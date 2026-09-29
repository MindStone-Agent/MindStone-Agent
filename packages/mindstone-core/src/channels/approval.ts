import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import { appendTranscriptEntry, type TranscriptEntry, type TranscriptSource } from "../transcript/index.js";
import type { ConnectorOutboundMessage } from "./connector.js";
import { parsePersonaProposal, PERSONA_TEXT_INVISIBLE, STACKED_MARKS, type PersonaProposalPayload } from "../persona/create.js";
import { validateWorkflowDefinition, WORKFLOW_ID, type WorkflowDefinitionInput } from "../workflow/validate.js";
import { builtinMindStoneSkills } from "../skills/artifacts.js";

/**
 * Durable proposed-action store (issue #21, designed to be absorbed by the
 * #24 Approval Center). Actions with consequences — sending an email, writing
 * a memory file — are PROPOSED here instead of executed; a human decision
 * (approve/reject) is required to act. Records are never deleted by
 * decisions: approved/rejected entries retain their full payload + decision
 * metadata, which together with the `approval_proposed`/`approval_decided`
 * transcript events is the audit trail the ticket requires.
 *
 * #21 ships two action kinds; #24 extends the taxonomy (tasks, calendar,
 * skills, personas, workflows, config) and adds a UI + defer on top of this
 * same store.
 */
export type ProposedActionKind =
  | "connector_send"
  | "memory_write"
  | "connector_mutation"
  | "persona_create"
  | "skill_install"
  | "workflow_create"
  | "persona_kb_create";

export type ProposedActionStatus = "pending" | "approved" | "rejected";

export type MemoryWritePayload = {
  /** Relative path inside the memory directory (sanitized on apply). */
  path: string;
  content: string;
};

/**
 * A proposed mutation against an external service (issue #22): create/update
 * a calendar event, task, etc. Mutations are ALWAYS approval-gated — there is
 * no auto path for connector_mutation at all. On approve the payload is
 * enqueued onto the target connector's delivery queue as a typed outbound
 * message; the connector's sendOutbound applies it (retry/dead-letter apply).
 */
export type ConnectorMutationPayload = {
  /** Target connector (e.g. "calendar"). */
  connectorId: string;
  operation: "create" | "update";
  /** Resource type in the target service's vocabulary (e.g. "event", "task"). */
  resource: string;
  /** Provider-shaped resource data (validated by the connector on apply). */
  data: Record<string, unknown>;
};

/**
 * A skill the agent proposes to install (#104). It is held in the proposal
 * only: nothing is written under the skills directory until the owner
 * approves it, so model output never creates files on its own.
 */
export type SkillInstallPayload = {
  id: string;
  label: string;
  description: string;
  goal?: string;
  whenToUse: string[];
  outputs: string[];
  safetyNotes: string[];
  /** The SKILL.md body; generated from the fields when the proposal has none. */
  instructions?: string;
};

/**
 * A persona's components as the agent proposes them (#125). Existing ones are
 * listed by id and checked when the persona is approved; new ones each become
 * their own approval card, linked to the persona's.
 */
export type PersonaProposalComponents = {
  skills: string[];
  workflows: string[];
  knowledgebases: string[];
};

/** A workflow the agent proposes with a persona (#125). It can't route to, or gate on, a persona. */
export type WorkflowCreatePayload = {
  id: string;
  personaId: string;
  definition: WorkflowDefinitionInput;
};

/** A private knowledge base the agent proposes for its persona (#125): markdown text sources only. */
export type PersonaKnowledgebasePayload = {
  personaId: string;
  id: string;
  name?: string;
  sources: Array<{ name: string; text: string }>;
};

/** How much one persona proposal may bring (#125). */
export const PERSONA_COMPONENT_LIMITS = {
  listed: 12,
  newSkills: 3,
  newWorkflows: 3,
  newKnowledgebases: 2,
  sourcesPerKnowledgebase: 5,
  sourceText: 20_000,
} as const;

/** Pending component cards kept at once, per kind (#125). */
export const MAX_PENDING_COMPONENTS = 6;

/** Size limits for a proposed skill, so a reply can't park megabytes in the approvals store. */
export const SKILL_PROPOSAL_LIMITS = { text: 2_000, list: 12, instructions: 16_000 } as const;

export type ProposedAction = {
  id: string;
  kind: ProposedActionKind;
  /** Connector that produced the proposal (e.g. "email"). */
  connectorId: string;
  sessionKey?: string;
  agentId?: string;
  createdAt?: string;
  /** Human-readable one-liner for list surfaces. */
  summary: string;
  /** connector_send: the ConnectorOutboundMessage to enqueue on approval. */
  send?: ConnectorOutboundMessage;
  /** memory_write: the memory file proposal to apply on approval. */
  memory?: MemoryWritePayload;
  /** connector_mutation: the external-service mutation to apply on approval. */
  mutation?: ConnectorMutationPayload;
  /** persona_create: the persona the agent proposed for itself (#105). */
  persona?: PersonaProposalPayload;
  /** skill_install: the skill to draft and install on approval (#104). */
  skill?: SkillInstallPayload;
  /** persona_create: the existing components the persona lists (#125). */
  components?: PersonaProposalComponents;
  /** workflow_create: the workflow to write on approval (#125). */
  workflow?: WorkflowCreatePayload;
  /** persona_kb_create: the private knowledge base to write and ingest on approval (#125). */
  knowledgebase?: PersonaKnowledgebasePayload;
  /**
   * A component card's persona card (#125): it can be approved only after
   * that one is, and is rejected with it.
   */
  parentApprovalId?: string;
  status: ProposedActionStatus;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  /**
   * For an approved send or mutation: "queuing" from the decision until its
   * queue entry is written, then "queued". An approve interrupted in between
   * leaves "queuing", and only such an action can be queued by approving it
   * again (#77 review). Approvals from before this field existed have none
   * and are never re-queued.
   */
  queueState?: "queuing" | "queued";
  /** The process (pid on host) that set "queuing", so a repair never runs while that approve is still going (#77 round 3). */
  queuingBy?: { pid: number; host: string };
};

