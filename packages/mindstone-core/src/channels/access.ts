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
  /**
   * Sender domains allowed to interact (issue #21 contact/domain trust rules —
   * email-shaped sender ids). A sender whose id ends in `@<domain>` is
   * allowed. Empty/missing grants nothing; there is no "*" form (allowing all
   * domains is allowedSenders: ["*"], an explicit opt-in).
   */
  allowedSenderDomains?: string[];
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
    allowedSenderDomains: list(record.allowedSenderDomains),
  };
}

function senderDomainAllowed(policy: ConnectorAccessPolicy, sender: string | undefined): boolean {
  if (!sender || !policy.allowedSenderDomains?.length) return false;
  const at = sender.lastIndexOf("@");
  if (at < 0) return false;
  const domain = sender.slice(at + 1).toLowerCase();
  if (!domain) return false;
  return policy.allowedSenderDomains.some((allowed) => allowed.toLowerCase() === domain);
}

export function evaluateConnectorAccess(policy: ConnectorAccessPolicy, message: ConnectorInboundMessage): ConnectorAccessDecision {
  const sender = message.senderId?.trim();
  const chat = message.chatId?.trim();

  const senderAllowed =
    (sender && policy.pairedSenders?.includes(sender)) ||
    policy.allowedSenders?.includes("*") ||
    (sender ? policy.allowedSenders?.includes(sender) : false) ||
    senderDomainAllowed(policy, sender);
  if (!senderAllowed) {
    return { allowed: false, reason: sender ? `sender ${sender} is not allowlisted, paired, or domain-trusted` : "message has no senderId; access fails closed" };
  }

  if (policy.allowedChats?.length) {
    const chatAllowed = policy.allowedChats.includes("*") || (chat ? policy.allowedChats.includes(chat) : false);
    if (!chatAllowed) {
      return { allowed: false, reason: chat ? `chat ${chat} is not allowlisted` : "message has no chatId but an allowedChats list is configured; access fails closed" };
    }
  }

  return { allowed: true, reason: "sender and chat allowed" };
}
