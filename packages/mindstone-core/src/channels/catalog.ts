import type { MindStoneConfig } from "../config/types.js";
import type { ChannelCapabilities, ChannelId } from "./types.js";

export type MindStoneChannelKind = "surface" | "gateway_api" | "external_channel" | "external_client";
export type MindStoneChannelImplementationStatus = "available" | "diagnostic" | "planned" | "not_validated" | "not_implemented";

export type MindStoneChannelCatalogEntry = {
  id: ChannelId;
  label: string;
  kind: MindStoneChannelKind;
  status: MindStoneChannelImplementationStatus;
  configured: boolean;
  enabled?: boolean;
  capabilities?: ChannelCapabilities;
  summary: string;
  setup: string;
  notes: string[];
};

export type MindStoneChannelCatalog = {
  configuredChannelKeys: string[];
  entries: MindStoneChannelCatalogEntry[];
};

function configuredChannels(config: MindStoneConfig | undefined): string[] {
  return Object.keys(config?.channels ?? {}).sort();
}

function channelConfigured(config: MindStoneConfig | undefined, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(config?.channels ?? {}, id);
}

export function getMindStoneChannelCatalog(config?: MindStoneConfig): MindStoneChannelCatalog {
  const keys = configuredChannels(config);
  const gateway = config?.gateway;
  const chatCompletionsEnabled = gateway?.http?.chatCompletions?.enabled ?? true;
  const responsesEnabled = gateway?.http?.responses?.enabled ?? false;
  const entries: MindStoneChannelCatalogEntry[] = [
    {
      id: "pi-adapter",
      label: "Pi adapter",
      kind: "surface",
      status: "diagnostic",
      configured: true,
      enabled: true,
      capabilities: { chatTypes: ["direct"], nativeCommands: true },
      summary: "Pi extension control/setup/status surface when loaded by Pi; not a production channel listener.",
      setup: "Install/load the MindStone Pi adapter in the isolated Pi runtime.",
      notes: ["Provides commands/tools/hooks", "Does not own always-on channel loops"],
    },
    {
      id: "native-cli-tui",
      label: "Native CLI/TUI",
      kind: "surface",
      status: "available",
      configured: true,
      enabled: true,
      capabilities: { chatTypes: ["direct"], nativeCommands: true },
      summary: "Local terminal chat and styled TUI over the canonical MindStone session.",
      setup: "Use mindstone chat or mindstone tui.",
      notes: ["MVP interaction surface", "Not a network listener"],
    },
    {
      id: "gateway",
      label: "Gateway",
      kind: "surface",
      status: "available",
      configured: Boolean(gateway),
      enabled: true,
      capabilities: { chatTypes: ["direct", "thread"] },
      summary: "Always-on runtime owner for HTTP APIs, WebChat, and future channel listeners.",
      setup: "Configure gateway host/port/auth, then run mindstone gateway start or install the user service with mindstone gateway install.",
      notes: ["Long-running channel listeners belong here", "Status commands do not start or probe listeners"],
    },
    {
      id: "webchat",
      label: "WebChat",
      kind: "surface",
      status: "available",
      configured: true,
      enabled: true,
      capabilities: { chatTypes: ["direct"] },
      summary: "Gateway-hosted browser shell using MindStone chat/session APIs.",
      setup: "Start Gateway and open /webchat.",
      notes: ["Internal/session surface", "Setup polish and validation remain pending"],
    },
    {
      id: "openai-chat-completions",
      label: "OpenAI-compatible chat completions",
      kind: "gateway_api",
      status: "available",
      configured: true,
      enabled: chatCompletionsEnabled,
      capabilities: { chatTypes: ["direct"] },
      summary: "Gateway /v1/chat/completions compatibility surface.",
      setup: "Enable gateway.http.chatCompletions and use Gateway auth as configured.",
      notes: ["Can be used by compatible clients", "Not a deliverable outbound channel by itself"],
    },
    {
      id: "openresponses",
      label: "OpenResponses HTTP",
      kind: "gateway_api",
      status: "available",
      configured: true,
      enabled: responsesEnabled,
      capabilities: { chatTypes: ["direct"] },
      summary: "Gateway /v1/responses-compatible non-streaming compatibility surface.",
      setup: "Enable gateway.http.responses and use Gateway auth as configured.",
      notes: ["Non-streaming request/response path is smoke-validated", "Full OpenResponses parity and streaming remain pending"],
    },
    {
      id: "openwebui",
      label: "OpenWebUI",
      kind: "external_client",
      status: "not_validated",
      configured: false,
      enabled: false,
      capabilities: { chatTypes: ["direct"] },
      summary: "Expected to connect through the OpenAI-compatible Gateway surface.",
      setup: "Validate against Gateway /v1/chat/completions after API surface is intentionally configured.",
      notes: ["Not validated yet", "No listener owned by MindStone-Agent"],
    },
    {
      id: "telegram",
      label: "Telegram",
      kind: "external_channel",
      status: "available",
      configured: channelConfigured(config, "telegram"),
      enabled: channelConfigured(config, "telegram"),
      capabilities: { chatTypes: ["direct", "group", "thread"], media: true, nativeCommands: true },
      summary: "Gateway-owned Telegram Bot API connector (long-polling) on the shared connector framework.",
      setup: "Configure channels.telegram with a token REF (tokenEnv/tokenFile) + allowedSenders; the Gateway starts the listener. Live validation steps in docs/operations/LIVE_UAT_RUNBOOK.md.",
      notes: ["Access fails closed (empty allowlist = nobody)", "Outbound rides the delivery queue (retry + dead-letter)", "Live-Telegram validation pending (smoke uses a local stub Bot API)"],
    },
    {
      id: "discord",
      label: "Discord",
      kind: "external_channel",
      status: "not_implemented",
      configured: channelConfigured(config, "discord"),
      enabled: false,
      capabilities: { chatTypes: ["direct", "group", "channel", "thread"], reactions: true, media: true, nativeCommands: true },
      summary: "Planned Gateway-owned Discord channel plugin.",
      setup: "Future setup should collect token source, guild/channel allowlists, mention/thread behavior, and permission scope.",
      notes: ["Not implemented/validated in MindStone-Agent yet"],
    },
    {
      id: "slack",
      label: "Slack",
      kind: "external_channel",
      status: "available",
      configured: channelConfigured(config, "slack"),
      enabled: channelConfigured(config, "slack"),
      capabilities: { chatTypes: ["direct", "channel", "thread"], nativeCommands: false },
      summary: "Gateway-owned Slack connector via Socket Mode (outbound WebSocket, no public endpoint) on the shared connector framework.",
      setup: "Configure channels.slack with bot + app token REFS (tokenEnv/appTokenEnv) + allowedSenders; the Gateway opens the Socket Mode connection. Live validation steps in docs/operations/LIVE_UAT_RUNBOOK.md.",
      notes: [
        "Access fails closed (empty allowlist = nobody)",
        "DMs via message events; channels via app_mention ONLY (dedup by design — no broad workspace reads)",
        "Outbound rides the delivery queue; channel replies thread on the triggering message",
        "Live-Slack validation pending (smoke uses a local stub Web API + Socket Mode server)",
      ],
    },
    {
      id: "signal",
      label: "Signal",
      kind: "external_channel",
      status: "not_implemented",
      configured: channelConfigured(config, "signal"),
      enabled: false,
      capabilities: { chatTypes: ["direct", "group"], media: true },
      summary: "Planned Gateway-owned Signal channel plugin via signal-cli or local bridge.",
      setup: "Future setup must validate local dependency/bridge availability and account pairing state explicitly.",
      notes: ["Not implemented/validated in MindStone-Agent yet", "Dependency detection must be explicit"],
    },
  ];

  return { configuredChannelKeys: keys, entries };
}

