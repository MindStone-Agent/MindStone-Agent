import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MindStoneChatRequest, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider, MindStoneProviderInfo } from "@mindstone-agent/core";

export type PiSessionMindStoneProviderOptions = {
  projectRoot?: string;
  agentDir?: string;
  sessionDir?: string;
  cwd?: string;
  defaultProvider?: string;
  defaultModel?: string;
};

type PiModel = {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
};

type PiRegistry = {
  getAll(): PiModel[];
  getAvailable(): PiModel[];
  find(provider: string, modelId: string): PiModel | undefined;
  getProviderDisplayName(provider: string): string;
  getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
  hasConfiguredAuth?(model: PiModel): boolean;
};

type PiSessionModules = {
  createAgentSession: (options?: Record<string, unknown>) => Promise<{ session: PiAgentSession; modelFallbackMessage?: string }>;
  AuthStorage: { create(path?: string): unknown };
  ModelRegistry: { create(authStorage: unknown, modelsPath?: string): PiRegistry };
  SessionManager: { open(path: string, sessionDir?: string, cwdOverride?: string): unknown };
  SettingsManager: { create(cwd?: string, agentDir?: string): unknown };
};

type PiAgentMessage = {
  role?: string;
  content?: unknown;
};

type PiAgentEvent = {
  type?: string;
  message?: PiAgentMessage;
  messages?: PiAgentMessage[];
  assistantMessageEvent?: unknown;
  toolName?: string;
  toolCallId?: string;
  willRetry?: boolean;
};

type PiSessionEventSummary = {
  type: string;
  messageRole?: string;
  assistantTextChars?: number;
  toolName?: string;
  toolCallId?: string;
  willRetry?: boolean;
};

type PiSessionEventCapture = {
  events: PiSessionEventSummary[];
  eventCounts: Record<string, number>;
  assistantTexts: string[];
  lastAssistantText?: string;
};

type PiAgentSession = {
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  subscribe?(listener: (event: PiAgentEvent) => void): () => void;
  dispose(): void;
  messages?: PiAgentMessage[];
  state?: { messages?: PiAgentMessage[]; model?: PiModel };
  sessionId?: string;
  sessionFile?: string;
};

function projectRootFromEnv(): string {
  return resolve(process.env.MINDSTONE_AGENT_ROOT ?? process.cwd());
}

async function importFromProject<T>(projectRoot: string, path: string): Promise<T> {
  return import(pathToFileURL(join(projectRoot, path)).href) as Promise<T>;
}

