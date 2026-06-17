#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-file-memory-smoke.XXXXXX")"
GATEWAY_PORT="19803"

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

echo "== File-backed memory auto-recall smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

cat >"${MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/memory/project_integration_builder.md" <<'MD'
---
name: project_integration_builder
description: Integration Builder structured memory.
type: project
hits: 0
prevented: 0
last_applied: null
created: 2026-06-17
half_life_days: 30
critical: false
evergreen: true
---

# Integration Builder structured memory

Integration Builder should prioritize APIs, webhooks, connectors, channel adapters, automation, and safe credential handling.
MD

python3 - <<'PY'
import json, os, pathlib
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
config["routing"] = {"mode": "mock", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "file-memory-smoke"}}
config["memory"]["autoRecall"] = True
config["memory"]["vectorStore"] = "memory"
config["memory"]["recall"] = {"maxResults": 4, "maxPromptTokens": 800, "minScore": 0.2}
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY

./scripts/start-gateway.sh >/tmp/mindstone-agent-file-memory-gateway.log 2>&1 &
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
    body: JSON.stringify({ text: "What should Integration Builder prioritize for APIs and webhooks?" }),
  },
  200,
);
if (!send.ok || send.provider !== "mock") process.exit(1);
if (!send.memoryRecall || send.memoryRecall.hitCount < 1) process.exit(1);

const history = await request("/chat/history", undefined, 200);
const recallEvent = history.entries.find((entry) => entry.metadata?.event === "memory_recall_injected");
if (!recallEvent) process.exit(1);
const hit = recallEvent.metadata?.hits?.find((candidate) => String(candidate.id).includes("project_integration_builder.md"));
if (!hit) process.exit(1);
NODE

doctor_output="$(MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}" ./scripts/mindstone doctor)"
printf '%s\n' "$doctor_output"
grep -q "memory.index" <<<"$doctor_output"
grep -q "memory.files" <<<"$doctor_output"

echo "File-backed memory auto-recall smoke test passed."
