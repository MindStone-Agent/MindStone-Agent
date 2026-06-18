import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentCompactionInput, AgentCompactionResult, ContextManagementPolicy, MindStoneChatRequest, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider, MindStoneProviderInfo, MindStonePiCompactionConfig } from "@mindstone-agent/core";
import { buildMindStonePiExtensionFactories, type MindStonePiExtensionFactory } from "./pi-context-pruning-extension.js";

export type PiSessionResourceLoaderOptions = {
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  /** MindStone-owned Pi inline extension factories. Used for parity with current MindStone's embedded runner. */
  extensionFactories?: MindStonePiExtensionFactory[];
};

export type PiSessionExecutorOptions = PiSessionResourceLoaderOptions & {
  /** MindStone context policy used to derive safe Pi-side inline extension parity. */
  contextManagement?: ContextManagementPolicy;
  /** Session-local Pi native compaction settings for the isolated route. */
  compaction?: MindStonePiCompactionConfig;
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

type PiResourceLoader = { reload(): Promise<void> };

type PiSettingsManagerLike = {
  getCompactionEnabled?(): boolean;
  getCompactionReserveTokens?(): number;
  getCompactionKeepRecentTokens?(): number;
  applyOverrides?(overrides: { compaction: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number } }): void;
};

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function applyPiSessionCompactionSettings(input: {
  settingsManager: PiSettingsManagerLike;
  compaction?: MindStonePiCompactionConfig;
}): {
  didOverride: boolean;
  compaction: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
} {
  const currentEnabled = input.settingsManager.getCompactionEnabled?.();
  const currentReserveTokens = input.settingsManager.getCompactionReserveTokens?.();
  const currentKeepRecentTokens = input.settingsManager.getCompactionKeepRecentTokens?.();
  const reserveTokensFloor = nonNegativeInt(input.compaction?.reserveTokensFloor) ?? DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
  const configuredReserveTokens = nonNegativeInt(input.compaction?.reserveTokens);
  const configuredKeepRecentTokens = positiveInt(input.compaction?.keepRecentTokens);
  const targetEnabled = typeof input.compaction?.enabled === "boolean" ? input.compaction.enabled : currentEnabled;
  const targetReserveTokens = Math.max(configuredReserveTokens ?? currentReserveTokens ?? 0, reserveTokensFloor);
  const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;
  const overrides: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number } = {};

  if (targetEnabled !== undefined && targetEnabled !== currentEnabled) overrides.enabled = targetEnabled;
  if (targetReserveTokens > 0 && targetReserveTokens !== currentReserveTokens) overrides.reserveTokens = targetReserveTokens;
  if (targetKeepRecentTokens !== undefined && targetKeepRecentTokens !== currentKeepRecentTokens) overrides.keepRecentTokens = targetKeepRecentTokens;

  if (Object.keys(overrides).length > 0) {
    input.settingsManager.applyOverrides?.({ compaction: overrides });
  }

  return {
    didOverride: Object.keys(overrides).length > 0,
    compaction: {
      enabled: targetEnabled,
      reserveTokens: targetReserveTokens > 0 ? targetReserveTokens : undefined,
      keepRecentTokens: targetKeepRecentTokens,
    },
  };
}

type PiSessionModules = {
  createAgentSession: (options?: Record<string, unknown>) => Promise<{ session: PiAgentSession; modelFallbackMessage?: string }>;
  AuthStorage: { create(path?: string): unknown };
  DefaultResourceLoader: new (options: Record<string, unknown>) => PiResourceLoader;
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
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: boolean;
  reason?: string;
  willRetry?: boolean;
  aborted?: boolean;
  errorMessage?: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  success?: boolean;
  finalError?: string;
  steering?: readonly unknown[];
  followUp?: readonly unknown[];
  name?: string;
  level?: string;
};

export const PI_SESSION_EVENT_CALLBACK_METADATA_KEY = "__mindstonePiSessionEventCallback";

export type PiSessionEventCallbackPayload = {
  summary: PiSessionEventSummary;
  textDelta?: string;
};

export type PiSessionEventCallback = (payload: PiSessionEventCallbackPayload) => void;

