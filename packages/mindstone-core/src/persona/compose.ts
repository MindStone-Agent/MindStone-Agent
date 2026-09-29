import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverMindStoneKnowledgebases, privateKnowledgebaseLinkError } from "../knowledgebase/load.js";
import { parseExternalSources } from "../knowledgebase/sources.js";
import { discoverMindStoneSkills } from "../skills/artifacts.js";
import { loadMindStoneWorkflow } from "../workflow/load.js";
import { isRealWorkflowDir } from "../workflow/validate.js";
import { isRealDirectory, isSafeComponentId, personaKnowledgebasesDir, readablePersonaKnowledgebasesDir } from "./components.js";
import { PERSONA_PROPOSAL_ID } from "./create.js";
import { loadMindStonePersona } from "./load.js";

/**
 * Owner-built personas (#125): create and edit a persona with its component
 * lists from the admin API. The rules are #105's where they overlap:
 * - a new id is lowercase letters, digits and hyphens, and is created
 *   exclusively; an id the config already uses is refused, compared by
 *   case and by the directory the filesystem resolves it to;
 * - saving never makes a persona active.
 * Every listed component must exist: installed skills, workflows that load,
 * global KB collections. A create is written to a staging folder and moved
 * into place in one rename, so a half-written persona never shows up.
 */

export const OWNER_PERSONA_LIMITS = { name: 60, description: 300, personaMarkdown: 20_000, components: 32 };

export class PersonaComposeError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export type PersonaComponentLists = {
  skills?: string[];
  workflows?: string[];
  knowledgebases?: string[];
};

export type OwnerPersonaInput = PersonaComponentLists & {
  name?: string;
  description?: string;
  personaMarkdown?: string;
};

type Dirs = {
  personasDir: string;
  skillsDir: string;
  workflowsDir: string;
  knowledgebasesDir: string;
};

function singleLine(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new PersonaComposeError(`${field} is required`, "invalid_persona", 400);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PersonaComposeError(`${field} must be text of at most ${max} characters on one line`, "invalid_persona", 400);
  }
  return value.trim();
}

function markdown(value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new PersonaComposeError("personaMarkdown is required", "invalid_persona", 400);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > OWNER_PERSONA_LIMITS.personaMarkdown || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new PersonaComposeError(`personaMarkdown must be non-empty text of at most ${OWNER_PERSONA_LIMITS.personaMarkdown} characters`, "invalid_persona", 400);
  }
  return value.replace(/\r\n/g, "\n").trimEnd() + "\n";
}

function idList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > OWNER_PERSONA_LIMITS.components || value.some((id) => !isSafeComponentId(typeof id === "string" ? id : undefined))) {
    throw new PersonaComposeError(`${field} must be a list of at most ${OWNER_PERSONA_LIMITS.components} ids`, "invalid_persona", 400);
  }
  return [...new Set(value as string[])];
}

/** Checks that every listed component exists; the error names the first that doesn't. */
export function checkPersonaComponents(lists: PersonaComponentLists, dirs: Omit<Dirs, "personasDir">): void {
  if (lists.skills?.length) {
    const installed = new Set(discoverMindStoneSkills(dirs.skillsDir).filter((skill) => skill.source === "installed" && !skill.error).map((skill) => skill.id));
    const missing = lists.skills.find((id) => !installed.has(id));
    if (missing) throw new PersonaComposeError(`no installed skill named "${missing}"`, "unknown_component", 422);
  }
  for (const id of lists.workflows ?? []) {
    // Exactly this id: a case-insensitive filesystem would find "WF-A" for "wf-a".
    const loaded = isRealWorkflowDir(dirs.workflowsDir, id) ? loadMindStoneWorkflow(dirs.workflowsDir, id) : undefined;
    if (!loaded?.ok) throw new PersonaComposeError(`no workflow named "${id}" that loads`, "unknown_component", 422);
  }
  if (lists.knowledgebases?.length) {
    const kbs = new Set(discoverMindStoneKnowledgebases(dirs.knowledgebasesDir).filter((kb) => !kb.error).map((kb) => kb.id));
    const missing = lists.knowledgebases.find((id) => !kbs.has(id));
    if (missing) throw new PersonaComposeError(`no knowledge base collection named "${missing}"`, "unknown_component", 422);
  }
}

