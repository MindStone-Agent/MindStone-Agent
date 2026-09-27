import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/**
 * A literal value for a Pi config field such as `apiKey`. Pi treats these
 * fields as templates: a leading "!" runs a shell command and "$VAR" or
 * "${VAR}" reads an environment variable. A key that should be used as it
 * is (a stored secret) is escaped: "$$" is a literal "$" and a leading "$!"
 * a literal "!" (resolve-config-value.ts).
 */
export function literalConfigValue(value: string): string {
  const escaped = value.replace(/\$/g, "$$$$");
  return escaped.startsWith("!") ? `$!${escaped.slice(1)}` : escaped;
}

/** A model id a provider listing may register: short, printable, no spaces or control/bidi characters. */
export const MODEL_ID_PATTERN = /^[^\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]{1,200}$/;

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
  // Written to a new 0600 file and renamed over the old one, so a crash can't
  // leave a truncated models.json and the key is never in a wider-mode file.
  const temp = `${current.path}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(temp, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, current.path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never written.
    }
    throw error;
  }
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
/** The most of a model listing that is read; a bigger one is refused. */
const PROBE_MAX_BYTES = 1024 * 1024;

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
    // Read at most PROBE_MAX_BYTES: the server can be anywhere, and its answer
    // is kept in memory and written to models.json.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PROBE_MAX_BYTES) {
          await reader.cancel();
          return { ok: false, baseUrl, error: `The model list at ${baseUrl}/models is too large` };
        }
        chunks.push(value);
      }
    }
    let body: { data?: Array<{ id?: unknown }> };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { data?: Array<{ id?: unknown }> };
    } catch {
      return { ok: false, baseUrl, error: `${baseUrl}/models did not answer with a model list` };
    }
    const seen = new Set<string>();
    const models = (Array.isArray(body?.data) ? body.data : [])
      .map((entry) => (entry && typeof entry.id === "string" ? entry.id.trim() : ""))
      .filter((id) => MODEL_ID_PATTERN.test(id) && !seen.has(id) && Boolean(seen.add(id)))
      .slice(0, 500)
      .map((id) => ({ id }));
    if (models.length === 0) {
      return { ok: false, baseUrl, error: `Endpoint responded but listed no usable models (${baseUrl}/models)` };
    }
    return { ok: true, baseUrl, models };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? `Timed out after ${params.timeoutMs ?? 5_000}ms`
      : "Could not connect";
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
