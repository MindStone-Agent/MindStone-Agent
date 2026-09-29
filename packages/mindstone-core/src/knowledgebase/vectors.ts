import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryEmbeddingSpec, type MemoryEmbeddingProvider } from "../memory/embedding.js";
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
  | {
    state: "missing";
    reason: string;
    superseded?: true;
    /**
     * Why embedding stopped (#158): the embedder couldn't be reached or used
     * (down, a 5xx, a timeout, no key), it was limiting requests (429), or it
     * refused the text (a 400, a zero or wrong-size vector).
     */
    cause?: KbEmbedFailureCause;
    /** Entries embedded before it stopped. */
    embedded?: number;
  };

export type KbEmbedFailureCause = "unavailable" | "rate-limited" | "rejected";

/** The re-embed's state for a KB (#158), beside its vectors, so a restart keeps it. */
export const KB_REEMBED_STATE_FILE = "reembed.json";
/** How the stale reason ends while the gateway may still embed the KB again. */
export const KB_REEMBED_NOTE = " (a KB of at most 512 entries is also embedded again after an owner's chat through the gateway)";

export type KbReembedState = {
  version: 1;
  /** The model spec the attempts were for: a state for another model doesn't apply. */
  spec: string;
  /** Failures that count toward giving up. */
  failures: number;
  /** When it may be tried again; absent once given up. */
  nextAttemptAt?: string;
  gaveUp?: true;
  /** The last attempt's fixed reason. */
  reason?: string;
  updatedAt: string;
};

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
class KbZeroVector extends Error {}

/** Why an embed request failed (#158), from the error the embedding provider threw. */
function embedFailureCause(error: unknown): KbEmbedFailureCause {
  const { status, unavailable } = (error ?? {}) as { status?: unknown; unavailable?: unknown };
  if (status === 429) return "rate-limited";
  // A 5xx, or a key, permission or model the embedder doesn't have: nothing about the text.
  if (typeof status === "number") return status >= 500 || status === 401 || status === 403 || status === 404 ? "unavailable" : "rejected";
  // Not reached (fetch's TypeError), not answered in time, or not usable as configured.
  if (unavailable === true || error instanceof KbEmbedTimeout || isAbort(error) || error instanceof TypeError) return "unavailable";
  return "rejected";
}

