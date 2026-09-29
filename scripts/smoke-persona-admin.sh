#!/usr/bin/env bash
# Owner-built personas, workflows and private knowledge bases through the
# admin API (#125, part 2).
#   - POST/PATCH/GET /admin/personas: create never activates; an id on disk
#     or used by the config is refused; every component must exist; a list
#     given replaces the old one, an empty list removes it
#   - POST/PATCH/GET /admin/workflows: strict checks (unknown keys, empty
#     conditions or gates, the attempt cap, a step's persona by exact id)
#   - GET /admin/knowledgebases: the global collections
#   - private KBs: create, add a text source, a URL source (advanced
#     permission; credentials masked on read), ingest (a size cap on fetches);
#     links refused; the new KB is recalled while its persona is active
#   - no staging folder is left behind, and each write is audited
# Binds gateway port base+36 and a stub source server on base+37; serialize
# per smoke protocol. Synthetic strings only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-persona-admin-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 36))"
STUB_PORT="$((SMOKE_PORT_BASE + 37))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${stub_pid:-}" ]]; then kill "${stub_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export PADMIN_TOKEN="persona-admin-smoke-service-token"
export PADMIN_ADMIN_TOKEN="persona-admin-smoke-admin-token"
export CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
export STUB_PORT
cd "${PROJECT_ROOT}"
echo "== Persona admin smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
BASE="http://127.0.0.1:${GATEWAY_PORT}"
BODY="${TEMP_RUNTIME}/body.json"

# A source server: one small markdown page, one page over the 5 MB cap, and
# one that answers after 6 s (to overlap ingests, with room on a busy host).
node - <<'NODE' &
require("http").createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/slow.md") { setTimeout(() => { res.writeHead(200, { "content-type": "text/markdown" }); res.end("# Slow\n\nSlow page.\n"); }, 6000); return; }
  if (path === "/doc.md") { res.writeHead(200, { "content-type": "text/markdown" }); res.end("# URL facts\n\nThe fetched reference code is URLFACT-8802 for this collection.\n"); return; }
  if (path === "/huge.md") { res.writeHead(200, { "content-type": "text/markdown" }); const chunk = "x".repeat(1024 * 1024); for (let i = 0; i < 6; i += 1) res.write(chunk); res.end(); return; }
  res.writeHead(404); res.end();
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");
NODE
stub_pid=$!

python3 - <<'PY'
import json, os, pathlib
data = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone"
p = data / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "PADMIN_TOKEN"}
c["gateway"]["admin"] = {"tokenEnv": "PADMIN_ADMIN_TOKEN"}
c["gateway"]["http"] = {"chatCompletions": {"enabled": True}}
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "padmin", "captureFile": os.environ["CAPTURE"]}}
c["memory"] = {"autoRecall": True}
# "reserved" is used by a route rule: creating it would make it answer with no switch.
c["personas"] = {"active": "existing", "routes": [{"personaId": "reserved", "sourceChannel": "nowhere"}]}
# "wf-live" is the config's active workflow, though none exists yet: creating it would take effect at once.
c["workflows"] = {"active": "wf-live"}
p.write_text(json.dumps(c, indent=2) + "\n")
def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)
write(data / "skills" / "alpha-skill" / "skill.json", json.dumps({"id": "alpha-skill", "label": "Alpha", "description": "Alpha sentinel."}))
write(data / "skills" / "alpha-skill" / "SKILL.md", "# alpha\n\nSkill body SKILLBODY-alpha.\n")
write(data / "knowledgebases" / "g1" / "kb.json", json.dumps({"name": "g1"}))
write(data / "knowledgebases" / "g1" / "sources" / "notes.md", "# Notes\n\nThe global reference code is GFACT-8800 for this collection.\n")
write(data / "personas" / "existing" / "PERSONA.md", "# Existing\n\nPersona sentinel EXISTING.\n")
# It lists a workflow that doesn't exist yet (a hand edit): creating it would run on its turns.
write(data / "personas" / "existing" / "workflows.json", json.dumps(["wf-future"]))
(data / "outside").mkdir()
# A leftover staging folder, as a crash mid-create would leave: never listed.
write(data / "personas" / ".staging-leftover" / "PERSONA.md", "# Leftover\n\nSTAGING-LEFTOVER\n")
os.symlink(data / "personas" / "existing", data / "personas" / "linked")
PY
./scripts/mindstone kb ingest g1 --json >/dev/null

