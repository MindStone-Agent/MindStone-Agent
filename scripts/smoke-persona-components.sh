#!/usr/bin/env bash
# Persona components at run time (#125): while a persona is active, its
# skills, workflows and knowledge bases are the ones in play.
#   - skills: only the persona's listed skills are in the owner prompt; a
#     listed skill that isn't installed is skipped and recorded; the Console's
#     Skills page marks the others as not in the prompt
#   - global KBs: only the collections it lists; with none listed, all of them
#   - private KBs: the persona's own, never another persona's (same KB id in
#     both), on owner turns and tenant App Engine runs (gateway and
#     in-process); non-owner chats get none, and their responses don't name
#     the persona's components
#   - workflows: every listed workflow is a candidate, in order; a "stop" gate
#     ends the selection; a step that routes to another persona brings that
#     persona's components; a step's skills narrow the skill set, and its
#     knowledgebases narrow global and private KBs each on its own
#   - a persona named by an App Engine request uses its own workflows, and a
#     step that routed elsewhere doesn't narrow it
#   - with no persona active, nothing changes: a step's lists are only logged
#   - links: a linked persona folder, knowledgebases folder, index.json or
#     source file is not used
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
export COMPONENTS_ADMIN_TOKEN="persona-components-smoke-admin-token"
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
c["gateway"]["admin"] = {"tokenEnv": "COMPONENTS_ADMIN_TOKEN"}
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
# Lists of its own, which its workflow's step narrows: skills to beta, and
# KBs to global-other. The step names no private KB, so its own stays.
four = persona("persona-four", ["alpha-skill", "beta-skill"], ["global-attached", "global-other"], ["wf-narrow"])
kb(four / "knowledgebases", "p4", "PFOUR-7107")
# Its step names only one of its private KBs: global recall stays as it was.
five = persona("persona-five", workflows=["wf-private-only"])
kb(five / "knowledgebases", "mine", "PFIVE-7108")
kb(five / "knowledgebases", "other", "POTHER-7109")
# A stop gate first: wf-one after it is never tried.
persona("persona-six", workflows=["wf-stop", "wf-one"])
# Its step names skills and KBs outside its own lists: nothing is widened.
seven = persona("persona-seven", ["alpha-skill"], ["global-attached"], ["wf-wide"])
kb(seven / "knowledgebases", "notes", "PSEVEN-7110")
# A gate that never passes, asking for 9 attempts: capped at 5.
persona("persona-eight", workflows=["wf-cap"])
# A skills.json that doesn't parse: the persona fails to load, rather than reading as "every skill".
bad = persona("persona-bad")
write(bad / "skills.json", "{not json")
kb(bad / "knowledgebases", "notes", "PBAD-7111")
link = persona("persona-link")
kb(data / "outside", "notes", "PLINK-7105")
os.symlink(data / "outside", link / "knowledgebases")
# A persona folder that is a link to persona-two's.
os.symlink(two, data / "personas" / "persona-alias")
# persona-one's "stolen" KB: its index.json is a link to persona-two's.
write(one / "knowledgebases" / "stolen" / "kb.json", json.dumps({"name": "stolen"}))
os.symlink(two / "knowledgebases" / "notes" / "index.json", one / "knowledgebases" / "stolen" / "index.json")
# persona-two's "linky" KB: a source file that is a link.
write(two / "knowledgebases" / "linky" / "kb.json", json.dumps({"name": "linky"}))
(two / "knowledgebases" / "linky" / "sources").mkdir(parents=True)
os.symlink(data / "outside" / "notes" / "sources" / "notes.md", two / "knowledgebases" / "linky" / "sources" / "notes.md")

def workflow(wid, steps):
    write(data / "workflows" / wid / "workflow.json", json.dumps({"name": wid, "steps": steps}))
