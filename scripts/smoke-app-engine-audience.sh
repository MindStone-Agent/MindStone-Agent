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
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
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
./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
run() { : > "${CAPTURE}"; curl -s -X POST -H "Authorization: Bearer ${AE_TOKEN}" -H 'content-type: application/json' -d "$1" "http://127.0.0.1:${GATEWAY_PORT}/agents/default/runs" >"${TEMP_RUNTIME}/run.json"; cp "${CAPTURE}" "$2"; }
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
  for (const s of ["TEAL-OWNER-PROFILE", INDEX_HEADER, "PLUM-INVARIANT-PRIVATE"]) {
    if (p.includes(s)) fail(`${name}: a scoped run got the owner's ${s}`);
  }
  if (!p.includes("SAGE-INVARIANT-PUBLIC")) fail(`${name}: lost the rule marked invariant_audience: all`);
}
if (!prompt("tenant.jsonl").includes("TENANT-DOC-SENTINEL")) fail("the tenant run lost its own scoped recall");
console.log("app engine audience assertions passed");
NODE
# A scoped run may not use a session key outside its scope; bad scope fields are refused.
code() { curl -s -o "${TEMP_RUNTIME}/code.json" -w '%{http_code}' -X POST -H "Authorization: Bearer ${AE_TOKEN}" -H 'content-type: application/json' -d "$1" "http://127.0.0.1:${GATEWAY_PORT}/agents/default/runs"; }
[[ "$(code '{"text":"hi","tenantId":"t1","sessionKey":"agent:default:main"}')" == "403" ]] || { echo "a tenant run was allowed into the owner's main session" >&2; exit 1; }
[[ "$(code '{"text":"hi","tenantId":"t1","sessionKey":"tenant:t2:agent:default:main"}')" == "403" ]] || { echo "a tenant run was allowed into another tenant's session" >&2; exit 1; }
[[ "$(code '{"text":"hi","tenantId":"t1","sessionKey":"tenant:t1:agent:default:thread-7"}')" == "200" ]] || { echo "a tenant run should be able to use its own scoped keys: $(cat "${TEMP_RUNTIME}/code.json")" >&2; exit 1; }
[[ "$(code '{"text":"hi","tenantId":42}')" == "400" ]] || { echo "a numeric tenantId must be refused, not dropped" >&2; exit 1; }
[[ "$(code '{"text":"hi","appId":"  "}')" == "400" ]] || { echo "a blank appId must be refused" >&2; exit 1; }

# The in-process API (runMindStone) applies the same audience.
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadMindStoneConfig, resolveConfigPath, runtimePathsFromEnv, runMindStone } from "./packages/mindstone-core/src/index.ts";
import { MockMindStoneProvider } from "./packages/mindstone-gateway/src/mock-provider.ts";
import { piSessionRunnerOptions } from "./packages/mindstone-gateway/src/index.ts";

const paths = runtimePathsFromEnv();
const configPath = resolveConfigPath(process.env, paths);
const { config } = loadMindStoneConfig(configPath);
const seen: string[] = [];
const provider = new MockMindStoneProvider({ responsePrefix: "core" });
const complete = provider.completeChat.bind(provider);
provider.completeChat = async (request) => { seen.push(request.messages.map((m) => m.text ?? "").join("\n")); return complete(request); };
const model = { id: "mindstone/mock", provider: "mock", contextWindowTokens: 128000 };
const run = (extra: Record<string, unknown>) => runMindStone({ agentId: "default", input: "What is the heron budget?", ...extra } as never, { config, configPath, provider, model } as never);
await run({ tenantId: "t1" });
await run({});
const [tenant, owner] = seen;
assert.ok(owner.includes("TEAL-OWNER-PROFILE") && owner.includes("Index of the agent's durable memories"), "control: the unscoped in-process run keeps owner context");
for (const s of ["TEAL-OWNER-PROFILE", "Index of the agent's durable memories", "PLUM-INVARIANT-PRIVATE", "CORAL-HANDOFF-TAIL"]) {
  assert.ok(!tenant.includes(s), `in-process tenant run got the owner's ${s}`);
}
assert.ok(tenant.includes("SAGE-INVARIANT-PUBLIC"), "in-process tenant run lost the invariant_audience: all rule");
await assert.rejects(run({ tenantId: "t1", sessionKey: "agent:default:main" }), /outside this run's scope/);
await assert.rejects(run({ tenantId: 7 }), /must be non-empty strings/);
const tenantPi = piSessionRunnerOptions({ routing: { mode: "pi-session", pi: { builtinTools: ["bash"] } } } as never, "tenant");
assert.deepEqual(tenantPi.builtinTools, [], "tenant Pi turns get no built-in tools");
assert.equal(tenantPi.noSkills, true);
console.log("in-process and Pi tenant assertions passed");
TS

echo "App Engine audience smoke test passed."
