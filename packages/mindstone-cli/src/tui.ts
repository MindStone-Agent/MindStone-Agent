import {
  loadMindStoneConfig,
  resolveConfigPath,
  resolveConfiguredSessionKey,
  listTranscriptSessions,
  readTranscriptEntries,
  resolveMindStoneChatModel,
  runMindStoneChatTurn,
  runtimePathsFromEnv,
  type AgentRunner,
  type AgentRunStreamEvent,
  type MindStoneModelInfo,
  type TranscriptEntry,
} from "@mindstone-agent/core";
import { MockMindStoneProvider, PiMindStoneProvider, PiSessionAgentRunner, PiSessionMindStoneProvider } from "@mindstone-agent/gateway";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  truncateToWidth,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
} from "../../../vendor/pi/packages/tui/dist/index.js";

const reset = "\x1b[0m";
const ansi = (code: string) => (text: string) => `${code}${text}${reset}`;
const gold = ansi("\x1b[38;5;214m");
const amber = ansi("\x1b[38;5;222m");
const muted = ansi("\x1b[38;5;244m");
const dim = ansi("\x1b[2m");
const red = ansi("\x1b[38;5;203m");
const green = ansi("\x1b[38;5;114m");
const bold = ansi("\x1b[1m");

const selectListTheme: SelectListTheme = {
  selectedPrefix: gold,
  selectedText: (text) => bold(gold(text)),
  description: muted,
  scrollInfo: dim,
  noMatch: muted,
};

const editorTheme: EditorTheme = {
  borderColor: muted,
  selectList: selectListTheme,
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => bold(gold(text)),
  link: green,
  linkUrl: dim,
  code: amber,
  codeBlock: amber,
  codeBlockBorder: muted,
  quote: muted,
  quoteBorder: muted,
  hr: muted,
  listBullet: gold,
  bold,
  italic: (text) => `\x1b[3m${text}${reset}`,
  strikethrough: (text) => `\x1b[9m${text}${reset}`,
  underline: (text) => `\x1b[4m${text}${reset}`,
  highlightCode: (code) => code.split("\n").map(amber),
};

type TuiCommandContext = {
  agentId: string;
  sessionKey: string;
  model: MindStoneModelInfo;
  routingMode: "mock" | "pi" | "pi-session";
};

class MindStoneHeader implements Component {
  constructor(private readonly ctx: TuiCommandContext) {}

  render(width: number): string[] {
    const title = `${gold("◆")} ${bold(gold("MindStone-Agent"))} ${muted("TUI")}`;
    const detail = muted(`agent ${this.ctx.agentId} • ${this.ctx.routingMode} • ${this.ctx.model.id}`);
    return [
      truncateToWidth(title, width),
      truncateToWidth(detail, width),
      truncateToWidth(muted("─".repeat(Math.max(0, width))), width),
    ];
  }

  invalidate(): void {}
}

class MindStoneFooter implements Component {
  private status = "idle";

  setStatus(status: string): void {
    this.status = status;
  }

  render(width: number): string[] {
    return [
      truncateToWidth(muted("─".repeat(Math.max(0, width))), width),
      truncateToWidth(`${gold("◆")} ${muted(this.status)} ${dim("• Enter send • /help • /clear • /exit")}`, width),
    ];
  }

  invalidate(): void {}
}

type AssistantMessageHandle = {
  setText(text: string): void;
};

class MarkdownMessageHandle implements AssistantMessageHandle {
  constructor(private readonly markdown: Markdown) {}

  setText(text: string): void {
    this.markdown.setText(text || muted("(empty response)"));
  }
}

class MindStoneChatLog extends Container {
  private readonly maxComponents: number;

  constructor(maxComponents = 160) {
    super();
    this.maxComponents = maxComponents;
  }

  private append(component: Component): void {
    this.addChild(component);
    while (this.children.length > this.maxComponents) {
      const oldest = this.children[0];
      if (!oldest) return;
      this.removeChild(oldest);
    }
  }

