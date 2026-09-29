import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_WORKFLOW_GATE_ATTEMPTS } from "./load.js";
import type { MindStoneWorkflowCondition, MindStoneWorkflowStep } from "./types.js";

/**
 * Strict checks for a workflow written through the admin API (#125). The
 * loader stays lenient for workflows already on disk; what the Console saves
 * must say exactly what it means:
 * - unknown keys are refused;
 * - an empty `when`, an empty-string condition field and an empty gate are
 *   refused (the loader treats each of them as "always");
 * - `retry.maxAttempts` is a whole number from 1 to MAX_WORKFLOW_GATE_ATTEMPTS;
 * - a step can name a persona only if it exists under exactly that id.
 */

export const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_WORKFLOW_STEPS = 20;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COMPONENT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const MAX_TEXT = 200;
const MAX_REFS = 32;

export type WorkflowDefinitionInput = {
  name?: string;
  description?: string;
  version?: string;
  steps: MindStoneWorkflowStep[];
};

export type ValidateWorkflowResult =
  | { ok: true; workflow: WorkflowDefinitionInput }
  | { ok: false; error: string };

type Context = {
  /** True when a persona exists under exactly this id (case included). */
  personaExists: (id: string) => boolean;
  /** True when a skill is installed under this id. A route step's skills must be: a typo would narrow the skill set to nothing. */
  skillInstalled?: (id: string) => boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unknownKey(record: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(record).find((key) => !allowed.includes(key));
}

function optionalText(value: unknown, where: string, max: number): string | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    return { error: `${where} must be non-empty text of at most ${max} characters on one line` };
  }
  return value.trim();
}

function condition(value: unknown, where: string): MindStoneWorkflowCondition | { error: string } {
  if (!isRecord(value)) return { error: `${where} must be an object` };
  const extra = unknownKey(value, ["sessionKeyPrefix", "sourceChannel", "sourceSubstrate", "messagePrefix"]);
  if (extra) return { error: `${where} has an unknown field: ${extra}` };
  const result: MindStoneWorkflowCondition = {};
  for (const key of ["sessionKeyPrefix", "sourceChannel", "sourceSubstrate", "messagePrefix"] as const) {
    const text = optionalText(value[key], `${where}.${key}`, MAX_TEXT);
    if (text && typeof text === "object") return text;
    if (text) result[key] = text;
  }
  if (Object.keys(result).length === 0) return { error: `${where} needs at least one field; an empty one would match every turn` };
  return result;
}

function refs(value: unknown, where: string): string[] | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REFS || value.some((id) => typeof id !== "string" || !COMPONENT_ID.test(id))) {
    return { error: `${where} must be a list of at most ${MAX_REFS} ids` };
  }
  return [...new Set(value as string[])];
}

function persona(value: unknown, where: string, context: Context): string | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !COMPONENT_ID.test(value)) return { error: `${where} must be a persona id` };
  if (!context.personaExists(value)) return { error: `${where}: no persona named "${value}"` };
  return value;
}

