#!/usr/bin/env bash
# Agent-proposed persona components (#125, part 3): a persona proposal can
# list existing skills, workflows and shared KBs, and bring new ones, each on
# its own approval card linked to the persona's.
#   - parsing: bad components drop the whole proposal; a proposed workflow
#     can't name a persona
#   - a component card waits for its persona card; rejecting the persona
#     rejects its pending components
#   - approving the persona writes its lists; each approved component joins
#     its persona; a proposed private KB is written and ingested
#   - approving never activates; a non-owner's proposal is dropped
#   - refusals: an unknown listed component, a skill already installed (no
#     force), a workflow id the config runs
# The mock model echoes the user's message, so a message holding the block
# stands in for a model that proposes. Binds gateway port base+38; serialize
# per smoke protocol. Synthetic strings only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-proposal-components-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 38))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export PC_TOKEN="proposal-components-smoke-service-token"
export PC_ADMIN_TOKEN="proposal-components-smoke-admin-token"
export CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
cd "${PROJECT_ROOT}"
echo "== Persona proposal components smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
BASE="http://127.0.0.1:${GATEWAY_PORT}"
BODY="${TEMP_RUNTIME}/body.json"

# --- 0. Units: parsing, and the pending caps.
npx tsx <<'TS'
import assert from "node:assert/strict";
import { join } from "node:path";
import { applyActionProposalDiscipline, ApprovalStore, extractActionProposals, MAX_PENDING_COMPONENTS, parsePersonaComponents } from "./packages/mindstone-core/src/index.ts";
const route = (extra = {}) => ({ id: "s", kind: "route", ...extra });
assert.ok(parsePersonaComponents({ skills: ["a"], new: { workflows: [{ id: "w", steps: [route()] }] } }), "a plain component list parses");
assert.equal(parsePersonaComponents({ new: { workflows: [{ id: "w", steps: [route({ personaId: "x" })] }] } }), undefined, "a proposed workflow routing to a persona must be refused");
assert.equal(parsePersonaComponents({ new: { workflows: [{ id: "w", steps: [{ id: "g", kind: "gate", gate: { personaLoadable: "x" } }] }] } }), undefined, "a proposed gate on a persona must be refused");
assert.equal(parsePersonaComponents({ skills: ["a"], extra: 1 }), undefined, "an unknown key must be refused");
assert.equal(parsePersonaComponents({ new: { privateKnowledgebases: [{ id: "k", sources: [{ text: "hidden​mark" }] }] } }), undefined, "an invisible character in a source must be refused");
assert.equal(parsePersonaComponents({ new: { privateKnowledgebases: [{ id: "../k", sources: [{ text: "x" }] }] } }), undefined, "a path as a KB id must be refused");
assert.equal(parsePersonaComponents({ skills: ["../x"] }), undefined, "a path as a listed id must be refused");
const skill = (id) => ({ id, label: "L", description: "D", whenToUse: ["w"], outputs: ["o"], safetyNotes: ["s"] });
assert.equal(parsePersonaComponents({ new: { skills: [skill("a1"), skill("a2"), skill("a3"), skill("a4")] } }), undefined, "more than 3 new skills must be refused");
const block = (json) => "Here it is.\n```mindstone-persona-proposal\n" + JSON.stringify(json) + "\n```";
const base = { id: "unit", name: "Unit", voice: "Plain." };
assert.equal(extractActionProposals(block({ ...base, components: { bogus: true } })).persona, undefined, "a persona with bad components must be dropped whole");
assert.equal(extractActionProposals(block({ ...base, components: { skills: ["a"] } })).persona?.id, "unit");
// Caps: past MAX_PENDING_COMPONENTS of a kind, the whole proposal is dropped, with a note.
const store = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "unit-approvals.json") });
const kbs = (n) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, sources: [{ text: "x" }] }));
for (let i = 0; i < 3; i += 1) {
  const r = applyActionProposalDiscipline({ replyText: block({ ...base, id: `cap${i}`, components: { new: { privateKnowledgebases: kbs(2) } } }), origin: "unit", allowPersona: true, store });
  assert.equal(r.proposals.length, 3, `proposal ${i} should make a persona card and two KB cards`);
}
assert.equal(store.pending().filter((a) => a.kind === "persona_kb_create").length, MAX_PENDING_COMPONENTS);
// The persona cards are decided, so only the KB cap can refuse the next one (the persona cap is 3).
for (const card of store.pending().filter((a) => a.kind === "persona_create")) store.decide(card.id, { status: "approved", decidedBy: "unit", now: "t" });
const capped = applyActionProposalDiscipline({ replyText: block({ id: "cap9", name: "Cap", voice: "x", components: { new: { privateKnowledgebases: kbs(1) } } }), origin: "unit", allowPersona: true, store });
assert.equal(capped.proposals.length, 0, "a proposal past the KB cap must be dropped whole");
assert.match(capped.text, /wasn't saved/);
console.log("units ok");
TS

python3 - <<'PY'
import json, os, pathlib
data = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone"
p = data / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "PC_TOKEN"}
c["gateway"]["admin"] = {"tokenEnv": "PC_ADMIN_TOKEN"}
c["gateway"]["http"] = {"chatCompletions": {"enabled": True}}
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "pc", "captureFile": os.environ["CAPTURE"]}}
c["memory"] = {"autoRecall": True}
c["workflows"] = {"active": "wf-live"}
p.write_text(json.dumps(c, indent=2) + "\n")
def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)
write(data / "skills" / "alpha-skill" / "skill.json", json.dumps({"id": "alpha-skill", "label": "Alpha", "description": "Alpha sentinel."}))
write(data / "skills" / "alpha-skill" / "SKILL.md", "# alpha\n\nSkill body SKILLBODY-alpha.\n")
write(data / "knowledgebases" / "g1" / "kb.json", json.dumps({"name": "g1"}))
write(data / "knowledgebases" / "g1" / "sources" / "notes.md", "# Notes\n\nThe shared reference code is GPROP-9900 for this collection.\n")
PY
./scripts/mindstone kb ingest g1 --json >/dev/null
./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

