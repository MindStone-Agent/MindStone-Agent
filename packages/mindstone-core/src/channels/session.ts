import type { MindStoneConfig } from "../config/types.js";
import { resolveConfiguredSessionKey, resolveSessionKey } from "../routing/session.js";
import type { ConnectorInboundMessage } from "./connector.js";

/**
 * True only for a direct message from a sender the connector could vouch for
 * (#61). Group, channel and thread turns, a missing or unrecognised chat type,
 * and an unverified sender are all not the owner: fails closed.
 */
export function isOwnerDirectMessage(message: ConnectorInboundMessage): boolean {
  const chatType = typeof message.chatType === "string" ? message.chatType.trim().toLowerCase() : "";
  return chatType === "direct" && message.senderVerified !== false;
}

/**
 * Thread/session mapping (issue #16): connector-native identity feeds the
 * standard session-key discipline — session.mode "single" collapses to the
 * canonical continuity session; "per_surface" keys by connector/chatType and
 * prefers threadId over senderId, so threads keep their own lineage.
 *
 * Only the owner's direct messages may collapse into the canonical session
 * (#61). Every other turn gets its own per-surface key in either mode, so it
 * never reads the owner's DM history.
 */
export function connectorSessionKey(params: {
  config: MindStoneConfig | undefined;
  connectorId: string;
  agentId?: string;
  message: ConnectorInboundMessage;
}): string {
  const agentId = params.agentId ?? params.config?.routing?.defaultAgentId ?? "default";
  const input = {
    agentId,
    substrate: `connector:${params.connectorId}`,
    channel: params.message.chatId ?? params.connectorId,
    chatType: isOwnerDirectMessage(params.message)
      ? "direct"
      : params.message.chatType === "direct"
        ? "unverified"
        : params.message.chatType ?? "unknown",
    senderId: params.message.senderId,
    threadId: params.message.threadId,
  };
  return isOwnerDirectMessage(params.message)
    ? resolveConfiguredSessionKey(params.config, input)
    : resolveSessionKey(input);
}

/**
 * Mention/trigger behavior (issue #16): DMs always reply; group/channel/thread
 * traffic replies only when mentioned or when the message carries the
 * configured trigger prefix — unless the policy explicitly opts into replying
 * to everything (respondWithoutMention).
 */
export type ConnectorTriggerPolicy = {
  /** Reply to group/channel messages even without a mention/prefix. Default false. */
  respondWithoutMention?: boolean;
  /** Message prefix that always triggers a reply, e.g. "!ms". */
  triggerPrefix?: string;
};

export function connectorTriggerPolicyFromChannelConfig(channelConfig: Record<string, unknown> | undefined): ConnectorTriggerPolicy {
  const record = (channelConfig ?? {}) as Record<string, unknown>;
  return {
    respondWithoutMention: record.respondWithoutMention === true,
    triggerPrefix: typeof record.triggerPrefix === "string" && record.triggerPrefix.trim() ? record.triggerPrefix.trim() : undefined,
  };
}

export type ConnectorTriggerDecision = {
  respond: boolean;
  reason: string;
  /** Message text with a matched trigger prefix stripped. */
  text: string;
};

export function shouldTriggerConnectorReply(policy: ConnectorTriggerPolicy, message: ConnectorInboundMessage): ConnectorTriggerDecision {
  const text = message.text ?? "";
  // A missing chat type is unknown, not direct: it needs a mention too (#61).
  const chatType = message.chatType ?? "unknown";
  if (policy.triggerPrefix && text.trimStart().startsWith(policy.triggerPrefix)) {
    return { respond: true, reason: `trigger prefix ${policy.triggerPrefix}`, text: text.trimStart().slice(policy.triggerPrefix.length).trimStart() };
  }
  if (chatType === "direct") {
    return { respond: true, reason: "direct message", text };
  }
  if (message.mentioned) {
    return { respond: true, reason: "mentioned", text };
  }
  if (policy.respondWithoutMention) {
    return { respond: true, reason: "respondWithoutMention enabled", text };
  }
  return { respond: false, reason: `${chatType} message without mention or trigger prefix`, text };
}
