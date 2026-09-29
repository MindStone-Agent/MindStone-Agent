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
import { createMemoryEmbeddingProvider, embeddingFailureCause, memoryEmbeddingSpec, type MemoryEmbeddingProvider } from "./embedding.js";
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
  /**
   * At most this many chunks another model (or an unrecorded one) embedded
   * are embedded again in this run, newest first; chunks with no vector are
   * always embedded. Absent: all of them (#140 review: a whole-index
   * re-embed on the per-turn queue held up every later turn's own chunks).
   */
  otherModelLimit?: number;
  /** With otherModelLimit: only chunks another model (or an unrecorded one) embedded; chunks with no vector are left (#157). */
  otherModelOnly?: boolean;
  /**
   * Awaited before each request to the embedder: the gateway waits here while turns run (#157).
   * After it, a chunk removed or rewritten meanwhile is left out of the request.
   */
  beforeBatch?: () => Promise<void>;
};

/** How many of another model's chunks each turn's index update embeds again (#140 review). */
export const MEMORY_REEMBED_PER_TURN = 128;

/**
 * Chunks a request when the gateway embeds another model's chunks again (#157):
 * a turn's query that arrives meanwhile waits behind at most this many on an
 * embedder that answers one request at a time.
 */
export const MEMORY_REEMBED_BATCH = 4;

/**
 * After this many refusals on its own, a chunk isn't sent to that model again
 * (#170): it stays found by its words, and the rest of the index goes on being
 * embedded. A chunk whose text changes is tried afresh.
 */
export const MEMORY_EMBED_SKIP_AFTER = 3;

/**
 * A chunk's refusals count at most once per this long (#170 review), so reaching
 * MEMORY_EMBED_SKIP_AFTER takes at least 20 minutes of refusals, not one burst of runs.
 */
export const MEMORY_EMBED_REFUSAL_SPACING_MS = 10 * 60 * 1000;

/** The short text sent after a request none of whose chunks went in, to tell a refused text from a refusing embedder (#170 review). */
export const MEMORY_EMBED_PROBE_TEXT = "memory";

