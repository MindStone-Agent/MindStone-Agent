import type { MindStoneConfig } from "../config/index.js";
import { runtimePathsFromEnv } from "../paths/runtime.js";
import { enterpriseEmbeddingEndpoint, isEnterpriseEmbeddingProvider } from "../provider/enterprise.js";

export type MemoryEmbeddingProviderConfig = {
  id: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  /** Request headers instead of a Bearer apiKey (an enterprise endpoint's: Azure's api-key, a gateway's own). */
  headers?: Record<string, string>;
  /** false: a redirect is an error, so the key and headers only reach baseUrl. */
  followRedirects?: boolean;
  /** Why this provider can't embed (an enterprise provider that isn't registered): every request fails with it. */
  unavailable?: string;
  timeoutMs?: number;
};

export type MemoryEmbeddingProbeResult = {
  providerId: string;
  model: string;
  baseUrl: string;
  dimensions?: number;
  error?: string;
};

export interface MemoryEmbeddingProvider {
  id: string;
  model: string;
  embedTexts(texts: string[]): Promise<number[][]>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function resolveMemoryEmbeddingProviderConfig(
  config?: MindStoneConfig,
  env: NodeJS.ProcessEnv = process.env,
): MemoryEmbeddingProviderConfig | undefined {
  const spec = config?.memory?.embeddingProvider?.trim() || envValue(env, "MINDSTONE_EMBEDDING_PROVIDER", "EMBEDDING_PROVIDER");
  if (!spec) return undefined;

  const [rawProvider, ...modelParts] = spec.split(":");
  const provider = rawProvider.trim();
  const model = (modelParts.join(":").trim() || envValue(env, "EMBEDDER_MODEL") || "nomic-embed-text");

  if (provider === "ollama") {
    return {
      id: provider,
      model,
      baseUrl: trimTrailingSlash(envValue(env, "EMBEDDER_BASE_URL", "OLLAMA_EMBEDDER_BASE_URL", "OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434/v1"),
      apiKey: envValue(env, "EMBEDDER_API_KEY", "OLLAMA_API_KEY"),
      timeoutMs: Number(envValue(env, "EMBEDDER_TIMEOUT_MS") ?? 10_000),
    };
  }

  if (provider === "openai") {
    return {
      id: provider,
      model,
      baseUrl: trimTrailingSlash(envValue(env, "EMBEDDER_BASE_URL", "OPENAI_BASE_URL") ?? "https://api.openai.com/v1"),
      apiKey: envValue(env, "EMBEDDER_API_KEY", "OPENAI_API_KEY"),
      timeoutMs: Number(envValue(env, "EMBEDDER_TIMEOUT_MS") ?? 10_000),
    };
  }

  if (isEnterpriseEmbeddingProvider(provider)) {
    // A registered enterprise endpoint (#126): its own address and key, never the environment's.
    const agentDir = config?.routing?.pi?.agentDir ?? runtimePathsFromEnv(env).piAgentDir;
    const endpoint = enterpriseEmbeddingEndpoint(agentDir, provider);
    return {
      id: provider,
      model,
      baseUrl: "error" in endpoint ? "" : endpoint.baseUrl,
      ...("error" in endpoint ? { unavailable: endpoint.error } : { headers: endpoint.headers }),
      followRedirects: false,
      timeoutMs: Number(envValue(env, "EMBEDDER_TIMEOUT_MS") ?? 10_000),
    };
  }

  if (provider === "openai-compatible" || provider === "http") {
    return {
      id: provider,
      model,
      baseUrl: trimTrailingSlash(envValue(env, "EMBEDDER_BASE_URL") ?? "http://127.0.0.1:11434/v1"),
      apiKey: envValue(env, "EMBEDDER_API_KEY"),
      timeoutMs: Number(envValue(env, "EMBEDDER_TIMEOUT_MS") ?? 10_000),
    };
  }

  // Treat an unrecognized provider prefix as an OpenAI-compatible provider name so custom local gateways
  // can still be used as long as EMBEDDER_BASE_URL is supplied.
  return {
    id: provider,
    model,
    baseUrl: trimTrailingSlash(envValue(env, "EMBEDDER_BASE_URL") ?? "http://127.0.0.1:11434/v1"),
    apiKey: envValue(env, "EMBEDDER_API_KEY"),
    timeoutMs: Number(envValue(env, "EMBEDDER_TIMEOUT_MS") ?? 10_000),
  };
}

type OpenAiEmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: unknown }>;
  error?: { message?: string };
};

function validateEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("embedding response item is not an array");
  const embedding = value.map((entry) => Number(entry));
  if (embedding.length === 0 || embedding.some((entry) => !Number.isFinite(entry))) {
    throw new Error("embedding response contains non-numeric values");
  }
  return embedding;
}

export class OpenAiCompatibleEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly #baseUrl: string;
  readonly #apiKey?: string;
  readonly #headers?: Record<string, string>;
  readonly #followRedirects: boolean;
  readonly #unavailable?: string;
  readonly #timeoutMs: number;

  constructor(config: MemoryEmbeddingProviderConfig) {
    this.id = config.id;
    this.model = config.model;
    this.#baseUrl = trimTrailingSlash(config.baseUrl);
    this.#apiKey = config.apiKey;
    this.#headers = config.headers;
    this.#followRedirects = config.followRedirects !== false;
    this.#unavailable = config.unavailable;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    const normalized = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (normalized.length === 0) return [];
    if (this.#unavailable) throw new Error(this.#unavailable);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          ...this.#headers,
          "content-type": "application/json",
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: normalized }),
        redirect: this.#followRedirects ? "follow" : "error",
        signal: controller.signal,
      });
      const body = await response.json() as OpenAiEmbeddingResponse;
      if (!response.ok) {
        throw new Error(body.error?.message || `embedding request failed with HTTP ${response.status}`);
      }
      const data = body.data;
      if (!Array.isArray(data) || data.length !== normalized.length) {
        throw new Error(`embedding response returned ${data?.length ?? 0} vectors for ${normalized.length} inputs`);
      }
      return [...data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((entry) => validateEmbedding(entry.embedding));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createMemoryEmbeddingProvider(
  config?: MindStoneConfig,
  env: NodeJS.ProcessEnv = process.env,
): MemoryEmbeddingProvider | undefined {
  const resolved = resolveMemoryEmbeddingProviderConfig(config, env);
  return resolved ? new OpenAiCompatibleEmbeddingProvider(resolved) : undefined;
}

/**
 * One live embed with the configured provider. `timeoutMs` raises the embed
 * timeout for this probe only (never lowers it): the first embed after a
 * model loads can take longer than a chat's (#140: mxbai-embed-large took
 * about 13 s to load, past the 10 s default).
 */
export async function probeMemoryEmbeddingProvider(
  config?: MindStoneConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number } = {},
): Promise<MemoryEmbeddingProbeResult | undefined> {
  const resolved = resolveMemoryEmbeddingProviderConfig(config, env);
  if (!resolved) return undefined;
  try {
    const timeoutMs = Math.max(resolved.timeoutMs ?? 10_000, options.timeoutMs ?? 0);
    const provider = new OpenAiCompatibleEmbeddingProvider({ ...resolved, timeoutMs });
    const [embedding] = await provider.embedTexts(["MindStone embedding health check"]);
    return {
      providerId: resolved.id,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      dimensions: embedding?.length,
    };
  } catch (error) {
    // A provider's error can quote the request: its key and header values are never shown.
    const known = [resolved.apiKey, ...Object.values(resolved.headers ?? {})]
      .map((value) => value?.replace(/^Bearer /i, ""))
      .filter((value): value is string => typeof value === "string" && value.length >= 8)
      .sort((a, b) => b.length - a.length);
    const message = error instanceof Error ? error.message : String(error);
    return {
      providerId: resolved.id,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      error: known.reduce((text, value) => text.split(value).join("[redacted]"), message),
    };
  }
}
