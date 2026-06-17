#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-memory-backfill-smoke.XXXXXX")"
GATEWAY_PORT="19804"

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

echo "== SQLite memory backfill smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

cat >"${MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/memory/project_vector_recall.md" <<'MD'
---
name: project_vector_recall
description: Vector recall smoke memory.
type: project
hits: 0
prevented: 0
last_applied: null
created: 2026-06-17
half_life_days: 30
critical: false
evergreen: true
---

# Vector recall smoke memory

The SQLite memory index should remember that nightjar-blue widgets require signed webhook envelopes and rotating API tokens.
MD

python3 - <<'PY'
import json, os, pathlib
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
config["routing"] = {"mode": "mock", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "sqlite-memory-smoke"}}
config["memory"]["autoRecall"] = True
config["memory"]["vectorStore"] = "sqlite-vec"
config["memory"]["recall"] = {"maxResults": 4, "maxPromptTokens": 800, "minScore": 0.2}
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY

./scripts/mindstone memory backfill
status_output="$(./scripts/mindstone memory status)"
printf '%s\n' "$status_output"
grep -q "Present: true" <<<"$status_output"
grep -q "Chunks: " <<<"$status_output"

./scripts/start-gateway.sh >/tmp/mindstone-agent-memory-backfill-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;

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
    body: JSON.stringify({ text: "What does the memory say about nightjar-blue widgets and webhook envelopes?" }),
  },
  200,
);
if (!send.ok || send.provider !== "mock") process.exit(1);
if (!send.memoryRecall || send.memoryRecall.hitCount < 1) process.exit(1);

const history = await request("/chat/history", undefined, 200);
const recallEvent = history.entries.find((entry) => entry.metadata?.event === "memory_recall_injected");
if (!recallEvent) process.exit(1);
const hit = recallEvent.metadata?.hits?.find((candidate) => String(candidate.id).includes("project_vector_recall.md"));
if (!hit) process.exit(1);
NODE

doctor_output="$(./scripts/mindstone doctor)"
printf '%s\n' "$doctor_output"
grep -q "memory.sqlite" <<<"$doctor_output"
grep -q "memory.sqlite.chunks" <<<"$doctor_output"

echo "SQLite memory backfill smoke test passed."