./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

ADMIN=(-H "Authorization: Bearer ${PADMIN_TOKEN}" -H "x-mindstone-admin-token: ${PADMIN_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
call() { # call <method> <path> [json]: prints the status; the body lands in ${BODY}
  if [[ $# -ge 3 ]]; then curl -s -o "${BODY}" -w '%{http_code}' -X "$1" "${ADMIN[@]}" -d "$3" "${BASE}$2"; else curl -s -o "${BODY}" -w '%{http_code}' -X "$1" "${ADMIN[@]}" "${BASE}$2"; fi
}
expect() { # expect <status> <what> <method> <path> [json] [body part]
  local want="$1" what="$2"; shift 2
  local got; got="$(call "$1" "$2" ${3:+"$3"})"
  [[ "${got}" == "${want}" ]] || { echo "${what}: expected ${want}, got ${got}: $(cat "${BODY}")" >&2; exit 1; }
  if [[ -n "${4:-}" ]]; then grep -qF -- "$4" "${BODY}" || { echo "${what}: the body lacks '$4': $(cat "${BODY}")" >&2; exit 1; }; fi
}
body_check() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!('"$2"')) { console.error(process.argv[2] + ": " + JSON.stringify(b)); process.exit(1); }' "${BODY}" "$1"; }
MD='# Built\n\nPersona sentinel BUILT-8810.\n'

# --- 1. Create a persona: saved, not active.
expect 201 "create a persona" POST /admin/personas "{\"id\":\"built\",\"name\":\"Built\",\"description\":\"Made in the Console\",\"personaMarkdown\":\"${MD}\",\"skills\":[\"alpha-skill\"],\"knowledgebases\":[\"g1\"]}"
body_check "create response" 'b.persona.id === "built" && b.persona.active === false'
[[ "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).personas.active)' "${DATA}/config.json")" == "existing" ]] || { echo "creating a persona changed the active persona" >&2; exit 1; }
grep -q 'BUILT-8810' "${DATA}/personas/built/PERSONA.md" || { echo "PERSONA.md was not written" >&2; exit 1; }
[[ "$(cat "${DATA}/personas/built/skills.json" | tr -d ' \n')" == '["alpha-skill"]' ]] || { echo "skills.json is wrong" >&2; exit 1; }
[[ ! -e "${DATA}/personas/built/workflows.json" ]] || { echo "a list not given was written" >&2; exit 1; }
expect 200 "read the persona" GET /admin/personas/built
body_check "read" 'b.persona.name === "Built" && b.persona.personaMarkdown.includes("BUILT-8810") && JSON.stringify(b.persona.skills) === JSON.stringify(["alpha-skill"]) && JSON.stringify(b.persona.knowledgebases) === JSON.stringify(["g1"]) && b.persona.active === false && Array.isArray(b.persona.privateKnowledgebases)'

# --- 2. Create refusals.
expect 409 "an id already on disk" POST /admin/personas "{\"id\":\"built\",\"name\":\"B\",\"personaMarkdown\":\"x\"}" persona_exists
expect 409 "an id the config uses" POST /admin/personas "{\"id\":\"reserved\",\"name\":\"R\",\"personaMarkdown\":\"x\"}" persona_referenced
expect 400 "an uppercase id" POST /admin/personas "{\"id\":\"Built\",\"name\":\"B\",\"personaMarkdown\":\"x\"}"
expect 400 "a path as an id" POST /admin/personas "{\"id\":\"../x\",\"name\":\"B\",\"personaMarkdown\":\"x\"}"
expect 422 "a skill not installed" POST /admin/personas "{\"id\":\"p2\",\"name\":\"B\",\"personaMarkdown\":\"x\",\"skills\":[\"ghost\"]}" unknown_component
expect 422 "a KB that doesn't exist" POST /admin/personas "{\"id\":\"p2\",\"name\":\"B\",\"personaMarkdown\":\"x\",\"knowledgebases\":[\"ghost\"]}" unknown_component
expect 422 "a workflow that doesn't exist" POST /admin/personas "{\"id\":\"p2\",\"name\":\"B\",\"personaMarkdown\":\"x\",\"workflows\":[\"ghost\"]}" unknown_component
expect 400 "an unknown field" POST /admin/personas "{\"id\":\"p2\",\"name\":\"B\",\"personaMarkdown\":\"x\",\"active\":true}"
expect 400 "no PERSONA.md text" POST /admin/personas "{\"id\":\"p2\",\"name\":\"B\"}"
expect 400 "a name over two lines" POST /admin/personas "{\"id\":\"p2\",\"name\":\"B\\nC\",\"personaMarkdown\":\"x\"}"
expect 404 "an id in another case" GET /admin/personas/BUILT
expect 200 "the list" GET /admin/personas
grep -q 'staging' "${BODY}" && { echo "a staging folder was listed as a persona: $(cat "${BODY}")" >&2; exit 1; }
[[ ! -e "${DATA}/personas/p2" ]] || { echo "a refused create left a persona behind" >&2; exit 1; }
echo "persona create ok"

# --- 3. Workflows: strict checks.
expect 201 "create a workflow" POST /admin/workflows '{"id":"wf-a","name":"A","steps":[{"id":"to-built","kind":"route","personaId":"built"}]}'
expect 409 "a workflow id already on disk" POST /admin/workflows '{"id":"wf-a","steps":[{"id":"s","kind":"route"}]}' workflow_exists
expect 400 "a top-level unknown key" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route"}],"active":true}'
expect 400 "a step's unknown key" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route","gate":{}}]}'
expect 400 "an empty when" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route","when":{}}]}'
expect 400 "an empty condition field" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route","when":{"messagePrefix":""}}]}'
expect 400 "an empty gate" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"gate","gate":{}}]}'
expect 400 "a gate with both kinds" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"gate","gate":{"personaLoadable":"built","condition":{"messagePrefix":"x"}}}]}'
expect 400 "too many attempts" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"gate","gate":{"condition":{"messagePrefix":"x"}},"retry":{"maxAttempts":6}}]}'
expect 400 "an unknown persona" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route","personaId":"ghost"}]}' 'no persona named \"ghost\"'
expect 400 "a persona in another case" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route","personaId":"BUILT"}]}' 'no persona named \"BUILT\"'
expect 400 "a linked persona" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route","personaId":"linked"}]}' 'no persona named \"linked\"'
expect 400 "a duplicate step id" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route"},{"id":"s","kind":"route"}]}'
expect 400 "a step skill not installed" POST /admin/workflows '{"id":"wf-b","steps":[{"id":"s","kind":"route","skills":["ghost"]}]}' 'no installed skill named'
expect 409 "an id the config runs" POST /admin/workflows '{"id":"wf-live","steps":[{"id":"s","kind":"route","personaId":"built"}]}' workflow_referenced
[[ ! -e "${DATA}/workflows/wf-live" ]] || { echo "a workflow the config runs was created" >&2; exit 1; }
expect 409 "an id a persona lists" POST /admin/workflows '{"id":"wf-future","steps":[{"id":"s","kind":"route","personaId":"built"}]}' workflow_referenced
[[ ! -e "${DATA}/workflows/wf-b" ]] || { echo "a refused workflow was written" >&2; exit 1; }
expect 200 "replace a workflow" PATCH /admin/workflows/wf-a '{"name":"A2","steps":[{"id":"gate-1","kind":"gate","gate":{"condition":{"messagePrefix":"go"}},"retry":{"maxAttempts":5},"onFail":"continue"},{"id":"to-built","kind":"route","personaId":"built","skills":["alpha-skill"]}]}'
expect 200 "read the workflow" GET /admin/workflows/wf-a
body_check "workflow read" 'b.workflow.name === "A2" && b.workflow.steps.length === 2 && b.workflow.steps[0].retry.maxAttempts === 5 && !("dir" in b.workflow) && !("id" in b.workflow) && !("skills" in b.workflow.steps[0])'
# What GET returns, PATCH takes back.
ROUND="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workflow))' "${BODY}")"
expect 200 "send a read workflow back" PATCH /admin/workflows/wf-a "${ROUND}"
expect 404 "replace a workflow that doesn't exist" PATCH /admin/workflows/wf-none '{"steps":[{"id":"s","kind":"route"}]}'
expect 200 "list workflows" GET /admin/workflows
body_check "workflow list" 'b.workflows.some((w) => w.id === "wf-a" && w.stepCount === 2)'
echo "workflows ok"

