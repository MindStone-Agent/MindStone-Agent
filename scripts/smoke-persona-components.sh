#!/usr/bin/env bash
# Persona components at run time (#125): while a persona is active, its
# skills, workflows and knowledge bases are the ones in play.
#   - skills: only the persona's listed skills are in the owner prompt; a
#     listed skill that isn't installed is skipped and recorded
#   - global KBs: only the collections it lists; with none listed, all of them
#   - private KBs: the persona's own, never another persona's (same KB id in
#     both), on owner turns and tenant App Engine runs; non-owner chats get none
#   - workflows: every listed workflow is a candidate, in order; a step that
#     routes to another persona brings that persona's components, and a
#     step's skills and knowledgebases narrow them
#   - a linked knowledgebases folder is not searched
#   - `mindstone kb … --persona <id>` works on private KBs and checks its ids
# Binds gateway port base+35; serialize per smoke protocol. Synthetic strings only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-persona-components-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 35))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export COMPONENTS_TOKEN="persona-components-smoke-service-token"
export CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
cd "${PROJECT_ROOT}"
echo "== Persona components smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
BASE="http://127.0.0.1:${GATEWAY_PORT}"
BODY="${TEMP_RUNTIME}/body.json"

python3 - <<'PY'
import json, os, pathlib
data = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone"
p = data / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "COMPONENTS_TOKEN"}
c["gateway"]["http"] = {"chatCompletions": {"enabled": True}}
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "components", "captureFile": os.environ["CAPTURE"]}}
c["memory"] = {"autoRecall": True}
c["personas"] = {"active": "persona-one"}
p.write_text(json.dumps(c, indent=2) + "\n")

def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)

def kb(root, kb_id, fact):
    write(root / kb_id / "kb.json", json.dumps({"name": kb_id, "version": "0.1.0"}))
    write(root / kb_id / "sources" / "notes.md", f"# Notes\n\nThe reference code is {fact} for this collection.\n")

for skill in ["alpha-skill", "beta-skill", "gamma-skill"]:
    write(data / "skills" / skill / "skill.json", json.dumps({"id": skill, "label": skill.upper(), "description": f"The {skill} sentinel."}))
    write(data / "skills" / skill / "SKILL.md", f"# {skill}\n\nSkill body sentinel SKILLBODY-{skill}.\n")

kb(data / "knowledgebases", "global-attached", "GATTACHED-7101")
kb(data / "knowledgebases", "global-other", "GOTHER-7102")

def persona(pid, skills=None, kbs=None, workflows=None):
    d = data / "personas" / pid
    write(d / "PERSONA.md", f"# {pid}\n\nPersona sentinel {pid.upper()}.\n")
    if skills is not None: write(d / "skills.json", json.dumps(skills))
    if kbs is not None: write(d / "knowledgebases.json", json.dumps(kbs))
    if workflows is not None: write(d / "workflows.json", json.dumps(workflows))
    return d

one = persona("persona-one", ["alpha-skill", "ghost-skill"], ["global-attached"], ["wf-nomatch", "wf-one"])
kb(one / "knowledgebases", "notes", "PONE-7103")
two = persona("persona-two")
# The same private KB id as persona-one's: the namespaces must not mix.
kb(two / "knowledgebases", "notes", "PTWO-7104")
# A second private KB, which wf-route's step leaves out.
kb(two / "knowledgebases", "extra", "PEXTRA-7106")
persona("persona-three", workflows=["wf-route"])
link = persona("persona-link")
kb(data / "outside", "notes", "PLINK-7105")
os.symlink(data / "outside", link / "knowledgebases")

def workflow(wid, steps):
    write(data / "workflows" / wid / "workflow.json", json.dumps({"name": wid, "steps": steps}))
workflow("wf-nomatch", [{"id": "never", "kind": "route", "when": {"messagePrefix": "zzz-never"}}])
workflow("wf-one", [{"id": "always", "kind": "route"}])
# Routes to persona-two, and narrows: one skill, and KBs by id (its private
# "notes" plus the global "global-other").
workflow("wf-route", [{"id": "hand-off", "kind": "route", "personaId": "persona-two", "skills": ["beta-skill"], "knowledgebases": ["notes", "global-other"]}])
PY