  addSystem(text: string): void {
    this.append(new Text(muted(text), 1, 0));
  }

  addEvent(text: string): void {
    this.append(new Text(dim(`• ${text}`), 1, 0));
  }

  addTool(text: string): void {
    this.append(new Spacer(1));
    this.append(new Text(`${amber("◇")} ${bold("tool")}`, 1, 0));
    this.append(new Markdown(text || muted("(empty tool result)"), 2, 0, markdownTheme));
  }

  addPanel(title: string, text: string): void {
    this.append(new Spacer(1));
    this.append(new Text(`${gold("◆")} ${bold(gold(title))}`, 1, 0));
    this.append(new Markdown(text, 2, 0, markdownTheme));
  }

  addStatusPanel(text: string): void {
    this.addPanel("status", text);
  }

  addUser(text: string): void {
    this.append(new Spacer(1));
    this.append(new Text(`${gold("◆")} ${bold("you")}`, 1, 0));
    this.append(new Markdown(text, 2, 0, markdownTheme));
  }

  startAssistant(text: string): AssistantMessageHandle {
    this.append(new Spacer(1));
    this.append(new Text(`${gold("◆")} ${bold(gold("mindstone"))}`, 1, 0));
    const markdown = new Markdown(text || muted("(empty response)"), 2, 0, markdownTheme);
    this.append(markdown);
    return new MarkdownMessageHandle(markdown);
  }

  addAssistant(text: string): void {
    this.startAssistant(text);
  }

  addTurnEvents(entries: TranscriptEntry[], options: { skipRunnerStreamEvents?: boolean } = {}): void {
    for (const entry of entries) {
      if (entry.role !== "event") continue;
      if (options.skipRunnerStreamEvents && isRunnerStreamTranscriptEvent(entry)) continue;
      const label = eventEntryLabel(entry);
      if (label) this.addEvent(label);
    }
  }