workflow("wf-nomatch", [{"id": "never", "kind": "route", "when": {"messagePrefix": "zzz-never"}}])
workflow("wf-one", [{"id": "always", "kind": "route"}])
# Routes to persona-two, and narrows: one skill, and KBs by id (its private
# "notes" plus the global "global-other").
workflow("wf-route", [{"id": "hand-off", "kind": "route", "personaId": "persona-two", "skills": ["beta-skill"], "knowledgebases": ["notes", "global-other"]}])
workflow("wf-narrow", [{"id": "narrow", "kind": "route", "skills": ["beta-skill"], "knowledgebases": ["global-other"]}])
workflow("wf-private-only", [{"id": "mine-only", "kind": "route", "knowledgebases": ["mine", "no-such-kb"]}])
workflow("wf-wide", [{"id": "wide", "kind": "route", "skills": ["beta-skill"], "knowledgebases": ["global-other", "notes"]}])
workflow("wf-cap", [{"id": "never", "kind": "gate", "gate": {"condition": {"messagePrefix": "zzz-never"}}, "retry": {"maxAttempts": 9}, "onFail": "continue"}, {"id": "then", "kind": "route"}])
workflow("wf-stop", [{"id": "blocker", "kind": "gate", "gate": {"condition": {"messagePrefix": "zzz-never"}}, "onFail": "stop"}, {"id": "after", "kind": "route"}])
PY

for kb_id in global-attached global-other; do ./scripts/mindstone kb ingest "${kb_id}" --json >/dev/null; done
./scripts/mindstone kb ingest --persona persona-one notes --json >/dev/null
./scripts/mindstone kb ingest notes --persona persona-two --json >/dev/null
./scripts/mindstone kb ingest --persona persona-two extra --json >/dev/null
./scripts/mindstone kb ingest --persona persona-four p4 --json >/dev/null
./scripts/mindstone kb ingest --persona persona-five mine --json >/dev/null
./scripts/mindstone kb ingest --persona persona-five other --json >/dev/null
./scripts/mindstone kb ingest --persona persona-seven notes --json >/dev/null
DIR="${DATA}/personas/persona-bad/knowledgebases" npx tsx -e 'import { ingestMindStoneKnowledgebase } from "./packages/mindstone-core/src/index.ts"; ingestMindStoneKnowledgebase(process.env.DIR, "notes").then((r) => { if (!r.ok) { console.error(r.error); process.exit(1); } });'
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
refused "stolen/index.json is a link" kb search --persona persona-one stolen q
refused "a link there is not used" kb search --persona persona-alias notes q
refused "is a link; a persona's knowledge base must be its own files" kb ingest --persona persona-two linky
echo "cli ok"

# Shares words with every KB source but names none of the codes, so a code in the prompt came from recall.
QUESTION="Which reference code applies for this collection?"
last_prompt() {
  node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); process.stdout.write(JSON.parse(l.pop()).messages.map((m)=>m.text??"").join("\n"))' "${CAPTURE}" > "${TEMP_RUNTIME}/$1.prompt"
}
# expect <label> <present|absent> <text>...: checks ${TEMP_RUNTIME}/<label>.prompt
expect() {
  local label="$1" mode="$2"; shift 2
  for text in "$@"; do
    if grep -qF -- "${text}" "${TEMP_RUNTIME}/${label}.prompt"; then
      [[ "${mode}" == present ]] || { echo "${label}: '${text}' is in the prompt and should not be" >&2; exit 1; }
    else
      [[ "${mode}" == absent ]] || { echo "${label}: '${text}' is missing from the prompt" >&2; exit 1; }
    fi
  done
}

# --- CLI chat (the TUI and `mindstone chat` path): persona-one's private KB and global list.
: > "${CAPTURE}"
./scripts/mindstone chat --once "${QUESTION}" --json >/dev/null
last_prompt cli
expect cli present PONE-7103 GATTACHED-7101 SKILLBODY-alpha-skill
expect cli absent PTWO-7104 GOTHER-7102 SKILLBODY-beta-skill
# The CLI path records a step's unknown KB id too (persona-five's step names "no-such-kb").
PERSONA=persona-five python3 -c 'import json,os,pathlib; p=pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"])/"mindstone"/"config.json"; c=json.loads(p.read_text()); c["personas"]={"active":os.environ["PERSONA"]}; p.write_text(json.dumps(c,indent=2)+"\n")'
./scripts/mindstone chat --once "${QUESTION}" --json >"${BODY}"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const pc=b.assistantEntry?.metadata?.personaComponents; if (JSON.stringify(pc?.stepKnowledgebasesUnknown) !== JSON.stringify(["no-such-kb"])) { console.error("cli chat: the unknown step KB id was not recorded: " + JSON.stringify(pc)); process.exit(1); }' "${BODY}"
echo "cli chat ok"

