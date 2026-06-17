import type { MindStoneConfig } from "../config/index.js";
import type { MindStoneHandoffReplay } from "../routing/run.js";

export type PostCompactMaintenanceInput = {
  sessionKey: string;
  agentId: string;
  handoffReplay: MindStoneHandoffReplay;
  config?: MindStoneConfig;
  runId?: string;
};

export type PostCompactMaintenanceResult = {
  event: "post_compact_maintenance";
  archive: "pending" | "completed" | "skipped";
  backfill: "pending" | "completed" | "skipped";
  dreamCycle: "pending_policy" | "completed" | "skipped";
  durableMemoryWritten: false;
  trigger: "handoff_replayed";
  reason: string;
  handoff: {
    path: string;
    sha256: string;
    updatedAt?: string;
  };
  details?: Record<string, unknown>;
};

export function planPostCompactMaintenance(input: PostCompactMaintenanceInput): PostCompactMaintenanceResult {
  return {
    event: "post_compact_maintenance",
    archive: "pending",
    backfill: "skipped",
    dreamCycle: "pending_policy",
    durableMemoryWritten: false,
    trigger: "handoff_replayed",
    reason: "post_compact_maintenance_policy_not_enabled",
    handoff: {
      path: input.handoffReplay.path,
      sha256: input.handoffReplay.sha256,
      updatedAt: input.handoffReplay.updatedAt,
    },
    details: {
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      runId: input.runId,
      memoryVectorStore: input.config?.memory?.vectorStore,
      note: "Scaffold only: no transcript archive, SQLite backfill, embedding backfill, journal, or durable memory write was performed automatically.",
    },
  };
}
