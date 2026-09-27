import type { MindStoneConfig } from "../config/types.js";
import { resolveConfiguredSessionKey, resolveSessionKey } from "../routing/session.js";
import type { ConnectorInboundMessage } from "./connector.js";

/** Lower-cased, trimmed chat type, or undefined when absent (#61). One normalizer for every check. */
export function normalizeConnectorChatType(chatType: unknown): string | undefined {
  const value = typeof chatType === "string" ? chatType.trim().toLowerCase() : "";
  return value || undefined;
}

/**
 * The owner's sender ids on one connector: `channels.<id>.ownerSenders`
 * (#61). Exact ids, compared trimmed and case-insensitively. "*" and domain
 * rules never make anyone the owner; an empty or missing list means nobody is.
 */
export function connectorOwnerSenders(config: MindStoneConfig | undefined, connectorId: string): string[] {
  const section = (config?.channels as Record<string, unknown> | undefined)?.[connectorId];
  const list = section && typeof section === "object" ? (section as Record<string, unknown>).ownerSenders : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "" && value !== "*");
}

/**
 * True only for a direct message from one of the owner's own sender ids, sent
 * by a sender the connector could vouch for (#61). Being allowed to talk to
 * the agent (allowedSenders, pairing, domains) is not being the owner. Group,
 * channel and thread turns, a missing or unrecognised chat type, an
 * unverified sender and any sender not in ownerSenders are not the owner.
 */
export function isOwnerDirectMessage(message: ConnectorInboundMessage, ownerSenders: readonly string[]): boolean {
  const sender = typeof message.senderId === "string" ? message.senderId.trim().toLowerCase() : "";
  return (
    normalizeConnectorChatType(message.chatType) === "direct" &&
    message.senderVerified !== false &&
    sender !== "" &&
    ownerSenders.includes(sender)
  );
}

/** isOwnerDirectMessage with the connector's configured owner list. */
export function isConnectorOwnerMessage(params: {
  config: MindStoneConfig | undefined;
  connectorId: string;
  message: ConnectorInboundMessage;
}): boolean {
  return isOwnerDirectMessage(params.message, connectorOwnerSenders(params.config, params.connectorId));
}

/**
 * Thread/session mapping (issue #16): connector-native identity feeds the
 * standard session-key discipline — session.mode "single" collapses to the
 * canonical continuity session; "per_surface" keys by connector/chatType and
 * prefers threadId over senderId, so threads keep their own lineage.
 *
 * Only the owner's direct messages may collapse into the canonical session
 * (#61). Every other turn gets its own per-surface key in either mode, keyed
 * by connector as well as chat so two connectors can't share one, and never
 * reads the owner's DM history.
 */
export function connectorSessionKey(params: {
  config: MindStoneConfig | undefined;
  connectorId: string;
  agentId?: string;
  message: ConnectorInboundMessage;
}): string {
  const agentId = params.agentId ?? params.config?.routing?.defaultAgentId ?? "default";
  const chatType = normalizeConnectorChatType(params.message.chatType);
  const input = {
    agentId,
    substrate: `connector:${params.connectorId}`,
    channel: params.message.chatId ?? params.connectorId,
    chatType: chatType ?? "unknown",
    senderId: params.message.senderId,
    threadId: params.message.threadId,
  };
  if (isConnectorOwnerMessage(params)) return resolveConfiguredSessionKey(params.config, input);
  return resolveSessionKey({
    ...input,
    channel: `${params.connectorId}:${input.channel}`,
    chatType: chatType === "direct" ? "nonowner-direct" : input.chatType,
  });
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
  const chatType = normalizeConnectorChatType(message.chatType) ?? "unknown";
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
