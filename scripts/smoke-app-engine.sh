#!/usr/bin/env bash
set -euo pipefail

# App Engine Mode + Agent Mesh smoke (issue #14):
#   1. minimal runtime API scaffolded: mindstone.run() over the canonical chat path
#   2. scope metadata prevents cross-tenant/cross-agent recall (subset-matching rule)
#   3. shared Gateway serves agent-scoped routes: POST /agents/:agentId/runs
#   4. deterministic request routing: forced persona/workflow (authority: request > workflow > config)
#   All mock-routed — no live providers.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-app-engine-smoke.XXXXXX")"
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

echo "== App Engine Mode + Agent Mesh smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-app-engine-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"

# Seed mock routing, identity, a persona pair, a workflow, and SCOPED recall documents.
node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const configPath = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "analyst", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.gateway = { ...(config.gateway ?? {}), auth: { mode: "none" } };
config.memory = {
  autoRecall: true,
  localDocuments: [
    { id: "doc-analyst-t1", kind: "custom", title: "Tenant-one analyst playbook", text: "Substation credential rotation policy for tenant-one analysts: rotate quarterly.", metadata: { scope: { tenantId: "t1", agentId: "analyst" } } },
    { id: "doc-billing-t2", kind: "custom", title: "Tenant-two billing notes", text: "Substation credential rotation policy for tenant-two billing: rotate monthly. SENTINEL-B", metadata: { scope: { tenantId: "t2", agentId: "billing" } } },
    { id: "doc-user-u1", kind: "custom", title: "User-one preferences", text: "Substation credential rotation policy preference for user-one: terse summaries.", metadata: { scope: { tenantId: "t1", userId: "u1" } } },
    { id: "doc-global", kind: "custom", title: "Global baseline", text: "Substation credential rotation policy global baseline: log all rotations." },
  ],
};
mkdirSync(`${runtime}/agents/analyst`, { recursive: true });
writeFileSync(`${runtime}/agents/analyst/IDENTITY.md`, "# App Engine Smoke Identity\n\nIdentity sentinel: APP-ENGINE-SMOKE.");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const personas = `${runtime}/personas`;
for (const id of ["forced-persona", "workflow-persona"]) {
  mkdirSync(`${personas}/${id}`, { recursive: true });
  writeFileSync(`${personas}/${id}/PERSONA.md`, `# ${id}\n\nPersona sentinel: ${id.toUpperCase()}.`);
  writeFileSync(`${personas}/${id}/metadata.json`, JSON.stringify({ name: id }));
}

const workflows = `${runtime}/workflows`;
mkdirSync(`${workflows}/mesh-flow`, { recursive: true });
writeFileSync(`${workflows}/mesh-flow/workflow.json`, JSON.stringify({
  name: "Mesh flow",
  steps: [{ id: "route-step", kind: "route", personaId: "workflow-persona" }],
}, null, 2));
NODE

# --- 1+2+4. In-process runtime API: scope-enforced recall + deterministic request routing ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  loadMindStoneConfig,
  readTranscriptEntries,
  resolveConfigPath,
  runMindStone,
  runtimePathsFromEnv,
  scopeMatchesRecallFilter,
  scopedSessionKey,
} from "./packages/mindstone-core/src/index.ts";
import { MockMindStoneProvider } from "./packages/mindstone-gateway/src/index.ts";

const paths = runtimePathsFromEnv();
const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
assert.ok(!loaded.error, loaded.error);
const config = loaded.config!;
const provider = new MockMindStoneProvider({ responsePrefix: "Mock response" });
const model = provider.listModels()[0];
const QUERY = "what is our substation credential rotation policy";

// Session key derivation: scoped, and companion-shape degradation when unscoped.
assert.equal(
  scopedSessionKey({ appId: "app1", tenantId: "t1", userId: "u1", agentId: "analyst" }),
  "app:app1:tenant:t1:user:u1:agent:analyst:main",
);
assert.equal(scopedSessionKey({ agentId: "default" }), "agent:default:main");

// Subset-matching rule unit checks.
assert.equal(scopeMatchesRecallFilter(undefined, { agentId: "x" }), true, "global docs are always eligible");
assert.equal(scopeMatchesRecallFilter({ tenantId: "t1" }, { tenantId: "t1", userId: "u1", agentId: "a" }), true, "broader doc visible to narrower request");
assert.equal(scopeMatchesRecallFilter({ tenantId: "t2" }, { tenantId: "t1" }), false, "cross-tenant blocked");
assert.equal(scopeMatchesRecallFilter({ agentId: "a" }, {} as never), false, "agent-private doc never surfaces unscoped");

// Run 1: analyst @ t1/u1, default memoryScope=agent — sees agent+user+global docs, never tenant-two's.
const run1 = await runMindStone(
  { agentId: "analyst", tenantId: "t1", userId: "u1", input: QUERY },
  { config, provider, model },
);
assert.equal(run1.sessionKey, "tenant:t1:user:u1:agent:analyst:main");
assert.ok(run1.response.text.startsWith("Mock response:"));
const run1Ids = run1.memoryRecall!.hits.map((hit) => hit.id.split("#")[0]).sort();
assert.deepEqual(run1Ids, ["doc-analyst-t1", "doc-global", "doc-user-u1"], `run1 recall mismatch: ${run1Ids}`);
assert.ok((run1.memoryRecall!.rejectedCount ?? 0) >= 1, "cross-tenant doc must be scope-rejected");