# --- 4. Edit the persona: lists replace; an empty list removes the file.
expect 200 "edit the persona" PATCH /admin/personas/built '{"workflows":["wf-a"],"skills":[]}'
[[ ! -e "${DATA}/personas/built/skills.json" ]] || { echo "an empty skills list did not remove skills.json" >&2; exit 1; }
[[ "$(cat "${DATA}/personas/built/workflows.json" | tr -d ' \n')" == '["wf-a"]' ]] || { echo "workflows.json is wrong" >&2; exit 1; }
expect 400 "an edit with nothing in it" PATCH /admin/personas/built '{}'
expect 400 "an edit that renames the id" PATCH /admin/personas/built '{"id":"other"}'
expect 422 "an edit to a skill not installed" PATCH /admin/personas/built '{"skills":["ghost"]}' unknown_component
expect 404 "an edit to a persona that doesn't exist" PATCH /admin/personas/nobody '{"name":"N"}'
expect 404 "an edit to a linked persona" PATCH /admin/personas/linked '{"name":"N"}'
expect 422 "a workflow in another case" PATCH /admin/personas/built '{"workflows":["WF-A"]}' unknown_component
expect 200 "rename the persona" PATCH /admin/personas/built '{"name":"Built Two"}'
expect 200 "read it back" GET /admin/personas/built
body_check "edit read" 'b.persona.name === "Built Two" && b.persona.description === "Made in the Console" && b.persona.skills.length === 0 && JSON.stringify(b.persona.workflows) === JSON.stringify(["wf-a"])'
grep -q '"createdBy": "owner"' "${DATA}/personas/built/metadata.json" || { echo "an edit dropped the metadata's provenance" >&2; exit 1; }
echo "persona edit ok"

