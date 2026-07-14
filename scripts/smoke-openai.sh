#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-openai-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE - 8))"
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

echo "== OpenAI-compatible Gateway smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

python3 - <<'PY'
import json, os, pathlib
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
gateway = config.setdefault("gateway", {})
gateway["auth"] = {"mode": "none"}
http = gateway.setdefault("http", {})
http.setdefault("chatCompletions", {})["enabled"] = True
http.setdefault("responses", {})["enabled"] = True
config.setdefault("agents", {}).setdefault("default", {})["defaultModel"] = "mindstone/default"
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY

./scripts/start-gateway.sh >/tmp/mindstone-agent-openai-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const sessionKey = process.env.SESSION_KEY;

async function expect(path, init, expectedStatus, check) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  if (check && !check(body)) process.exit(1);
  return body;
}

await expect("/v1/models", undefined, 200, (body) => body.object === "list" && Array.isArray(body.data));
await expect(
  "/v1/chat/completions",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mindstone/default",
      metadata: { agentId: "default" },
      messages: [
        { role: "system", content: "You are a smoke test." },
        { role: "user", content: "hello" },
      ],
    }),
  },
  501,
  (body) => body.error?.code === "not_implemented" && body.mindstone?.persisted === true && body.mindstone?.entries?.length === 3,
);
await expect(
  "/v1/responses",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mindstone/default",
      metadata: { agentId: "default" },
      input: "hello responses",
    }),
  },
  501,
  (body) => body.error?.code === "not_implemented" && body.mindstone?.persisted === true && body.mindstone?.entries?.length === 2,
);
const history = await expect("/chat/history", undefined, 200);
if (history.sessionKey !== sessionKey) process.exit(1);
if (!Array.isArray(history.entries) || history.entries.length !== 5) process.exit(1);
if (history.entries[0].role !== "system") process.exit(1);
if (history.entries[0].source?.substrate !== "openai" || history.entries[0].source?.channel !== "openai-chat-completions") process.exit(1);
if (history.entries[1].text !== "hello") process.exit(1);
if (history.entries[1].source?.substrate !== "openai") process.exit(1);
if (history.entries[2].metadata?.event !== "routing_not_implemented" || history.entries[2].source?.substrate !== "openai") process.exit(1);
if (history.entries[3].text !== "hello responses") process.exit(1);
if (history.entries[3].source?.substrate !== "openai" || history.entries[3].source?.channel !== "openai-responses") process.exit(1);
if (history.entries[4].metadata?.event !== "routing_not_implemented" || history.entries[4].metadata?.source !== "openai-responses") process.exit(1);
NODE

echo "OpenAI-compatible Gateway smoke test passed."
