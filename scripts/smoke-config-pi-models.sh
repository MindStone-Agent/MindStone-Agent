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