# --- 5. Private knowledge bases.
expect 201 "create a private KB" POST /admin/personas/built/knowledgebases '{"id":"notes","name":"Notes"}'
expect 409 "the same KB id again" POST /admin/personas/built/knowledgebases '{"id":"notes"}' knowledgebase_exists
expect 400 "a path as a KB id" POST /admin/personas/built/knowledgebases '{"id":"../g1"}'
expect 404 "a KB on a linked persona" POST /admin/personas/linked/knowledgebases '{"id":"x"}'
expect 201 "add a text source" POST /admin/personas/built/knowledgebases/notes/sources '{"kind":"text","name":"facts","text":"# Facts\n\nThe private reference code is PADMIN-8801 for this collection.\n"}'
expect 409 "the same source name again" POST /admin/personas/built/knowledgebases/notes/sources '{"kind":"text","name":"facts","text":"x"}' source_exists
expect 403 "a URL source without the advanced permission" POST /admin/personas/built/knowledgebases/notes/sources "{\"kind\":\"url\",\"name\":\"web\",\"url\":\"http://127.0.0.1:${STUB_PORT}/doc.md\"}"
expect 200 "grant advanced settings" POST /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}'
expect 201 "add a URL source" POST /admin/personas/built/knowledgebases/notes/sources "{\"kind\":\"url\",\"name\":\"web\",\"url\":\"http://127.0.0.1:${STUB_PORT}/doc.md\"}"
expect 400 "a file URL" POST /admin/personas/built/knowledgebases/notes/sources '{"kind":"url","name":"local","url":"file:///etc/hosts"}'
# A user name or password in a URL is refused; a token in its query reads back masked.
expect 201 "a second KB for the masking check" POST /admin/personas/built/knowledgebases '{"id":"masked"}'
expect 400 "a URL with credentials" POST /admin/personas/built/knowledgebases/masked/sources '{"kind":"url","name":"secret","url":"https://smoke-user:smoke-pass-8899@example.invalid/doc"}'
expect 201 "a URL with a token" POST /admin/personas/built/knowledgebases/masked/sources "{\"kind\":\"url\",\"name\":\"tokened\",\"url\":\"HTTP://127.0.0.1:${STUB_PORT}/missing?token=smoke-tok-7777\"}"
expect 200 "read the sources" GET /admin/personas/built/knowledgebases/masked/sources
grep -q 'smoke-tok-7777' "${BODY}" && { echo "a source URL's token was returned: $(cat "${BODY}")" >&2; exit 1; }
body_check "the URL is listed, masked" 'b.sources.urls.length === 1 && b.sources.urls[0].id === "tokened" && b.sources.urls[0].url.startsWith("http://127.0.0.1") && b.sources.urls[0].url.includes("***")'
# Its fetch fails (404); the error names the address without the token.
expect 422 "ingest a failing URL" POST /admin/personas/built/knowledgebases/masked/ingest '{}' "HTTP 404"
grep -q 'smoke-tok-7777' "${BODY}" && { echo "an ingest error returned the token: $(cat "${BODY}")" >&2; exit 1; }
# At most 10 URL sources.
expect 201 "a KB for the URL cap" POST /admin/personas/built/knowledgebases '{"id":"many"}'
for i in 1 2 3 4 5 6 7 8 9 10; do expect 201 "URL ${i}" POST /admin/personas/built/knowledgebases/many/sources "{\"kind\":\"url\",\"name\":\"u${i}\",\"url\":\"http://127.0.0.1:${STUB_PORT}/doc.md?n=${i}\"}"; done
expect 409 "an eleventh URL" POST /admin/personas/built/knowledgebases/many/sources "{\"kind\":\"url\",\"name\":\"u11\",\"url\":\"http://127.0.0.1:${STUB_PORT}/doc.md\"}" too_many_sources
# An eleventh put in kb.json by hand is refused at ingest.
node -e 'const f=process.argv[1]; const c=JSON.parse(require("fs").readFileSync(f,"utf8")); c.externalSources.push({id:"u11",type:"url",url:"http://127.0.0.1:1/x"}); require("fs").writeFileSync(f, JSON.stringify(c));' "${DATA}/personas/built/knowledgebases/many/kb.json"
expect 422 "ingest with eleven URLs" POST /admin/personas/built/knowledgebases/many/ingest '{}' too_many_sources
# Overlapping ingests: one per KB (ingest_running), two at once (ingest_busy).
for kb in slow slow2 slow3; do
  expect 201 "KB ${kb}" POST /admin/personas/built/knowledgebases "{\"id\":\"${kb}\"}"
  expect 201 "a slow URL in ${kb}" POST "/admin/personas/built/knowledgebases/${kb}/sources" "{\"kind\":\"url\",\"name\":\"slow\",\"url\":\"http://127.0.0.1:${STUB_PORT}/slow.md\"}"
