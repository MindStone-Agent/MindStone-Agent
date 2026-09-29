import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEmbeddingProvider } from "../memory/embedding.js";
import type { MindStoneKbIndexEntry, MindStoneKbVectorsStatus } from "./types.js";

/**
 * Embedded vectors for a KB (#125 §5). Ingest embeds each index entry with the
 * install's embedder (the one memory recall uses) and writes them next to
 * index.json. Nothing is imported: the file is generated, and a vector is only
 * used while its index, provider, model and dimension still match.
 */
export const KB_VECTORS_FILE = "vectors.json";

export const KB_EMBED_LIMITS = {
  /** Characters of an entry sent to the embedder: its title, heading and the start of its text. */
  maxChars: 6000,
  /** Entries a request: small enough for a CPU embedder to answer within `requestTimeoutMs`. */
  batchSize: 8,
  /** One embedding request at ingest (longer than the query's 10 s). */
  requestTimeoutMs: 60_000,
  /** The whole embedding pass. Past it, ingest keeps the index and drops the vectors. */
  timeoutMs: 120_000,
  /** A vectors.json larger than this is not read at recall. */
  maxFileBytes: 256 * 1024 * 1024,
  /** Decoded vectors kept in memory across turns, all KBs together. */
  cacheBytes: 512 * 1024 * 1024,
};

type KbVectorsFile = {
  version: 1;
  kbId: string;
  provider: string;
  model: string;
  dimension: number;
  /** sha256 of the index.json these vectors were made from. */
  indexSha256: string;
  createdAt?: string;
  /** entryId -> little-endian float32, base64. */
  vectors: Record<string, string>;
};

export type KbVectorsWriteResult =
  | { state: "ready"; provider: string; model: string; dimension: number; count: number }
  | { state: "missing"; reason: string };

export type LoadedKbVectors = {
  provider: string;
  model: string;
  dimension: number;
  vectors: Map<string, Float32Array>;
};

export function kbIndexDigest(indexText: string): string {
  return createHash("sha256").update(indexText).digest("hex");
}

/** What the embedder sees for an entry: where it sits, then the start of its text. */
export function kbEntryEmbeddingText(entry: MindStoneKbIndexEntry, maxChars = KB_EMBED_LIMITS.maxChars): string {
  const heading = [entry.sourceTitle, entry.section].filter((part) => part && part.trim()).join(" — ");
  return (heading ? `${heading}\n\n${entry.text}` : entry.text).trim().slice(0, maxChars);
}

function encodeVector(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

function decodeVector(encoded: unknown, dimension: number): Float32Array | undefined {
  if (typeof encoded !== "string") return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== dimension * 4) return undefined;
  const vector = new Float32Array(dimension);
  for (let index = 0; index < dimension; index += 1) {
    const value = bytes.readFloatLE(index * 4);
    if (!Number.isFinite(value)) return undefined;
    vector[index] = value;
  }
  return vector;
}

export function removeKbVectors(kbDir: string): void {
  rmSync(join(kbDir, KB_VECTORS_FILE), { force: true });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new KbEmbedTimeout()), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

class KbEmbedTimeout extends Error {}

/** A request the embedder didn't answer in time (fetch's abort), not an error the embedder sent back. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Embeds a freshly written index and writes vectors.json beside it, whole and
 * moved into place. Never fails the ingest: with no embedder, a failing one, or
 * past the time limit, any earlier vectors file is removed and recall keeps
 * word match for this KB. Reasons are fixed text, since an embedder's own error
 * can quote its request (`mindstone doctor` shows it with keys redacted).
 */
