#!/usr/bin/env bash
set -euo pipefail

# Deterministic workflow router smoke (issue #12):
#   1. schema: steps, conditions, gates, retries, failure handling, persona/skill/KB refs
#   2. deterministic routing on configured conditions (config rule > active > persona-packaged)
#   3. transcript events: workflow_started/step/gate/finished/failed
#   4. at least one deterministic route proven on a real (mock-routed) chat turn

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-workflow-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== Deterministic workflow router smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-workflow-init.log

# Seed mock routing, identity, a persona, and two workflows.
node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "default", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.session = { mode: "single", defaultSessionKey: "agent:default:main" };
config.workflows = {
  routes: [{ workflowId: "sec-triage", messagePrefix: "sec:" }],
};
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, "# Workflow Smoke Identity\n\nIdentity sentinel: WORKFLOW-SMOKE-IDENTITY.");
writeFileSync(`${runtime}/agents/default/USER.md`, "# Workflow Smoke User\n\nUser sentinel: WORKFLOW-SMOKE-USER.");
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

const personas = `${runtime}/personas`;
mkdirSync(`${personas}/cyber-analyst`, { recursive: true });
writeFileSync(`${personas}/cyber-analyst/PERSONA.md`, "# Cyber Analyst\n\nPersona sentinel: CYBER-ANALYST-OVERLAY.");
writeFileSync(`${personas}/cyber-analyst/metadata.json`, JSON.stringify({ name: "Cyber Analyst", version: "0.1.0" }));
writeFileSync(`${personas}/cyber-analyst/workflows.json`, JSON.stringify(["packaged-flow"]));

const workflows = `${runtime}/workflows`;
mkdirSync(`${workflows}/sec-triage`, { recursive: true });
writeFileSync(`${workflows}/sec-triage/workflow.json`, JSON.stringify({
  name: "Security triage",
  version: "0.1.0",
  steps: [
    { id: "require-analyst", kind: "gate", gate: { personaLoadable: "cyber-analyst" }, retry: { maxAttempts: 2 }, onFail: "stop" },
    { id: "sec-route", kind: "route", when: { messagePrefix: "sec:" }, personaId: "cyber-analyst", skills: ["threat-intel"], knowledgebases: ["ot-kb"] },
    { id: "fallback-route", kind: "route", personaId: "general-helper" },
  ],
}, null, 2));
mkdirSync(`${workflows}/packaged-flow`, { recursive: true });
writeFileSync(`${workflows}/packaged-flow/workflow.json`, JSON.stringify({
  name: "Persona-packaged flow",
  steps: [{ id: "self-route", kind: "route", personaId: "cyber-analyst" }],
}, null, 2));
mkdirSync(`${workflows}/broken-flow`, { recursive: true });
writeFileSync(`${workflows}/broken-flow/workflow.json`, "{ not json");
NODE

# --- 1. Schema/loader + deterministic resolution unit assertions ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  discoverMindStoneWorkflows,
  loadMindStoneWorkflow,
  resolveMindStoneWorkflowId,
  runMindStoneWorkflow,
} from "./packages/mindstone-core/src/index.ts";

const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const workflowsDir = `${runtime}/workflows`;

// Discovery: two valid, one broken (surfaced, not hidden).
const summaries = discoverMindStoneWorkflows(workflowsDir);
assert.equal(summaries.length, 3);
assert.ok(summaries.find((wf) => wf.id === "broken-flow")?.error, "broken workflow.json must surface an error");

// Schema round-trip: steps, condition, gate, retry, failure policy, persona/skill/KB refs.
const loaded = loadMindStoneWorkflow(workflowsDir, "sec-triage");
assert.ok(loaded.ok);
const wf = loaded.workflow;
assert.equal(wf.steps.length, 3);
assert.deepEqual(wf.steps[0].gate, { personaLoadable: "cyber-analyst", condition: undefined });
assert.equal(wf.steps[0].retry?.maxAttempts, 2);
assert.equal(wf.steps[0].onFail, "stop");
assert.deepEqual(wf.steps[1].skills, ["threat-intel"]);
assert.deepEqual(wf.steps[1].knowledgebases, ["ot-kb"]);

