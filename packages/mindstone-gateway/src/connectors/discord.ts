import {
  registerConnector,
  type ConnectorContext,
  type ConnectorInboundHandle,
  type ConnectorInboundMessage,
  type ConnectorOutboundMessage,
  type ConnectorSetupAdapter,
  type MindStoneConnector,
  type MindStoneConfig,
} from "@mindstone-agent/core";

/**
 * Discord connector MVP (issue #19) on the shared connector framework.
 *
 * Discord REQUIRES its Gateway WebSocket to receive messages (REST cannot),
 * so inbound implements the gateway protocol: GET /gateway/bot → wss, op 10
 * hello → op 2 identify → READY → MESSAGE_CREATE dispatches, with op 1
 * heartbeats on the interval hello specifies (op 11 acks expected).
 *
 * **Permissions are explicit and least-privilege by default:** the identify
 * intents are exactly what the MVP consumes — GUILD_MESSAGES + DIRECT_MESSAGES
 * + MESSAGE_CONTENT — nothing else (no members, presences, moderation, voice).
 *
 * Access is layered: `allowedGuilds` filters at the connector before anything
 * is processed; the framework's fail-closed `allowedSenders`/`allowedChats`
 * then applies. Outbound rides the delivery queue via
 * POST /channels/:id/messages with a message_reference reply.
 *
 * MVP boundary: native thread-channels are treated as regular channels
 * (MESSAGE_CREATE doesn't carry thread metadata without extra REST lookups);
 * reply chains map to thread lineage via message_reference.
 */

const DEFAULT_API_BASE = "https://discord.com/api/v10";
const DEFAULT_RECONNECT_MS = 3000;

/** GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15) — nothing else. */
export const DISCORD_LEAST_PRIVILEGE_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

type DiscordUser = { id: string; username?: string; bot?: boolean };
type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: DiscordUser;
  content?: string;
  timestamp?: string;
  mentions?: DiscordUser[];
  message_reference?: { message_id?: string };
  attachments?: Array<{ filename?: string; content_type?: string }>;
};

function apiBase(ctx: ConnectorContext): string {
  const configured = typeof ctx.channelConfig.apiBaseUrl === "string" && ctx.channelConfig.apiBaseUrl.trim() ? ctx.channelConfig.apiBaseUrl.trim() : DEFAULT_API_BASE;
  return configured.replace(/\/+$/, "");
}

