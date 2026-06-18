import {
  appendTranscriptEntry,
  createLocalMemoryRecallProvider,
  createMemoryEmbeddingProvider,
  discoverFileMemoryDocuments,
  getSqliteMemoryIndexStats,
  listTranscriptSessions,
  loadMindStoneConfig,
  loadMindStoneIdentity,
  resolveConfigPath,
  runMindStoneConfigWizard,
  runtimePathsFromEnv,
  sqliteMemoryDatabasePath,
  SqliteMemoryRecallProvider,
  transcriptPathForSession,
  type MemoryDocument,
  type MemoryHit,
  type MemoryRecallProvider,
  type MindStonePrompter,
  type MindStoneSelectOption,
} from "@mindstone-agent/core";

type PiNotifyKind = "info" | "warning" | "error";

type PiCommandContext = {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, kind?: PiNotifyKind): void;
  };
};

type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type PiToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<PiToolResult> | PiToolResult;
};

type PiSessionShutdownEvent = {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
};

type PiExtensionApi = {
  on(event: "session_shutdown", handler: (event: PiSessionShutdownEvent, ctx: unknown) => Promise<void> | void): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: PiCommandContext): Promise<void> | void;
    },
  ): void;
  registerTool(tool: PiToolDefinition): void;
};

function formatOption<T extends string>(option: MindStoneSelectOption<T>): string {
  return option.hint ? `${option.label} — ${option.hint}` : option.label;
}

const EMPTY_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const MEMORY_SEARCH_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Memory search query." },
    limit: { type: "number", description: "Maximum hits to return. Defaults to 5; maximum 20." },
  },
  required: ["query"],
  additionalProperties: false,
};

const MEMORY_READ_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Memory document id, title, absolute path, or runtime-relative path." },
  },
  required: ["id"],
  additionalProperties: false,
};

const TRANSCRIPT_STATUS_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    sessionKey: { type: "string", description: "Optional MindStone session key. Defaults to configured default session." },
  },
  additionalProperties: false,
};

function textToolResult(text: string, details?: Record<string, unknown>): PiToolResult {
  return { content: [{ type: "text", text }], details };
}

function parseRecallSearchArgs(args: string): { query: string; limit: number } {
  const parts = args.trim().split(/\s+/g).filter(Boolean);
  const queryParts: string[] = [];
  let limit = 5;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if ((part === "--limit" || part === "-n") && parts[i + 1]) {
      const parsed = Number.parseInt(parts[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, 20);
      i += 1;
      continue;
    }
    queryParts.push(part);
  }
  return { query: queryParts.join(" ").trim(), limit };
}

function truncateSnippet(text: string, maxChars = 360): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatMemoryHit(hit: MemoryHit, index: number): string {
  const title = hit.title ?? hit.path ?? hit.id;
  const providerScore = typeof hit.metadata?.providerScore === "number" ? ` provider=${hit.metadata.providerScore.toFixed(3)}` : "";
  const recallMode = typeof hit.metadata?.recallMode === "string" ? ` mode=${hit.metadata.recallMode}` : "";
  return [
    `${index + 1}. ${title}`,
    `   score=${hit.score.toFixed(3)}${providerScore}${recallMode}`,
    `   ${truncateSnippet(hit.text)}`,
  ].join("\n");
}

function resolveLimit(value: unknown, fallback = 5): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 20) : fallback;
}

function loadedRuntimeConfig() {
  const paths = runtimePathsFromEnv();
  const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
  if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
  return { paths, loaded };
}

function runtimeIsolationMessage(): string {
  const paths = runtimePathsFromEnv();
  return [
    "MindStone-Agent runtime isolation",
    `Pi agent dir: ${paths.piAgentDir}`,
    `Pi session dir: ${paths.piSessionDir}`,
    `Data dir: ${paths.dataDir}`,
  ].join("\n");
}