# --- In-process App Engine (runMindStone): a tenant run under persona-one gets its private KB.
npx tsx <<'TS'
import assert from "node:assert/strict";
import { loadMindStoneConfig, resolveConfigPath, runMindStone, runtimePathsFromEnv } from "./packages/mindstone-core/src/index.ts";
import { MockMindStoneProvider } from "./packages/mindstone-gateway/src/index.ts";
const paths = runtimePathsFromEnv();
const config = loadMindStoneConfig(resolveConfigPath(process.env, paths)).config!;
const provider = new MockMindStoneProvider({ responsePrefix: "in-process" });
const model = provider.listModels()[0];
const run = await runMindStone({ agentId: "default", appId: "shop", tenantId: "acme", userId: "cust7", input: "Which reference code applies for this collection?", personaId: "persona-one" }, { config, provider, model });
const ids = run.memoryRecall?.hits.map((hit) => hit.id) ?? [];
assert.ok(ids.some((id) => id.startsWith("pkb:persona-one:notes:")), `in-process tenant run missed persona-one's private KB: ${ids}`);
assert.ok(!ids.some((id) => id.startsWith("pkb:persona-two:")), `in-process tenant run reached persona-two: ${ids}`);
assert.ok(!ids.some((id) => id.startsWith("kb:global-other:")), `in-process tenant run searched an unlisted global KB: ${ids}`);
TS
echo "in-process tenant ok"

./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