for kb_id in global-attached global-other; do ./scripts/mindstone kb ingest "${kb_id}" --json >/dev/null; done
./scripts/mindstone kb ingest --persona persona-one notes --json >/dev/null
./scripts/mindstone kb ingest notes --persona persona-two --json >/dev/null
./scripts/mindstone kb ingest --persona persona-two extra --json >/dev/null
[[ -f "${DATA}/personas/persona-one/knowledgebases/notes/index.json" && -f "${DATA}/personas/persona-two/knowledgebases/notes/index.json" ]] || { echo "kb ingest --persona did not index the private KBs" >&2; exit 1; }
# The linked folder's KB is indexed where it really lives, so only the link check keeps it out of recall.
DIR="${DATA}/outside" npx tsx -e 'import { ingestMindStoneKnowledgebase } from "./packages/mindstone-core/src/index.ts"; ingestMindStoneKnowledgebase(process.env.DIR, "notes").then((r) => { if (!r.ok) { console.error(r.error); process.exit(1); } });'
[[ -f "${DATA}/outside/notes/index.json" ]] || { echo "the linked KB was not indexed, so its check would prove nothing" >&2; exit 1; }

# --- CLI: kb search --persona, and its argument checks.
./scripts/mindstone kb search --persona persona-one notes "PONE-7103" --json >"${BODY}"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!r.ok || r.hits.length !== 1 || !r.hits[0].entry.text.includes("PONE-7103")) { console.error("kb search --persona missed its own KB: " + JSON.stringify(r)); process.exit(1); }' "${BODY}"
./scripts/mindstone kb search --persona persona-one notes "PTWO-7104" --json >"${BODY}"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (r.hits.length !== 0) { console.error("kb search --persona persona-one reached persona-two: " + JSON.stringify(r)); process.exit(1); }' "${BODY}"
refused() { # refused <expected message part> <args...>
  local want="$1"; shift
  if ./scripts/mindstone "$@" >"${TEMP_RUNTIME}/refused.out" 2>&1; then echo "accepted: mindstone $*" >&2; exit 1; fi
  grep -q -- "${want}" "${TEMP_RUNTIME}/refused.out" || { echo "mindstone $* failed without '${want}': $(cat "${TEMP_RUNTIME}/refused.out")" >&2; exit 1; }
}
refused "Usage: --persona" kb search --persona ../persona-one notes q
refused "Usage: --persona" kb search notes q --persona
refused 'Persona "no-such-persona" not found' kb search --persona no-such-persona notes q
refused "Not a knowledge base id" kb search --persona persona-one ../../knowledgebases/global-other q
refused "a link there is not used" kb ingest --persona persona-link notes
echo "cli ok"

# --- CLI chat (the TUI and `mindstone chat` path): persona-one's private KB and global list.
: > "${CAPTURE}"
./scripts/mindstone chat --once "Which reference code applies for this collection?" --json >/dev/null
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); process.stdout.write(JSON.parse(l.pop()).messages.map((m)=>m.text??"").join("\n"))' "${CAPTURE}" > "${TEMP_RUNTIME}/cli.prompt"
for text in PONE-7103 GATTACHED-7101 SKILLBODY-alpha-skill; do grep -qF "${text}" "${TEMP_RUNTIME}/cli.prompt" || { echo "cli chat: '${text}' is missing from the prompt" >&2; exit 1; }; done
for text in PTWO-7104 GOTHER-7102 SKILLBODY-beta-skill; do grep -qF "${text}" "${TEMP_RUNTIME}/cli.prompt" && { echo "cli chat: '${text}' is in the prompt and should not be" >&2; exit 1; }; done
echo "cli chat ok"

./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

# Shares words with every KB source but names none of the codes, so a code in the prompt came from recall.
QUESTION="Which reference code applies for this collection?"
set_active() {
  PERSONA="$1" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text()); c["personas"] = {"active": os.environ["PERSONA"]}; p.write_text(json.dumps(c, indent=2) + "\n")
