#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CONFIG="$TMP_DIR/config.json"

cat > "$CONFIG" <<'JSON'
{
  "customTopLevel": {
    "preserve": true
  },
  "gateway": {
    "xPreserveNested": "yes",
    "host": "127.0.0.1",
    "port": 19789,
    "auth": {
      "mode": "none"
    }
  }
}
JSON

cd "$ROOT"
MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { runMindStoneConfigWizard, type MindStonePrompter, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

const texts = [
  "91",
  "70",
  "20",
];
const selects = [
  "keep",
  "local",
  "token",
  "keep",
  "mock",
  "done",
  "sliding_window",
  "custom",
  "sqlite-vec",
  "suggested",
  "keep",
  "keep",
  "keep",
];
const confirms = [true, false, true, true];

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
    if (!found) throw new Error(`Selection not available: ${next}`);
    return found.value;
  },
  text: async () => {
    const next = texts.shift();
    if (next === undefined) throw new Error("Unexpected text prompt");
    return next;
  },
};

const result = await runMindStoneConfigWizard(prompter, {
  sections: ["workspace", "gateway", "routing", "context", "memory", "identity"],
});
if (!result.wrote) throw new Error("Wizard did not write config");
if (texts.length || selects.length || confirms.length) throw new Error("Smoke prompt queues were not fully consumed");

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
if (config.customTopLevel?.preserve !== true) throw new Error("Top-level unknown key was not preserved");
if (config.gateway?.xPreserveNested !== "yes") throw new Error("Nested unknown gateway key was not preserved");
if (config.gateway?.auth?.mode !== "token") throw new Error("Gateway auth mode was not written");
if (config.gateway?.auth?.tokenEnv !== "MINDSTONE_GATEWAY_TOKEN") throw new Error("Gateway tokenEnv was not written");
if (config.gateway?.http?.chatCompletions?.enabled !== true) throw new Error("chatCompletions was not enabled");
if (config.gateway?.http?.responses?.enabled !== false) throw new Error("responses should remain disabled");
if (config.routing?.mode !== "mock") throw new Error("Routing mock mode was not written");
if (config.routing?.defaultModel !== "mindstone/mock") throw new Error("Mock default model label was not written");
if (config.contextManagement?.mode !== "sliding_window") throw new Error("Context mode was not written");
if (config.contextManagement?.ceilingPercent !== 91) throw new Error("Context ceiling was not written");
if (config.memory?.autoRecall !== true) throw new Error("Memory autoRecall was not written");
if (config.memory?.embeddingProvider !== "ollama:nomic-embed-text") throw new Error("Embedding provider was not written");
if (config.agents?.default?.identityPath !== "agents/default/IDENTITY.md") throw new Error("Identity path was not written");

console.log(`config wizard smoke passed: ${result.path}`);
TS