  addError(text: string): void {
    this.append(new Spacer(1));
    this.append(new Text(`${red("✗")} ${bold("error")}`, 1, 0));
    this.append(new Text(red(text), 2, 0));
  }
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasOption(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function numberOption(argv: string[], name: string, fallback: number): number {
  const raw = optionValue(argv, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function transcriptEntryText(entry: TranscriptEntry): string {
  return (entry.text ?? textFromContent(entry.content) ?? "").trim();
}

function eventEntryLabel(entry: TranscriptEntry): string | undefined {
  const metadataEvent = typeof entry.metadata?.event === "string" ? entry.metadata.event : undefined;
  const text = transcriptEntryText(entry);
  if (text) return text;
  if (metadataEvent) return metadataEvent.replaceAll("_", " ");
  return undefined;
}

function runnerStreamEventLabel(event: AgentRunStreamEvent): string {
  if (event.type === "run_started") return `runner ${event.runnerId} started`;
  if (event.type === "route_planned") return `runner ${event.runnerId} planned route`;
  if (event.type === "text_delta") return `runner ${event.runnerId} text delta (${event.text.length} chars)`;
  if (event.type === "substrate_event") return `runner ${event.runnerId} ${event.substrate} event`;
  if (event.type === "run_completed") return `runner ${event.runnerId} completed`;
  return `runner ${event.runnerId} failed: ${event.error.message}`;
}

function isRunnerStreamTranscriptEvent(entry: TranscriptEntry): boolean {
  return entry.metadata?.event === "runner_stream_event";
}

function buildTuiStatusPanel(params: {
  ctx: TuiCommandContext;
  configPath: string;
  historyLimit: number;
  renderedHistoryCount: number;
  transcriptDir: string;
  piSessionDir: string;
}): string {
  return [
    `- agent: \`${params.ctx.agentId}\``,
    `- session: \`${params.ctx.sessionKey}\``,
    `- route: \`${params.ctx.routingMode}\``,
    `- model: \`${params.ctx.model.id}\``,
    `- provider: \`${params.ctx.model.provider}\``,
    `- transcript dir: \`${params.transcriptDir}\``,
    `- pi session dir: \`${params.piSessionDir}\``,
    `- config: \`${params.configPath}\``,
    `- loaded history: \`${params.renderedHistoryCount}/${params.historyLimit}\``,
  ].join("\n");
}

type TuiPanelItem = {
  id: string;
  detail?: string;
  current?: boolean;
};

function buildTuiListPanel(params: { emptyText: string; items: TuiPanelItem[]; next?: string }): string {
  const lines = params.items.length === 0
    ? [`- ${params.emptyText}`]
    : params.items.map((item) => {
      const current = item.current ? " **current**" : "";
      const detail = item.detail ? ` — ${item.detail}` : "";
      return `- \`${item.id}\`${current}${detail}`;
    });
  if (params.next) lines.push("", params.next);
  return lines.join("\n");
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function configuredAgentIds(config: ReturnType<typeof loadMindStoneConfig>["config"], ctx: TuiCommandContext): string[] {
  return uniqueValues([
    ctx.agentId,
    config?.routing?.defaultAgentId,
    ...Object.keys(config?.agents ?? {}),
  ]).sort((a, b) => a.localeCompare(b));
}

function buildTuiAgentsPanel(config: ReturnType<typeof loadMindStoneConfig>["config"], ctx: TuiCommandContext): string {
  const ids = configuredAgentIds(config, ctx);
  return buildTuiListPanel({
    emptyText: "No configured agents found.",
    items: ids.map((id) => {
      const agent = config?.agents?.[id];
      const detailParts = [
        id === config?.routing?.defaultAgentId ? "default" : undefined,
        agent?.profileId ? `profile ${agent.profileId}` : undefined,
        agent?.defaultModel ? `model ${agent.defaultModel}` : undefined,
      ].filter(Boolean);
      return {
        id,
        current: id === ctx.agentId,
        detail: detailParts.join("; ") || undefined,
      };
    }),
    next: "Use `/agent <id>` to switch this TUI session. Config mutation is not enabled here.",
  });
}

function buildTuiModelsPanel(config: ReturnType<typeof loadMindStoneConfig>["config"], ctx: TuiCommandContext): string {
  const agent = config?.agents?.[ctx.agentId];
  const ids = uniqueValues([
    ctx.model.id,
    agent?.defaultModel,
    config?.routing?.defaultModel,
    ctx.routingMode === "mock" ? "mindstone/mock" : undefined,
  ]).sort((a, b) => a.localeCompare(b));
  return buildTuiListPanel({
    emptyText: "No configured models found.",
    items: ids.map((id) => ({
      id,
      current: id === ctx.model.id,
      detail: [
        id === config?.routing?.defaultModel ? "routing default" : undefined,
        id === agent?.defaultModel ? "agent default" : undefined,
      ].filter(Boolean).join("; ") || undefined,
    })),
    next: "Use `/model <id>` to switch this TUI session. Config mutation is not enabled here.",
  });
}

function buildTuiSessionsPanel(params: {
  ctx: TuiCommandContext;
  config: ReturnType<typeof loadMindStoneConfig>["config"];
  sessions: Array<{ sessionKey: string; entries: number; updatedAt?: string }>;
}): string {
  const defaultSession = params.config?.session?.defaultSessionKey;
  const mode = params.config?.session?.mode ?? "single";
  const configured = uniqueValues([params.ctx.sessionKey, defaultSession]);
  const byKey = new Map<string, TuiPanelItem>();
  for (const key of configured) {
    byKey.set(key, {
      id: key,
      current: key === params.ctx.sessionKey,
      detail: key === defaultSession ? `configured default; mode ${mode}` : `mode ${mode}`,
    });
  }
  for (const session of params.sessions) {
    const existing = byKey.get(session.sessionKey);
    const detail = `${session.entries} entr${session.entries === 1 ? "y" : "ies"}${session.updatedAt ? `; updated ${session.updatedAt}` : ""}`;
    byKey.set(session.sessionKey, {
      id: session.sessionKey,
      current: session.sessionKey === params.ctx.sessionKey || Boolean(existing?.current),
      detail: existing?.detail ? `${existing.detail}; ${detail}` : detail,
    });
  }
  return buildTuiListPanel({
    emptyText: "No sessions found.",
    items: Array.from(byKey.values()).sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)) || a.id.localeCompare(b.id)),
    next: "Use `/session <key>` to switch this TUI session. Config mutation is not enabled here.",
  });
}

function commandArgument(message: string, command: string): string | undefined {
  if (!message.startsWith(`${command} `)) return undefined;
  const value = message.slice(command.length + 1).trim();
  return value || undefined;
}

function switchTuiSession(ctx: TuiCommandContext, config: ReturnType<typeof loadMindStoneConfig>["config"], rawSessionKey: string): string {
  ctx.sessionKey = resolveConfiguredSessionKey(config, {
    agentId: ctx.agentId,
    substrate: "mindstone-tui",
    channel: "terminal",
    chatType: "direct",
    senderId: "local",
    explicitSessionKey: rawSessionKey,
  });
  return `Switched this TUI session to \`${ctx.sessionKey}\`. Config was not changed.`;
}

function switchTuiAgent(ctx: TuiCommandContext, config: ReturnType<typeof loadMindStoneConfig>["config"], agentId: string): string {
  ctx.agentId = agentId;
  ctx.sessionKey = resolveConfiguredSessionKey(config, {
    agentId,
    substrate: "mindstone-tui",
    channel: "terminal",
    chatType: "direct",
    senderId: "local",
  });
  ctx.model = resolveMindStoneChatModel({ config, agentId, routingMode: ctx.routingMode });
  return `Switched this TUI session to agent \`${ctx.agentId}\`, session \`${ctx.sessionKey}\`, model \`${ctx.model.id}\`. Config was not changed.`;
}

function switchTuiModel(ctx: TuiCommandContext, config: ReturnType<typeof loadMindStoneConfig>["config"], modelId: string): string {
  ctx.model = resolveMindStoneChatModel({
    config,
    agentId: ctx.agentId,
    routingMode: ctx.routingMode,
    metadata: { model: modelId },
  });
  return `Switched this TUI session to model \`${ctx.model.id}\`. Config was not changed.`;
}

function appendTranscriptEntryToChatLog(chat: MindStoneChatLog, entry: TranscriptEntry): boolean {
  const text = transcriptEntryText(entry);
  if (entry.role === "user") {
    chat.addUser(text || muted("(empty user message)"));
    return true;
  }
  if (entry.role === "assistant") {
    chat.addAssistant(text || muted("(empty assistant response)"));
    return true;
  }
  if (entry.role === "tool") {
    chat.addTool(text || muted("(empty tool result)"));
    return true;
  }
  if (entry.role === "event") {
    const label = eventEntryLabel(entry);
    if (!label) return false;
    chat.addEvent(label);
    return true;
  }
  return false;
}

function isRenderableTranscriptEntry(entry: TranscriptEntry): boolean {
  if (entry.role === "user" || entry.role === "assistant" || entry.role === "tool") return true;
  if (entry.role === "event") return Boolean(eventEntryLabel(entry));
  return false;
}

function appendRecentTranscriptToChatLog(chat: MindStoneChatLog, entries: TranscriptEntry[]): number {
  let rendered = 0;
  for (const entry of entries) {
    if (appendTranscriptEntryToChatLog(chat, entry)) rendered += 1;
  }
  return rendered;
}

function recentTranscriptEntries(sessionKey: string, limit: number): TranscriptEntry[] {
  return readTranscriptEntries(sessionKey, { limit });
}

function resolveTuiProvider(config: ReturnType<typeof loadMindStoneConfig>["config"]): MockMindStoneProvider | PiMindStoneProvider | PiSessionMindStoneProvider {
  const mode = config?.routing?.mode ?? "placeholder";
  const paths = runtimePathsFromEnv();
  if (mode === "mock") return new MockMindStoneProvider(config?.routing?.mock);
  if (mode === "pi-session") {
    return new PiSessionMindStoneProvider({
      projectRoot: paths.root,
      agentDir: config?.routing?.pi?.agentDir ?? paths.piAgentDir,
      sessionDir: paths.piSessionDir,
      cwd: config?.workspace?.root,
      defaultModel: config?.routing?.defaultModel,
    });
  }
  if (mode === "pi") {
    return new PiMindStoneProvider({
      agentDir: config?.routing?.pi?.agentDir,
      defaultModel: config?.routing?.defaultModel,
    });
  }
  throw new Error("MindStone TUI requires routing.mode to be mock, pi-session, or pi. Current mode is placeholder; run `mindstone config` first.");
}

function resolveTuiRunner(config: ReturnType<typeof loadMindStoneConfig>["config"], provider: MockMindStoneProvider | PiMindStoneProvider | PiSessionMindStoneProvider): AgentRunner | undefined {
  return config?.routing?.mode === "pi-session" ? new PiSessionAgentRunner({ provider }) : undefined;
}

async function sendTuiTurn(params: {
  argv: string[];
  loaded: ReturnType<typeof loadMindStoneConfig>;
  ctx: TuiCommandContext;
  message: string;
  onRunnerStreamEvent?: (event: AgentRunStreamEvent) => void;
}): Promise<Awaited<ReturnType<typeof runMindStoneChatTurn>>> {
  const config = params.loaded.config;
  if (!config) throw new Error(`Config not found. Run ./scripts/init-runtime.sh or mindstone onboard first. Expected: ${params.loaded.path}`);
  const provider = resolveTuiProvider(config);
  const runner = resolveTuiRunner(config, provider);
  const metadata: Record<string, unknown> = {
    source: "mindstone-tui",
    method: "tui",
    model: params.ctx.model.id,
  };
  return runMindStoneChatTurn({
    agentId: params.ctx.agentId,
    sessionKey: params.ctx.sessionKey,
    message: params.message,
    config,
    configPath: params.loaded.path,
    provider,
    model: params.ctx.model,
    runner,
    source: {
      substrate: "mindstone-tui",
      channel: "terminal",
      chatType: "direct",
      senderId: "local",
    },
    metadata,
    onRunnerStreamEvent: params.onRunnerStreamEvent,
  });
}

function resolveTuiContext(argv: string[], loaded: ReturnType<typeof loadMindStoneConfig>): TuiCommandContext {
  const config = loaded.config;
  if (!config) throw new Error(`Config not found. Run ./scripts/init-runtime.sh or mindstone onboard first. Expected: ${loaded.path}`);
  const routingMode = config.routing?.mode ?? "placeholder";
  if (routingMode !== "mock" && routingMode !== "pi-session" && routingMode !== "pi") {
    throw new Error("MindStone TUI requires routing.mode to be mock, pi-session, or pi. Current mode is placeholder; run `mindstone config` first.");
  }
  const agentId = optionValue(argv, "--agent") ?? config.routing?.defaultAgentId ?? "default";
  const sessionKey = resolveConfiguredSessionKey(config, {
    agentId,
    substrate: "mindstone-tui",
    channel: "terminal",
    chatType: "direct",
    senderId: "local",
    explicitSessionKey: optionValue(argv, "--session"),
  });
  const metadata: Record<string, unknown> = {};
  const modelOverride = optionValue(argv, "--model");
  if (modelOverride) metadata.model = modelOverride;
  return {
    agentId,
    sessionKey,
    routingMode,
    model: resolveMindStoneChatModel({ config, agentId, routingMode, metadata }),
  };
}

export function createMindStoneTuiSmokeSnapshot(width = 80): string {
  const ctx: TuiCommandContext = {
    agentId: "default",
    sessionKey: "agent:default:main",
    routingMode: "mock",
    model: { id: "mindstone/mock", provider: "mock" },
  };
  const header = new MindStoneHeader(ctx);
  const chat = new MindStoneChatLog();
  const footer = new MindStoneFooter();
  chat.addSystem("Welcome back. This is the styled MindStone-Agent TUI shell.");
  chat.addUser("hello tui");
  const assistant = chat.startAssistant(dim("MindStone is thinking…"));
  assistant.setText("TUI smoke response with **markdown** and `code`.");
  chat.addEvent("runner stream event smoke");
  chat.addEvent(runnerStreamEventLabel({
    type: "run_started",
    sequence: 0,
    timestamp: "2026-06-18T00:00:00.000Z",
    runnerId: "provider-route",
    input: { agentId: ctx.agentId, sessionKey: ctx.sessionKey, model: ctx.model },
  }));
  const smokeConfig = {
    routing: { mode: "mock" as const, defaultAgentId: "default", defaultModel: "mindstone/mock" },
    session: { mode: "single" as const, defaultSessionKey: "agent:default:main" },
    agents: {
      default: { id: "default", defaultModel: "mindstone/mock", profileId: "software-engineering-partner" },
      research: { id: "research", defaultModel: "mindstone/research", profileId: "research-analyst" },
    },
  };
  chat.addStatusPanel(buildTuiStatusPanel({
    ctx,
    configPath: "/tmp/mindstone/config.json",
    historyLimit: 40,
    renderedHistoryCount: 2,
    transcriptDir: "/tmp/mindstone/transcripts",
    piSessionDir: "/tmp/pi-sessions",
  }));
  chat.addPanel("sessions", buildTuiSessionsPanel({
    ctx,
    config: smokeConfig,
    sessions: [{ sessionKey: "agent:default:main", entries: 2, updatedAt: "2026-06-18T00:00:00.000Z" }],
  }));
  chat.addPanel("agents", buildTuiAgentsPanel(smokeConfig, ctx));
  chat.addPanel("models", buildTuiModelsPanel(smokeConfig, ctx));
  footer.setStatus(`session ${ctx.sessionKey}`);
  return [...header.render(width), ...chat.render(width), ...footer.render(width)].join("\n");
}

function createMindStoneTuiHistorySnapshot(argv: string[], width: number): string {
  const paths = runtimePathsFromEnv();
  const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
  if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
  const ctx = resolveTuiContext(argv, loaded);
  const header = new MindStoneHeader(ctx);
  const chat = new MindStoneChatLog();
  const footer = new MindStoneFooter();
  const historyLimit = numberOption(argv, "--history-limit", 40);
  const entries = recentTranscriptEntries(ctx.sessionKey, historyLimit);
  const renderableCount = entries.filter(isRenderableTranscriptEntry).length;
  if (renderableCount === 0) {
    chat.addSystem("No transcript history yet. Type a message to begin.");
  } else {
    chat.addSystem(`Loaded ${renderableCount} recent transcript entr${renderableCount === 1 ? "y" : "ies"}.`);
    appendRecentTranscriptToChatLog(chat, entries);
  }
  footer.setStatus(`session ${ctx.sessionKey}`);
  return [...header.render(width), ...chat.render(width), ...footer.render(width)].join("\n");
}

function createMindStoneTuiSwitchSnapshot(width = 80): string {
  const config = {
    routing: { mode: "mock" as const, defaultAgentId: "default", defaultModel: "mindstone/mock" },
    session: { mode: "single" as const, defaultSessionKey: "agent:default:main" },
    agents: {
      default: { id: "default", defaultModel: "mindstone/mock", profileId: "software-engineering-partner" },
      research: { id: "research", defaultModel: "mindstone/research", profileId: "research-analyst" },
    },
  };
  const ctx: TuiCommandContext = {
    agentId: "default",
    sessionKey: "agent:default:main",
    routingMode: "mock",
    model: { id: "mindstone/mock", provider: "mock" },
  };
  const header = new MindStoneHeader(ctx);
  const chat = new MindStoneChatLog();
  const footer = new MindStoneFooter();
  chat.addSystem(switchTuiAgent(ctx, config, "research"));
  chat.addSystem(switchTuiModel(ctx, config, "mindstone/custom-smoke"));
  chat.addSystem(switchTuiSession(ctx, config, "agent:research:smoke"));
  chat.addPanel("agents", buildTuiAgentsPanel(config, ctx));
  chat.addPanel("models", buildTuiModelsPanel(config, ctx));
  chat.addPanel("sessions", buildTuiSessionsPanel({ ctx, config, sessions: [] }));
  footer.setStatus(`session ${ctx.sessionKey}`);
  return [...header.render(width), ...chat.render(width), ...footer.render(width)].join("\n");
}

export async function runTuiCommand(argv: string[]): Promise<void> {
  if (hasOption(argv, "--smoke-switches")) {
    process.stdout.write(`${createMindStoneTuiSwitchSnapshot(numberOption(argv, "--width", 80))}\n`);
    return;
  }
  if (hasOption(argv, "--smoke-history")) {
    process.stdout.write(`${createMindStoneTuiHistorySnapshot(argv, numberOption(argv, "--width", 80))}\n`);
    return;
  }
  if (hasOption(argv, "--smoke")) {
    process.stdout.write(`${createMindStoneTuiSmokeSnapshot(numberOption(argv, "--width", 80))}\n`);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("MindStone TUI requires a TTY. Use `mindstone tui --smoke` for non-interactive validation or `mindstone chat --once` for one-shot chat.");
  }

  const paths = runtimePathsFromEnv();
  const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
  if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
  const ctx = resolveTuiContext(argv, loaded);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const header = new MindStoneHeader(ctx);
  const chat = new MindStoneChatLog();
  const footer = new MindStoneFooter();
  const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
    { name: "help", description: "Show TUI commands" },
    { name: "clear", description: "Clear the visible chat log" },
    { name: "status", description: "Show current TUI/session status" },
    { name: "sessions", description: "Show known/configured sessions" },
    { name: "session", description: "Switch this TUI session: /session <key>" },
    { name: "agents", description: "Show configured agents" },
    { name: "agent", description: "Switch this TUI session to an agent: /agent <id>" },
    { name: "models", description: "Show configured model choices" },
    { name: "model", description: "Switch this TUI session model: /model <id>" },
    { name: "exit", description: "Exit the TUI" },
    { name: "quit", description: "Exit the TUI" },
  ], process.cwd()));

  const historyLimit = numberOption(argv, "--history-limit", 40);
  const entries = recentTranscriptEntries(ctx.sessionKey, historyLimit);
  let renderedHistoryCount = entries.filter(isRenderableTranscriptEntry).length;
  if (renderedHistoryCount === 0) {
    chat.addSystem("Welcome back. Type a message, /help, /clear, or /exit.");
  } else {
    chat.addSystem(`Loaded ${renderedHistoryCount} recent transcript entr${renderedHistoryCount === 1 ? "y" : "ies"}. Type /help for commands.`);
    appendRecentTranscriptToChatLog(chat, entries);
  }
  footer.setStatus(`session ${ctx.sessionKey}`);

  tui.addChild(header);
  tui.addChild(chat);
  tui.addChild(footer);
  tui.addChild(editor);
  tui.setFocus(editor);

  let responding = false;
  let stopped = false;

  await new Promise<void>((resolve) => {
    const stop = () => {
      if (stopped) return;
      stopped = true;
      tui.stop();
      resolve();
    };

    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
        stop();
        return { consume: true };
      }
      return undefined;
    });

    const reloadVisibleHistory = (notice: string) => {
      const nextEntries = recentTranscriptEntries(ctx.sessionKey, historyLimit);
      renderedHistoryCount = nextEntries.filter(isRenderableTranscriptEntry).length;
      chat.clear();
      chat.addSystem(notice);
      if (renderedHistoryCount === 0) {
        chat.addSystem("No transcript history for this session yet.");
      } else {
        chat.addSystem(`Loaded ${renderedHistoryCount} recent transcript entr${renderedHistoryCount === 1 ? "y" : "ies"}.`);
        appendRecentTranscriptToChatLog(chat, nextEntries);
      }
      footer.setStatus(`session ${ctx.sessionKey}`);
    };

    editor.onSubmit = (raw: string) => {
      const message = raw.trim();
      editor.setText("");
      if (!message || responding) return;
      editor.addToHistory(message);

      if (message === "/exit" || message === "/quit") {
        stop();
        return;
      }
      if (message === "/help") {
        chat.addSystem("Commands: /help, /clear, /status, /sessions, /session <key>, /agents, /agent <id>, /models, /model <id>, /exit. Regular text sends a MindStone turn.");
        tui.requestRender();
        return;
      }
      if (message === "/status") {
        chat.addStatusPanel(buildTuiStatusPanel({
          ctx,
          configPath: loaded.path,
          historyLimit,
          renderedHistoryCount,
          transcriptDir: paths.transcriptDir,
          piSessionDir: paths.piSessionDir,
        }));
        tui.requestRender();
        return;
      }
      if (message === "/sessions") {
        chat.addPanel("sessions", buildTuiSessionsPanel({
          ctx,
          config: loaded.config,
          sessions: listTranscriptSessions({ paths }).slice(0, 12),
        }));
        tui.requestRender();
        return;
      }
      const sessionSwitch = commandArgument(message, "/session");
      if (sessionSwitch) {
        reloadVisibleHistory(switchTuiSession(ctx, loaded.config, sessionSwitch));
        tui.requestRender(true);
        return;
      }
      if (message === "/agents") {
        chat.addPanel("agents", buildTuiAgentsPanel(loaded.config, ctx));
        tui.requestRender();
        return;
      }
      const agentSwitch = commandArgument(message, "/agent");
      if (agentSwitch) {
        reloadVisibleHistory(switchTuiAgent(ctx, loaded.config, agentSwitch));
        tui.requestRender(true);
        return;
      }
      if (message === "/models") {
        chat.addPanel("models", buildTuiModelsPanel(loaded.config, ctx));
        tui.requestRender();
        return;
      }
      const modelSwitch = commandArgument(message, "/model");
      if (modelSwitch) {
        chat.addSystem(switchTuiModel(ctx, loaded.config, modelSwitch));
        footer.setStatus(`model ${ctx.model.id} • session ${ctx.sessionKey}`);
        tui.requestRender();
        return;
      }
      if (message === "/clear") {
        chat.clear();
        chat.addSystem("Visible chat log cleared. Transcript history is preserved.");
        tui.requestRender(true);
        return;
      }

      responding = true;
      editor.disableSubmit = true;
      footer.setStatus("thinking…");
      chat.addUser(message);
      const assistant = chat.startAssistant(dim("MindStone is thinking…"));
      let streamedAssistantText = "";
      const loader = new Loader(tui, gold, muted, "working");
      chat.addChild(loader);
      tui.requestRender();

      void sendTuiTurn({
        argv,
        loaded,
        ctx,
        message,
        onRunnerStreamEvent: (event) => {
          if (event.type === "text_delta") {
            streamedAssistantText += event.text;
            assistant.setText(streamedAssistantText);
            footer.setStatus("receiving response…");
          } else {
            chat.addEvent(runnerStreamEventLabel(event));
            footer.setStatus(event.type === "run_completed" ? "finalizing…" : runnerStreamEventLabel(event));
          }
          tui.requestRender();
        },
      })
        .then((result) => {
          chat.removeChild(loader);
          chat.addTurnEvents(result.events, { skipRunnerStreamEvents: true });
          assistant.setText(result.assistantEntry.text ?? "");
          footer.setStatus(`idle • ${ctx.sessionKey}`);
        })
        .catch((error) => {
          chat.removeChild(loader);
          assistant.setText(red("Turn failed."));
          chat.addError(error instanceof Error ? error.message : String(error));
          footer.setStatus("error");
        })
        .finally(() => {
          responding = false;
          editor.disableSubmit = false;
          tui.requestRender();
        });
    };

    tui.start();
  });
}
