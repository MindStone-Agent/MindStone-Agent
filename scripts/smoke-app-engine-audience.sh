#!/usr/bin/env bash
# App Engine audience (#70): a run scoped to an app, tenant or user gets none of
# the owner's context (USER.md, memory index, owner-only invariants, handoff),
# keeps rules marked invariant_audience: all, and keeps its scoped recall. An
# unscoped run (agent only) keeps the owner's context (control).
# Binds gateway port base+27 — serialize per smoke protocol. Synthetic sentinels only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-ae-audience-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 27))"
cleanup() { if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi; rm -rf "${TEMP_RUNTIME}"; }
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}" MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export AE_TOKEN="ae-audience-token" CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
cd "${PROJECT_ROOT}"
echo "== App Engine audience smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-ae-audience-init.log
DATA="${TEMP_RUNTIME}/mindstone"
printf '# User\n\nOwner profile sentinel: TEAL-OWNER-PROFILE.\n' > "${DATA}/agents/default/USER.md"
printf '# Memory index\n\n- [Heron budget](project_heron_budget.md) — pointer\n' > "${DATA}/memory/MEMORY.md"
printf -- '---\nname: feedback_private_rule\ndescription: Owner-only rule.\ntype: feedback\ncritical: true\ninvariant: Never mention PLUM-INVARIANT-PRIVATE.\n---\n\nBody.\n' > "${DATA}/memory/feedback_private_rule.md"
printf -- '---\nname: feedback_public_rule\ndescription: Rule for all.\ntype: feedback\ncritical: true\ninvariant: Always be polite (SAGE-INVARIANT-PUBLIC).\ninvariant_audience: all\n---\n\nBody.\n' > "${DATA}/memory/feedback_public_rule.md"
mkdir -p "${DATA}/transcripts"
printf '# Handoff\n\n- Session: agent:default:main\n\nCORAL-HANDOFF-TAIL\n' > "${DATA}/transcripts/.handoff.md"
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "AE_TOKEN"}
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "ae", "captureFile": os.environ["CAPTURE"]}}
c["memory"] = {**c.get("memory", {}), "autoRecall": True, "vectorStore": "memory", "recall": {"maxResults": 5, "maxPromptTokens": 800, "minScore": 0.01},
  "localDocuments": [{"id": "tenant-doc", "kind": "doc", "title": "Tenant heron note", "text": "The heron budget for tenant t1 is TENANT-DOC-SENTINEL.", "metadata": {"scope": {"tenantId": "t1", "agentId": "default"}}}]}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
./scripts/start-gateway.sh >/tmp/mindstone-agent-ae-audience-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
run() { : > "${CAPTURE}"; curl -s -X POST -H "Authorization: Bearer ${AE_TOKEN}" -H 'content-type: application/json' -d "$1" "http://127.0.0.1:${GATEWAY_PORT}/agents/default/runs" >/tmp/mindstone-agent-ae-run.json; cp "${CAPTURE}" "$2"; }
run '{"text":"What is the heron budget?","tenantId":"t1"}' "${TEMP_RUNTIME}/tenant.jsonl"
run '{"text":"What is the heron budget?","appId":"app-9","userId":"u2"}' "${TEMP_RUNTIME}/appuser.jsonl"
run '{"text":"What is the heron budget?"}' "${TEMP_RUNTIME}/owner.jsonl"
TR="${TEMP_RUNTIME}" node <<'NODE'
const { readFileSync } = require("node:fs");
const fail = (m) => { console.error(m); process.exit(1); };
const prompt = (name) => {
  const lines = readFileSync(`${process.env.TR}/${name}`, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) fail(`${name}: no model request captured`);
  return JSON.parse(lines.pop()).messages.map((m) => m.text ?? "").join("\n");
};
const owner = prompt("owner.jsonl");
// (No handoff here: any scoped route, App Engine included, skips handoff replay since #62.)
const INDEX_HEADER = "Index of the agent's durable memories";
for (const s of ["TEAL-OWNER-PROFILE", INDEX_HEADER, "PLUM-INVARIANT-PRIVATE", "SAGE-INVARIANT-PUBLIC"]) {
  if (!owner.includes(s)) fail(`control: the unscoped (owner) run is missing ${s}`);
}
for (const name of ["tenant.jsonl", "appuser.jsonl"]) {
  const p = prompt(name);
  // Recall of the owner's unscoped memory in tenant runs is the open App Engine
  // scope decision, so this checks the memory index block, not the pointer text.
  for (const s of ["TEAL-OWNER-PROFILE", INDEX_HEADER, "PLUM-INVARIANT-PRIVATE", "CORAL-HANDOFF-TAIL"]) {
    if (p.includes(s)) fail(`${name}: a scoped run got the owner's ${s}`);
  }
  if (!p.includes("SAGE-INVARIANT-PUBLIC")) fail(`${name}: lost the rule marked invariant_audience: all`);
}
if (!prompt("tenant.jsonl").includes("TENANT-DOC-SENTINEL")) fail("the tenant run lost its own scoped recall");
console.log("app engine audience assertions passed");
NODE
echo "App Engine audience smoke test passed."
