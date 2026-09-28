import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardEnterpriseEndpoints } from "./enterprise-redirect-guard.js";
import type { MindStoneChatRequest, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider, MindStoneProviderInfo } from "@mindstone-agent/core";

type PiModel = {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
};

type PiAuthStatus = {
  configured: boolean;
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
};

type PiRegistry = {
  getAll(): PiModel[];
  getAvailable(): PiModel[];
  find(provider: string, modelId: string): PiModel | undefined;
  getProviderDisplayName(provider: string): string;
  getProviderAuthStatus(provider: string): PiAuthStatus;
  getApiKeyAndHeaders(model: PiModel): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string; env?: Record<string, string> } | { ok: false; error: string }>;
};

/** Pi's model and auth runtime (Pi 0.87, #127): it resolves each provider's auth, base URL included. */
type PiModelRuntime = {
  completeSimple(model: PiModel, context: unknown, options?: Record<string, unknown>): Promise<unknown>;
};

/** Pi 0.87's credential store: locked, 0600 writes to one auth.json. */
type PiAuthStorage = {
  modify(provider: string, fn: (current: unknown) => Promise<unknown>): Promise<unknown>;
  delete(provider: string): Promise<void>;
};

type PiProviderModules = {
  ModelRuntime: { create(options: { authPath: string; modelsPath: string | null; allowModelNetwork?: boolean }): Promise<PiModelRuntime> };
  ModelRegistry: new (runtime: PiModelRuntime) => PiRegistry;
  AuthStorage: { create(path: string): PiAuthStorage };
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
  const [{ ModelRuntime }, { ModelRegistry }, { AuthStorage }] = await Promise.all([
    importFromProject<{ ModelRuntime: PiProviderModules["ModelRuntime"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/model-runtime.js"),
    importFromProject<{ ModelRegistry: PiProviderModules["ModelRegistry"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/model-registry.js"),
    importFromProject<{ AuthStorage: PiProviderModules["AuthStorage"] }>(projectRoot, "vendor/pi/packages/coding-agent/dist/core/auth-storage.js"),
  ]);
  return { ModelRuntime, ModelRegistry, AuthStorage };
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

export type PiProviderCredential = { type: "api_key"; key: string; env?: Record<string, string> };

/**
 * Writes (or, with undefined, removes) a provider's entry in the isolated
 * Pi auth.json through Pi's own AuthStorage, which locks the file and keeps
 * it 0600. Throws when Pi could not persist the change.
 */
export async function setPiProviderCredential(agentDir: string, provider: string, credential: PiProviderCredential | undefined, projectRoot?: string): Promise<void> {
  const modules = await loadPiProviderModules(resolve(projectRoot ?? projectRootFromEnv()));
  const storage = modules.AuthStorage.create(join(resolve(agentDir), "auth.json"));
  if (credential) await storage.modify(provider, async () => credential);
  else await storage.delete(provider);
}

/**
 * A provider's auth.json entry exactly as stored (its key never resolved as
 * a template), or undefined when it has none. Throws when auth.json can't be read.
 */
export async function piProviderCredential(agentDir: string, provider: string): Promise<{ type: string; key?: string; env?: Record<string, string> } | undefined> {
  const path = join(resolve(agentDir), "auth.json");
  if (!existsSync(path)) return undefined;
  const data = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("the isolated auth.json can't be read");
  const credential = Object.hasOwn(data, provider) ? (data as Record<string, unknown>)[provider] : undefined;
  return credential && typeof credential === "object" ? { ...(credential as { type: string; key?: string; env?: Record<string, string> }) } : undefined;
}

/** The type of a provider's auth.json entry ("api_key", "oauth"), or undefined when it has none. */
export async function piProviderCredentialType(agentDir: string, provider: string): Promise<string | undefined> {
  return (await piProviderCredential(agentDir, provider))?.type;
}

export type PiModelTestResult =
  | { ok: true; model: string; reply: string; latencyMs: number }
  | { ok: false; model?: string; error: string; latencyMs?: number };

export class PiMindStoneProvider implements MindStoneModelProvider {
  readonly id = "pi";
  readonly #projectRoot: string;
  readonly #agentDir: string;
  readonly #defaultProvider?: string;
  readonly #defaultModel?: string;
  #registry?: PiRegistry;
  #runtime?: PiModelRuntime;

  constructor(options: PiMindStoneProviderOptions = {}) {
    this.#projectRoot = resolve(options.projectRoot ?? projectRootFromEnv());
    this.#agentDir = resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(this.#projectRoot, ".runtime", "pi-agent"));
    guardEnterpriseEndpoints(this.#agentDir);
    this.#defaultProvider = options.defaultProvider;
    this.#defaultModel = options.defaultModel;
  }

  async #load(): Promise<{ runtime: PiModelRuntime; registry: PiRegistry }> {
    if (this.#runtime && this.#registry) return { runtime: this.#runtime, registry: this.#registry };
    const modules = await loadPiProviderModules(this.#projectRoot);
    const authPath = join(this.#agentDir, "auth.json");
    const modelsPath = join(this.#agentDir, "models.json");
    // Only this install's agent dir: a missing models.json means none (null),
    // never Pi's global default. No catalog fetches at run time.
    const runtime = await modules.ModelRuntime.create({ authPath, modelsPath: existsSync(modelsPath) ? modelsPath : null, allowModelNetwork: false });
    const registry = new modules.ModelRegistry(runtime);
    this.#runtime = runtime;
    this.#registry = registry;
    return { runtime, registry };
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
      authStatus: registry.getProviderAuthStatus(provider),
      modelCount: all.filter((model) => model.provider === provider).length,
      availableModelCount: available.filter((model) => model.provider === provider).length,
    }));
  }

  async listModelsForProvider(provider: string): Promise<MindStoneModelInfo[]> {
    const { registry } = await this.#load();
    return registry.getAll().filter((model) => model.provider === provider).map(toModelInfo);
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

  /**
   * One short completion against exactly this provider and model (never a
   * fallback model), for the Console's live Test.
   */
  async testModel(provider: string, modelId: string, timeoutMs: number): Promise<PiModelTestResult> {
    const { runtime, registry } = await this.#load();
    const piModel = registry.find(provider, modelId);
    if (!piModel) return { ok: false, error: `${provider}/${modelId} isn't a registered model` };
    const id = `${provider}/${modelId}`;
    const auth = await registry.getApiKeyAndHeaders(piModel);
    if (!auth.ok) return { ok: false, model: id, error: auth.error };
    // A provider's error can quote the request; its own key, header values
    // and secret settings (keys, tokens, the key file's path) are never shown.
    const secretEnv = Object.entries(auth.env ?? {}).filter(([name]) => /KEY|SECRET|TOKEN|CREDENTIALS|PASSWORD/i.test(name)).map(([, value]) => value);
    const known = [auth.apiKey, ...Object.values(auth.headers ?? {}), ...secretEnv]
      .filter((value): value is string => typeof value === "string" && value.length >= 8)
      .sort((a, b) => b.length - a.length);
    const redact = (text: string) => known.reduce((out, value) => out.split(value).join("[redacted]"), text);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      // The runtime resolves the provider's key, headers and settings itself, as a chat does.
      const assistant = await runtime.completeSimple(piModel, {
        messages: [{ role: "user", content: "Reply with the single word: ready", timestamp: Date.now() }],
        tools: [],
      }, {
        signal: controller.signal,
        maxTokens: 64,
      });
      const latencyMs = Date.now() - started;
      const record = (assistant ?? {}) as { stopReason?: unknown; errorMessage?: unknown };
      if (record.stopReason === "error" || record.stopReason === "aborted") {
        const error = controller.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : typeof record.errorMessage === "string" && record.errorMessage ? record.errorMessage : "the model returned an error";
        return { ok: false, model: id, error: redact(error), latencyMs };
      }
      return { ok: true, model: id, reply: redact(textFromAssistantMessage(assistant).trim()).slice(0, 200), latencyMs };
    } catch (error) {
      return { ok: false, model: id, error: controller.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : redact(error instanceof Error ? error.message : String(error)), latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  async completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult> {
    const { runtime, registry } = await this.#load();
    const piModel = await this.#resolvePiModel(request.model.id);
    // Checked first for a clear error; the runtime resolves the same auth for the call.
    const auth = await registry.getApiKeyAndHeaders(piModel);
    if (!auth.ok) throw new Error(auth.error);

    const messages = request.messages.map((message) => ({
      role: message.role === "tool" ? "user" : message.role,
      content: message.text ?? (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")),
      timestamp: Date.now(),
    }));
    const context = { messages, tools: [] };
    const assistant = await runtime.completeSimple(piModel, context, {
      signal: request.signal,
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