export async function writeKbVectors(params: {
  kbDir: string;
  kbId: string;
  entries: MindStoneKbIndexEntry[];
  indexText: string;
  embedder?: MemoryEmbeddingProvider;
  now?: string;
  timeoutMs?: number;
  batchSize?: number;
}): Promise<KbVectorsWriteResult> {
  const { embedder } = params;
  if (!embedder) {
    removeKbVectors(params.kbDir);
    return { state: "missing", reason: "no embedder is configured" };
  }
  const started = Date.now();
  const budget = params.timeoutMs ?? KB_EMBED_LIMITS.timeoutMs;
  const batchSize = Math.max(1, params.batchSize ?? KB_EMBED_LIMITS.batchSize);
  const encoded: Record<string, string> = {};
  let dimension = 0;
  const embedBatch = async (batch: MindStoneKbIndexEntry[]) => {
    const texts = batch.map((entry) => kbEntryEmbeddingText(entry));
    // The embedder drops blank inputs, which would shift every vector after one.
    if (texts.some((text) => !text)) throw new Error("blank entry");
    const vectors = await withTimeout(embedder.embedTexts(texts), budget - (Date.now() - started));
    if (vectors.length !== batch.length) throw new Error("vector count");
    batch.forEach((entry, index) => {
      const vector = vectors[index];
      if (dimension === 0) dimension = vector.length;
      if (vector.length !== dimension || dimension === 0) throw new Error("dimension");
      // Stored as float32: a value past its range would read back as infinity.
      if (vector.some((value) => !Number.isFinite(Math.fround(value)))) throw new Error("range");
      encoded[entry.entryId] = encodeVector(vector);
    });
  };
  try {
    for (let offset = 0; offset < params.entries.length; offset += batchSize) {
      const batch = params.entries.slice(offset, offset + batchSize);
      try {
        await embedBatch(batch);
      } catch (error) {
        // A request the embedder couldn't finish in time: its entries once more, one a request.
        if (error instanceof KbEmbedTimeout || !isAbort(error) || batch.length === 1) throw error;
        for (const entry of batch) await embedBatch([entry]);
      }
    }
  } catch (error) {
    removeKbVectors(params.kbDir);
    return {
      state: "missing",
      reason: error instanceof KbEmbedTimeout
        ? `embedding took longer than ${Math.round(budget / 1000)} s; ingest again with a longer limit (CLI: --embed-timeout <seconds>)`
        : isAbort(error)
          ? "the embedder didn't answer a request in time; run `mindstone doctor` to check it"
          : "the embedder failed; run `mindstone doctor` to check it",
    };
  }
  if (dimension === 0) {
    removeKbVectors(params.kbDir);
    return { state: "missing", reason: "the index has no entries" };
  }
  const file: KbVectorsFile = {
    version: 1,
    kbId: params.kbId,
    provider: embedder.id,
    model: embedder.model,
    dimension,
    indexSha256: kbIndexDigest(params.indexText),
    ...(params.now ? { createdAt: params.now } : {}),
    vectors: encoded,
  };
  const path = join(params.kbDir, KB_VECTORS_FILE);
  const temp = join(params.kbDir, `.${KB_VECTORS_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { flag: "wx" });
    renameSync(temp, path);
  } catch {
    removeKbVectors(params.kbDir);
    return { state: "missing", reason: "the vectors file could not be written" };
  } finally {
    rmSync(temp, { force: true });
  }
  return { state: "ready", provider: file.provider, model: file.model, dimension, count: Object.keys(encoded).length };
}

type ReadKbVectors =
  | { state: "ready"; loaded: LoadedKbVectors; count: number }
  | { state: "missing" | "stale" | "unused"; reason: string; provider?: string; model?: string; dimension?: number };

/**
 * The vectors beside an index, if they can be used with `embedder` (the
 * install's provider and model now). Stale when either changed, or when the
 * index was written again after them. `noLinks`: a private KB's file must not
 * be a link.
 */
export function readKbVectors(
  kbDir: string,
  indexText: string,
  embedder: { id: string; model: string } | undefined,
  options: { noLinks?: boolean } = {},
): ReadKbVectors {
  const path = join(kbDir, KB_VECTORS_FILE);
  let parsed: ParsedVectorsFile;
  try {
    if (options.noLinks && lstatSync(path).isSymbolicLink()) return { state: "missing", reason: "vectors.json is a link" };
    parsed = parsedVectorsFile(path, options.noLinks === true);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Not a file (a pipe, a folder) or a link swapped in: re-ingest writes a file. Anything else may pass.
    if (!code || code === "ELOOP") return { state: "missing", reason: "vectors.json isn't a file that can be read; re-ingest" };
    if (code !== "ENOENT") return { state: "missing", reason: `vectors.json can't be read now (${code})` };
    return { state: "missing", reason: embedder ? "not embedded yet; re-ingest" : "no embedder is configured" };
  }
  if (parsed === "too_large") return { state: "stale", reason: `vectors.json is larger than ${KB_EMBED_LIMITS.maxFileBytes / 1024 / 1024} MB; recall uses word match for this KB` };
  if (parsed === "unreadable") return { state: "stale", reason: "vectors.json can't be read; re-ingest" };
  const file = parsed.file;
  const dimension = file.dimension;
  if (
    !file || typeof file !== "object" || file.version !== 1 || typeof file.provider !== "string" || typeof file.model !== "string"
    || typeof dimension !== "number" || !Number.isInteger(dimension) || dimension <= 0
    || !file.vectors || typeof file.vectors !== "object" || Array.isArray(file.vectors)
  ) {
    return { state: "stale", reason: "vectors.json can't be read; re-ingest" };
  }
  const described = { provider: file.provider, model: file.model, dimension };
  if (!embedder) return { state: "unused", reason: "no embedder is configured", ...described };
  if (file.provider !== embedder.id || file.model !== embedder.model) {
    return { state: "stale", reason: `made with ${file.provider}:${file.model}, the install now uses ${embedder.id}:${embedder.model}; re-ingest`, ...described };
  }
  if (file.indexSha256 !== kbIndexDigest(indexText)) {
    return { state: "stale", reason: "the index changed after these vectors were made; re-ingest", ...described };
  }
  const vectors = parsed.decoded();
  if (!vectors) return { state: "stale", reason: "vectors.json can't be read; re-ingest", ...described };
  return { state: "ready", loaded: { provider: file.provider, model: file.model, dimension, vectors }, count: vectors.size };
}