PY
}
last_prompt() {
  node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); process.stdout.write(JSON.parse(l.pop()).messages.map((m)=>m.text??"").join("\n"))' "${CAPTURE}" > "${TEMP_RUNTIME}/$1.prompt"
}
# chat <role> <conversation>: the model's prompt lands in ${TEMP_RUNTIME}/<conversation>.prompt
chat() {
  : > "${CAPTURE}"
  local payload code
  payload="$(TEXT="${QUESTION}" node -e 'process.stdout.write(JSON.stringify({ model: "mindstone/default", messages: [{ role: "user", content: process.env.TEXT }] }))')"
  code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${COMPONENTS_TOKEN}" -H 'content-type: application/json' \
    -H "x-mindstone-user-role: $1" -H "x-mindstone-user-id: smoke-$1" -H "x-mindstone-conversation-id: $2" -d "${payload}" "${BASE}/v1/chat/completions")"
  [[ "${code}" == 200 ]] || { echo "chat $2 failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
  last_prompt "$2"
}
# expect <conversation> <present|absent> <text>...
expect() {
  local conv="$1" mode="$2"; shift 2
  for text in "$@"; do
    if grep -qF -- "${text}" "${TEMP_RUNTIME}/${conv}.prompt"; then
      [[ "${mode}" == present ]] || { echo "${conv}: '${text}' is in the prompt and should not be" >&2; exit 1; }
    else
      [[ "${mode}" == absent ]] || { echo "${conv}: '${text}' is missing from the prompt" >&2; exit 1; }
    fi
  done
}
# The latest assistant entry's metadata, from the gateway transcripts.
last_assistant_metadata() {
  DIR="${DATA}/transcripts" node -e '
const fs = require("fs"), path = require("path");
let best;
for (const f of fs.readdirSync(process.env.DIR)) {
  if (!f.endsWith(".jsonl")) continue;
  for (const line of fs.readFileSync(path.join(process.env.DIR, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.role === "assistant" && (!best || e.timestamp >= best.timestamp)) best = e;
  }
}
process.stdout.write(JSON.stringify(best?.metadata ?? {}));' > "${TEMP_RUNTIME}/assistant-meta.json"
}
meta_check() { # meta_check <label> <js expression over m>
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!('"$2"')) { console.error(process.argv[2] + ": " + JSON.stringify(m)); process.exit(1); }' "${TEMP_RUNTIME}/assistant-meta.json" "$1"
}

# --- 1. persona-one: its listed skill, its global collection, its own private KB.
set_active persona-one
chat admin conv-one
expect conv-one present "SKILLBODY-alpha-skill" "GATTACHED-7101" "PONE-7103" "mindstone kb search --persona persona-one notes"
expect conv-one absent "SKILLBODY-beta-skill" "SKILLBODY-gamma-skill" "GOTHER-7102" "PTWO-7104" "PLINK-7105"
grep -h '"event":"workflow_finished"' "${DATA}"/transcripts/*.jsonl | grep -q '"workflowId":"wf-one","stepId":"always"' || { echo "persona-one: its second workflow did not decide" >&2; exit 1; }
last_assistant_metadata
meta_check "persona-one: recall used its private KB" 'm.memoryRecall && m.memoryRecall.chunkIds.some((id) => id.startsWith("pkb:persona-one:notes:")) && !m.memoryRecall.chunkIds.some((id) => id.startsWith("pkb:persona-two:"))'
meta_check "persona-one: components recorded" 'm.personaComponents && m.personaComponents.personaId === "persona-one" && JSON.stringify(m.personaComponents.skillsInPrompt) === JSON.stringify(["alpha-skill"]) && JSON.stringify(m.personaComponents.skillsMissing) === JSON.stringify(["ghost-skill"])'
grep -q '"workflowId":"wf-nomatch"' "${DATA}"/transcripts/*.jsonl || { echo "persona-one: the first workflow's events were not kept" >&2; exit 1; }
echo "persona-one ok"

# --- 2. persona-two lists nothing: every skill, every global collection, and its own private KB only.
set_active persona-two
chat admin conv-two
expect conv-two present "SKILLBODY-alpha-skill" "SKILLBODY-beta-skill" "SKILLBODY-gamma-skill" "GATTACHED-7101" "GOTHER-7102" "PTWO-7104" "PEXTRA-7106"
expect conv-two absent "PONE-7103" "PLINK-7105"
echo "persona-two ok"

# --- 3. A tenant App Engine run under persona-one gets its private KB and its global list.
: > "${CAPTURE}"
payload="$(TEXT="${QUESTION}" node -e 'process.stdout.write(JSON.stringify({ text: process.env.TEXT, appId: "shop", tenantId: "acme", userId: "cust42", personaId: "persona-one" }))')"
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${COMPONENTS_TOKEN}" -H 'content-type: application/json' -d "${payload}" "${BASE}/agents/default/runs")"
[[ "${code}" == 200 ]] || { echo "the tenant run failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
last_prompt tenant
expect tenant present "PONE-7103" "GATTACHED-7101"
expect tenant absent "PTWO-7104" "GOTHER-7102" "SKILLBODY-"
echo "tenant ok"

# --- 4. A non-owner chat under persona-one gets no recall at all.
set_active persona-one
chat user conv-user
expect conv-user absent "PONE-7103" "GATTACHED-7101" "PTWO-7104"
echo "non-owner ok"

# --- 5. persona-three's workflow routes to persona-two and narrows its components.
set_active persona-three
chat admin conv-route
expect conv-route present "PERSONA-TWO" "PTWO-7104" "GOTHER-7102" "SKILLBODY-beta-skill"
expect conv-route absent "PERSONA-THREE" "PONE-7103" "GATTACHED-7101" "PEXTRA-7106" "SKILLBODY-alpha-skill" "SKILLBODY-gamma-skill"
echo "workflow route ok"

# --- 6. A linked knowledgebases folder is not searched.
set_active persona-link
chat admin conv-link
expect conv-link absent "PLINK-7105"
expect conv-link present "GATTACHED-7101"
echo "linked folder ok"

echo "Persona components smoke test passed."