function gatewayStatusMessage(): string {
  const { loaded } = loadedRuntimeConfig();
  const gateway = loaded.config?.gateway;
  const host = gateway?.host ?? "127.0.0.1";
  const port = gateway?.port ?? 19789;
  return [
    "MindStone Gateway status",
    `Config: ${loaded.path}`,
    `Endpoint: http://${host}:${port}`,
    `Auth mode: ${gateway?.auth?.mode ?? "none"}`,
    `OpenAI chat completions: ${gateway?.http?.chatCompletions?.enabled ?? true}`,
    `OpenResponses: ${gateway?.http?.responses?.enabled ?? false}`,
    "Live probe: not run by this command",
    "Secret values are intentionally not displayed.",
  ].join("\n");
}

function channelStatusMessage(): string {
  const { loaded } = loadedRuntimeConfig();
  const config = loaded.config;
  const gateway = config?.gateway;
  const host = gateway?.host ?? "127.0.0.1";
  const port = gateway?.port ?? 19789;
  const configuredChannels = Object.keys(config?.channels ?? {}).sort();
  return [
    "MindStone channel/surface status",
    `Config: ${loaded.path}`,
    `Configured channel keys: ${configuredChannels.length ? configuredChannels.join(", ") : "none"}`,
    `Default session policy: ${config?.session?.mode ?? "single"}`,
    `Default session key: ${config?.session?.defaultSessionKey ?? "agent:default:main"}`,
    "",
    "Built-in/local surfaces:",
    `- Pi adapter: active extension/control surface when loaded by Pi; not a production listener`,
    `- Native CLI/TUI: available through scripts/mindstone chat|tui`,
    `- Gateway endpoint: http://${host}:${port}`,
    `- WebChat shell: /webchat (Gateway-hosted; setup polish pending)`,
    `- OpenAI-compatible HTTP: /v1/chat/completions enabled=${gateway?.http?.chatCompletions?.enabled ?? true}`,
    `- OpenResponses HTTP: /v1/responses enabled=${gateway?.http?.responses?.enabled ?? false}`,
    "",
    "External channel plugins:",
    "- Telegram: not implemented/validated in MindStone-Agent yet",
    "- OpenWebUI: not validated yet; expected to use OpenAI-compatible Gateway surface",
    "- Signal/Discord/Slack: conceptually planned from MindStone lineage; not implemented here yet",
    "",
    "This command is diagnostic only. It does not start listeners, probe networks, mutate config, or expose secrets.",
  ].join("\n");
}

function defaultAgentAndSession() {
  const { loaded } = loadedRuntimeConfig();
  const config = loaded.config;
  const agentId = config?.routing?.defaultAgentId ?? "default";
  const sessionKey = config?.session?.defaultSessionKey ?? "agent:default:main";
  return { loaded, config, agentId, sessionKey };
}