done
curl -s -o "${TEMP_RUNTIME}/first-ingest.json" -X POST "${ADMIN[@]}" -d '{}' "${BASE}/admin/personas/built/knowledgebases/slow/ingest" &
first_ingest=$!
curl -s -o "${TEMP_RUNTIME}/second-ingest.json" -X POST "${ADMIN[@]}" -d '{}' "${BASE}/admin/personas/built/knowledgebases/slow2/ingest" &
second_ingest=$!
sleep 1
expect 409 "the same KB while it runs" POST /admin/personas/built/knowledgebases/slow/ingest '{}' ingest_running
expect 409 "a third KB while two run" POST /admin/personas/built/knowledgebases/slow3/ingest '{}' ingest_busy
wait "${first_ingest}" "${second_ingest}"
grep -q '"entryCount"' "${TEMP_RUNTIME}/first-ingest.json" && grep -q '"entryCount"' "${TEMP_RUNTIME}/second-ingest.json" || { echo "an overlapped ingest failed: $(cat "${TEMP_RUNTIME}/first-ingest.json" "${TEMP_RUNTIME}/second-ingest.json")" >&2; exit 1; }
expect 200 "the third KB once they finish" POST /admin/personas/built/knowledgebases/slow3/ingest '{}'
expect 200 "read the notes sources" GET /admin/personas/built/knowledgebases/notes/sources
body_check "sources" 'JSON.stringify(b.sources.text) === JSON.stringify(["facts"]) && b.sources.urls.length === 1 && b.sources.urls[0].id === "web"'
# Fetching needs the advanced permission, whoever added the URL.
expect 200 "revoke advanced settings" POST /admin/permissions/advanced '{"enabled":false}'
expect 403 "ingest URL sources without the advanced permission" POST /admin/personas/built/knowledgebases/notes/ingest '{}'
expect 200 "grant advanced settings again" POST /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}'
# A token in a URL's query is fetched but never written down: not in the index, not in recall.
expect 201 "a URL with a token that answers" POST /admin/personas/built/knowledgebases/notes/sources "{\"kind\":\"url\",\"name\":\"tokdoc\",\"url\":\"http://127.0.0.1:${STUB_PORT}/doc.md?token=smoke-tok-5555\"}"
expect 200 "ingest" POST /admin/personas/built/knowledgebases/notes/ingest '{}'
grep -q 'smoke-tok-5555' "${DATA}/personas/built/knowledgebases/notes/index.json" && { echo "a URL token was written into the index" >&2; exit 1; }
grep -qF '/doc.md?…' "${DATA}/personas/built/knowledgebases/notes/index.json" || { echo "the tokened source was not indexed under its written address" >&2; exit 1; }
body_check "ingest" 'b.knowledgebase.entryCount >= 3 && b.knowledgebase.sourceCount === 3'
grep -q 'URLFACT-8802' "${DATA}/personas/built/knowledgebases/notes/index.json" || { echo "the URL source was not fetched at ingest" >&2; exit 1; }
# Over the size cap: the ingest fails and says why.
expect 201 "a KB for the size check" POST /admin/personas/built/knowledgebases '{"id":"big"}'
expect 201 "a huge URL" POST /admin/personas/built/knowledgebases/big/sources "{\"kind\":\"url\",\"name\":\"huge\",\"url\":\"http://127.0.0.1:${STUB_PORT}/huge.md\"}"
expect 422 "ingest over the size cap" POST /admin/personas/built/knowledgebases/big/ingest '{}' "larger than"
# A linked KB folder is refused.
ln -s "${DATA}/knowledgebases/g1" "${DATA}/personas/built/knowledgebases/evil"
expect 422 "a source into a linked KB" POST /admin/personas/built/knowledgebases/evil/sources '{"kind":"text","name":"x","text":"x"}' "is a link"
expect 422 "ingest of a linked KB" POST /admin/personas/built/knowledgebases/evil/ingest '{}'
rm "${DATA}/personas/built/knowledgebases/evil"
expect 200 "list private KBs" GET /admin/personas/built/knowledgebases
body_check "private list" 'b.knowledgebases.some((k) => k.id === "notes" && k.indexed === true)'
expect 200 "list global KBs" GET /admin/knowledgebases
body_check "global list" 'b.knowledgebases.length === 1 && b.knowledgebases[0].id === "g1" && !("dir" in b.knowledgebases[0])'
echo "private KBs ok"

