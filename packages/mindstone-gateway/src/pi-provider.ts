import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MindStoneChatRequest, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider } from "@mindstone-agent/core";

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
  getApiKeyAndHeaders(model: PiModel): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string }>;
};

type PiProviderModules = {
  AuthStorage: { create(path?: string): unknown };
  ModelRegistry: { create(authStorage: unknown, modelsPath?: string): PiRegistry };
  completeSimple: (model: PiModel, context: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

export type PiMindStoneProviderOptions = {
  projectRoot?: string;
  agentDir?: string;
  defaultProvider?: string;
  defaultModel?: string;
};

function projectRootFromEnv(): string {
  return resolve(process.env.MINDSTONE_AGENT_ROOT ?? process.cwd());
}

async function importFromProject<T>(projectRoot: string, path: string): Promise<T> {
  return import(pathToFileURL(join(projectRoot, path)).href) as Promise<T>;
}

async function loadPiProviderModules(projectRoot: string): Promise<PiProviderModules> {
  const [{ AuthStorage }, { ModelRegistry }, ai] = await Promise.all([
    importFromProject<{ AuthStorage: PiProviderModules["AuthStorage"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/auth-storage.js"),
    importFromProject<{ ModelRegistry: PiProviderModules["ModelRegistry"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/model-registry.js"),
    importFromProject<{ completeSimple: PiProviderModules["completeSimple"] }>(projectRoot, "vendor/pi/packages/ai/dist/index.js"),
  ]);
  return { AuthStorage, ModelRegistry, completeSimple: ai.completeSimple };
}

function toModelInfo(model: PiModel): MindStoneModelInfo {
  return {
    id: `${model.provider}/${model.id}`,
    provider: "pi",
    name: model.name,
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
  };
}

function textFromAssistantMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "thinking" && typeof record.thinking === "string") return "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function usageFromAssistantMessage(message: unknown): MindStoneChatResult["usage"] {
  if (!message || typeof message !== "object") return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: typeof record.input === "number" ? record.input : undefined,
    outputTokens: typeof record.output === "number" ? record.output : undefined,
    totalTokens: typeof record.totalTokens === "number" ? record.totalTokens : undefined,
  };
}

function splitProviderModel(modelId: string | undefined): { provider?: string; modelId?: string } {
  if (!modelId) return {};
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { modelId };
  return { provider: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) };
}

function readPiSettings(agentDir: string): { defaultProvider?: string; defaultModel?: string } {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    return {
      defaultProvider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined,
      defaultModel: typeof settings.defaultModel === "string" ? settings.defaultModel : undefined,
    };
  } catch {
    return {};
  }
}

export class PiMindStoneProvider implements MindStoneModelProvider {
  readonly id = "pi";
  readonly #projectRoot: string;
  readonly #agentDir: string;
  readonly #defaultProvider?: string;
  readonly #defaultModel?: string;
  #modules?: PiProviderModules;
  #registry?: PiRegistry;

  constructor(options: PiMindStoneProviderOptions = {}) {
    this.#projectRoot = resolve(options.projectRoot ?? projectRootFromEnv());
    this.#agentDir = resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(this.#projectRoot, ".runtime", "pi-agent"));
    this.#defaultProvider = options.defaultProvider;
    this.#defaultModel = options.defaultModel;
  }

  async #load(): Promise<{ modules: PiProviderModules; registry: PiRegistry }> {
    if (this.#modules && this.#registry) return { modules: this.#modules, registry: this.#registry };
    const modules = await loadPiProviderModules(this.#projectRoot);
    const authPath = join(this.#agentDir, "auth.json");
    const modelsPath = join(this.#agentDir, "models.json");
    const authStorage = modules.AuthStorage.create(authPath);
    const registry = modules.ModelRegistry.create(authStorage, existsSync(modelsPath) ? modelsPath : undefined);
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

  async #resolvePiModel(requestModelId?: string): Promise<PiModel> {
    const { registry } = await this.#load();
    const settings = readPiSettings(this.#agentDir);
    const parsed = splitProviderModel(requestModelId ?? this.#defaultModel ?? settings.defaultModel);
    const provider = parsed.provider ?? this.#defaultProvider ?? settings.defaultProvider;
    const modelId = parsed.modelId ?? this.#defaultModel ?? settings.defaultModel;
    const explicit = provider && modelId ? registry.find(provider, modelId) : undefined;
    if (explicit) return explicit;
    const available = registry.getAvailable();
    if (available.length > 0) return available[0];
    throw new Error("No isolated Pi model is available/configured for MindStone-Agent routing");
  }

  async completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult> {
    const { modules, registry } = await this.#load();
    const piModel = await this.#resolvePiModel(request.model.id);
    const auth = await registry.getApiKeyAndHeaders(piModel);
    if (!auth.ok) throw new Error(auth.error);

    const messages = request.messages.map((message) => ({
      role: message.role === "tool" ? "user" : message.role,
      content: message.text ?? (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")),
      timestamp: Date.now(),
    }));
    const context = { messages, tools: [] };
    const assistant = await modules.completeSimple(piModel, context, {
      signal: request.signal,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      sessionId: request.sessionKey,
    });

    return {
      role: "assistant",
      text: textFromAssistantMessage(assistant),
      model: toModelInfo(piModel),
      usage: usageFromAssistantMessage(assistant),
      raw: assistant,
    };
  }
}
