#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-cli-chat-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== CLI chat smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-cli-chat-init.log

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = {
  mode: "mock",
  defaultAgentId: "default",
  defaultModel: "mindstone/mock",
  mock: { responsePrefix: "cli-chat-smoke" },
};
config.session = {
  mode: "single",
  defaultSessionKey: "agent:default:main",
};
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, '# CLI Chat Identity\n\nIdentity sentinel: CLI-CHAT-IDENTITY.');
writeFileSync(`${runtime}/agents/default/USER.md`, '# CLI Chat User\n\nUser sentinel: CLI-CHAT-USER.');
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

OUTPUT="$(./scripts/mindstone chat --once "hello native cli chat" --json)"
echo "${OUTPUT}"

CHAT_OUTPUT="${OUTPUT}" node <<'NODE'
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const result = JSON.parse(process.env.CHAT_OUTPUT);
if (!result.ok) process.exit(1);
if (result.sessionKey !== process.env.CHAT_SESSION_KEY) process.exit(1);
if (result.provider !== "mock") process.exit(1);
if (!result.assistantEntry?.text?.includes("hello native cli chat")) process.exit(1);
if (!result.identityContext?.injected || result.identityContext.name !== "CLI Chat Identity") process.exit(1);
if (result.assistantEntry?.source?.substrate !== "mindstone-cli") process.exit(1);
if (result.userEntry?.source?.channel !== "terminal") process.exit(1);
if (result.runner?.id !== "provider-route" || result.runner?.mode !== "provider-route") process.exit(1);
if (result.runner?.runId !== result.runId || result.runner?.surface !== "mindstone-cli") process.exit(1);
const transcriptPath = join(
  process.env.MINDSTONE_AGENT_RUNTIME_DIR,
  "mindstone",
  "transcripts",
  `${Buffer.from(process.env.CHAT_SESSION_KEY, "utf8").toString("base64url")}.jsonl`,
);
if (!existsSync(transcriptPath)) process.exit(1);
const entries = readFileSync(transcriptPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
if (!entries.some((entry) => entry.role === "user" && entry.text === "hello native cli chat" && entry.source?.substrate === "mindstone-cli")) process.exit(1);
if (!entries.some((entry) => entry.role === "assistant" && entry.metadata?.event === "assistant_response" && entry.metadata?.provider === "mock" && entry.metadata?.runner?.id === "provider-route")) process.exit(1);
NODE

echo "CLI chat smoke test passed."
