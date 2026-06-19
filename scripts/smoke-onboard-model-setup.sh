#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CONFIG="$TMP_DIR/config.json"

cd "$ROOT"
MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { runMindStoneOnboardingWizard, type MindStonePrompter, type MindStoneProviderAuthSetupRequest, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

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
const confirms = [true, true];
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
