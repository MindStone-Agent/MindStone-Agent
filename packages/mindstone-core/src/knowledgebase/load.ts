import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import { memoryEmbeddingSpec, type MemoryEmbeddingProvider } from "../memory/embedding.js";
import type { MemoryDocument } from "../memory/types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type {
  MindStoneKbIndex,
  MindStoneKbIndexEntry,
  MindStoneKbSearchHit,
  MindStoneKbSourceStatus,
  MindStoneKbStatus,
  MindStoneKbVectorsStatus,
  MindStoneKnowledgebase,
  MindStoneKnowledgebaseCatalog,
  MindStoneKnowledgebaseSummary,
} from "./types.js";
import {
  loadFolderSourceDocuments,
  loadUrlSourceDocument,
  parseExternalSources,
  type ExternalSourceDocument,
} from "./sources.js";
import {
  KB_REEMBED_MAX_FAILURES,
  KB_REEMBED_NOTE,
  KB_REEMBED_STATE_FALLBACK,
  KB_REEMBED_STATE_FILE,
  KB_VECTORS_FILE,
  clearKbReembedState,
  kbVectorsStatus,
  readKbReembedState,
  readKbVectors,
  writeKbReembedState,
  writeKbVectors,
  type KbReembedState,
  type KbVectorsWriteResult,
} from "./vectors.js";

/**
 * Knowledgebase v1 layout (issue #13):
 *
 *   <kbDir>/<id>/kb.json       — catalog metadata
 *   <kbDir>/<id>/sources/*.md  — source documents (markdown, nested dirs allowed)
 *   <kbDir>/<id>/index.json    — generated index; ingest is deterministic (extractive), never model-driven
 *   <kbDir>/<id>/vectors.json  — generated: each entry embedded with the install's embedder (#125 §5)
 */

const DEFAULT_SUMMARY_CHARS = 400;

export function knowledgebasesDirFromConfig(config: MindStoneConfig | undefined, paths?: MindStoneRuntimePaths): string {
  const resolved = paths ?? runtimePathsFromEnv();
  return resolve(config?.knowledgebases?.dir ?? join(resolved.dataDir, "knowledgebases"));
}

export type LoadKnowledgebaseResult =
  | { ok: true; kb: MindStoneKnowledgebase }
  | { ok: false; kbId: string; error: string };

export function loadMindStoneKnowledgebase(kbDir: string, kbId: string): LoadKnowledgebaseResult {
  const dir = join(kbDir, kbId);
  const catalogPath = join(dir, "kb.json");
  if (!existsSync(catalogPath)) {
    return { ok: false, kbId, error: `kb.json not found at ${catalogPath}` };
  }
  let catalog: MindStoneKnowledgebaseCatalog = {};
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      catalog = {
        name: typeof record.name === "string" ? record.name : undefined,
        version: typeof record.version === "string" ? record.version : undefined,
        description: typeof record.description === "string" ? record.description : undefined,
        externalSources: record.externalSources,
      };
    }
  } catch (error) {
    return { ok: false, kbId, error: `kb.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    ok: true,
    kb: {
      id: kbId,
      dir,
      name: catalog.name ?? kbId,
      version: catalog.version,
      description: catalog.description,
      sourcesDir: join(dir, "sources"),
      indexPath: join(dir, "index.json"),
      externalSources: parseExternalSources(catalog.externalSources),
    },
  };
}

function walkMarkdownFiles(dir: string, noLinks = false): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const output: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (noLinks && lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a link; a persona's knowledge base must be its own files`);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      output.push(...walkMarkdownFiles(path, noLinks));
      continue;
    }
    if (stats.isFile() && name.toLowerCase().endsWith(".md")) output.push(path);
  }
  return output;
}

type ParsedSource = {
  title?: string;
  sections: Array<{ heading?: string; text: string }>;
};

function parseSourceMarkdown(raw: string): ParsedSource {
  const normalized = raw.replace(/\r\n/g, "\n");
  let body = normalized;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end !== -1) body = body.slice(end + "\n---".length);
  }
  body = body.trim();

  const lines = body.split("\n");
  let title: string | undefined;
  const sections: Array<{ heading?: string; text: string }> = [];
  let current: { heading?: string; buffer: string[] } = { buffer: [] };

  const flush = () => {
    const text = current.buffer.join("\n").trim();
    if (text || current.heading) sections.push({ heading: current.heading, text });
  };

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line.trim());
    if (h1 && title === undefined) {
      title = h1[1].trim();
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line.trim());
    if (h2) {
      flush();
      current = { heading: h2[1].trim(), buffer: [] };
      continue;
    }
    current.buffer.push(line);
  }
  flush();

  if (sections.length === 0) sections.push({ text: "" });
  return { title, sections };
}