const config = {
  workflows: { dir: workflowsDir, routes: [{ workflowId: "sec-triage", messagePrefix: "sec:" }] },
  personas: { dir: `${runtime}/personas`, active: "cyber-analyst" },
} as any;

// Selection precedence: config rule > persona-packaged fallback.
assert.deepEqual(
  resolveMindStoneWorkflowId({ config, turn: { sessionKey: "agent:default:main", messageText: "sec: scan the PLC" } }),
  { workflowId: "sec-triage", reason: "route:messagePrefix" },
);
assert.deepEqual(
  resolveMindStoneWorkflowId({ config, turn: { sessionKey: "agent:default:main", messageText: "hello" } }),
  { workflowId: "packaged-flow", reason: "persona:cyber-analyst" },
  "active persona's packaged workflows.json must participate in selection",
);

// Full run: gate passes (with retry config), conditional route matches, decision carries refs.
const outcome = runMindStoneWorkflow({ config, turn: { sessionKey: "agent:default:main", messageText: "sec: scan the PLC" } })!;
assert.equal(outcome.failed, false);
assert.equal(outcome.decision?.stepId, "sec-route");
assert.equal(outcome.decision?.personaId, "cyber-analyst");
assert.deepEqual(outcome.decision?.skills, ["threat-intel"]);
const eventNames = outcome.events.map((event) => event.event);
assert.deepEqual(eventNames, ["workflow_started", "workflow_gate", "workflow_step", "workflow_finished"]);

// Non-matching message falls through the conditional route to the unconditional fallback.
const fallback = runMindStoneWorkflow({ config: { workflows: { dir: workflowsDir, active: "sec-triage" }, personas: { dir: `${runtime}/personas` } } as any, turn: { sessionKey: "agent:default:main", messageText: "hello" } })!;
assert.equal(fallback.decision?.stepId, "fallback-route");

// Gate failure with onFail=stop -> workflow_failed, no decision.
const failing = runMindStoneWorkflow({
  config: { workflows: { dir: workflowsDir, active: "sec-triage" }, personas: { dir: `${runtime}/personas-missing` } } as any,
  turn: { sessionKey: "agent:default:main", messageText: "sec: x" },
})!;
assert.equal(failing.failed, true);
assert.equal(failing.decision, undefined);
assert.ok(failing.events.some((event) => event.event === "workflow_failed"));
console.log("workflow schema/resolution assertions passed");
TS

# --- 2. Real chat turn: deterministic route -> persona forced by workflow + transcript events ---
CHAT_JSON="$(./scripts/mindstone chat --once "sec: check the substation logs" --json)"
grep -q '"workflowId": "sec-triage"' <<<"${CHAT_JSON}"
grep -q '"personaId": "cyber-analyst"' <<<"${CHAT_JSON}"
grep -q 'workflow:sec-triage/step:sec-route' <<<"${CHAT_JSON}"

TRANSCRIPT_FILE="$(ls "${TEMP_RUNTIME}"/mindstone/transcripts/*.jsonl | head -1)"
grep -q "workflow_started" "${TRANSCRIPT_FILE}"
grep -q "workflow_gate" "${TRANSCRIPT_FILE}"
grep -q "workflow_finished" "${TRANSCRIPT_FILE}"

# Non-matching message: no workflow rule fires and no persona is configured -> no workflow context.
CHAT_PLAIN="$(./scripts/mindstone chat --once "hello there" --json)"
if grep -q '"workflowId"' <<<"${CHAT_PLAIN}"; then
  echo "workflow context should be absent for non-matching turn with no active workflow/persona" >&2
  exit 1
fi

echo "Deterministic workflow router smoke test passed."
