#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CONFIG="$TMP_DIR/config.json"

cd "$ROOT"
MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { runMindStoneConfigWizard, type MindStoneModelInfo, type MindStoneProviderInfo, type MindStonePrompter, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

const discovered: MindStoneModelInfo[] = [
  {
    id: "openai-codex/gpt-5.5",
    provider: "openai-codex",
    name: "GPT 5.5 via isolated Pi",
    contextWindowTokens: 272000,
    maxOutputTokens: 128000,
  },
];
const providers: MindStoneProviderInfo[] = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    authStatus: { configured: false },
    modelCount: 1,
    availableModelCount: 1,
  },
];
const texts: string[] = [];
const selects = ["pi", "provider:openai-codex", "env", "keep", "model:openai-codex/gpt-5.5", "done"];
const confirms = [true];
let authRequest: unknown;

const prompter: MindStonePrompter = {
  note: async () => undefined,
  confirm: async () => {
    const next = confirms.shift();
    if (next === undefined) throw new Error("Unexpected confirm prompt");
    return next;
  },
  select: async <T extends string>({ options }: { message: string; options: Array<MindStoneSelectOption<T>>; initialValue?: T }): Promise<T> => {
    const next = selects.shift();
    if (next === undefined) throw new Error("Unexpected select prompt");
    const found = options.find((option) => option.value === next);
    if (!found) throw new Error(`Selection not available: ${next}; options=${options.map((option) => option.value).join(",")}`);
    return found.value;
  },
  text: async () => {
    const next = texts.shift();
    if (next === undefined) throw new Error("Unexpected text prompt; Pi model selection should be arrow-driven");
    return next;
  },
};

const result = await runMindStoneConfigWizard(prompter, {
  sections: ["routing"],
  availableModels: discovered,
  availableProviders: providers,
  setupProviderAuth: async (request) => {
    authRequest = request;
    return "auth saved";
  },
});
if (!result.wrote) throw new Error("Wizard did not write config");
if (texts.length || selects.length || confirms.length) throw new Error("Smoke prompt queues were not fully consumed");

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
if (config.routing?.mode !== "pi") throw new Error("Routing pi mode was not written");
if (config.routing?.defaultModel !== "openai-codex/gpt-5.5") throw new Error("Discovered Pi model was not written");
if (!config.routing?.pi?.agentDir) throw new Error("Pi agent dir was not written");
if (JSON.stringify(authRequest) !== JSON.stringify({ providerId: "openai-codex", mode: "env", envVar: "OPENAI_API_KEY" })) {
  throw new Error(`Provider auth setup request was not captured: ${JSON.stringify(authRequest)}`);
}

console.log(`config pi model smoke passed: ${result.path}`);
TS

MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$TMP_DIR/pi-session-config.json" npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { runMindStoneConfigWizard, type MindStoneModelInfo, type MindStoneProviderInfo, type MindStonePrompter, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

const discovered: MindStoneModelInfo[] = [
  {
    id: "openai/gpt-5.1",
    provider: "openai",
    name: "GPT 5.1 via isolated Pi",
    contextWindowTokens: 272000,
    maxOutputTokens: 128000,
  },
];
const providers: MindStoneProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    authStatus: { configured: true },
    modelCount: 1,
    availableModelCount: 1,
  },
];
const texts = ["456", "26000"];
const selects = ["pi-session", "provider:openai", "model:openai/gpt-5.1", "advanced", "keep", "keep", "custom", "enabled", "enabled", "enabled"];
const confirms = [true];

const prompter: MindStonePrompter = {
  note: async () => undefined,
  confirm: async () => {
    const next = confirms.shift();
    if (next === undefined) throw new Error("Unexpected confirm prompt");
    return next;
  },
  select: async <T extends string>({ options }: { message: string; options: Array<MindStoneSelectOption<T>>; initialValue?: T }): Promise<T> => {
    const next = selects.shift();
    if (next === undefined) throw new Error("Unexpected select prompt");
    const found = options.find((option) => option.value === next);
    if (!found) throw new Error(`Selection not available: ${next}; options=${options.map((option) => option.value).join(",")}`);
    return found.value;
  },
  text: async () => {
    const next = texts.shift();
    if (next === undefined) throw new Error("Unexpected text prompt");
    return next;
  },
};

