import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import { loadMindStonePersona, personasDirFromConfig, resolveMindStonePersona } from "../persona/load.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type {
  MindStoneWorkflowCondition,
  MindStoneWorkflowDefinition,
  MindStoneWorkflowEvent,
  MindStoneWorkflowOutcome,
  MindStoneWorkflowStep,
  MindStoneWorkflowSummary,
} from "./types.js";

/** Attempts a gate gets at most, however many `retry.maxAttempts` asks for (#125). */
export const MAX_WORKFLOW_GATE_ATTEMPTS = 5;

export function workflowsDirFromConfig(config: MindStoneConfig | undefined, paths?: MindStoneRuntimePaths): string {
  const resolved = paths ?? runtimePathsFromEnv();
  return resolve(config?.workflows?.dir ?? join(resolved.dataDir, "workflows"));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function parseCondition(value: unknown): MindStoneWorkflowCondition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const condition: MindStoneWorkflowCondition = {
    sessionKeyPrefix: typeof record.sessionKeyPrefix === "string" ? record.sessionKeyPrefix : undefined,
    sourceChannel: typeof record.sourceChannel === "string" ? record.sourceChannel : undefined,
    sourceSubstrate: typeof record.sourceSubstrate === "string" ? record.sourceSubstrate : undefined,
    messagePrefix: typeof record.messagePrefix === "string" ? record.messagePrefix : undefined,
  };
  return Object.values(condition).some((entry) => entry !== undefined) ? condition : undefined;
}

export type LoadWorkflowResult =
  | { ok: true; workflow: MindStoneWorkflowDefinition }
  | { ok: false; workflowId: string; error: string };

export function loadMindStoneWorkflow(workflowsDir: string, workflowId: string): LoadWorkflowResult {
  const dir = join(workflowsDir, workflowId);
  const definitionPath = join(dir, "workflow.json");
  if (!existsSync(definitionPath)) {
    return { ok: false, workflowId, error: `workflow.json not found at ${definitionPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(definitionPath, "utf-8"));
  } catch (error) {
    return { ok: false, workflowId, error: `workflow.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, workflowId, error: "workflow.json must be an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    return { ok: false, workflowId, error: "workflow.json requires a non-empty steps array" };
  }
  const steps: MindStoneWorkflowStep[] = [];
  for (const [index, rawStep] of record.steps.entries()) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      return { ok: false, workflowId, error: `steps[${index}] must be an object` };
    }
    const stepRecord = rawStep as Record<string, unknown>;
    const kind = stepRecord.kind;
    if (kind !== "route" && kind !== "gate") {
      return { ok: false, workflowId, error: `steps[${index}].kind must be "route" or "gate"` };
    }
    const gateRecord = stepRecord.gate && typeof stepRecord.gate === "object" && !Array.isArray(stepRecord.gate)
      ? stepRecord.gate as Record<string, unknown>
      : undefined;
    if (kind === "gate" && !gateRecord) {
      return { ok: false, workflowId, error: `steps[${index}] is a gate but has no gate definition` };
    }
    const retryRecord = stepRecord.retry && typeof stepRecord.retry === "object" && !Array.isArray(stepRecord.retry)
      ? stepRecord.retry as Record<string, unknown>
      : undefined;
    steps.push({
      id: typeof stepRecord.id === "string" && stepRecord.id.trim() ? stepRecord.id : `step-${index + 1}`,
      kind,
      when: parseCondition(stepRecord.when),
      personaId: typeof stepRecord.personaId === "string" ? stepRecord.personaId : undefined,
      skills: stringList(stepRecord.skills),
      knowledgebases: stringList(stepRecord.knowledgebases),
      gate: gateRecord
        ? {
            personaLoadable: typeof gateRecord.personaLoadable === "string" ? gateRecord.personaLoadable : undefined,
            condition: parseCondition(gateRecord.condition),
          }
        : undefined,
      retry: retryRecord ? { maxAttempts: typeof retryRecord.maxAttempts === "number" ? retryRecord.maxAttempts : undefined } : undefined,
      onFail: stepRecord.onFail === "continue" ? "continue" : stepRecord.onFail === "stop" ? "stop" : undefined,
    });
  }
  return {
    ok: true,
    workflow: {
      id: workflowId,
      dir,
      name: typeof record.name === "string" && record.name.trim() ? record.name : workflowId,
      version: typeof record.version === "string" ? record.version : undefined,
      description: typeof record.description === "string" ? record.description : undefined,
      steps,
    },
  };
}

