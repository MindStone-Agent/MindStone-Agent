#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-webchat-ui-smoke.XXXXXX")"
GATEWAY_PORT="19798"
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

echo "== WebChat UI Gateway smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

./scripts/start-gateway.sh >/tmp/mindstone-agent-webchat-ui-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const expectedSessionKey = process.env.SESSION_KEY;

async function get(path, expectedStatus = 200) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  console.log(`${path} -> ${response.status}`);
  if (response.status !== expectedStatus) process.exit(1);
  return text;
}

async function json(path, init, expectedStatus) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  return body;
}

const html = await get('/webchat');
if (!html.includes('MindStone WebChat')) process.exit(1);
if (!html.includes('agent:default:main')) process.exit(1);
if (!html.includes('/chat/send')) process.exit(1);
if (!html.includes('not OpenWebUI')) process.exit(1);

const send = await json(
  '/chat/send',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'default', senderId: 'webchat-ui-smoke', text: 'hello from native webchat ui smoke' }),
  },
  501,
);
if (send.persisted !== true || !Array.isArray(send.entries) || send.entries.length !== 2) process.exit(1);

const history = await json('/chat/history?agentId=default&senderId=webchat-ui-smoke', undefined, 200);
if (history.sessionKey !== expectedSessionKey) process.exit(1);
if (!Array.isArray(history.entries) || history.entries.length !== 2) process.exit(1);
if (history.entries[0].text !== 'hello from native webchat ui smoke') process.exit(1);
if (history.entries[0].source?.substrate !== 'gateway-rest') process.exit(1);
if (history.entries[0].source?.channel !== 'webchat') process.exit(1);
if (history.entries[0].source?.chatType !== 'internal') process.exit(1);
if (history.entries[1].metadata?.event !== 'routing_not_implemented') process.exit(1);
NODE

echo "WebChat UI Gateway smoke test passed."
