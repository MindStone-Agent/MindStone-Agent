#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-sliding-window-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE - 3))"
SESSION_KEY="agent:default:webchat:direct:sliding-window-smoke"

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

echo "== Gateway sliding-window smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

./scripts/start-gateway.sh >/tmp/mindstone-agent-sliding-window-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const sessionKey = process.env.SESSION_KEY;
const largeText = "x".repeat(1200);

async function post(path, body, expectedStatus) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    console.error(path, response.status, payload);
    process.exit(1);
  }
  return payload;
}

for (let index = 0; index < 30; index += 1) {
  await post("/chat/inject", {
    sessionKey,
    agentId: "default",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${index}:${largeText}`,
  }, 201);
}

const sent = await post("/chat/send", {
  sessionKey,
  agentId: "default",
  text: "current message must survive pruning",
  metadata: {
    contextWindowTokens: 5000,
    reservedTokens: 0,
  },
}, 501);

console.log(JSON.stringify(sent.promptWindow, null, 2));
if (sent.promptWindow.mode !== "sliding_window") process.exit(1);
if (sent.promptWindow.pruned !== true) process.exit(1);
if (sent.promptWindow.prunedEntries <= 0) process.exit(1);
if (sent.promptWindow.tokensAfter >= sent.promptWindow.tokensBefore) process.exit(1);

const historyResponse = await fetch(`${base}/chat/history?sessionKey=${encodeURIComponent(sessionKey)}`);
const history = await historyResponse.json();
if (historyResponse.status !== 200) process.exit(1);
if (history.entries.length < 33) process.exit(1);

const pruneEvent = history.entries.find((entry) => entry.metadata?.event === "context_window_pruned");
if (!pruneEvent) {
  console.error("missing context_window_pruned event", history);
  process.exit(1);
}
if (!Array.isArray(pruneEvent.metadata.prunedEntryIds) || pruneEvent.metadata.prunedEntryIds.length === 0) process.exit(1);
if (!history.entries.some((entry) => entry.text === "0:" + largeText)) process.exit(1);
if (!history.entries.some((entry) => entry.text === "current message must survive pruning")) process.exit(1);

console.log(JSON.stringify({
  transcriptEntries: history.entries.length,
  prunedEntries: pruneEvent.metadata.prunedEntries,
  keptEntries: pruneEvent.metadata.keptEntries,
}, null, 2));
NODE

echo "Gateway sliding-window smoke test passed."
