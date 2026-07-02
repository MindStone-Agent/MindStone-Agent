#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
STUB_PID=""
cleanup() {
  [[ -n "${STUB_PID}" ]] && kill "${STUB_PID}" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
CONFIG="$TMP_DIR/config.json"

cd "$ROOT"
MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { runMindStoneOnboardingWizard, type MindStonePrompter, type MindStoneProviderAuthSetupRequest, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

// Queue order mirrors the current onboarding flow: risk confirm, profile/preference
// selects, one work-context text, the model lane, write-config confirm, two
// identity-seed texts, then the identity-activation confirm.
const texts = [
  "Building MindStone-Agent with real model-backed chat.",
  "help configure and validate the model-backed onboarding path",
  "Prefer direct, verified work; do not touch credentials outside isolated runtime.",
];
const selects = [
  "software_engineering_partner",
  "balanced",
  "direct",
  "act_directly",
  "standard",
  "propose_checkpoint_memories",
  "none",
  "defer",
  "quickstart",
  "connect",
  "provider:openai-codex",
  "login",
  "model:openai-codex/gpt-5.5",
];
const confirms = [true, true, true];
const authRequests: MindStoneProviderAuthSetupRequest[] = [];

const prompter: MindStonePrompter = {
  intro: async () => undefined,
  outro: async () => undefined,
  note: async () => undefined,
  confirm: async () => {
    const next = confirms.shift();
    if (next === undefined) throw new Error("Unexpected confirm prompt");
    return next;
  },
  select: async <T extends string>({ message, options }: { message: string; options: Array<MindStoneSelectOption<T>>; initialValue?: T }): Promise<T> => {
    const next = selects.shift();
    if (next === undefined) throw new Error(`Unexpected select prompt: ${message}`);
    const found = options.find((option) => option.value === next);
    if (!found) throw new Error(`Selection not available for ${message}: ${next}; available=${options.map((option) => option.value).join(",")}`);
    return found.value;
  },
  text: async () => {
    const next = texts.shift();
    if (next === undefined) throw new Error("Unexpected text prompt");
    return next;
  },
};

const result = await runMindStoneOnboardingWizard(prompter, {
  configPath: process.env.MINDSTONE_AGENT_CONFIG!,
  showHeader: false,
  availableProviders: [
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      authStatus: { configured: false, source: "missing", label: "not connected" },
      modelCount: 1,
      availableModelCount: 0,
    },
  ],
  availableModels: [
    {
      id: "openai-codex/gpt-5.5",
      name: "GPT-5.5",
      provider: "openai-codex",
      contextWindowTokens: 400000,
      maxOutputTokens: 128000,
    },
  ],
  setupProviderAuth: async (request) => {
    authRequests.push(request);
    return `auth setup requested: ${request.providerId}/${request.mode}`;
  },
});

if (!result.wrote) throw new Error("Onboarding did not write config");
if (texts.length || selects.length || confirms.length) throw new Error("Smoke prompt queues were not fully consumed");
if (authRequests.length !== 1 || authRequests[0].providerId !== "openai-codex" || authRequests[0].mode !== "login") {
  throw new Error(`Expected OpenAI Codex login auth request, got ${JSON.stringify(authRequests)}`);
}

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
if (config.routing?.mode !== "pi-session") throw new Error(`Expected pi-session routing, got ${config.routing?.mode}`);
if (config.routing?.defaultModel !== "openai-codex/gpt-5.5") throw new Error(`Expected selected OpenAI Codex model, got ${config.routing?.defaultModel}`);
if (!config.routing?.pi?.agentDir?.endsWith(".runtime/pi-agent")) throw new Error("Expected isolated pi agentDir in routing config");

console.log(`onboard model setup smoke passed: ${result.path}`);
TS

# --- Local model lane: onboarding registers a live OpenAI-compatible endpoint ---

node "$ROOT/scripts/stub-openai-server.mjs" >"$TMP_DIR/stub.json" &
STUB_PID=$!
disown
for _ in $(seq 1 50); do
  [[ -s "$TMP_DIR/stub.json" ]] && break
  sleep 0.1
done
STUB_PORT="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8")).port)' "$TMP_DIR/stub.json")"
export STUB_URL="http://127.0.0.1:${STUB_PORT}/v1"