/** The re-embed state beside a KB's vectors, if it is a small file (never a link for a private KB). */
export function readKbReembedState(kbDir: string, options: { noLinks?: boolean } = {}): KbReembedState | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(kbDir, KB_REEMBED_STATE_FILE), constants.O_RDONLY | constants.O_NONBLOCK | (options.noLinks ? constants.O_NOFOLLOW : 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    const state = JSON.parse(readFileSync(fd, "utf8")) as Partial<KbReembedState>;
    if (
      state?.version !== 1 || typeof state.spec !== "string" || typeof state.updatedAt !== "string"
      || typeof state.failures !== "number" || !Number.isInteger(state.failures) || state.failures < 0
      || (state.nextAttemptAt !== undefined && (typeof state.nextAttemptAt !== "string" || Number.isNaN(Date.parse(state.nextAttemptAt))))
      || (state.gaveUp !== undefined && state.gaveUp !== true)
      || (state.reason !== undefined && typeof state.reason !== "string")
    ) {
      return undefined;
    }
    return state as KbReembedState;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Writes the re-embed state whole (moved into place); false if it can't be written. */
export function writeKbReembedState(kbDir: string, state: KbReembedState): boolean {
  const temp = join(kbDir, `.${KB_REEMBED_STATE_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { flag: "wx" });
    renameSync(temp, join(kbDir, KB_REEMBED_STATE_FILE));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function clearKbReembedState(kbDir: string): void {
  rmSync(join(kbDir, KB_REEMBED_STATE_FILE), { force: true });
}

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
  /**
   * The index these entries came from: checked again before the vectors are
   * written, so an ingest that finished meanwhile keeps its own (#151 review).
   */
  indexPath?: string;
  /** A background re-embed (#151): on failure the old vectors stay, rather than being removed. */
  keepOnFailure?: boolean;
  /**
   * Awaited before each request (#156 review): a background re-embed waits
   * while a turn is being answered. Time spent waiting doesn't count against
   * the budget.
   */
  beforeBatch?: () => Promise<void>;
}): Promise<KbVectorsWriteResult> {
  const { embedder } = params;
  const indexStillCurrent = () => {
    if (!params.indexPath) return true;
    try {
      return kbIndexDigest(readFileSync(params.indexPath, "utf-8")) === kbIndexDigest(params.indexText);
    } catch {
      return false;
    }
  };
  // Old vectors are removed only by the run whose index is the current one.
  const dropOld = () => {
    if (!params.keepOnFailure && indexStillCurrent()) removeKbVectors(params.kbDir);
  };
  if (!embedder) {
    dropOld();
    return { state: "missing", reason: "no embedder is configured" };
  }
  const started = Date.now();
  const budget = params.timeoutMs ?? KB_EMBED_LIMITS.timeoutMs;
  const batchSize = Math.max(1, params.batchSize ?? KB_EMBED_LIMITS.batchSize);
  const encoded: Record<string, string> = {};
  let dimension = 0;
  let paused = 0;
  const embedBatch = async (batch: MindStoneKbIndexEntry[]) => {
    const texts = batch.map((entry) => kbEntryEmbeddingText(entry));
    // The embedder drops blank inputs, which would shift every vector after one.
    if (texts.some((text) => !text)) throw new Error("blank entry");
    const vectors = await withTimeout(embedder.embedTexts(texts), budget - (Date.now() - started - paused));
    if (vectors.length !== batch.length) throw new Error("vector count");
    batch.forEach((entry, index) => {
      const vector = vectors[index];
      if (dimension === 0) dimension = vector.length;
      if (vector.length !== dimension || dimension === 0) throw new Error("dimension");
      // Stored as float32: a value past its range would read back as infinity.
      if (vector.some((value) => !Number.isFinite(Math.fround(value)))) throw new Error("range");
      // An all-zero vector (as stored, in float32) matches nothing (#151).
      if (vector.every((value) => Math.fround(value) === 0)) throw new KbZeroVector();
      encoded[entry.entryId] = encodeVector(vector);
    });
  };
  try {
    for (let offset = 0; offset < params.entries.length; offset += batchSize) {
      if (params.beforeBatch) {
        const waitStarted = Date.now();
        await params.beforeBatch();
        paused += Date.now() - waitStarted;
      }
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
    dropOld();
    const cause = embedFailureCause(error);
    return {
      state: "missing",
      cause,
      embedded: Object.keys(encoded).length,
      reason: cause === "rate-limited"
        ? "the embedder is limiting requests (HTTP 429); tried again later"
        : error instanceof KbZeroVector
        ? "the embedder returned an all-zero vector for an entry; check the embedding model, then re-ingest"
        : error instanceof KbEmbedTimeout
        ? `embedding took longer than ${Math.round(budget / 1000)} s; ingest again with a longer limit (CLI: --embed-timeout <seconds>)`
        : isAbort(error)
          ? "the embedder didn't answer a request in time; run `mindstone doctor` to check it"
          : "the embedder failed; run `mindstone doctor` to check it",
    };
  }
  if (dimension === 0) {
    dropOld();
    return { state: "missing", reason: "the index has no entries" };
  }
  if (!indexStillCurrent()) return { state: "missing", reason: "the index changed while these were embedded; the newer ingest's vectors are kept", superseded: true };
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
    // Embedded for this model: nothing is left to retry or give up on (#158).
    clearKbReembedState(params.kbDir);
  } catch {
    dropOld();
    return { state: "missing", reason: "the vectors file could not be written" };
  } finally {
    rmSync(temp, { force: true });
  }
  return { state: "ready", provider: file.provider, model: file.model, dimension, count: Object.keys(encoded).length };
}

type ReadKbVectors =
  | { state: "ready"; loaded: LoadedKbVectors; count: number }
  | { state: "missing" | "stale" | "unused"; reason: string; provider?: string; model?: string; dimension?: number; cause?: "model" };

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
  /** `decode: false`: the header checks only (a background scan, #151 review); a ready result then holds no vectors. */
  options: { noLinks?: boolean; decode?: boolean } = {},
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
  // The same model identity memory records with each chunk (#140, #151).
  if (memoryEmbeddingSpec({ id: file.provider, model: file.model }) !== memoryEmbeddingSpec(embedder)) {
    return {
      state: "stale",
      reason: `made with ${memoryEmbeddingSpec({ id: file.provider, model: file.model })}, the install now uses ${memoryEmbeddingSpec(embedder)}; re-ingest${KB_REEMBED_NOTE}`,
      ...described,
      cause: "model",
    };
  }
  if (file.indexSha256 !== kbIndexDigest(indexText)) {
    return { state: "stale", reason: "the index changed after these vectors were made; re-ingest", ...described };
  }
  if (options.decode === false) return { state: "ready", loaded: { provider: file.provider, model: file.model, dimension, vectors: new Map() }, count: 0 };
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