function extractSummary(text: string, maxChars: number): string {
  const paragraph = text
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .find((block) => block.length > 0);
  const summary = paragraph ?? "";
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1).trimEnd()}…` : summary;
}

function sectionSlug(heading: string | undefined, ordinal: number): string {
  if (!heading) return String(ordinal);
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || String(ordinal);
}

/**
 * Why a persona's private KB can't be used as its own files (#125): its
 * folder, kb.json, index.json, vectors.json or sources folder is a link. Undefined when none is. Missing
 * files aren't an error here; the loader reports those.
 */
export function privateKnowledgebaseLinkError(kbDir: string, kbId: string): string | undefined {
  for (const path of [join(kbDir, kbId), join(kbDir, kbId, "kb.json"), join(kbDir, kbId, "index.json"), join(kbDir, kbId, KB_VECTORS_FILE), join(kbDir, kbId, KB_REEMBED_STATE_FILE), join(kbDir, kbId, "sources")]) {
    try {
      if (lstatSync(path).isSymbolicLink()) return `${relative(kbDir, path)} is a link; a persona's knowledge base must be its own files`;
    } catch {
      // not there
    }
  }
  return undefined;
}

/**
 * A workflow step's KB ids that match no KB in any of these folders (#125).
 * They narrow nothing, so the turn records them for the step's author.
 */
export function unknownKnowledgebaseIds(ids: string[] | undefined, kbDirs: Array<string | undefined>): string[] {
  if (!ids?.length) return [];
  const known = new Set(kbDirs.flatMap((dir) => (dir ? discoverMindStoneKnowledgebases(dir).map((summary) => summary.id) : [])));
  return ids.filter((id) => !known.has(id));
}

export type IngestKnowledgebaseResult =
  | { ok: true; kbId: string; indexPath: string; entryCount: number; sourceCount: number; vectors: KbVectorsWriteResult }
  | { ok: false; kbId: string; error: string };

function entriesFromParsedSource(params: {
  sourcePath: string;
  parsed: ParsedSource;
  titleHint?: string;
  citationBase: string;
  mtimeMs: number;
  maxSummaryChars: number;
  origin?: string;
  sensitivity?: string;
  fetchedAt?: string;
}): MindStoneKbIndexEntry[] {
  const entries: MindStoneKbIndexEntry[] = [];
  const title = params.parsed.title ?? params.titleHint;
  params.parsed.sections.forEach((section, ordinal) => {
    if (!section.text.trim()) return;
    const slug = sectionSlug(section.heading, ordinal);
    entries.push({
      entryId: `${params.sourcePath}#${slug}`,
      sourceId: params.sourcePath,
      sourcePath: params.sourcePath,
      sourceTitle: title,
      section: section.heading,
      citation: section.heading ? `${params.citationBase} § ${section.heading}` : params.citationBase,
      summary: extractSummary(section.text, params.maxSummaryChars),
      text: section.text,
      sourceMtimeMs: params.mtimeMs,
      origin: params.origin,
      sensitivity: params.sensitivity,
      fetchedAt: params.fetchedAt,
    });
  });
  return entries;
}

/**
 * Deterministic extractive ingest: walk sources/, pull declared external
 * sources (folders at their real paths; URLs fetched HERE and only here —
 * issue #23), split on H2 sections, preserve citations. No model calls.
 * A failing external source fails the ingest LOUDLY rather than silently
 * indexing a partial KB.
 */
