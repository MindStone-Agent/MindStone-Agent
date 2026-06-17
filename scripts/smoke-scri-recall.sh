#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-scri-recall-smoke.XXXXXX")"
GATEWAY_PORT="19807"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"

cd "${PROJECT_ROOT}"

echo "== SCRI recall ranking/dedup smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const path = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
const activeDuplicate = "How should the alpha continuity rule handle webhook envelopes, rotating API tokens, incident cases, and integration safety during channel setup?";
config.routing = {
  mode: "mock",
  defaultModel: "mindstone/mock",
  mock: { responsePrefix: "scri-recall-smoke" },
};
config.memory = {
  autoRecall: true,
  vectorStore: "memory",
  recall: { maxResults: 4, maxPromptTokens: 700, minScore: 0.1, dedupAgainstActiveContext: true },
  localDocuments: [
    {
      id: "memory-active-duplicate",
      kind: "transcript",
      title: "Duplicate active prompt",
      text: activeDuplicate,
      metadata: { relativePath: "transcripts/current.jsonl" }
    },
    {
      id: "memory-alpha-continuity",
      kind: "custom",
      title: "Alpha continuity rule",
      text: "The alpha continuity rule says Integration Builder should use signed webhook envelopes, rotating API tokens, incident case notes, and safe channel setup.",
      metadata: {
        relativePath: "memory/project_alpha_continuity.md",
        critical: "true",
        evergreen: "true",
        hits: "4",
        prevented: "2",
        created: new Date().toISOString(),
        half_life_days: "90"
      }
    },
    {
      id: "memory-low-priority",
      kind: "transcript",
      title: "Low priority transcript",
      text: "Webhook envelopes and API tokens were mentioned in a short transcript fragment.",
      metadata: { relativePath: "transcripts/old.jsonl" }
    }
  ]
};
writeFileSync(path, JSON.stringify(config, null, 2));
console.log(path);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-scri-recall-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const question = "How should the alpha continuity rule handle webhook envelopes, rotating API tokens, incident cases, and integration safety during channel setup?";

async function request(path, init, expectedStatus) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  return body;
}

const send = await request(
  "/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: question }),
  },
  200,
);
if (!send.ok || send.provider !== "mock") process.exit(1);
if (!send.memoryRecall || send.memoryRecall.hitCount < 1) process.exit(1);

const history = await request("/chat/history", undefined, 200);
const recallEvent = history.entries.find((entry) => entry.metadata?.event === "memory_recall_injected");
if (!recallEvent) process.exit(1);
const hits = recallEvent.metadata?.hits ?? [];
const rejected = recallEvent.metadata?.diagnostics?.rejected ?? [];
if (hits.some((hit) => hit.id === "memory-active-duplicate")) process.exit(1);
if (!rejected.some((entry) => entry.id === "memory-active-duplicate" && entry.reason === "duplicate-active-context")) process.exit(1);
const alpha = hits.find((hit) => hit.id === "memory-alpha-continuity");
if (!alpha) process.exit(1);
if (typeof alpha.providerScore !== "number") process.exit(1);
if (!alpha.scri || typeof alpha.scri.finalScore !== "number") process.exit(1);
if (alpha.score <= alpha.providerScore) process.exit(1);
if (!Array.isArray(alpha.scri.reasons) || !alpha.scri.reasons.includes("critical") || !alpha.scri.reasons.includes("evergreen")) process.exit(1);
NODE

echo "SCRI recall ranking/dedup smoke test passed."
