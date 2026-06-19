#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-gateway-cli-smoke.XXXXXX")"
PORT="19897"

cleanup() {
  MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}" MINDSTONE_AGENT_GATEWAY_PORT="${PORT}" \
    node packages/mindstone-cli/bin/mindstone.js gateway stop --force >/dev/null 2>&1 || true
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${PORT}"

cd "${PROJECT_ROOT}"

echo "== Gateway CLI smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-gateway-cli-init.log

node <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const path = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(path, 'utf8'));
config.gateway = {
  ...(config.gateway ?? {}),
  host: '127.0.0.1',
  port: Number(process.env.MINDSTONE_AGENT_GATEWAY_PORT),
  auth: { mode: 'none' },
  http: {
    ...(config.gateway?.http ?? {}),
    chatCompletions: { enabled: true },
    responses: { enabled: true },
  },
};
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

STATUS_BEFORE="$(node packages/mindstone-cli/bin/mindstone.js gateway status --json)"
echo "${STATUS_BEFORE}"
STATUS_BEFORE="${STATUS_BEFORE}" node <<'NODE'
const status = JSON.parse(process.env.STATUS_BEFORE);
if (status.managed.running !== false) throw new Error('Gateway unexpectedly running before start');
if (!status.configured.baseUrl.endsWith(`:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`)) throw new Error(`Configured URL did not use smoke port: ${status.configured.baseUrl}`);
NODE

node packages/mindstone-cli/bin/mindstone.js gateway start

node <<'NODE'
const url = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}/health`;
const deadline = Date.now() + 5000;
let last = '';
while (Date.now() < deadline) {
  try {
    const res = await fetch(url);
    const body = await res.json();
    if (res.ok && body.ok === true) process.exit(0);
    last = JSON.stringify(body);
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
throw new Error(`Gateway did not become healthy: ${last}`);
NODE

STATUS_RUNNING="$(node packages/mindstone-cli/bin/mindstone.js gateway status --json)"
echo "${STATUS_RUNNING}"
STATUS_RUNNING="${STATUS_RUNNING}" node <<'NODE'
const status = JSON.parse(process.env.STATUS_RUNNING);
if (status.managed.running !== true || !status.managed.pid) throw new Error('Managed gateway not running after start');
if (status.live.ok !== true) throw new Error(`Gateway live health failed: ${JSON.stringify(status.live)}`);
NODE

LOGS="$(node packages/mindstone-cli/bin/mindstone.js gateway logs --lines 20)"
echo "${LOGS}"
if ! grep -q "MindStone-Agent Gateway listening" <<<"${LOGS}"; then
  echo "Gateway logs did not include listening message" >&2
  exit 1
fi

node packages/mindstone-cli/bin/mindstone.js gateway restart
node <<'NODE'
const res = await fetch(`http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}/health`);
const body = await res.json();
if (!res.ok || body.ok !== true) throw new Error('Gateway unhealthy after restart');
NODE

node packages/mindstone-cli/bin/mindstone.js gateway install --dry-run | tee /tmp/mindstone-agent-gateway-install-dry-run.log
if ! grep -q "Gateway launchd install dry run" /tmp/mindstone-agent-gateway-install-dry-run.log; then
  echo "Gateway install dry-run output missing expected header" >&2
  exit 1
fi
node packages/mindstone-cli/bin/mindstone.js gateway uninstall --dry-run | tee /tmp/mindstone-agent-gateway-uninstall-dry-run.log
if ! grep -q "Gateway launchd uninstall dry run" /tmp/mindstone-agent-gateway-uninstall-dry-run.log; then
  echo "Gateway uninstall dry-run output missing expected header" >&2
  exit 1
fi

node packages/mindstone-cli/bin/mindstone.js gateway stop
STATUS_STOPPED="$(node packages/mindstone-cli/bin/mindstone.js gateway status --json)"
echo "${STATUS_STOPPED}"
STATUS_STOPPED="${STATUS_STOPPED}" node <<'NODE'
const status = JSON.parse(process.env.STATUS_STOPPED);
if (status.managed.running !== false) throw new Error('Managed gateway still running after stop');
NODE

HELP="$(node packages/mindstone-cli/bin/mindstone.js gateway help)"
if ! grep -q "mindstone gateway start" <<<"${HELP}" || ! grep -q "mindstone gateway install" <<<"${HELP}"; then
  echo "Gateway help missing MVP commands" >&2
  exit 1
fi

echo "Gateway CLI smoke test passed."