export type PiSessionEventSummary = {
  type: string;
  messageRole?: string;
  messageTextChars?: number;
  assistantTextChars?: number;
  assistantStreamEventType?: string;
  assistantStreamDeltaChars?: number;
  assistantStreamContentChars?: number;
  assistantStreamContentIndex?: number;
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgsKeys?: string[];
  toolResultTextChars?: number;
  toolResultIsError?: boolean;
  compactionReason?: string;
  compactionWillRetry?: boolean;
  compactionAborted?: boolean;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
  retrySuccess?: boolean;
  queueSteeringCount?: number;
  queueFollowUpCount?: number;
  sessionName?: string;
  thinkingLevel?: string;
  messagesCount?: number;
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
  compact?(customInstructions?: string): Promise<unknown>;
  abort?(): Promise<void>;
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
  const [sdk, auth, resourceLoader, registry, sessionManager, settingsManager] = await Promise.all([
    importFromProject<{ createAgentSession: PiSessionModules["createAgentSession"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/sdk.js"),
    importFromProject<{ AuthStorage: PiSessionModules["AuthStorage"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/auth-storage.js"),
    importFromProject<{ DefaultResourceLoader: PiSessionModules["DefaultResourceLoader"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/resource-loader.js"),
    importFromProject<{ ModelRegistry: PiSessionModules["ModelRegistry"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/model-registry.js"),
    importFromProject<{ SessionManager: PiSessionModules["SessionManager"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/session-manager.js"),
    importFromProject<{ SettingsManager: PiSessionModules["SettingsManager"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/settings-manager.js"),
  ]);
  return {
    createAgentSession: sdk.createAgentSession,
    AuthStorage: auth.AuthStorage,
    DefaultResourceLoader: resourceLoader.DefaultResourceLoader,
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

export function buildPiSessionResourceLoaderOptions(input: {
  cwd: string;
  agentDir: string;
  settingsManager: unknown;
  appendSystemPrompt: string[];
  options?: PiSessionResourceLoaderOptions;
}): Record<string, unknown> {
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: input.settingsManager,
    appendSystemPrompt: input.appendSystemPrompt,
    additionalExtensionPaths: input.options?.additionalExtensionPaths,
    additionalSkillPaths: input.options?.additionalSkillPaths,
    additionalPromptTemplatePaths: input.options?.additionalPromptTemplatePaths,
    additionalThemePaths: input.options?.additionalThemePaths,
    noExtensions: input.options?.noExtensions,
    noSkills: input.options?.noSkills,
    noPromptTemplates: input.options?.noPromptTemplates,
    noThemes: input.options?.noThemes,
    noContextFiles: input.options?.noContextFiles,
    extensionFactories: input.options?.extensionFactories,
  };
}

const piSessionFileLocks = new Map<string, Promise<void>>();

export async function withPiSessionFileLock<T>(sessionFile: string, operation: () => Promise<T>): Promise<T> {
  const previous = piSessionFileLocks.get(sessionFile) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveLock) => {
    releaseCurrent = resolveLock;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  piSessionFileLocks.set(sessionFile, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (piSessionFileLocks.get(sessionFile) === tail) {
      piSessionFileLocks.delete(sessionFile);
    }
  }
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function objectKeys(value: unknown): string[] | undefined {
  const input = record(value);
  if (!input) return undefined;
  const keys = Object.keys(input).filter(Boolean).sort();
  return keys.length > 0 ? keys.slice(0, 50) : undefined;
}

function textCharsFromResult(value: unknown): number | undefined {
  const input = record(value);
  if (!input) return undefined;
  const text = textFromContent(input.content);
  return text ? text.length : undefined;
}

function textDeltaFromAssistantStreamEvent(value: unknown): string | undefined {
  const input = record(value);
  if (!input) return undefined;
  if (input.type !== "text_delta") return undefined;
  return stringValue(input.delta);
}

function assistantStreamEventSummary(value: unknown): Partial<PiSessionEventSummary> {
  const input = record(value);
  if (!input) return {};
  const delta = stringValue(input.delta);
  const content = stringValue(input.content);
  const toolCall = record(input.toolCall);
  const finalMessage = record(input.message) ?? record(input.error);
  const finalText = textFromContent(finalMessage?.content).trim();
  return {
    assistantStreamEventType: stringValue(input.type),
    assistantStreamDeltaChars: delta ? delta.length : undefined,
    assistantStreamContentChars: content ? content.length : finalText ? finalText.length : undefined,
    assistantStreamContentIndex: numberValue(input.contentIndex),
    stopReason: stringValue(input.reason) ?? stringValue(finalMessage?.stopReason),
    errorMessage: stringValue(finalMessage?.errorMessage),
    toolName: stringValue(toolCall?.name),
    toolCallId: stringValue(toolCall?.id),
    toolArgsKeys: objectKeys(toolCall?.arguments),
  };
}

function messageSummary(message: PiAgentMessage | undefined): Partial<PiSessionEventSummary> {
  const input = record(message);
  const role = stringValue(message?.role);
  const text = textFromContent(message?.content).trim();
  return {
    messageRole: role,
    messageTextChars: text ? text.length : undefined,
    assistantTextChars: role === "assistant" && text ? text.length : undefined,
    stopReason: stringValue(input?.stopReason),
    errorMessage: stringValue(input?.errorMessage),
  };
}

function lastAssistantText(messages: PiAgentMessage[] | undefined): string {
  const assistant = [...(messages ?? [])].reverse().find((message) => message.role === "assistant");
  return textFromContent(assistant?.content).trim();
}

export function summarizePiSessionEvent(event: PiAgentEvent): PiSessionEventSummary {
  const type = stringValue(event.type) ?? "unknown";
  const assistantEvent = assistantStreamEventSummary(event.assistantMessageEvent);
  const message = messageSummary(event.message);
  return {
    type,
    ...message,
    ...assistantEvent,
    toolName: stringValue(event.toolName) ?? assistantEvent.toolName,
    toolCallId: stringValue(event.toolCallId) ?? assistantEvent.toolCallId,
    toolArgsKeys: objectKeys(event.args) ?? assistantEvent.toolArgsKeys,
    toolResultTextChars: textCharsFromResult(event.result) ?? textCharsFromResult(event.partialResult),
    toolResultIsError: booleanValue(event.isError),
    compactionReason: type === "compaction_start" || type === "compaction_end" ? stringValue(event.reason) : undefined,
    compactionWillRetry: type === "compaction_end" ? booleanValue(event.willRetry) : undefined,
    compactionAborted: type === "compaction_end" ? booleanValue(event.aborted) : undefined,
    retryAttempt: type === "auto_retry_start" || type === "auto_retry_end" ? numberValue(event.attempt) : undefined,
    retryMaxAttempts: type === "auto_retry_start" ? numberValue(event.maxAttempts) : undefined,
    retryDelayMs: type === "auto_retry_start" ? numberValue(event.delayMs) : undefined,
    retrySuccess: type === "auto_retry_end" ? booleanValue(event.success) : undefined,
    queueSteeringCount: type === "queue_update" && Array.isArray(event.steering) ? event.steering.length : undefined,
    queueFollowUpCount: type === "queue_update" && Array.isArray(event.followUp) ? event.followUp.length : undefined,
    sessionName: type === "session_info_changed" ? stringValue(event.name) : undefined,
    thinkingLevel: type === "thinking_level_changed" ? stringValue(event.level) : undefined,
    messagesCount: Array.isArray(event.messages) ? event.messages.length : undefined,
    willRetry: booleanValue(event.willRetry),
    errorMessage: stringValue(event.errorMessage) ?? message.errorMessage ?? assistantEvent.errorMessage ?? stringValue(event.finalError),
  };
}

function piSessionEventCallbackFromMetadata(metadata: Record<string, unknown> | undefined): PiSessionEventCallback | undefined {
  const value = metadata?.[PI_SESSION_EVENT_CALLBACK_METADATA_KEY];
  return typeof value === "function" ? value as PiSessionEventCallback : undefined;
}

export function createPiSessionEventCapture(limit = 200): { capture: PiSessionEventCapture; record: (event: PiAgentEvent) => PiSessionEventSummary } {
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
      const summary = summarizePiSessionEvent(event);
      capture.eventCounts[type] = (capture.eventCounts[type] ?? 0) + 1;
      capture.events.push(summary);
      if (capture.events.length > limit) capture.events.splice(0, capture.events.length - limit);
      rememberAssistantText(event.message);
      if (event.type === "agent_end") {
        rememberAssistantText([...(event.messages ?? [])].reverse().find((message) => message.role === "assistant"));
      }
      return summary;
    },
  };
}

export type PiSessionPromptParts = {
  appendSystemPrompt: string[];
  promptText: string;
  diagnostics: {
    appendSystemPromptCount: number;
    promptTextChars: number;
    latestUserMessageFound: boolean;
    nonUserPromptMessagesSkipped: number;
  };
};

function labelSystemPrompt(index: number, text: string): string {
  return [`<mindstone_context index="${index}">`, text.trim(), "</mindstone_context>"].join("\n");
}

function fallbackPromptText(message: MindStoneChatRequest["messages"][number] | undefined): string {
  if (!message) return "";
  if (message.text?.trim()) return message.text.trim();
  if (typeof message.content === "string") return message.content.trim();
  return "";
}

export function buildPiSessionPromptParts(messages: MindStoneChatRequest["messages"]): PiSessionPromptParts {
  const systemMessages = messages.filter((message) => message.role === "system" && message.text?.trim());
  const latestUser = [...messages].reverse().find((message) => message.role === "user" && (message.text?.trim() || typeof message.content === "string"));
  const latestMessage = [...messages].reverse().find((message) => message.text?.trim() || typeof message.content === "string");
  const nonUserPromptMessagesSkipped = messages.filter((message) => message.role === "assistant" || message.role === "tool").length;
  const promptText = fallbackPromptText(latestUser ?? latestMessage);
  return {
    appendSystemPrompt: systemMessages.map((message, index) => labelSystemPrompt(index + 1, message.text ?? "")),
    promptText,
    diagnostics: {
      appendSystemPromptCount: systemMessages.length,
      promptTextChars: promptText.length,
      latestUserMessageFound: Boolean(latestUser),
      nonUserPromptMessagesSkipped,
    },
  };
}

export class PiSessionExecutor implements MindStoneModelProvider {
  readonly id = "pi-session";
  readonly #projectRoot: string;
  readonly #agentDir: string;
  readonly #sessionDir: string;
  readonly #cwd: string;
  readonly #defaultProvider?: string;
  readonly #defaultModel?: string;
  readonly #compactionOptions?: MindStonePiCompactionConfig;
  readonly #resourceOptions: PiSessionResourceLoaderOptions;
  #modules?: PiSessionModules;
  #registry?: PiRegistry;

  constructor(options: PiSessionExecutorOptions = {}) {
    this.#projectRoot = resolve(options.projectRoot ?? projectRootFromEnv());
    this.#agentDir = resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(this.#projectRoot, ".runtime", "pi-agent"));
    this.#sessionDir = resolve(options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? join(this.#projectRoot, ".runtime", "pi-sessions"));
    this.#cwd = resolve(options.cwd ?? this.#projectRoot);
    this.#defaultProvider = options.defaultProvider;
    this.#defaultModel = options.defaultModel;
    this.#compactionOptions = options.compaction;
    this.#resourceOptions = {
      additionalExtensionPaths: options.additionalExtensionPaths,
      additionalSkillPaths: options.additionalSkillPaths,
      additionalPromptTemplatePaths: options.additionalPromptTemplatePaths,
      additionalThemePaths: options.additionalThemePaths,
      noExtensions: options.noExtensions,
      noSkills: options.noSkills,
      noPromptTemplates: options.noPromptTemplates,
      noThemes: options.noThemes,
      noContextFiles: options.noContextFiles,
      extensionFactories: [
        ...(options.extensionFactories ?? []),
        ...buildMindStonePiExtensionFactories({
          contextManagement: options.contextManagement,
          noExtensions: options.noExtensions,
        }),
      ],
    };
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

  async compactSession(input: AgentCompactionInput): Promise<AgentCompactionResult> {
    const startedAt = input.runContext?.startedAt ?? new Date().toISOString();
    const startedMs = Date.now();
    const unavailable = (reason: string, details?: Record<string, unknown>): AgentCompactionResult => ({
      requested: false,
      available: false,
      runnerId: "pi-session",
      substrate: "pi",
      reason,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      model: input.model,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedMs),
      runId: input.runContext?.runId,
      surface: input.runContext?.surface,
      details,
    });

    let model: PiModel;
    try {
      model = await this.#resolvePiModel(input.model.id);
    } catch (error) {
      return unavailable("pi_model_unavailable_for_compaction", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const { modules } = await this.#load();
    const sessionFile = piSessionFileForKey(this.#sessionDir, input.sessionKey);
    return withPiSessionFileLock(sessionFile, async () => {
      mkdirSync(dirname(sessionFile), { recursive: true });
      const sessionManager = modules.SessionManager.open(sessionFile, this.#sessionDir, this.#cwd);
      const settingsManager = modules.SettingsManager.create(this.#cwd, this.#agentDir);
      applyPiSessionCompactionSettings({ settingsManager: settingsManager as PiSettingsManagerLike, compaction: this.#compactionOptions });
      const resourceLoader = new modules.DefaultResourceLoader(buildPiSessionResourceLoaderOptions({
        cwd: this.#cwd,
        agentDir: this.#agentDir,
        settingsManager,
        appendSystemPrompt: [],
        options: this.#resourceOptions,
      }));
      await resourceLoader.reload();
      const { session } = await modules.createAgentSession({
        cwd: this.#cwd,
        agentDir: this.#agentDir,
        model,
        sessionManager,
        settingsManager,
        resourceLoader,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      const abortSession = (): void => {
        void session.abort?.().catch(() => undefined);
      };
      input.signal?.addEventListener("abort", abortSession, { once: true });
      try {
        throwIfAborted(input.signal);
        if (typeof session.compact !== "function") {
          return unavailable("pi_agent_session_compact_not_available", { sessionFile });
        }
        const result = await session.compact(input.customInstructions);
        throwIfAborted(input.signal);
        return {
          requested: true,
          available: true,
          runnerId: "pi-session",
          substrate: "pi",
          reason: "pi_agent_session_compact_completed",
          sessionKey: input.sessionKey,
          agentId: input.agentId,
          model: toModelInfo(model),
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedMs),
          runId: input.runContext?.runId,
          surface: input.runContext?.surface,
          details: {
            sessionFile,
            result,
          },
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return unavailable("pi_agent_session_compact_failed", {
          sessionFile,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        input.signal?.removeEventListener("abort", abortSession);
        session.dispose();
      }
    });
  }

  async completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult> {
    const { modules } = await this.#load();
    const model = await this.#resolvePiModel(request.model.id);
    const sessionFile = piSessionFileForKey(this.#sessionDir, request.sessionKey);
    return withPiSessionFileLock(sessionFile, async () => {
      mkdirSync(dirname(sessionFile), { recursive: true });
      const sessionManager = modules.SessionManager.open(sessionFile, this.#sessionDir, this.#cwd);
      const settingsManager = modules.SettingsManager.create(this.#cwd, this.#agentDir);
      applyPiSessionCompactionSettings({ settingsManager: settingsManager as PiSettingsManagerLike, compaction: this.#compactionOptions });
      const promptParts = buildPiSessionPromptParts(request.messages);
      const resourceLoader = new modules.DefaultResourceLoader(buildPiSessionResourceLoaderOptions({
        cwd: this.#cwd,
        agentDir: this.#agentDir,
        settingsManager,
        appendSystemPrompt: promptParts.appendSystemPrompt,
        options: this.#resourceOptions,
      }));
      await resourceLoader.reload();
      const { session, modelFallbackMessage } = await modules.createAgentSession({
        cwd: this.#cwd,
        agentDir: this.#agentDir,
        model,
        sessionManager,
        settingsManager,
        resourceLoader,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });

      const { capture, record } = createPiSessionEventCapture();
      const onEvent = piSessionEventCallbackFromMetadata(request.metadata);
      const unsubscribe = session.subscribe?.((event) => {
        const summary = record(event);
        onEvent?.({ summary, textDelta: textDeltaFromAssistantStreamEvent(event.assistantMessageEvent) });
      });
      const abortSession = (): void => {
        void session.abort?.().catch(() => undefined);
      };
      request.signal?.addEventListener("abort", abortSession, { once: true });

      try {
        throwIfAborted(request.signal);
        await session.prompt(promptParts.promptText || request.transcriptEntries.at(-1)?.text || "", { source: "rpc" });
        throwIfAborted(request.signal);
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
              prompt: promptParts.diagnostics,
              eventCounts: capture.eventCounts,
              events: capture.events,
              assistantTexts: capture.assistantTexts,
            },
          },
        };
      } finally {
        request.signal?.removeEventListener("abort", abortSession);
        unsubscribe?.();
        session.dispose();
      }
    });
  }
}
