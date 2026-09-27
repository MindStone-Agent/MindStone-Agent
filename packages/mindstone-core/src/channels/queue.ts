import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type { ConnectorOutboundMessage } from "./connector.js";

/**
 * Persistent outbound delivery queue (issue #16). One JSON file per connector
 * under <dataDir>/connectors/<id>/queue.json. Deliveries retry up to
 * maxAttempts, then dead-letter — entries are never silently dropped, and the
 * queue survives Gateway restarts.
 */
export type ConnectorQueueEntryStatus = "pending" | "delivered" | "dead";

export type ConnectorQueueEntry = {
  id: string;
  connectorId: string;
  message: ConnectorOutboundMessage;
  status: ConnectorQueueEntryStatus;
  attempts: number;
  maxAttempts: number;
  enqueuedAt?: string;
  lastError?: string;
  deliveredAt?: string;
  /** Epoch ms before which a failed entry isn't retried (exponential backoff). */
  nextAttemptAt?: number;
  /** The approved action this entry sends, so an interrupted approve can be completed (#77 review). */
  approvalId?: string;
};

type QueueFile = {
  entries: ConnectorQueueEntry[];
};

export type ConnectorQueueStatus = {
  connectorId: string;
  pending: number;
  delivered: number;
  dead: number;
};

// With backoff doubling from RETRY_BASE_MS, eight attempts span about four
// minutes, so a short outage no longer dead-letters replies in milliseconds
// (#77 review).
const DEFAULT_MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Delivered entries kept for status and history; older ones are pruned. */
const DELIVERED_KEEP = 500;
/**
 * A lock older than this is from a crashed writer and is broken. The critical
 * section is a synchronous read and write of one small file, so 2 s is far
 * beyond any live holder; it must stay well under LOCK_WAIT_MS so a waiter
 * breaks an orphaned lock instead of giving up first (#63).
 */
const STALE_LOCK_MS = 2_000;
const LOCK_WAIT_MS = 5_000;

/** One drain per queue file in this process; a drain requested mid-drain runs once more after it (#63). */
const drainsInFlight = new Map<string, { promise: Promise<ConnectorQueueStatus>; again: boolean }>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function connectorDataDir(connectorId: string, paths?: MindStoneRuntimePaths): string {
  const resolved = paths ?? runtimePathsFromEnv();
  return join(resolved.dataDir, "connectors", connectorId);
}

export class ConnectorDeliveryQueue {
  readonly connectorId: string;
  readonly #path: string;

  constructor(connectorId: string, options: { paths?: MindStoneRuntimePaths; path?: string } = {}) {
    this.connectorId = connectorId;
    this.#path = options.path ?? join(connectorDataDir(connectorId, options.paths), "queue.json");
  }

  get path(): string {
    return this.#path;
  }

