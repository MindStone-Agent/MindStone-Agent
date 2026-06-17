#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-auto-recall-smoke.XXXXXX")"
GATEWAY_PORT="19802"
SESSION_KEY="agent:default:main"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export SESSION_KEY

cd "${PROJECT_ROOT}"

echo "== Auto-recall smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const path = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = {
  mode: "mock",
  defaultModel: "mindstone/mock",
  mock: { responsePrefix: "auto-recall-smoke" },
};
config.memory = {
  autoRecall: true,
  vectorStore: "memory",
  recall: { maxResults: 3, maxPromptTokens: 500, minScore: 0.2 },
  localDocuments: [
    {
      id: "memory-integration-builder",
      kind: "checkpoint",
      title: "Integration Builder preference",
      text: "Integration Builder should focus on APIs, webhooks, connectors, channel adapters, automation, and safe credential handling."
    },
    {
      id: "memory-unrelated",
      kind: "doc",
      title: "Unrelated note",
      text: "A garden shed needs fresh paint and a new latch."
    }
  ]
};
writeFileSync(path, JSON.stringify(config, null, 2));
console.log(path);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-auto-recall-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;

async function request(path, init, expectedStatus) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  return body;
}

const send = await request(
  "/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "How should Integration Builder handle APIs and webhooks?" }),
  },
  200,
);
if (!send.ok || send.provider !== "mock") process.exit(1);
if (!send.memoryRecall || send.memoryRecall.hitCount < 1) process.exit(1);
if (send.memoryRecall?.query !== "How should Integration Builder handle APIs and webhooks?") process.exit(1);

const history = await request("/chat/history", undefined, 200);
const recallEvent = history.entries.find((entry) => entry.metadata?.event === "memory_recall_injected");
if (!recallEvent) process.exit(1);
if (recallEvent.metadata?.hitCount < 1) process.exit(1);
if (!recallEvent.metadata?.hits?.some((hit) => hit.id === "memory-integration-builder")) process.exit(1);
if (!history.entries.some((entry) => entry.role === "assistant" && entry.metadata?.event === "assistant_response")) process.exit(1);
NODE

echo "Auto-recall smoke test passed."
