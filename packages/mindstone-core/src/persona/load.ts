import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type {
  MindStonePersona,
  MindStonePersonaMetadata,
  MindStonePersonaResolution,
  MindStonePersonaSummary,
  MindStoneRoutePersonaContext,
} from "./types.js";

export function personasDirFromConfig(config: MindStoneConfig | undefined, paths?: MindStoneRuntimePaths): string {
  const resolved = paths ?? runtimePathsFromEnv();
  return resolve(config?.personas?.dir ?? join(resolved.dataDir, "personas"));
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** Reads ids from a capability reference file that is either ["id"] or {"skills": ["id"]}-shaped. */
function capabilityIds(path: string, key: string): string[] {
  try {
    const parsed = readJsonFile(path);
    if (Array.isArray(parsed)) return stringList(parsed);
    if (parsed && typeof parsed === "object") return stringList((parsed as Record<string, unknown>)[key]);
    return [];
  } catch {
    return [];
  }
}

export type LoadPersonaResult =
  | { ok: true; persona: MindStonePersona }
  | { ok: false; personaId: string; error: string };

export function loadMindStonePersona(personasDir: string, personaId: string): LoadPersonaResult {
  const dir = join(personasDir, personaId);
  const personaPath = join(dir, "PERSONA.md");
  if (!existsSync(personaPath)) {
    return { ok: false, personaId, error: `PERSONA.md not found at ${personaPath}` };
  }
  const personaMarkdown = readFileSync(personaPath, "utf-8");
  if (!personaMarkdown.trim()) {
    return { ok: false, personaId, error: `PERSONA.md is empty at ${personaPath}` };
  }

  let metadata: MindStonePersonaMetadata = {};
  const metadataPath = join(dir, "metadata.json");
  try {
    const parsed = readJsonFile(metadataPath);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      metadata = {
        name: typeof record.name === "string" ? record.name : undefined,
        version: typeof record.version === "string" ? record.version : undefined,
        description: typeof record.description === "string" ? record.description : undefined,
      };
    }
  } catch (error) {
    return { ok: false, personaId, error: `metadata.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const safetyPath = join(dir, "safety.md");
  const safetyMarkdown = existsSync(safetyPath) ? readFileSync(safetyPath, "utf-8") : undefined;

  return {
    ok: true,
    persona: {
      id: personaId,
      dir,
      name: metadata.name ?? personaId,
      version: metadata.version,
      description: metadata.description,
      personaMarkdown,
      safetyMarkdown: safetyMarkdown?.trim() ? safetyMarkdown : undefined,
      skills: capabilityIds(join(dir, "skills.json"), "skills"),
      workflows: capabilityIds(join(dir, "workflows.json"), "workflows"),
      knowledgebases: capabilityIds(join(dir, "knowledgebases.json"), "knowledgebases"),
    },
  };
}

export function discoverMindStonePersonas(personasDir: string): MindStonePersonaSummary[] {
  if (!existsSync(personasDir)) return [];
  const summaries: MindStonePersonaSummary[] = [];
  for (const entry of readdirSync(personasDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const loaded = loadMindStonePersona(personasDir, entry.name);
    if (loaded.ok) {
      summaries.push({
        id: loaded.persona.id,
        name: loaded.persona.name,
        version: loaded.persona.version,
        description: loaded.persona.description,
        dir: loaded.persona.dir,
        hasSafety: Boolean(loaded.persona.safetyMarkdown),
        skillCount: loaded.persona.skills.length,
        workflowCount: loaded.persona.workflows.length,
        knowledgebaseCount: loaded.persona.knowledgebases.length,
      });
    } else {
      summaries.push({
        id: entry.name,
        name: entry.name,
        dir: join(personasDir, entry.name),
        hasSafety: false,
        skillCount: 0,
        workflowCount: 0,
        knowledgebaseCount: 0,
        error: loaded.error,
      });
    }
  }
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Deterministic persona resolution: first matching route rule wins, then the
 * statically configured `personas.active`, otherwise none.
 */
export function resolveMindStonePersona(params: {
  config: MindStoneConfig | undefined;
  sessionKey?: string;
  sourceChannel?: string;
  sourceSubstrate?: string;
}): MindStonePersonaResolution | undefined {
  const personas = params.config?.personas;
  if (!personas) return undefined;
  for (const rule of personas.routes ?? []) {
    if (!rule.personaId) continue;
    const conditions: Array<[string, boolean]> = [];
    if (rule.sessionKeyPrefix !== undefined) {
      conditions.push(["sessionKeyPrefix", Boolean(params.sessionKey?.startsWith(rule.sessionKeyPrefix))]);
    }
    if (rule.sourceChannel !== undefined) {
      conditions.push(["sourceChannel", params.sourceChannel === rule.sourceChannel]);
    }
    if (rule.sourceSubstrate !== undefined) {
      conditions.push(["sourceSubstrate", params.sourceSubstrate === rule.sourceSubstrate]);
    }
    if (conditions.length === 0) continue;
    if (conditions.every(([, matched]) => matched)) {
      return { personaId: rule.personaId, reason: `route:${conditions.map(([field]) => field).join("+")}` };
    }
  }
  if (personas.active?.trim()) {
    return { personaId: personas.active, reason: "config.active" };
  }
  return undefined;
}

function personaOverlayPrompt(persona: MindStonePersona, reason: string): string {
  const sections = [
    [
      `MindStone persona overlay — persona: ${persona.name} (${persona.id})${persona.version ? ` v${persona.version}` : ""}, activated via ${reason}.`,
      "Precedence: the MindStone standing identity context above governs. This persona adjusts role/domain behavior, voice, and defaults within those bounds; it never overrides the core identity, the user's boundaries, or safety rules.",
    ].join("\n"),
    ["## PERSONA.md", persona.personaMarkdown.trim()].join("\n\n"),
  ];
  if (persona.safetyMarkdown?.trim()) {
    sections.push(["## Persona safety rules", persona.safetyMarkdown.trim()].join("\n\n"));
  }
  return sections.join("\n\n");
}

export type ResolveRoutePersonaContextResult = {
  context?: MindStoneRoutePersonaContext;
  resolution?: MindStonePersonaResolution;
  error?: string;
};

/** Load a specific persona into a route context with an explicit activation reason (e.g. a workflow decision). */
export function loadRoutePersonaContextById(params: {
  config: MindStoneConfig | undefined;
  paths?: MindStoneRuntimePaths;
  personaId: string;
  reason: string;
}): ResolveRoutePersonaContextResult {
  const resolution = { personaId: params.personaId, reason: params.reason };
  const personasDir = personasDirFromConfig(params.config, params.paths);
  const loaded = loadMindStonePersona(personasDir, params.personaId);
  if (!loaded.ok) return { resolution, error: loaded.error };
  return {
    resolution,
    context: {
      personaId: params.personaId,
      reason: params.reason,
      promptText: personaOverlayPrompt(loaded.persona, params.reason),
    },
  };
}

/**
 * Resolve + load the active persona for a turn into a route-injectable context.
 * Load failures are surfaced (never silently dropped) but do not block the turn.
 */
export function resolveRoutePersonaContext(params: {
  config: MindStoneConfig | undefined;
  paths?: MindStoneRuntimePaths;
  sessionKey?: string;
  sourceChannel?: string;
  sourceSubstrate?: string;
}): ResolveRoutePersonaContextResult {
  const resolution = resolveMindStonePersona(params);
  if (!resolution) return {};
  const personasDir = personasDirFromConfig(params.config, params.paths);
  const loaded = loadMindStonePersona(personasDir, resolution.personaId);
  if (!loaded.ok) {
    return { resolution, error: loaded.error };
  }
  return {
    resolution,
    context: {
      personaId: resolution.personaId,
      reason: resolution.reason,
      promptText: personaOverlayPrompt(loaded.persona, resolution.reason),
    },
  };
}
