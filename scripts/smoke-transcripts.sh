#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-transcript-smoke.XXXXXX")"
GATEWAY_PORT="19793"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"

cd "${PROJECT_ROOT}"

echo "== Transcript store smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

node <<'NODE'
import {
  appendTranscriptEntry,
  listTranscriptSessions,
  readTranscriptEntries,
  resolveSessionKey,
} from "@mindstone-agent/core";

const sessionKey = resolveSessionKey({ agentId: "default", substrate: "smoke", senderId: "transcript-test" });
appendTranscriptEntry({ sessionKey, agentId: "default", role: "user", text: "hello transcript" });
appendTranscriptEntry({ sessionKey, agentId: "default", role: "assistant", text: "hello back" });

const entries = readTranscriptEntries(sessionKey);
console.log(JSON.stringify(entries, null, 2));
if (entries.length !== 2) process.exit(1);
if (entries[0].text !== "hello transcript") process.exit(1);

const sessions = listTranscriptSessions();
console.log(JSON.stringify(sessions, null, 2));
if (sessions.length !== 1) process.exit(1);
if (sessions[0].entries !== 2) process.exit(1);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-transcript-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const response = await fetch(`${base}/status`);
const body = await response.json();
console.log(JSON.stringify(body.transcripts, null, 2));
if (!response.ok) process.exit(1);
if (body.transcripts?.sessionCount !== 1) process.exit(1);
if (body.transcripts?.entryCount !== 2) process.exit(1);
NODE

echo "Transcript store smoke test passed."
