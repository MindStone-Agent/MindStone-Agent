import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Isolated Pi models.json management for local (Ollama / LM Studio / OpenAI-compatible)
 * and Ollama Cloud providers.
 *
 * Pi's ModelRegistry merges custom providers from `<agentDir>/models.json` with its
 * built-in catalog, so registering a local endpoint here makes it a first-class
 * provider for both `pi` and `pi-session` routing without any MindStone-side client.
 * A provider is only "available" to Pi when it has an apiKey value (models.json) or
 * auth.json entry — local servers ignore the key, so presets carry a placeholder.
 */

export type IsolatedModelDefinition = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
};

export type IsolatedProviderConfig = {
  name?: string;
  baseUrl?: string;
  api?: string;
  /** Literal key, or Pi config-value template like "$OLLAMA_API_KEY". Never log this. */
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: IsolatedModelDefinition[];
  modelOverrides?: Record<string, unknown>;
};

export type IsolatedModelsConfig = {
  providers: Record<string, IsolatedProviderConfig>;
};

export type LocalProviderPresetId = "ollama" | "lmstudio" | "openai-compatible" | "ollama-cloud";

export type LocalProviderPreset = {
  presetId: LocalProviderPresetId;
  providerId: string;
  name: string;
  baseUrl: string;
  api: string;
  /** Placeholder key for keyless local servers; makes the provider "available" to Pi. */
  placeholderApiKey?: string;
};

export const LOCAL_PROVIDER_PRESETS: Record<LocalProviderPresetId, LocalProviderPreset> = {
  ollama: {
    presetId: "ollama",
    providerId: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    placeholderApiKey: "ollama",
  },
  lmstudio: {
    presetId: "lmstudio",
    providerId: "lmstudio",
    name: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    placeholderApiKey: "lm-studio",
  },
  "openai-compatible": {
    presetId: "openai-compatible",
    providerId: "local-openai",
    name: "Local OpenAI-compatible server",
    baseUrl: "http://localhost:8080/v1",
    api: "openai-completions",
    placeholderApiKey: "local",
  },
  "ollama-cloud": {
    presetId: "ollama-cloud",
    providerId: "ollama-cloud",
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    api: "openai-completions",
  },
};

export function isolatedModelsPath(agentDir: string): string {
  return join(agentDir, "models.json");
}

export type IsolatedModelsReadResult = {
  path: string;
  exists: boolean;
  config: IsolatedModelsConfig;
  error?: string;
};

export function readIsolatedModelsConfig(agentDir: string): IsolatedModelsReadResult {
  const path = isolatedModelsPath(agentDir);
  if (!existsSync(path)) {
    return { path, exists: false, config: { providers: {} } };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const providers = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { providers?: unknown }).providers
      : undefined;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      return { path, exists: true, config: { providers: {} }, error: "models.json has no valid providers object" };
    }
    return { path, exists: true, config: { providers: providers as Record<string, IsolatedProviderConfig> } };
  } catch (error) {
    return {
      path,
      exists: true,
      config: { providers: {} },
      error: `models.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function mergeModelLists(
  existing: IsolatedModelDefinition[] | undefined,
  incoming: IsolatedModelDefinition[] | undefined,
): IsolatedModelDefinition[] | undefined {
  if (!incoming?.length) return existing;
  const merged = [...(existing ?? [])];
  for (const model of incoming) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index === -1) merged.push(model);
    else merged[index] = { ...merged[index], ...model };
  }
  return merged;
}

export type UpsertIsolatedProviderResult = {
  path: string;
  wrote: boolean;
  providerId: string;
  modelCount: number;
  error?: string;
};

/**
 * Merge a provider definition into the isolated models.json. Existing providers and
 * models are preserved; incoming fields win on conflict. Refuses to write over a
 * models.json that exists but cannot be parsed, so a hand-edited file is never lost.
 */
export function upsertIsolatedProvider(
  agentDir: string,
  providerId: string,
  provider: IsolatedProviderConfig,
  options: { dryRun?: boolean } = {},
): UpsertIsolatedProviderResult {
  const current = readIsolatedModelsConfig(agentDir);
  if (current.error) {
    return { path: current.path, wrote: false, providerId, modelCount: 0, error: current.error };
  }
  const existing = current.config.providers[providerId];
  const merged: IsolatedProviderConfig = {
    ...existing,
    ...provider,
    models: mergeModelLists(existing?.models, provider.models),
  };
  const nextConfig: IsolatedModelsConfig = {
    providers: { ...current.config.providers, [providerId]: merged },
  };
  const modelCount = merged.models?.length ?? 0;
  if (options.dryRun) {
    return { path: current.path, wrote: false, providerId, modelCount };
  }
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(current.path, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  // Re-assert permissions: writeFileSync mode only applies on creation.
  chmodSync(current.path, 0o600);
  return { path: current.path, wrote: true, providerId, modelCount };
}

export type ProbeModelsResult =
  | { ok: true; baseUrl: string; models: Array<{ id: string }> }
  | { ok: false; baseUrl: string; error: string };

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * List models from an OpenAI-compatible endpoint (`GET <baseUrl>/models`). Works for
 * Ollama (local and Cloud), LM Studio, vLLM, and other OpenAI-compatible servers.
 */
export async function probeOpenAiCompatibleModels(params: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<ProbeModelsResult> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 5_000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, baseUrl, error: `HTTP ${response.status} from ${baseUrl}/models` };
    }
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = (Array.isArray(body.data) ? body.data : [])
      .map((entry) => (typeof entry.id === "string" && entry.id.trim() ? { id: entry.id } : undefined))
      .filter((entry): entry is { id: string } => Boolean(entry));
    if (models.length === 0) {
      return { ok: false, baseUrl, error: `Endpoint responded but listed no models (${baseUrl}/models)` };
    }
    return { ok: true, baseUrl, models };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? `Timed out after ${params.timeoutMs ?? 5_000}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, baseUrl, error: `${message} (${baseUrl}/models)` };
  } finally {
    clearTimeout(timeout);
  }
}

export type IsolatedProviderStatus = {
  providerId: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  modelCount: number;
  /** Sanitized auth summary — never contains key material. */
  auth: string;
};

export type IsolatedModelsStatus = {
  path: string;
  exists: boolean;
  providers: IsolatedProviderStatus[];
  error?: string;
};

function sanitizedAuthSummary(apiKey: string | undefined): string {
  if (!apiKey) return "none (uses isolated auth.json if present)";
  const envVars = apiKey.match(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g);
  if (envVars?.length) return `env: ${envVars.map((entry) => entry.replace(/[${}]/g, "")).join(", ")}`;
  return "models.json key (stored)";
}

/** Sanitized view of custom providers in the isolated models.json for status/doctor. */
export function getIsolatedModelsStatus(agentDir: string): IsolatedModelsStatus {
  const read = readIsolatedModelsConfig(agentDir);
  return {
    path: read.path,
    exists: read.exists,
    error: read.error,
    providers: Object.entries(read.config.providers).map(([providerId, provider]) => ({
      providerId,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      modelCount: provider.models?.length ?? 0,
      auth: sanitizedAuthSummary(provider.apiKey),
    })),
  };
}