export function parseOwnerPersonaInput(body: Record<string, unknown>, mode: "create" | "edit"): OwnerPersonaInput & { id?: string } {
  const allowed = mode === "create"
    ? ["id", "name", "description", "personaMarkdown", "skills", "workflows", "knowledgebases"]
    : ["name", "description", "personaMarkdown", "skills", "workflows", "knowledgebases"];
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new PersonaComposeError(`unknown field: ${unknown}`, "invalid_persona", 400);
  let id: string | undefined;
  if (mode === "create") {
    if (typeof body.id !== "string" || !PERSONA_PROPOSAL_ID.test(body.id)) {
      throw new PersonaComposeError("id must be 1 to 40 lowercase letters, digits and hyphens", "invalid_persona", 400);
    }
    id = body.id;
  }
  const input: OwnerPersonaInput & { id?: string } = {
    ...(id ? { id } : {}),
    name: singleLine(body.name, "name", OWNER_PERSONA_LIMITS.name, mode === "create"),
    description: singleLine(body.description, "description", OWNER_PERSONA_LIMITS.description, false),
    personaMarkdown: markdown(body.personaMarkdown, mode === "create"),
    skills: idList(body.skills, "skills"),
    workflows: idList(body.workflows, "workflows"),
    knowledgebases: idList(body.knowledgebases, "knowledgebases"),
  };
  if (mode === "edit" && Object.values(input).every((value) => value === undefined)) {
    throw new PersonaComposeError("nothing to change", "invalid_persona", 400);
  }
  return input;
}

/** The persona ids already on disk, lowercased: a new id must differ from all of them (#105's case-fold rule). */
function existingPersonaIds(personasDir: string): Set<string> {
  if (!existsSync(personasDir)) return new Set();
  return new Set(readdirSync(personasDir).map((name) => name.toLowerCase()));
}

function writeComponentFiles(dir: string, lists: PersonaComponentLists): void {
  if (lists.skills) writeFileSync(join(dir, "skills.json"), `${JSON.stringify(lists.skills, null, 2)}\n`);
  if (lists.workflows) writeFileSync(join(dir, "workflows.json"), `${JSON.stringify(lists.workflows, null, 2)}\n`);
  if (lists.knowledgebases) writeFileSync(join(dir, "knowledgebases.json"), `${JSON.stringify(lists.knowledgebases, null, 2)}\n`);
}

/**
 * Create an owner-built persona. Refused: an id already on disk (in any
 * case), an id the config already uses (it would answer with no switch), a
 * component that doesn't exist. Never activates.
 */
