import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ConnectorOutboundMessage } from "./connector.js";
import { ApprovalStore, sanitizeMemoryProposalPath, summaryText, type ProposedAction } from "./approval.js";
import { ConnectorDeliveryQueue } from "./queue.js";
import { composeMindStoneSkillDraft, validateSkillId, writeInstalledMindStoneSkill } from "../skills/artifacts.js";
import { PersonaExistsError, writeProposedPersona } from "../persona/create.js";
import { addPersonaComponentId, checkPersonaComponents, PersonaComposeError, writePrivateKnowledgebase } from "../persona/compose.js";
import { isRealDirectory, personaKnowledgebasesDir } from "../persona/components.js";
import { loadMindStonePersona } from "../persona/load.js";
import { builtinMindStoneSkills, discoverMindStoneSkills } from "../skills/artifacts.js";
import { validateWorkflowDefinition, writeWorkflowDefinition, WorkflowWriteError } from "../workflow/validate.js";

/**
 * Approving and rejecting proposed actions, shared by `mindstone approvals`
 * and the admin API (#84), so both run the same guards (#63, #77).
 *
 * Everything here is synchronous: within one process (the Gateway), two
 * approves of the same action can't interleave between the decision and the
 * queue write.
 */

/**
 * A refusal, with a code and the HTTP status the admin API answers with.
 * Every refusal is a 4xx: the Console passes the gateway's 4xx answers to
 * the browser but hides 5xx ones, and the admin needs to see why.
 */
export class ApprovalActionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found" | "already_decided" | "approve_running" | "changed" | "queue_busy" | "already_queued"
      | "memory_exists" | "unsafe_path" | "no_payload" | "no_personas_dir" | "persona_exists" | "persona_referenced"
      | "no_persona_references" | "skill_exists" | "invalid_skill" | "install_failed"
      | "persona_pending" | "unknown_component" | "workflow_exists" | "workflow_referenced" | "invalid_workflow"
      | "knowledgebase_exists" | "invalid_knowledgebase" | "invalid_persona" | "persona_rejected" | "persona_missing",
    readonly status: number,
    /** For callers outside this host (the Console): the same refusal without host paths or CLI hints. */
    readonly publicMessage: string = message,
  ) {
    super(message);
  }
}

/** Called after each decision, for the transcript event (and, in the Gateway, the admin audit). */
export type ApprovalDecisionHook = (action: ProposedAction, decision: "approved" | "rejected", detail: string) => void;

/** What an approved send or mutation puts on its connector's queue. */
export function approvalQueueTarget(action: ProposedAction): { connectorId: string; message: ConnectorOutboundMessage } | undefined {
  if (action.kind === "connector_send" && action.send) return { connectorId: action.connectorId, message: action.send };
  if (action.kind === "connector_mutation" && action.mutation) {
    return {
      connectorId: action.mutation.connectorId,
      message: { text: action.summary, metadata: { kind: "connector_mutation", mutation: action.mutation } },
    };
  }
  return undefined;
}