export function formatMindStoneChannelCatalog(config?: MindStoneConfig): string {
  const catalog = getMindStoneChannelCatalog(config);
  const lines = [
    "MindStone channel/surface catalog",
    `Configured channel keys: ${catalog.configuredChannelKeys.length ? catalog.configuredChannelKeys.join(", ") : "none"}`,
    "",
    "Built-in/local surfaces:",
    ...catalog.entries
      .filter((entry) => entry.kind === "surface" || entry.kind === "gateway_api")
      .map((entry) => `- ${entry.label}: ${entry.status}; configured=${entry.configured}; enabled=${entry.enabled ?? "n/a"}; ${entry.summary}`),
    "",
    "External channel plugins / clients:",
    ...catalog.entries
      .filter((entry) => entry.kind === "external_channel" || entry.kind === "external_client")
      .map((entry) => {
        const status = entry.status === "not_implemented" ? "not implemented/validated yet" : entry.status;
        return `- ${entry.label}: ${status}; configured=${entry.configured}; ${entry.summary}`;
      }),
    "",
    "Setup notes:",
    ...catalog.entries.map((entry) => `- ${entry.label}: ${entry.setup}`),
    "",
    "This catalog is diagnostic only. It does not start listeners, probe networks, mutate config, or expose secrets.",
  ];
  return lines.join("\n");
}
