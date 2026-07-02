#!/usr/bin/env bash
set -euo pipefail

# Skill Builder smoke (issue #13):
#   1. stable skill artifact schema on disk (skill.json + SKILL.md)
#   2. draft -> install approval path (drafts are not usable until installed)
#   3. skill discovery/status (built-ins + installed + drafts + broken surfaced)
#   4. Integration Builder is the first built-in example (draft seeded from it)
#   5. generate + load one local skill end-to-end via the CLI

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-skill-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== Skill Builder smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-skill-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"
SKILLS_DIR="${RUNTIME_DATA}/skills"

# --- 1. Built-in surfaces discoverable before any artifact exists ---
LIST_JSON="$(./scripts/mindstone skill list --json)"
grep -q '"id": "integration-builder"' <<<"${LIST_JSON}"
grep -q '"source": "builtin"' <<<"${LIST_JSON}"

# --- 2. Generate a custom DRAFT artifact ---
BUILD_JSON="$(./scripts/mindstone skill build --id threat-triage --label "Threat Triage" \
  --description "Deterministic triage checklist for inbound threat reports" \
  --when "triaging a new threat report" --output "triage checklist" --safety "never auto-block without approval" --json)"
grep -q '"skillId": "threat-triage"' <<<"${BUILD_JSON}"
test -f "${SKILLS_DIR}/drafts/threat-triage/skill.json"
test -f "${SKILLS_DIR}/drafts/threat-triage/SKILL.md"
grep -q '"origin": "custom"' "${SKILLS_DIR}/drafts/threat-triage/skill.json"

# Draft refuses silent overwrite without --force.
if ./scripts/mindstone skill build --id threat-triage --label "x" --description "y" >/dev/null 2>&1; then
  echo "draft overwrite without --force should fail" >&2
  exit 1
fi

# --- 3. Draft seeded from the built-in Integration Builder example ---
./scripts/mindstone skill build --from-builtin integration-builder --id my-integration-builder --json >/dev/null
grep -q '"origin": "builtin:integration-builder"' "${SKILLS_DIR}/drafts/my-integration-builder/skill.json"
grep -q "Integration Builder" "${SKILLS_DIR}/drafts/my-integration-builder/SKILL.md"

# --- 4. Discovery/status show drafts as pending approval ---
STATUS_JSON="$(./scripts/mindstone skill status --json)"
grep -q '"draft": 2' <<<"${STATUS_JSON}"
grep -q '"installed": 0' <<<"${STATUS_JSON}"

# --- 5. Approval path: install promotes the draft ---
./scripts/mindstone skill install threat-triage --json >/dev/null
test -f "${SKILLS_DIR}/threat-triage/skill.json"
test ! -d "${SKILLS_DIR}/drafts/threat-triage"
STATUS_JSON="$(./scripts/mindstone skill status --json)"
grep -q '"installed": 1' <<<"${STATUS_JSON}"
grep -q '"draft": 1' <<<"${STATUS_JSON}"

# Installing an id with no draft fails loudly.
if ./scripts/mindstone skill install no-such-skill >/dev/null 2>&1; then
  echo "installing a missing draft should fail" >&2
  exit 1
fi

# --- 6. Load the installed skill (SKILL.md is the loadable surface) ---
LOAD_OUT="$(./scripts/mindstone skill load threat-triage)"
grep -q "Threat Triage" <<<"${LOAD_OUT}"
grep -q "never auto-block without approval" <<<"${LOAD_OUT}"
LOAD_JSON="$(./scripts/mindstone skill load threat-triage --json)"
grep -q '"source": "installed"' <<<"${LOAD_JSON}"

# --- 7. Broken artifact surfaces an error instead of vanishing ---
mkdir -p "${SKILLS_DIR}/broken-skill"
echo "{ not json" > "${SKILLS_DIR}/broken-skill/skill.json"
LIST_JSON="$(./scripts/mindstone skill list --json)"
grep -q '"id": "broken-skill"' <<<"${LIST_JSON}"
grep -q '"error"' <<<"${LIST_JSON}"

# --- 8. Persona skills[] refs resolve against the skill catalog ---
node <<'NODE'
const { mkdirSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const { readFileSync } = require("node:fs");
const configPath = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.personas = { active: "triage-analyst" };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const dir = `${runtime}/personas/triage-analyst`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/PERSONA.md`, "# Triage Analyst\n\nPersona sentinel.");
writeFileSync(`${dir}/metadata.json`, JSON.stringify({ name: "Triage Analyst" }));
writeFileSync(`${dir}/skills.json`, JSON.stringify(["threat-triage", "integration-builder", "ghost-skill"]));
NODE
STATUS_JSON="$(./scripts/mindstone skill status --json)"
grep -q '"id": "threat-triage",' <<<"${STATUS_JSON}"
grep -q '"status": "installed"' <<<"${STATUS_JSON}"
grep -q '"status": "builtin"' <<<"${STATUS_JSON}"
grep -q '"status": "missing"' <<<"${STATUS_JSON}"

# --- 9. Unit-level loader assertions (installed wins over draft; validation errors surface) ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  buildMindStoneSkillDraft,
  discoverMindStoneSkills,
  installMindStoneSkill,
  loadMindStoneSkill,
  resolveSkillRefs,
} from "./packages/mindstone-core/src/index.ts";

const skillsDir = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/skills`;

const skills = discoverMindStoneSkills(skillsDir);
assert.ok(skills.find((skill) => skill.id === "integration-builder" && skill.source === "builtin"));
assert.ok(skills.find((skill) => skill.id === "threat-triage" && skill.source === "installed"));
assert.ok(skills.find((skill) => skill.id === "my-integration-builder" && skill.source === "draft"));
assert.ok(skills.find((skill) => skill.id === "broken-skill")?.error, "broken skill.json must surface an error");

const loaded = loadMindStoneSkill(skillsDir, "threat-triage");
assert.ok(loaded.ok);
assert.equal(loaded.skill.source, "installed");
assert.equal(loaded.skill.artifact.label, "Threat Triage");
assert.ok(loaded.skill.skillMarkdown?.includes("Threat Triage"));

// Draft shadowed by install: drafting the same id again (force) then loading resolves installed first.
const rebuilt = buildMindStoneSkillDraft({ skillsDir, id: "threat-triage", label: "Shadow", description: "shadow draft", force: true });
assert.ok(rebuilt.ok);
const shadowed = loadMindStoneSkill(skillsDir, "threat-triage");
assert.ok(shadowed.ok && shadowed.skill.source === "installed", "installed artifact must win over a draft of the same id");

const refs = resolveSkillRefs(["threat-triage", "integration-builder", "ghost-skill"], skillsDir);
assert.deepEqual(refs.map((ref) => ref.status), ["installed", "builtin", "missing"]);

const badInstall = installMindStoneSkill(skillsDir, "definitely-missing");
assert.ok(!badInstall.ok);
console.log("skill artifact assertions passed");
TS

echo "Skill Builder smoke test passed."
