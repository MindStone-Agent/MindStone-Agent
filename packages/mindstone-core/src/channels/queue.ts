import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

const DEFAULT_MAX_ATTEMPTS = 3;
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

  #read(): QueueFile {
    if (!existsSync(this.#path)) return { entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as QueueFile).entries)) return parsed as QueueFile;
    } catch {
      // fall through — a corrupt queue file is replaced, not fatal
    }
    return { entries: [] };
  }

  #write(file: QueueFile): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.tmp-${randomUUID().slice(0, 8)}`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temp, this.#path);
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
        writeFileSync(fd, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          // Break a stale lock only if it still holds the same owner we judged
          // stale, so a waiter can't delete a lock another waiter just took.
          const holder = readFileSync(lockPath, "utf-8");
          if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS && readFileSync(lockPath, "utf-8") === holder) {
            unlinkSync(lockPath);
          }
        } catch {
          // The holder released it meanwhile; retry.
        }
        if (Date.now() > deadline) throw new Error(`connector queue ${this.#path} is locked`);
        sleepSync(5);
      }
    }
    try {
      const file = this.#read();
      const result = change(file);
      this.#write(file);
      return result;
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone.
      }
    }
  }

  enqueue(message: ConnectorOutboundMessage, options: { maxAttempts?: number; now?: string } = {}): ConnectorQueueEntry {
    const entry: ConnectorQueueEntry = {
      id: randomUUID(),
      connectorId: this.connectorId,
      message,
      status: "pending",
      attempts: 0,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      enqueuedAt: options.now,
    };
    this.#mutate((file) => {
      file.entries.push(entry);
    });
    return entry;
  }

  pending(): ConnectorQueueEntry[] {
    return this.#read().entries.filter((entry) => entry.status === "pending");
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
  async drain(deliver: (entry: ConnectorQueueEntry) => Promise<void>, options: { now?: string } = {}): Promise<ConnectorQueueStatus> {
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

  async #drainOnce(deliver: (entry: ConnectorQueueEntry) => Promise<void>, options: { now?: string }): Promise<void> {
    for (const { id } of this.pending()) {
      const claimed = this.#mutate((file) => {
        const entry = file.entries.find((candidate) => candidate.id === id);
        if (!entry || entry.status !== "pending") return undefined;
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
        } else {
          entry.lastError = error instanceof Error ? error.message : String(error);
          if (entry.attempts >= entry.maxAttempts) entry.status = "dead";
        }
      });
    }
  }

  status(): ConnectorQueueStatus {
    const file = this.#read();
    return {
      connectorId: this.connectorId,
      pending: file.entries.filter((entry) => entry.status === "pending").length,
      delivered: file.entries.filter((entry) => entry.status === "delivered").length,
      dead: file.entries.filter((entry) => entry.status === "dead").length,
    };
  }

  deadLetters(): ConnectorQueueEntry[] {
    return this.#read().entries.filter((entry) => entry.status === "dead");
  }
}
