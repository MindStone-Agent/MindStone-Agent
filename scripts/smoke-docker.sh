#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

echo "== Docker MindStone-Agent smoke test =="

docker compose build

version="$(docker compose run --rm mindstone-agent-pi --version)"
echo "Pi version: ${version}"
if [[ -z "${version}" ]]; then
  echo "Docker Pi version check returned empty output" >&2
  exit 1
fi

docker compose run --rm --entrypoint bash mindstone-agent-pi -lc './scripts/show-isolation.sh; ./scripts/start-gateway.sh >/tmp/gateway.log 2>&1 & pid=$!; sleep 1; node -e '\''for (const path of ["/health", "/status"]) { const r=await fetch(`http://127.0.0.1:19789${path}`); if(!r.ok) process.exit(1); const body=await r.json(); if(!body.ok) process.exit(1); console.log(path); console.log(JSON.stringify(body, null, 2)); }'\''; kill $pid'

docker compose run --rm mindstone-agent-pi install ./packages/mindstone-pi-adapter >/tmp/mindstone-agent-docker-install.log
commands_json="$(docker compose run --rm --entrypoint bash mindstone-agent-pi -lc 'printf "%s\n" "{\"id\":\"1\",\"type\":\"get_commands\"}" | ./scripts/pi-agent --mode rpc --no-session --no-context-files')"
echo "${commands_json}"
if ! grep -q 'mindstone-agent-status' <<<"${commands_json}"; then
  echo "mindstone-agent-status command was not discovered in Docker" >&2
  exit 1
fi

echo "Docker smoke test passed."