type ApprovalFile = {
  actions: ProposedAction[];
};

export type ApprovalStoreStatus = {
  pending: number;
  approved: number;
  rejected: number;
};

export function approvalsPath(paths?: MindStoneRuntimePaths): string {
  const resolved = paths ?? runtimePathsFromEnv();
  return join(resolved.dataDir, "approvals", "actions.json");
}

export class ApprovalStore {
  readonly #path: string;

  constructor(options: { paths?: MindStoneRuntimePaths; path?: string } = {}) {
    this.#path = options.path ?? approvalsPath(options.paths);
  }

  get path(): string {
    return this.#path;
  }

  #read(): ApprovalFile {
    if (!existsSync(this.#path)) return { actions: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as ApprovalFile).actions)) return parsed as ApprovalFile;
    } catch {
      // fall through — a corrupt approvals file is replaced, not fatal
    }
    return { actions: [] };
  }

  #write(file: ApprovalFile): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.tmp-${randomUUID().slice(0, 8)}`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temp, this.#path);
  }

  propose(action: Omit<ProposedAction, "id" | "status">): ProposedAction {
    const file = this.#read();
    const record: ProposedAction = { ...action, id: randomUUID(), status: "pending" };
    file.actions.push(record);
    this.#write(file);
    return record;
  }

  list(): ProposedAction[] {
    return this.#read().actions;
  }

  pending(): ProposedAction[] {
    return this.#read().actions.filter((action) => action.status === "pending");
  }

  get(id: string): ProposedAction | undefined {
    // Full ids match exactly; short prefixes (>= 8 chars) match uniquely.
    const actions = this.#read().actions;
    const exact = actions.find((action) => action.id === id);
    if (exact) return exact;
    if (id.length < 8) return undefined;
    const matches = actions.filter((action) => action.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Record a decision on a pending action. Decisions are immutable — deciding
   * a non-pending action throws rather than silently rewriting history.
   */
  decide(
    id: string,
    decision: {
      status: "approved" | "rejected";
      decidedBy?: string;
      note?: string;
      now?: string;
      queueState?: "queuing";
      queuingBy?: { pid: number; host: string };
    },
  ): ProposedAction {
    const file = this.#read();
    const target = file.actions.find((action) => action.id === id) ?? (id.length >= 8 ? singlePrefixMatch(file.actions, id) : undefined);
    if (!target) throw new Error(`no proposed action matches id "${id}"`);
    if (target.status !== "pending") throw new Error(`action ${target.id} is already ${target.status}; decisions are immutable`);
    target.status = decision.status;
    target.decidedAt = decision.now;
    target.decidedBy = decision.decidedBy;
    target.decisionNote = decision.note;
    if (decision.status === "approved" && decision.queueState) {
      target.queueState = decision.queueState;
      if (decision.queuingBy) target.queuingBy = decision.queuingBy;
    }
    this.#write(file);
    return target;
  }

  /** Record that this approval's queue entry is written. Only this exact decision is marked. */
  markQueued(id: string, decidedAt: string | undefined): boolean {
    const file = this.#read();
    const target = file.actions.find((action) => action.id === id);
    if (!target || target.status !== "approved" || target.decidedAt !== decidedAt) return false;
    target.queueState = "queued";
    delete target.queuingBy;
    this.#write(file);
    return true;
  }

  /**
   * Put an approval back to pending when the step after it failed (the
   * delivery queue was locked), so the owner can approve it again (#63).
   * Only this exact decision is undone: a later one is left alone.
   */
  undoApproval(id: string, decidedAt: string | undefined): boolean {
    const file = this.#read();
    const target = file.actions.find((action) => action.id === id);
    if (!target || target.status !== "approved" || target.decidedAt !== decidedAt) return false;
    target.status = "pending";
    delete target.decidedAt;
    delete target.decidedBy;
    delete target.decisionNote;
    delete target.queueState;
    delete target.queuingBy;
    this.#write(file);
    return true;
  }

  status(): ApprovalStoreStatus {
    const actions = this.#read().actions;
    return {
      pending: actions.filter((action) => action.status === "pending").length,
      approved: actions.filter((action) => action.status === "approved").length,
      rejected: actions.filter((action) => action.status === "rejected").length,
    };
  }
}

function singlePrefixMatch(actions: ProposedAction[], prefix: string): ProposedAction | undefined {
  const matches = actions.filter((action) => action.id.startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

// ---------------------------------------------------------------------------
// Send-policy resolution (issue #21): connectors whose outbound has real-world
// consequences declare approval_required as their default; config may override
// per channel, but the override is an explicit policy act surfaced by doctor.
// ---------------------------------------------------------------------------

export type ConnectorSendPolicy = "auto" | "approval_required";

export function resolveConnectorSendPolicy(params: {
  /** The connector's declared default (undefined = auto, the chat-connector norm). */
  connectorDefault?: ConnectorSendPolicy;
  channelConfig: Record<string, unknown> | undefined;
}): ConnectorSendPolicy {
  const configured = params.channelConfig?.sendPolicy;
  if (configured === "auto" || configured === "approval_required") return configured;
  return params.connectorDefault ?? "auto";
}

// ---------------------------------------------------------------------------
// Action-proposal block extraction (issues #21/#22): a model reply may carry
// fenced blocks proposing consequential actions — a durable memory write
// (mindstone-memory-proposal) or an external-service mutation such as a
// calendar event (mindstone-calendar-proposal). Blocks are extracted (and
// stripped from the visible reply) into pending ProposedActions — model
// output derives from untrusted input (email bodies, chat), which is exactly
// why every proposal terminates in the human approval gate and is never
// applied directly.
// ---------------------------------------------------------------------------

const SKILL_PROPOSAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

function boundedList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SKILL_PROPOSAL_LIMITS.list) return undefined;
  const items = value.map((item) => boundedText(item, SKILL_PROPOSAL_LIMITS.text));
  return items.every((item): item is string => item !== undefined) ? items : undefined;
}

/**
 * Characters no proposal text needs and a terminal or reader could be fooled
 * by: C0 controls but line breaks and tabs, DEL and C1 (escape sequences),
 * bidi embeddings, overrides and isolates, line and paragraph separators,
 * and tag characters (#125 review).
 */
const PROPOSAL_UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029\u{E0000}-\u{E007F}]/u;
/** A name (a memory path, a mutation resource) is one line too: a line break would draw a line of its own (#125 review). */
// Zero-width joiners (U+200C, U+200D) stay allowed: Persian, Indic scripts and
// emoji spell with them. U+200B, bidi marks and the rest have no such use.
const PROPOSAL_UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\u2800\ufeff\u{E0000}-\u{E007F}]/u;