ADMIN=(-H "Authorization: Bearer ${PC_TOKEN}" -H "x-mindstone-admin-token: ${PC_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
call() { if [[ $# -ge 3 ]]; then curl -s -o "${BODY}" -w '%{http_code}' -X "$1" "${ADMIN[@]}" -d "$3" "${BASE}$2"; else curl -s -o "${BODY}" -w '%{http_code}' -X "$1" "${ADMIN[@]}" "${BASE}$2"; fi; }
expect() { # expect <status> <what> <method> <path> [json] [body part]
  local want="$1" what="$2"; shift 2
  local got; got="$(call "$1" "$2" ${3:+"$3"})"
  [[ "${got}" == "${want}" ]] || { echo "${what}: expected ${want}, got ${got}: $(cat "${BODY}")" >&2; exit 1; }
  if [[ -n "${4:-}" ]]; then grep -qF -- "$4" "${BODY}" || { echo "${what}: the body lacks '$4': $(cat "${BODY}")" >&2; exit 1; }; fi
}
# say <role> <conversation> <message>: the mock echoes it, so a block in it is proposed.
say() {
  : > "${CAPTURE}"
  local payload code
  payload="$(TEXT="$3" node -e 'process.stdout.write(JSON.stringify({ model: "mindstone/default", messages: [{ role: "user", content: process.env.TEXT }] }))')"
  code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${PC_TOKEN}" -H 'content-type: application/json' \
    -H "x-mindstone-user-role: $1" -H "x-mindstone-user-id: smoke-$1" -H "x-mindstone-conversation-id: $2" -d "${payload}" "${BASE}/v1/chat/completions")"
  [[ "${code}" == 200 ]] || { echo "chat $2 failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
}
proposal() { # proposal <json>: a reply that ends with a persona proposal block
  printf 'Here is a persona for you.\n```mindstone-persona-proposal\n%s\n```' "$1"
}
# card <persona-id> <kind>: the id of that persona's card of that kind, from the approvals store
card() {
  PID="$1" KIND="$2" node -e '
const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).actions;
const persona = a.find((x) => x.kind === "persona_create" && x.persona?.id === process.env.PID);
if (!persona) { console.error("no persona card for " + process.env.PID); process.exit(1); }
const found = process.env.KIND === "persona_create" ? persona : a.find((x) => x.kind === process.env.KIND && x.parentApprovalId === persona.id);
if (!found) { console.error("no " + process.env.KIND + " card for " + process.env.PID); process.exit(1); }
process.stdout.write(found.id);' "${DATA}/approvals/actions.json"
}
status_of() { ID="$1" node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).actions; process.stdout.write(a.find((x) => x.id === process.env.ID)?.status ?? "none");' "${DATA}/approvals/actions.json"; }

NEW_SKILL='{"id":"beta-new","label":"Beta","description":"A proposed skill.","whenToUse":["when asked"],"outputs":["a note"],"safetyNotes":["none"],"instructions":"# Beta\n\nSkill body SKILLBODY-beta-new."}'
P2_JSON='{"id":"p2","name":"Proposed Two","voice":"Plain and short.","components":{"skills":["alpha-skill"],"knowledgebases":["g1"],"new":{"skills":['"${NEW_SKILL}"'],"workflows":[{"id":"wf-p2","steps":[{"id":"route-it","kind":"route","when":{"messagePrefix":"p2:"}}]}],"privateKnowledgebases":[{"id":"notes","sources":[{"text":"# Notes\n\nThe private reference code is PPROP-9901 for this collection."}]}]}}}'
P2="$(proposal "${P2_JSON}")"

# --- 1. The owner's agent proposes persona p2 with components: four cards, the proposal gone from the reply.
say admin conv-propose "${P2}"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const reply=b.choices?.[0]?.message?.content ?? ""; if (!reply || reply.includes("mindstone-persona-proposal")) { console.error("the proposal block reached the reply: " + reply); process.exit(1); }' "${BODY}"
PERSONA_CARD="$(card p2 persona_create)"; SKILL_CARD="$(card p2 skill_install)"; WF_CARD="$(card p2 workflow_create)"; KB_CARD="$(card p2 persona_kb_create)"
echo "cards ok"

# --- 2. A component waits for its persona.
expect 409 "the KB card before the persona" POST "/admin/approvals/${KB_CARD}/approve" '{}' persona_pending
[[ ! -e "${DATA}/personas/p2" ]] || { echo "a component card wrote the persona" >&2; exit 1; }
# --- 3. Approving the persona writes it and its listed components, and doesn't activate it.
expect 200 "approve the persona" POST "/admin/approvals/${PERSONA_CARD}/approve" '{}'
[[ "$(tr -d ' \n' < "${DATA}/personas/p2/skills.json")" == '["alpha-skill"]' ]] || { echo "the persona's listed skills weren't written" >&2; exit 1; }
[[ "$(tr -d ' \n' < "${DATA}/personas/p2/knowledgebases.json")" == '["g1"]' ]] || { echo "the persona's listed KBs weren't written" >&2; exit 1; }
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (c.personas?.active) { console.error("approving activated a persona"); process.exit(1); }' "${DATA}/config.json"
# --- 4. Each component card, then, joins its persona.
expect 403 "a skill card without advanced settings" POST "/admin/approvals/${SKILL_CARD}/approve" '{}'
expect 200 "grant advanced settings" POST /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}'
expect 200 "approve the skill card" POST "/admin/approvals/${SKILL_CARD}/approve" '{}'
grep -q '"beta-new"' "${DATA}/personas/p2/skills.json" || { echo "the approved skill didn't join its persona" >&2; exit 1; }
expect 200 "approve the workflow card" POST "/admin/approvals/${WF_CARD}/approve" '{}'
[[ -f "${DATA}/workflows/wf-p2/workflow.json" ]] || { echo "the approved workflow wasn't written" >&2; exit 1; }
grep -q '"wf-p2"' "${DATA}/personas/p2/workflows.json" || { echo "the approved workflow didn't join its persona" >&2; exit 1; }
expect 200 "approve the KB card" POST "/admin/approvals/${KB_CARD}/approve" '{}' '"entryCount"'
[[ -f "${DATA}/personas/p2/knowledgebases/notes/index.json" ]] || { echo "the approved KB wasn't ingested" >&2; exit 1; }
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (c.personas?.active) { console.error("approving a component activated a persona"); process.exit(1); }' "${DATA}/config.json"
echo "approvals ok"

# --- 5. Switched to, p2 answers with its components: its private KB, its listed and new skills, its shared KB.
expect 200 "switch to p2" PATCH /admin/config/personas '{"active":"p2"}'
say admin conv-p2 "Which private reference code applies for this collection?"
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); process.stdout.write(JSON.parse(l.pop()).messages.map((m)=>m.text??"").join("\n"))' "${CAPTURE}" > "${TEMP_RUNTIME}/p2.prompt"
for text in PPROP-9901 GPROP-9900 SKILLBODY-alpha SKILLBODY-beta-new; do grep -qF "${text}" "${TEMP_RUNTIME}/p2.prompt" || { echo "p2: '${text}' is missing from the prompt" >&2; exit 1; }; done
expect 200 "switch back to none" PATCH /admin/config/personas '{"active":null}'
echo "persona in use ok"

# --- 6. Rejecting a persona rejects its pending components; nothing is written.
say admin conv-p3 "$(proposal '{"id":"p3","name":"Three","voice":"x","components":{"new":{"privateKnowledgebases":[{"id":"n3","sources":[{"text":"# N\n\nNothing."}]}]}}}')"
P3="$(card p3 persona_create)"; P3KB="$(card p3 persona_kb_create)"
expect 409 "p3's KB before p3" POST "/admin/approvals/${P3KB}/approve" '{}' persona_pending
expect 200 "reject p3" POST "/admin/approvals/${P3}/reject" '{"note":"not now"}'
[[ "$(status_of "${P3KB}")" == rejected ]] || { echo "rejecting the persona left its KB card $(status_of "${P3KB}")" >&2; exit 1; }
[[ ! -e "${DATA}/personas/p3" ]] || { echo "a rejected persona was written" >&2; exit 1; }
echo "reject cascade ok"

# --- 7. Refusals at approval.
# A listed component that doesn't exist.
say admin conv-p4 "$(proposal '{"id":"p4","name":"Four","voice":"x","components":{"skills":["ghost-skill"]}}')"
expect 422 "a persona listing a skill that doesn't exist" POST "/admin/approvals/$(card p4 persona_create)/approve" '{}' unknown_component
[[ ! -e "${DATA}/personas/p4" ]] || { echo "a refused persona was written" >&2; exit 1; }
# A new skill already installed: refused, even with force.
# (Single-quoted: macOS bash 3.2 mangles escaped quotes nested in "$( )".)
P5='{"id":"p5","name":"Five","voice":"x","components":{"new":{"skills":[{"id":"alpha-skill","label":"A","description":"D","whenToUse":["w"],"outputs":["o"],"safetyNotes":["s"]}],"workflows":[{"id":"wf-live","steps":[{"id":"s","kind":"route"}]}]}}}'
say admin conv-p5 "$(proposal "${P5}")"
expect 200 "approve p5" POST "/admin/approvals/$(card p5 persona_create)/approve" '{}'
expect 409 "a new skill that is installed, with force" POST "/admin/approvals/$(card p5 skill_install)/approve" '{"force":true}' skill_exists
grep -q 'SKILLBODY-alpha' "${DATA}/skills/alpha-skill/SKILL.md" || { echo "the installed skill was replaced" >&2; exit 1; }
# A workflow id the config runs.
expect 409 "a proposed workflow the config runs" POST "/admin/approvals/$(card p5 workflow_create)/approve" '{}' workflow_referenced
[[ ! -e "${DATA}/workflows/wf-live" ]] || { echo "a workflow the config runs was created" >&2; exit 1; }
echo "refusals ok"

# --- 8. A non-owner's proposal, and one whose workflow routes to a persona, are dropped whole.
before="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).actions.length))' "${DATA}/approvals/actions.json")"
say user conv-user "$(proposal '{"id":"p6","name":"Six","voice":"x","components":{"skills":["alpha-skill"]}}')"
say admin conv-route "$(proposal '{"id":"p7","name":"Seven","voice":"x","components":{"new":{"workflows":[{"id":"wf-hijack","steps":[{"id":"s","kind":"route","personaId":"p2"}]}]}}}')"
after="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).actions.length))' "${DATA}/approvals/actions.json")"
[[ "${before}" == "${after}" ]] || { echo "a dropped proposal made cards (${before} -> ${after})" >&2; exit 1; }
echo "dropped ok"

echo "Persona proposal components smoke test passed."
