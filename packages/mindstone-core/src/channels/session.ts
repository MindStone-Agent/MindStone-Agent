import type { MindStoneConfig } from "../config/types.js";
import { resolveConfiguredSessionKey } from "../routing/session.js";
import type { ConnectorInboundMessage } from "./connector.js";

/**
 * Thread/session mapping (issue #16): connector-native identity feeds the
 * standard session-key discipline — session.mode "single" collapses to the
 * canonical continuity session; "per_surface" keys by connector/chatType and
 * prefers threadId over senderId, so threads keep their own lineage.
 */
export function connectorSessionKey(params: {
  config: MindStoneConfig | undefined;
  connectorId: string;
  agentId?: string;
  message: ConnectorInboundMessage;
}): string {
  const agentId = params.agentId ?? params.config?.routing?.defaultAgentId ?? "default";
  return resolveConfiguredSessionKey(params.config, {
    agentId,
    substrate: `connector:${params.connectorId}`,
    channel: params.message.chatId ?? params.connectorId,
    chatType: params.message.chatType ?? "direct",
    senderId: params.message.senderId,
    threadId: params.message.threadId,
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
  const chatType = message.chatType ?? "direct";
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