// Run 2: same request at memoryScope=user — the agent-PRIVATE doc must drop out.
const run2 = await runMindStone(
  { agentId: "analyst", tenantId: "t1", userId: "u1", input: QUERY, memoryScope: "user", sessionKey: "tenant:t1:user:u1:agent:analyst:ms-user" },
  { config, provider, model },
);
const run2Ids = run2.memoryRecall!.hits.map((hit) => hit.id.split("#")[0]).sort();
assert.deepEqual(run2Ids, ["doc-global", "doc-user-u1"], `run2 recall mismatch: ${run2Ids}`);

// Run 3: a different agent in a different tenant sees ITS doc, not tenant-one's.
const run3 = await runMindStone(
  { agentId: "billing", tenantId: "t2", input: QUERY },
  { config, provider, model },
);
const run3Ids = run3.memoryRecall!.hits.map((hit) => hit.id.split("#")[0]).sort();
assert.deepEqual(run3Ids, ["doc-billing-t2", "doc-global"], `run3 recall mismatch: ${run3Ids}`);

// Run 4: unscoped companion-shaped run — ONLY global docs; every scoped doc is invisible.
const run4 = await runMindStone({ agentId: "solo", input: QUERY }, { config, provider, model });
assert.equal(run4.sessionKey, "agent:solo:main");
const run4Ids = run4.memoryRecall!.hits.map((hit) => hit.id.split("#")[0]).sort();
assert.deepEqual(run4Ids, ["doc-global"], `run4 recall mismatch: ${run4Ids}`);

// Run 5: memoryScope=none disables recall entirely for the run.
const run5 = await runMindStone(
  { agentId: "analyst", tenantId: "t1", input: QUERY, memoryScope: "none", sessionKey: "tenant:t1:agent:analyst:ms-none" },
  { config, provider, model },
);
assert.equal(run5.memoryRecall, undefined, "memoryScope none must disable recall");

// Run 6: deterministic request routing — forced workflow runs, forced persona BEATS its decision.
const run6 = await runMindStone(
  { agentId: "analyst", tenantId: "t1", input: "route this run", personaId: "forced-persona", workflowId: "mesh-flow", sessionKey: "tenant:t1:agent:analyst:routing" },
  { config, provider, model },
);
assert.equal(run6.workflow?.workflowId, "mesh-flow");
assert.equal(run6.workflow?.reason, "forced:request");
assert.equal(run6.workflow?.decision?.personaId, "workflow-persona", "workflow decision still evaluated");
assert.equal(run6.personaContext?.personaId, "forced-persona", "request persona must beat the workflow decision");
assert.equal(run6.personaContext?.reason, "forced:request");

// Transcript entries carry scope metadata on both user and assistant rows.
const transcript = readTranscriptEntries(run1.sessionKey);
const userRow = transcript.find((row) => row.role === "user");
const assistantRow = transcript.find((row) => row.role === "assistant");
assert.equal((userRow?.metadata?.scope as { tenantId?: string })?.tenantId, "t1");
assert.equal((assistantRow?.metadata?.scope as { tenantId?: string })?.tenantId, "t1");
console.log("app-engine runtime API + scope isolation assertions passed");
TS

# --- 3. Shared Gateway, agent-scoped route ---
./scripts/start-gateway.sh >/tmp/mindstone-agent-app-engine-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

RUN_JSON="$(curl -s -X POST "http://127.0.0.1:${GATEWAY_PORT}/agents/mesh-analyst/runs" \
  -H "Content-Type: application/json" \
  -d '{"input":"what is our substation credential rotation policy","tenantId":"t1","userId":"u1","personaId":"forced-persona","memoryScope":"agent"}')"
grep -q '"tenantId": *"t1"' <<<"${RUN_JSON}" || grep -q '"tenantId":"t1"' <<<"${RUN_JSON}"
grep -q 'Mock response' <<<"${RUN_JSON}"
grep -q '"sessionKey": *"tenant:t1:user:u1:agent:mesh-analyst:main"' <<<"${RUN_JSON}" || grep -q '"sessionKey":"tenant:t1:user:u1:agent:mesh-analyst:main"' <<<"${RUN_JSON}"
grep -q 'forced:request' <<<"${RUN_JSON}"

# A second logically isolated agent runs through the SAME gateway daemon.
RUN2_JSON="$(curl -s -X POST "http://127.0.0.1:${GATEWAY_PORT}/agents/mesh-billing/runs" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello from billing","tenantId":"t2"}')"
grep -q 'Mock response' <<<"${RUN2_JSON}"
grep -q 'agent:mesh-billing:main' <<<"${RUN2_JSON}"

# Validation failures are 400s, not crashes.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${GATEWAY_PORT}/agents/mesh-analyst/runs" -H "Content-Type: application/json" -d '{}')"
test "${CODE}" = "400"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${GATEWAY_PORT}/agents/mesh-analyst/runs" -H "Content-Type: application/json" -d '{"input":"x","memoryScope":"galaxy"}')"
test "${CODE}" = "400"

# Gateway-path transcripts carry scope metadata on user AND assistant rows
# (filenames are base64url session keys).
GW_TRANSCRIPT="${RUNTIME_DATA}/transcripts/$(node -p 'Buffer.from("tenant:t1:user:u1:agent:mesh-analyst:main","utf-8").toString("base64url")').jsonl"
test -f "${GW_TRANSCRIPT}"
test "$(grep -c '"scope"' "${GW_TRANSCRIPT}")" -ge 2

kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

echo "App Engine Mode + Agent Mesh smoke test passed."
