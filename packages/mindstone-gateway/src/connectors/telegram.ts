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
 * Telegram connector MVP (issue #17), built on the #16 framework: credential
 * REFS, fail-closed allowlists, trigger policy, canonical session mapping,
 * delivery queue, and status/doctor visibility all come from the framework —
 * this module is the Bot API transport.
 *
 * Inbound: long-polling getUpdates (no public endpoint needed; webhook mode is
 * future scope). Outbound: sendMessage via the delivery queue (throwing sends
 * retry, then dead-letter). `apiBaseUrl` is configurable so smokes run against
 * a local stub server — the same execution path as live Telegram.
 */

const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_POLL_MS = 1500;

type TelegramUser = { id: number; username?: string; first_name?: string; is_bot?: boolean };
type TelegramChat = { id: number; type: "private" | "group" | "supergroup" | "channel" };
type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  entities?: Array<{ type: string; offset: number; length: number }>;
  reply_to_message?: { from?: TelegramUser };
  photo?: unknown[];
  document?: unknown;
  voice?: unknown;
  video?: unknown;
  audio?: unknown;
  sticker?: unknown;
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage };

function apiBase(ctx: ConnectorContext): string {
  const configured = typeof ctx.channelConfig.apiBaseUrl === "string" && ctx.channelConfig.apiBaseUrl.trim() ? ctx.channelConfig.apiBaseUrl.trim() : DEFAULT_API_BASE;
  return configured.replace(/\/+$/, "");
}

async function callTelegram<T>(ctx: ConnectorContext, method: string, body?: Record<string, unknown>): Promise<T> {
  if (!ctx.credential) throw new Error("Telegram bot token is not resolved (configure tokenEnv or tokenFile)");
  const response = await fetch(`${apiBase(ctx)}/bot${ctx.credential}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json().catch(() => undefined)) as { ok?: boolean; result?: T; description?: string } | undefined;
  if (!response.ok || !payload?.ok) {
    throw new Error(`Telegram ${method} failed: HTTP ${response.status}${payload?.description ? ` — ${payload.description}` : ""}`);
  }
  return payload.result as T;
}

function mediaKind(message: TelegramMessage): string | undefined {
  if (message.photo) return "photo";
  if (message.document) return "document";
  if (message.voice) return "voice";
  if (message.video) return "video";
  if (message.audio) return "audio";
  if (message.sticker) return "sticker";
  return undefined;
}

function isBotMentioned(message: TelegramMessage, botUsername: string | undefined, botId: number | undefined): boolean {
  if (message.reply_to_message?.from?.id !== undefined && message.reply_to_message.from.id === botId) return true;
  if (!botUsername) return false;
  const text = message.text ?? message.caption ?? "";
  for (const entity of message.entities ?? []) {
    if (entity.type !== "mention") continue;
    const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (mention === `@${botUsername.toLowerCase()}`) return true;
  }
  return false;
}

export function telegramUpdateToInbound(update: TelegramUpdate, bot: { id?: number; username?: string }): ConnectorInboundMessage | undefined {
  const message = update.message;
  if (!message || !message.chat) return undefined;
  if (message.from?.is_bot) return undefined; // never react to bots (including ourselves)
  const media = mediaKind(message);
  const text = message.text ?? message.caption ?? (media ? `[${media}]` : "");
  if (!text) return undefined;
  const chatType = message.chat.type === "private" ? "direct" : message.chat.type === "channel" ? "channel" : "group";
  return {
    messageId: String(message.message_id),
    text,
    senderId: message.from ? String(message.from.id) : undefined,
    senderLabel: message.from?.username ?? message.from?.first_name,
    chatId: String(message.chat.id),
    chatType: message.is_topic_message && message.message_thread_id !== undefined ? "thread" : chatType,
    threadId: message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined,
    mentioned: isBotMentioned(message, bot.username, bot.id),
    timestamp: message.date ? new Date(message.date * 1000).toISOString() : undefined,
    metadata: media ? { media } : undefined,
  };
}

const TELEGRAM_SETUP: ConnectorSetupAdapter = {
  async configure({ config, prompter }) {
    const mode = await prompter.select({
      message: "Telegram bot token source (the token itself never enters config)",
      options: [
        { value: "env", label: "Environment variable (tokenEnv)" },
        { value: "file", label: "Isolated secret file (tokenFile, chmod 600)" },
      ],
    });
    const ref = await prompter.text({
      message: mode === "env" ? "Environment variable name holding the bot token" : "Secret file path (relative paths resolve under the runtime data dir)",
      placeholder: mode === "env" ? "MINDSTONE_TELEGRAM_TOKEN" : "secrets/telegram.token",
    });
    const allow = await prompter.text({
      message: "Allowed Telegram sender ids (comma-separated numeric ids; empty = nobody, access fails closed)",
      placeholder: "123456789",
    });
    const allowedSenders = String(allow ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    channels.telegram = {
      enabled: true,
      ...(mode === "env" ? { tokenEnv: String(ref).trim() } : { tokenFile: String(ref).trim() }),
      allowedSenders,
    };
    return { config: { ...config, channels } as MindStoneConfig };
  },
  disable(config) {
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    const section = channels.telegram;
    channels.telegram = { ...(typeof section === "object" && section !== null ? section : {}), enabled: false };
    return { ...config, channels } as MindStoneConfig;
  },
};

export const TELEGRAM_CONNECTOR: MindStoneConnector = {
  id: "telegram",
  meta: {
    id: "telegram",
    label: "Telegram",
    blurb: "Gateway-owned Telegram Bot API connector (long-polling) on the shared connector framework.",
  },
  capabilities: { chatTypes: ["direct", "group", "thread"], media: true, nativeCommands: true },
  setup: TELEGRAM_SETUP,

  async startInbound(ctx, onMessage): Promise<ConnectorInboundHandle> {
    // Validate the token up front — a bad token fails VISIBLY at startup
    // (error state in runtime status), not silently in the poll loop.
    const me = await callTelegram<TelegramUser>(ctx, "getMe");
    const bot = { id: me.id, username: me.username };
    const pollMs = typeof ctx.channelConfig.pollIntervalMs === "number" && ctx.channelConfig.pollIntervalMs > 0 ? ctx.channelConfig.pollIntervalMs : DEFAULT_POLL_MS;

    let offset = 0;
    let stopped = false;
    let polling = false;

    const poll = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const updates = await callTelegram<TelegramUpdate[]>(ctx, "getUpdates", { offset, timeout: 0 });
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          const inbound = telegramUpdateToInbound(update, bot);
          if (inbound) await onMessage(inbound);
        }
      } catch {
        // transient poll errors retry on the next tick; persistent inbound
        // handler errors are recorded by the runtime's onMessage wrapper
      } finally {
        polling = false;
      }
    };

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
    if (!message.chatId) throw new Error("Telegram outbound requires chatId");
    await callTelegram(ctx, "sendMessage", {
      chat_id: Number.isNaN(Number(message.chatId)) ? message.chatId : Number(message.chatId),
      text: message.text,
      ...(message.threadId ? { message_thread_id: Number(message.threadId) } : {}),
      ...(message.inReplyToMessageId ? { reply_to_message_id: Number(message.inReplyToMessageId) } : {}),
    });
  },

  async probe(ctx) {
    try {
      const me = await callTelegram<TelegramUser>(ctx, "getMe");
      return { ok: true, detail: `bot @${me.username ?? me.id}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};

registerConnector(TELEGRAM_CONNECTOR);
