import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  connectorCredentialRefFromChannelConfig,
  connectorDataDir,
  registerConnector,
  resolveConnectorCredential,
  type ConnectorContext,
  type ConnectorInboundHandle,
  type ConnectorInboundMessage,
  type ConnectorOutboundMessage,
  type ConnectorSetupAdapter,
  type MindStoneConnector,
  type MindStoneConfig,
} from "@mindstone-agent/core";

/**
 * Email connector MVP (issue #21), Gmail-first on the #16 framework via a
 * provider-agnostic MailProvider seam (M365/Graph is the documented second
 * pass — same interface, different transport).
 *
 * The connector is PURE TRANSPORT. The #21 safety posture lives in the
 * framework: `defaultSendPolicy: "approval_required"` means routed replies
 * become durable ProposedActions (drafts) — NOTHING sends without an explicit
 * human approval, which then rides the normal delivery queue into
 * `sendOutbound`. Outbound is REPLY-ONLY by construction: sends are built from
 * the original inbound message (recipient = original sender, threaded), so no
 * compose-to-arbitrary-recipients path exists.
 *
 * Credentials are three REFS (never raw values in config):
 *   - refresh token → tokenEnv/tokenFile (the framework-primary credential)
 *   - OAuth client id → clientIdEnv/clientIdFile
 *   - OAuth client secret → clientSecretEnv/clientSecretFile
 * `apiBaseUrl` and `tokenUrl` are configurable so smokes drive the exact live
 * code path against a local stub.
 */

const DEFAULT_API_BASE = "https://gmail.googleapis.com";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_QUERY = "is:unread newer_than:7d";
const DEFAULT_MAX_BODY_CHARS = 8000;
const SEEN_IDS_CAP = 500;

// ---------------------------------------------------------------------------
// Gmail payload types (the subset the connector reads)
// ---------------------------------------------------------------------------

type GmailHeader = { name: string; value: string };
type GmailBodyPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailBodyPart[];
  headers?: GmailHeader[];
};
export type GmailMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailBodyPart & { headers?: GmailHeader[] };
};
type GmailThread = { id: string; messages?: GmailMessage[] };
type GmailProfile = { emailAddress?: string };

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit smokes)
// ---------------------------------------------------------------------------

export function parseEmailAddress(headerValue: string | undefined): { address?: string; label?: string } {
  if (!headerValue) return {};
  const angled = headerValue.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (angled) {
    const address = angled[2].trim().toLowerCase();
    const label = angled[1]?.trim();
    return { address: address || undefined, label: label || undefined };
  }
  const bare = headerValue.trim();
  return bare.includes("@") ? { address: bare.toLowerCase() } : {};
}

function header(message: GmailMessage, name: string): string | undefined {
  const headers = message.payload?.headers ?? [];
  return headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  } catch {
    return "";
  }
}

/** Best-effort plain-text body: prefer text/plain parts, fall back to the top-level body. */
export function gmailMessageBody(message: GmailMessage, maxBodyChars: number): string {
  const collect = (part: GmailBodyPart | undefined, wanted: string): string[] => {
    if (!part) return [];
    const chunks: string[] = [];
    if ((part.mimeType ?? "").toLowerCase().startsWith(wanted) && part.body?.data) chunks.push(decodeBase64Url(part.body.data));
    for (const child of part.parts ?? []) chunks.push(...collect(child, wanted));
    return chunks;
  };
  const plain = collect(message.payload, "text/plain").join("\n").trim();
  const fallback = plain || (message.payload?.body?.data ? decodeBase64Url(message.payload.body.data).trim() : "") || message.snippet || "";
  return fallback.length > maxBodyChars ? `${fallback.slice(0, maxBodyChars)}\n[truncated]` : fallback;
}

/**
 * Map a Gmail message to the connector inbound shape. The text is the #21
 * envelope: header line + optional thread digest + body. senderId is the bare
 * lower-cased address so allowedSenders/allowedSenderDomains match naturally.
 */
export function gmailMessageToInbound(
  message: GmailMessage,
  options: { maxBodyChars?: number; threadDigest?: string; priorCount?: number } = {},
): ConnectorInboundMessage | undefined {
  const from = parseEmailAddress(header(message, "From"));
  if (!from.address) return undefined; // unattributable mail fails closed at access anyway; skip early
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const subject = header(message, "Subject") ?? "(no subject)";
  const date = header(message, "Date") ?? (message.internalDate ? new Date(Number(message.internalDate)).toISOString() : "unknown");
  const priorCount = options.priorCount ?? 0;
  const body = gmailMessageBody(message, maxBodyChars);
  const digest = options.threadDigest?.trim();
  const envelope = [
    `[email] from: ${from.address} | subject: ${subject} | date: ${date} | thread: ${priorCount} prior message(s)`,
    ...(digest ? [digest] : []),
    "---",
    body,
  ].join("\n");
  return {
    messageId: message.id,
    text: envelope,
    senderId: from.address,
    senderLabel: from.label ?? from.address,
    chatId: message.threadId ?? message.id,
    chatType: "direct",
    threadId: message.threadId,
    timestamp: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : undefined,
    metadata: { subject, sensitiveSource: "email" },
  };
}

