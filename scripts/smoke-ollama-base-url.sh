#!/usr/bin/env bash
# OLLAMA_BASE_URL moves the Ollama chat preset as it moves memory embeddings (#171),
# so a gateway in a container reaches Ollama on the host for both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
env -u OLLAMA_BASE_URL -u EMBEDDER_BASE_URL -u OLLAMA_EMBEDDER_BASE_URL npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  DEFAULT_OLLAMA_BASE_URL,
  LOCAL_PROVIDER_PRESETS,
  ollamaBaseUrl,
  resolveMemoryEmbeddingProviderConfig,
} from "./packages/mindstone-core/src/index.ts";

// Unset: the default, as before.
assert.equal(DEFAULT_OLLAMA_BASE_URL, "http://localhost:11434/v1");
assert.equal(ollamaBaseUrl({}), DEFAULT_OLLAMA_BASE_URL);
assert.equal(ollamaBaseUrl({ OLLAMA_BASE_URL: "   " }), DEFAULT_OLLAMA_BASE_URL, "a blank value is unset");
assert.equal(LOCAL_PROVIDER_PRESETS.ollama.baseUrl, DEFAULT_OLLAMA_BASE_URL);

// Set: trimmed, trailing slashes dropped, the same value embeddings use.
const hostUrl = "http://host.docker.internal:11434/v1";
assert.equal(ollamaBaseUrl({ OLLAMA_BASE_URL: ` ${hostUrl}// ` }), hostUrl);
process.env.OLLAMA_BASE_URL = `${hostUrl}/`;
assert.equal(LOCAL_PROVIDER_PRESETS.ollama.baseUrl, hostUrl, "the preset follows the environment");
assert.equal({ ...LOCAL_PROVIDER_PRESETS.ollama }.baseUrl, hostUrl, "a copy of the preset carries the value");
const embedding = resolveMemoryEmbeddingProviderConfig({ memory: { embeddingProvider: "ollama:nomic-embed-text" } } as never);
assert.equal(embedding?.baseUrl, LOCAL_PROVIDER_PRESETS.ollama.baseUrl, "chat and embeddings reach the same Ollama");

// Other presets are unaffected.
assert.equal(LOCAL_PROVIDER_PRESETS.lmstudio.baseUrl, "http://localhost:1234/v1");
assert.equal(LOCAL_PROVIDER_PRESETS["ollama-cloud"].baseUrl, "https://ollama.com/v1");

delete process.env.OLLAMA_BASE_URL;
assert.equal(LOCAL_PROVIDER_PRESETS.ollama.baseUrl, DEFAULT_OLLAMA_BASE_URL);
console.log("ollama base url smoke passed");
TS
