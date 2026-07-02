import type { ConnectorInboundMessage } from "./connector.js";

/**
 * Connector access control (issue #16): allowlist/pairing policy evaluated on
 * every inbound message. FAILS CLOSED — no policy section means nothing is
 * allowed except explicitly paired senders.
 */
export type ConnectorAccessPolicy = {
  /** Sender ids allowed to interact. "*" allows all senders (explicit opt-in). */
  allowedSenders?: string[];
  /** Chat/channel ids the connector may serve. "*" allows all chats. */
  allowedChats?: string[];
  /** Paired sender ids (populated by an explicit pairing/approval step). */
  pairedSenders?: string[];
};

export type ConnectorAccessDecision = {
  allowed: boolean;
  reason: string;
};

export function connectorAccessPolicyFromChannelConfig(channelConfig: Record<string, unknown> | undefined): ConnectorAccessPolicy {
  const record = (channelConfig ?? {}) as Record<string, unknown>;
  const list = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : undefined;
  return {
    allowedSenders: list(record.allowedSenders),
    allowedChats: list(record.allowedChats),
    pairedSenders: list(record.pairedSenders),
  };
}

export function evaluateConnectorAccess(policy: ConnectorAccessPolicy, message: ConnectorInboundMessage): ConnectorAccessDecision {
  const sender = message.senderId?.trim();
  const chat = message.chatId?.trim();

  const senderAllowed =
    (sender && policy.pairedSenders?.includes(sender)) ||
    policy.allowedSenders?.includes("*") ||
    (sender ? policy.allowedSenders?.includes(sender) : false);
  if (!senderAllowed) {
    return { allowed: false, reason: sender ? `sender ${sender} is not allowlisted or paired` : "message has no senderId; access fails closed" };
  }

  if (policy.allowedChats?.length) {
    const chatAllowed = policy.allowedChats.includes("*") || (chat ? policy.allowedChats.includes(chat) : false);
    if (!chatAllowed) {
      return { allowed: false, reason: chat ? `chat ${chat} is not allowlisted` : "message has no chatId but an allowedChats list is configured; access fails closed" };
    }
  }

  return { allowed: true, reason: "sender and chat allowed" };
}
