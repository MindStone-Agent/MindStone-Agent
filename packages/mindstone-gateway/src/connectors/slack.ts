import {
  connectorCredentialRefFromChannelConfig,
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
 * Slack connector MVP (issue #18) on the shared connector framework.
 *
 * **Socket Mode over Events API (the ticket's decision point):** Events API
 * requires a public HTTPS endpoint, which contradicts MindStone's local-first
 * Gateway; Socket Mode is an OUTBOUND WebSocket (apps.connections.open → wss)
 * — no inbound exposure, correct for gateway-owned listeners.
 *
 * Two tokens, both REFS (never raw values in config):
 *   - bot token (xoxb-…)  → `tokenEnv`/`tokenFile`      → Web API (auth.test, chat.postMessage)
 *   - app token (xapp-…)  → `appTokenEnv`/`appTokenFile` → Socket Mode (apps.connections.open)
 *
 * Event policy (dedup by design): DMs arrive as `message` events with
 * channel_type "im"; channel traffic is handled via `app_mention` ONLY —
 * Slack sends both `message` and `app_mention` for a mention, and processing
 * both would double-reply. Consequence: channel messages without a mention
 * are never processed (which also satisfies "no broad workspace access").
 */

const DEFAULT_API_BASE = "https://slack.com/api";
const DEFAULT_RECONNECT_MS = 3000;

type SlackEvent = {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
};

function apiBase(ctx: ConnectorContext): string {
  const configured = typeof ctx.channelConfig.apiBaseUrl === "string" && ctx.channelConfig.apiBaseUrl.trim() ? ctx.channelConfig.apiBaseUrl.trim() : DEFAULT_API_BASE;
  return configured.replace(/\/+$/, "");
}

async function callSlack<T extends { ok?: boolean; error?: string }>(ctx: ConnectorContext, token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase(ctx)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json().catch(() => undefined)) as T | undefined;
  if (!response.ok || !payload?.ok) {
    throw new Error(`Slack ${method} failed: HTTP ${response.status}${payload?.error ? ` — ${payload.error}` : ""}`);
  }
  return payload;
}

function resolveAppToken(ctx: ConnectorContext): string {
  const ref = connectorCredentialRefFromChannelConfig({
    tokenEnv: ctx.channelConfig.appTokenEnv,
    tokenFile: ctx.channelConfig.appTokenFile,
  } as Record<string, unknown>);
  const resolved = resolveConnectorCredential(ref);
  if (!resolved.present) {
    throw new Error(`Slack app-level token unresolved (appTokenEnv/appTokenFile): ${!resolved.present ? resolved.error : ""}`);
  }
  return resolved.value;
}

export function slackEventToInbound(event: SlackEvent, botUserId: string | undefined): ConnectorInboundMessage | undefined {
  if (event.bot_id || (botUserId && event.user === botUserId)) return undefined; // never react to bots/self
  if (event.subtype) return undefined; // edits, joins, etc. are out of MVP scope

  if (event.type === "app_mention") {
    if (!event.text || !event.channel || !event.ts) return undefined;
    const text = botUserId ? event.text.replaceAll(`<@${botUserId}>`, "").trim() : event.text;
    return {
      messageId: event.ts,
      text: text || event.text,
      senderId: event.user,
      chatId: event.channel,
      chatType: "channel",
      threadId: event.thread_ts,
      mentioned: true,
    };
  }

  if (event.type === "message" && event.channel_type === "im") {
    if (!event.text || !event.channel || !event.ts) return undefined;
    return {
      messageId: event.ts,
      text: event.text,
      senderId: event.user,
      chatId: event.channel,
      chatType: "direct",
      threadId: event.thread_ts,
      mentioned: false,
    };
  }

  return undefined;
}

const SLACK_SETUP: ConnectorSetupAdapter = {
  async configure({ config, prompter }) {
    const botRef = await prompter.text({
      message: "Environment variable holding the BOT token (xoxb-…) — the token itself never enters config",
      placeholder: "MINDSTONE_SLACK_BOT_TOKEN",
    });
    const appRef = await prompter.text({
      message: "Environment variable holding the APP-LEVEL token (xapp-…, Socket Mode)",
      placeholder: "MINDSTONE_SLACK_APP_TOKEN",
    });
    const allow = await prompter.text({
      message: "Allowed Slack member ids (comma-separated, e.g. U012ABC; empty = nobody, access fails closed)",
      placeholder: "U012ABCDEF",
    });
    const allowedSenders = String(allow ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    channels.slack = {
      enabled: true,
      tokenEnv: String(botRef).trim(),
      appTokenEnv: String(appRef).trim(),
      allowedSenders,
    };
    return { config: { ...config, channels } as MindStoneConfig };
  },
  disable(config) {
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    const section = channels.slack;
    channels.slack = { ...(typeof section === "object" && section !== null ? section : {}), enabled: false };
    return { ...config, channels } as MindStoneConfig;
  },
};

export const SLACK_CONNECTOR: MindStoneConnector = {
  id: "slack",
  meta: {
    id: "slack",
    label: "Slack",
    blurb: "Gateway-owned Slack connector via Socket Mode (outbound WebSocket; no public endpoint) on the shared connector framework.",
  },
  capabilities: { chatTypes: ["direct", "channel", "thread"], media: false, nativeCommands: false },
  setup: SLACK_SETUP,

  async startInbound(ctx, onMessage): Promise<ConnectorInboundHandle> {
    if (!ctx.credential) throw new Error("Slack bot token is not resolved (configure tokenEnv or tokenFile)");
    const botToken = ctx.credential;
    const appToken = resolveAppToken(ctx);

    // Validate the bot token up front — bad tokens fail VISIBLY at startup.
    const identity = await callSlack<{ ok: boolean; user_id?: string }>(ctx, botToken, "auth.test");
    const botUserId = identity.user_id;
    const reconnectMs = typeof ctx.channelConfig.reconnectMs === "number" && ctx.channelConfig.reconnectMs > 0 ? ctx.channelConfig.reconnectMs : DEFAULT_RECONNECT_MS;

    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (stopped) return;
      const opened = await callSlack<{ ok: boolean; url?: string }>(ctx, appToken, "apps.connections.open");
      if (!opened.url) throw new Error("Slack apps.connections.open returned no URL");
      const ws = new WebSocket(opened.url);
      socket = ws;

      ws.onmessage = (raw) => {
        void (async () => {
          let envelope: { envelope_id?: string; type?: string; payload?: { event?: SlackEvent } };
          try {
            envelope = JSON.parse(String(raw.data));
          } catch {
            return;
          }
          // Socket Mode requires prompt acks or Slack redelivers.
          if (envelope.envelope_id) {
            try {
              ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            } catch {
              // ack failures surface as redeliveries; nothing to crash over
            }
          }
          if (envelope.type === "disconnect") {
            try {
              ws.close();
            } catch {
              // already closing
            }
            return;
          }
          const event = envelope.payload?.event;
          if (!event) return;
          const inbound = slackEventToInbound(event, botUserId);
          if (inbound) await onMessage(inbound);
        })();
      };

      ws.onclose = () => {
        if (stopped) return;
        reconnectTimer = setTimeout(() => {
          void connect().catch(() => {
            // reconnect failures retry on the next close/timer cycle
            reconnectTimer = setTimeout(() => void connect().catch(() => undefined), reconnectMs);
          });
        }, reconnectMs);
        reconnectTimer.unref?.();
      };
      ws.onerror = () => {
        // onclose handles the reconnect path
      };

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        const failTimer = setTimeout(() => reject(new Error("Slack Socket Mode connection timed out")), 10_000);
        ws.addEventListener("open", () => clearTimeout(failTimer), { once: true });
        ws.addEventListener("error", () => {
          clearTimeout(failTimer);
          reject(new Error("Slack Socket Mode connection failed"));
        }, { once: true });
      });
    };

    await connect();

    return {
      stop: () => {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        try {
          socket?.close();
        } catch {
          // already closed
        }
      },
    };
  },

  async sendOutbound(ctx, message: ConnectorOutboundMessage): Promise<void> {
    if (!ctx.credential) throw new Error("Slack bot token is not resolved");
    if (!message.chatId) throw new Error("Slack outbound requires chatId (channel)");
    // Reply in-thread: an existing thread wins; otherwise channel replies root a
    // thread on the triggering message (polite default); DMs stay flat.
    const threadTs = message.threadId ?? (message.metadata?.chatType === "direct" ? undefined : message.inReplyToMessageId);
    await callSlack(ctx, ctx.credential, "chat.postMessage", {
      channel: message.chatId,
      text: message.text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  },

  async probe(ctx) {
    try {
      if (!ctx.credential) throw new Error("bot token unresolved");
      const identity = await callSlack<{ ok: boolean; user?: string; user_id?: string }>(ctx, ctx.credential, "auth.test");
      return { ok: true, detail: `bot ${identity.user ?? identity.user_id}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};

registerConnector(SLACK_CONNECTOR);