async function callDiscord<T>(ctx: ConnectorContext, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  if (!ctx.credential) throw new Error("Discord bot token is not resolved (configure tokenEnv or tokenFile)");
  const response = await fetch(`${apiBase(ctx)}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bot ${ctx.credential}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json().catch(() => undefined)) as (T & { message?: string }) | undefined;
  if (!response.ok) {
    throw new Error(`Discord ${method} ${path} failed: HTTP ${response.status}${payload?.message ? ` — ${payload.message}` : ""}`);
  }
  return payload as T;
}

function allowedGuilds(ctx: ConnectorContext): string[] | undefined {
  const value = ctx.channelConfig.allowedGuilds;
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function discordMessageToInbound(message: DiscordMessage, botUserId: string | undefined, guildAllowlist?: string[]): ConnectorInboundMessage | undefined {
  if (message.author?.bot) return undefined; // never react to bots
  if (botUserId && message.author?.id === botUserId) return undefined; // never react to our own messages (even if unflagged)
  if (message.guild_id && guildAllowlist && !guildAllowlist.includes("*") && !guildAllowlist.includes(message.guild_id)) {
    return undefined; // guild not allowlisted — dropped before any processing
  }
  const attachment = message.attachments?.[0];
  const text = message.content?.trim() || (attachment ? `[${attachment.content_type?.split("/")[0] ?? "attachment"}: ${attachment.filename ?? "file"}]` : "");
  if (!text) return undefined;
  const mentioned = Boolean(botUserId && message.mentions?.some((user) => user.id === botUserId));
  const cleaned = botUserId ? text.replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "").trim() : text;
  return {
    messageId: message.id,
    text: cleaned || text,
    senderId: message.author?.id,
    senderLabel: message.author?.username,
    chatId: message.channel_id,
    chatType: message.guild_id ? "channel" : "direct",
    threadId: message.message_reference?.message_id,
    mentioned,
    timestamp: message.timestamp,
    metadata: {
      ...(message.guild_id ? { guildId: message.guild_id } : {}),
      ...(attachment ? { media: attachment.content_type?.split("/")[0] ?? "attachment" } : {}),
    },
  };
}

const DISCORD_SETUP: ConnectorSetupAdapter = {
  async configure({ config, prompter }) {
    const tokenRef = await prompter.text({
      message: "Environment variable holding the Discord bot token — the token itself never enters config",
      placeholder: "MINDSTONE_DISCORD_TOKEN",
    });
    const guilds = await prompter.text({
      message: "Allowed guild ids (comma-separated; empty = DMs only)",
      placeholder: "123456789012345678",
    });
    const allow = await prompter.text({
      message: "Allowed Discord user ids (comma-separated; empty = nobody, access fails closed)",
      placeholder: "234567890123456789",
    });
    const list = (value: unknown): string[] =>
      String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    channels.discord = {
      enabled: true,
      tokenEnv: String(tokenRef).trim(),
      allowedGuilds: list(guilds),
      allowedSenders: list(allow),
    };
    return { config: { ...config, channels } as MindStoneConfig };
  },
  disable(config) {
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    const section = channels.discord;
    channels.discord = { ...(typeof section === "object" && section !== null ? section : {}), enabled: false };
    return { ...config, channels } as MindStoneConfig;
  },
};

export const DISCORD_CONNECTOR: MindStoneConnector = {
  id: "discord",
  meta: {
    id: "discord",
    label: "Discord",
    blurb: "Gateway-owned Discord connector (Gateway WebSocket, least-privilege intents) on the shared connector framework.",
  },
  capabilities: { chatTypes: ["direct", "channel"], media: true, nativeCommands: false },
  setup: DISCORD_SETUP,

  async startInbound(ctx, onMessage): Promise<ConnectorInboundHandle> {
    // Validate the token up front — bad tokens fail VISIBLY at startup.
    const me = await callDiscord<DiscordUser>(ctx, "GET", "/users/@me");
    const botUserId = me.id;
    const gateway = await callDiscord<{ url?: string }>(ctx, "GET", "/gateway/bot");
    if (!gateway.url) throw new Error("Discord /gateway/bot returned no URL");
    const guildAllowlist = allowedGuilds(ctx);
    const reconnectMs = typeof ctx.channelConfig.reconnectMs === "number" && ctx.channelConfig.reconnectMs > 0 ? ctx.channelConfig.reconnectMs : DEFAULT_RECONNECT_MS;

    let stopped = false;
    let socket: WebSocket | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let sequence: number | null = null;

    const cleanupSocketTimers = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };

    const connect = async (): Promise<void> => {
      if (stopped) return;
      const ws = new WebSocket(gateway.url!.startsWith("ws") ? gateway.url! : `wss://${gateway.url}`);
      socket = ws;

      ws.onmessage = (raw) => {
        void (async () => {
          let frame: { op?: number; t?: string; s?: number | null; d?: unknown };
          try {
            frame = JSON.parse(String(raw.data));
          } catch {
            return;
          }
          if (typeof frame.s === "number") sequence = frame.s;

          if (frame.op === 10) {
            // hello → identify with EXPLICIT least-privilege intents, then heartbeat.
            const interval = (frame.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 30_000;
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: ctx.credential,
                  intents: DISCORD_LEAST_PRIVILEGE_INTENTS,
                  properties: { os: process.platform, browser: "mindstone-agent", device: "mindstone-agent" },
                },
              }),
            );
            cleanupSocketTimers();
            heartbeatTimer = setInterval(() => {
              try {
                ws.send(JSON.stringify({ op: 1, d: sequence }));
              } catch {
                // socket closing; reconnect path handles it
              }
            }, interval);
            heartbeatTimer.unref?.();
            return;
          }
          if (frame.op === 0 && frame.t === "MESSAGE_CREATE") {
            const inbound = discordMessageToInbound(frame.d as DiscordMessage, botUserId, guildAllowlist);
            if (inbound) await onMessage(inbound);
          }
        })();
      };

      ws.onclose = () => {
        cleanupSocketTimers();
        if (stopped) return;
        reconnectTimer = setTimeout(() => {
          void connect().catch(() => {
            reconnectTimer = setTimeout(() => void connect().catch(() => undefined), reconnectMs);
          });
        }, reconnectMs);
        reconnectTimer.unref?.();
      };
      ws.onerror = () => {
        // onclose handles reconnects
      };

      await new Promise<void>((resolve, reject) => {
        const failTimer = setTimeout(() => reject(new Error("Discord gateway connection timed out")), 10_000);
        ws.addEventListener("open", () => {
          clearTimeout(failTimer);
          resolve();
        }, { once: true });
        ws.addEventListener("error", () => {
          clearTimeout(failTimer);
          reject(new Error("Discord gateway connection failed"));
        }, { once: true });
      });
    };

    await connect();

    return {
      stop: () => {
        stopped = true;
        cleanupSocketTimers();
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
    if (!message.chatId) throw new Error("Discord outbound requires chatId (channel id)");
    await callDiscord(ctx, "POST", `/channels/${message.chatId}/messages`, {
      content: message.text,
      ...(message.inReplyToMessageId ? { message_reference: { message_id: message.inReplyToMessageId } } : {}),
    });
  },

  async probe(ctx) {
    try {
      const me = await callDiscord<DiscordUser>(ctx, "GET", "/users/@me");
      return { ok: true, detail: `bot ${me.username ?? me.id}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};

registerConnector(DISCORD_CONNECTOR);
