#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-pi-session-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== Pi session-backed runner smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-pi-session-init.log

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const piAgentDir = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = {
  mode: "pi-session",
  defaultAgentId: "default",
  defaultModel: "openai/gpt-5.1",
  pi: { agentDir: piAgentDir },
};
config.session = {
  mode: "single",
  defaultSessionKey: "agent:default:main",
};
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, '# Pi Session Smoke Identity\n\nIdentity sentinel: PI-SESSION-SMOKE-IDENTITY.');
writeFileSync(`${runtime}/agents/default/USER.md`, '# Pi Session Smoke User\n\nUser sentinel: PI-SESSION-SMOKE-USER.');
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

node --input-type=module <<'NODE'
import { createPiSessionEventCapture, piSessionFileForKey } from './packages/mindstone-gateway/dist/index.js';
import { resolve } from 'node:path';
const expected = resolve(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions/${Buffer.from(process.env.CHAT_SESSION_KEY, 'utf8').toString('base64url')}.jsonl`);
const actual = piSessionFileForKey(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions`, process.env.CHAT_SESSION_KEY);
console.log(JSON.stringify({ sessionKey: process.env.CHAT_SESSION_KEY, sessionFile: actual }, null, 2));
if (actual !== expected) process.exit(1);

const { capture, record } = createPiSessionEventCapture(3);
record({ type: 'agent_start' });
record({ type: 'message_end', message: { role: 'assistant', content: 'hello from event capture' } });
record({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'tool-1' });
record({ type: 'agent_end', messages: [{ role: 'assistant', content: 'final assistant text' }], willRetry: false });
if (capture.events.length !== 3) throw new Error(`expected bounded event capture length 3, got ${capture.events.length}`);
if (capture.eventCounts.agent_start !== 1 || capture.eventCounts.message_end !== 1 || capture.eventCounts.agent_end !== 1) throw new Error('event counts not captured');
if (capture.lastAssistantText !== 'final assistant text') throw new Error('last assistant text not captured from agent_end');
if (!capture.events.some((event) => event.toolName === 'read' && event.toolCallId === 'tool-1')) throw new Error('tool event summary not captured');
NODE

set +e
OUTPUT="$(./scripts/mindstone chat --once "hello pi session runner" --json 2>&1)"
STATUS=$?
set -e

echo "${OUTPUT}"
if [[ "${STATUS}" -eq 0 ]]; then
  echo "Expected pi-session runner to fail without isolated provider auth, but it succeeded" >&2
  exit 1
fi
if ! grep -Eq "No isolated Pi model is available/configured|not available in isolated runtime auth" <<<"${OUTPUT}"; then
  echo "Unexpected pi-session failure mode" >&2
  exit 1
fi

echo "Pi session-backed runner smoke test passed with expected unavailable-model/auth result."
