import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import { configuredConnectorIds, getConnector } from "./connector.js";
import { connectorCredentialRefFromChannelConfig, resolveConnectorCredential } from "./credentials.js";
import { ConnectorDeliveryQueue, connectorDataDir, type ConnectorQueueStatus } from "./queue.js";
import { resolveConnectorSendPolicy, type ConnectorSendPolicy } from "./approval.js";

/**
 * Connector runtime status (issue #16): the Gateway connector runtime WRITES
 * per-connector state to <dataDir>/connectors/<id>/status.json; doctor/status/
 * CLI READ it from any process. Failures land here instead of crashing the
 * Gateway — that is the visibility contract.
 */
export type ConnectorRuntimeState = "running" | "stopped" | "error" | "never_started";

export type ConnectorRuntimeStatusFile = {
  connectorId: string;
  state: ConnectorRuntimeState;
  lastError?: string;
  startedAt?: string;
  stoppedAt?: string;
  inboundCount?: number;
  /** Inbound messages rejected by the allowlist/pairing policy (fail-closed denials). */
  deniedCount?: number;
  updatedAt?: string;
};

export function connectorStatusPath(connectorId: string, paths?: MindStoneRuntimePaths): string {
  return join(connectorDataDir(connectorId, paths), "status.json");
}

export function writeConnectorRuntimeStatus(status: ConnectorRuntimeStatusFile, paths?: MindStoneRuntimePaths): void {
  const path = connectorStatusPath(status.connectorId, paths);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`);
}

export function readConnectorRuntimeStatus(connectorId: string, paths?: MindStoneRuntimePaths): ConnectorRuntimeStatusFile {
  const path = connectorStatusPath(connectorId, paths);
  if (!existsSync(path)) return { connectorId, state: "never_started" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as ConnectorRuntimeStatusFile).state === "string") {
      return parsed as ConnectorRuntimeStatusFile;
    }
  } catch {
    // unreadable status is itself a status
  }
  return { connectorId, state: "error", lastError: `status file unreadable at ${path}` };
}

export type ConnectorVisibilityStatus = {
  connectorId: string;
  configured: boolean;
  enabled: boolean;
  credential: { configured: boolean; present: boolean; source?: "env" | "file"; error?: string; warning?: string };
  /** Effective send policy (issue #21) — WARNS when an approval-default connector is overridden to auto. */
  sendPolicy?: { effective: ConnectorSendPolicy; overridden: boolean; warning?: string };
  runtime: ConnectorRuntimeStatusFile;
  queue: ConnectorQueueStatus;
};

/** One consolidated, secret-free status row per configured connector. */
export function getConnectorVisibilityStatuses(
  config: MindStoneConfig | undefined,
  options: { env?: NodeJS.ProcessEnv; paths?: MindStoneRuntimePaths } = {},
): ConnectorVisibilityStatus[] {
  const channels = (config?.channels ?? {}) as Record<string, Record<string, unknown>>;
  const enabledIds = new Set(configuredConnectorIds(config));
  return Object.keys(channels)
    .sort()
    .map((connectorId) => {
      const channelConfig = channels[connectorId] ?? {};
      const ref = connectorCredentialRefFromChannelConfig(channelConfig);
      const resolved = ref ? resolveConnectorCredential(ref, options) : undefined;
      const connectorDefault = getConnector(connectorId)?.defaultSendPolicy;
      const effective = resolveConnectorSendPolicy({ connectorDefault, channelConfig });
      return {
        connectorId,
        configured: true,
        enabled: enabledIds.has(connectorId),
        credential: {
          configured: Boolean(ref),
          present: resolved?.present === true,
          source: resolved?.present === true ? resolved.source : undefined,
          error: resolved && !resolved.present ? resolved.error : undefined,
          warning: resolved?.present === true ? resolved.warning : undefined,
        },
        sendPolicy: {
          effective,
          overridden: effective !== (connectorDefault ?? "auto"),
          warning:
            connectorDefault === "approval_required" && effective === "auto"
              ? "sendPolicy OVERRIDDEN to auto — outbound sends WITHOUT approval (explicit config policy)"
              : undefined,
        },
        runtime: readConnectorRuntimeStatus(connectorId, options.paths),
        queue: new ConnectorDeliveryQueue(connectorId, { paths: options.paths }).status(),
      };
    });
}
