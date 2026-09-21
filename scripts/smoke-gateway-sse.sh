#!/usr/bin/env bash
# Streaming chat completions smoke: with stream:true the gateway must answer as text/event-stream
# in the OpenAI chunk format ending in [DONE]; without it, plain JSON. Fails if either is wrong.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-sse-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 7))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
cd "${PROJECT_ROOT}"
echo "== Gateway SSE chat completions smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "none"}
c["gateway"].setdefault("http", {}).setdefault("chatCompletions", {})["enabled"] = True
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "sse-smoke"}}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
./scripts/start-gateway.sh >/tmp/mindstone-agent-sse-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
BODY='{"model":"mindstone/default","stream":true,"messages":[{"role":"user","content":"stream me"}]}'
HDR="$(curl -s -D - -o /tmp/mindstone-agent-sse-body.txt -H 'Content-Type: application/json' -d "${BODY}" "http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions")"
echo "${HDR}" | grep -qi '^content-type: text/event-stream' || { echo "FAIL: stream:true did not return text/event-stream"; echo "${HDR}"; exit 1; }
grep -q '"object":"chat.completion.chunk"' /tmp/mindstone-agent-sse-body.txt || { echo "FAIL: no chat.completion.chunk frame"; cat /tmp/mindstone-agent-sse-body.txt; exit 1; }
grep -q '"content":"sse-smoke' /tmp/mindstone-agent-sse-body.txt || { echo "FAIL: routed content missing from the delta"; cat /tmp/mindstone-agent-sse-body.txt; exit 1; }
grep -q '"finish_reason":"stop"' /tmp/mindstone-agent-sse-body.txt || { echo "FAIL: no stop chunk"; exit 1; }
tail -c 20 /tmp/mindstone-agent-sse-body.txt | grep -q 'data: \[DONE\]' || { echo "FAIL: stream did not end with [DONE]"; exit 1; }
NS="$(curl -s -D - -o /tmp/mindstone-agent-sse-ns.txt -H 'Content-Type: application/json' -d '{"model":"mindstone/default","messages":[{"role":"user","content":"plain"}]}' "http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions")"
echo "${NS}" | grep -qi '^content-type: application/json' || { echo "FAIL: non-stream request did not return JSON"; exit 1; }
grep -q '"object": "chat.completion"' /tmp/mindstone-agent-sse-ns.txt || { echo "FAIL: non-stream body is not a chat.completion"; exit 1; }
echo "PASS: stream:true -> SSE chunks + [DONE]; stream absent -> JSON"