/**
 * Persona ids (as written, and lowercased) the config already puts to use: `personas.active`, a persona
 * route rule, or a workflow step (its persona, or a gate on one being
 * loadable). Approving a persona the agent proposed under one of these ids
 * would make it answer with no switch, so the approval is refused (#105
 * review).
 */
export function referencedPersonaIds(config: MindStoneConfig | undefined, paths?: MindStoneRuntimePaths): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    // As written, and lowercased: persona directories match regardless of
    // case on macOS and Windows (#105 review).
    if (typeof value === "string" && value.trim()) ids.add(value.trim()).add(value.trim().toLowerCase());
  };
  add(config?.personas?.active);
  for (const rule of Array.isArray(config?.personas?.routes) ? config.personas.routes : []) add(rule?.personaId);
  const workflowsDir = workflowsDirFromConfig(config, paths);
  if (existsSync(workflowsDir)) {
    for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const loaded = loadMindStoneWorkflow(workflowsDir, entry.name);
      if (!loaded.ok) continue;
      for (const step of loaded.workflow.steps) {
        add(step.personaId);
        add(step.gate?.personaLoadable);
      }
    }
  }
  return ids;
}

export function discoverMindStoneWorkflows(workflowsDir: string): MindStoneWorkflowSummary[] {
  if (!existsSync(workflowsDir)) return [];
  const summaries: MindStoneWorkflowSummary[] = [];
  for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const loaded = loadMindStoneWorkflow(workflowsDir, entry.name);
    if (loaded.ok) {
      summaries.push({
        id: loaded.workflow.id,
        name: loaded.workflow.name,
        version: loaded.workflow.version,
        description: loaded.workflow.description,
        dir: loaded.workflow.dir,
        stepCount: loaded.workflow.steps.length,
      });
    } else {
      summaries.push({ id: entry.name, name: entry.name, dir: join(workflowsDir, entry.name), stepCount: 0, error: loaded.error });
    }
  }
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

export type WorkflowTurnInput = {
  sessionKey?: string;
  sourceChannel?: string;
  sourceSubstrate?: string;
  messageText?: string;
};

function conditionMatches(condition: MindStoneWorkflowCondition, turn: WorkflowTurnInput): { matched: boolean; fields: string[] } {
  const checks: Array<[string, boolean]> = [];
  if (condition.sessionKeyPrefix !== undefined) checks.push(["sessionKeyPrefix", Boolean(turn.sessionKey?.startsWith(condition.sessionKeyPrefix))]);
  if (condition.sourceChannel !== undefined) checks.push(["sourceChannel", turn.sourceChannel === condition.sourceChannel]);
  if (condition.sourceSubstrate !== undefined) checks.push(["sourceSubstrate", turn.sourceSubstrate === condition.sourceSubstrate]);
  if (condition.messagePrefix !== undefined) {
    checks.push(["messagePrefix", Boolean(turn.messageText?.toLowerCase().startsWith(condition.messagePrefix.toLowerCase()))]);
  }
  return { matched: checks.length > 0 && checks.every(([, matched]) => matched), fields: checks.map(([field]) => field) };
}

/**
 * Deterministic workflow selection: first matching config route rule wins, then
 * workflows.active, then the active persona's workflows. A persona's listed
 * workflows are all candidates, in order (#125): the first one that reaches a
 * decision is used.
 */