export async function ingestMindStoneKnowledgebase(
  kbDir: string,
  kbId: string,
  options: {
    now?: string;
    maxSummaryChars?: number;
    noLinks?: boolean;
    fetchTimeoutMs?: number;
    maxFetchBytes?: number;
    /**
     * A persona's private KB (#125): its URLs are fetched with the host checks
     * of `loadUrlSourceDocument`'s `privateKb` (#142 review).
     */
    privateKbUrls?: { refusedHost?: (host: string) => boolean };
    /**
     * An approved proposal's KB (#125): its text sources only. One that has a
     * URL source by now (added in between) is left for an admin ingest, with
     * its permission check and limits (#125 review).
     */
    textOnly?: boolean;
    /**
     * The install's embedder (#125 §5): each entry is embedded into
     * vectors.json. Absent or failing, the index is still written and recall
     * uses word match for this KB.
     */
    embedder?: MemoryEmbeddingProvider;
    embedTimeoutMs?: number;
  } = {},
): Promise<IngestKnowledgebaseResult> {
  // A persona's private KB (#125, `noLinks`) is its own files: no links
  // anywhere in it, and no folder sources outside it.
  if (options.noLinks) {
    const linkError = privateKnowledgebaseLinkError(kbDir, kbId);
    if (linkError) return { ok: false, kbId, error: linkError };
  }
  const loaded = loadMindStoneKnowledgebase(kbDir, kbId);
  if (!loaded.ok) return { ok: false, kbId, error: loaded.error };
  const kb = loaded.kb;
  if (options.textOnly && kb.externalSources.length > 0) {
    return { ok: false, kbId, error: "it has an external source now; ingest it from the persona editor" };
  }
  if (options.noLinks && kb.externalSources.some((source) => source.type === "folder")) {
    return { ok: false, kbId, error: "a persona's private knowledge base can't read folders outside it; use sources/ or a URL source" };
  }
  let sourcePaths: string[];
  try {
    sourcePaths = walkMarkdownFiles(kb.sourcesDir, options.noLinks);
  } catch (error) {
    return { ok: false, kbId, error: error instanceof Error ? error.message : String(error) };
  }

  const externalDocuments: ExternalSourceDocument[] = [];
  for (const source of kb.externalSources) {
    try {
      if (source.type === "folder") {
        externalDocuments.push(...loadFolderSourceDocuments(source, kb.dir));
      } else {
        externalDocuments.push(await loadUrlSourceDocument(source, { now: options.now, timeoutMs: options.fetchTimeoutMs, maxBytes: options.maxFetchBytes, privateKb: options.privateKbUrls }));
      }
    } catch (error) {
      return { ok: false, kbId, error: `external source "${source.id}" failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (sourcePaths.length === 0 && externalDocuments.length === 0) {
    return { ok: false, kbId, error: `No markdown sources found under ${kb.sourcesDir} and no external sources declared` };
  }

  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_SUMMARY_CHARS;
  const entries: MindStoneKbIndexEntry[] = [];
  for (const path of sourcePaths) {
    const sourcePath = relative(kb.sourcesDir, path);
    entries.push(...entriesFromParsedSource({
      sourcePath,
      parsed: parseSourceMarkdown(readFileSync(path, "utf-8")),
      citationBase: sourcePath,
      mtimeMs: statSync(path).mtimeMs,
      maxSummaryChars,
    }));
  }
  for (const document of externalDocuments) {
    entries.push(...entriesFromParsedSource({
      sourcePath: document.sourcePath,
      parsed: parseSourceMarkdown(document.raw),
      titleHint: document.titleHint,
      // URL citations point at the URL itself; folder citations keep the
      // readable virtual path (the absolute path rides in `origin`).
      citationBase: document.sourcePath.startsWith("url:") ? document.origin : document.sourcePath,
      mtimeMs: document.mtimeMs,
      maxSummaryChars,
      origin: document.origin,
      sensitivity: document.sensitivity,
      fetchedAt: document.fetchedAt,
    }));
  }

  // Sections whose headings slug alike ("C++" and "C#", or "Example" twice)
  // would share an id, and so a vector (#125 §5 review): later ones get a suffix.
  const seenEntryIds = new Map<string, number>();
  for (const entry of entries) {
    const count = seenEntryIds.get(entry.entryId) ?? 0;
    seenEntryIds.set(entry.entryId, count + 1);
    if (count > 0) entry.entryId = `${entry.entryId}~${count + 1}`;
  }
  const index: MindStoneKbIndex = { kbId, ingestedAt: options.now, entries };
  const text = `${JSON.stringify(index, null, 2)}\n`;
  if (options.noLinks) {
    // A private KB (#125): written whole and moved into place, so a turn
    // reading it meanwhile never sees half a file. A global KB's index is
    // written in place as before (it may be a link an operator set up).
    const temp = join(kb.dir, `.index.json.${process.pid}.${Date.now().toString(36)}.tmp`);
    try {
      writeFileSync(temp, text, { flag: "wx" });
      renameSync(temp, kb.indexPath);
    } finally {
      rmSync(temp, { force: true });
    }
  } else {
    writeFileSync(kb.indexPath, text);
  }
  const vectors = await writeKbVectors({ kbDir: kb.dir, kbId, entries, indexText: text, indexPath: kb.indexPath, embedder: options.embedder, now: options.now, timeoutMs: options.embedTimeoutMs });
  return { ok: true, kbId, indexPath: kb.indexPath, entryCount: entries.length, sourceCount: sourcePaths.length + externalDocuments.length, vectors };
}

/**
 * The ingest that follows approving an agent-proposed private KB (#125): its
 * own files only and its text sources only, so nothing is fetched. One place
 * for the gateway and the CLI, so neither can drop a guard (#146 review).
 */
export function ingestApprovedPrivateKnowledgebase(
  kbRoot: string,
  kbId: string,
  options: { now?: string; embedder?: MemoryEmbeddingProvider } = {},
): Promise<IngestKnowledgebaseResult> {
  // Embedded like any other ingest (#125 §5), when the install has an embedder.
  return ingestMindStoneKnowledgebase(kbRoot, kbId, { now: options.now, noLinks: true, textOnly: true, embedder: options.embedder });
}

/**
 * After a switch of embedding model (#151): embed again, from its index (no
 * source is read or fetched), the first KB whose vectors another model made,
 * among the global collections and every persona's private KBs. One KB a
 * call, at most `maxEntries` entries; a larger one keeps word match until
 * `kb ingest`. `claim` lets the caller skip a KB being ingested meanwhile. A
 * failed attempt keeps the old vectors (recall uses word match) and is tried
 * again for that model after KB_REEMBED_LIMITS.retryAfterMs. A failure that
 * cost something (the embedder refused the text, or stopped after embedding
 * some of it) counts: the wait doubles with each, and after
 * KB_REEMBED_LIMITS.maxFailures the KB isn't tried again for that model. An
 * embedder that can't be reached, or is limiting requests, only waits (#158).
 * The state is kept in the KB's `reembed.json`, so a restart keeps it; a state
 * for another model doesn't apply, and embedding the KB removes it.
 * `deferred` counts the stale KBs left for later (claimed, or waiting to be
 * retried): with none and nothing done, nothing is stale for this model.
 */
export async function reembedStaleKnowledgebase(options: {
  kbDirs: Array<{ dir: string; personaId?: string }>;
  embedder: MemoryEmbeddingProvider;
  now?: string;
  maxEntries?: number;
  timeoutMs?: number;
  claim?: (target: { personaId?: string; kbId: string }) => (() => void) | undefined;
  /** Awaited before each entry is sent (#156 review): the caller holds the job while turns run. */
  beforeBatch?: () => Promise<void>;
  /** How a 429 pauses the job (#158); KB_REEMBED_LIMITS.rateLimit by default. */
  rateLimit?: { minMs: number; maxMs: number; maxWaits: number; maxTotalMs: number };
}): Promise<{ reembedded?: { kbId: string; personaId?: string; vectors: KbVectorsWriteResult; gaveUp?: true }; deferred: number }> {
  const maxEntries = options.maxEntries ?? KB_REEMBED_LIMITS.maxEntries;
  const spec = memoryEmbeddingSpec(options.embedder);
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  let deferred = 0;
  for (const { dir, personaId } of options.kbDirs) {
    const noLinks = personaId !== undefined;
    await yieldTurn();
    for (const summary of discoverMindStoneKnowledgebases(dir)) {
      await yieldTurn();
      if (summary.error || !summary.indexed || summary.entryCount > maxEntries) continue;
      if (noLinks && privateKnowledgebaseLinkError(dir, summary.id)) continue;
      const loaded = loadMindStoneKnowledgebase(dir, summary.id);
      if (!loaded.ok) continue;
      const read = readKbIndexWithText(loaded.kb);
      if (!read) continue;
      const current = readKbVectors(loaded.kb.dir, read.text, options.embedder, { noLinks, decode: false });
      if (current.state !== "stale" || current.cause !== "model") {
        // Not stale for this model any more (embedded some other way, or its vectors
        // removed): an earlier state no longer applies (#158 review).
        clearKbReembedState(loaded.kb.dir);
        continue;
      }
      const state = reembedState(loaded.kb.dir, spec, noLinks);
      // Given up on for this model: not waiting, so not deferred (#156 review).
      if (state?.gaveUp) continue;
      if (state?.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now()) {
        deferred += 1;
        continue;
      }
      const release = options.claim ? options.claim({ personaId, kbId: summary.id }) : () => undefined;
      if (!release) {
        deferred += 1;
        continue;
      }
      try {
        const vectors = await writeKbVectors({
          kbDir: loaded.kb.dir,
          kbId: summary.id,
          entries: read.index.entries,
          indexText: read.text,
          indexPath: loaded.kb.indexPath,
          embedder: options.embedder,
          now: options.now,
          timeoutMs: options.timeoutMs ?? KB_REEMBED_LIMITS.timeoutMs,
          keepOnFailure: true,
          // One entry a request: a one-at-a-time embedder answers a turn's own
          // request after at most one entry (#156 review).
          batchSize: 1,
          beforeBatch: options.beforeBatch,
          rateLimit: options.rateLimit ?? KB_REEMBED_LIMITS.rateLimit,
        });
        // An ingest that finished meanwhile left nothing to retry (#158 review).
        const reread = readKbIndexWithText(loaded.kb);
        const stillStale = ((now) => now.state === "stale" && now.cause === "model")(
          reread ? readKbVectors(loaded.kb.dir, reread.text, options.embedder, { noLinks, decode: false }) : { state: "missing" as const },
        );
        if (vectors.state === "ready" || !stillStale) {
          // Nothing to record.
        } else if (vectors.superseded) {
          // A newer ingest won: not a failure of the embedder (#156 review).
        } else {
          // A failure that cost something counts, and the wait doubles; an
          // outage or a 429 costs nothing and only waits (#158).
          // Free only when nothing was embedded and the embedder was out of reach or
          // limiting requests; anything else, or no cause at all, counts (#158 review).
          const free = (vectors.cause === "unavailable" || vectors.cause === "rate-limited") && !((vectors.embedded ?? 0) > 0);
          const counts = !free;
          // Read again now: a reset during this attempt starts the count afresh (#164).
          const failures = (reembedState(loaded.kb.dir, spec, noLinks)?.failures ?? 0) + (counts ? 1 : 0);
          const gaveUp = counts && failures >= KB_REEMBED_LIMITS.maxFailures;
          const next: KbReembedState = {
            version: 1,
            spec,
            failures,
            ...(gaveUp
              ? { gaveUp: true as const }
              : { nextAttemptAt: new Date(Date.now() + KB_REEMBED_LIMITS.retryAfterMs * 2 ** Math.max(0, failures - 1)).toISOString() }),
            reason: vectors.reason,
            updatedAt: new Date(Date.now()).toISOString(),
          };
          if (writeKbReembedState(loaded.kb.dir, next)) KB_REEMBED_STATE_FALLBACK.delete(loaded.kb.dir);
          else KB_REEMBED_STATE_FALLBACK.set(loaded.kb.dir, next);
          if (gaveUp) return { reembedded: { kbId: summary.id, personaId, vectors, gaveUp: true }, deferred };
        }
        return { reembedded: { kbId: summary.id, personaId, vectors }, deferred };
      } finally {
        release();
      }
    }
  }
  return { deferred };
}

/** A background re-embed after a model switch (#151): nobody waits on it, so it gets a longer budget. */
export const KB_REEMBED_LIMITS = {
  maxEntries: 512,
  timeoutMs: 600_000,
  retryAfterMs: 30 * 60_000,
  maxFailures: KB_REEMBED_MAX_FAILURES,
  /** A turn running longer than this no longer holds the re-embed back: it may never end (#158). */
  turnWaitMs: 10 * 60_000,
  /**
   * A 429 pauses the job: Retry-After within 30 s to 5 minutes, up to 5 times
   * in a row, and 30 minutes of waiting in all per run (#158).
   */
  rateLimit: { minMs: 30_000, maxMs: 5 * 60_000, maxWaits: 5, maxTotalMs: 30 * 60_000 },
};

/**
 * Waits while turns in flight (their start times, read each time) hold a
 * background re-embed back (#156 review, #158): the gateway's `beforeBatch`.
 */
export async function waitWhileTurnsRun(starts: () => Iterable<number>, pollMs = 200): Promise<void> {
  while (turnsHoldReembed(starts())) await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
}

/**
 * Clears a KB's re-embed state, so the next owner chat tries it again (#158
 * review): the admin's reset after fixing the embedder. False if there is no
 * such KB, or a private one is linked.
 */
export function resetKnowledgebaseReembed(kbDir: string, kbId: string, options: { noLinks?: boolean } = {}): boolean {
  if (options.noLinks && privateKnowledgebaseLinkError(kbDir, kbId)) return false;
  // Exactly its folder's name: a case-folding filesystem would find "GARAGE" for "garage" (#164).
  try {
    if (!readdirSync(kbDir).includes(kbId)) return false;
  } catch {
    return false;
  }
  const loaded = loadMindStoneKnowledgebase(kbDir, kbId);
  if (!loaded.ok) return false;
  clearKbReembedState(loaded.kb.dir);
  return true;
}

/** Whether turns in flight (their start times) hold a background re-embed back (#156 review, #158). */
export function turnsHoldReembed(starts: Iterable<number>, now = Date.now(), waitMs = KB_REEMBED_LIMITS.turnWaitMs): boolean {
  for (const started of starts) if (now - started < waitMs) return true;
  return false;
}

/**
 * A KB's re-embed state for the Console (#158 review): only while the KB is
 * still stale for the install's model, the only case the gateway acts on.
 */
export function knowledgebaseReembedState(
  kbDir: string,
  kbId: string,
  embedder: { id: string; model: string },
  noLinks = false,
): KbReembedState | undefined {
  const loaded = loadMindStoneKnowledgebase(kbDir, kbId);
  if (!loaded.ok) return undefined;
  const state = reembedState(loaded.kb.dir, memoryEmbeddingSpec(embedder), noLinks);
  if (!state) return undefined;
  const read = readKbIndexWithText(loaded.kb);
  const current = read ? readKbVectors(loaded.kb.dir, read.text, embedder, { noLinks, decode: false }) : undefined;
  return current?.state === "stale" && current.cause === "model" ? state : undefined;
}

/** The re-embed state that applies to a KB for `spec`, if any (#158). */
export function reembedState(kbDir: string, spec: string, noLinks = false): KbReembedState | undefined {
  const kept = KB_REEMBED_STATE_FALLBACK.get(kbDir);
  const state = kept?.spec === spec ? kept : readKbReembedState(kbDir, { noLinks });
  return state?.spec === spec ? state : undefined;
}

export function readMindStoneKbIndex(kb: MindStoneKnowledgebase): MindStoneKbIndex | undefined {
  return readKbIndexWithText(kb)?.index;
}

/** The index and its text as read, which the vectors are checked against (#125 §5). */
function readKbIndexWithText(kb: MindStoneKnowledgebase): { index: MindStoneKbIndex; text: string } | undefined {
  if (!existsSync(kb.indexPath)) return undefined;
  try {
    const text = readFileSync(kb.indexPath, "utf-8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as MindStoneKbIndex).entries)) return undefined;
    return { index: parsed as MindStoneKbIndex, text };
  } catch {
    return undefined;
  }
}

/**
 * Per-source ingest/index state. Staleness: KB-local + folder sources compare
 * real file mtimes; url sources go stale when `refreshMs` has elapsed since
 * their recorded fetchedAt (absent refreshMs = manual refresh, never
 * auto-stale). Re-running `kb ingest` refreshes everything.
 */
export function mindStoneKbStatus(
  kbDir: string,
  kbId: string,
  options: {
    now?: number;
    /** The install's embedder now (provider id and model); absent when none is configured. */
    embedder?: { id: string; model: string };
    noLinks?: boolean;
  } = {},
): MindStoneKbStatus | { kbId: string; error: string } {
  const loaded = loadMindStoneKnowledgebase(kbDir, kbId);
  if (!loaded.ok) return { kbId, error: loaded.error };
  const kb = loaded.kb;
  const read = readKbIndexWithText(kb);
  const index = read?.index;
  const sourcePaths = walkMarkdownFiles(kb.sourcesDir);
  const indexedBySource = new Map<string, MindStoneKbIndexEntry[]>();
  for (const entry of index?.entries ?? []) {
    const list = indexedBySource.get(entry.sourcePath) ?? [];
    list.push(entry);
    indexedBySource.set(entry.sourcePath, list);
  }

  const sources: MindStoneKbSourceStatus[] = [];
  for (const path of sourcePaths) {
    const sourcePath = relative(kb.sourcesDir, path);
    const entries = indexedBySource.get(sourcePath);
    indexedBySource.delete(sourcePath);
    if (!entries?.length) {
      sources.push({ sourceId: sourcePath, sourcePath, state: "unindexed", entryCount: 0 });
      continue;
    }
    const stale = statSync(path).mtimeMs > Math.max(...entries.map((entry) => entry.sourceMtimeMs));
    sources.push({ sourceId: sourcePath, sourcePath, state: stale ? "stale" : "indexed", entryCount: entries.length });
  }

  // External sources (issue #23): consume their indexed entries by prefix so
  // they never misreport as "missing" local files.
  const now = options.now ?? Date.now();
  for (const source of kb.externalSources) {
    const prefix = `${source.type}:${source.id}`;
    const externalEntries = new Map<string, MindStoneKbIndexEntry[]>();
    for (const [sourcePath, entries] of indexedBySource) {
      if (sourcePath === prefix || sourcePath.startsWith(`${prefix}/`)) {
        externalEntries.set(sourcePath, entries);
        indexedBySource.delete(sourcePath);
      }
    }
    if (externalEntries.size === 0) {
      sources.push({ sourceId: prefix, sourcePath: prefix, state: "unindexed", entryCount: 0 });
      continue;
    }
    for (const [sourcePath, entries] of externalEntries) {
      let state: MindStoneKbSourceStatus["state"] = "indexed";
      if (source.type === "folder") {
        const origin = entries[0]?.origin;
        if (!origin || !existsSync(origin)) state = "missing";
        else if (statSync(origin).mtimeMs > Math.max(...entries.map((entry) => entry.sourceMtimeMs))) state = "stale";
      } else if (source.refreshMs) {
        const fetchedAt = entries[0]?.fetchedAt ? Date.parse(entries[0].fetchedAt) : 0;
        if (now - fetchedAt > source.refreshMs) state = "stale";
      }
      sources.push({ sourceId: sourcePath, sourcePath, state, entryCount: entries.length });
    }
  }

  for (const [sourcePath, entries] of indexedBySource) {
    sources.push({ sourceId: sourcePath, sourcePath, state: "missing", entryCount: entries.length });
  }

  return {
    kbId,
    dir: kb.dir,
    indexed: Boolean(index),
    ingestedAt: index?.ingestedAt,
    entryCount: index?.entries.length ?? 0,
    // All sources represented in the matrix — local files, external
    // folder/url sources, and indexed-but-missing leftovers (#23 QA fix:
    // aggregate counts must agree with the per-source rows, not just local).
    sourceCount: sources.length,
    staleCount: sources.filter((source) => source.state !== "indexed").length,
    sources,
    vectors: read
      ? withReembedState(kbVectorsStatus(readKbVectors(kb.dir, read.text, options.embedder, { noLinks: options.noLinks })), kb.dir, options)
      : { state: "missing", reason: "not indexed yet" },
  };
}

/** A KB stale after a model switch shows what the re-embed did about it (#158). */
function withReembedState(
  status: MindStoneKbVectorsStatus,
  kbDir: string,
  options: { embedder?: { id: string; model: string }; noLinks?: boolean },
): MindStoneKbVectorsStatus {
  if (status.state !== "stale" || !options.embedder || !status.reason?.endsWith(KB_REEMBED_NOTE)) return status;
  const state = reembedState(kbDir, memoryEmbeddingSpec(options.embedder), options.noLinks);
  if (!state) return status;
  const reembed = {
    failures: state.failures,
    ...(state.gaveUp ? { gaveUp: true as const } : { nextAttemptAt: state.nextAttemptAt }),
    ...(state.reason ? { reason: state.reason } : {}),
  };
  const reason = state.gaveUp
    ? `${status.reason.slice(0, -KB_REEMBED_NOTE.length)} (the gateway stopped embedding it again after ${state.failures} failures${state.reason ? `: ${state.reason}` : ""})`
    : status.reason;
  return { ...status, reason, reembed };
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_+-]+/g)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3),
  );
}

function lexicalScore(query: string, text: string): number {
  const queryWords = words(query);
  if (queryWords.size === 0) return 0;
  const textWords = words(text);
  let matches = 0;
  for (const word of queryWords) {
    if (textWords.has(word)) matches += 1;
  }
  return matches / queryWords.size;
}

export type KbSearchResult =
  | { ok: true; kbId: string; query: string; hits: MindStoneKbSearchHit[] }
  | { ok: false; kbId: string; error: string };

/** Dedicated KB search path: lexical scoring over indexed entries; every hit carries its citation. */
export function searchMindStoneKnowledgebase(kbDir: string, kbId: string, query: string, options: { limit?: number } = {}): KbSearchResult {
  const loaded = loadMindStoneKnowledgebase(kbDir, kbId);
  if (!loaded.ok) return { ok: false, kbId, error: loaded.error };
  const index = readMindStoneKbIndex(loaded.kb);
  if (!index) return { ok: false, kbId, error: `Knowledgebase "${kbId}" has no index — run: mindstone kb ingest ${kbId}` };
  const limit = options.limit ?? 8;
  const hits = index.entries
    .map((entry) => ({ entry, score: lexicalScore(query, `${entry.sourceTitle ?? ""} ${entry.section ?? ""} ${entry.text}`) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.entryId.localeCompare(b.entry.entryId))
    .slice(0, limit);
  return { ok: true, kbId, query, hits };
}

/**
 * The ids of the collections whose kb.json loads: what
 * `discoverMindStoneKnowledgebases` finds without an error, without reading
 * any index or source (#160 review: the persona catalog runs every owner turn).
 */
export function loadableKnowledgebaseIds(kbDir: string): string[] {
  if (!existsSync(kbDir)) return [];
  return readdirSync(kbDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && loadMindStoneKnowledgebase(kbDir, entry.name).ok)
    .map((entry) => entry.name);
}

export function discoverMindStoneKnowledgebases(kbDir: string): MindStoneKnowledgebaseSummary[] {
  if (!existsSync(kbDir)) return [];
  const summaries: MindStoneKnowledgebaseSummary[] = [];
  for (const entry of readdirSync(kbDir, { withFileTypes: true })) {
    // A dot folder is a staging folder from an admin write (#125), never a real one.
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const loaded = loadMindStoneKnowledgebase(kbDir, entry.name);
    if (loaded.ok) {
      const index = readMindStoneKbIndex(loaded.kb);
      // #23 QA fix: count external sources too, without running providers
      // (no network, no folder reads): indexed source paths ∪ local files,
      // plus declared external sources that have no indexed entries yet.
      const indexedPaths = new Set((index?.entries ?? []).map((indexEntry) => indexEntry.sourcePath));
      const localPaths = walkMarkdownFiles(loaded.kb.sourcesDir).map((path) => relative(loaded.kb.sourcesDir, path));
      const distinct = new Set([...indexedPaths, ...localPaths]);
      const declaredUnindexed = loaded.kb.externalSources.filter((source) => {
        const prefix = `${source.type}:${source.id}`;
        return ![...indexedPaths].some((path) => path === prefix || path.startsWith(`${prefix}/`));
      }).length;
      summaries.push({
        id: loaded.kb.id,
        name: loaded.kb.name,
        version: loaded.kb.version,
        description: loaded.kb.description,
        dir: loaded.kb.dir,
        indexed: Boolean(index),
        entryCount: index?.entries.length ?? 0,
        sourceCount: distinct.size + declaredUnindexed,
      });
    } else {
      summaries.push({
        id: entry.name,
        name: entry.name,
        dir: join(kbDir, entry.name),
        indexed: false,
        entryCount: 0,
        sourceCount: 0,
        error: loaded.error,
      });
    }
  }
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One recall document's entries with their vectors (#125 §5), for ranking the
 * document by meaning. Kept beside the documents, never in their metadata, so
 * vectors don't reach recall events or usage logs.
 */
export type KnowledgebaseDocumentVectors = {
  dimension: number;
  /** The document's text with its section lines left out, and those lines with each entry's vector. */
  header: string[];
  footer: string[];
  entries: Array<{ line: string; citation: string; vector: Float32Array }>;
};

export type KnowledgebaseRecall = {
  documents: MemoryDocument[];
  /**
   * Recall document id -> its vectors, for KBs whose vectors match the
   * install's embedder. Read on first call only, so a turn that doesn't rank
   * by meaning never reads vectors.json (#125 §5 review).
   */
  vectors: () => Map<string, KnowledgebaseDocumentVectors>;
};

type VectorLoader = (into: Map<string, KnowledgebaseDocumentVectors>) => void;

export type KnowledgebaseRecallOptions = {
  config?: MindStoneConfig;
  paths?: MindStoneRuntimePaths;
  only?: string[];
  /**
   * A workflow step's KB ids. They narrow each kind on its own: global
   * collections only if the step names one of them, private KBs only if it
   * names one of those. Naming only private KBs leaves global recall as it was.
   */
  step?: string[];
  private?: { personaId: string; dir: string };
  /** The install's embedder (provider id and model): vectors made with another are left out. */
  embedder?: { id: string; model: string };
};

/**
 * KB participation in Auto Recall: one summary+pointer MemoryDocument per indexed source
 * (kind "kb"). Summaries and citations only — full content stays behind `mindstone kb search`.
 *
 * #125: `only` limits the global collections to the active persona's list
 * (absent: all of them), and `private` adds that persona's own KBs. Their ids
 * are `pkb:<personaId>:<kbId>:<source>`, never `kb:`, so a private KB can't be
 * mistaken for a global one with the same id.
 */
export function discoverKnowledgebaseRecallDocuments(options: KnowledgebaseRecallOptions = {}): MemoryDocument[] {
  return discoverKnowledgebaseRecall(options).documents;
}

/** The recall documents, plus each one's entry vectors where the KB has usable ones (#125 §5). */
export function discoverKnowledgebaseRecall(options: KnowledgebaseRecallOptions = {}): KnowledgebaseRecall {
  const loaders: VectorLoader[] = [];
  let vectors: Map<string, KnowledgebaseDocumentVectors> | undefined;
  const recall: KnowledgebaseRecall = {
    documents: [],
    vectors: () => {
      if (!vectors) {
        vectors = new Map();
        for (const load of loaders) load(vectors);
      }
      return vectors;
    },
  };
  if (options.config?.knowledgebases?.recall?.enabled === false) return recall;
  knowledgebaseRecallDocuments(recall, loaders, knowledgebasesDirFromConfig(options.config, options.paths), {
    only: options.only,
    step: options.step,
    embedder: options.embedder,
    idPrefix: "kb:",
    label: "Knowledgebase",
    titleTag: "KB",
    searchCommand: "mindstone kb search",
  });
  if (options.private) {
    knowledgebaseRecallDocuments(recall, loaders, options.private.dir, {
      step: options.step,
      embedder: options.embedder,
      noLinks: true,
      idPrefix: `pkb:${options.private.personaId}:`,
      label: `Persona ${options.private.personaId} private knowledgebase`,
      titleTag: `Persona KB`,
      searchCommand: `mindstone kb search --persona ${options.private.personaId}`,
      personaId: options.private.personaId,
    });
  }
  return recall;
}

function knowledgebaseRecallDocuments(recall: KnowledgebaseRecall, loaders: VectorLoader[], kbDir: string, options: {
  only?: string[];
  step?: string[];
  embedder?: { id: string; model: string };
  /** Private KBs: a KB whose kb.json, index.json or vectors.json is a link is left out. */
  noLinks?: boolean;
  idPrefix: string;
  label: string;
  titleTag: string;
  searchCommand: string;
  personaId?: string;
}): void {
  const summaries = discoverMindStoneKnowledgebases(kbDir);
  let only = options.only ? new Set(options.only) : undefined;
  const named = (options.step ?? []).filter((id) => summaries.some((summary) => summary.id === id));
  if (named.length) only = new Set(only ? named.filter((id) => only!.has(id)) : named);
  for (const summary of summaries) {
    if (summary.error || !summary.indexed) continue;
    if (only && !only.has(summary.id)) continue;
    if (options.noLinks && privateKnowledgebaseLinkError(kbDir, summary.id)) continue;
    const loaded = loadMindStoneKnowledgebase(kbDir, summary.id);
    if (!loaded.ok) continue;
    const read = readKbIndexWithText(loaded.kb);
    if (!read) continue;
    const index = read.index;
    const forVectors: Array<{ id: string; entries: MindStoneKbIndexEntry[]; lines: string[]; header: string[]; footer: string[] }> = [];
    const bySource = new Map<string, MindStoneKbIndexEntry[]>();
    for (const entry of index.entries) {
      const list = bySource.get(entry.sourcePath) ?? [];
      list.push(entry);
      bySource.set(entry.sourcePath, list);
    }
    for (const [sourcePath, entries] of bySource) {
      const title = entries[0].sourceTitle ?? sourcePath;
      const lines = entries.map((entry) => `- ${entry.citation}: ${entry.summary}`);
      const origin = entries[0].origin;
      const sensitivity = entries[0].sensitivity;
      const header = [
        `${options.label} "${summary.name}" (${summary.id}) — source: ${sourcePath}`,
        // AC3 (#23): KB hits are REFERENCE MATERIAL, not memory — stated in
        // the injected text itself so the model treats it accordingly.
        `Reference material (not memory): cite sources when used.${sensitivity ? ` Sensitivity: ${sensitivity}.` : ""}`,
      ];
      const footer = [`Full content: ${options.searchCommand} ${summary.id} "<query>"`];
      const id = `${options.idPrefix}${summary.id}:${sourcePath}`;
      recall.documents.push({
        id,
        kind: "kb",
        title: `[${options.titleTag} ${summary.name}] ${title}`,
        // External sources live at their origin (real folder path / URL);
        // KB-local sources under sources/.
        path: origin ?? join(loaded.kb.sourcesDir, sourcePath),
        text: [...header, lines.join("\n"), ...footer].join("\n"),
        metadata: {
          kbId: summary.id,
          ...(options.personaId ? { personaId: options.personaId, privateKnowledgebase: true } : {}),
          sourcePath,
          citations: entries.map((entry) => entry.citation),
          ...(origin ? { origin } : {}),
          ...(sensitivity ? { sensitivity } : {}),
        },
      });
      forVectors.push({ id, entries, lines, header, footer });
    }
    const embedder = options.embedder;
    if (!embedder) continue;
    const kbDirOfVectors = loaded.kb.dir;
    const indexText = read.text;
    loaders.push((into) => {
      const kbVectors = readKbVectors(kbDirOfVectors, indexText, embedder, { noLinks: options.noLinks });
      if (kbVectors.state !== "ready") return;
      const loadedVectors = kbVectors.loaded;
      for (const source of forVectors) {
        const withVectors = source.entries.flatMap((entry, ordinal) => {
          const vector = loadedVectors.vectors.get(entry.entryId);
          return vector ? [{ line: source.lines[ordinal], citation: entry.citation, vector }] : [];
        });
        // Every entry embedded, or the document stays on word match: a
        // partly embedded source would be ranked on some of its sections only.
        if (withVectors.length === source.entries.length) {
          into.set(source.id, { dimension: loadedVectors.dimension, header: source.header, footer: source.footer, entries: withVectors });
        }
      }
    });
  }
}