# --- 6. Switch to the built persona: its private KB is recalled in a chat.
expect 200 "switch to it" PATCH /admin/config/personas '{"active":"built"}'
: > "${CAPTURE}"
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${PADMIN_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'x-mindstone-conversation-id: conv-built' -d '{"model":"mindstone/default","messages":[{"role":"user","content":"Which private reference code applies for this collection?"}]}' "${BASE}/v1/chat/completions")"
[[ "${code}" == 200 ]] || { echo "the chat failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); process.stdout.write(JSON.parse(l.pop()).messages.map((m)=>m.text??"").join("\n"))' "${CAPTURE}" > "${TEMP_RUNTIME}/built.prompt"
for text in BUILT-8810 PADMIN-8801 GFACT-8800 URLFACT-8802; do grep -qF "${text}" "${TEMP_RUNTIME}/built.prompt" || { echo "chat: '${text}' is missing from the prompt" >&2; exit 1; }; done
grep -q 'smoke-tok-5555' "${TEMP_RUNTIME}/built.prompt" && { echo "a URL token reached the prompt" >&2; exit 1; }
# The tokened source itself is in the prompt (so the check above tested something), under its written address.
grep -qF 'source: url:tokdoc' "${TEMP_RUNTIME}/built.prompt" || { echo "the tokened source is not in the prompt, so the token check proved nothing" >&2; exit 1; }
grep -qF '/doc.md?…' "${TEMP_RUNTIME}/built.prompt" || { echo "the tokened source's written address is not in the prompt" >&2; exit 1; }
echo "chat ok"

# --- 7. Housekeeping: no staging folders left; writes audited; a non-admin can't write.
if find "${DATA}/personas" "${DATA}/workflows" -name '.staging-*' ! -name '.staging-leftover' | grep -q .; then echo "a staging folder was left behind" >&2; exit 1; fi
for action in persona_created persona_edited workflow_created workflow_edited persona_kb_created persona_kb_source_added persona_kb_ingested; do
  grep -q "\"action\":\"${action}\"" "${DATA}/admin/audit.jsonl" || { echo "no audit entry for ${action}" >&2; exit 1; }
done
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${PADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json' -d '{"id":"sneak","name":"S","personaMarkdown":"x"}' "${BASE}/admin/personas")"
[[ "${code}" != 201 && ! -e "${DATA}/personas/sneak" ]] || { echo "a write without the admin credential created a persona (${code})" >&2; exit 1; }
echo "housekeeping ok"

echo "Persona admin smoke test passed."
