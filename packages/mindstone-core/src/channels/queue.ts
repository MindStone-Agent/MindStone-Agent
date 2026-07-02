import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

  enqueue(message: ConnectorOutboundMessage, options: { maxAttempts?: number; now?: string } = {}): ConnectorQueueEntry {
    const file = this.#read();
    const entry: ConnectorQueueEntry = {
      id: randomUUID(),
      connectorId: this.connectorId,
      message,
      status: "pending",
      attempts: 0,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      enqueuedAt: options.now,
    };
    file.entries.push(entry);
    this.#write(file);
    return entry;
  }

  pending(): ConnectorQueueEntry[] {
    return this.#read().entries.filter((entry) => entry.status === "pending");
  }

  /**
   * Attempt delivery of every pending entry through `deliver`. A throwing
   * delivery increments attempts; entries exceeding maxAttempts dead-letter
   * with the last error preserved.
   */
  async drain(deliver: (entry: ConnectorQueueEntry) => Promise<void>, options: { now?: string } = {}): Promise<ConnectorQueueStatus> {
    const file = this.#read();
    for (const entry of file.entries) {
      if (entry.status !== "pending") continue;
      entry.attempts += 1;
      try {
        await deliver(entry);
        entry.status = "delivered";
        entry.deliveredAt = options.now;
        entry.lastError = undefined;
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
        if (entry.attempts >= entry.maxAttempts) entry.status = "dead";
      }
    }
    this.#write(file);
    return this.status();
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