/** Text for a summary line, with anything unsafe shown as \u{..}: summaries reach logs and the TUI as they are. */
export function summaryText(text: string): string {
  return text.replace(new RegExp(PROPOSAL_UNSAFE_NAME.source, "gu"), (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

function hasUnsafeText(value: unknown): boolean {
  if (typeof value === "string") return PROPOSAL_UNSAFE_TEXT.test(value.replace(/\r\n/g, "\n"));
  if (Array.isArray(value)) return value.some(hasUnsafeText);
  return false;
}

/** A proposed skill (#104), or undefined when any field is missing, malformed or too large. */
export function parseSkillProposal(parsed: unknown): SkillInstallPayload | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  // Nothing that acts on a terminal or hides text (escape sequences, C1,
  // bidi overrides, tag characters) in any field: the text is printed in
  // `skill list`, the TUI and logs long after it is approved. Zero-width
  // joiners and variation selectors stay: real writing needs them (#125 review).
  const fields = ["id", "label", "description", "goal", "whenToUse", "outputs", "safetyNotes", "instructions"].map((key) => record[key]);
  if (fields.some((field) => hasUnsafeText(field))) return undefined;
  const id = typeof record.id === "string" && SKILL_PROPOSAL_ID.test(record.id) && record.id !== "drafts" ? record.id : undefined;
  // One line: the label goes into the card's summary, which list views print
  // as it is, so a line break could draw rows of its own (#125 review).
  const label = typeof record.label === "string" && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(record.label) ? undefined : boundedText(record.label, SKILL_PROPOSAL_LIMITS.text);
  // One line, like the label: `skill list` prints it as a row (#125 review).
  const description = typeof record.description === "string" && /[\n\t]/.test(record.description.trim()) ? undefined : boundedText(record.description, SKILL_PROPOSAL_LIMITS.text);
  const goal = record.goal === undefined ? undefined : boundedText(record.goal, SKILL_PROPOSAL_LIMITS.text);
  const whenToUse = boundedList(record.whenToUse);
  const outputs = boundedList(record.outputs);
  const safetyNotes = boundedList(record.safetyNotes);
  const instructions = record.instructions === undefined ? undefined : boundedText(record.instructions, SKILL_PROPOSAL_LIMITS.instructions);
  if (!id || !label || !description || !whenToUse || !outputs || !safetyNotes) return undefined;
  if (record.goal !== undefined && goal === undefined) return undefined;
  if (record.instructions !== undefined && instructions === undefined) return undefined;
  return { id, label, description, goal, whenToUse, outputs, safetyNotes, instructions };
}

const COMPONENT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const PRIVATE_KB_PROPOSAL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type ParsedPersonaComponents = {
  listed: PersonaProposalComponents;
  skills: SkillInstallPayload[];
  workflows: Array<{ id: string; definition: WorkflowDefinitionInput }>;
  knowledgebases: Array<{ id: string; name?: string; sources: Array<{ name: string; text: string }> }>;
};

/**
 * Every string in a proposed component, keys included, CRLF read as LF: the
 * same refusals as a persona's own fields (#105), invisible characters and
 * stacked combining marks (#125 review).
 */
function hasInvisibleText(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.replace(/\r\n/g, "\n");
    return PERSONA_TEXT_INVISIBLE.test(text) || STACKED_MARKS.test(text);
  }
  if (Array.isArray(value)) return value.some(hasInvisibleText);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, item]) => hasInvisibleText(key) || hasInvisibleText(item));
  }
  return false;
}