const result = await runMindStoneConfigWizard(prompter, {
  sections: ["routing"],
  availableModels: discovered,
  availableProviders: providers,
});
if (!result.wrote) throw new Error("Wizard did not write pi-session config");
if (texts.length || selects.length || confirms.length) throw new Error("Pi-session safety prompt queues were not fully consumed");

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
if (config.routing?.mode !== "pi-session") throw new Error("Routing pi-session mode was not written");
if (config.routing?.defaultModel !== "openai/gpt-5.1") throw new Error("Pi-session model was not written");
if (config.routing?.pi?.resumeCap?.enabled !== true) throw new Error("Pi-session resume cap enabled was not written");
if (config.routing?.pi?.resumeCap?.maxEntries !== 456) throw new Error("Pi-session resume cap maxEntries was not written");
if (config.routing?.pi?.resumeCap?.dropErrorTurns !== true) throw new Error("Pi-session dropErrorTurns was not written");
if (config.routing?.pi?.compaction?.reserveTokensFloor !== 26000) throw new Error("Pi-session compaction reserve floor was not written");
if (config.routing?.pi?.compaction?.safeguardFallback !== true) throw new Error("Pi-session safeguard fallback was not written");

console.log(`config pi-session safety smoke passed: ${result.path}`);
TS

MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$TMP_DIR/no-model-config.json" npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { runMindStoneConfigWizard, type MindStonePrompter, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

const selects = ["pi-session", "skip", "done"];
const confirms = [true];
let noteText = "";

const prompter: MindStonePrompter = {
  note: async (message) => { noteText += `${message}\n`; },
  confirm: async () => {
    const next = confirms.shift();
    if (next === undefined) throw new Error("Unexpected confirm prompt");
    return next;
  },
  select: async <T extends string>({ options }: { message: string; options: Array<MindStoneSelectOption<T>>; initialValue?: T }): Promise<T> => {
    const next = selects.shift();
    if (next === undefined) throw new Error("Unexpected select prompt");
    const found = options.find((option) => option.value === next);
    if (!found) throw new Error(`Selection not available: ${next}; options=${options.map((option) => option.value).join(",")}`);
    return found.value;
  },
  text: async () => {
    throw new Error("Unexpected text prompt; no-model fallback should not ask advanced Pi text prompts");
  },
};

const result = await runMindStoneConfigWizard(prompter, {
  sections: ["routing"],
  availableModels: [],
  availableProviders: [],
  modelDiscoveryError: "smoke discovery unavailable",
});
if (!result.wrote) throw new Error("Wizard did not write no-model config");
if (selects.length || confirms.length) throw new Error("No-model prompt queues were not fully consumed");
if (!noteText.includes("No model was selected")) throw new Error(`Expected no-model setup note, got: ${noteText}`);

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
if (config.routing?.mode !== "placeholder") throw new Error(`Expected placeholder fallback when no model selected, got ${config.routing?.mode}`);
if (config.routing?.defaultModel !== undefined) throw new Error("Expected no defaultModel when no model selected");

console.log(`config no-model fallback smoke passed: ${result.path}`);
TS

MINDSTONE_AGENT_ROOT="$ROOT" TMP_AGENT_DIR="$TMP_DIR/pi-agent" npx tsx <<'TS'
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
  getIsolatedModelsStatus,
  isolatedModelsPath,
  readIsolatedModelsConfig,
  upsertIsolatedProvider,
} from "./packages/mindstone-core/src/index.ts";
import { PiMindStoneProvider } from "./packages/mindstone-gateway/src/pi-provider.ts";

const agentDir = process.env.TMP_AGENT_DIR!;

// Fresh dir: no models.json yet.
const initial = readIsolatedModelsConfig(agentDir);
assert.equal(initial.exists, false);
assert.deepEqual(initial.config.providers, {});

// Register a local Ollama-style provider with two models.
const first = upsertIsolatedProvider(agentDir, "ollama", {
  name: "Ollama (local)",
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
  apiKey: "ollama",
  models: [{ id: "llama3.1:8b" }, { id: "qwen3:14b" }],
});
assert.equal(first.wrote, true);
assert.equal(first.modelCount, 2);

