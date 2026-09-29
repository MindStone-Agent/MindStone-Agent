import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { estimatePromptTokens } from "../context/index.js";
import type { MindStoneConfig } from "../config/index.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import { SCOPE_DIMENSIONS as RECALL_SCOPE_DIMENSIONS, scopeMatchesRecallFilter } from "../app-engine/types.js";
import { connectorOwnerSenders, isOwnerDirectMessage } from "../channels/session.js";
import type { TranscriptEntry } from "../transcript/index.js";
import { createMemoryEmbeddingProvider, type MemoryEmbeddingProvider } from "./embedding.js";
import { discoverFileMemoryDocuments } from "./file-memory.js";
import { redactSecrets } from "./redact.js";
import type { MemoryDocument, MemoryHit, MemoryQuery, MemoryRecallProvider } from "./types.js";

export type SqliteMemoryBackfillOptions = {
  config?: MindStoneConfig;
  paths?: MindStoneRuntimePaths;
  includeFileMemory?: boolean;
  includeTranscripts?: boolean;
};

export type SqliteMemoryEmbeddingBackfillOptions = {
  config?: MindStoneConfig;
  paths?: MindStoneRuntimePaths;
  provider?: MemoryEmbeddingProvider;
  batchSize?: number;
  force?: boolean;
  /** Embed the newest chunks first (live indexing, #106), so a backlog doesn't hold up the latest turn. */
  newestFirst?: boolean;
};

export type SqliteMemoryEmbeddingBackfillResult = {
  databasePath: string;
  providerId: string;
  model: string;
  chunksConsidered: number;
  chunksEmbedded: number;
  dimensions?: number;
};

export type SqliteMemoryBackfillResult = {
  databasePath: string;
  sourcesIndexed: number;
  chunksIndexed: number;
  chunkEmbeddingsPreserved: number;
  fileDocuments: number;
  transcriptDocuments: number;
  /** Transcript sources removed because this pass no longer indexes them (#62). */
  transcriptSourcesPruned: number;
};

export type SqliteVecStatus = {
  available: boolean;
  version?: string;
  extensionPath?: string;
  error?: string;
};

export type SqliteMemoryBloatStats = {
  databaseBytes: number;
  walBytes: number;
  shmBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  estimatedFreeBytes: number;
};

export type SqliteMemoryIndexStats = {
  databasePath: string;
  present: boolean;
  sources: number;
  chunks: number;
  embeddedChunks: number;
  duplicateTextChunks: number;
  vectorBackend: "sqlite-vec" | "js-cosine" | "lexical";
  sqliteVec: SqliteVecStatus;
  updatedAt?: string;
  bloat?: SqliteMemoryBloatStats;
  error?: string;
};

export type SqliteMemoryMaintenanceOptions = {
  paths?: MindStoneRuntimePaths;
  dryRun?: boolean;
  removeStaleSources?: boolean;
  deduplicateText?: boolean;
  optimize?: boolean;
  vacuum?: boolean;
};

export type SqliteMemoryMaintenanceResult = {
  databasePath: string;
  present: boolean;
  dryRun: boolean;
  staleSourcesFound: number;
  staleSourcesRemoved: number;
  duplicateTextChunksFound: number;
  duplicateTextChunksRemoved: number;
  emptySourcesFound: number;
  emptySourcesRemoved: number;
  optimized: boolean;
  vacuumed: boolean;
  before?: Pick<SqliteMemoryIndexStats, "sources" | "chunks" | "embeddedChunks" | "duplicateTextChunks" | "bloat">;
  after?: Pick<SqliteMemoryIndexStats, "sources" | "chunks" | "embeddedChunks" | "duplicateTextChunks" | "bloat">;
  error?: string;
};

type StoredChunk = {
  chunk_id: string;
  source_id: string;
  kind: string;
  path?: string;
  title?: string;
  ordinal: number;
  text: string;
  token_estimate: number;
  embedding_json?: string;
  metadata_json?: string;
};

const DEFAULT_CHUNK_CHARS = 2400;
const DEFAULT_OVERLAP_CHARS = 240;

export function sqliteMemoryDatabasePath(paths: MindStoneRuntimePaths = runtimePathsFromEnv()): string {
  return join(paths.vectorDir, "memory.sqlite");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sqliteVecExtensionPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MINDSTONE_SQLITE_VEC_EXTENSION?.trim() || env.SQLITE_VEC_EXTENSION?.trim() || undefined;
}