/**
 * A persona proposal's `components` (#125), or why they don't hold up; then
 * the whole proposal is dropped, so no persona arrives half-built, and the
 * reply says why. The reasons are fixed text: nothing from the proposal is
 * echoed.
 * - `skills`, `workflows`, `knowledgebases`: existing ids, checked on approval.
 * - `new.skills`: skill proposals, with exactly the fields and limits of a
 *   `mindstone-skill-proposal`; not a built-in skill's id.
 * - `new.workflows`: `{ id, name?, description?, steps }`, checked strictly;
 *   a step can't name a persona (`personaId`, `personaLoadable`).
 * - `new.privateKnowledgebases`: `{ id, name?, sources: [{ text }] }`.
 * - No id both listed and new, and no invisible characters in any text.
 */
export function checkPersonaComponentsProposal(value: unknown): { ok: true; components: ParsedPersonaComponents } | { ok: false; error: string } {
  const empty: ParsedPersonaComponents = { listed: { skills: [], workflows: [], knowledgebases: [] }, skills: [], workflows: [], knowledgebases: [] };
  const fail = (error: string) => ({ ok: false as const, error });
  if (value === undefined) return { ok: true, components: empty };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("its components aren't an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["skills", "workflows", "knowledgebases", "new"].includes(key))) {
    return fail("its components have a key other than skills, workflows, knowledgebases and new");
  }
  const ids = (list: unknown): string[] | undefined => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > PERSONA_COMPONENT_LIMITS.listed) return undefined;
    if (list.some((id) => typeof id !== "string" || !COMPONENT_ID.test(id))) return undefined;
    return [...new Set(list as string[])];
  };
  const skills = ids(record.skills);
  const workflows = ids(record.workflows);
  const knowledgebases = ids(record.knowledgebases);
  if (!skills || !workflows || !knowledgebases) {
    return fail(`a list of existing skills, workflows or knowledge bases isn't a list of up to ${PERSONA_COMPONENT_LIMITS.listed} ids`);
  }
  const parsed: ParsedPersonaComponents = { ...empty, listed: { skills, workflows, knowledgebases } };
  if (record.new === undefined) return { ok: true, components: parsed };
  if (!record.new || typeof record.new !== "object" || Array.isArray(record.new)) return fail("its new components aren't an object");
  const next = record.new as Record<string, unknown>;
  if (Object.keys(next).some((key) => !["skills", "workflows", "privateKnowledgebases"].includes(key))) {
    return fail("its new components have a key other than skills, workflows and privateKnowledgebases");
  }
  if (hasInvisibleText(next)) return fail("a new component has characters that can't be seen on the approval card");
  const list = (entry: unknown, max: number): unknown[] | undefined =>
    entry === undefined ? [] : Array.isArray(entry) && entry.length <= max ? entry : undefined;
  const newSkills = list(next.skills, PERSONA_COMPONENT_LIMITS.newSkills);
  const newWorkflows = list(next.workflows, PERSONA_COMPONENT_LIMITS.newWorkflows);
  const newKbs = list(next.privateKnowledgebases, PERSONA_COMPONENT_LIMITS.newKnowledgebases);
  if (!newSkills || !newWorkflows || !newKbs) {
    return fail(`it brings more than ${PERSONA_COMPONENT_LIMITS.newSkills} new skills, ${PERSONA_COMPONENT_LIMITS.newWorkflows} new workflows or ${PERSONA_COMPONENT_LIMITS.newKnowledgebases} private knowledge bases`);
  }
  const builtins = new Set(builtinMindStoneSkills().map((skill) => skill.artifact.id));
  for (const raw of newSkills) {
    const skill = parseSkillProposal(raw);
    if (!skill) return fail("a new skill isn't a valid skill proposal");
    if (parsed.skills.some((other) => other.id === skill.id)) return fail("two new skills have the same id");
    if (builtins.has(skill.id)) return fail("a new skill has the id of a built-in skill");
    parsed.skills.push(skill);
  }
  for (const raw of newWorkflows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("a new workflow isn't an object");
    const { id, ...definition } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !WORKFLOW_ID.test(id)) return fail("a new workflow's id isn't lowercase letters, digits and hyphens");
    if (parsed.workflows.some((other) => other.id === id)) return fail("two new workflows have the same id");
    // No step of an agent-proposed workflow may name a persona: such a
    // workflow could make one answer turns on the owner's behalf (#125).
    // The checker is told no persona exists, so a step that names one fails.
    const checked = validateWorkflowDefinition(definition, { personaExists: () => false });
    if (!checked.ok) return fail("a new workflow isn't valid (its steps route or gate, and none can name a persona)");
    parsed.workflows.push({ id, definition: checked.workflow });
  }
  for (const raw of newKbs) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("a new private knowledge base isn't an object");
    const kb = raw as Record<string, unknown>;
    if (Object.keys(kb).some((key) => !["id", "name", "sources"].includes(key))) return fail("a new private knowledge base has a key other than id, name and sources");
    if (typeof kb.id !== "string" || !PRIVATE_KB_PROPOSAL_ID.test(kb.id)) return fail("a new private knowledge base's id isn't lowercase letters, digits and hyphens");
    if (parsed.knowledgebases.some((other) => other.id === kb.id)) return fail("two new private knowledge bases have the same id");
    const name = kb.name === undefined ? undefined : boundedText(kb.name, 80);
    // The same rule as a KB created on the admin API, so the card can be approved.
    if (kb.name !== undefined && (!name || /[\u0000-\u001f\u007f]/.test(name))) return fail("a new private knowledge base's name isn't one line of up to 80 characters");
    if (!Array.isArray(kb.sources) || kb.sources.length === 0 || kb.sources.length > PERSONA_COMPONENT_LIMITS.sourcesPerKnowledgebase) {
      return fail(`a new private knowledge base doesn't have 1 to ${PERSONA_COMPONENT_LIMITS.sourcesPerKnowledgebase} sources`);
    }
    const sources: Array<{ name: string; text: string }> = [];
    for (const [index, source] of kb.sources.entries()) {
      if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source as Record<string, unknown>).some((key) => key !== "text")) {
        return fail("a knowledge base source isn't an object with only `text`");
      }
      const text = (source as Record<string, unknown>).text;
      if (typeof text !== "string" || !text.trim() || text.length > PERSONA_COMPONENT_LIMITS.sourceText) {
        return fail(`a knowledge base source's text is empty or longer than ${PERSONA_COMPONENT_LIMITS.sourceText} characters`);
      }
      sources.push({ name: `source-${index + 1}`, text: text.replace(/\r\n/g, "\n") });
    }
    parsed.knowledgebases.push({ id: kb.id, ...(name ? { name } : {}), sources });
  }
  // Listed and new at once: the persona can't be approved (the listed one
  // doesn't exist yet) and the new card waits for the persona (#125 review).
  const clash = (listed: string[], added: Array<{ id: string }>) => added.some((item) => listed.some((id) => id.toLowerCase() === item.id.toLowerCase()));
  if (clash(parsed.listed.skills, parsed.skills) || clash(parsed.listed.workflows, parsed.workflows)) {
    return fail("a skill or workflow is both listed as existing and brought as new; list only existing ones");
  }
  return { ok: true, components: parsed };
}

