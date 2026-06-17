#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-gateway-runner-stream-smoke.XXXXXX")"
GATEWAY_PORT="19803"
SESSION_KEY="agent:default:gateway:runner-stream-smoke"

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

echo "== Gateway runner stream transcript smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-gateway-runner-stream-init.log

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, 'utf8'));
config.routing = {
  mode: 'mock',
  defaultModel: 'mindstone/mock',
  mock: { responsePrefix: 'gateway-stream-smoke' },
};
config.observability = {
  runnerStream: {
    persistTranscriptEvents: true,
    eventTypes: ['run_started'],
    maxEvents: 5,
  },
};
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, '# Gateway Stream Identity\n\nIdentity sentinel: GATEWAY-STREAM-IDENTITY.');
writeFileSync(`${runtime}/agents/default/USER.md`, '# Gateway Stream User\n\nUser sentinel: GATEWAY-STREAM-USER.');
writeFileSync(path, JSON.stringify(config, null, 2));
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-gateway-runner-stream.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(payload, null, 2));
  if (response.status !== 200) process.exit(1);
  return payload;
}

const chat = await post('/chat/send', {
  sessionKey: process.env.SESSION_KEY,
  agentId: 'default',
  text: 'hello gateway runner stream',
});
if (!chat.ok || chat.runner?.id !== 'provider-route') process.exit(1);
if (chat.runnerStream?.eventCount !== 2 || chat.runnerStream?.persistedEventCount !== 1) process.exit(1);

const historyResponse = await fetch(`${base}/chat/history?sessionKey=${encodeURIComponent(process.env.SESSION_KEY)}`);
const history = await historyResponse.json();
console.log(JSON.stringify(history, null, 2));
const entries = history.entries ?? [];
const streamEvents = entries.filter((entry) => entry.metadata?.event === 'runner_stream_event');
if (streamEvents.length !== 1) process.exit(1);
if (streamEvents[0].metadata?.streamType !== 'run_started') process.exit(1);
const assistantIndex = entries.findIndex((entry) => entry.role === 'assistant');
const streamIndex = entries.findIndex((entry) => entry.metadata?.event === 'runner_stream_event');
if (streamIndex < 0 || assistantIndex < 0 || streamIndex > assistantIndex) process.exit(1);
NODE

echo "Gateway runner stream transcript smoke test passed."
