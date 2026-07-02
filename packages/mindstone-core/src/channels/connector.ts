import type { MindStoneConfig } from "../config/types.js";
import type { MindStonePrompter } from "../wizard/prompter.js";
import type { TranscriptSource } from "../transcript/index.js";
import type { ChannelCapabilities, ChannelId, ChannelMeta } from "./types.js";

/**
 * Shared channel connector contract (issue #16). Every production connector
 * (Telegram, Slack, Discord, email, …) implements this shape; the loopback
 * reference connector is the first end-to-end implementation and the template.
 *
 * Framework guarantees the contract leans on:
 * - credentials are REFS (env var or isolated secret file), never raw values
 *   in config, and are masked in every status surface (credentials.ts);
 * - access control fails closed (access.ts);
 * - inbound/outbound normalize through canonical session keys and transcript
 *   source metadata (session.ts);
 * - outbound rides a persistent delivery queue with retry + dead-letter
 *   (queue.ts);
 * - listener failures are isolated into runtime status — they never crash the
 *   Gateway (runtime-status.ts + the Gateway connector runtime).
 */

export type ConnectorInboundMessage = {
  /** Connector-native message id (for dedup/acks). */
  messageId?: string;
  text: string;
  senderId?: string;
  senderLabel?: string;
  chatId?: string;
  chatType?: "direct" | "group" | "channel" | "thread";
  threadId?: string;
  /** Whether the agent was explicitly mentioned/addressed (connector-native semantics). */
  mentioned?: boolean;
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export type ConnectorOutboundMessage = {
  text: string;
  chatId?: string;
  threadId?: string;
  /** Correlates a reply to the inbound message that caused it. */
  inReplyToMessageId?: string;
  metadata?: Record<string, unknown>;
};

export type ConnectorContext = {
  config: MindStoneConfig | undefined;
  /** The connector's own section of config.channels[id] (never contains raw secrets). */
  channelConfig: Record<string, unknown>;
  /** Resolved credential value for this run, if the connector declares one. Never persisted. */
  credential?: string;
};

export type ConnectorInboundHandle = {
  stop(): Promise<void> | void;
};

export type ConnectorSetupAdapter = {
  /** Interactive setup: collects token REFS, allowlists, and policy — never raw secrets into config. */
  configure(ctx: { config: MindStoneConfig; prompter: MindStonePrompter }): Promise<{ config: MindStoneConfig; accountId?: string }>;
  disable?(config: MindStoneConfig): MindStoneConfig;
};

export type MindStoneConnector = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  /** Setup wizard adapter. */
  setup?: ConnectorSetupAdapter;
  /**
   * Start the inbound listener. MUST resolve/reject promptly; long-running
   * work happens behind the handle. Errors reject — the Gateway runtime
   * isolates them into runtime status instead of crashing.
   */
  startInbound(ctx: ConnectorContext, onMessage: (message: ConnectorInboundMessage) => Promise<void>): Promise<ConnectorInboundHandle>;
  /** Deliver one outbound message (called by the delivery queue worker; throw to retry). */
  sendOutbound(ctx: ConnectorContext, message: ConnectorOutboundMessage): Promise<void>;
  /** Optional connector-specific health probe for doctor/status. */
  probe?(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }>;
};

/**
 * Canonical transcript source metadata for connector traffic. Thread identity
 * is not a TranscriptSource field — it lives in the session key
 * (connectorSessionKey) and per-entry metadata.
 */
export function connectorTranscriptSource(params: {
  connectorId: ChannelId;
  message: ConnectorInboundMessage;
  accountId?: string;
}): TranscriptSource {
  return {
    substrate: `connector:${params.connectorId}`,
    channel: params.message.chatId ?? params.connectorId,
    chatType: params.message.chatType ?? "direct",
    senderId: params.message.senderId,
    senderName: params.message.senderLabel,
    ...(params.accountId ? { accountId: params.accountId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Registry — connectors register once; the Gateway runtime and catalog read it.
// ---------------------------------------------------------------------------

const REGISTRY = new Map<ChannelId, MindStoneConnector>();

export function registerConnector(connector: MindStoneConnector): void {
  REGISTRY.set(connector.id, connector);
}

export function getConnector(id: ChannelId): MindStoneConnector | undefined {
  return REGISTRY.get(id);
}

export function listConnectors(): MindStoneConnector[] {
  return [...REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Connector ids that are configured (config.channels[id] present and not disabled). */
export function configuredConnectorIds(config: MindStoneConfig | undefined): ChannelId[] {
  const channels = (config?.channels ?? {}) as Record<string, unknown>;
  return Object.keys(channels)
    .filter((id) => {
      const section = channels[id];
      if (!section || typeof section !== "object") return false;
      return (section as Record<string, unknown>).enabled !== false;
    })
    .sort();
}