function mindstoneContextMessage(): string {
  const { paths, loaded } = loadedRuntimeConfig();
  const config = loaded.config;
  const agentId = config?.routing?.defaultAgentId ?? "default";
  const agent = config?.agents?.[agentId];
  const identity = agent ? loadMindStoneIdentity(agentId, agent, loaded.path) : undefined;
  return [
    "MindStone context status",
    `Config: ${loaded.path}`,
    `Runtime data dir: ${paths.dataDir}`,
    `Default agent: ${agentId}`,
    `Routing mode: ${config?.routing?.mode ?? "placeholder"}`,
    `Default model: ${config?.routing?.defaultModel ?? agent?.defaultModel ?? "not configured"}`,
    `Default session: ${config?.session?.defaultSessionKey ?? "agent:default:main"}`,
    `Identity path: ${identity?.identityPath ?? "not configured"}`,
    `Identity exists: ${identity?.identityExists ?? false}`,
    `User path: ${identity?.userPath ?? "not configured"}`,
    `User exists: ${identity?.userExists ?? false}`,
    `Memory autoRecall: ${config?.memory?.autoRecall ?? false}`,
    `Memory vector store: ${config?.memory?.vectorStore ?? "memory"}`,
    `Context mode: ${config?.contextManagement?.mode ?? "sliding_window"}`,
    identity?.error ? `Identity error: ${identity.error}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function transcriptStatusMessage(sessionKeyInput?: unknown): { text: string; details: Record<string, unknown> } {
  const paths = runtimePathsFromEnv();
  const { sessionKey: defaultSessionKey } = defaultAgentAndSession();
  const sessionKey = typeof sessionKeyInput === "string" && sessionKeyInput.trim() ? sessionKeyInput.trim() : defaultSessionKey;
  const sessions = listTranscriptSessions({ paths });
  const current = sessions.find((session) => session.sessionKey === sessionKey);
  const transcriptPath = transcriptPathForSession(sessionKey, { paths });
  const text = [
    "MindStone transcript status",
    `Session: ${sessionKey}`,
    `Path: ${transcriptPath}`,
    `Exists: ${Boolean(current)}`,
    `Entries: ${current?.entries ?? 0}`,
    `Bytes: ${current?.bytes ?? 0}`,
    current?.updatedAt ? `Updated: ${current.updatedAt}` : undefined,
    `Known sessions: ${sessions.length}`,
    "Transcript status is diagnostic only. This command does not prune, compact, or rewrite transcript history.",
  ].filter((line): line is string => Boolean(line)).join("\n");
  return {
    text,
    details: {
      sessionKey,
      path: transcriptPath,
      exists: Boolean(current),
      entries: current?.entries ?? 0,
      bytes: current?.bytes ?? 0,
      updatedAt: current?.updatedAt,
      sessions: sessions.length,
    },
  };
}

function recordPiAdapterShutdown(event: PiSessionShutdownEvent): void {
  const { agentId, sessionKey } = defaultAgentAndSession();
  appendTranscriptEntry({
    sessionKey,
    agentId,
    role: "event",
    text: `Pi adapter session shutdown observed: ${event.reason}.`,
    source: {
      substrate: "pi-adapter",
      channel: "pi",
      chatType: "internal",
      senderId: "extension",
    },
    metadata: {
      event: "pi_adapter_session_shutdown",
      reason: event.reason,
      targetSessionFile: event.targetSessionFile,
      archiveScope: "lifecycle_marker_only",
      note: "Conservative first-pass archive hook; raw Pi transcript/message archival is not implemented here.",
    },
  });
}

function memoryStatusMessage(): { text: string; details: Record<string, unknown> } {
  const paths = runtimePathsFromEnv();
  const stats = getSqliteMemoryIndexStats(paths);
  const text = [
    "MindStone memory status",
    `Database: ${stats.databasePath}`,
    `Present: ${stats.present}`,
    `Sources: ${stats.sources}`,
    `Chunks: ${stats.chunks}`,
    `Embedded chunks: ${stats.embeddedChunks}`,
    `Duplicate text chunks: ${stats.duplicateTextChunks}`,
    `Vector backend: ${stats.vectorBackend}`,
    `sqlite-vec available: ${stats.sqliteVec.available}`,
    stats.sqliteVec.version ? `sqlite-vec version: ${stats.sqliteVec.version}` : undefined,
    stats.sqliteVec.error ? `sqlite-vec note: ${stats.sqliteVec.error}` : undefined,
    stats.updatedAt ? `Updated: ${stats.updatedAt}` : undefined,
    stats.error ? `Error: ${stats.error}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
  return { text, details: { ...stats, sqliteVec: stats.sqliteVec } };
}

function memoryStatusText(): string {
  return memoryStatusMessage().text;
}

function discoverReadableMemoryDocuments(): MemoryDocument[] {
  const { paths, loaded } = loadedRuntimeConfig();
  return discoverFileMemoryDocuments({ config: loaded.config, paths });
}

function documentMatchesId(document: MemoryDocument, id: string): boolean {
  const normalized = id.trim();
  if (!normalized) return false;
  const relativePath = typeof document.metadata?.relativePath === "string" ? document.metadata.relativePath : undefined;
  return [document.id, document.path, relativePath, document.title]
    .filter((value): value is string => Boolean(value))
    .some((value) => value === normalized || value.endsWith(`/${normalized}`));
}

function memoryReadMessage(id: string): { text: string; details: Record<string, unknown> } {
  const documents = discoverReadableMemoryDocuments();
  const document = documents.find((candidate) => documentMatchesId(candidate, id));
  if (!document) {
    return {
      text: `No MindStone memory document matched '${id}'. Search memory first, then read by id or runtime-relative path.`,
      details: { found: false, id, documents: documents.length },
    };
  }
  const relativePath = typeof document.metadata?.relativePath === "string" ? document.metadata.relativePath : undefined;
  return {
    text: [
      `MindStone memory document: ${document.title ?? document.id}`,
      `ID: ${document.id}`,
      relativePath ? `Path: ${relativePath}` : document.path ? `Path: ${document.path}` : undefined,
      `Kind: ${document.kind}`,
      "",
      document.text.trim(),
    ].filter((line): line is string => Boolean(line)).join("\n"),
    details: {
      found: true,
      id: document.id,
      title: document.title,
      path: document.path,
      relativePath,
      kind: document.kind,
      chars: document.text.length,
    },
  };
}

async function memorySearchMessage(query: string, limit: number): Promise<{ text: string; details: Record<string, unknown> }> {
  const provider = resolveMemoryRecallProvider();
  if (!provider) {
    return {
      text: "No MindStone memory provider is available. Run memory backfill or add memory files first.",
      details: { query, hits: 0, provider: undefined },
    };
  }
  const hits = await provider.search({ text: query, limit });
  return {
    text: [
      `MindStone recall search: ${query}`,
      `Provider: ${provider.id}`,
      `Hits: ${hits.length}`,
      "",
      ...hits.map(formatMemoryHit),
    ].join("\n"),
    details: {
      query,
      provider: provider.id,
      hits: hits.length,
      hitIds: hits.map((hit) => hit.chunkId),
    },
  };
}

function resolveMemoryRecallProvider(): MemoryRecallProvider | undefined {
  const { paths, loaded } = loadedRuntimeConfig();
  const stats = getSqliteMemoryIndexStats(paths);
  if (stats.present && stats.chunks > 0) {
    return new SqliteMemoryRecallProvider({
      databasePath: sqliteMemoryDatabasePath(paths),
      embeddingProvider: createMemoryEmbeddingProvider(loaded.config),
    });
  }
  return createLocalMemoryRecallProvider(discoverFileMemoryDocuments({ config: loaded.config, paths }));
}

function piPrompter(ctx: PiCommandContext): MindStonePrompter {
  return {
    intro: async (title) => ctx.ui.notify(title, "info"),
    outro: async (message) => ctx.ui.notify(message, "info"),
    note: async (message, title) => ctx.ui.notify(title ? `${title}\n${message}` : message, "info"),
    confirm: async ({ message }) => ctx.ui.confirm("MindStone", message),
    select: async <T extends string>({ message, options, initialValue }: {
      message: string;
      options: Array<MindStoneSelectOption<T>>;
      initialValue?: T;
    }): Promise<T> => {
      const labels = options.map(formatOption);
      const selected = await ctx.ui.select(message, labels);
      if (!selected) {
        if (initialValue) return initialValue;
        throw new Error("Selection cancelled");
      }
      const index = labels.indexOf(selected);
      if (index < 0) throw new Error(`Unknown selection: ${selected}`);
      return options[index].value;
    },
    text: async ({ message, placeholder, initialValue, validate }) => {
      const value = await ctx.ui.input(message, placeholder ?? initialValue);
      const resolved = value ?? initialValue ?? "";
      const issue = validate?.(resolved);
      if (issue) throw new Error(issue);
      return resolved;
    },
  };
}

async function runConfigWizardCommand(ctx: PiCommandContext): Promise<void> {
  try {
    const result = await runMindStoneConfigWizard(piPrompter(ctx));
    ctx.ui.notify(
      [
        result.wrote ? "MindStone-Agent config updated." : "MindStone-Agent config unchanged.",
        `Path: ${result.path}`,
        `Changed sections: ${result.changedSections.length ? result.changedSections.join(", ") : "none"}`,
      ].join("\n"),
      "info",
    );
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

export default function mindstoneAgentPiAdapter(pi: PiExtensionApi): void {
  pi.on("session_shutdown", async (event) => {
    recordPiAdapterShutdown(event);
  });

  pi.registerTool({
    name: "mindstone_memory_status",
    label: "MindStone Memory Status",
    description: "Show read-only MindStone-Agent memory index and recall backend status for the isolated runtime.",
    promptSnippet: "Inspect MindStone-Agent memory index and recall backend status",
    promptGuidelines: ["Use mindstone_memory_status before memory search when recall/index health is uncertain."],
    parameters: EMPTY_PARAMETERS_SCHEMA,
    execute: async () => {
      const { text, details } = memoryStatusMessage();
      return textToolResult(text, details);
    },
  });

  pi.registerTool({
    name: "mindstone_memory_search",
    label: "MindStone Memory Search",
    description: "Search MindStone-Agent memory from the isolated runtime. This is read-only and does not mutate memory files or indexes.",
    promptSnippet: "Search MindStone-Agent structured memory, journals, LOG, transcripts, or SQLite memory index",
    promptGuidelines: ["Use mindstone_memory_search when prior MindStone context may help answer the current request."],
    parameters: MEMORY_SEARCH_PARAMETERS_SCHEMA,
    execute: async (_toolCallId, params) => {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) return textToolResult("query is required", { error: "missing_query" });
      const { text, details } = await memorySearchMessage(query, resolveLimit(params.limit));
      return textToolResult(text, details);
    },
  });

  pi.registerTool({
    name: "mindstone_memory_read",
    label: "MindStone Memory Read",
    description: "Read a discovered MindStone-Agent memory document by id, title, absolute path, or runtime-relative path. Does not read arbitrary filesystem paths.",
    promptSnippet: "Read a discovered MindStone-Agent memory document by id or runtime-relative path",
    promptGuidelines: ["Use mindstone_memory_read after mindstone_memory_search when more exact memory detail is needed."],
    parameters: MEMORY_READ_PARAMETERS_SCHEMA,
    execute: async (_toolCallId, params) => {
      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (!id) return textToolResult("id is required", { error: "missing_id" });
      const { text, details } = memoryReadMessage(id);
      return textToolResult(text, details);
    },
  });

  pi.registerTool({
    name: "mindstone_transcript_status",
    label: "MindStone Transcript Status",
    description: "Show read-only MindStone transcript status for the configured/default session.",
    promptSnippet: "Inspect MindStone transcript file status for a session",
    promptGuidelines: ["Use mindstone_transcript_status to check transcript continuity without mutating transcript history."],
    parameters: TRANSCRIPT_STATUS_PARAMETERS_SCHEMA,
    execute: async (_toolCallId, params) => {
      const { text, details } = transcriptStatusMessage(params.sessionKey);
      return textToolResult(text, details);
    },
  });

  pi.registerCommand("mindstone-agent-status", {
    description: "Show MindStone-Agent isolated runtime status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(runtimeIsolationMessage(), "info");
    },
  });

  pi.registerCommand("mindstone-status", {
    description: "Show MindStone-Agent isolated runtime status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(runtimeIsolationMessage(), "info");
    },
  });

  pi.registerCommand("mindstone-context", {
    description: "Show read-only MindStone-Agent context/config/identity status",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(mindstoneContextMessage(), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("mindstone-gateway-status", {
    description: "Show configured MindStone Gateway endpoint/auth status without probing live network state",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(gatewayStatusMessage(), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("mindstone-channels", {
    description: "Show configured MindStone channel/surface status without starting listeners",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(channelStatusMessage(), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("mindstone-transcript-status", {
    description: "Show read-only MindStone transcript status for the configured/default session",
    handler: async (args, ctx) => {
      try {
        const sessionKey = args.trim() || undefined;
        ctx.ui.notify(transcriptStatusMessage(sessionKey).text, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("mindstone-recall-status", {
    description: "Show MindStone-Agent memory/recall index status",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(memoryStatusText(), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("mindstone-recall-search", {
    description: "Search MindStone-Agent memory from the isolated runtime",
    handler: async (args, ctx) => {
      try {
        const { query, limit } = parseRecallSearchArgs(args);
        if (!query) {
          ctx.ui.notify("Usage: /mindstone-recall-search <query> [--limit N]", "warning");
          return;
        }
        const { text, details } = await memorySearchMessage(query, limit);
        ctx.ui.notify(text, typeof details.hits === "number" && details.hits > 0 ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("mindstone-config", {
    description: "Configure MindStone-Agent runtime settings",
    handler: async (_args, ctx) => runConfigWizardCommand(ctx),
  });

  pi.registerCommand("mindstone-setup", {
    description: "Run MindStone-Agent setup/configuration flow",
    handler: async (_args, ctx) => runConfigWizardCommand(ctx),
  });
}
