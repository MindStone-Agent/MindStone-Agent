import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { estimatePromptTokens } from "../context/index.js";
import type { MindStoneConfig } from "../config/index.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type { TranscriptEntry } from "../transcript/index.js";
import { createMemoryEmbeddingProvider, type MemoryEmbeddingProvider } from "./embedding.js";
import { discoverFileMemoryDocuments } from "./file-memory.js";
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
  fileDocuments: number;
  transcriptDocuments: number;
};

export type SqliteMemoryIndexStats = {
  databasePath: string;
  present: boolean;
  sources: number;
  chunks: number;
  embeddedChunks: number;
  updatedAt?: string;
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

function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
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

function transcriptDocuments(paths: MindStoneRuntimePaths): MemoryDocument[] {
  if (!existsSync(paths.transcriptDir) || !statSync(paths.transcriptDir).isDirectory()) return [];
  const docs: MemoryDocument[] = [];
  for (const name of readdirSync(paths.transcriptDir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(paths.transcriptDir, name);
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    lines.forEach((line, index) => {
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        return;
      }
      const text = entry.text?.trim();
      if (!text) return;
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
          runId: entry.runId,
          event: entry.metadata?.event,
        },
      });
    });
  }
  return docs;
}

function indexDocument(db: DatabaseSync, document: MemoryDocument): number {
  const now = new Date().toISOString();
  const contentHash = hashText(document.text);
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
    INSERT INTO memory_chunks (chunk_id, source_id, kind, path, title, ordinal, text, token_estimate, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const chunks = chunkText(document.text);
  chunks.forEach((text, ordinal) => {
    insertChunk.run(
      `${document.id}#${ordinal}`,
      document.id,
      document.kind,
      document.path ?? null,
      document.title ?? null,
      ordinal,
      text,
      estimatePromptTokens(text),
      JSON.stringify({ ...(document.metadata ?? {}), sourceId: document.id }),
      now,
    );
  });
  return chunks.length;
}

export function backfillSqliteMemoryIndex(options: SqliteMemoryBackfillOptions = {}): SqliteMemoryBackfillResult {
  const paths = options.paths ?? runtimePathsFromEnv();
  const databasePath = sqliteMemoryDatabasePath(paths);
  const db = openDatabase(databasePath);
  initializeSchema(db);

  const fileDocuments = options.includeFileMemory === false ? [] : discoverFileMemoryDocuments({ config: options.config, paths });
  const transcriptDocs = options.includeTranscripts === false ? [] : transcriptDocuments(paths);
  const documents = [...fileDocuments, ...transcriptDocs];
  let chunksIndexed = 0;

  db.exec("BEGIN");
  try {
    for (const document of documents) chunksIndexed += indexDocument(db, document);
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
    fileDocuments: fileDocuments.length,
    transcriptDocuments: transcriptDocs.length,
  };
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
    ORDER BY updated_at ASC, chunk_id ASC
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
  if (!existsSync(databasePath)) return { databasePath, present: false, sources: 0, chunks: 0, embeddedChunks: 0 };
  try {
    const db = openDatabase(databasePath);
    initializeSchema(db);
    const sources = db.prepare("SELECT count(*) AS count FROM memory_sources").get() as { count: number };
    const chunks = db.prepare("SELECT count(*) AS count FROM memory_chunks").get() as { count: number };
    const embeddedChunks = db.prepare("SELECT count(*) AS count FROM memory_chunks WHERE embedding_json IS NOT NULL").get() as { count: number };
    const updated = db.prepare("SELECT max(updated_at) AS updatedAt FROM memory_chunks").get() as { updatedAt?: string };
    db.close();
    return {
      databasePath,
      present: true,
      sources: Number(sources.count ?? 0),
      chunks: Number(chunks.count ?? 0),
      embeddedChunks: Number(embeddedChunks.count ?? 0),
      updatedAt: updated.updatedAt,
    };
  } catch (error) {
    return { databasePath, present: true, sources: 0, chunks: 0, embeddedChunks: 0, error: error instanceof Error ? error.message : String(error) };
  }
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
        if (embeddingHits.length > 0) return embeddingHits;
      } catch {
        // Fall through to lexical scoring. AutoRecall should degrade, not break chat routing, when an embedder is down.
      }
    }
    return this.#lexicalSearch(query);
  }

  #rows(includeEmbeddings: boolean): StoredChunk[] {
    const db = openDatabase(this.#databasePath);
    initializeSchema(db);
    const rows = db.prepare(`
      SELECT chunk_id, source_id, kind, path, title, ordinal, text, token_estimate, embedding_json, metadata_json
      FROM memory_chunks
      ${includeEmbeddings ? "WHERE embedding_json IS NOT NULL" : ""}
      ORDER BY updated_at DESC
      LIMIT 5000
    `).all() as StoredChunk[];
    db.close();
    return rows;
  }

  async #embeddingSearch(query: MemoryQuery): Promise<MemoryHit[]> {
    if (!this.#embeddingProvider) return [];
    const [queryEmbedding] = await this.#embeddingProvider.embedTexts([query.text]);
    if (!queryEmbedding) return [];
    const limit = query.limit ?? 8;
    return this.#rows(true)
      .map((row) => {
        const embedding = parseEmbedding(row.embedding_json);
        const score = embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;
        return this.#hitFromRow(row, score, "embedding");
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, limit);
  }

  #lexicalSearch(query: MemoryQuery): MemoryHit[] {
    const limit = query.limit ?? 8;
    return this.#rows(false)
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

export function createSqliteMemoryRecallProvider(options: { config?: MindStoneConfig; paths?: MindStoneRuntimePaths } = {}): MemoryRecallProvider | undefined {
  const paths = options.paths ?? runtimePathsFromEnv();
  const databasePath = sqliteMemoryDatabasePath(paths);
  return existsSync(databasePath)
    ? new SqliteMemoryRecallProvider({ databasePath, embeddingProvider: createMemoryEmbeddingProvider(options.config) })
    : undefined;
}
