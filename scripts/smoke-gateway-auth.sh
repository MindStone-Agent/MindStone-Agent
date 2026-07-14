#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-auth-smoke.XXXXXX")"
TOKEN="auth-smoke-token"
PASSWORD="auth-smoke-password"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_TOKEN="${TOKEN}"
export MINDSTONE_AGENT_GATEWAY_PASSWORD="${PASSWORD}"

cd "${PROJECT_ROOT}"

echo "== Gateway auth smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

set_auth_mode() {
  local mode="$1"
  python3 - "${mode}" <<'PY'
import json, os, pathlib, sys
mode = sys.argv[1]
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
if mode == "token":
    config.setdefault("gateway", {})["auth"] = {
        "mode": "token",
        "tokenEnv": "MINDSTONE_AGENT_GATEWAY_TOKEN",
    }
elif mode == "password":
    config.setdefault("gateway", {})["auth"] = {
        "mode": "password",
        "passwordEnv": "MINDSTONE_AGENT_GATEWAY_PASSWORD",
    }
else:
    raise SystemExit(f"unsupported auth mode: {mode}")
gateway = config.setdefault("gateway", {})
http = gateway.setdefault("http", {})
http.setdefault("chatCompletions", {})["enabled"] = True
http.setdefault("responses", {})["enabled"] = True
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY
}

start_gateway_on_port() {
  export MINDSTONE_AGENT_GATEWAY_PORT="$1"
  ./scripts/start-gateway.sh >/tmp/mindstone-agent-auth-gateway.log 2>&1 &
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

echo "-- token auth --"
set_auth_mode token
start_gateway_on_port "$((SMOKE_PORT_BASE - 10))"
node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const token = process.env.MINDSTONE_AGENT_GATEWAY_TOKEN;

async function expect(path, init, expectedStatus) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  console.log(`${path} -> ${response.status}`);
  console.log(text);
  if (response.status !== expectedStatus) process.exit(1);
}

await expect("/health", undefined, 200);
await expect("/status", undefined, 401);
await expect("/status", { headers: { authorization: "Bearer wrong" } }, 401);
await expect("/status", { headers: { authorization: `Bearer ${token}` } }, 200);
await expect("/status", { headers: { "x-mindstone-token": token } }, 200);
await expect("/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mindstone/default", input: "token auth should block this without credentials" }),
}, 401);
await expect("/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ model: "mindstone/default", input: "token auth authorized responses" }),
}, 501);
NODE
stop_gateway

echo "-- password auth --"
set_auth_mode password
start_gateway_on_port "$((SMOKE_PORT_BASE - 9))"
node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const password = process.env.MINDSTONE_AGENT_GATEWAY_PASSWORD;
const basic = Buffer.from(`mindstone:${password}`).toString("base64");

async function expect(path, init, expectedStatus) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  console.log(`${path} -> ${response.status}`);
  console.log(text);
  if (response.status !== expectedStatus) process.exit(1);
}

await expect("/health", undefined, 200);
await expect("/status", undefined, 401);
await expect("/status", { headers: { authorization: "Basic " + Buffer.from("mindstone:wrong").toString("base64") } }, 401);
await expect("/status", { headers: { authorization: `Basic ${basic}` } }, 200);
await expect("/status", { headers: { "x-mindstone-password": password } }, 200);
await expect("/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mindstone/default", input: "password auth should block this without credentials" }),
}, 401);
await expect("/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
  body: JSON.stringify({ model: "mindstone/default", input: "password auth authorized responses" }),
}, 501);
NODE
stop_gateway

echo "Gateway auth smoke test passed."
