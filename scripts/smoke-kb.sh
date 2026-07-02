#!/usr/bin/env bash
set -euo pipefail

# Knowledgebase v1 smoke (issue #13):
#   1. KB catalog/schema loads; broken kb.json surfaces an error
#   2. deterministic ingest builds index.json (sections, summaries, NO model calls)
#   3. source metadata + citations preserved through ingest and search
#   4. dedicated KB search path returns cited hits
#   5. ingest/index status reports fresh/stale/unindexed per source
#   6. KB summaries participate in Auto Recall on a real mock-routed chat turn

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-kb-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== Knowledgebase v1 smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-kb-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"
KB_DIR="${RUNTIME_DATA}/knowledgebases"

# Seed mock routing + identity + one KB with two sources (+ one broken KB).
node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const configPath = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "default", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.session = { mode: "single", defaultSessionKey: "agent:default:main" };
config.memory = { autoRecall: true };
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, "# KB Smoke Identity\n\nIdentity sentinel: KB-SMOKE-IDENTITY.");
writeFileSync(`${runtime}/agents/default/USER.md`, "# KB Smoke User\n\nUser sentinel: KB-SMOKE-USER.");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const kb = `${runtime}/knowledgebases/ot-security`;
mkdirSync(`${kb}/sources/guides`, { recursive: true });
writeFileSync(`${kb}/kb.json`, JSON.stringify({ name: "OT Security", version: "0.1.0", description: "Operational technology security references" }, null, 2));
writeFileSync(
  `${kb}/sources/guides/segmentation.md`,
  [
    "# Substation Segmentation Guide",
    "",
    "Baseline guidance for substation network zoning.",
    "",
    "## Firewall placement",
    "",
    "Place the substation firewall between the control zone and the corporate zone. Segmentation limits lateral movement.",
    "",
    "## Zone policy",
    "",
    "Define conduits explicitly; deny inter-zone traffic by default.",
    "",
    "SENTINEL-FULL-BODY-ONLY: audit conduit rules quarterly.",
  ].join("\n"),
);
writeFileSync(
  `${kb}/sources/protocols.md`,
  ["# Protocol Notes", "", "Modbus and DNP3 lack native authentication; monitor them at zone boundaries."].join("\n"),
);

const broken = `${runtime}/knowledgebases/broken-kb`;
mkdirSync(broken, { recursive: true });
writeFileSync(`${broken}/kb.json`, "{ not json");
NODE

# --- 1. Catalog/schema: discovery lists the KB; broken kb.json surfaces an error ---
LIST_JSON="$(./scripts/mindstone kb list --json)"
grep -q '"id": "ot-security"' <<<"${LIST_JSON}"
grep -q '"name": "OT Security"' <<<"${LIST_JSON}"
grep -q '"id": "broken-kb"' <<<"${LIST_JSON}"
grep -q '"error"' <<<"${LIST_JSON}"

# Search before ingest fails with a actionable error.
if ./scripts/mindstone kb search ot-security "firewall" >/dev/null 2>&1; then
  echo "search before ingest should fail with a run-ingest hint" >&2
  exit 1
fi

# --- 2. Deterministic ingest builds the index ---
INGEST_JSON="$(./scripts/mindstone kb ingest ot-security --json)"
grep -q '"entryCount": 4' <<<"${INGEST_JSON}"
grep -q '"sourceCount": 2' <<<"${INGEST_JSON}"
test -f "${KB_DIR}/ot-security/index.json"

# --- 3. Source metadata + citations preserved in the index ---
grep -q '"citation": "guides/segmentation.md § Firewall placement"' "${KB_DIR}/ot-security/index.json"
grep -q '"sourceTitle": "Substation Segmentation Guide"' "${KB_DIR}/ot-security/index.json"
grep -q '"citation": "protocols.md"' "${KB_DIR}/ot-security/index.json"

# --- 4. Dedicated search path returns cited hits ---
SEARCH_JSON="$(./scripts/mindstone kb search ot-security "substation firewall segmentation" --json)"
grep -q '"citation": "guides/segmentation.md § Firewall placement"' <<<"${SEARCH_JSON}"
grep -q '"summary"' <<<"${SEARCH_JSON}"