function tryEnableSqliteVec(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): SqliteVecStatus {
  const extensionPath = sqliteVecExtensionPath(env);
  try {
    if (extensionPath) {
      db.enableLoadExtension(true);
      db.loadExtension(extensionPath);
    }
    const row = db.prepare("SELECT vec_version() AS version").get() as { version?: string };
    return { available: true, version: row.version, extensionPath };
  } catch (error) {
    return {
      available: false,
      extensionPath,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db.enableLoadExtension(false);
    } catch {
      // Some builds may not allow toggling extension loading after a failed probe.
    }
  }
}

export function getSqliteVecStatus(paths: MindStoneRuntimePaths = runtimePathsFromEnv(), env: NodeJS.ProcessEnv = process.env): SqliteVecStatus {
  const databasePath = sqliteMemoryDatabasePath(paths);
  const db = openDatabase(databasePath);
  try {
    return tryEnableSqliteVec(db, env);
  } finally {
    db.close();
  }
}

function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Live indexing and recall share the file (#106): wait for a lock rather than fail.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function pragmaNumber(db: DatabaseSync, statement: string): number {
  const row = db.prepare(statement).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readBloatStats(db: DatabaseSync, databasePath: string): SqliteMemoryBloatStats {
  const pageSize = pragmaNumber(db, "PRAGMA page_size");
  const pageCount = pragmaNumber(db, "PRAGMA page_count");
  const freelistCount = pragmaNumber(db, "PRAGMA freelist_count");
  return {
    databaseBytes: fileSize(databasePath),
    walBytes: fileSize(`${databasePath}-wal`),
    shmBytes: fileSize(`${databasePath}-shm`),
    pageSize,
    pageCount,
    freelistCount,
    estimatedFreeBytes: pageSize * freelistCount,
  };
}

function readIndexCounts(db: DatabaseSync, databasePath: string): Pick<SqliteMemoryIndexStats, "sources" | "chunks" | "embeddedChunks" | "duplicateTextChunks" | "bloat"> {
  const sources = db.prepare("SELECT count(*) AS count FROM memory_sources").get() as { count: number };
  const chunks = db.prepare("SELECT count(*) AS count FROM memory_chunks").get() as { count: number };
  const embeddedChunks = db.prepare("SELECT count(*) AS count FROM memory_chunks WHERE embedding_json IS NOT NULL").get() as { count: number };
  const textDedup = db.prepare("SELECT count(*) AS chunks, count(DISTINCT trim(text)) AS uniqueChunks FROM memory_chunks").get() as { chunks: number; uniqueChunks: number };
  return {
    sources: Number(sources.count ?? 0),
    chunks: Number(chunks.count ?? 0),
    embeddedChunks: Number(embeddedChunks.count ?? 0),
    duplicateTextChunks: Math.max(0, Number(textDedup.chunks ?? 0) - Number(textDedup.uniqueChunks ?? 0)),
    bloat: readBloatStats(db, databasePath),
  };
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      path TEXT,
      title TEXT,
      timestamp TEXT,
      content_hash TEXT NOT NULL,
      metadata_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_chunks (
      chunk_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT,
      title TEXT,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      embedding_json TEXT,
      metadata_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_kind ON memory_chunks(kind);
    CREATE INDEX IF NOT EXISTS idx_memory_sources_kind ON memory_sources(kind);
  `);
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

function parseEmbedding(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const embedding = parsed.map((entry) => Number(entry));
    return embedding.length > 0 && embedding.every((entry) => Number.isFinite(entry)) ? embedding : undefined;
  } catch {
    return undefined;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function chunkText(text: string, maxChars = DEFAULT_CHUNK_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < normalized.length) {
    let end = Math.min(normalized.length, offset + maxChars);
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      const sentenceBreak = normalized.lastIndexOf(". ", end);
      const candidate = Math.max(paragraphBreak, sentenceBreak);
      if (candidate > offset + Math.floor(maxChars * 0.5)) end = candidate + (candidate === sentenceBreak ? 1 : 0);
    }
    const chunk = normalized.slice(offset, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    offset = Math.max(end - overlapChars, offset + 1);
  }
  return chunks;
}

/**
 * Whether a user turn was the owner's (#61/#62). New connector entries record
 * `ownerTurn`. Older ones are judged by today's rule where they can be: a
 * direct message from one of the connector's ownerSenders. Older email
 * entries never count, because nothing recorded whether the From header was
 * authenticated. Non-connector surfaces (webchat, REST, CLI, App Engine) are
 * the owner's own; App Engine tenants are separated by scope. A Console
 * user's turn (#103) is never the owner's: new entries record `ownerTurn`,
 * and older ones are known by their non-owner session key.
 */
function userTurnIsOwner(entry: TranscriptEntry, config: MindStoneConfig | undefined): boolean {
  if (typeof entry.metadata?.ownerTurn === "boolean") return entry.metadata.ownerTurn;
  if (entry.sessionKey?.includes(":non-owner%3A")) return false;
  const substrate = entry.source?.substrate ?? "";
  if (!substrate.startsWith("connector:")) return true;
  const connectorId = substrate.slice("connector:".length);
  if (connectorId === "email") return false;
  return isOwnerDirectMessage(
    { text: entry.text ?? "", chatType: entry.source?.chatType as never, senderId: entry.source?.senderId },
    connectorOwnerSenders(config, connectorId),
  );
}

function recordScope(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const scope = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1] !== ""),
  );
  return Object.keys(scope).length ? scope : undefined;
}

/**
 * Every transcript entry as a memory document, labelled with where it came
 * from (#62): surface, chat type, sender, tenant scope and audience.
 * - Scope comes from the entry itself, else from its run (runId), else from
 *   the user turn it follows, so a tenant's run, reply and events included,
 *   is recalled only at that exact scope.
 * - A non-owner user turn, and every entry after it up to the next owner turn
 *   (the reply to it), is audience "non_owner" and is left out unless
 *   includeNonOwner is set.
 */
/** Runtime bookkeeping events left out of the recall index (#106). */
const BOOKKEEPING_EVENTS = new Set([
  "memory_recall_injected",
  "memory_invariants_injected",
  "memory_index_injected",
  "identity_formation_prompted",
  "handoff_replayed",
  "context_window_pruned",
  "auto_compact_warning",
  "routing_not_implemented",
  "routing_failed",
  "abort_requested",
  "persona_proposal_dropped",
  "persona_load_failed",
  "client_system_prompt_ignored",
  "approval_proposed",
  "approval_decided",
  "auto_compact_required",
  "post_compact_maintenance",
  "persona_activated",
  "persona_deactivated",
  "pack_installed",
  "runner_stream_event",
]);

/** Workflow bookkeeping (workflow_selected, workflow_failed, …) is left out too. */
function isBookkeepingEvent(entry: TranscriptEntry): boolean {
  const event = String(entry.metadata?.event ?? "");
  return BOOKKEEPING_EVENTS.has(event) || event.startsWith("workflow_");
}

/**
 * An entry written for someone other than the owner, whatever its role (#106
 * review): new entries record `ownerTurn`, older ones carry a non-owner
 * session key. /v1/responses stores a caller's leading assistant and system
 * items before its user item, so the user turn alone can't decide this.
 */
function entryIsNonOwner(entry: TranscriptEntry): boolean {
  return entry.metadata?.ownerTurn === false || Boolean(entry.sessionKey?.includes(":non-owner%3A"));
}

function transcriptDocuments(paths: MindStoneRuntimePaths, options: { includeNonOwner?: boolean; config?: MindStoneConfig; onlyFile?: string } = {}): MemoryDocument[] {
  if (!existsSync(paths.transcriptDir) || !statSync(paths.transcriptDir).isDirectory()) return [];
  const docs: MemoryDocument[] = [];
  for (const name of readdirSync(paths.transcriptDir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    if (options.onlyFile !== undefined && name !== options.onlyFile) continue;
    const path = join(paths.transcriptDir, name);
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const entries: Array<{ entry: TranscriptEntry; index: number }> = [];
    lines.forEach((line, index) => {
      try {
        entries.push({ entry: JSON.parse(line) as TranscriptEntry, index });
      } catch {
        // Malformed lines are skipped.
      }
    });
    // A user turn sets the audience and scope for itself and the entries after
    // it (its reply, events) until the next user turn. Scope comes from each
    // turn, never from elsewhere in the file: one scoped run in a session must
    // not relabel the rest of it.
    const runScopes = new Map<string, Record<string, string>>();
    for (const { entry } of entries) {
      const scope = recordScope(entry.metadata?.scope);
      if (scope && entry.runId && !runScopes.has(entry.runId)) runScopes.set(entry.runId, scope);
    }
    let audience: "owner" | "non_owner" = "owner";
    let turnScope: Record<string, string> | undefined;
    for (const { entry, index } of entries) {
      if (entry.role === "user") {
        audience = userTurnIsOwner(entry, options.config) ? "owner" : "non_owner";
        turnScope = recordScope(entry.metadata?.scope);
      }
      const scope = recordScope(entry.metadata?.scope) ?? (entry.runId ? runScopes.get(entry.runId) : undefined) ?? turnScope;
      const entryAudience = entryIsNonOwner(entry) ? "non_owner" : audience;
      if (entryAudience === "non_owner" && !options.includeNonOwner) continue;
      // A client's system prompt is an instruction to that chat, not something said in it.
      if (entry.role === "system") continue;
      // The runtime's bookkeeping events ("Injected 3 recalled memory
      // chunks", "identity formation prompted") aren't the conversation:
      // recalling them would feed recall back into itself (#106). Tool
      // activity and other events stay recallable.
      if (entry.role === "event" && isBookkeepingEvent(entry)) continue;
      const text = entry.text?.trim() ? redactSecrets(entry.text.trim()) : undefined;
      if (!text) continue;
      const sourceParts = [entry.source?.substrate, entry.source?.channel, entry.source?.chatType].filter(Boolean).join("/");
      docs.push({
        id: `transcript:${name}:${entry.id || index}`,
        kind: "transcript",
        text,
        path,
        title: `${entry.sessionKey} ${entry.role} ${entry.timestamp}`,
        timestamp: entry.timestamp,
        metadata: {
          relativePath: relative(paths.dataDir, path),
          file: basename(path),
          line: index + 1,
          role: entry.role,
          sessionKey: entry.sessionKey,
          agentId: entry.agentId,
          source: sourceParts || undefined,
          surface: entry.source?.substrate,
          chatType: entry.source?.chatType,
          senderId: entry.source?.senderId,
          audience: entryAudience,
          ...(scope ? { scope } : {}),
          runId: entry.runId,
          event: entry.metadata?.event,
        },
      });
    }
  }
  return docs;
}

function preservedChunkEmbeddings(db: DatabaseSync, sourceId: string): Map<string, string> {
  const rows = db.prepare("SELECT text, embedding_json FROM memory_chunks WHERE source_id = ? AND embedding_json IS NOT NULL").all(sourceId) as Array<{ text: string; embedding_json?: string }>;
  const output = new Map<string, string>();
  for (const row of rows) {
    if (!row.embedding_json || !parseEmbedding(row.embedding_json)) continue;
    const key = hashText(row.text.trim());
    if (!output.has(key)) output.set(key, row.embedding_json);
  }
  return output;
}

function indexDocument(db: DatabaseSync, document: MemoryDocument): { chunksIndexed: number; chunkEmbeddingsPreserved: number } {
  const now = new Date().toISOString();
  const contentHash = hashText(document.text);
  const preservedEmbeddings = preservedChunkEmbeddings(db, document.id);
  db.prepare(`
    INSERT INTO memory_sources (id, kind, path, title, timestamp, content_hash, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      path = excluded.path,
      title = excluded.title,
      timestamp = excluded.timestamp,
      content_hash = excluded.content_hash,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    document.id,
    document.kind,
    document.path ?? null,
    document.title ?? null,
    document.timestamp ?? null,
    contentHash,
    JSON.stringify(document.metadata ?? {}),
    now,
  );
  db.prepare("DELETE FROM memory_chunks WHERE source_id = ?").run(document.id);

  const insertChunk = db.prepare(`
    INSERT INTO memory_chunks (chunk_id, source_id, kind, path, title, ordinal, text, token_estimate, embedding_json, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const chunks = chunkText(document.text);
  let chunkEmbeddingsPreserved = 0;
  chunks.forEach((text, ordinal) => {
    const preservedEmbedding = preservedEmbeddings.get(hashText(text.trim()));
    if (preservedEmbedding) chunkEmbeddingsPreserved += 1;
    insertChunk.run(
      `${document.id}#${ordinal}`,
      document.id,
      document.kind,
      document.path ?? null,
      document.title ?? null,
      ordinal,
      text,
      estimatePromptTokens(text),
      preservedEmbedding ?? null,
      JSON.stringify({ ...(document.metadata ?? {}), sourceId: document.id }),
      now,
    );
  });
  return { chunksIndexed: chunks.length, chunkEmbeddingsPreserved };
}

