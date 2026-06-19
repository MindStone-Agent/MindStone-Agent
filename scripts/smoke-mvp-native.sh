#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-mvp-native-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== Native MVP spine smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-mvp-native-init.log

expect <<'EXPECT'
set timeout 30
spawn -noecho node packages/mindstone-cli/bin/mindstone.js chat
expect "MindStone chat needs an answer mode"
expect "How should MindStone answer messages?"
send "j"
sleep 0.1
send "j"
sleep 0.1
send "\r"
expect "Model setup options"
send "\r"
expect "Write config"
send "\r"
expect "MindStone chat"
expect "you>"
send "hello native mvp spine\r"
expect "mindstone>"
expect "Mock response: hello native mvp spine"
send "/exit\r"
expect eof
EXPECT

node <<'NODE'
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const configPath = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (config.routing?.mode !== "mock") throw new Error(`Expected routing.mode mock after chat setup, got ${config.routing?.mode}`);
if (config.routing?.defaultModel !== "mindstone/mock") throw new Error(`Expected mindstone/mock default model after mock setup, got ${config.routing?.defaultModel}`);
const transcriptPath = join(
  runtime,
  "transcripts",
  `${Buffer.from(process.env.CHAT_SESSION_KEY, "utf8").toString("base64url")}.jsonl`,
);
if (!existsSync(transcriptPath)) throw new Error(`Transcript missing: ${transcriptPath}`);
const entries = readFileSync(transcriptPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
if (!entries.some((entry) => entry.role === "user" && entry.text === "hello native mvp spine" && entry.source?.substrate === "mindstone-cli")) {
  throw new Error("MVP user turn was not persisted with mindstone-cli source metadata");
}
if (!entries.some((entry) => entry.role === "assistant" && entry.text === "Mock response: hello native mvp spine" && entry.metadata?.runner?.id === "provider-route")) {
  throw new Error("MVP assistant turn was not persisted with runner metadata");
}
NODE

HISTORY_OUTPUT="$(node packages/mindstone-cli/bin/mindstone.js tui --smoke-history --history-limit 10 --width 72)"
echo "${HISTORY_OUTPUT}"
if ! grep -q "hello native mvp spine" <<<"${HISTORY_OUTPUT}"; then
  echo "TUI history output missing MVP user turn" >&2
  exit 1
fi
if ! grep -q "Mock response: hello native mvp spine" <<<"${HISTORY_OUTPUT}"; then
  echo "TUI history output missing MVP assistant turn" >&2
  exit 1
fi
if ! grep -q "Loaded 2 recent transcript" <<<"${HISTORY_OUTPUT}"; then
  echo "TUI history output missing expected transcript load count" >&2
  exit 1
fi

STATUS_OUTPUT="$(node packages/mindstone-cli/bin/mindstone.js status)"
if ! grep -q "routing.mode: mock" <<<"${STATUS_OUTPUT}" || ! grep -q "routing.defaultModel: mindstone/mock" <<<"${STATUS_OUTPUT}"; then
  echo "Status output missing configured mock routing/model" >&2
  echo "${STATUS_OUTPUT}" >&2
  exit 1
fi

HELP_OUTPUT="$(node packages/mindstone-cli/bin/mindstone.js help)"
if ! grep -q "mindstone chat" <<<"${HELP_OUTPUT}" || ! grep -q "mindstone tui" <<<"${HELP_OUTPUT}"; then
  echo "Help output missing native MVP commands" >&2
  exit 1
fi

echo "Native MVP spine smoke test passed."
