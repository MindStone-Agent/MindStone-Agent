#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-ws-rpc-smoke.XXXXXX")"
GATEWAY_PORT="19796"
SESSION_KEY="agent:default:ws-rpc:direct:smoke"

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

echo "== Gateway WebSocket RPC smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

./scripts/start-gateway.sh >/tmp/mindstone-agent-ws-rpc-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const sessionKey = process.env.SESSION_KEY;

function openSocket(path = "/rpc") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}${path}`);
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
}

function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 5000);
    const onMessage = (event) => {
      const body = JSON.parse(String(event.data));
      if (body.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      console.log(`${method} ->`);
      console.log(JSON.stringify(body, null, 2));
      resolve(body);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const ws = await openSocket();

const injected = await call(ws, "1", "chat.inject", { sessionKey, message: "operator note", label: "ws" });
if (!injected.ok || injected.result.entry.role !== "assistant") process.exit(1);

const sent = await call(ws, "2", "chat.send", { sessionKey, message: "route this over websocket later" });
if (!sent.ok || sent.result.code !== "not_implemented" || sent.result.persisted !== true) process.exit(1);

const aborted = await call(ws, "3", "chat.abort", { sessionKey, runId: "ws-run" });
if (!aborted.ok || aborted.result.aborted !== false || aborted.result.entry.metadata?.event !== "abort_requested") process.exit(1);

const sessions = await call(ws, "4", "chat.sessions", {});
if (!sessions.ok || !Array.isArray(sessions.result.sessions) || sessions.result.sessions[0]?.sessionKey !== sessionKey) process.exit(1);
if (sessions.result.sessions[0].entries !== 4) process.exit(1);

const history = await call(ws, "5", "chat.history", { sessionKey });
if (!history.ok || !Array.isArray(history.result.entries) || history.result.entries.length !== 4) process.exit(1);
if (history.result.entries[0].text !== "[ws]\n\noperator note") process.exit(1);
if (history.result.entries[2].metadata?.event !== "routing_not_implemented") process.exit(1);
if (history.result.entries[3].metadata?.event !== "abort_requested") process.exit(1);

const missing = await call(ws, "6", "chat.nope", {});
if (missing.ok !== false || missing.error?.code !== "method_not_found") process.exit(1);

ws.close();

const wsAlias = await openSocket("/ws");
const aliasHistory = await call(wsAlias, "7", "chat.history", { sessionKey });
if (!aliasHistory.ok || aliasHistory.result.entries?.length !== 4) process.exit(1);
wsAlias.close();
NODE

echo "Gateway WebSocket RPC smoke test passed."
