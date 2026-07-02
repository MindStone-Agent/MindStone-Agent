#!/usr/bin/env bash
set -euo pipefail

# Persona Package MVP smoke (issue #11):
#   1. persona artifacts load; overlay precedence is BELOW core identity
#   2. activation/deactivation emit transcript events + config changes
#   3. deterministic route rule wins over static active persona
#   4. status/doctor/TUI surface the active persona
#   5. everything runs against mock routing — no live provider

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-persona-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== Persona package smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-persona-init.log

# Seed mock routing + identity + two personas (one with safety.md, one broken).
node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "default", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.session = { mode: "single", defaultSessionKey: "agent:default:main" };
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, "# Persona Smoke Identity\n\nIdentity sentinel: PERSONA-SMOKE-IDENTITY.");
writeFileSync(`${runtime}/agents/default/USER.md`, "# Persona Smoke User\n\nUser sentinel: PERSONA-SMOKE-USER.");
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

const personas = `${runtime}/personas`;
mkdirSync(`${personas}/cyber-analyst`, { recursive: true });
writeFileSync(`${personas}/cyber-analyst/PERSONA.md`, "# Cyber Analyst\n\nPersona sentinel: CYBER-ANALYST-OVERLAY.");
writeFileSync(`${personas}/cyber-analyst/metadata.json`, JSON.stringify({ name: "Cyber Analyst", version: "0.1.0", description: "Threat-intel role overlay" }));
writeFileSync(`${personas}/cyber-analyst/safety.md`, "Safety sentinel: NO-DESTRUCTIVE-SCANS.");
writeFileSync(`${personas}/cyber-analyst/skills.json`, JSON.stringify(["integration-builder"]));
mkdirSync(`${personas}/broken-persona`, { recursive: true });
writeFileSync(`${personas}/broken-persona/metadata.json`, "{}");
NODE

# --- 1. Loader + precedence proof (persona overlay sits BELOW core identity) ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  buildMindStoneRoutePlan,
  discoverMindStonePersonas,
  loadMindStonePersona,
  personasDirFromConfig,
  resolveMindStonePersona,
  resolveRoutePersonaContext,
} from "./packages/mindstone-core/src/index.ts";

const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const personasDir = `${runtime}/personas`;

const summaries = discoverMindStonePersonas(personasDir);
assert.equal(summaries.length, 2, "expected two persona dirs discovered");
const analyst = summaries.find((persona) => persona.id === "cyber-analyst")!;
assert.equal(analyst.name, "Cyber Analyst");
assert.equal(analyst.hasSafety, true);
assert.equal(analyst.skillCount, 1);
const broken = summaries.find((persona) => persona.id === "broken-persona")!;
assert.ok(broken.error, "broken persona (no PERSONA.md) must surface an error");

const loaded = loadMindStonePersona(personasDir, "cyber-analyst");
assert.ok(loaded.ok);

// Deterministic resolution: route rule wins over static active.
const config = {
  personas: {
    dir: personasDir,
    active: "cyber-analyst",
    routes: [{ personaId: "routed-persona", sessionKeyPrefix: "agent:default:sec" }],
  },
} as any;
assert.deepEqual(resolveMindStonePersona({ config, sessionKey: "agent:default:main" }), { personaId: "cyber-analyst", reason: "config.active" });
assert.deepEqual(resolveMindStonePersona({ config, sessionKey: "agent:default:sec-ops" }), { personaId: "routed-persona", reason: "route:sessionKeyPrefix" });
assert.equal(resolveMindStonePersona({ config: { personas: {} } as any, sessionKey: "agent:default:main" }), undefined);

// Route-context load failure surfaces (routed persona does not exist on disk).
const failed = resolveRoutePersonaContext({ config, sessionKey: "agent:default:sec-ops" });
assert.ok(failed.error, "missing routed persona must surface a load error");
assert.equal(failed.resolution?.personaId, "routed-persona");