/** `checkPersonaComponentsProposal` without the reason. */
export function parsePersonaComponents(value: unknown): ParsedPersonaComponents | undefined {
  const checked = checkPersonaComponentsProposal(value);
  return checked.ok ? checked.components : undefined;
}

/** Pending persona proposals kept at once (#105 review). */
export const MAX_PENDING_PERSONAS = 3;

/** The proposal kinds, in one place: every fence pattern below is built from it. */
const PROPOSAL_KINDS = "memory|calendar|persona|skill";
const PROPOSAL_INFO = new RegExp(`^mindstone-(${PROPOSAL_KINDS})-proposal$`);
const PROPOSAL_INLINE_OPENER = new RegExp(`^(.*?\\S)[ \\t]*(\`\`\`mindstone-(?:${PROPOSAL_KINDS})-proposal[ \\t]*\\r?)$`);

/**
 * The reply split into its text and its proposal blocks. A block counts only
 * at the top level, outside any other fenced block (``` or ~~~): one shown
 * inside another fence (an example, or instructions echoed back) is left in
 * the text and never proposed (#105 review). As before, a proposal fence may
 * open at the end of a line of text and close at the end of its last line;
 * an unclosed one isn't a block.
 */
function splitProposalBlocks(replyText: string): { text: string; blocks: Array<{ kind: string; body: string }> } {
  const lines = replyText.split("\n");
  const kept: string[] = [];
  const blocks: Array<{ kind: string; body: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A proposal fence opened after some text: the text stays, the fence starts its own line.
    const inline = PROPOSAL_INLINE_OPENER.exec(line);
    if (inline) {
      lines.splice(i, 1, inline[1]!, inline[2]!);
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*?)\r?$/.exec(line);
    if (!open || (open[1]![0] === "`" && open[2]!.includes("`"))) {
      kept.push(line);
      i += 1;
      continue;
    }
    const marker = open[1]!;
    // A bare ``` fence whose first line is the kind counts too: a model may
    // break the line between the backticks and the name (#105 journey).
    const kindOnNextLine = !open[2]!.trim() && marker === "```" && i + 1 < lines.length
      ? PROPOSAL_INFO.exec(lines[i + 1]!.trim())?.[1]
      : undefined;
    const kind = PROPOSAL_INFO.exec(open[2]!.trim())?.[1] ?? kindOnNextLine;
    const bodyStart = kindOnNextLine && !PROPOSAL_INFO.test(open[2]!.trim()) ? i + 2 : i + 1;
    const close = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t\\r]*$`);
    // A proposal may also close at the end of its last line ("}```").
    const closesInline = (text: string) => kind !== undefined && marker === "```" && /\S[ \t]*```[ \t]*\r?$/.test(text);
    let j = bodyStart;
    while (j < lines.length && !close.test(lines[j]!) && !closesInline(lines[j]!)) j += 1;
    if (kind && j < lines.length) {
      const last = close.test(lines[j]!) ? [] : [lines[j]!.replace(/[ \t]*```[ \t]*\r?$/, "")];
      blocks.push({ kind, body: [...lines.slice(bodyStart, j), ...last].join("\n") });
      // An empty line where the block was, as before, so the text around it stays apart.
      kept.push("");
    } else {
      kept.push(...lines.slice(i, Math.min(j, lines.length - 1) + 1));
    }
    i = j + 1;
  }
  return { text: kept.join("\n"), blocks };
}