export function validateWorkflowDefinition(value: unknown, context: Context): ValidateWorkflowResult {
  if (!isRecord(value)) return { ok: false, error: "a workflow must be an object" };
  const extra = unknownKey(value, ["name", "description", "version", "steps"]);
  if (extra) return { ok: false, error: `unknown field: ${extra}` };
  const name = optionalText(value.name, "name", 80);
  const description = optionalText(value.description, "description", 300);
  const version = optionalText(value.version, "version", 40);
  for (const field of [name, description, version]) if (field && typeof field === "object") return { ok: false, error: field.error };
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_WORKFLOW_STEPS) {
    return { ok: false, error: `steps must be a list of 1 to ${MAX_WORKFLOW_STEPS} steps` };
  }
  const steps: MindStoneWorkflowStep[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.steps.entries()) {
    const where = `steps[${index}]`;
    if (!isRecord(raw)) return { ok: false, error: `${where} must be an object` };
    if (typeof raw.id !== "string" || !STEP_ID.test(raw.id)) return { ok: false, error: `${where}.id must be lowercase letters, digits and hyphens` };
    if (seen.has(raw.id)) return { ok: false, error: `${where}.id "${raw.id}" is used twice` };
    seen.add(raw.id);
    if (raw.kind === "route") {
      const bad = unknownKey(raw, ["id", "kind", "when", "personaId", "skills", "knowledgebases"]);
      if (bad) return { ok: false, error: `${where} is a route step and can't have ${bad}` };
      const when = raw.when === undefined ? undefined : condition(raw.when, `${where}.when`);
      const personaId = persona(raw.personaId, `${where}.personaId`, context);
      const skills = refs(raw.skills, `${where}.skills`);
      if (Array.isArray(skills) && context.skillInstalled) {
        const missing = skills.find((id) => !context.skillInstalled!(id));
        if (missing) return { ok: false, error: `${where}.skills: no installed skill named "${missing}"` };
      }
      const knowledgebases = refs(raw.knowledgebases, `${where}.knowledgebases`);
      for (const field of [when, personaId, skills, knowledgebases]) {
        if (field && typeof field === "object" && "error" in field) return { ok: false, error: (field as { error: string }).error };
      }
      steps.push({
        id: raw.id,
        kind: "route",
        ...(when ? { when: when as MindStoneWorkflowCondition } : {}),
        ...(personaId ? { personaId: personaId as string } : {}),
        ...(skills ? { skills: skills as string[] } : {}),
        ...(knowledgebases ? { knowledgebases: knowledgebases as string[] } : {}),
      });
      continue;
    }
    if (raw.kind === "gate") {
      const bad = unknownKey(raw, ["id", "kind", "gate", "retry", "onFail"]);
      if (bad) return { ok: false, error: `${where} is a gate step and can't have ${bad}` };
      if (!isRecord(raw.gate)) return { ok: false, error: `${where}.gate must be an object` };
      const gateExtra = unknownKey(raw.gate, ["personaLoadable", "condition"]);
      if (gateExtra) return { ok: false, error: `${where}.gate has an unknown field: ${gateExtra}` };
      const hasPersona = raw.gate.personaLoadable !== undefined;
      const hasCondition = raw.gate.condition !== undefined;
      if (hasPersona === hasCondition) return { ok: false, error: `${where}.gate needs exactly one of personaLoadable or condition; an empty gate would always pass` };
      const personaLoadable = persona(raw.gate.personaLoadable, `${where}.gate.personaLoadable`, context);
      if (personaLoadable && typeof personaLoadable === "object") return { ok: false, error: personaLoadable.error };
      const gateCondition = hasCondition ? condition(raw.gate.condition, `${where}.gate.condition`) : undefined;
      if (gateCondition && "error" in gateCondition) return { ok: false, error: gateCondition.error as string };
      let retry: { maxAttempts: number } | undefined;
      if (raw.retry !== undefined) {
        const attempts = isRecord(raw.retry) ? raw.retry.maxAttempts : undefined;
        if (!isRecord(raw.retry) || unknownKey(raw.retry, ["maxAttempts"]) || !Number.isInteger(attempts) || (attempts as number) < 1 || (attempts as number) > MAX_WORKFLOW_GATE_ATTEMPTS) {
          return { ok: false, error: `${where}.retry must be { "maxAttempts": 1 to ${MAX_WORKFLOW_GATE_ATTEMPTS} }` };
        }
        retry = { maxAttempts: attempts as number };
      }
      if (raw.onFail !== undefined && raw.onFail !== "stop" && raw.onFail !== "continue") {
        return { ok: false, error: `${where}.onFail must be "stop" or "continue"` };
      }
      steps.push({
        id: raw.id,
        kind: "gate",
        gate: personaLoadable ? { personaLoadable: personaLoadable as string } : { condition: gateCondition as MindStoneWorkflowCondition },
        ...(retry ? { retry } : {}),
        ...(raw.onFail ? { onFail: raw.onFail as "stop" | "continue" } : {}),
      });
      continue;
    }
    return { ok: false, error: `${where}.kind must be "route" or "gate"` };
  }
  return {
    ok: true,
    workflow: {
      ...(name ? { name: name as string } : {}),
      ...(description ? { description: description as string } : {}),
      ...(version ? { version: version as string } : {}),
      steps,
    },
  };
}

export class WorkflowWriteError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

/**
 * Write a checked workflow as `<workflows>/<id>/workflow.json` (#125).
 * - create: the id is new (compared without case, as persona ids are), and
 *   the folder is made exclusively; the file is staged in a dot folder and
 *   moved in, so a half-written workflow never shows up.
 * - replace: the workflow must exist as a real folder; its workflow.json is
 *   replaced in one rename.
 */