/** Whether the approve that set "queuing" is still running: the same process id alive on this host. */
export function approverStillRunning(by: { pid: number; host: string }): boolean {
  if (by.host !== hostname()) return true;
  if (by.pid === process.pid) return false;
  try {
    process.kill(by.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Add an approved component's id to its persona's list (#125). The persona
 * folder was checked before anything was written; if the list still can't
 * be updated (it changed meanwhile), the result says so, so the owner can
 * attach it in the persona editor.
 */
function addComponentOrExplain(personaDir: string, key: "skills" | "workflows", id: string): { note: string; listed: boolean } {
  try {
    const added = addPersonaComponentId(personaDir, key, id);
    // Listed, but in a persona that doesn't load it takes effect nowhere (#125 review).
    const loads = loadMindStonePersona(dirname(personaDir), basename(personaDir));
    if (!loads.ok) {
      return added === "all"
        ? { note: "the persona lists no skills, so none was added; it doesn't load, so it uses no skills until it is fixed (this skill is installed and in use elsewhere)", listed: false }
        : { note: `it was added to the persona's ${key}, but the persona doesn't load, so it isn't used there until the persona is fixed`, listed: false };
    }
    return added === "all"
      ? { note: "the persona lists no skills, so it uses every installed skill, this one included", listed: true }
      : { note: `added to the persona's ${key}`, listed: true };
  } catch (error) {
    // The component is approved and written; only the list failed. Said in the
    // result, not thrown: the approve itself succeeded.
    return {
      note: `it couldn't be added to the persona's ${key}.json (${error instanceof PersonaComposeError ? error.message : "the file couldn't be written"}); attach it in the persona editor`,
      listed: false,
    };
  }
}

/** The approval id an agent-proposed persona's metadata.json records, if it is a plain file that parses. */
function personaApprovalId(personaDir: string): string | undefined {
  const path = join(personaDir, "metadata.json");
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const id = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).approvalId : undefined;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A component card's persona card: refused while it waits (`persona_pending`)
 * or when it no longer exists (`persona_missing`: the card can only be
 * rejected). A rejected one is returned; the caller rejects the card.
 */
function componentParentOrRefuse(store: ApprovalStore, action: ProposedAction): ProposedAction {
  const kind = action.kind === "skill_install" ? "skill" : action.kind === "workflow_create" ? "workflow" : "knowledge base";
  const parent = store.get(action.parentApprovalId!);
  if (!parent || !parent.persona) {
    throw new ApprovalActionError(`this ${kind} belongs to a persona proposal (approval ${action.parentApprovalId}) that no longer exists; reject this card`, "persona_missing", 409);
  }
  if (parent.status === "pending") {
    throw new ApprovalActionError(`approve the persona first (approval ${action.parentApprovalId}); this ${kind} is part of it`, "persona_pending", 409);
  }
  return parent;
}

/** `store.decide`, with its refusal (decided meanwhile) as an ApprovalActionError. */
function decideOrRefuse(store: ApprovalStore, id: string, decision: Parameters<ApprovalStore["decide"]>[1]): ProposedAction {
  try {
    return store.decide(id, decision);
  } catch (error) {
    // Only "decided meanwhile" is a refusal; anything else (an I/O error, with
    // the action still pending) is a failure and is thrown as it is.
    const now = store.get(id);
    if (!now || now.status === "pending") throw error;
    throw new ApprovalActionError(`action ${now.id} is already ${now.status}`, "already_decided", 409);
  }
}

export type ApprovalCheck = { action: ProposedAction; repair: boolean };

/**
 * Whether an action can be approved now, before any confirmation. An approve
 * interrupted after the decision but before the queue entry was recorded (a
 * killed process) leaves the action approved with queueState "queuing".
 * Approving it again completes it (`repair`). Only such an action is
 * re-queued: one that was queued, or approved before queueState existed, is
 * refused like any decided action (#77 review).
 */
export function checkApprovable(store: ApprovalStore, id: string): ApprovalCheck {
  const action = store.get(id);
  if (!action) throw new ApprovalActionError(`no proposed action matches id "${id}"`, "not_found", 404);
  const repair = action.status === "approved" && action.queueState === "queuing" && approvalQueueTarget(action) !== undefined;
  if (!repair && action.status !== "pending") throw new ApprovalActionError(`action ${action.id} is already ${action.status}`, "already_decided", 409);
  // "queuing" alone can't tell an approve that is still running (waiting for
  // the queue lock) from one that was killed. The approve records its
  // process; while that process is alive, it isn't repaired (#77 round 3).
  // A component card (#125) is refused here, before any confirmation, while
  // its persona card waits or is gone (#125 review); one whose persona was
  // rejected is rejected by the approve itself.
  if (!repair && action.parentApprovalId) componentParentOrRefuse(store, action);
  if (repair && action.queuingBy && approverStillRunning(action.queuingBy)) {
    throw new ApprovalActionError(
      `an approve of ${action.id} is still running (process ${action.queuingBy.pid}); let it finish, or stop it and approve again`,
      "approve_running",
      409,
    );
  }
  return { action, repair };
}

export type ApproveResult =
  | { outcome: "approved"; kind: "connector_send"; connectorId: string }
  | { outcome: "approved"; kind: "connector_mutation"; connectorId: string }
  | { outcome: "approved"; kind: "memory_write"; memoryFile: string }
  | { outcome: "approved"; kind: "persona_create"; personaId: string }
  /** `persona`: for a persona's skill (#125), whether it joined the persona and how. */
  | { outcome: "approved"; kind: "skill_install"; skillId: string; persona?: { id: string; listed: boolean; note: string } }
  | { outcome: "approved"; kind: "workflow_create"; workflowId: string; personaId: string; listed: boolean; note: string }
  /** The KB is written; the caller ingests it (`kbRoot`, `kbId`), since ingest is async. */
  | { outcome: "approved"; kind: "persona_kb_create"; personaId: string; kbId: string; kbRoot: string; listed?: false; note?: string }
  | { outcome: "requeued"; kind: "connector_send" | "connector_mutation"; connectorId: string }
  | { outcome: "already_queued"; kind: "connector_send" | "connector_mutation"; connectorId: string };

/**
 * Approve the action `checkApprovable` returned (after any confirmation).
 * A send or mutation is decided first, so an action rejected or approved
 * meanwhile is refused, and nothing refused is queued. The decision records
 * queueState "queuing" until the entry is written. If the queue then fails
 * (locked), the approval is undone and the action is pending again rather
 * than approved but never sent (#63). The entry is written at most once per
 * approval, even if two approves race (#77).
 */
export function approveProposedAction(
  store: ApprovalStore,
  check: ApprovalCheck,
  options: {
    decidedBy: string;
    memoryDir: string;
    force?: boolean;
    now?: () => string;
    onDecision?: ApprovalDecisionHook;
    /** persona_create (#105): where personas live. */
    personasDir?: string;
    /** Persona ids the config already uses (referencedPersonaIds); approving one of them is refused. */
    referencedPersonaIds?: ReadonlySet<string>;
    /** Where skills are installed (#104); required to approve a skill_install. */
    skillsDir?: string;
    /** #125: where workflows and global KBs live, to check a persona's components and write a proposed workflow. */
    workflowsDir?: string;
    knowledgebasesDir?: string;
    /** #125: workflow ids the config runs or a persona lists; creating one of them is refused. */
    referencedWorkflowIds?: ReadonlySet<string>;
  },
): ApproveResult {
  const { action, repair } = check;
  const now = options.now ?? (() => new Date().toISOString());
  // A component card (#125) waits for its persona's card: approving the
  // persona writes its folder, so a component never lands in a persona that
  // doesn't exist.
  let parentPersonaDir: string | undefined;
  let parentPersonaId: string | undefined;
  if (action.parentApprovalId) {
    // Checked again: the persona card may have changed since checkApprovable.
    const parent = componentParentOrRefuse(store, action);
    // Its persona was rejected (a reject that missed it): it goes the same way (#125 review).
    if (parent.status === "rejected" && !repair) {
      const at = now();
      decideOrRefuse(store, action.id, { status: "rejected", decidedBy: options.decidedBy, note: "its persona was rejected", now: at });
      options.onDecision?.(action, "rejected", "its persona was rejected");
      throw new ApprovalActionError(`its persona (approval ${action.parentApprovalId}) was rejected, so this card is rejected too`, "persona_rejected", 409);
    }
    if (parent.status !== "approved" || !parent.persona) {
      throw new ApprovalActionError(`approve the persona first (approval ${action.parentApprovalId})`, "persona_pending", 409);
    }
    if (!options.personasDir) throw new ApprovalActionError("approving a persona's component needs the personas directory", "no_personas_dir", 422);
    parentPersonaDir = join(options.personasDir, parent.persona.id);
    parentPersonaId = parent.persona.id;
    // Checked before anything is written or installed: a component never
    // lands globally for a persona that isn't there (#125 review).
    if (!isRealDirectory(parentPersonaDir)) {
      throw new ApprovalActionError(
        `persona ${parent.persona.id} is no longer at ${parentPersonaDir} (removed, a link, or the personas directory changed); nothing was written: restore it, or reject this card`,
        "invalid_persona",
        409,
        `persona ${parent.persona.id} is no longer in the personas folder; nothing was written: restore it, or reject this card`,
      );
    }
    // The folder must be the one that persona card wrote, not a persona made
    // later under the same id (#146 review): its metadata.json names the card.
    if (personaApprovalId(parentPersonaDir) !== action.parentApprovalId) {
      throw new ApprovalActionError(
        `persona ${parent.persona.id} at ${parentPersonaDir} is not the one approval ${action.parentApprovalId} created (it was removed and made again, or its metadata changed); nothing was written: reject this card`,
        "invalid_persona",
        409,
        `persona ${parent.persona.id} is not the one approval ${action.parentApprovalId} created; nothing was written: reject this card`,
      );
    }
  }
  const queueTarget = approvalQueueTarget(action);
  if (repair && queueTarget) {
    const { queued, refused } = new ConnectorDeliveryQueue(queueTarget.connectorId).enqueueForApproval(queueTarget.message, action.id, {
      now: now(),
      // Re-read under the queue lock: still approved, still "queuing", same decision.
      stillApproved: () => {
        const current = store.get(action.id);
        return current?.status === "approved" && current.queueState === "queuing" && current.decidedAt === action.decidedAt;
      },
    });
    if (refused) {
      throw new ApprovalActionError(
        `${action.id} changed while it was being queued (undone or decided again); nothing was queued. Check it with mindstone approvals show ${action.id}`,
        "changed",
        409,
      );
    }
    store.markQueued(action.id, action.decidedAt);
    if (queued) options.onDecision?.(action, "approved", `enqueued via ${queueTarget.connectorId} (completing an earlier approval that was never queued)`);
    const kind = action.kind === "connector_mutation" ? "connector_mutation" : "connector_send";
    return queued ? { outcome: "requeued", kind, connectorId: queueTarget.connectorId } : { outcome: "already_queued", kind, connectorId: queueTarget.connectorId };
  }
  const approveThenEnqueue = (target: NonNullable<typeof queueTarget>) => {
    const decided = decideOrRefuse(store, action.id, {
      status: "approved",
      decidedBy: options.decidedBy,
      now: now(),
      queueState: "queuing",
      queuingBy: { pid: process.pid, host: hostname() },
    });
    const queue = new ConnectorDeliveryQueue(target.connectorId);
    try {
      queue.enqueueForApproval(target.message, action.id, { now: now() });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      let undone = false;
      try {
        // Undone only under the queue lock and only if nothing queued it
        // meanwhile, so an undone approval never has a live entry.
        undone = queue.withApprovalLocked(decided.id, (queued) => !queued && store.undoApproval(decided.id, decided.decidedAt));
      } catch (undoError) {
        throw new ApprovalActionError(
          `${reason}; undoing the approval also failed (${undoError instanceof Error ? undoError.message : String(undoError)}): the action is approved but not queued; once this command has exited, approve it again to queue it`,
          "queue_busy",
          409,
          "the connector's delivery queue is busy or unreadable, and undoing the approval also failed: the action is approved but not queued; approve it again to queue it",
        );
      }
      throw new ApprovalActionError(
        undone
          ? `${reason}; the action is pending again, approve it once the queue is free`
          : `${reason}; the approval could not be undone (it changed meanwhile): check it with mindstone approvals show ${decided.id}`,
        "queue_busy",
        409,
        undone
          ? "the connector's delivery queue is busy or unreadable; the action is pending again, approve it once the queue is free"
          : "the connector's delivery queue is busy or unreadable, and the approval could not be undone (it changed meanwhile); check the action",
      );
    }
    store.markQueued(decided.id, decided.decidedAt);
  };
  if (action.kind === "connector_send" && action.send && queueTarget) {
    approveThenEnqueue(queueTarget);
    options.onDecision?.(action, "approved", `enqueued for delivery via ${action.connectorId}`);
    return { outcome: "approved", kind: "connector_send", connectorId: action.connectorId };
  }
  if (action.kind === "connector_mutation" && action.mutation && queueTarget) {
    approveThenEnqueue(queueTarget);
    options.onDecision?.(action, "approved", `mutation enqueued for apply via ${action.mutation.connectorId}`);
    return { outcome: "approved", kind: "connector_mutation", connectorId: action.mutation.connectorId };
  }
  if (action.kind === "memory_write" && action.memory) {
    const safePath = sanitizeMemoryProposalPath(action.memory.path);
    // Quoted as JSON: a path from before one-line names can't draw lines of its own.
    // Escaped, then quoted as JSON: a path from before names were checked
    // can't act on a terminal, and a typed "\u{1b}" can't pass for a real one.
    if (!safePath) throw new ApprovalActionError(`memory proposal path ${JSON.stringify(summaryText(action.memory.path))} is not a safe relative path`, "unsafe_path", 422);
    const target = join(options.memoryDir, safePath);
    if (existsSync(target) && !options.force) {
      throw new ApprovalActionError(
        `memory file already exists: ${target} (re-run with --force to overwrite)`,
        "memory_exists",
        409,
        `memory file already exists: ${safePath}; approve with force to overwrite it`,
      );
    }
    decideOrRefuse(store, action.id, { status: "approved", decidedBy: options.decidedBy, now: now() });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, action.memory.content.endsWith("\n") ? action.memory.content : `${action.memory.content}\n`);
    options.onDecision?.(action, "approved", `memory file written: ${safePath}`);
    return { outcome: "approved", kind: "memory_write", memoryFile: target };
  }
  if (action.kind === "skill_install" && action.skill && options.skillsDir) {
    // The proposal holds the whole skill (#104); nothing was written before
    // this approval. Checks first, then the decision, then the files.
    const skill = action.skill;
    const idError = validateSkillId(skill.id);
    if (idError) throw new ApprovalActionError(`proposed skill id is not valid: ${idError}`, "invalid_skill", 422);
    // A persona's new skill is new: one already installed, or a built-in's
    // id, is refused, with no force (#125).
    if (action.parentApprovalId && (existsSync(join(options.skillsDir, skill.id, "skill.json")) || builtinMindStoneSkills().some((builtin) => builtin.artifact.id === skill.id))) {
      throw new ApprovalActionError(
        `skill "${skill.id}" already exists, and a persona's new skill can't replace one; reject this card, or ask the agent to list the existing skill instead`,
        "skill_exists",
        409,
      );
    }
    if (existsSync(join(options.skillsDir, skill.id, "skill.json")) && !options.force) {
      throw new ApprovalActionError(
        `skill "${skill.id}" is already installed at ${join(options.skillsDir, skill.id)} (re-run with --force to replace it)`,
        "skill_exists",
        409,
        `skill "${skill.id}" is already installed; approve with force to replace it`,
      );
    }
    const composed = composeMindStoneSkillDraft({
      id: skill.id,
      label: skill.label,
      description: skill.description,
      goal: skill.goal,
      whenToUse: skill.whenToUse,
      outputs: skill.outputs,
      safetyNotes: skill.safetyNotes,
      skillMarkdown: skill.instructions,
      now: now(),
    });
    if (!composed.ok) throw new ApprovalActionError(`proposed skill is not valid: ${composed.error}`, "invalid_skill", 422);
    const decided = decideOrRefuse(store, action.id, { status: "approved", decidedBy: options.decidedBy, now: now() });
    try {
      // Installed directly: drafts/ is the admin's, and an approval never touches it.
      writeInstalledMindStoneSkill(options.skillsDir, composed.artifact, composed.skillMarkdown);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const undone = store.undoApproval(decided.id, decided.decidedAt);
      throw new ApprovalActionError(
        `the skill ${skill.id} could not be installed (${reason}); ${undone ? "the action is pending again" : "the approval could not be undone (it changed meanwhile)"}`,
        "install_failed",
        500,
        `the skill could not be installed; ${undone ? "the action is pending again" : "check the action"}`,
      );
    }
    const joined = parentPersonaDir && parentPersonaId ? { id: parentPersonaId, ...addComponentOrExplain(parentPersonaDir, "skills", skill.id) } : undefined;
    options.onDecision?.(action, "approved", `skill installed: ${skill.id}${joined ? ` (${joined.note})` : ""}`);
    return { outcome: "approved", kind: "skill_install", skillId: skill.id, ...(joined ? { persona: joined } : {}) };
  }
  if (action.kind === "workflow_create" && action.workflow && parentPersonaDir) {
    const workflow = action.workflow;
    if (!options.workflowsDir) throw new ApprovalActionError("approving a workflow needs the workflows directory", "no_payload", 422);
    const installed = new Set(options.skillsDir ? discoverMindStoneSkills(options.skillsDir).filter((skill) => skill.source === "installed" && !skill.error).map((skill) => skill.id) : []);
    // Checked again now: the skills it names must be installed by now, and
    // it still can't name a persona.
    const checked = validateWorkflowDefinition(workflow.definition, { personaExists: () => false, skillInstalled: (id) => installed.has(id) });
    if (!checked.ok) throw new ApprovalActionError(`the proposed workflow isn't valid: ${checked.error}`, "invalid_workflow", 422);
    if (options.referencedWorkflowIds?.has(workflow.id) || options.referencedWorkflowIds?.has(workflow.id.toLowerCase())) {
      throw new ApprovalActionError(`the config or a persona already names a workflow "${workflow.id}", so creating it would take effect with no switch; reject this card and ask for another id`, "workflow_referenced", 409);
    }
    const decided = decideOrRefuse(store, action.id, { status: "approved", decidedBy: options.decidedBy, now: now() });
    try {
      writeWorkflowDefinition({ workflowsDir: options.workflowsDir, id: workflow.id, workflow: checked.workflow, mode: "create" });
    } catch (error) {
      const undone = store.undoApproval(decided.id, decided.decidedAt);
      const exists = error instanceof WorkflowWriteError && error.code === "workflow_exists";
      const after = undone ? "the card is pending again" : "the approval could not be undone";
      throw new ApprovalActionError(
        `${error instanceof Error ? error.message : String(error)}; ${after}`,
        exists ? "workflow_exists" : "invalid_workflow",
        exists ? 409 : 422,
        // A filesystem error names host paths: the Console gets the gist.
        error instanceof WorkflowWriteError ? `${error.message}; ${after}` : `the workflow could not be written; ${after}`,
      );
    }
    const joined = addComponentOrExplain(parentPersonaDir, "workflows", workflow.id);
    options.onDecision?.(action, "approved", `workflow written: ${workflow.id} (${joined.note})`);
    return { outcome: "approved", kind: "workflow_create", workflowId: workflow.id, personaId: workflow.personaId, ...joined };
  }
  if (action.kind === "persona_kb_create" && action.knowledgebase && parentPersonaDir) {
    const kb = action.knowledgebase;
    const decided = decideOrRefuse(store, action.id, { status: "approved", decidedBy: options.decidedBy, now: now() });
    let kbRoot: string;
    try {
      writePrivateKnowledgebase(parentPersonaDir, kb);
      kbRoot = personaKnowledgebasesDir(parentPersonaDir);
    } catch (error) {
      const undone = store.undoApproval(decided.id, decided.decidedAt);
      const exists = error instanceof PersonaComposeError && error.code === "knowledgebase_exists";
      const after = undone ? "the card is pending again" : "the approval could not be undone";
      throw new ApprovalActionError(
        `${error instanceof Error ? error.message : String(error)}; ${after}`,
        exists ? "knowledgebase_exists" : "invalid_knowledgebase",
        exists ? 409 : 422,
        error instanceof PersonaComposeError ? `${error.message}; ${after}` : `the knowledge base could not be written; ${after}`,
      );
    }
    // Written, but a persona that doesn't load uses none of it (#125 review).
    const personaLoads = loadMindStonePersona(dirname(parentPersonaDir), basename(parentPersonaDir)).ok;
    const unused = personaLoads ? undefined : "the persona doesn't load, so this knowledge base isn't used until the persona is fixed";
    options.onDecision?.(action, "approved", `private knowledge base written: ${kb.id} (persona ${kb.personaId}); ingest follows${unused ? ` (${unused})` : ""}`);
    return { outcome: "approved", kind: "persona_kb_create", personaId: kb.personaId, kbId: kb.id, kbRoot, ...(unused ? { listed: false, note: unused } : {}) };
  }
  if (action.kind === "persona_create" && action.persona) {
    // Written before the decision, so a refused decision leaves nothing
    // behind and an approval never exists without its files (#105).
    if (!options.personasDir) throw new ApprovalActionError("approving a persona needs the personas directory", "no_personas_dir", 422);
    const personaId = action.persona.id;
    // An id the config already uses (active, a route rule, a workflow step)
    // would answer as soon as it's saved, with no switch (#105 review).
    if (!options.referencedPersonaIds) throw new ApprovalActionError("approving a persona needs the persona ids the config uses", "no_persona_references", 422);
    if (options.referencedPersonaIds.has(personaId.toLowerCase())) {
      throw new ApprovalActionError(
        `the config already uses the persona id "${personaId}", so approving it would make it active without a switch; ask the agent for a new name, or reject this proposal`,
        "persona_referenced",
        409,
      );
    }
    // The existing components it lists must exist now (#125).
    const listed = action.components;
    if (listed && (listed.skills.length || listed.workflows.length || listed.knowledgebases.length)) {
      if (!options.skillsDir || !options.workflowsDir || !options.knowledgebasesDir) {
        throw new ApprovalActionError("approving a persona with components needs the skills, workflows and knowledge base directories", "no_personas_dir", 422);
      }
      try {
        checkPersonaComponents(listed, { skillsDir: options.skillsDir, workflowsDir: options.workflowsDir, knowledgebasesDir: options.knowledgebasesDir });
      } catch (error) {
        throw new ApprovalActionError(
          `${error instanceof Error ? error.message : String(error)}; the persona lists it, so it can't be approved as it is: reject it and ask the agent again`,
          "unknown_component",
          422,
        );
      }
    }
    let dir: string;
    try {
      dir = writeProposedPersona({ personasDir: options.personasDir, persona: action.persona, approvedBy: options.decidedBy, now: now(), approvalId: action.id });
    } catch (error) {
      if (error instanceof PersonaExistsError) {
        throw new ApprovalActionError(`${error.message}; ask the agent for a new name, or reject this proposal`, "persona_exists", 409);
      }
      throw error;
    }
    // A filesystem that folds more than case (APFS: "ſhadow" is "shadow")
    // can still put the new persona where a referenced id points: compare
    // the directories themselves (#105 review).
    const written = statSync(dir);
    for (const referenced of options.referencedPersonaIds) {
      if (!/^[^/\\]+$/.test(referenced) || referenced === "." || referenced === "..") continue;
      let other;
      try {
        other = statSync(join(options.personasDir, referenced));
      } catch {
        continue;
      }
      if (other.ino === written.ino && other.dev === written.dev) {
        rmSync(dir, { recursive: true, force: true });
        throw new ApprovalActionError(
          `the config already uses the persona id "${referenced}", which is the same directory as "${personaId}" on this filesystem, so approving it would make it active without a switch; ask the agent for a new name, or reject this proposal`,
          "persona_referenced",
          409,
        );
      }
    }
    try {
      if (listed) {
        for (const key of ["skills", "workflows", "knowledgebases"] as const) {
          if (listed[key].length) writeFileSync(join(dir, `${key}.json`), `${JSON.stringify(listed[key], null, 2)}\n`, { flag: "wx" });
        }
      }
      decideOrRefuse(store, action.id, { status: "approved", decidedBy: options.decidedBy, now: now() });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    // Saved to the list only: making it active is a separate, deliberate
    // switch on the Personas page (Clint, #105).
    options.onDecision?.(action, "approved", `persona saved: ${personaId} (not active until switched to)`);
    return { outcome: "approved", kind: "persona_create", personaId };
  }
  throw new ApprovalActionError(`action ${action.id} has kind "${action.kind}" but no matching payload; refusing to approve`, "no_payload", 422);
}

/**
 * Reject a pending action. A pending action must not have a queued send; if
 * it does (a lost update in the approval store), rejecting it wouldn't stop
 * the send, so it is refused (#77 round 3).
 */
export function rejectProposedAction(
  store: ApprovalStore,
  id: string,
  options: { decidedBy: string; note?: string; now?: () => string; onDecision?: ApprovalDecisionHook },
): ProposedAction {
  const action = store.get(id);
  if (!action) throw new ApprovalActionError(`no proposed action matches id "${id}"`, "not_found", 404);
  if (action.status !== "pending") throw new ApprovalActionError(`action ${action.id} is already ${action.status}`, "already_decided", 409);
  const rejectQueue = action.kind === "connector_send" ? action.connectorId : action.kind === "connector_mutation" ? action.mutation?.connectorId : undefined;
  if (rejectQueue && new ConnectorDeliveryQueue(rejectQueue).hasApprovalEntry(action.id)) {
    throw new ApprovalActionError(`a send for ${action.id} is already queued, so rejecting it wouldn't stop it; check the ${rejectQueue} queue`, "already_queued", 409);
  }
  const at = (options.now ?? (() => new Date().toISOString()))();
  const decided = decideOrRefuse(store, action.id, { status: "rejected", decidedBy: options.decidedBy, note: options.note, now: at });
  options.onDecision?.(action, "rejected", options.note ?? "no note");
  // Rejecting a persona rejects its components that are still waiting (#125).
  if (action.kind === "persona_create") {
    for (const child of store.pending().filter((entry) => entry.parentApprovalId === action.id)) {
      try {
        const rejected = decideOrRefuse(store, child.id, { status: "rejected", decidedBy: options.decidedBy, note: "its persona was rejected", now: at });
        options.onDecision?.(rejected, "rejected", "its persona was rejected");
      } catch {
        // Decided meanwhile: nothing to do.
      }
    }
  }
  return decided;
}