export function backfillSqliteMemoryIndex(options: SqliteMemoryBackfillOptions = {}): SqliteMemoryBackfillResult {
  const paths = options.paths ?? runtimePathsFromEnv();
  const databasePath = sqliteMemoryDatabasePath(paths);
  const db = openDatabase(databasePath);
  initializeSchema(db);

  const fileDocuments = options.includeFileMemory === false ? [] : discoverFileMemoryDocuments({ config: options.config, paths });
  const transcriptDocs = options.includeTranscripts === false
    ? []
    : transcriptDocuments(paths, { includeNonOwner: options.config?.memory?.transcripts?.includeNonOwner === true, config: options.config });
  const documents = [...fileDocuments, ...transcriptDocs];
  let chunksIndexed = 0;
  let chunkEmbeddingsPreserved = 0;
  let transcriptSourcesPruned = 0;

  db.exec("BEGIN");
  try {
    // Transcript sources this pass no longer produces (now excluded, or from a
    // deleted transcript) are removed, so a stricter rule also clears what an
    // earlier backfill indexed (#62).
    // Only transcript ids (a memory file can also have kind "transcript"), and
    // never when the transcript directory is missing: that is a moved or
    // unmounted directory, not a deleted history.
    // An empty directory where the index holds transcripts is treated like a
    // missing one (an unmounted volume leaves an empty mount point).
    const transcriptDirUsable =
      existsSync(paths.transcriptDir) &&
      statSync(paths.transcriptDir).isDirectory() &&
      readdirSync(paths.transcriptDir).some((name) => name.endsWith(".jsonl"));
    if (options.includeTranscripts !== false && transcriptDirUsable) {
      const keep = new Set(transcriptDocs.map((document) => document.id));
      const stale = (db.prepare("SELECT id FROM memory_sources WHERE kind = 'transcript' AND id LIKE 'transcript:%'").all() as Array<{ id: string }>)
        .map((row) => row.id)
        .filter((id) => !keep.has(id));
      const deleteChunks = db.prepare("DELETE FROM memory_chunks WHERE source_id = ?");
      const deleteSource = db.prepare("DELETE FROM memory_sources WHERE id = ?");
      for (const id of stale) {
        deleteChunks.run(id);
        deleteSource.run(id);
      }
      transcriptSourcesPruned = stale.length;
    }
    for (const document of documents) {
      const indexed = indexDocument(db, document);
      chunksIndexed += indexed.chunksIndexed;
      chunkEmbeddingsPreserved += indexed.chunkEmbeddingsPreserved;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  return {
    databasePath,
    sourcesIndexed: documents.length,
    chunksIndexed,
    chunkEmbeddingsPreserved,
    fileDocuments: fileDocuments.length,
    transcriptDocuments: transcriptDocs.length,
    transcriptSourcesPruned,
  };
}

export type SqliteMemoryTurnIndexResult = {
  databasePath: string;
  sourcesIndexed: number;
  chunksEmbedded: number;
};

/**
 * Keep the recall index current as the agent works (#106): called after each
 * reply, so a new chat can recall an earlier one without a manual backfill.
 * It indexes the one transcript file the turn was written to, and memory
 * files that are new or changed; a source whose text is unchanged is left as
 * it is. Chunks without an embedding are then embedded when a provider is
 * configured (otherwise recall uses the lexical fallback). The same audience
 * rule as the backfill applies: turns that weren't the owner's are left out
 * unless `memory.transcripts.includeNonOwner` is set.
 */
export async function indexSqliteMemoryTurn(options: {
  transcriptFile: string;
  config?: MindStoneConfig;
  paths?: MindStoneRuntimePaths;
  provider?: MemoryEmbeddingProvider;
}): Promise<SqliteMemoryTurnIndexResult> {
  const paths = options.paths ?? runtimePathsFromEnv();
  const databasePath = sqliteMemoryDatabasePath(paths);
  const documents = [
    ...discoverFileMemoryDocuments({ config: options.config, paths }),
    ...transcriptDocuments(paths, {
      includeNonOwner: options.config?.memory?.transcripts?.includeNonOwner === true,
      config: options.config,
      onlyFile: basename(options.transcriptFile),
    }),
  ];
  const db = openDatabase(databasePath);
  initializeSchema(db);
  let sourcesIndexed = 0;
  const existingHash = db.prepare("SELECT content_hash FROM memory_sources WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const document of documents) {
      const row = existingHash.get(document.id) as { content_hash?: string } | undefined;
      if (row?.content_hash === hashText(document.text)) continue;
      indexDocument(db, document);
      sourcesIndexed += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  const provider = options.provider ?? createMemoryEmbeddingProvider(options.config);
  const embedded = provider ? await backfillSqliteMemoryEmbeddings({ paths, config: options.config, provider, newestFirst: true }) : undefined;
  return { databasePath, sourcesIndexed, chunksEmbedded: embedded?.chunksEmbedded ?? 0 };
}

export async function backfillSqliteMemoryEmbeddings(options: SqliteMemoryEmbeddingBackfillOptions = {}): Promise<SqliteMemoryEmbeddingBackfillResult> {
  const paths = options.paths ?? runtimePathsFromEnv();
  const databasePath = sqliteMemoryDatabasePath(paths);
  const provider = options.provider ?? createMemoryEmbeddingProvider(options.config);
  if (!provider) throw new Error("No memory embedding provider configured. Set memory.embeddingProvider, e.g. ollama:nomic-embed-text.");

  const db = openDatabase(databasePath);
  initializeSchema(db);
  const rows = db.prepare(`
    SELECT chunk_id, text
    FROM memory_chunks
    ${options.force ? "" : "WHERE embedding_json IS NULL"}
    ORDER BY updated_at ${options.newestFirst ? "DESC" : "ASC"}, chunk_id ASC
  `).all() as Array<{ chunk_id: string; text: string }>;

  const batchSize = Math.max(1, options.batchSize ?? 16);
  let chunksEmbedded = 0;
  let dimensions: number | undefined;
  const update = db.prepare("UPDATE memory_chunks SET embedding_json = ?, updated_at = ? WHERE chunk_id = ?");

  try {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const embeddings = await provider.embedTexts(batch.map((row) => row.text));
      if (embeddings.length !== batch.length) {
        throw new Error(`embedding provider returned ${embeddings.length} vectors for ${batch.length} chunks`);
      }
      db.exec("BEGIN");
      try {
        embeddings.forEach((embedding, index) => {
          dimensions ??= embedding.length;
          update.run(JSON.stringify(embedding), new Date().toISOString(), batch[index].chunk_id);
          chunksEmbedded += 1;
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    db.close();
  }

  return {
    databasePath,
    providerId: provider.id,
    model: provider.model,
    chunksConsidered: rows.length,
    chunksEmbedded,
    dimensions,
  };
}

export function getSqliteMemoryIndexStats(paths: MindStoneRuntimePaths = runtimePathsFromEnv()): SqliteMemoryIndexStats {
  const databasePath = sqliteMemoryDatabasePath(paths);
  const sqliteVec = existsSync(databasePath) ? getSqliteVecStatus(paths) : { available: false, error: "database not present" };
  const empty = {
    databasePath,
    sources: 0,
    chunks: 0,
    embeddedChunks: 0,
    duplicateTextChunks: 0,
    vectorBackend: "lexical" as const,
    sqliteVec,
  };
  if (!existsSync(databasePath)) return { ...empty, present: false };
  try {
    const db = openDatabase(databasePath);
    initializeSchema(db);
    const counts = readIndexCounts(db, databasePath);
    const updated = db.prepare("SELECT max(updated_at) AS updatedAt FROM memory_chunks").get() as { updatedAt?: string };
    db.close();
    const embedded = counts.embeddedChunks;
    return {
      databasePath,
      present: true,
      ...counts,
      vectorBackend: sqliteVec.available ? "sqlite-vec" : embedded > 0 ? "js-cosine" : "lexical",
      sqliteVec,
      updatedAt: updated.updatedAt,
    };
  } catch (error) {
    return { ...empty, present: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function staleSourceIds(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT id, path FROM memory_sources WHERE path IS NOT NULL").all() as Array<{ id: string; path?: string }>;
  return rows.filter((row) => row.path && !existsSync(row.path)).map((row) => row.id);
}

function duplicateTextChunkIds(db: DatabaseSync): string[] {
  const rows = db.prepare(`
    SELECT chunk_id, text, updated_at
    FROM memory_chunks
    ORDER BY updated_at DESC, chunk_id ASC
  `).all() as Array<{ chunk_id: string; text: string; updated_at: string }>;
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const key = hashText(row.text.trim());
    if (seen.has(key)) {
      duplicates.push(row.chunk_id);
      continue;
    }
    seen.add(key);
  }
  return duplicates;
}

function emptySourceIds(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT id FROM memory_sources WHERE id NOT IN (SELECT DISTINCT source_id FROM memory_chunks)").all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function maintainSqliteMemoryIndex(options: SqliteMemoryMaintenanceOptions = {}): SqliteMemoryMaintenanceResult {
  const paths = options.paths ?? runtimePathsFromEnv();
  const databasePath = sqliteMemoryDatabasePath(paths);
  const dryRun = options.dryRun ?? false;
  const removeStaleSources = options.removeStaleSources ?? true;
  const deduplicateText = options.deduplicateText ?? false;
  const optimize = options.optimize ?? true;
  const vacuum = options.vacuum ?? true;
  if (!existsSync(databasePath)) {
    return {
      databasePath,
      present: false,
      dryRun,
      staleSourcesFound: 0,
      staleSourcesRemoved: 0,
      duplicateTextChunksFound: 0,
      duplicateTextChunksRemoved: 0,
      emptySourcesFound: 0,
      emptySourcesRemoved: 0,
      optimized: false,
      vacuumed: false,
    };
  }

  const db = openDatabase(databasePath);
  initializeSchema(db);
  try {
    const before = readIndexCounts(db, databasePath);
    const staleIds = removeStaleSources ? staleSourceIds(db) : [];
    const duplicateIds = deduplicateText ? duplicateTextChunkIds(db) : [];
    const emptyIdsBefore = emptySourceIds(db);
    let staleSourcesRemoved = 0;
    let duplicateTextChunksRemoved = 0;
    let emptySourcesRemoved = 0;

    if (!dryRun) {
      db.exec("BEGIN");
      try {
        const deleteSource = db.prepare("DELETE FROM memory_sources WHERE id = ?");
        for (const id of staleIds) {
          const result = deleteSource.run(id);
          staleSourcesRemoved += Number(result.changes ?? 0);
        }
        const deleteChunk = db.prepare("DELETE FROM memory_chunks WHERE chunk_id = ?");
        for (const id of duplicateIds) {
          const result = deleteChunk.run(id);
          duplicateTextChunksRemoved += Number(result.changes ?? 0);
        }
        const emptyResult = db.prepare("DELETE FROM memory_sources WHERE id NOT IN (SELECT DISTINCT source_id FROM memory_chunks)").run();
        emptySourcesRemoved = Number(emptyResult.changes ?? 0);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    let optimized = false;
    let vacuumed = false;
    if (!dryRun && optimize) {
      db.exec("PRAGMA optimize");
      db.exec("REINDEX");
      optimized = true;
    }
    if (!dryRun && vacuum) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      vacuumed = true;
    }
    const after = readIndexCounts(db, databasePath);
    return {
      databasePath,
      present: true,
      dryRun,
      staleSourcesFound: staleIds.length,
      staleSourcesRemoved,
      duplicateTextChunksFound: duplicateIds.length,
      duplicateTextChunksRemoved,
      emptySourcesFound: emptyIdsBefore.length,
      emptySourcesRemoved,
      optimized,
      vacuumed,
      before,
      after,
    };
  } catch (error) {
    return {
      databasePath,
      present: true,
      dryRun,
      staleSourcesFound: 0,
      staleSourcesRemoved: 0,
      duplicateTextChunksFound: 0,
      duplicateTextChunksRemoved: 0,
      emptySourcesFound: 0,
      emptySourcesRemoved: 0,
      optimized: false,
      vacuumed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

/**
 * An app, tenant or user scope. An agentId alone is the owner's own App Engine
 * run, which recalls the owner's chats (#106 review); a tenant's run carries
 * excludeOwnerTranscripts whatever its scope holds.
 */
function isScopedQuery(scope: Record<string, string> | undefined): boolean {
  return Boolean(scope && (["appId", "tenantId", "userId"] as const).some((dim) => typeof scope[dim] === "string" && scope[dim] !== ""));
}

/** The owner's unscoped chat transcripts stay out of this query: a scoped query, or one that says so. */
function excludesOwnerTranscripts(query: MemoryQuery): boolean {
  return query.excludeOwnerTranscripts === true || isScopedQuery(query.scope);
}

export class SqliteMemoryRecallProvider implements MemoryRecallProvider {
  readonly id = "sqlite";
  readonly #databasePath: string;
  readonly #embeddingProvider?: MemoryEmbeddingProvider;

  constructor(options: { databasePath?: string; embeddingProvider?: MemoryEmbeddingProvider } = {}) {
    this.#databasePath = options.databasePath ?? sqliteMemoryDatabasePath();
    this.#embeddingProvider = options.embeddingProvider;
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    if (!existsSync(this.#databasePath)) return [];
    if (this.#embeddingProvider) {
      try {
        const embeddingHits = await this.#embeddingSearch(query);
        if (embeddingHits.length > 0) {
          // Chunks not embedded yet (the latest turn while the embedder was
          // slow or down) are still found by their words (#106 review).
          const pending = this.#lexicalSearch(query, true);
          const limit = query.limit ?? 8;
          return [...embeddingHits, ...pending]
            .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
            .slice(0, limit);
        }
      } catch {
        // Fall through to lexical scoring. AutoRecall should degrade, not break chat routing, when an embedder is down.
      }
    }
    return this.#lexicalSearch(query);
  }

  /**
   * Candidate rows, capped at 5000: memory files and knowledge first, then
   * chat transcripts newest first, so a long chat history can't push MEMORY.md
   * out (#106 review). The scope filter is part of the query (#62), so
   * out-of-scope chunks never take up the cap: each scope dimension a chunk
   * carries must equal the query's. #inScope checks the parsed rows again (it
   * treats non-string values as absent, so the SQL is the stricter of the two).
   * A scoped query (a tenant's App Engine run) never gets the owner's
   * unscoped chat transcripts (#106 review, pending #71).
   */
  #rows(embedded: boolean | "pending", scope: Record<string, string> | undefined, excludeOwnerTranscripts = false): StoredChunk[] {
    const db = openDatabase(this.#databasePath);
    initializeSchema(db);
    const scopeClauses = RECALL_SCOPE_DIMENSIONS.map(
      (dim) => `(json_extract(metadata_json, '$.scope.${dim}') IS NULL OR json_extract(metadata_json, '$.scope.${dim}') = ?)`,
    );
    // A row whose metadata isn't valid JSON is left out rather than making
    // json_extract throw and the whole recall fail.
    const scoped = excludeOwnerTranscripts || isScopedQuery(scope);
    const where = [
      ...(embedded === true ? ["embedding_json IS NOT NULL"] : embedded === "pending" ? ["embedding_json IS NULL"] : []),
      "(metadata_json IS NULL OR json_valid(metadata_json))",
      ...scopeClauses,
      ...(scoped ? ["NOT (source_id LIKE 'transcript:%' AND (metadata_json IS NULL OR json_extract(metadata_json, '$.scope') IS NULL))"] : []),
    ];
    const rows = db.prepare(`
      SELECT chunk_id, source_id, kind, path, title, ordinal, text, token_estimate, embedding_json, metadata_json
      FROM memory_chunks
      WHERE ${where.join(" AND ")}
      ORDER BY CASE WHEN source_id LIKE 'transcript:%' THEN 1 ELSE 0 END, updated_at DESC
      LIMIT 5000
    `).all(...RECALL_SCOPE_DIMENSIONS.map((dim) => scope?.[dim] ?? null)) as StoredChunk[];
    db.close();
    return rows;
  }

  /**
   * Scope is applied before ranking (#62): a scoped chunk is only a candidate
   * for a query at its exact scope, so one tenant's volume can't crowd
   * everyone else out of the top results. No query scope (the owner's own
   * recall) means no scoped chunk is a candidate.
   */
  #inScope(row: StoredChunk, query: MemoryQuery): boolean {
    if (!row.metadata_json || !row.metadata_json.includes('"scope"')) return !(excludesOwnerTranscripts(query) && row.source_id.startsWith("transcript:"));
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      return scopeMatchesRecallFilter(metadata.scope as Record<string, unknown> | undefined, query.scope);
    } catch {
      return false;
    }
  }

  async #embeddingSearch(query: MemoryQuery): Promise<MemoryHit[]> {
    if (!this.#embeddingProvider) return [];
    const [queryEmbedding] = await this.#embeddingProvider.embedTexts([query.text]);
    if (!queryEmbedding) return [];
    const limit = query.limit ?? 8;
    return this.#rows(true, query.scope, excludesOwnerTranscripts(query))
      .filter((row) => this.#inScope(row, query))
      .map((row) => {
        const embedding = parseEmbedding(row.embedding_json);
        const score = embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;
        return this.#hitFromRow(row, score, "embedding");
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, limit);
  }

  #lexicalSearch(query: MemoryQuery, pendingOnly = false): MemoryHit[] {
    const limit = query.limit ?? 8;
    return this.#rows(pendingOnly ? "pending" : false, query.scope, excludesOwnerTranscripts(query))
      .filter((row) => this.#inScope(row, query))
      .map((row) => this.#hitFromRow(row, lexicalScore(query.text, row.text), "lexical"))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, limit);
  }

  #hitFromRow(row: StoredChunk, score: number, recallMode: "embedding" | "lexical"): MemoryHit {
    const metadata = row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined;
    return {
      id: row.source_id,
      chunkId: row.chunk_id,
      sourceId: row.source_id,
      kind: row.kind as MemoryHit["kind"],
      path: row.path,
      title: row.title,
      ordinal: row.ordinal,
      text: row.text,
      metadata: { ...(metadata ?? {}), tokenEstimate: row.token_estimate, recallMode },
      score,
      distance: recallMode === "embedding" ? 1 - score : undefined,
    };
  }
}

export function createSqliteMemoryRecallProvider(options: {
  config?: MindStoneConfig;
  paths?: MindStoneRuntimePaths;
  /** The turn's shared embedder (#125 §5); by default one is made from the config. */
  embeddingProvider?: MemoryEmbeddingProvider;
} = {}): MemoryRecallProvider | undefined {
  const paths = options.paths ?? runtimePathsFromEnv();
  const databasePath = sqliteMemoryDatabasePath(paths);
  return existsSync(databasePath)
    ? new SqliteMemoryRecallProvider({ databasePath, embeddingProvider: options.embeddingProvider ?? createMemoryEmbeddingProvider(options.config) })
    : undefined;
}