// Upsert again with one overlapping + one new model: merged, no duplicates, fields preserved.
const second = upsertIsolatedProvider(agentDir, "ollama", {
  models: [{ id: "qwen3:14b", contextWindow: 32768 }, { id: "gemma3:27b" }],
});
assert.equal(second.modelCount, 3, "expected merged model list without duplicates");
const merged = readIsolatedModelsConfig(agentDir);
const ollama = merged.config.providers.ollama;
assert.equal(ollama.baseUrl, "http://localhost:11434/v1", "existing fields preserved on partial upsert");
assert.equal(ollama.apiKey, "ollama");
assert.equal(ollama.models?.find((m) => m.id === "qwen3:14b")?.contextWindow, 32768, "overlapping model updated in place");

// Register LM Studio with a distinctive literal key and Ollama Cloud with an env-var reference.
upsertIsolatedProvider(agentDir, "lmstudio", {
  name: "LM Studio (local)",
  baseUrl: "http://localhost:1234/v1",
  api: "openai-completions",
  apiKey: "sk-lmstudio-secret-smoke",
  models: [{ id: "qwen2.5-coder-14b" }],
});
upsertIsolatedProvider(agentDir, "ollama-cloud", {
  name: "Ollama Cloud",
  baseUrl: "https://ollama.com/v1",
  api: "openai-completions",
  apiKey: "$OLLAMA_API_KEY",
  models: [{ id: "gpt-oss:120b" }],
});

// File permissions are owner-only (the file may hold key material).
const mode = statSync(isolatedModelsPath(agentDir)).mode & 0o777;
assert.equal(mode, 0o600, `expected models.json mode 600, got ${mode.toString(8)}`);

// Sanitized status: classifies auth without leaking key material.
const status = getIsolatedModelsStatus(agentDir);
assert.equal(status.providers.length, 3);
const statusJson = JSON.stringify(status);
assert.ok(!statusJson.includes("sk-lmstudio-secret-smoke"), "status must not leak literal keys");
assert.ok(!statusJson.includes("$OLLAMA_API_KEY"), "status must not include raw apiKey template values");
assert.equal(status.providers.find((p) => p.providerId === "lmstudio")!.auth, "models.json key (stored)");
assert.equal(status.providers.find((p) => p.providerId === "ollama-cloud")!.auth, "env: OLLAMA_API_KEY");

// Pi ModelRegistry picks the custom providers up from the isolated agent dir.
process.env.OLLAMA_API_KEY = "smoke-test-cloud-key";
const provider = new PiMindStoneProvider({ agentDir });
const providers = await provider.listProviders();
const piOllama = providers.find((p) => p.id === "ollama");
assert.ok(piOllama, "expected ollama provider in Pi registry discovery");
assert.equal(piOllama.authStatus?.configured, true, "models.json apiKey should make the provider available");
assert.equal(piOllama.modelCount, 3);
assert.ok(providers.some((p) => p.id === "ollama-cloud"), "expected ollama-cloud provider in Pi registry discovery");
const models = await provider.listModels();
assert.ok(models.some((m) => m.id === "ollama/llama3.1:8b"), "expected ollama/llama3.1:8b in registry models");
const available = await provider.listAvailableModels();
assert.ok(available.some((m) => m.id === "ollama/gemma3:27b"), "keyed local provider models should be available");
assert.ok(available.some((m) => m.id === "ollama-cloud/gpt-oss:120b"), "env-keyed cloud provider should be available when the variable is set");

// A malformed models.json is surfaced and never overwritten.
writeFileSync(isolatedModelsPath(agentDir), "{ not json", "utf-8");
const broken = readIsolatedModelsConfig(agentDir);
assert.ok(broken.error, "expected parse error surfaced");
const refused = upsertIsolatedProvider(agentDir, "ollama", { models: [{ id: "x" }] });
assert.equal(refused.wrote, false, "upsert must refuse to clobber an unparseable models.json");
assert.ok(refused.error);
assert.equal(readFileSync(isolatedModelsPath(agentDir), "utf-8"), "{ not json", "original file preserved");

console.log(`isolated models.json custom provider smoke passed: ${agentDir}`);
TS
