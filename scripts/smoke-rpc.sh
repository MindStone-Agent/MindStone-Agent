#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-rpc-smoke.XXXXXX")"
GATEWAY_PORT="19795"
SESSION_KEY="agent:default:rpc:direct:smoke"

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

echo "== Gateway RPC smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

./scripts/start-gateway.sh >/tmp/mindstone-agent-rpc-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const sessionKey = process.env.SESSION_KEY;

async function rpc(id, method, params, expectedStatus = 200) {
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, method, params }),
  });
  const body = await response.json();
  console.log(`${method} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  return body;
}

const injected = await rpc("1", "chat.inject", { sessionKey, message: "operator note", label: "note" });
if (!injected.ok || injected.result.entry.role !== "assistant") process.exit(1);

const sent = await rpc("2", "chat.send", { sessionKey, message: "route this later" });
if (!sent.ok || sent.result.code !== "not_implemented" || sent.result.persisted !== true) process.exit(1);

const aborted = await rpc("3", "chat.abort", { sessionKey, runId: "rpc-run" });
if (!aborted.ok || aborted.result.aborted !== false) process.exit(1);

const sessions = await rpc("4", "chat.sessions", {});
if (!Array.isArray(sessions.result.sessions) || sessions.result.sessions[0].entries !== 4) process.exit(1);

const history = await rpc("5", "chat.history", { sessionKey });
if (!Array.isArray(history.result.entries) || history.result.entries.length !== 4) process.exit(1);
if (history.result.entries[0].text !== "[note]\n\noperator note") process.exit(1);
if (history.result.entries[2].metadata?.event !== "routing_not_implemented") process.exit(1);
if (history.result.entries[3].metadata?.event !== "abort_requested") process.exit(1);

const missing = await rpc("6", "chat.nope", {}, 404);
if (missing.ok !== false || missing.error?.code !== "method_not_found") process.exit(1);
NODE

echo "Gateway RPC smoke test passed."