export type ExtractedActionProposals = {
  /** Reply text with every proposal block stripped. */
  text: string;
  memory?: MemoryWritePayload;
  mutations: ConnectorMutationPayload[];
  /** The first well-formed persona proposal (#105). */
  persona?: PersonaProposalPayload;
  /** Its components (#125); a proposal whose components don't hold up is dropped whole. */
  personaComponents?: ParsedPersonaComponents;
  /** Skill blocks dropped although another was used, or why the only one was (#125 review). */
  skillBlocksDropped?: number;
  skillProposalError?: string;
  /** Persona blocks dropped although another was used: only one per reply is (#125 review). */
  personaBlocksDropped?: number;
  /** Why a persona proposal was dropped (#125 review), so the reply can say so. */
  personaProposalError?: string;
  /** At most one proposed skill per reply (#104). */
  skill?: SkillInstallPayload;
};

export function extractActionProposals(replyText: string): ExtractedActionProposals {
  const mutations: ConnectorMutationPayload[] = [];
  let memory: MemoryWritePayload | undefined;
  let persona: PersonaProposalPayload | undefined;
  let personaComponents: ParsedPersonaComponents | undefined;
  let personaProposalError: string | undefined;
  let personaBlocks = 0;
  let skillBlocks = 0;
  let skillProposalError: string | undefined;
  let skill: SkillInstallPayload | undefined;
  const split = splitProposalBlocks(replyText);
  for (const { kind: fenceKind, body } of split.blocks) {
    // An empty block is noise, not a proposal: dropped without a word, as before.
    if (!body.trim()) continue;
    // Counted once each, whatever happens while reading it (#125 review).
    if (fenceKind === "persona") personaBlocks += 1;
    if (fenceKind === "skill") skillBlocks += 1;
    try {
      const parsed = JSON.parse(body);
      if (fenceKind === "memory") {
        const path = typeof parsed?.path === "string" ? parsed.path.trim() : "";
        const content = typeof parsed?.content === "string" ? parsed.content : "";
        // A path is a file name: no control, bidi or tag characters, which
        // would reach terminals and file names as they are (#125 review).
        if (path && content && !memory && !PROPOSAL_UNSAFE_NAME.test(path)) memory = { path, content };
      } else if (fenceKind === "persona") {
        if (!persona) {
          const base = parsePersonaProposal(parsed);
          const components = base ? checkPersonaComponentsProposal((parsed as Record<string, unknown>).components) : undefined;
          if (base && components?.ok) {
            persona = base;
            personaComponents = components.components;
          } else if (components && !components.ok) {
            personaProposalError ??= components.error;
          } else {
            personaProposalError ??= "its id, name, voice, working style or boundaries don't hold up (see their limits)";
          }
        }
      } else if (fenceKind === "skill") {
        if (!skill) {
          skill = parseSkillProposal(parsed);
          if (!skill) skillProposalError ??= "its fields don't hold up (an id, a one-line label and a one-line description are needed, within their limits)";
        }
      } else {
        const operation = parsed?.operation === "update" ? "update" : parsed?.operation === "create" ? "create" : undefined;
        const resource = typeof parsed?.resource === "string" && parsed.resource.trim() ? parsed.resource.trim() : "event";
        const data = parsed?.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? (parsed.data as Record<string, unknown>) : undefined;
        // A resource that isn't a plain name drops the proposal: the card
        // never shows a different resource than the agent proposed (#125 review).
        if (operation && data && !PROPOSAL_UNSAFE_NAME.test(resource)) {
          mutations.push({ connectorId: "calendar", operation, resource, data });
        }
      }
    } catch {
      // malformed proposal blocks are dropped from the reply, never applied;
      // a persona's is said in the reply (#125 review)
      if (fenceKind === "persona" && !persona) personaProposalError ??= "its block isn't valid JSON, or couldn't be read";
      if (fenceKind === "skill" && !skill) skillProposalError ??= "its block isn't valid JSON, or couldn't be read";
    }
  }
  return {
    text: split.text.trim(),
    memory,
    mutations,
    persona,
    personaComponents,
    ...(persona ? { personaBlocksDropped: personaBlocks - 1 } : { personaProposalError }),
    skill,
    ...(skill ? { skillBlocksDropped: skillBlocks - 1 } : skillBlocks ? { skillProposalError } : {}),
  };
}

/** The reply, then any notes about dropped proposals, apart from it by a blank line. */
function withNotes(text: string, notes: string): string {
  return notes ? (text ? `${text}\n\n${notes}` : notes) : text;
}

/** Back-compat single-memory-proposal shape (issue #21 callers/tests). */
export function extractMemoryProposal(replyText: string): { text: string; proposal?: MemoryWritePayload } {
  const extracted = extractActionProposals(replyText);
  return { text: extracted.text, proposal: extracted.memory };
}

/**
 * Strip proposal blocks from a string WITHOUT proposing; no-op (identity)
 * when none present. The same blocks the text path finds (#105 review), so
 * structured content and text never disagree.
 */
export function stripProposalFences(text: string): string {
  const split = splitProposalBlocks(text);
  return split.blocks.length === 0 ? text : split.text.trim();
}

/**
 * Deep strip-only pass over an arbitrary content value (Slate's #22 QA
 * finding): providers may return structured/opaque `content` alongside
 * `text`, and transcript/context/auto-compact/webchat paths can read it — so
 * a fence stripped from `text` must not survive in `content`. Walks plain
 * JSON-ish data (strings, arrays, objects) and strips fences from every
 * string; never proposes (proposing is text-path-only, keeping it
 * single-source).
 */
export function stripActionProposalsDeep(value: unknown): unknown {
  if (typeof value === "string") return stripProposalFences(value);
  if (Array.isArray(value)) return value.map((entry) => stripActionProposalsDeep(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, stripActionProposalsDeep(entry)]));
  }
  return value;
}