set_config() { # set_config <persona-or-empty> [workflows-active]
  PERSONA="$1" WORKFLOW="${2:-}" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c["personas"] = {"active": os.environ["PERSONA"]} if os.environ["PERSONA"] else {}
c["workflows"] = {"active": os.environ["WORKFLOW"]} if os.environ["WORKFLOW"] else {}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
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
# Entries of one conversation (its session key ends with :<conversation>), from the transcripts.
conversation_entries() {
  CONV="$1" DIR="${DATA}/transcripts" node -e '
const fs = require("fs"), path = require("path");
const out = [];
for (const f of fs.readdirSync(process.env.DIR)) {
  if (!f.endsWith(".jsonl")) continue;
  for (const line of fs.readFileSync(path.join(process.env.DIR, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (typeof e.sessionKey === "string" && e.sessionKey.endsWith(":" + process.env.CONV)) out.push(e);
  }
}
process.stdout.write(JSON.stringify(out));' > "${TEMP_RUNTIME}/entries.json"
}
entries_check() { # entries_check <label> <js expression over es (entries) and a (last assistant metadata)>
  node -e 'const es=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const a=[...es].reverse().find((e)=>e.role==="assistant")?.metadata ?? {}; if (es.length === 0 || !('"$2"')) { console.error(process.argv[2] + ": " + JSON.stringify(es.filter((e)=>e.role!=="user").map((e)=>e.metadata))); process.exit(1); }' "${TEMP_RUNTIME}/entries.json" "$1"
}

# --- 1. persona-one: its listed skill, its global collection, its own private KB.
set_config persona-one
chat admin conv-one
expect conv-one present "SKILLBODY-alpha-skill" "GATTACHED-7101" "PONE-7103" "mindstone kb search --persona persona-one notes"
expect conv-one absent "SKILLBODY-beta-skill" "SKILLBODY-gamma-skill" "GOTHER-7102" "PTWO-7104" "PLINK-7105"
conversation_entries conv-one
entries_check "persona-one: its second workflow did not decide after the first was tried" 'es.some((e)=>e.metadata?.event==="workflow_finished" && e.metadata.workflowId==="wf-one" && e.metadata.stepId==="always") && es.some((e)=>e.metadata?.event==="workflow_started" && e.metadata.workflowId==="wf-nomatch")'
entries_check "persona-one: recall did not use its private KB only" 'a.memoryRecall && a.memoryRecall.chunkIds.some((id) => id.startsWith("pkb:persona-one:notes:")) && !a.memoryRecall.chunkIds.some((id) => id.startsWith("pkb:persona-two:") || id.startsWith("pkb:persona-one:stolen:"))'
entries_check "persona-one: components not recorded" 'a.personaComponents && a.personaComponents.personaId === "persona-one" && JSON.stringify(a.personaComponents.skillsInPrompt) === JSON.stringify(["alpha-skill"]) && JSON.stringify(a.personaComponents.skillsMissing) === JSON.stringify(["ghost-skill"])'
# The Console's Skills page says which skills the active persona leaves out of the prompt.
code="$(curl -s -o "${BODY}" -w '%{http_code}' -H "Authorization: Bearer ${COMPONENTS_TOKEN}" -H "x-mindstone-admin-token: ${COMPONENTS_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' "${BASE}/admin/skills")"
[[ "${code}" == 200 ]] || { echo "GET /admin/skills failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const s=Object.fromEntries(b.skills.map((k)=>[k.id,k.inPrompt])); if (s["alpha-skill"] !== true || s["beta-skill"] !== false) { console.error("/admin/skills inPrompt ignores the active persona: " + JSON.stringify(s)); process.exit(1); }' "${BODY}"
echo "persona-one ok"

# --- 2. persona-two lists nothing: every skill, every global collection, and its own private KBs only.
set_config persona-two
chat admin conv-two
expect conv-two present "SKILLBODY-alpha-skill" "SKILLBODY-beta-skill" "SKILLBODY-gamma-skill" "GATTACHED-7101" "GOTHER-7102" "PTWO-7104" "PEXTRA-7106"
expect conv-two absent "PONE-7103" "PLINK-7105"
echo "persona-two ok"

# --- 3. A tenant App Engine run names persona-one while persona-three is active:
# persona-one's own lists and workflows, not narrowed by persona-three's step.
set_config persona-three
: > "${CAPTURE}"
payload="$(TEXT="${QUESTION}" node -e 'process.stdout.write(JSON.stringify({ text: process.env.TEXT, appId: "shop", tenantId: "acme", userId: "cust42", personaId: "persona-one" }))')"
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${COMPONENTS_TOKEN}" -H 'content-type: application/json' -d "${payload}" "${BASE}/agents/default/runs")"
[[ "${code}" == 200 ]] || { echo "the tenant run failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
last_prompt tenant
expect tenant present "PERSONA-ONE" "PONE-7103" "GATTACHED-7101"
expect tenant absent "PTWO-7104" "GOTHER-7102" "SKILLBODY-"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const w=b.workflow; if (!w || w.workflowId !== "wf-one" || !w.decision || JSON.stringify(w.tried) !== JSON.stringify(["wf-nomatch","wf-one"])) { console.error("tenant: persona-one did not use its own workflows: " + JSON.stringify(w)); process.exit(1); } if (b.personaComponents?.personaId !== "persona-one" || b.personaComponents.globalKnowledgebases?.[0] !== "global-attached") { console.error("tenant: components not persona-one s: " + JSON.stringify(b.personaComponents)); process.exit(1); }' "${BODY}"
# The request names persona-one and wf-route, whose step routes to persona-two
# and narrows: persona-one answers, and that step doesn't narrow it.
: > "${CAPTURE}"
payload="$(TEXT="${QUESTION}" node -e 'process.stdout.write(JSON.stringify({ text: process.env.TEXT, appId: "shop", tenantId: "acme", userId: "cust43", personaId: "persona-one", workflowId: "wf-route" }))')"
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${COMPONENTS_TOKEN}" -H 'content-type: application/json' -d "${payload}" "${BASE}/agents/default/runs")"
[[ "${code}" == 200 ]] || { echo "the tenant run with a workflow failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
last_prompt tenant-wf
expect tenant-wf present "PERSONA-ONE" "PONE-7103" "GATTACHED-7101"
expect tenant-wf absent "PERSONA-TWO" "PTWO-7104" "GOTHER-7102"
echo "tenant ok"

# --- 4. A non-owner chat under persona-one gets no recall, and its response doesn't name the persona's components.
set_config persona-one
chat user conv-user
expect conv-user absent "PONE-7103" "GATTACHED-7101" "PTWO-7104"
if grep -q 'personaComponents\|personaContext\|persona-one' "${BODY}"; then echo "a non-owner response named the persona or its components: $(cat "${BODY}")" >&2; exit 1; fi
echo "non-owner ok"

# --- 5. persona-three's workflow routes to persona-two and narrows its components.
set_config persona-three
chat admin conv-route
expect conv-route present "PERSONA-TWO" "PTWO-7104" "GOTHER-7102" "SKILLBODY-beta-skill"
expect conv-route absent "PERSONA-THREE" "PONE-7103" "GATTACHED-7101" "PEXTRA-7106" "SKILLBODY-alpha-skill" "SKILLBODY-gamma-skill"
echo "workflow route ok"

# --- 6. A step narrows a persona's own lists; naming no private KB leaves its private KBs alone.
set_config persona-four
chat admin conv-four
expect conv-four present "SKILLBODY-beta-skill" "GOTHER-7102" "PFOUR-7107"
expect conv-four absent "SKILLBODY-alpha-skill" "GATTACHED-7101"
# Naming only a private KB narrows the private KBs and leaves global recall alone.
set_config persona-five
chat admin conv-five
expect conv-five present "PFIVE-7108" "GATTACHED-7101" "GOTHER-7102"
expect conv-five absent "POTHER-7109"
conversation_entries conv-five
entries_check "persona-five: the step's unknown KB id was not recorded" 'JSON.stringify(a.personaComponents?.stepKnowledgebasesUnknown) === JSON.stringify(["no-such-kb"])'
# A step naming skills and KBs outside the persona's lists widens nothing:
# alpha-skill and beta-skill have no overlap, nor global-attached and global-other.
set_config persona-seven
chat admin conv-seven
expect conv-seven present "PSEVEN-7110"
expect conv-seven absent "SKILLBODY-beta-skill" "SKILLBODY-gamma-skill" "SKILLBODY-alpha-skill" "GOTHER-7102" "GATTACHED-7101"
echo "step narrowing ok"

# --- 7. A stop gate ends the selection: wf-one, listed after it, is never tried.
set_config persona-six
chat admin conv-six
conversation_entries conv-six
entries_check "persona-six: the stop gate did not run" 'es.some((e)=>e.metadata?.event==="workflow_failed" && e.metadata.workflowId==="wf-stop")'
entries_check "persona-six: wf-one was tried after a stop gate" '!es.some((e)=>e.metadata?.event==="workflow_started" && e.metadata.workflowId==="wf-one")'
echo "stop gate ok"

# --- 7b. A gate is tried at most 5 times, whatever retry.maxAttempts asks.
set_config persona-eight
chat admin conv-eight
conversation_entries conv-eight
entries_check "persona-eight: the gate was not capped at 5 attempts" 'es.some((e)=>e.metadata?.event==="workflow_gate" && e.metadata.workflowId==="wf-cap" && e.metadata.attempts===5)'
echo "gate cap ok"

# --- 7c. A list file that doesn't parse: the persona fails to load, and the
# turn gets no skills and no KBs, private or global, rather than all of them (#142 review).
set_config persona-bad
chat admin conv-bad
expect conv-bad absent "PERSONA-BAD" "PBAD-7111" "SKILLBODY-alpha-skill" "GATTACHED-7101"
conversation_entries conv-bad
entries_check "persona-bad: its turn wasn't marked as failed closed" 'a.personaComponents?.loadFailed === true && a.personaComponents.skills.length === 0 && a.personaComponents.globalKnowledgebases.length === 0'
echo "malformed list ok"

# --- 8. No persona active: a step's lists are only logged, as before.
set_config "" wf-narrow
chat admin conv-none
expect conv-none present "SKILLBODY-alpha-skill" "SKILLBODY-beta-skill" "SKILLBODY-gamma-skill" "GATTACHED-7101" "GOTHER-7102"
echo "no persona ok"

# --- 9. Links: a linked knowledgebases folder, and a persona folder that is a link, are not searched.
set_config persona-link
chat admin conv-link
expect conv-link absent "PLINK-7105"
expect conv-link present "GATTACHED-7101"
conversation_entries conv-link
entries_check "persona-link: a linked KB was recalled" 'a.memoryRecall && !a.memoryRecall.chunkIds.some((id) => id.startsWith("pkb:"))'
set_config persona-alias
chat admin conv-alias
expect conv-alias present "PERSONA-TWO" "GATTACHED-7101"
expect conv-alias absent "PTWO-7104" "PEXTRA-7106"
# An id in another case than the folder on disk (a case-insensitive filesystem
# finds it): its private KBs aren't used, so recall ids stay canonical.
if [[ -d "${DATA}/personas/PERSONA-TWO" ]]; then
  set_config PERSONA-TWO
  chat admin conv-case
  expect conv-case absent "PTWO-7104"
  conversation_entries conv-case
  entries_check "PERSONA-TWO: private KBs were used under a non-canonical id" '!a.memoryRecall || !a.memoryRecall.chunkIds.some((id) => id.startsWith("pkb:"))'
  echo "case-variant id ok"
fi
echo "links ok"

echo "Persona components smoke test passed."