export function writeWorkflowDefinition(params: {
  workflowsDir: string;
  id: string;
  workflow: WorkflowDefinitionInput;
  mode: "create" | "replace";
}): string {
  if (!WORKFLOW_ID.test(params.id)) throw new WorkflowWriteError("id must be 1 to 40 lowercase letters, digits and hyphens", "invalid_workflow", 400);
  const dir = join(params.workflowsDir, params.id);
  const text = `${JSON.stringify(params.workflow, null, 2)}\n`;
  if (params.mode === "create") {
    mkdirSync(params.workflowsDir, { recursive: true });
    if (readdirSync(params.workflowsDir).some((name) => name.toLowerCase() === params.id)) {
      throw new WorkflowWriteError(`a workflow named ${params.id} already exists`, "workflow_exists", 409);
    }
    const staging = mkdtempSync(join(params.workflowsDir, ".staging-"));
    try {
      writeFileSync(join(staging, "workflow.json"), text);
      try {
        mkdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkflowWriteError(`a workflow named ${params.id} already exists`, "workflow_exists", 409);
        throw error;
      }
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return dir;
  }
  if (!isRealWorkflowDir(params.workflowsDir, params.id)) throw new WorkflowWriteError(`no workflow named "${params.id}"`, "not_found", 404);
  const path = join(dir, "workflow.json");
  const temp = join(dir, `.workflow.json.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return dir;
}

/** A workflow folder named exactly this (case included), that is a real folder with a workflow.json that isn't a link. */
export function isRealWorkflowDir(workflowsDir: string, id: string): boolean {
  if (!WORKFLOW_ID.test(id) || !existsSync(workflowsDir) || !readdirSync(workflowsDir).includes(id)) return false;
  try {
    return lstatSync(join(workflowsDir, id)).isDirectory() && lstatSync(join(workflowsDir, id, "workflow.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * A loaded workflow in the shape a PATCH takes (#125): only the fields each
 * step's kind allows, and no empty lists, so the editor can send back what it
 * read.
 */
export function workflowForEditing(workflow: { name?: string; description?: string; version?: string; steps: MindStoneWorkflowStep[] }, id: string): WorkflowDefinitionInput {
  const steps = workflow.steps.map((step): MindStoneWorkflowStep => {
    if (step.kind === "gate") {
      return {
        id: step.id,
        kind: "gate",
        ...(step.gate ? { gate: step.gate.personaLoadable ? { personaLoadable: step.gate.personaLoadable } : { condition: step.gate.condition } } : {}),
        ...(step.retry?.maxAttempts !== undefined ? { retry: { maxAttempts: step.retry.maxAttempts } } : {}),
        ...(step.onFail ? { onFail: step.onFail } : {}),
      };
    }
    return {
      id: step.id,
      kind: "route",
      ...(step.when ? { when: step.when } : {}),
      ...(step.personaId ? { personaId: step.personaId } : {}),
      ...(step.skills?.length ? { skills: step.skills } : {}),
      ...(step.knowledgebases?.length ? { knowledgebases: step.knowledgebases } : {}),
    };
  });
  return {
    ...(workflow.name && workflow.name !== id ? { name: workflow.name } : {}),
    ...(workflow.description ? { description: workflow.description } : {}),
    ...(workflow.version ? { version: workflow.version } : {}),
    steps,
  };
}

/**
 * Workflow ids the config already runs: `workflows.active` and route rules.
 * Creating one of them would take effect with no step of its own (#125, the
 * workflow form of #105's rule), so a create under one is refused.
 */
export function referencedWorkflowIds(
  config: { workflows?: { active?: unknown; routes?: unknown } } | undefined,
  /** Workflow ids personas list. A persona can only list one that exists (the admin API checks), so a listed id with no workflow was put there by hand or a pack, and creating it would run on that persona's turns. */
  personaListed: string[] = [],
): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) ids.add(value.trim()).add(value.trim().toLowerCase());
  };
  add(config?.workflows?.active);
  for (const rule of Array.isArray(config?.workflows?.routes) ? config.workflows.routes : []) add((rule as { workflowId?: unknown })?.workflowId);
  for (const id of personaListed) add(id);
  return ids;
}
