#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-chat-smoke.XXXXXX")"
GATEWAY_PORT="19794"
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

echo "== Chat history Gateway smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

./scripts/start-gateway.sh >/tmp/mindstone-agent-chat-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const sessionKey = process.env.SESSION_KEY;

async function request(path, init, expectedStatus) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  return body;
}

await request(
  "/chat/inject",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "default", role: "user", text: "hello webchat" }),
  },
  201,
);
await request(
  "/chat/inject",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "default", role: "assistant", text: "hello human" }),
  },
  201,
);

const send = await request(
  "/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "default", text: "please route me later" }),
  },
  501,
);
if (send.persisted !== true || !Array.isArray(send.entries) || send.entries.length !== 2) process.exit(1);

const abort = await request(
  "/chat/abort",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "default", runId: "smoke-run" }),
  },
  202,
);
if (abort.aborted !== false || !abort.entry) process.exit(1);

const sessions = await request("/chat/sessions", undefined, 200);
if (!Array.isArray(sessions.sessions) || sessions.sessions.length !== 1 || sessions.sessions[0].sessionKey !== sessionKey || sessions.sessions[0].entries !== 5) {
  process.exit(1);
}

const history = await request("/chat/history", undefined, 200);
if (history.sessionKey !== sessionKey) process.exit(1);
if (!Array.isArray(history.entries) || history.entries.length !== 5) process.exit(1);
if (history.entries[0].text !== "hello webchat") process.exit(1);
if (history.entries[0].source?.substrate !== "gateway-rest" || history.entries[0].source?.channel !== "webchat") process.exit(1);
if (history.entries[2].source?.substrate !== "gateway-rest" || history.entries[2].source?.chatType !== "internal") process.exit(1);
if (history.entries[3].metadata?.event !== "routing_not_implemented" || history.entries[3].source?.substrate !== "gateway-rest") process.exit(1);
if (history.entries[4].metadata?.event !== "abort_requested" || history.entries[4].source?.substrate !== "gateway-rest") process.exit(1);
NODE

echo "Chat history Gateway smoke test passed."