export function createOwnerPersona(params: Dirs & {
  input: OwnerPersonaInput & { id?: string };
  referencedPersonaIds: ReadonlySet<string>;
  createdBy: string;
  now: string;
}): { id: string; dir: string } {
  const id = params.input.id;
  if (!id || !PERSONA_PROPOSAL_ID.test(id)) throw new PersonaComposeError("id must be lowercase letters, digits and hyphens", "invalid_persona", 400);
  if (params.referencedPersonaIds.has(id) || params.referencedPersonaIds.has(id.toLowerCase())) {
    throw new PersonaComposeError(`the config already uses the persona id "${id}", so creating it would make it active without a switch; choose another id`, "persona_referenced", 409);
  }
  if (existingPersonaIds(params.personasDir).has(id.toLowerCase())) {
    throw new PersonaComposeError(`a persona named ${id} already exists`, "persona_exists", 409);
  }
  checkPersonaComponents(params.input, params);
  mkdirSync(params.personasDir, { recursive: true });
  // Staged next to its final place (same filesystem), then moved in one
  // rename. The staging folder starts with a dot, which persona discovery skips.
  const staging = mkdtempSync(join(params.personasDir, ".staging-"));
  try {
    writeFileSync(join(staging, "PERSONA.md"), params.input.personaMarkdown ?? "");
    writeFileSync(
      join(staging, "metadata.json"),
      `${JSON.stringify({ name: params.input.name, version: "1", ...(params.input.description ? { description: params.input.description } : {}), createdBy: "owner", createdByUser: params.createdBy, createdAt: params.now }, null, 2)}\n`,
    );
    writeComponentFiles(staging, params.input);
    const dir = join(params.personasDir, id);
    try {
      // Exclusive: a folder that appeared since the check (or a link there) wins, and this create fails.
      mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PersonaComposeError(`a persona named ${id} already exists`, "persona_exists", 409);
      throw error;
    }
    renameSync(staging, dir);
    // A filesystem that folds more than case can put the new persona where a
    // referenced id points: compare the directories themselves (#105 review).
    const written = statSync(dir);
    for (const referenced of params.referencedPersonaIds) {
      if (!isSafeComponentId(referenced)) continue;
      let other;
      try {
        other = statSync(join(params.personasDir, referenced));
      } catch {
        continue;
      }
      if (other.ino === written.ino && other.dev === written.dev) {
        rmSync(dir, { recursive: true, force: true });
        throw new PersonaComposeError(`the config already uses the persona id "${referenced}", which is the same directory as "${id}" on this filesystem; choose another id`, "persona_referenced", 409);
      }
    }
    return { id, dir };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Edit a persona: its name, description, PERSONA.md and component lists. A
 * list given replaces the one on disk; an empty list removes its file (the
 * persona then uses every skill / every global collection / no workflows).
 * Each file is written to a temporary name and renamed over the old one.
 */
export function updateOwnerPersona(params: Dirs & { id: string; input: OwnerPersonaInput; updatedBy: string; now: string }): { id: string; dir: string } {
  if (!isSafeComponentId(params.id)) throw new PersonaComposeError(`no persona named "${params.id}"`, "not_found", 404);
  const dir = join(params.personasDir, params.id);
  if (!isRealDirectory(dir) || !readdirSync(params.personasDir).includes(params.id)) {
    throw new PersonaComposeError(`no persona named "${params.id}"`, "not_found", 404);
  }
  const loaded = loadMindStonePersona(params.personasDir, params.id);
  if (!loaded.ok) throw new PersonaComposeError(`persona "${params.id}" can't be loaded, so it can't be edited here`, "invalid_persona", 422);
  checkPersonaComponents(params.input, params);
  // Every file this edit writes is checked first, so an edit is refused
  // whole, never half-applied: none may be a link or anything but a file.
  const writes: Array<[string, string | null]> = [];
  if (params.input.personaMarkdown !== undefined) writes.push(["PERSONA.md", params.input.personaMarkdown]);
  if (params.input.name !== undefined || params.input.description !== undefined) {
    // The metadata keeps what it holds (who created or approved it, pack
    // fields); only the name and description change.
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      existing = {};
    }
    const description = params.input.description ?? loaded.persona.description;
    const metadata = {
      ...existing,
      name: params.input.name ?? loaded.persona.name,
      ...(description ? { description } : {}),
      updatedBy: params.updatedBy,
      updatedAt: params.now,
    };
    writes.push(["metadata.json", `${JSON.stringify(metadata, null, 2)}\n`]);
  }
  for (const [key, file] of [["skills", "skills.json"], ["workflows", "workflows.json"], ["knowledgebases", "knowledgebases.json"]] as const) {
    const list = params.input[key];
    if (list === undefined) continue;
    writes.push([file, list.length === 0 ? null : `${JSON.stringify(list, null, 2)}\n`]);
  }
  for (const [name] of writes) {
    let stats;
    try {
      stats = lstatSync(join(dir, name));
    } catch {
      continue;
    }
    if (!stats.isFile()) throw new PersonaComposeError(`${name} isn't a plain file; edit it on disk`, "invalid_persona", 422);
  }
  for (const [name, text] of writes) {
    const path = join(dir, name);
    if (text === null) {
      rmSync(path, { force: true });
      continue;
    }
    const temp = join(dir, `.${name}.${process.pid}.${Date.now().toString(36)}.tmp`);
    try {
      writeFileSync(temp, text, { flag: "wx" });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  return { id: params.id, dir };
}

/** The persona's private KB folder, created on first use; refused when the persona folder or it is a link. */
export function ensurePersonaKnowledgebasesDir(personaDir: string): string {
  if (!isRealDirectory(personaDir)) throw new PersonaComposeError("the persona folder is a link or missing", "invalid_persona", 422);
  const dir = personaKnowledgebasesDir(personaDir);
  try {
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!isRealDirectory(dir)) throw new PersonaComposeError("the persona's knowledgebases folder is a link", "invalid_persona", 422);
  return dir;
}

/** A private KB id, and a text source's name: one lowercase folder or file name. */
export const PRIVATE_KB_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PRIVATE_KB_LIMITS = { name: 80, description: 300, text: 60_000, url: 2000, sources: 100, urlSources: 10 };

/** The persona's private KB folder `<kbId>`, when it and everything above it is its own (no links). */
function privateKnowledgebaseDir(personaDir: string, kbId: string): string {
  if (!PRIVATE_KB_ID.test(kbId)) throw new PersonaComposeError(`no private knowledge base named "${kbId}"`, "not_found", 404);
  const root = isRealDirectory(personaDir) ? readablePersonaKnowledgebasesDir(personaDir) : undefined;
  if (!root) throw new PersonaComposeError(`no private knowledge base named "${kbId}"`, "not_found", 404);
  if (!existsSync(root) || !readdirSync(root).includes(kbId)) throw new PersonaComposeError(`no private knowledge base named "${kbId}"`, "not_found", 404);
  const linkError = privateKnowledgebaseLinkError(root, kbId);
  if (linkError) throw new PersonaComposeError(linkError, "invalid_knowledgebase", 422);
  return join(root, kbId);
}

function readCatalog(kbDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(kbDir, "kb.json"), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new PersonaComposeError("kb.json can't be read", "invalid_knowledgebase", 422);
}

function replaceFile(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Create a private KB under the persona: `kb.json` and an empty `sources/`, staged and moved in. */
export function createPrivateKnowledgebase(personaDir: string, input: { id: unknown; name?: unknown; description?: unknown }): { id: string; dir: string } {
  if (typeof input.id !== "string" || !PRIVATE_KB_ID.test(input.id)) {
    throw new PersonaComposeError("id must be 1 to 40 lowercase letters, digits and hyphens", "invalid_knowledgebase", 400);
  }
  const id = input.id;
  const name = singleLine(input.name, "name", PRIVATE_KB_LIMITS.name, false) ?? id;
  const description = singleLine(input.description, "description", PRIVATE_KB_LIMITS.description, false);
  const root = ensurePersonaKnowledgebasesDir(personaDir);
  if (readdirSync(root).some((entry) => entry.toLowerCase() === id)) {
    throw new PersonaComposeError(`a private knowledge base named ${id} already exists`, "knowledgebase_exists", 409);
  }
  const staging = mkdtempSync(join(root, ".staging-"));
  try {
    writeFileSync(join(staging, "kb.json"), `${JSON.stringify({ name, version: "1", ...(description ? { description } : {}) }, null, 2)}\n`);
    mkdirSync(join(staging, "sources"));
    const dir = join(root, id);
    try {
      mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PersonaComposeError(`a private knowledge base named ${id} already exists`, "knowledgebase_exists", 409);
      throw error;
    }
    renameSync(staging, dir);
    return { id, dir };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export type PrivateKnowledgebaseSources = {
  text: string[];
  urls: Array<{ id: string; url: string; refreshMs?: number }>;
};

export function listPrivateKnowledgebaseSources(personaDir: string, kbId: string): PrivateKnowledgebaseSources {
  const dir = privateKnowledgebaseDir(personaDir, kbId);
  const sourcesDir = join(dir, "sources");
  const text = existsSync(sourcesDir)
    ? readdirSync(sourcesDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name.slice(0, -3)).sort()
    : [];
  const urls = parseExternalSources(readCatalog(dir).externalSources)
    .filter((source) => source.type === "url" && source.url)
    .map((source) => ({ id: source.id, url: source.url!, ...(source.refreshMs ? { refreshMs: source.refreshMs } : {}) }));
  return { text, urls };
}

/**
 * Add a source to a private KB. Markdown text becomes `sources/<name>.md`
 * (a new name only: an existing one is refused). A URL is added to kb.json's
 * url sources and fetched at the next ingest. Neither is indexed until then.
 */
export function addPrivateKnowledgebaseSource(personaDir: string, kbId: string, body: Record<string, unknown>): { kind: "text" | "url"; name: string } {
  const dir = privateKnowledgebaseDir(personaDir, kbId);
  const current = listPrivateKnowledgebaseSources(personaDir, kbId);
  if (current.text.length + current.urls.length >= PRIVATE_KB_LIMITS.sources) {
    throw new PersonaComposeError(`a private knowledge base holds at most ${PRIVATE_KB_LIMITS.sources} sources`, "too_many_sources", 409);
  }
  if (body.kind === "text") {
    const unknown = Object.keys(body).find((key) => !["kind", "name", "text"].includes(key));
    if (unknown) throw new PersonaComposeError(`unknown field: ${unknown}`, "invalid_source", 400);
    if (typeof body.name !== "string" || !SOURCE_NAME.test(body.name)) {
      throw new PersonaComposeError("name must be 1 to 64 lowercase letters, digits and hyphens", "invalid_source", 400);
    }
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > PRIVATE_KB_LIMITS.text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) {
      throw new PersonaComposeError(`text must be non-empty markdown of at most ${PRIVATE_KB_LIMITS.text} characters`, "invalid_source", 400);
    }
    const sourcesDir = join(dir, "sources");
    mkdirSync(sourcesDir, { recursive: true });
    if (current.text.includes(body.name) || current.urls.some((source) => source.id === body.name)) {
      throw new PersonaComposeError(`a source named ${body.name} already exists`, "source_exists", 409);
    }
    try {
      writeFileSync(join(sourcesDir, `${body.name}.md`), `${body.text.replace(/\r\n/g, "\n").trimEnd()}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PersonaComposeError(`a source named ${body.name} already exists`, "source_exists", 409);
      throw error;
    }
    return { kind: "text", name: body.name };
  }
  if (body.kind === "url") {
    const unknown = Object.keys(body).find((key) => !["kind", "name", "url", "refreshMs"].includes(key));
    if (unknown) throw new PersonaComposeError(`unknown field: ${unknown}`, "invalid_source", 400);
    if (typeof body.name !== "string" || !SOURCE_NAME.test(body.name)) {
      throw new PersonaComposeError("name must be 1 to 64 lowercase letters, digits and hyphens", "invalid_source", 400);
    }
    let url: URL;
    try {
      url = new URL(typeof body.url === "string" ? body.url : "");
    } catch {
      throw new PersonaComposeError("url must be an http or https address", "invalid_source", 400);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.href.length > PRIVATE_KB_LIMITS.url) {
      throw new PersonaComposeError("url must be an http or https address", "invalid_source", 400);
    }
    // A user name or password in the address can never be sent (fetch refuses
    // it), and it would sit in kb.json: refused. Put a token in a header-free
    // URL only if the site takes one in its query, which reads back masked.
    if (url.username || url.password) {
      throw new PersonaComposeError("url can't hold a user name or password", "invalid_source", 400);
    }
    if (body.refreshMs !== undefined && (!Number.isInteger(body.refreshMs) || (body.refreshMs as number) < 60_000)) {
      throw new PersonaComposeError("refreshMs must be a whole number of milliseconds, at least 60000", "invalid_source", 400);
    }
    if (current.text.includes(body.name) || current.urls.some((source) => source.id === body.name)) {
      throw new PersonaComposeError(`a source named ${body.name} already exists`, "source_exists", 409);
    }
    // Each is fetched at ingest, one after another, 20 s at most each: ten keep an ingest under the Console's wait.
    if (current.urls.length >= PRIVATE_KB_LIMITS.urlSources) {
      throw new PersonaComposeError(`a private knowledge base holds at most ${PRIVATE_KB_LIMITS.urlSources} URL sources`, "too_many_sources", 409);
    }
    const catalog = readCatalog(dir);
    const existing = Array.isArray(catalog.externalSources) ? catalog.externalSources : [];
    // Stored as parsed: scheme and host lowercased, stray whitespace gone, so
    // what is listed, masked and fetched is the same string.
    catalog.externalSources = [...existing, { id: body.name, type: "url", url: url.href, ...(body.refreshMs ? { refreshMs: body.refreshMs } : {}) }];
    replaceFile(join(dir, "kb.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    return { kind: "url", name: body.name };
  }
  throw new PersonaComposeError('kind must be "text" or "url"', "invalid_source", 400);
}