async function loadPiSessionModules(projectRoot: string): Promise<PiSessionModules> {
  const [sdk, auth, registry, sessionManager, settingsManager] = await Promise.all([
    importFromProject<{ createAgentSession: PiSessionModules["createAgentSession"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/sdk.js"),
    importFromProject<{ AuthStorage: PiSessionModules["AuthStorage"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/auth-storage.js"),
    importFromProject<{ ModelRegistry: PiSessionModules["ModelRegistry"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/model-registry.js"),
    importFromProject<{ SessionManager: PiSessionModules["SessionManager"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/session-manager.js"),
    importFromProject<{ SettingsManager: PiSessionModules["SettingsManager"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/settings-manager.js"),
  ]);
  return {
    createAgentSession: sdk.createAgentSession,
    AuthStorage: auth.AuthStorage,
    ModelRegistry: registry.ModelRegistry,
    SessionManager: sessionManager.SessionManager,
    SettingsManager: settingsManager.SettingsManager,
  };
}

function splitProviderModel(modelId: string | undefined): { provider?: string; modelId?: string } {
  if (!modelId) return {};
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { modelId };
  return { provider: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) };
}

function toModelInfo(model: PiModel): MindStoneModelInfo {
  return {
    id: `${model.provider}/${model.id}`,
    provider: model.provider,
    name: model.name,
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
  };
}

export function piSessionFileForKey(sessionDir: string, sessionKey: string): string {
  return join(sessionDir, `${Buffer.from(sessionKey, "utf8").toString("base64url")}.jsonl`);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function lastAssistantText(messages: PiAgentMessage[] | undefined): string {
  const assistant = [...(messages ?? [])].reverse().find((message) => message.role === "assistant");
  return textFromContent(assistant?.content).trim();
}

export function summarizePiSessionEvent(event: PiAgentEvent): PiSessionEventSummary {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const assistantText = event.message?.role === "assistant" ? textFromContent(event.message.content).trim() : undefined;
  return {
    type,
    messageRole: event.message?.role,
    assistantTextChars: assistantText ? assistantText.length : undefined,
    toolName: typeof event.toolName === "string" ? event.toolName : undefined,
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
    willRetry: typeof event.willRetry === "boolean" ? event.willRetry : undefined,
  };
}

export function createPiSessionEventCapture(limit = 200): { capture: PiSessionEventCapture; record: (event: PiAgentEvent) => void } {
  const capture: PiSessionEventCapture = { events: [], eventCounts: {}, assistantTexts: [] };
  const rememberAssistantText = (message: PiAgentMessage | undefined): void => {
    if (message?.role !== "assistant") return;
    const text = textFromContent(message.content).trim();
    if (!text) return;
    if (capture.assistantTexts.at(-1) !== text) capture.assistantTexts.push(text);
    capture.lastAssistantText = text;
  };
  return {
    capture,
    record(event) {
      const type = typeof event.type === "string" ? event.type : "unknown";
      capture.eventCounts[type] = (capture.eventCounts[type] ?? 0) + 1;
      capture.events.push(summarizePiSessionEvent(event));
      if (capture.events.length > limit) capture.events.splice(0, capture.events.length - limit);
      rememberAssistantText(event.message);
      if (event.type === "agent_end") {
        rememberAssistantText([...(event.messages ?? [])].reverse().find((message) => message.role === "assistant"));
      }
    },
  };
}

export class PiSessionMindStoneProvider implements MindStoneModelProvider {
  readonly id = "pi-session";
  readonly #projectRoot: string;
  readonly #agentDir: string;
  readonly #sessionDir: string;
  readonly #cwd: string;
  readonly #defaultProvider?: string;
  readonly #defaultModel?: string;
  #modules?: PiSessionModules;
  #registry?: PiRegistry;

  constructor(options: PiSessionMindStoneProviderOptions = {}) {
    this.#projectRoot = resolve(options.projectRoot ?? projectRootFromEnv());
    this.#agentDir = resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(this.#projectRoot, ".runtime", "pi-agent"));
    this.#sessionDir = resolve(options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? join(this.#projectRoot, ".runtime", "pi-sessions"));
    this.#cwd = resolve(options.cwd ?? this.#projectRoot);
    this.#defaultProvider = options.defaultProvider;
    this.#defaultModel = options.defaultModel;
  }

  async #load(): Promise<{ modules: PiSessionModules; registry: PiRegistry }> {
    if (this.#modules && this.#registry) return { modules: this.#modules, registry: this.#registry };
    const modules = await loadPiSessionModules(this.#projectRoot);
    const authStorage = modules.AuthStorage.create(join(this.#agentDir, "auth.json"));
    const registry = modules.ModelRegistry.create(authStorage, join(this.#agentDir, "models.json"));
    this.#modules = modules;
    this.#registry = registry;
    return { modules, registry };
  }

  async listModels(): Promise<MindStoneModelInfo[]> {
    const { registry } = await this.#load();
    return registry.getAll().map(toModelInfo);
  }

  async listAvailableModels(): Promise<MindStoneModelInfo[]> {
    const { registry } = await this.#load();
    return registry.getAvailable().map(toModelInfo);
  }

  async listProviders(): Promise<MindStoneProviderInfo[]> {
    const { registry } = await this.#load();
    const all = registry.getAll();
    const available = registry.getAvailable();
    const providers = [...new Set(all.map((model) => model.provider))].sort((a, b) => registry.getProviderDisplayName(a).localeCompare(registry.getProviderDisplayName(b)));
    return providers.map((provider) => ({
      id: provider,
      name: registry.getProviderDisplayName(provider),
      authStatus: registry.getProviderAuthStatus(provider) as MindStoneProviderInfo["authStatus"],
      modelCount: all.filter((model) => model.provider === provider).length,
      availableModelCount: available.filter((model) => model.provider === provider).length,
    }));
  }

  async #resolvePiModel(requestModelId?: string): Promise<PiModel> {
    const { registry } = await this.#load();
    const parsed = splitProviderModel(requestModelId ?? this.#defaultModel);
    const provider = parsed.provider ?? this.#defaultProvider;
    const modelId = parsed.modelId ?? this.#defaultModel;
    const explicit = provider && modelId ? registry.find(provider, modelId) : undefined;
    if (explicit) {
      const configured = registry.hasConfiguredAuth ? registry.hasConfiguredAuth(explicit) : registry.getAvailable().some((model) => model.provider === explicit.provider && model.id === explicit.id);
      if (!configured) throw new Error(`Pi model is known but not available in isolated runtime auth: ${explicit.provider}/${explicit.id}`);
      return explicit;
    }
    const available = registry.getAvailable();
    if (available.length > 0) return available[0];
    throw new Error("No isolated Pi model is available/configured for session-backed MindStone-Agent routing");
  }

  async completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult> {
    const { modules } = await this.#load();
    const model = await this.#resolvePiModel(request.model.id);
    const sessionFile = piSessionFileForKey(this.#sessionDir, request.sessionKey);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const sessionManager = modules.SessionManager.open(sessionFile, this.#sessionDir, this.#cwd);
    const settingsManager = modules.SettingsManager.create(this.#cwd, this.#agentDir);
    const { session, modelFallbackMessage } = await modules.createAgentSession({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      model,
      sessionManager,
      settingsManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });

    const { capture, record } = createPiSessionEventCapture();
    const unsubscribe = session.subscribe?.((event) => record(event));

    try {
      const prompt = request.messages
        .map((message) => {
          if (message.role === "system") return `[system context]\n${message.text ?? ""}`;
          if (message.role === "assistant") return `[prior assistant]\n${message.text ?? ""}`;
          if (message.role === "tool") return `[tool]\n${message.text ?? JSON.stringify(message.content ?? "")}`;
          return message.text ?? "";
        })
        .filter((text) => text.trim())
        .join("\n\n");
      await session.prompt(prompt || request.transcriptEntries.at(-1)?.text || "", { source: "rpc" });
      const text = capture.lastAssistantText ?? lastAssistantText(session.messages ?? session.state?.messages);
      return {
        role: "assistant",
        text,
        model: toModelInfo(model),
        raw: {
          sessionId: session.sessionId,
          sessionFile,
          modelFallbackMessage,
          piSession: {
            eventCounts: capture.eventCounts,
            events: capture.events,
            assistantTexts: capture.assistantTexts,
          },
        },
      };
    } finally {
      unsubscribe?.();
      session.dispose();
    }
  }
}
