import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import type { MemoryDocument } from "../memory/types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type {
  MindStoneKbIndex,
  MindStoneKbIndexEntry,
  MindStoneKbSearchHit,
  MindStoneKbSourceStatus,
  MindStoneKbStatus,
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

/**
 * Knowledgebase v1 layout (issue #13):
 *
 *   <kbDir>/<id>/kb.json       — catalog metadata
 *   <kbDir>/<id>/sources/*.md  — source documents (markdown, nested dirs allowed)
 *   <kbDir>/<id>/index.json    — generated index; ingest is deterministic (extractive), never model-driven
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

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const output: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      output.push(...walkMarkdownFiles(path));
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

export type IngestKnowledgebaseResult =
  | { ok: true; kbId: string; indexPath: string; entryCount: number; sourceCount: number }
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
export async function ingestMindStoneKnowledgebase(kbDir: string, kbId: string, options: { now?: string; maxSummaryChars?: number } = {}): Promise<IngestKnowledgebaseResult> {
  const loaded = loadMindStoneKnowledgebase(kbDir, kbId);
  if (!loaded.ok) return { ok: false, kbId, error: loaded.error };
  const kb = loaded.kb;
  const sourcePaths = walkMarkdownFiles(kb.sourcesDir);

  const externalDocuments: ExternalSourceDocument[] = [];
  for (const source of kb.externalSources) {
    try {
      if (source.type === "folder") {
        externalDocuments.push(...loadFolderSourceDocuments(source, kb.dir));
      } else {
        externalDocuments.push(await loadUrlSourceDocument(source, { now: options.now }));
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

  const index: MindStoneKbIndex = { kbId, ingestedAt: options.now, entries };
  writeFileSync(kb.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return { ok: true, kbId, indexPath: kb.indexPath, entryCount: entries.length, sourceCount: sourcePaths.length + externalDocuments.length };
}

export function readMindStoneKbIndex(kb: MindStoneKnowledgebase): MindStoneKbIndex | undefined {
  if (!existsSync(kb.indexPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(kb.indexPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as MindStoneKbIndex).entries)) return undefined;
    return parsed as MindStoneKbIndex;
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
export function mindStoneKbStatus(kbDir: string, kbId: string, options: { now?: number } = {}): MindStoneKbStatus | { kbId: string; error: string } {
  const loaded = loadMindStoneKnowledgebase(kbDir, kbId);
  if (!loaded.ok) return { kbId, error: loaded.error };
  const kb = loaded.kb;
  const index = readMindStoneKbIndex(kb);
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
    sourceCount: sourcePaths.length,
    staleCount: sources.filter((source) => source.state !== "indexed").length,
    sources,
  };
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

export function discoverMindStoneKnowledgebases(kbDir: string): MindStoneKnowledgebaseSummary[] {
  if (!existsSync(kbDir)) return [];
  const summaries: MindStoneKnowledgebaseSummary[] = [];
  for (const entry of readdirSync(kbDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const loaded = loadMindStoneKnowledgebase(kbDir, entry.name);
    if (loaded.ok) {
      const index = readMindStoneKbIndex(loaded.kb);
      summaries.push({
        id: loaded.kb.id,
        name: loaded.kb.name,
        version: loaded.kb.version,
        description: loaded.kb.description,
        dir: loaded.kb.dir,
        indexed: Boolean(index),
        entryCount: index?.entries.length ?? 0,
        sourceCount: walkMarkdownFiles(loaded.kb.sourcesDir).length,
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
 * KB participation in Auto Recall: one summary+pointer MemoryDocument per indexed source
 * (kind "kb"). Summaries and citations only — full content stays behind `mindstone kb search`.
 */
export function discoverKnowledgebaseRecallDocuments(options: { config?: MindStoneConfig; paths?: MindStoneRuntimePaths } = {}): MemoryDocument[] {
  if (options.config?.knowledgebases?.recall?.enabled === false) return [];
  const kbDir = knowledgebasesDirFromConfig(options.config, options.paths);
  const documents: MemoryDocument[] = [];
  for (const summary of discoverMindStoneKnowledgebases(kbDir)) {
    if (summary.error || !summary.indexed) continue;
    const loaded = loadMindStoneKnowledgebase(kbDir, summary.id);
    if (!loaded.ok) continue;
    const index = readMindStoneKbIndex(loaded.kb);
    if (!index) continue;
    const bySource = new Map<string, MindStoneKbIndexEntry[]>();
    for (const entry of index.entries) {
      const list = bySource.get(entry.sourcePath) ?? [];
      list.push(entry);
      bySource.set(entry.sourcePath, list);
    }
    for (const [sourcePath, entries] of bySource) {
      const title = entries[0].sourceTitle ?? sourcePath;
      const sections = entries
        .map((entry) => `- ${entry.citation}: ${entry.summary}`)
        .join("\n");
      const origin = entries[0].origin;
      const sensitivity = entries[0].sensitivity;
      documents.push({
        id: `kb:${summary.id}:${sourcePath}`,
        kind: "kb",
        title: `[KB ${summary.name}] ${title}`,
        // External sources live at their origin (real folder path / URL);
        // KB-local sources under sources/.
        path: origin ?? join(loaded.kb.sourcesDir, sourcePath),
        text: [
          `Knowledgebase "${summary.name}" (${summary.id}) — source: ${sourcePath}`,
          // AC3 (#23): KB hits are REFERENCE MATERIAL, not memory — stated in
          // the injected text itself so the model treats it accordingly.
          `Reference material (not memory): cite sources when used.${sensitivity ? ` Sensitivity: ${sensitivity}.` : ""}`,
          sections,
          `Full content: mindstone kb search ${summary.id} "<query>"`,
        ].join("\n"),
        metadata: {
          kbId: summary.id,
          sourcePath,
          citations: entries.map((entry) => entry.citation),
          ...(origin ? { origin } : {}),
          ...(sensitivity ? { sensitivity } : {}),
        },
      });
    }
  }
  return documents;
}