// Precedence: identity system message FIRST, persona overlay SECOND.
const context = resolveRoutePersonaContext({ config, sessionKey: "agent:default:main" });
assert.ok(context.context, "active persona should produce a route context");
const plan = buildMindStoneRoutePlan({
  agentId: "default",
  sessionKey: "agent:default:main",
  entries: [{ id: "u1", timestamp: new Date().toISOString(), sessionKey: "agent:default:main", agentId: "default", role: "user", text: "hello" } as any],
  model: { id: "mindstone/mock", provider: "mindstone", name: "mock", contextWindowTokens: 128000 },
  identityContext: { name: "Persona Smoke", identityMarkdown: "IDENTITY-CORE-SENTINEL", userMarkdown: "USER-SENTINEL" },
  personaContext: context.context,
});
assert.ok(plan.messages[0].text?.includes("IDENTITY-CORE-SENTINEL"), "core identity must be the first system message");
assert.ok(plan.messages[1].text?.includes("CYBER-ANALYST-OVERLAY"), "persona overlay must come after core identity");
assert.ok(plan.messages[1].text?.includes("NO-DESTRUCTIVE-SCANS"), "persona safety.md must ride the overlay");
assert.ok(plan.messages[1].text?.includes("never overrides the core identity"), "overlay prompt must state precedence");
assert.equal(plan.personaContext?.personaId, "cyber-analyst");
assert.ok((plan.personaContext?.tokenEstimate ?? 0) > 0);
console.log("persona loader/precedence assertions passed");
TS

# --- 2. CLI activation/deactivation with transcript events ---
ACTIVATE_JSON="$(./scripts/mindstone persona activate cyber-analyst --json)"
grep -q '"activated": "cyber-analyst"' <<<"${ACTIVATE_JSON}"
LIST_OUTPUT="$(./scripts/mindstone persona list)"
grep -q "cyber-analyst" <<<"${LIST_OUTPUT}"
grep -q "active" <<<"${LIST_OUTPUT}"
STATUS_JSON="$(./scripts/mindstone persona status --json)"
grep -q '"personaId": "cyber-analyst"' <<<"${STATUS_JSON}"

TRANSCRIPT_FILE="$(ls "${TEMP_RUNTIME}"/mindstone/transcripts/*.jsonl | head -1)"
grep -q "persona_activated" "${TRANSCRIPT_FILE}"

# --- 3. Mock chat turn carries the persona context ---
CHAT_JSON="$(./scripts/mindstone chat --once "persona smoke ping" --json)"
grep -q '"personaId": "cyber-analyst"' <<<"${CHAT_JSON}"
grep -q '"reason": "config.active"' <<<"${CHAT_JSON}"

# --- 4. status/doctor/TUI visibility ---
STATUS_OUTPUT="$(./scripts/mindstone status)"
grep -q "Persona active: cyber-analyst (config.active)" <<<"${STATUS_OUTPUT}"
DOCTOR_OUTPUT="$(./scripts/mindstone doctor || true)"
grep -q "personas.catalog" <<<"${DOCTOR_OUTPUT}"
grep -q "Configured active persona loads" <<<"${DOCTOR_OUTPUT}"
grep -q "broken-persona" <<<"${DOCTOR_OUTPUT}"

# --- 5. deactivate ---
DEACTIVATE_JSON="$(./scripts/mindstone persona deactivate --json)"
grep -q '"deactivated": "cyber-analyst"' <<<"${DEACTIVATE_JSON}"
grep -q "persona_deactivated" "${TRANSCRIPT_FILE}"
CHAT_JSON_AFTER="$(./scripts/mindstone chat --once "no persona ping" --json)"
if grep -q '"personaId"' <<<"${CHAT_JSON_AFTER}"; then
  echo "persona context should be absent after deactivation" >&2
  exit 1
fi

echo "Persona package smoke test passed."
