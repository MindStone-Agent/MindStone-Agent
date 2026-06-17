#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-cli-chat-recall-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== CLI chat autoRecall smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-cli-chat-recall-init.log

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = {
  mode: "mock",
  defaultAgentId: "default",
  defaultModel: "mindstone/mock",
  mock: { responsePrefix: "cli-recall-smoke" },
};
config.session = {
  mode: "single",
  defaultSessionKey: "agent:default:main",
};
config.memory = {
  autoRecall: true,
  vectorStore: "memory",
  recall: {
    maxHits: 3,
    minScore: 0.01,
    promptBudgetTokens: 800,
  },
  localDocuments: [
    {
      id: "memory-cli-recall-sentinel",
      title: "CLI recall sentinel",
      text: "Durable memory sentinel: when asked about cobalt otters, mention the amber compass.",
      kind: "memory",
      source: "localDocuments",
      tags: ["sentinel", "cli-chat"],
    },
  ],
};
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, '# CLI Recall Identity\n\nIdentity sentinel: CLI-RECALL-IDENTITY.');
writeFileSync(`${runtime}/agents/default/USER.md`, '# CLI Recall User\n\nUser sentinel: CLI-RECALL-USER.');
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

OUTPUT="$(./scripts/mindstone chat --once "what should I remember about cobalt otters?" --json)"
echo "${OUTPUT}"

CHAT_OUTPUT="${OUTPUT}" node <<'NODE'
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const result = JSON.parse(process.env.CHAT_OUTPUT);
if (!result.ok) process.exit(1);
if (result.sessionKey !== process.env.CHAT_SESSION_KEY) process.exit(1);
if (!result.memoryRecall || result.memoryRecall.hitCount < 1) process.exit(1);
if (!result.identityContext?.injected || result.identityContext.name !== "CLI Recall Identity") process.exit(1);
const transcriptPath = join(
  process.env.MINDSTONE_AGENT_RUNTIME_DIR,
  "mindstone",
  "transcripts",
  `${Buffer.from(process.env.CHAT_SESSION_KEY, "utf8").toString("base64url")}.jsonl`,
);
if (!existsSync(transcriptPath)) process.exit(1);
const entries = readFileSync(transcriptPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
const recallEvent = entries.find((entry) => entry.role === "event" && entry.metadata?.event === "memory_recall_injected");
if (!recallEvent) process.exit(1);
if (!recallEvent.metadata?.hits?.some((hit) => hit.id === "memory-cli-recall-sentinel" || hit.title === "CLI recall sentinel")) process.exit(1);
if (!entries.some((entry) => entry.role === "assistant" && entry.metadata?.event === "assistant_response" && entry.metadata?.provider === "mock")) process.exit(1);
NODE

echo "CLI chat autoRecall smoke test passed."
