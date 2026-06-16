#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"
cd "${MINDSTONE_AGENT_ROOT}"

echo "== Native MindStone-Agent smoke test =="

npm run build:mindstone

./scripts/show-isolation.sh

version="$(./scripts/pi-agent --version)"
echo "Pi version: ${version}"
if [[ -z "${version}" ]]; then
  echo "Pi version check returned empty output" >&2
  exit 1
fi

./scripts/start-gateway.sh >/tmp/mindstone-agent-native-gateway.log 2>&1 &
gateway_pid=$!
cleanup() {
  kill "${gateway_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sleep 1
node -e 'const r=await fetch("http://127.0.0.1:19789/health"); if(!r.ok) process.exit(1); const body=await r.json(); if(!body.ok) process.exit(1); console.log(JSON.stringify(body, null, 2));'
cleanup
trap - EXIT

./scripts/pi-agent install ./packages/mindstone-pi-adapter >/tmp/mindstone-agent-native-install.log
commands_json="$(printf '%s\n' '{"id":"1","type":"get_commands"}' | ./scripts/pi-agent --mode rpc --no-session --no-context-files)"
echo "${commands_json}"
if ! grep -q 'mindstone-agent-status' <<<"${commands_json}"; then
  echo "mindstone-agent-status command was not discovered" >&2
  exit 1
fi

echo "Native smoke test passed."