export function resolveMindStoneWorkflowCandidates(params: {
  config: MindStoneConfig | undefined;
  paths?: MindStoneRuntimePaths;
  turn: WorkflowTurnInput;
  /** A persona the request names (App Engine): its workflows are the candidates, not the configured persona's. */
  personaId?: string;
}): Array<{ workflowId: string; reason: string }> {
  const workflows = params.config?.workflows;
  for (const rule of workflows?.routes ?? []) {
    if (!rule.workflowId) continue;
    const { matched, fields } = conditionMatches(rule, params.turn);
    if (matched) return [{ workflowId: rule.workflowId, reason: `route:${fields.join("+")}` }];
  }
  if (workflows?.active?.trim()) return [{ workflowId: workflows.active, reason: "config.active" }];

  const personaResolution = params.personaId
    ? { personaId: params.personaId }
    : resolveMindStonePersona({
        config: params.config,
        sessionKey: params.turn.sessionKey,
        sourceChannel: params.turn.sourceChannel,
        sourceSubstrate: params.turn.sourceSubstrate,
      });
  if (personaResolution) {
    const persona = loadMindStonePersona(personasDirFromConfig(params.config, params.paths), personaResolution.personaId);
    if (persona.ok) {
      return [...new Set(persona.persona.workflows)].map((workflowId) => ({ workflowId, reason: `persona:${personaResolution.personaId}` }));
    }
  }
  return [];
}

/** The first candidate from `resolveMindStoneWorkflowCandidates`. */
export function resolveMindStoneWorkflowId(params: {
  config: MindStoneConfig | undefined;
  paths?: MindStoneRuntimePaths;
  turn: WorkflowTurnInput;
  personaId?: string;
}): { workflowId: string; reason: string } | undefined {
  return resolveMindStoneWorkflowCandidates(params)[0];
}

/**
 * Run the selected workflow's steps deterministically for this turn.
 * Steps evaluate top-to-bottom: gates must pass (with per-step retry, honoring
 * onFail stop/continue); the first route step whose condition matches (or that
 * has no condition) produces the decision and finishes the workflow.
 */
export function runMindStoneWorkflow(params: {
  config: MindStoneConfig | undefined;
  paths?: MindStoneRuntimePaths;
  turn: WorkflowTurnInput;
  /** Deterministically force this workflow (App Engine request routing) — bypasses selection. */
  workflowId?: string;
  /** The persona the request names (App Engine): its workflows are the candidates. */
  personaId?: string;
}): MindStoneWorkflowOutcome | undefined {
  const candidates = params.workflowId
    ? [{ workflowId: params.workflowId, reason: "forced:request" }]
    : resolveMindStoneWorkflowCandidates({ config: params.config, paths: params.paths, turn: params.turn, personaId: params.personaId });
  // A persona's workflows are tried in order (#125): the first to reach a
  // decision wins. One with no matching route step, or that doesn't load,
  // passes to the next; a gate with onFail "stop" ends the selection, as it
  // ends its workflow. The events of every workflow tried are kept, so the
  // transcript shows why the earlier ones didn't decide.
  const events: MindStoneWorkflowEvent[] = [];
  const tried: string[] = [];
  let outcome: MindStoneWorkflowOutcome | undefined;
  for (const selected of candidates) {
    const run = runSelectedWorkflow(params, selected);
    outcome = run.outcome;
    tried.push(outcome.workflowId);
    events.push(...outcome.events);
    if (outcome.decision || run.stoppedAtGate) break;
  }
  return outcome ? { ...outcome, events, ...(tried.length > 1 ? { tried } : {}) } : undefined;
}