/** Build the RFC 2822 reply MIME for a Gmail send (raw, pre-base64url). */
export function buildReplyMime(params: {
  to: string;
  fromLabel?: string;
  subject: string;
  inReplyToRfc822?: string;
  text: string;
}): string {
  const subject = /^re:/i.test(params.subject.trim()) ? params.subject.trim() : `Re: ${params.subject.trim()}`;
  const lines = [
    `To: ${params.to}`,
    `Subject: ${subject}`,
    ...(params.inReplyToRfc822 ? [`In-Reply-To: ${params.inReplyToRfc822}`, `References: ${params.inReplyToRfc822}`] : []),
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
    "",
    params.text,
  ];
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// MailProvider seam + Gmail implementation
// ---------------------------------------------------------------------------

export type MailProvider = {
  profile(): Promise<{ address?: string }>;
  listMessageIds(query: string): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessage>;
  getThread(id: string): Promise<{ messages: GmailMessage[] }>;
  sendReply(params: { rawMime: string; threadId?: string }): Promise<void>;
};

type GmailProviderConfig = {
  apiBaseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export class GmailProvider implements MailProvider {
  readonly #config: GmailProviderConfig;
  #accessToken: string | undefined;
  #accessTokenExpiresAt = 0;

  constructor(config: GmailProviderConfig) {
    this.#config = config;
  }

  async #token(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt - 30_000) return this.#accessToken;
    const response = await fetch(this.#config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        refresh_token: this.#config.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const payload = (await response.json().catch(() => undefined)) as { access_token?: string; expires_in?: number; error?: string } | undefined;
    if (!response.ok || !payload?.access_token) {
      throw new Error(`Gmail token exchange failed: HTTP ${response.status}${payload?.error ? ` — ${payload.error}` : ""}`);
    }
    this.#accessToken = payload.access_token;
    this.#accessTokenExpiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
    return this.#accessToken;
  }

  async #call<T>(path: string, init: { method?: string; body?: string; contentType?: string } = {}): Promise<T> {
    const token = await this.#token();
    const run = async (bearer: string) =>
      fetch(`${this.#config.apiBaseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${bearer}`, ...(init.contentType ? { "Content-Type": init.contentType } : {}) },
        body: init.body,
      });
    let response = await run(token);
    if (response.status === 401) {
      // expired/revoked access token — force one refresh and retry once
      this.#accessToken = undefined;
      response = await run(await this.#token());
    }
    const payload = (await response.json().catch(() => undefined)) as T | { error?: { message?: string } } | undefined;
    if (!response.ok) {
      const detail = (payload as { error?: { message?: string } } | undefined)?.error?.message;
      throw new Error(`Gmail ${init.method ?? "GET"} ${path} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }
    return payload as T;
  }

  async profile(): Promise<{ address?: string }> {
    const profile = await this.#call<GmailProfile>("/gmail/v1/users/me/profile");
    return { address: profile.emailAddress?.toLowerCase() };
  }

  async listMessageIds(query: string): Promise<string[]> {
    const result = await this.#call<{ messages?: Array<{ id: string }> }>(
      `/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=25`,
    );
    return (result.messages ?? []).map((entry) => entry.id);
  }

  async getMessage(id: string): Promise<GmailMessage> {
    return this.#call<GmailMessage>(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
  }

  async getThread(id: string): Promise<{ messages: GmailMessage[] }> {
    const thread = await this.#call<GmailThread>(`/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`);
    return { messages: thread.messages ?? [] };
  }

  async sendReply(params: { rawMime: string; threadId?: string }): Promise<void> {
    const raw = Buffer.from(params.rawMime, "utf-8").toString("base64url");
    await this.#call("/gmail/v1/users/me/messages/send", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ raw, ...(params.threadId ? { threadId: params.threadId } : {}) }),
    });
  }
}

// ---------------------------------------------------------------------------
// Connector wiring
// ---------------------------------------------------------------------------

function resolveExtraCredential(ctx: ConnectorContext, envKey: string, fileKey: string, label: string): string {
  const ref = connectorCredentialRefFromChannelConfig({
    tokenEnv: ctx.channelConfig[envKey],
    tokenFile: ctx.channelConfig[fileKey],
  });
  const resolved = ref ? resolveConnectorCredential(ref) : undefined;
  if (!resolved?.present) {
    throw new Error(`email ${label} unresolved (${envKey}/${fileKey})${resolved && !resolved.present ? `: ${resolved.error}` : ""}`);
  }
  return resolved.value;
}

export function gmailProviderFromContext(ctx: ConnectorContext): GmailProvider {
  if (!ctx.credential) throw new Error("email refresh token is not resolved (configure tokenEnv or tokenFile)");
  const apiBaseUrl = (typeof ctx.channelConfig.apiBaseUrl === "string" && ctx.channelConfig.apiBaseUrl.trim() ? ctx.channelConfig.apiBaseUrl.trim() : DEFAULT_API_BASE).replace(/\/+$/, "");
  const tokenUrl = typeof ctx.channelConfig.tokenUrl === "string" && ctx.channelConfig.tokenUrl.trim() ? ctx.channelConfig.tokenUrl.trim() : DEFAULT_TOKEN_URL;
  return new GmailProvider({
    apiBaseUrl,
    tokenUrl,
    clientId: resolveExtraCredential(ctx, "clientIdEnv", "clientIdFile", "OAuth client id"),
    clientSecret: resolveExtraCredential(ctx, "clientSecretEnv", "clientSecretFile", "OAuth client secret"),
    refreshToken: ctx.credential,
  });
}

type EmailConnectorState = { seenMessageIds: string[] };

function statePath(): string {
  return join(connectorDataDir("email"), "state.json");
}

function readState(): EmailConnectorState {
  const path = statePath();
  if (!existsSync(path)) return { seenMessageIds: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && Array.isArray(parsed.seenMessageIds)) return { seenMessageIds: parsed.seenMessageIds.filter((id: unknown) => typeof id === "string") };
  } catch {
    // corrupt state re-initializes; at-least-once semantics tolerate replays
  }
  return { seenMessageIds: [] };
}

function writeState(state: EmailConnectorState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temp, `${JSON.stringify({ seenMessageIds: state.seenMessageIds.slice(-SEEN_IDS_CAP) }, null, 2)}\n`);
  renameSync(temp, path);
}

/** Thread digest for the envelope: prior messages' snippets, oldest→newest. */
export function threadDigestFromMessages(messages: GmailMessage[], currentId: string, maxChars = 1200): { digest?: string; priorCount: number } {
  const prior = messages.filter((entry) => entry.id !== currentId);
  if (!prior.length) return { priorCount: 0 };
  const lines = prior.map((entry) => {
    const from = parseEmailAddress(header(entry, "From")).address ?? "unknown";
    return `> [${from}] ${entry.snippet ?? ""}`.trim();
  });
  let digest = lines.join("\n");
  if (digest.length > maxChars) digest = `${digest.slice(0, maxChars)}\n> [digest truncated]`;
  return { digest, priorCount: prior.length };
}

const EMAIL_SETUP: ConnectorSetupAdapter = {
  async configure({ config, prompter }) {
    const refreshRef = await prompter.text({
      message: "Environment variable holding the Gmail OAuth REFRESH token (refs only — the token itself never enters config)",
      placeholder: "MINDSTONE_GMAIL_REFRESH_TOKEN",
    });
    const clientIdRef = await prompter.text({
      message: "Environment variable holding the OAuth client id",
      placeholder: "MINDSTONE_GMAIL_CLIENT_ID",
    });
    const clientSecretRef = await prompter.text({
      message: "Environment variable holding the OAuth client secret",
      placeholder: "MINDSTONE_GMAIL_CLIENT_SECRET",
    });
    const allow = await prompter.text({
      message: "Allowed sender addresses (comma-separated; empty = nobody, access fails closed)",
      placeholder: "clint@example.com",
    });
    const allowDomains = await prompter.text({
      message: "Allowed sender DOMAINS (comma-separated; empty = none)",
      placeholder: "example.com",
    });
    const query = await prompter.text({
      message: `Mailbox read scope as a Gmail query (default: ${DEFAULT_QUERY})`,
      placeholder: DEFAULT_QUERY,
    });
    const csv = (value: unknown): string[] =>
      String(value ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    channels.email = {
      enabled: true,
      tokenEnv: String(refreshRef).trim(),
      clientIdEnv: String(clientIdRef).trim(),
      clientSecretEnv: String(clientSecretRef).trim(),
      allowedSenders: csv(allow),
      allowedSenderDomains: csv(allowDomains),
      ...(String(query ?? "").trim() ? { query: String(query).trim() } : {}),
      // sendPolicy intentionally NOT written: the connector default is
      // approval_required; auto-send must be a deliberate manual config act.
    };
    return { config: { ...config, channels } as MindStoneConfig };
  },
  disable(config) {
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    const section = channels.email;
    channels.email = { ...(typeof section === "object" && section !== null ? section : {}), enabled: false };
    return { ...config, channels } as MindStoneConfig;
  },
};

export const EMAIL_CONNECTOR: MindStoneConnector = {
  id: "email",
  meta: {
    id: "email",
    label: "Email (Gmail)",
    blurb: "Gateway-owned Gmail connector: scoped mailbox poll in, approval-gated replies out, on the shared connector framework.",
  },
  capabilities: { chatTypes: ["direct", "thread"] },
  defaultSendPolicy: "approval_required",
  setup: EMAIL_SETUP,

  async startInbound(ctx, onMessage): Promise<ConnectorInboundHandle> {
    // Validate credentials up front — a bad ref/token fails VISIBLY at startup
    // (error state in runtime status), not silently in the poll loop.
    const provider = gmailProviderFromContext(ctx);
    const profile = await provider.profile();
    const selfAddress = profile.address;

    const pollMs = typeof ctx.channelConfig.pollIntervalMs === "number" && ctx.channelConfig.pollIntervalMs > 0 ? ctx.channelConfig.pollIntervalMs : DEFAULT_POLL_MS;
    const query = typeof ctx.channelConfig.query === "string" && ctx.channelConfig.query.trim() ? ctx.channelConfig.query.trim() : DEFAULT_QUERY;
    const maxBodyChars = typeof ctx.channelConfig.maxBodyChars === "number" && ctx.channelConfig.maxBodyChars > 0 ? ctx.channelConfig.maxBodyChars : DEFAULT_MAX_BODY_CHARS;

    const state = readState();
    const seen = new Set(state.seenMessageIds);
    let stopped = false;
    let polling = false;

    const poll = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const ids = await provider.listMessageIds(query);
        for (const id of ids) {
          if (stopped || seen.has(id)) continue;
          const message = await provider.getMessage(id);
          const from = parseEmailAddress(header(message, "From"));
          if (selfAddress && from.address === selfAddress) {
            // never react to our own sent mail (self-loop guard)
            seen.add(id);
            continue;
          }
          let digest: { digest?: string; priorCount: number } = { priorCount: 0 };
          if (message.threadId) {
            try {
              const thread = await provider.getThread(message.threadId);
              digest = threadDigestFromMessages(thread.messages, message.id);
            } catch {
              // thread digest is best-effort context, never a delivery blocker
            }
          }
          const inbound = gmailMessageToInbound(message, { maxBodyChars, threadDigest: digest.digest, priorCount: digest.priorCount });
          if (inbound) await onMessage(inbound);
          seen.add(id); // marked AFTER handling — at-least-once, never silent-drop
          writeState({ seenMessageIds: [...seen] });
        }
      } catch {
        // transient poll errors retry on the next tick; persistent inbound
        // handler errors are recorded by the runtime's onMessage wrapper
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, pollMs);
    timer.unref?.();

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  },

  async sendOutbound(ctx, message: ConnectorOutboundMessage): Promise<void> {
    // REPLY-ONLY: the send is reconstructed from the original inbound message
    // (recipient = its sender, subject = Re: its subject, threaded into its
    // Gmail thread). There is no path to arbitrary recipients.
    if (!message.inReplyToMessageId) throw new Error("email outbound is reply-only: inReplyToMessageId is required");
    const provider = gmailProviderFromContext(ctx);
    const original = await provider.getMessage(message.inReplyToMessageId);
    const from = parseEmailAddress(header(original, "From"));
    if (!from.address) throw new Error(`email reply target unresolved: original message ${message.inReplyToMessageId} has no From address`);
    const mime = buildReplyMime({
      to: from.address,
      subject: header(original, "Subject") ?? "(no subject)",
      inReplyToRfc822: header(original, "Message-ID"),
      text: message.text,
    });
    await provider.sendReply({ rawMime: mime, threadId: original.threadId ?? message.chatId });
  },

  async probe(ctx) {
    try {
      const provider = gmailProviderFromContext(ctx);
      const profile = await provider.profile();
      return { ok: true, detail: `mailbox ${profile.address ?? "(unknown)"}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};

registerConnector(EMAIL_CONNECTOR);