# --- 5. Status: fresh after ingest; stale after a source edit; unindexed for new sources ---
STATUS_JSON="$(./scripts/mindstone kb status ot-security --json)"
grep -q '"indexed": true' <<<"${STATUS_JSON}"
grep -q '"staleCount": 0' <<<"${STATUS_JSON}"
touch -t 203001010000 "${KB_DIR}/ot-security/sources/protocols.md"
echo "# New Doc" > "${KB_DIR}/ot-security/sources/new-doc.md"
STATUS_JSON="$(./scripts/mindstone kb status ot-security --json)"
grep -q '"state": "stale"' <<<"${STATUS_JSON}"
grep -q '"state": "unindexed"' <<<"${STATUS_JSON}"
rm "${KB_DIR}/ot-security/sources/new-doc.md"
./scripts/mindstone kb ingest ot-security --json >/dev/null

# --- 6. Auto Recall: KB summary docs are injected on a real mock-routed chat turn ---
CHAT_JSON="$(./scripts/mindstone chat --once "How should I approach substation firewall segmentation zoning?" --json)"
grep -q '"memoryRecall"' <<<"${CHAT_JSON}"
TRANSCRIPT_FILE="$(ls "${RUNTIME_DATA}"/transcripts/*.jsonl | head -1)"
grep -q "memory_recall_injected" "${TRANSCRIPT_FILE}"
grep -q "kb:ot-security:guides/segmentation.md" "${TRANSCRIPT_FILE}"

# Recall opt-out: knowledgebases.recall.enabled=false removes KB docs from recall.
node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.knowledgebases = { recall: { enabled: false } };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
KB_INJECTIONS_BEFORE="$(grep -c "kb:ot-security" "${TRANSCRIPT_FILE}" || true)"
./scripts/mindstone chat --once "substation firewall segmentation zoning again please" --json >/dev/null
KB_INJECTIONS_AFTER="$(grep -c "kb:ot-security" "${TRANSCRIPT_FILE}" || true)"
if [ "${KB_INJECTIONS_AFTER}" -ne "${KB_INJECTIONS_BEFORE}" ]; then
  echo "KB docs should not be recalled when knowledgebases.recall.enabled=false" >&2
  exit 1
fi

# --- 7. Unit-level assertions: recall documents are summaries/pointers with citations ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  discoverKnowledgebaseRecallDocuments,
  ingestMindStoneKnowledgebase,
  mindStoneKbStatus,
  searchMindStoneKnowledgebase,
} from "./packages/mindstone-core/src/index.ts";

const kbDir = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/knowledgebases`;

const search = searchMindStoneKnowledgebase(kbDir, "ot-security", "modbus dnp3 authentication");
assert.ok(search.ok);
assert.ok(search.hits.length >= 1);
assert.equal(search.hits[0].entry.citation, "protocols.md");

const status = mindStoneKbStatus(kbDir, "ot-security");
assert.ok(!("error" in status));
assert.equal(status.staleCount, 0, "re-ingest must clear staleness");

const docs = discoverKnowledgebaseRecallDocuments({ config: { knowledgebases: { dir: kbDir } } });
assert.equal(docs.length, 2, "one recall doc per indexed source");
const seg = docs.find((doc) => doc.id === "kb:ot-security:guides/segmentation.md")!;
assert.equal(seg.kind, "kb");
assert.ok(seg.text.includes("guides/segmentation.md § Firewall placement"), "recall doc must carry citations");
assert.ok(seg.text.includes("mindstone kb search ot-security"), "recall doc must point at the dedicated search path");
assert.ok(!seg.text.includes("SENTINEL-FULL-BODY-ONLY"), "recall doc carries first-paragraph summaries, not full section bodies");

const badIngest = ingestMindStoneKnowledgebase(kbDir, "broken-kb");
assert.ok(!badIngest.ok);
console.log("knowledgebase assertions passed");
TS

echo "Knowledgebase v1 smoke test passed."
