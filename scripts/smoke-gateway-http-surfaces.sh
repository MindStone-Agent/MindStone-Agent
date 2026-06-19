#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-http-surfaces-smoke.XXXXXX")"
GATEWAY_PORT="19803"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"

cd "${PROJECT_ROOT}"

echo "== Gateway HTTP surface enablement smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

set_http_flags() {
  local chat_enabled="$1"
  local responses_enabled="$2"
  python3 - "${chat_enabled}" "${responses_enabled}" <<'PY'
import json, os, pathlib, sys
chat_enabled = sys.argv[1] == "true"
responses_enabled = sys.argv[2] == "true"
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
gateway = config.setdefault("gateway", {})
gateway["auth"] = {"mode": "none"}
http = gateway.setdefault("http", {})
http.setdefault("chatCompletions", {})["enabled"] = chat_enabled
http.setdefault("responses", {})["enabled"] = responses_enabled
config.setdefault("agents", {}).setdefault("default", {})["defaultModel"] = "mindstone/default"
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY
}

start_gateway() {
  ./scripts/start-gateway.sh >/tmp/mindstone-agent-http-surfaces-gateway.log 2>&1 &
  gateway_pid=$!
  sleep 1
}

stop_gateway() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
    unset gateway_pid
  fi
}

run_case() {
  local label="$1"
  local chat_enabled="$2"
  local responses_enabled="$3"
  local models_status="$4"
  local chat_status="$5"
  local responses_status="$6"
  echo "-- ${label} --"
  set_http_flags "${chat_enabled}" "${responses_enabled}"
  start_gateway
  MODELS_STATUS="${models_status}" CHAT_STATUS="${chat_status}" RESPONSES_STATUS="${responses_status}" node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;

async function expect(path, init, expectedStatus, check) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  if (check && !check(body)) process.exit(1);
}

await expect("/health", undefined, 200, (body) => body.ok === true);
await expect("/v1/models", undefined, Number(process.env.MODELS_STATUS), (body) => {
  if (Number(process.env.MODELS_STATUS) === 200) return body.object === "list";
  return body.error?.code === "disabled";
});
await expect(
  "/v1/chat/completions",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mindstone/default", messages: [{ role: "user", content: "hello" }] }),
  },
  Number(process.env.CHAT_STATUS),
  (body) => {
    if (Number(process.env.CHAT_STATUS) === 404) return body.error?.code === "disabled";
    return body.error?.code === "not_implemented" && body.mindstone?.persisted === true;
  },
);
await expect(
  "/v1/responses",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mindstone/default", input: "hello responses" }),
  },
  Number(process.env.RESPONSES_STATUS),
  (body) => {
    if (Number(process.env.RESPONSES_STATUS) === 404) return body.error?.code === "disabled";
    return body.error?.code === "not_implemented" && body.mindstone?.persisted === true;
  },
);
NODE
  stop_gateway
}

run_case "both disabled" false false 404 404 404
run_case "chat only" true false 200 501 404
run_case "responses only" false true 200 404 501

echo "Gateway HTTP surface enablement smoke test passed."
