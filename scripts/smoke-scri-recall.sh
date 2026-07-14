#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-scri-recall-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 7))"

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

# --- Ranking parity battery (#36): hostile inputs, authority anchors, fail-open logger ---
node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
const rankingUrl = pathToFileURL(`${process.cwd()}/packages/mindstone-core/dist/memory/scri-ranking.js`).href;
const usageUrl = pathToFileURL(`${process.cwd()}/packages/mindstone-core/dist/memory/recall-usage.js`).href;
const { rankMemoryHitsWithScri } = await import(rankingUrl);
const { logRecallUsage } = await import(usageUrl);

const mk = (id, score, metadata, text) => ({
  id, kind: "custom", text, chunkId: `${id}#0`, sourceId: id, ordinal: 0, score,
  metadata: { relativePath: `memory/${id}.md`, ...metadata },
});

// 1. Hostile-input battery: 0 raises, every bound holds.
const hostile = [
  ["neg-hits", { hits: "-50", prevented: "-3" }],
  ["inf-hits", { hits: "1e309", prevented: "2" }],
  ["nan-hits", { hits: "NaN", prevented: "NaN" }],
  ["garbage", { hits: "over 9000", prevented: "lots", half_life_days: "yes" }],
  ["huge", { hits: "999999999999", prevented: "1000000" }],
  // Finite-but-huge prevented in the >5.99e307 band: 3*prevented would overflow
  // to +Infinity and yield NaN preventedBoost -> score collapse (QA #36 F1).
  ["overflow-prevented", { hits: "1", prevented: "1e308" }],
  ["max-value-prevented", { hits: "0", prevented: "1.7976931348623157e308" }],
  ["neg-halflife", { hits: "10", prevented: "1", half_life_days: "-30", last_applied: "not-a-date" }],
  ["weird-critical", { critical: "TRUEish", evergreen: 42 }],
  ["null-ish", { hits: null, prevented: undefined, last_applied: null }],
];
const hostileHits = hostile.map(([id, md], i) => mk(id, 0.5, md, `hostile battery case ${i} distinct text ${id}`));
const hostileResult = rankMemoryHitsWithScri(hostileHits, { dedupAgainstActiveContext: false });
if (hostileResult.hits.length !== hostile.length) { console.error("hostile: hits dropped"); process.exit(1); }
for (const h of hostileResult.hits) {
  if (!Number.isFinite(h.score) || h.score < 0 || h.score > 1) { console.error(`hostile: unbounded score ${h.id}=${h.score}`); process.exit(1); }
  const s = h.metadata.scri;
  if (!(s.usageBoost >= 0 && s.usageBoost <= 0.02 + 1e-9)) { console.error(`hostile: usageBoost out of cap ${h.id}=${s.usageBoost}`); process.exit(1); }
  if (!(s.preventedBoost >= 0 && s.preventedBoost <= 0.07 + 1e-9)) { console.error(`hostile: preventedBoost out of cap ${h.id}=${s.preventedBoost}`); process.exit(1); }
}
console.log("parity battery 1 ok: hostile inputs — 0 raises, bounds hold");

// 2. Authority anchors (reference-consistent): prevented=3 outranks hits=2400
//    at equal similarity; prevented=1 does NOT (matches ms4cc#63 math).
const swamp = rankMemoryHitsWithScri([
  mk("old-odometer", 0.5, { prevented: "0", hits: "2400" }, "long-present odometer memory distinct text one"),
  mk("high-prevented", 0.5, { prevented: "3", hits: "0" }, "memory that stopped three real mistakes distinct"),
], { dedupAgainstActiveContext: false });
if (swamp.hits[0].id !== "high-prevented") { console.error("parity: prevented=3 must outrank hits=2400"); process.exit(1); }
const weak = rankMemoryHitsWithScri([
  mk("old-odometer2", 0.5, { prevented: "0", hits: "2400" }, "long-present odometer memory distinct text two"),
  mk("one-prevented", 0.5, { prevented: "1", hits: "0" }, "memory with one prevention credit distinct text"),
], { dedupAgainstActiveContext: false });
if (weak.hits[0].id !== "old-odometer2") { console.error("parity: prevented=1 should NOT beat hits=2400"); process.exit(1); }
console.log("parity battery 2 ok: authority anchors hold");

// 3. Manual path logs the shared schema with authority_factor:null (raw, unweighted).
const os = await import("node:os");
const nodefs = await import("node:fs");
const tmpMem = nodefs.mkdtempSync(`${os.tmpdir()}/scri-manual-`);
process.env.MINDSTONE_AGENT_MEMORY_DIR = tmpMem;
logRecallUsage("manual", "manual battery query", swamp.hits, new Set());
const manualLog = `${tmpMem}/recall-usage.jsonl`;
if (!nodefs.existsSync(manualLog)) { console.error("manual path wrote no usage log"); process.exit(1); }
const manualLines = nodefs.readFileSync(manualLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (!manualLines.every((l) => l.path === "manual" && l.authority_factor === null)) { console.error("manual log must be path:manual, authority_factor:null (raw)", manualLines); process.exit(1); }
nodefs.rmSync(tmpMem, { recursive: true, force: true });
console.log("parity battery 3 ok: manual path logs shared schema, authority_factor null (raw)");

// 4. Usage logger is fail-open: unwritable path must not throw (auto OR manual).
process.env.MINDSTONE_AGENT_MEMORY_DIR = "/dev/null/nope";
logRecallUsage("auto", "battery query", swamp.hits, new Set());
logRecallUsage("manual", "battery query", swamp.hits, new Set());
console.log("parity battery 4 ok: usage logger fail-open on unwritable path (auto + manual)");
NODE

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

# Usage instrumentation (#36): the auto path must write the shared-schema JSONL.
USAGE_LOG="${TEMP_RUNTIME}/mindstone/memory/recall-usage.jsonl"
test -f "${USAGE_LOG}" || { echo "recall-usage.jsonl missing at ${USAGE_LOG}" >&2; exit 1; }
USAGE_LOG_PATH="${USAGE_LOG}" node <<'NODE'
const { readFileSync } = require("node:fs");
const lines = readFileSync(process.env.USAGE_LOG_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (lines.length < 1) process.exit(1);
const required = ["ts", "path", "query", "source_type", "source_path", "chunk_id", "similarity", "rank", "authority_factor", "injected"];
for (const line of lines) {
  for (const key of required) {
    if (!(key in line)) { console.error(`usage log missing field ${key}: ${JSON.stringify(line)}`); process.exit(1); }
  }
}
if (!lines.every((l) => l.path === "auto")) { console.error("usage log: non-auto path on the auto route"); process.exit(1); }
if (!lines.some((l) => l.injected === true)) { console.error("usage log: no injected=true record"); process.exit(1); }
if (!lines.some((l) => typeof l.authority_factor === "number" && l.authority_factor > 0)) { console.error("usage log: no positive authority_factor"); process.exit(1); }
console.log(`usage log ok: ${lines.length} line(s), shared schema complete, auto path, injected present`);
NODE

echo "SCRI recall ranking/dedup smoke test passed."
