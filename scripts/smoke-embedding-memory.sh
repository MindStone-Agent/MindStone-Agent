#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-embedding-memory-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 5))"
EMBED_PORT="$((SMOKE_PORT_BASE + 6))"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${embed_pid:-}" ]]; then
    kill "${embed_pid}" >/dev/null 2>&1 || true
    wait "${embed_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export EMBEDDER_BASE_URL="http://127.0.0.1:${EMBED_PORT}/v1"
export EMBED_PORT

cd "${PROJECT_ROOT}"

echo "== Embedding-backed SQLite memory smoke test =="

node --input-type=module <<'NODE' >/tmp/mindstone-agent-mock-embedder.log 2>&1 &
import { createServer } from "node:http";

const port = Number(process.env.EMBED_PORT);

function vectorFor(text) {
  const lower = String(text).toLowerCase();
  if (lower.includes("albatross") || lower.includes("semantic-magnet")) return [1, 0, 0, 0];
  if (lower.includes("mindstone embedding health check")) return [0, 0, 1, 0];
  return [0, 1, 0, 0];
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/embeddings") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const input = Array.isArray(body.input) ? body.input : [body.input];
    const data = input.map((text, index) => ({ object: "embedding", index, embedding: vectorFor(text) }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data, model: body.model }));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`mock embedder listening on ${port}`));
NODE
embed_pid=$!
sleep 1

npm run build:mindstone
./scripts/init-runtime.sh

cat >"${MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/memory/project_embedding_cluster.md" <<'MD'
---
name: project_embedding_cluster
description: Embedding smoke memory.
type: project
hits: 0
prevented: 0
last_applied: null
created: 2026-06-17
half_life_days: 30
critical: false
evergreen: true
---

# Embedding smoke memory

The semantic-magnet procedure requires signed webhook envelopes and rotating API tokens.
MD

python3 - <<'PY'
import json, os, pathlib
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
config["routing"] = {"mode": "mock", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "embedding-memory-smoke"}}
config["memory"]["autoRecall"] = True
config["memory"]["vectorStore"] = "sqlite-vec"
config["memory"]["embeddingProvider"] = "ollama:mock-embed"
config["memory"]["recall"] = {"maxResults": 4, "maxPromptTokens": 800, "minScore": 0.8}
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY

./scripts/mindstone memory backfill --embed
status_output="$(./scripts/mindstone memory status)"
printf '%s\n' "$status_output"
grep -q "Present: true" <<<"$status_output"
grep -E -q "Embedded chunks: [1-9]" <<<"$status_output"

doctor_output="$(./scripts/mindstone doctor)"
printf '%s\n' "$doctor_output"
grep -q "memory.embedding.live" <<<"$doctor_output"
grep -q "4 dimensions" <<<"$doctor_output"

./scripts/start-gateway.sh >/tmp/mindstone-agent-embedding-memory-gateway.log 2>&1 &
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
    body: JSON.stringify({ text: "What should albatross use?" }),
  },
  200,
);
if (!send.ok || send.provider !== "mock") process.exit(1);
if (!send.memoryRecall || send.memoryRecall.hitCount < 1) process.exit(1);

const history = await request("/chat/history", undefined, 200);
const recallEvent = history.entries.find((entry) => entry.metadata?.event === "memory_recall_injected");
if (!recallEvent) process.exit(1);
const hit = recallEvent.metadata?.hits?.find((candidate) => String(candidate.id).includes("project_embedding_cluster.md"));
if (!hit) process.exit(1);
if (hit.score < 0.8) process.exit(1);
NODE

echo "Embedding-backed SQLite memory smoke test passed."