function runSelectedWorkflow(
  params: { config: MindStoneConfig | undefined; paths?: MindStoneRuntimePaths; turn: WorkflowTurnInput },
  selected: { workflowId: string; reason: string },
): { outcome: MindStoneWorkflowOutcome; stoppedAtGate?: boolean } {
  const workflowsDir = workflowsDirFromConfig(params.config, params.paths);
  const events: MindStoneWorkflowEvent[] = [];
  const loaded = loadMindStoneWorkflow(workflowsDir, selected.workflowId);
  if (!loaded.ok) {
    events.push({
      event: "workflow_failed",
      text: `Workflow ${selected.workflowId} failed to load: ${loaded.error}`,
      metadata: { event: "workflow_failed", workflowId: selected.workflowId, reason: selected.reason, error: loaded.error },
    });
    return { outcome: { workflowId: selected.workflowId, reason: selected.reason, failed: true, events } };
  }
  const workflow = loaded.workflow;
  events.push({
    event: "workflow_started",
    text: `Workflow started: ${workflow.name} (${workflow.id}) via ${selected.reason}.`,
    metadata: { event: "workflow_started", workflowId: workflow.id, reason: selected.reason, steps: workflow.steps.length },
  });

  for (const step of workflow.steps) {
    if (step.kind === "gate") {
      const maxAttempts = Math.min(MAX_WORKFLOW_GATE_ATTEMPTS, Math.max(1, Math.floor(step.retry?.maxAttempts ?? 1)));
      let passed = false;
      let detail = "";
      let attempts = 0;
      for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
        if (step.gate?.personaLoadable) {
          const persona = loadMindStonePersona(personasDirFromConfig(params.config, params.paths), step.gate.personaLoadable);
          passed = persona.ok;
          detail = persona.ok ? `persona ${step.gate.personaLoadable} loads` : persona.error;
        } else if (step.gate?.condition) {
          const { matched, fields } = conditionMatches(step.gate.condition, params.turn);
          passed = matched;
          detail = `condition ${fields.join("+")} ${matched ? "matched" : "did not match"}`;
        } else {
          passed = true;
          detail = "empty gate passes";
        }
        if (passed) break;
      }
      events.push({
        event: "workflow_gate",
        text: `Workflow gate ${step.id}: ${passed ? "passed" : "failed"} (${detail}${attempts > 1 ? `, ${attempts} attempt(s)` : ""}).`,
        metadata: { event: "workflow_gate", workflowId: workflow.id, stepId: step.id, passed, attempts, detail },
      });
      if (!passed && (step.onFail ?? "stop") === "stop") {
        events.push({
          event: "workflow_failed",
          text: `Workflow ${workflow.id} stopped at gate ${step.id}.`,
          metadata: { event: "workflow_failed", workflowId: workflow.id, stepId: step.id },
        });
        return { outcome: { workflowId: workflow.id, reason: selected.reason, failed: true, events }, stoppedAtGate: true };
      }
      continue;
    }

    // route step
    const match = step.when ? conditionMatches(step.when, params.turn) : { matched: true, fields: ["unconditional"] };
    events.push({
      event: "workflow_step",
      text: `Workflow step ${step.id}: ${match.matched ? "matched" : "skipped"} (${match.fields.join("+")}).`,
      metadata: { event: "workflow_step", workflowId: workflow.id, stepId: step.id, matched: match.matched, fields: match.fields },
    });
    if (!match.matched) continue;
    const decision = {
      workflowId: workflow.id,
      stepId: step.id,
      personaId: step.personaId,
      skills: step.skills ?? [],
      knowledgebases: step.knowledgebases ?? [],
    };
    events.push({
      event: "workflow_finished",
      text: `Workflow ${workflow.id} finished: step ${step.id} routes persona=${decision.personaId ?? "none"} skills=${decision.skills.length} kbs=${decision.knowledgebases.length}.`,
      metadata: { event: "workflow_finished", workflowId: workflow.id, stepId: step.id, personaId: decision.personaId, skills: decision.skills, knowledgebases: decision.knowledgebases },
    });
    return { outcome: { workflowId: workflow.id, reason: selected.reason, decision, failed: false, events } };
  }

  events.push({
    event: "workflow_finished",
    text: `Workflow ${workflow.id} finished with no matching route step.`,
    metadata: { event: "workflow_finished", workflowId: workflow.id, decision: null },
  });
  return { outcome: { workflowId: workflow.id, reason: selected.reason, failed: false, events } };
}