/**
 * The single shared proposal-discipline step (issues #21/#22), called by BOTH
 * assistant-reply finalization sites (core chat turn AND the Gateway's
 * configured-route path): extract proposal blocks from the reply, persist
 * them as pending ProposedActions, append approval_proposed audit events, and
 * return the stripped reply text. Nothing consequential executes here — apply
 * happens only via an explicit approve.
 */
export function applyActionProposalDiscipline(params: {
  replyText: string;
  /** Provider `content` payload persisted alongside text — deep-stripped of fences (never proposed from). */
  content?: unknown;
  sessionKey?: string;
  agentId?: string;
  /** Where the reply came from (e.g. "chat", "gateway", "connector:email"). */
  origin: string;
  source?: TranscriptSource;
  runId?: string;
  store?: ApprovalStore;
  /**
   * Whether this turn may propose a persona (#105): the owner's turns only.
   * Otherwise a persona block is stripped and dropped.
   */
  allowPersona?: boolean;
  /**
   * Skill proposals are the owner's (#104): an installed skill joins the
   * owner's prompt, so a reply to anyone else never proposes one. The block is
   * still stripped from the reply.
   */
  allowSkill?: boolean;
}): { text: string; content: unknown; events: TranscriptEntry[]; proposals: ProposedAction[] } {
  const extracted = extractActionProposals(params.replyText);
  // Sanitize content always: proposals may exist in content even when text
  // is already clean (diverging shapes), and a ~~~ or bare-fence block has
  // no "```mindstone-" to probe for (#105 review).
  const content = params.content !== undefined ? stripActionProposalsDeep(params.content) : params.content;
  // At most a few persona proposals wait at once: the instruction is on every
  // owner turn, so an agent that keeps proposing can't flood Approvals.
  const store = params.store ?? new ApprovalStore();
  const pending = store.pending();
  const mine = (action: ProposedAction) => (action.agentId ?? "default") === (params.agentId ?? "default");
  // A component card counts only while its persona card is still live: one
  // left under a rejected persona can't be approved and is rejected when
  // tried, so it doesn't hold a place (#125 review).
  const liveComponent = (action: ProposedAction) => {
    if (!action.parentApprovalId) return false;
    const parent = store.get(action.parentApprovalId);
    return parent !== undefined && parent.status !== "rejected";
  };
  const pendingPersonas = pending.filter((action) => action.kind === "persona_create" && mine(action)).length;
  // Only component cards count toward the component caps: a plain skill
  // proposal (#104) never does (#125 review).
  const pendingComponents = (kind: ProposedActionKind) => pending.filter((action) => action.kind === kind && mine(action) && liveComponent(action)).length;
  const components = extracted.personaComponents;
  const overCap = (count: number, kind: ProposedActionKind) => count > 0 && count + pendingComponents(kind) > MAX_PENDING_COMPONENTS;
  // A persona proposal and each of its new components wait on their own
  // cards; if any kind it brings is at its cap, the whole proposal is dropped (#125).
  const capped = Boolean(params.allowPersona && extracted.persona) && (
    pendingPersonas >= MAX_PENDING_PERSONAS
    || overCap(components?.skills.length ?? 0, "skill_install")
    || overCap(components?.workflows.length ?? 0, "workflow_create")
    || overCap(components?.knowledgebases.length ?? 0, "persona_kb_create")
  );
  const persona = params.allowPersona && !capped ? extracted.persona : undefined;
  // A separate skill proposal with the id of a skill the persona brings is
  // dropped: approving one would replace what was reviewed on the other (#125 review).
  const skillClash = Boolean(persona && extracted.skill && components?.skills.some((item) => item.id === extracted.skill!.id));
  const skill = params.allowSkill && !skillClash ? extracted.skill : undefined;
  // A dropped proposal is said, not swallowed: the owner reads why in the reply.
  const refused = params.allowPersona ? extracted.personaProposalError : undefined;
  const extraBlocks = persona ? extracted.personaBlocksDropped ?? 0 : 0;
  const cappedNote = [
    capped
      ? `(The persona proposal wasn't saved: too many persona proposals, or proposed skills, workflows or knowledge bases, are already waiting on the Approvals page. Approve or reject those first.)`
      : refused
        ? `(The persona proposal wasn't saved, and nothing was put up for approval: ${refused}.)`
        : "",
    extraBlocks > 0 ? `(Only one persona proposal per reply is put up for approval; ${extraBlocks} other persona block(s) in this reply were dropped.)` : "",
    skillClash && params.allowSkill
      ? `(The separate skill proposal wasn't saved: the persona brings a skill with the same id, on its own card.${(extracted.skillBlocksDropped ?? 0) > 0 ? ` The other skill block(s) in this reply weren't saved either: one skill proposal per reply is read.` : ""})`
      : "",
    params.allowSkill && extracted.skillProposalError ? `(The skill proposal wasn't saved, and nothing was put up for approval: ${extracted.skillProposalError}.)` : "",
    params.allowSkill && !skillClash && (extracted.skillBlocksDropped ?? 0) > 0 ? `(Only one skill proposal per reply is put up for approval; ${extracted.skillBlocksDropped} other skill block(s) were dropped.)` : "",
  ].filter(Boolean).join("\n\n");
  // Every drop is in the transcript too, not only in the reply (#125 review).
  const drops: Array<{ reason: string; text: string }> = [
    ...(capped ? [{ reason: "too_many_pending", text: "persona proposal dropped: too many proposals already pending" }] : []),
    ...(!capped && refused ? [{ reason: "invalid_proposal", text: `persona proposal dropped: ${refused}` }] : []),
    ...(extraBlocks > 0 ? [{ reason: "extra_persona_blocks", text: `${extraBlocks} other persona block(s) dropped: one per reply` }] : []),
    ...(skillClash && params.allowSkill ? [{ reason: "skill_id_clash", text: "skill proposal dropped: the persona brings a skill with the same id" }] : []),
    ...(params.allowSkill && extracted.skillProposalError ? [{ reason: "invalid_skill_proposal", text: `skill proposal dropped: ${extracted.skillProposalError}` }] : []),
    ...(params.allowSkill && (extracted.skillBlocksDropped ?? 0) > 0 ? [{ reason: "extra_skill_blocks", text: `${extracted.skillBlocksDropped} other skill block(s) dropped: one per reply` }] : []),
  ];
  const cappedEvents = params.sessionKey
    ? drops.map((drop) => appendTranscriptEntry({
        sessionKey: params.sessionKey!,
        agentId: params.agentId ?? "default",
        role: "event",
        text: drop.text,
        source: params.source,
        runId: params.runId,
        metadata: { event: /skill/.test(drop.reason) ? "skill_proposal_dropped" : "persona_proposal_dropped", reason: drop.reason, origin: params.origin },
      }))
    : [];
  if (!extracted.memory && !extracted.mutations.length && !persona && !skill) {
    return { text: withNotes(extracted.text, cappedNote), content, events: cappedEvents, proposals: [] };
  }
  const approvals = store;
  const personaCard = persona
    ? approvals.propose({
        kind: "persona_create" as const,
        connectorId: params.origin,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        createdAt: new Date().toISOString(),
        summary: `persona proposal from ${params.origin}: ${persona.name} (${persona.id})`,
        persona,
        ...(components ? { components: components.listed } : {}),
      })
    : undefined;
  // Each new component on its own card, linked to the persona's (#125).
  const componentCards: ProposedAction[] = personaCard && persona && components
    ? [
        ...components.skills.map((component) => approvals.propose({
          kind: "skill_install" as const,
          connectorId: params.origin,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          createdAt: new Date().toISOString(),
          summary: `install skill ${component.id} for persona ${persona.id}: ${component.label}`,
          skill: component,
          parentApprovalId: personaCard.id,
        })),
        ...components.workflows.map((component) => approvals.propose({
          kind: "workflow_create" as const,
          connectorId: params.origin,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          createdAt: new Date().toISOString(),
          summary: `workflow ${component.id} for persona ${persona.id} (${component.definition.steps.length} step(s))`,
          workflow: { id: component.id, personaId: persona.id, definition: component.definition },
          parentApprovalId: personaCard.id,
        })),
        ...components.knowledgebases.map((component) => approvals.propose({
          kind: "persona_kb_create" as const,
          connectorId: params.origin,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          createdAt: new Date().toISOString(),
          summary: `private knowledge base ${component.id} for persona ${persona.id} (${component.sources.length} source(s))`,
          knowledgebase: { personaId: persona.id, ...component },
          parentApprovalId: personaCard.id,
        })),
      ]
    : [];
  const proposals: ProposedAction[] = [
    ...(extracted.memory
      ? [approvals.propose({
          kind: "memory_write" as const,
          connectorId: params.origin,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          createdAt: new Date().toISOString(),
          summary: `memory write proposal from ${params.origin}: ${extracted.memory.path}`,
          memory: extracted.memory,
        })]
      : []),
    ...(personaCard ? [personaCard, ...componentCards] : []),
    ...(skill
      ? [approvals.propose({
          kind: "skill_install" as const,
          connectorId: params.origin,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          createdAt: new Date().toISOString(),
          summary: `install skill ${skill.id}: ${skill.label}`,
          skill,
        })]
      : []),
    ...extracted.mutations.map((mutation) =>
      approvals.propose({
        kind: "connector_mutation" as const,
        connectorId: mutation.connectorId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        createdAt: new Date().toISOString(),
        summary: `${mutation.operation} ${mutation.resource} via ${mutation.connectorId}: ${summaryText(JSON.stringify(mutation.data).slice(0, 80))}`,
        mutation,
      }),
    ),
  ];
  const events = params.sessionKey
    ? proposals.map((proposal) =>
        appendTranscriptEntry({
          sessionKey: params.sessionKey!,
          agentId: params.agentId ?? "default",
          role: "event",
          text: `approval proposed: ${proposal.kind} ${proposal.id} (${proposal.summary})`,
          source: params.source,
          runId: params.runId,
          metadata: { event: "approval_proposed", approvalId: proposal.id, kind: proposal.kind, origin: params.origin },
        }),
      )
    : [];
  return { text: withNotes(extracted.text, cappedNote), content, events: [...cappedEvents, ...events], proposals };
}

/**
 * Sanitize a memory-proposal path on APPLY (not on propose — the record keeps
 * what the model asked for, the apply step constrains it): relative, no
 * traversal, markdown extension enforced.
 */
export function sanitizeMemoryProposalPath(path: string): string | undefined {
  const cleaned = path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  // Also checked here, at approve time, for a card proposed before names were checked (#125 review).
  if (!cleaned || cleaned.includes("..") || PROPOSAL_UNSAFE_NAME.test(cleaned)) return undefined;
  const withExt = cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
  return withExt;
}