type ParsedVectorsFile = "too_large" | "unreadable" | { file: Partial<KbVectorsFile>; decoded: () => Map<string, Float32Array> | undefined };

/**
 * vectors.json parsed, and its vectors decoded on first use, kept while the
 * file stays the same one (inode, size, mtime and ctime: ingest moves a new
 * file into place): recall reads it every turn (#125 §5 review). The stale
 * checks still run on every read. Least recently used entries go first once
 * the files kept add up to KB_EMBED_LIMITS.cacheBytes.
 */
const PARSED_VECTORS = new Map<string, { key: string; bytes: number; parsed: ParsedVectorsFile }>();

function parsedVectorsFile(path: string, noLinks: boolean): ParsedVectorsFile {
  // One descriptor for the size check and the read: a file swapped in between
  // can't skip the cap. Never through a link for a private KB, and never
  // waiting on something that isn't a file (a pipe).
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (noLinks ? constants.O_NOFOLLOW : 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a file");
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = PARSED_VECTORS.get(path);
    if (cached && cached.key === key) {
      PARSED_VECTORS.delete(path);
      PARSED_VECTORS.set(path, cached);
      return cached.parsed;
    }
    let parsed: ParsedVectorsFile;
    if (stat.size > KB_EMBED_LIMITS.maxFileBytes) {
      parsed = "too_large";
    } else {
      try {
        const file = JSON.parse(readFileSync(fd, "utf-8")) as Partial<KbVectorsFile>;
        if (!file || typeof file !== "object") throw new Error("not an object");
        let decoded: Map<string, Float32Array> | undefined | null = null;
        parsed = {
          file,
          decoded: () => {
            if (decoded !== null) return decoded;
            decoded = new Map();
            for (const [entryId, encoded] of Object.entries(file.vectors ?? {})) {
              const vector = decodeVector(encoded, file.dimension as number);
              if (!vector) {
                decoded = undefined;
                break;
              }
              decoded.set(entryId, vector);
            }
            // The base64 isn't needed once decoded: only the floats stay in memory.
            file.vectors = {};
            return decoded;
          },
        };
      } catch {
        parsed = "unreadable";
      }
    }
    PARSED_VECTORS.delete(path);
    // A file not read (too large, unreadable) holds no memory.
    PARSED_VECTORS.set(path, { key, bytes: typeof parsed === "string" ? 0 : stat.size, parsed });
    let total = [...PARSED_VECTORS.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [oldPath, entry] of PARSED_VECTORS) {
      if (total <= KB_EMBED_LIMITS.cacheBytes || oldPath === path) break;
      PARSED_VECTORS.delete(oldPath);
      total -= entry.bytes;
    }
    return parsed;
  } finally {
    closeSync(fd);
  }
}

/** The vectors.json paths the cache holds, least recently used first (for tests). */
export function kbVectorsCachedPaths(): string[] {
  return [...PARSED_VECTORS.keys()];
}

export function kbVectorsStatus(read: ReadKbVectors): MindStoneKbVectorsStatus {
  if (read.state === "ready") {
    return { state: "ready", provider: read.loaded.provider, model: read.loaded.model, dimension: read.loaded.dimension, count: read.count };
  }
  return { state: read.state, reason: read.reason, provider: read.provider, model: read.model, dimension: read.dimension };
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
