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

/**
 * The embedding model a vector comes from, as recorded with each chunk
 * (#140) and each KB's vectors (#151): `<provider id>:<model>`. A chunk
 * embedded by another model (or before this was recorded) is embedded again
 * by the next backfill, and until then recall finds it by its words.
 */
export function memoryEmbeddingSpec(provider: Pick<MemoryEmbeddingProvider, "id" | "model">): string {
  return `${provider.id}:${provider.model}`;
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
    // A timeout that isn't a positive number (EMBEDDER_TIMEOUT_MS=abc) would abort every request at once.
    this.#timeoutMs = typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 10_000;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    const normalized = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (normalized.length === 0) return [];
    // Marked, so a background re-embed can tell an embedder it can't reach from one that refuses the text (#158).
    if (this.#unavailable) throw Object.assign(new Error(this.#unavailable), { unavailable: true });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(`${this.#baseUrl}/embeddings`, {
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
      } catch (error) {
        // Not reached: marked, so the re-embed tells it from a reply it can't use (#158 review).
        if (error instanceof Error && error.name !== "AbortError") Object.assign(error, { unavailable: true });
        throw error;
      }
      if (!response.ok) {
        // The status goes with the error (#158): a 429 or a 5xx is the embedder's state, a 400 the text's.
        let message: string | undefined;
        try {
          message = ((await response.json()) as OpenAiEmbeddingResponse).error?.message;
        } catch {
          // Not JSON (a proxy's error page): the status says enough.
        }
        // A 429's Retry-After, in ms, so a re-embed can wait that long (#158 review).
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000;
        throw Object.assign(new Error(message || `embedding request failed with HTTP ${response.status}`), {
          status: response.status,
          ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: Math.round(seconds * 1000) } : {}),
        });
      }
      const body = await response.json() as OpenAiEmbeddingResponse;
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
  /** A request timeout of its own (KB ingest embeds many entries a request, #125 §5); default EMBEDDER_TIMEOUT_MS or 10 s. */
  options: { timeoutMs?: number } = {},
): MemoryEmbeddingProvider | undefined {
  const resolved = resolveMemoryEmbeddingProviderConfig(config, env);
  if (!resolved) return undefined;
  // Never shorter than the one set for the install (EMBEDDER_TIMEOUT_MS on a slow machine).
  const configured = typeof resolved.timeoutMs === "number" && Number.isFinite(resolved.timeoutMs) ? resolved.timeoutMs : 0;
  return new OpenAiCompatibleEmbeddingProvider(options.timeoutMs ? { ...resolved, timeoutMs: Math.max(configured, options.timeoutMs) } : resolved);
}

/**
 * A turn's embedder (#125 §5): a single text is embedded once however many
 * recall providers ask for it at once, so memory and KB recall share one
 * query embedding. Several texts pass straight through.
 */
export function sharedQueryEmbedder(provider: MemoryEmbeddingProvider | undefined): MemoryEmbeddingProvider | undefined {
  if (!provider) return undefined;
  const pending = new Map<string, Promise<number[][]>>();
  return {
    id: provider.id,
    model: provider.model,
    embedTexts(texts: string[]): Promise<number[][]> {
      if (texts.length !== 1) return provider.embedTexts(texts);
      const key = texts[0];
      let result = pending.get(key);
      if (!result) {
        result = provider.embedTexts(texts);
        pending.set(key, result);
      }
      return result;
    },
  };
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
  // A configured timeout that isn't a positive number counts as the default, so the raise still applies.
  const configured = typeof resolved.timeoutMs === "number" && Number.isFinite(resolved.timeoutMs) && resolved.timeoutMs > 0 ? resolved.timeoutMs : 10_000;
  const timeoutMs = Math.max(configured, options.timeoutMs ?? 0);
  try {
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
    // The request's own timeout names its limit; an upstream error is cut short (#140 review).
    const aborted = error instanceof Error && error.name === "AbortError";
    const message = aborted
      ? `no answer within ${Math.round(timeoutMs / 1000)} s`
      : error instanceof Error ? error.message : String(error);
    const redacted = known.reduce((text, value) => text.split(value).join("[redacted]"), message);
    return {
      providerId: resolved.id,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      error: redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted,
    };
  }
}