  /**
   * The queue file. A missing file is an empty queue. Any other read error
   * throws, so a write never replaces a queue it couldn't read (#77 review:
   * EACCES or a truncated file used to read as empty and the next write
   * wiped every entry). A file that reads but doesn't parse is moved aside
   * as queue.json.corrupt-<time> for recovery, then this throws.
   */
  #read(): QueueFile {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as QueueFile).entries)) return parsed as QueueFile;
    } catch {
      // Handled below.
    }
    const aside = `${this.#path}.corrupt-${Date.now()}`;
    try {
      renameSync(this.#path, aside);
    } catch {
      // Leave it; the throw below still stops the write.
    }
    throw new Error(`connector queue ${this.#path} was unreadable and was moved aside to ${aside}`);
  }

  /** Read for status and listing: an unreadable queue shows as empty, and nothing is written. */
  #readForListing(): QueueFile {
    try {
      return this.#read();
    } catch {
      return { entries: [] };
    }
  }

  #write(file: QueueFile): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.tmp-${randomUUID().slice(0, 8)}`;
    const fd = openSync(temp, "w");
    try {
      writeFileSync(fd, `${JSON.stringify(file, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.#path);
    // Make the rename itself durable.
    try {
      const dirFd = openSync(dirname(this.#path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Some filesystems don't allow fsync on a directory.
    }
  }

  /**
   * Read, change and write the queue file under an exclusive lock file, so a
   * write from another process (the CLI enqueues approved sends) is never
   * overwritten by a stale copy (#63). Synchronous, so nothing in this
   * process interleaves with it either.
   */
  #mutate<T>(change: (file: QueueFile) => T): T {
    mkdirSync(dirname(this.#path), { recursive: true });
    const lockPath = `${this.#path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | undefined;
    const token = `${process.pid}:${randomUUID()}`;
    while (fd === undefined) {
      try {
        fd = openSync(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          // Break a stale lock by renaming it to a name only this waiter
          // uses, then checking it is the lock that was judged stale. A rename
          // is atomic, so two waiters can't both break it. If the renamed file
          // turns out not to be the stale one (another waiter broke and
          // retook the lock in between), it is linked back, unless a third
          // process took the free path in that instant (#63 review).
          const holder = readFileSync(lockPath, "utf-8");
          if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
            const claimed = `${lockPath}.stale-${randomUUID().slice(0, 8)}`;
            renameSync(lockPath, claimed);
            if (readFileSync(claimed, "utf-8") === holder && Date.now() - statSync(claimed).mtimeMs > STALE_LOCK_MS) {
              unlinkSync(claimed);
            } else {
              try {
                linkSync(claimed, lockPath);
              } catch {
                // A new holder took the path meanwhile; theirs stands.
              }
              unlinkSync(claimed);
            }
          }
        } catch {
          // The holder released it meanwhile, or another waiter broke it; retry.
        }
        if (Date.now() > deadline) throw new Error(`connector queue ${this.#path} is locked`);
        sleepSync(5);
        continue;
      }
      try {
        writeFileSync(fd, token);
      } catch (error) {
        // Don't leave a lock with no owner behind (ENOSPC, EIO).
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
        throw error;
      }
    }
    try {
      const file = this.#read();
      const result = change(file);
      this.#write(file);
      return result;
    } finally {
      closeSync(fd);
      // Release only our own lock: if this process was suspended past the
      // stale threshold, another process may have broken it and taken a new
      // one, which must stand (#63 review).
      try {
        if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
      } catch {
        // Already gone.
      }
    }
  }

  enqueue(
    message: ConnectorOutboundMessage,
    options: { maxAttempts?: number; now?: string; approvalId?: string } = {},
  ): ConnectorQueueEntry {
    const entry: ConnectorQueueEntry = {
      id: randomUUID(),
      connectorId: this.connectorId,
      message,
      status: "pending",
      attempts: 0,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      enqueuedAt: options.now,
      ...(options.approvalId ? { approvalId: options.approvalId } : {}),
    };
    this.#mutate((file) => {
      file.entries.push(entry);
    });
    return entry;
  }

  pending(): ConnectorQueueEntry[] {
    return this.#readForListing().entries.filter((entry) => entry.status === "pending");
  }

  /** Whether any entry (pending, delivered or dead) sends this approved action. */
  hasApproval(approvalId: string): boolean {
    return this.#read().entries.some((entry) => entry.approvalId === approvalId);
  }

  /**
   * Attempt delivery of every pending entry through `deliver`. A throwing
   * delivery increments attempts; entries exceeding maxAttempts dead-letter
   * with the last error preserved.
   *
   * Only one drain per queue runs at a time in this process; a drain asked
   * for while one is running makes it do one more pass, so an entry enqueued
   * mid-drain still goes out promptly and nothing is sent twice (#63). Each
   * entry is claimed (attempts counted) before its send and settled after it
   * with a fresh read, so a concurrent enqueue is never lost.
   */
  async drain(deliver: (entry: ConnectorQueueEntry) => Promise<void>, options: { now?: string; nowMs?: number } = {}): Promise<ConnectorQueueStatus> {
    const running = drainsInFlight.get(this.#path);
    if (running) {
      running.again = true;
      return running.promise;
    }
    const state = { promise: undefined as unknown as Promise<ConnectorQueueStatus>, again: false };
    state.promise = (async () => {
      try {
        do {
          state.again = false;
          await this.#drainOnce(deliver, options);
        } while (state.again);
        return this.status();
      } finally {
        drainsInFlight.delete(this.#path);
      }
    })();
    drainsInFlight.set(this.#path, state);
    return state.promise;
  }

  async #drainOnce(deliver: (entry: ConnectorQueueEntry) => Promise<void>, options: { now?: string; nowMs?: number }): Promise<void> {
    // The clock for backoff; tests pass nowMs to step past it.
    const clock = () => options.nowMs ?? Date.now();
    for (const { id } of this.pending()) {
      const claimed = this.#mutate((file) => {
        const entry = file.entries.find((candidate) => candidate.id === id);
        if (!entry || entry.status !== "pending") return undefined;
        // Still backing off after a failure: a later drain retries it.
        if (entry.nextAttemptAt !== undefined && entry.nextAttemptAt > clock()) return undefined;
        entry.attempts += 1;
        return { ...entry };
      });
      if (!claimed) continue;
      let error: unknown;
      try {
        await deliver(claimed);
      } catch (caught) {
        error = caught ?? new Error("delivery failed");
      }
      this.#mutate((file) => {
        const entry = file.entries.find((candidate) => candidate.id === id);
        if (!entry) return;
        if (error === undefined) {
          entry.status = "delivered";
          entry.deliveredAt = options.now;
          entry.lastError = undefined;
          entry.nextAttemptAt = undefined;
        } else {
          entry.lastError = error instanceof Error ? error.message : String(error);
          if (entry.attempts >= entry.maxAttempts) {
            entry.status = "dead";
          } else {
            entry.nextAttemptAt = clock() + Math.min(RETRY_BASE_MS * 2 ** (entry.attempts - 1), RETRY_MAX_MS);
          }
        }
        // Keep the file bounded: drop the oldest delivered entries.
        const delivered = file.entries.filter((candidate) => candidate.status === "delivered");
        if (delivered.length > DELIVERED_KEEP) {
          const drop = new Set(delivered.slice(0, delivered.length - DELIVERED_KEEP).map((candidate) => candidate.id));
          file.entries = file.entries.filter((candidate) => !drop.has(candidate.id));
        }
      });
    }
  }

  status(): ConnectorQueueStatus {
    const file = this.#readForListing();
    return {
      connectorId: this.connectorId,
      pending: file.entries.filter((entry) => entry.status === "pending").length,
      delivered: file.entries.filter((entry) => entry.status === "delivered").length,
      dead: file.entries.filter((entry) => entry.status === "dead").length,
    };
  }

  deadLetters(): ConnectorQueueEntry[] {
    return this.#readForListing().entries.filter((entry) => entry.status === "dead");
  }
}