mkdir -p "$TMP_DIR/local"
MINDSTONE_AGENT_ROOT="$ROOT" \
MINDSTONE_AGENT_CONFIG="$TMP_DIR/local/config.json" \
PI_CODING_AGENT_DIR="$TMP_DIR/local/pi-agent" \
npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { runMindStoneOnboardingWizard, readIsolatedModelsConfig, type MindStonePrompter, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

const stubUrl = process.env.STUB_URL!;
const agentDir = process.env.PI_CODING_AGENT_DIR!;

const texts = [
  "Validating the local model onboarding lane against a stub endpoint.",
  stubUrl,
  "stub-key",
  "help validate the local model onboarding lane",
  "No credentials outside the isolated runtime.",
];
const selects = [
  "software_engineering_partner",
  "balanced",
  "direct",
  "act_directly",
  "standard",
  "propose_checkpoint_memories",
  "none",
  "defer",
  "quickstart",
  "local",
  "openai-compatible",
  "model:stub-model",
];
const confirms = [true, true, true];
let notes = "";

const prompter: MindStonePrompter = {
  intro: async () => undefined,
  outro: async () => undefined,
  note: async (message) => { notes += `${message}\n`; },
  confirm: async () => {
    const next = confirms.shift();
    if (next === undefined) throw new Error("Unexpected confirm prompt");
    return next;
  },
  select: async <T extends string>({ message, options }: { message: string; options: Array<MindStoneSelectOption<T>>; initialValue?: T }): Promise<T> => {
    const next = selects.shift();
    if (next === undefined) throw new Error(`Unexpected select prompt: ${message}`);
    const found = options.find((option) => option.value === next);
    if (!found) throw new Error(`Selection not available for ${message}: ${next}; available=${options.map((option) => option.value).join(",")}`);
    return found.value;
  },
  text: async ({ message }) => {
    const next = texts.shift();
    if (next === undefined) throw new Error(`Unexpected text prompt: ${message}`);
    return next;
  },
};

const result = await runMindStoneOnboardingWizard(prompter, {
  configPath: process.env.MINDSTONE_AGENT_CONFIG!,
  showHeader: false,
  availableProviders: [],
  availableModels: [],
  setupProviderAuth: async () => {
    throw new Error("Local model lane must not call setupProviderAuth");
  },
});

if (!result.wrote) throw new Error("Onboarding did not write config");
if (texts.length || selects.length || confirms.length) throw new Error("Local-lane smoke prompt queues were not fully consumed");

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
if (config.routing?.mode !== "pi-session") throw new Error(`Expected pi-session routing, got ${config.routing?.mode}`);
if (config.routing?.defaultModel !== "local-openai/stub-model") throw new Error(`Expected local-openai/stub-model, got ${config.routing?.defaultModel}`);
if (config.routing?.pi?.agentDir !== agentDir) throw new Error(`Expected isolated agentDir ${agentDir}, got ${config.routing?.pi?.agentDir}`);

const modelsConfig = readIsolatedModelsConfig(agentDir);
const provider = modelsConfig.config.providers["local-openai"];
if (!provider) throw new Error("Expected local-openai provider registered in isolated models.json");
if (provider.baseUrl !== stubUrl) throw new Error(`Expected baseUrl ${stubUrl}, got ${provider.baseUrl}`);
if (provider.apiKey !== "stub-key") throw new Error("Expected wizard-provided API key in models.json");
if (!provider.models?.some((m) => m.id === "stub-model")) throw new Error("Expected probed stub-model registered in models.json");
if (!notes.includes("Registered Local OpenAI-compatible server")) throw new Error(`Expected registration note, got: ${notes}`);

console.log(`onboard local model lane smoke passed: ${result.path}`);
TS

# --- Ollama Cloud lane: onboarding registers the cloud provider with an env-var key ---
# (base URL is pointed at the stub so the probe stays offline-safe)

mkdir -p "$TMP_DIR/cloud"
MINDSTONE_AGENT_ROOT="$ROOT" \
MINDSTONE_AGENT_CONFIG="$TMP_DIR/cloud/config.json" \
PI_CODING_AGENT_DIR="$TMP_DIR/cloud/pi-agent" \
OLLAMA_API_KEY="smoke-cloud-key" \
npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { runMindStoneOnboardingWizard, readIsolatedModelsConfig, type MindStonePrompter, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

const stubUrl = process.env.STUB_URL!;
const agentDir = process.env.PI_CODING_AGENT_DIR!;

const texts = [
  "Validating the Ollama Cloud onboarding lane against a stub endpoint.",
  "OLLAMA_API_KEY",
  stubUrl,
  "help validate the Ollama Cloud onboarding lane",
  "No credentials outside the isolated runtime.",
];
const selects = [
  "software_engineering_partner",
  "balanced",
  "direct",
  "act_directly",
  "standard",
  "propose_checkpoint_memories",
  "none",
  "defer",
  "quickstart",
  "ollama_cloud",
  "env",
  "model:stub-model",
];
const confirms = [true, true, true];
let notes = "";

const prompter: MindStonePrompter = {
  intro: async () => undefined,
  outro: async () => undefined,
  note: async (message) => { notes += `${message}\n`; },
  confirm: async () => {
    const next = confirms.shift();
    if (next === undefined) throw new Error("Unexpected confirm prompt");
    return next;
  },
  select: async <T extends string>({ message, options }: { message: string; options: Array<MindStoneSelectOption<T>>; initialValue?: T }): Promise<T> => {
    const next = selects.shift();
    if (next === undefined) throw new Error(`Unexpected select prompt: ${message}`);
    const found = options.find((option) => option.value === next);
    if (!found) throw new Error(`Selection not available for ${message}: ${next}; available=${options.map((option) => option.value).join(",")}`);
    return found.value;
  },
  text: async ({ message }) => {
    const next = texts.shift();
    if (next === undefined) throw new Error(`Unexpected text prompt: ${message}`);
    return next;
  },
};

const result = await runMindStoneOnboardingWizard(prompter, {
  configPath: process.env.MINDSTONE_AGENT_CONFIG!,
  showHeader: false,
  availableProviders: [],
  availableModels: [],
  setupProviderAuth: async () => {
    throw new Error("Ollama Cloud lane must not call setupProviderAuth");
  },
});

if (!result.wrote) throw new Error("Onboarding did not write config");
if (texts.length || selects.length || confirms.length) throw new Error("Cloud-lane smoke prompt queues were not fully consumed");

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
if (config.routing?.mode !== "pi-session") throw new Error(`Expected pi-session routing, got ${config.routing?.mode}`);
if (config.routing?.defaultModel !== "ollama-cloud/stub-model") throw new Error(`Expected ollama-cloud/stub-model, got ${config.routing?.defaultModel}`);

const modelsConfig = readIsolatedModelsConfig(agentDir);
const provider = modelsConfig.config.providers["ollama-cloud"];
if (!provider) throw new Error("Expected ollama-cloud provider registered in isolated models.json");
if (provider.apiKey !== "$OLLAMA_API_KEY") throw new Error(`Expected env-var key reference, got ${provider.apiKey ? "a different value" : "none"}`);
if (provider.baseUrl !== stubUrl) throw new Error(`Expected baseUrl ${stubUrl}, got ${provider.baseUrl}`);
if (!provider.models?.some((m) => m.id === "stub-model")) throw new Error("Expected probed stub-model registered in models.json");
if (!notes.includes("Registered Ollama Cloud")) throw new Error(`Expected cloud registration note, got: ${notes}`);

console.log(`onboard ollama cloud lane smoke passed: ${result.path}`);
TS
