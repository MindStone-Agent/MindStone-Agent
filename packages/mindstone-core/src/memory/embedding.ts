import type { MindStoneConfig } from "../config/index.js";

export type MemoryEmbeddingProviderConfig = {
  id: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
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
  readonly #timeoutMs: number;

  constructor(config: MemoryEmbeddingProviderConfig) {
    this.id = config.id;
    this.model = config.model;
    this.#baseUrl = trimTrailingSlash(config.baseUrl);
    this.#apiKey = config.apiKey;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    const normalized = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (normalized.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: normalized }),
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

export async function probeMemoryEmbeddingProvider(
  config?: MindStoneConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryEmbeddingProbeResult | undefined> {
  const resolved = resolveMemoryEmbeddingProviderConfig(config, env);
  if (!resolved) return undefined;
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider(resolved);
    const [embedding] = await provider.embedTexts(["MindStone embedding health check"]);
    return {
      providerId: resolved.id,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      dimensions: embedding?.length,
    };
  } catch (error) {
    return {
      providerId: resolved.id,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