export type SqliteMemoryEmbeddingBackfillResult = {
  databasePath: string;
  providerId: string;
  model: string;
  chunksConsidered: number;
  chunksEmbedded: number;
  /** Chunks the embedder refused on their own in this run (#170); after MEMORY_EMBED_SKIP_AFTER they are skipped for that model. */
  chunksRejected: number;
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
  embedding_spec?: string;
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
  // Which embedding model made each chunk's vector (#140): vectors from
  // another model, or of another size, are never compared with a query's.
  const columns = db.prepare("PRAGMA table_info(memory_chunks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "embedding_spec")) {
    db.exec("ALTER TABLE memory_chunks ADD COLUMN embedding_spec TEXT");
  }
  // Chunks an embedding model refused on their own, and how often (#170): after
  // MEMORY_EMBED_SKIP_AFTER, not sent to that model again while the text is the same.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embed_rejections (
      chunk_id TEXT NOT NULL,
      spec TEXT NOT NULL,
      text TEXT NOT NULL,
      failures INTEGER NOT NULL,
      reason TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chunk_id, spec)
    );
  `);
}

/** SQL: this chunk (memory_chunks) was refused MEMORY_EMBED_SKIP_AFTER times by the model (the first parameter), text unchanged. */
const SKIPPED_FOR_SPEC = `EXISTS (
  SELECT 1 FROM memory_embed_rejections r
  WHERE r.chunk_id = memory_chunks.chunk_id AND r.spec = ? AND r.text = memory_chunks.text AND r.failures >= ${MEMORY_EMBED_SKIP_AFTER}
)`;
/** SQL: the model (the first parameter) refused this chunk before, text unchanged: such chunks go last, so they can't head every run (#170). */
const REFUSED_BEFORE = `EXISTS (
  SELECT 1 FROM memory_embed_rejections r
  WHERE r.chunk_id = memory_chunks.chunk_id AND r.spec = ? AND r.text = memory_chunks.text
)`;

/** How many chunks have a vector, and how many of those another model made (or an unrecorded one). */
export function sqliteMemoryEmbeddingMix(
  spec: string,
  paths: MindStoneRuntimePaths = runtimePathsFromEnv(),
): { embedded: number; otherModel: number; skipped: number } {
  const databasePath = sqliteMemoryDatabasePath(paths);
  if (!existsSync(databasePath)) return { embedded: 0, otherModel: 0, skipped: 0 };
  const db = openDatabase(databasePath);
  try {
    initializeSchema(db);
    // otherModel: another model's chunks still to be embedded again with this one, so not the ones
    // this model refused MEMORY_EMBED_SKIP_AFTER times (skipped, below) (#170 review).
    const row = db.prepare(`
      SELECT count(*) AS embedded,
             sum(CASE WHEN (embedding_spec IS NULL OR embedding_spec != ?) AND NOT ${SKIPPED_FOR_SPEC} THEN 1 ELSE 0 END) AS otherModel
      FROM memory_chunks WHERE embedding_json IS NOT NULL
    `).get(spec, spec) as { embedded: number; otherModel: number | null };
    // Chunks this model refused MEMORY_EMBED_SKIP_AFTER times: found by their words only (#170).
    const skipped = db.prepare(`SELECT count(*) AS n FROM memory_chunks WHERE ${SKIPPED_FOR_SPEC}`).get(spec) as { n: number };
    return { embedded: Number(row.embedded ?? 0), otherModel: Number(row.otherModel ?? 0), skipped: Number(skipped.n ?? 0) };
  } finally {
    db.close();
  }
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
  // Vectors of different sizes come from different models: no similarity (#140).
  if (a.length !== b.length) return 0;
  const length = a.length;
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
  "skill_proposal_dropped",
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

function preservedChunkEmbeddings(db: DatabaseSync, sourceId: string): Map<string, { json: string; spec: string | null }> {
  const rows = db.prepare("SELECT text, embedding_json, embedding_spec FROM memory_chunks WHERE source_id = ? AND embedding_json IS NOT NULL").all(sourceId) as Array<{ text: string; embedding_json?: string; embedding_spec?: string | null }>;
  const output = new Map<string, { json: string; spec: string | null }>();
  for (const row of rows) {
    if (!row.embedding_json || !parseEmbedding(row.embedding_json)) continue;
    const key = hashText(row.text.trim());
    // The model travels with the vector, so a kept vector is never taken for the current model's.
    if (!output.has(key)) output.set(key, { json: row.embedding_json, spec: row.embedding_spec ?? null });
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
    INSERT INTO memory_chunks (chunk_id, source_id, kind, path, title, ordinal, text, token_estimate, embedding_json, embedding_spec, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      preservedEmbedding?.json ?? null,
      preservedEmbedding?.spec ?? null,
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
  /** The turn's own chunks the embedder refused on their own (#170). */
  chunksRejected: number;
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
  /**
   * How many of another model's chunks to embed again after the turn's own
   * (default MEMORY_REEMBED_PER_TURN). The gateway passes 0 and paces them
   * with reembedSqliteMemoryOtherModel, off the update a turn waits for (#157).
   */
  otherModelLimit?: number;
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
  // The turn's own chunks, then (unless otherModelLimit is 0, as the gateway passes, #157) a few of
  // another model's: a model switch is finished over later turns (or at once by
  // `mindstone memory backfill --embed`), never ahead of this turn's chunks (#140 review).
  const embedded = provider
    ? await backfillSqliteMemoryEmbeddings({ paths, config: options.config, provider, newestFirst: true, otherModelLimit: options.otherModelLimit ?? MEMORY_REEMBED_PER_TURN })
    : undefined;
  return { databasePath, sourcesIndexed, chunksEmbedded: embedded?.chunksEmbedded ?? 0, chunksRejected: embedded?.chunksRejected ?? 0 };
}

/**
 * Embeds again up to `limit` (default MEMORY_REEMBED_PER_TURN) of the newest
 * chunks another model embedded, MEMORY_REEMBED_BATCH a request, awaiting
 * `beforeBatch` before each (#157): the gateway's paced share of a model
 * switch after a turn, which never holds up a turn's own chunks or its query.
 */
export async function reembedSqliteMemoryOtherModel(options: {
  config?: MindStoneConfig;
  paths?: MindStoneRuntimePaths;
  provider: MemoryEmbeddingProvider;
  limit?: number;
  beforeBatch?: () => Promise<void>;
}): Promise<SqliteMemoryEmbeddingBackfillResult> {
  return backfillSqliteMemoryEmbeddings({
    paths: options.paths,
    config: options.config,
    provider: options.provider,
    otherModelOnly: true,
    otherModelLimit: options.limit ?? MEMORY_REEMBED_PER_TURN,
    batchSize: MEMORY_REEMBED_BATCH,
    beforeBatch: options.beforeBatch,
  });
}

export async function backfillSqliteMemoryEmbeddings(options: SqliteMemoryEmbeddingBackfillOptions = {}): Promise<SqliteMemoryEmbeddingBackfillResult> {
  const paths = options.paths ?? runtimePathsFromEnv();
  const databasePath = sqliteMemoryDatabasePath(paths);
  const provider = options.provider ?? createMemoryEmbeddingProvider(options.config);
  if (!provider) throw new Error("No memory embedding provider configured. Set memory.embeddingProvider, e.g. ollama:nomic-embed-text.");

  const spec = memoryEmbeddingSpec(provider);
  const db = openDatabase(databasePath);
  initializeSchema(db);
  // A refusal whose chunk is gone (pruned, re-indexed under another id) is dropped, text and all (#170 review).
  db.exec("DELETE FROM memory_embed_rejections WHERE chunk_id NOT IN (SELECT chunk_id FROM memory_chunks)");
  // A chunk this model refused before goes last, and one it refused MEMORY_EMBED_SKIP_AFTER times isn't
  // sent again while its text is the same (#170); --force sends everything.
  const order = `ORDER BY ${REFUSED_BEFORE} ASC, updated_at ${options.newestFirst ? "DESC" : "ASC"}, chunk_id ASC`;
  // Chunks with no vector, and chunks another model (or an unrecorded one) embedded (#140);
  // with otherModelLimit, every chunk with no vector first, then at most that many of the others, newest first.
  const rows = (options.force
    ? db.prepare(`SELECT chunk_id, text FROM memory_chunks ORDER BY updated_at ${options.newestFirst ? "DESC" : "ASC"}, chunk_id ASC`).all()
    : options.otherModelLimit === undefined
      ? db.prepare(`
        SELECT chunk_id, text
        FROM memory_chunks
        WHERE (embedding_json IS NULL OR embedding_spec IS NULL OR embedding_spec != ?) AND NOT ${SKIPPED_FOR_SPEC}
        ${order}
      `).all(spec, spec, spec)
      : [
          ...(options.otherModelOnly
            ? []
            : db.prepare(`SELECT chunk_id, text FROM memory_chunks WHERE embedding_json IS NULL AND NOT ${SKIPPED_FOR_SPEC} ${order}`).all(spec, spec)),
          ...db.prepare(`
            SELECT chunk_id, text
            FROM memory_chunks
            WHERE embedding_json IS NOT NULL AND (embedding_spec IS NULL OR embedding_spec != ?) AND NOT ${SKIPPED_FOR_SPEC}
            ORDER BY ${REFUSED_BEFORE} ASC, updated_at DESC, chunk_id ASC
            LIMIT ?
          `).all(spec, spec, spec, Math.max(0, Math.floor(options.otherModelLimit))),
        ]) as Array<{ chunk_id: string; text: string }>;

  const batchSize = Math.max(1, options.batchSize ?? 16);
  let chunksEmbedded = 0;
  let dimensions: number | undefined;
  // updated_at is left alone: an embedding isn't a change to the chunk, and recall ranks its window by
  // it, so re-embedding a whole index (after a model switch) must not turn old chats into new ones (#140 review).
  // Only the text that was embedded: a chunk re-indexed meanwhile keeps its own (#140 review).
  const update = db.prepare("UPDATE memory_chunks SET embedding_json = ?, embedding_spec = ? WHERE chunk_id = ? AND text = ?");
  const still = db.prepare("SELECT 1 AS present FROM memory_chunks WHERE chunk_id = ? AND text = ?");
  const cleared = db.prepare("DELETE FROM memory_embed_rejections WHERE chunk_id = ? AND spec = ?");
  // One more refusal on its own, at most one per MEMORY_EMBED_REFUSAL_SPACING_MS (#170 review): an embedder
  // that refuses on and off can't skip a chunk in one burst of runs. The count starts again when the text changes.
  const refused = db.prepare(`
    INSERT INTO memory_embed_rejections (chunk_id, spec, text, failures, reason, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT (chunk_id, spec) DO UPDATE SET
      failures = CASE
        WHEN memory_embed_rejections.text != excluded.text THEN 1
        WHEN memory_embed_rejections.updated_at <= ? THEN memory_embed_rejections.failures + 1
        ELSE memory_embed_rejections.failures
      END,
      updated_at = CASE
        WHEN memory_embed_rejections.text != excluded.text OR memory_embed_rejections.updated_at <= ? THEN excluded.updated_at
        ELSE memory_embed_rejections.updated_at
      END,
      text = excluded.text,
      reason = excluded.reason
  `);
  let chunksRejected = 0;
  const record = (row: { chunk_id: string; text: string }, reasonError: unknown) => {
    const now = Date.now();
    const spaced = new Date(now - MEMORY_EMBED_REFUSAL_SPACING_MS).toISOString();
    const reason = (reasonError instanceof Error ? reasonError.message : String(reasonError)).replace(/\p{C}/gu, " ").slice(0, 300);
    refused.run(row.chunk_id, spec, row.text, reason, new Date(now).toISOString(), spaced, spaced);
    chunksRejected += 1;
  };

  /** Waits in beforeBatch, then leaves out a chunk removed or rewritten meanwhile (#157 review). */
  const ready = async (batch: Array<{ chunk_id: string; text: string }>) => {
    if (!options.beforeBatch) return batch;
    await options.beforeBatch();
    return batch.filter((row) => still.get(row.chunk_id, row.text) !== undefined);
  };
  const embedAndStore = async (batch: Array<{ chunk_id: string; text: string }>) => {
    const embeddings = await provider.embedTexts(batch.map((row) => row.text));
    if (embeddings.length !== batch.length) {
      throw new Error(`embedding provider returned ${embeddings.length} vectors for ${batch.length} chunks`);
    }
    db.exec("BEGIN");
    try {
      embeddings.forEach((embedding, index) => {
        dimensions ??= embedding.length;
        const changed = update.run(JSON.stringify(embedding), spec, batch[index].chunk_id, batch[index].text);
        if (Number(changed.changes) > 0) chunksEmbedded += 1;
        cleared.run(batch[index].chunk_id, spec);
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  /**
   * After a request none of whose chunks went in, even alone: one short text, to tell texts this model
   * can't take from an embedder that refuses everything (a chat model behind the embeddings route, a
   * proxy's 400 while its upstream is down) (#170 review). An outage here stops the run as anywhere.
   */
  const probeAccepted = async () => {
    await options.beforeBatch?.();
    try {
      await provider.embedTexts([MEMORY_EMBED_PROBE_TEXT]);
      return true;
    } catch (error) {
      if (embeddingFailureCause(error) !== "rejected") throw error;
      return false;
    }
  };

  try {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = await ready(rows.slice(offset, offset + batchSize));
      if (batch.length === 0) continue;
      try {
        await embedAndStore(batch);
      } catch (error) {
        // An embedder that is down or limiting requests stops the run as before; one that refused
        // the text gets the request's chunks one at a time, so a chunk it can't take (an old one
        // too long for a smaller model) doesn't stop the rest for good (#170).
        if (embeddingFailureCause(error) !== "rejected") throw error;
        const refusedAlone: Array<{ row: { chunk_id: string; text: string }; error: unknown }> = [];
        let wentInAlone = false;
        if (batch.length === 1) {
          // A request of one chunk was that chunk alone already.
          refusedAlone.push({ row: batch[0]!, error });
        } else {
          for (const row of batch) {
            const [single] = await ready([row]);
            if (!single) continue;
            try {
              await embedAndStore([single]);
              wentInAlone = true;
            } catch (alone) {
              if (embeddingFailureCause(alone) !== "rejected") throw alone;
              refusedAlone.push({ row: single, error: alone });
            }
          }
        }
        if (refusedAlone.length === 0) continue;
        // Only a refusal shown to be about the text is counted: another chunk of the request went
        // in, or the short test text did. Otherwise the embedder refuses everything: stop, count nothing.
        if (!wentInAlone && !(await probeAccepted())) {
          throw Object.assign(
            new Error(`the embedding model ${spec} refused every chunk it was sent and a short test text; check the model and its endpoint. Nothing was counted as refused.`),
            { refusedEverything: true },
          );
        }
        for (const { row, error: why } of refusedAlone) record(row, why);
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
    chunksRejected,
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
        // A refusal record whose chunk is gone is dropped, text and all (#170 review).
        db.exec("DELETE FROM memory_embed_rejections WHERE chunk_id NOT IN (SELECT chunk_id FROM memory_chunks)");
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
  /**
   * embedded: chunks with a vector from `spec`'s model; "pending": chunks
   * without one (not embedded yet, or embedded by another model), found by
   * their words (#140); false: every chunk.
   */
  #rows(embedded: boolean | "pending", scope: Record<string, string> | undefined, excludeOwnerTranscripts = false, spec?: string): StoredChunk[] {
    const db = openDatabase(this.#databasePath);
    initializeSchema(db);
    const scopeClauses = RECALL_SCOPE_DIMENSIONS.map(
      (dim) => `(json_extract(metadata_json, '$.scope.${dim}') IS NULL OR json_extract(metadata_json, '$.scope.${dim}') = ?)`,
    );
    // A row whose metadata isn't valid JSON is left out rather than making
    // json_extract throw and the whole recall fail.
    const scoped = excludeOwnerTranscripts || isScopedQuery(scope);
    const where = [
      ...(embedded === true
        ? ["embedding_json IS NOT NULL AND embedding_spec = ?"]
        : embedded === "pending"
          ? ["(embedding_json IS NULL OR embedding_spec IS NULL OR embedding_spec != ?)"]
          : []),
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
    `).all(
      ...(embedded === false ? [] : [spec ?? ""]),
      ...RECALL_SCOPE_DIMENSIONS.map((dim) => scope?.[dim] ?? null),
    ) as StoredChunk[];
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
    return this.#rows(true, query.scope, excludesOwnerTranscripts(query), memoryEmbeddingSpec(this.#embeddingProvider))
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
    return this.#rows(
      pendingOnly ? "pending" : false,
      query.scope,
      excludesOwnerTranscripts(query),
      this.#embeddingProvider ? memoryEmbeddingSpec(this.#embeddingProvider) : undefined,
    )
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
