#!/usr/bin/env bash
# Console onboarding (#102, #103): what the Console's guided setup needs from
# the gateway, and what the owner's first Console chat gets.
#   - /admin/status: onboarded only with a provider, a persona, memory (vector
#     store and embedding provider) and the identity scaffold
#   - POST /admin/memory/check: a live embed with a candidate provider;
#     POST /admin/memory/pull: an Ollama model download (against a stub)
#   - POST /admin/onboarding/complete: the onboarding record and the
#     IDENTITY.md/USER.md scaffold, placeholders replaced with a backup,
#     real files kept
#   - /v1/chat/completions: a Console admin is the owner; a Console user, or a
#     blank role header, is not. Identity formation runs in the owner's first
#     conversation after setup, once per agent.
# Binds gateway port base+28 and an embedding stub on base+29; serialize per
# smoke protocol. Synthetic secrets only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-console-onboarding-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 28))"
STUB_PORT="$((SMOKE_PORT_BASE + 29))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${stub_pid:-}" ]]; then kill "${stub_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export ONB_TOKEN="onboarding-smoke-service-token"
export ONB_ADMIN_TOKEN="onboarding-smoke-admin-token"
# The embedding provider the gateway checks: a stub, never a real service.
export EMBEDDER_BASE_URL="http://127.0.0.1:${STUB_PORT}/v1"
export CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
cd "${PROJECT_ROOT}"
echo "== Console onboarding smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
BASE="http://127.0.0.1:${GATEWAY_PORT}"
BODY="${TEMP_RUNTIME}/body.json"

# The embedding stub: nomic-embed-text answers; any other model is "not found"
# until /api/pull downloads it.
STUB_PORT="${STUB_PORT}" node <<'NODE' >"${TEMP_RUNTIME}/stub.log" 2>&1 &
const { createServer } = require("node:http");
const pulled = new Set(["nomic-embed-text"]);
createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk)).on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/embeddings") {
      if (!pulled.has(body.model)) return send(404, { error: { message: `model "${body.model}" not found, try pulling it first` } });
      return send(200, { data: (body.input ?? []).map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) });
    }
    if (req.url === "/api/pull") {
      // Slow enough that a second download overlaps it.
      return setTimeout(() => { pulled.add(body.model); send(200, { status: "success" }); }, 1500);
    }
    send(404, { error: "not found" });
  });
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");
NODE
stub_pid=$!

python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "ONB_TOKEN"}
c["gateway"]["admin"] = {"tokenEnv": "ONB_ADMIN_TOKEN"}
c["gateway"]["http"] = {"chatCompletions": {"enabled": True}, "responses": {"enabled": True}}
# A fresh Console install: no provider yet, no onboarding record.
c["routing"] = {"mode": "placeholder", "defaultAgentId": "default"}
c.pop("onboarding", None)
c.pop("memory", None)
p.write_text(json.dumps(c, indent=2) + "\n")
PY

./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

ADMIN=(-H "Authorization: Bearer ${ONB_TOKEN}" -H "x-mindstone-admin-token: ${ONB_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
get() { curl -s -o "${BODY}" -w '%{http_code}' "${ADMIN[@]}" "${BASE}$1"; }
post() { curl -s -o "${BODY}" -w '%{http_code}' -X POST "${ADMIN[@]}" -d "$2" "${BASE}$1"; }
patch() { curl -s -o "${BODY}" -w '%{http_code}' -X PATCH "${ADMIN[@]}" -d "$2" "${BASE}/admin/config/$1"; }
expect() { local got="$1" want="$2" label="$3"; [[ "${got}" == "${want}" ]] || { echo "${label}: expected ${want}, got ${got}: $(cat "${BODY}")" >&2; exit 1; }; }
field() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); let v=b; for (const k of process.argv[2].split(".")) v=v?.[k]; console.log(typeof v==="object"?JSON.stringify(v):String(v))' "${BODY}" "$1"; }

# --- 0. Unit: an embedding provider from the environment counts for the memory step.
MINDSTONE_EMBEDDING_PROVIDER="ollama:nomic-embed-text" npx tsx -e '
import { onboardingSteps } from "./packages/mindstone-gateway/src/admin-api.ts";
const steps = onboardingSteps({ memory: { vectorStore: "sqlite-vec" } } as never).steps;
if (!steps.memory.done) { console.error("an embedding provider from the environment should count: " + JSON.stringify(steps.memory)); process.exit(1); }
' || exit 1

# --- 1. Nothing is set up: not onboarded, every step says what's missing.
expect "$(get /admin/status)" 200 "status on a fresh install"
[[ "$(field onboarded)" == false ]] || { echo "a fresh install counted as onboarded" >&2; exit 1; }
[[ "$(field steps.identity.done)" == false && "$(field steps.memory.done)" == false ]] || { echo "identity and memory should be missing: $(cat "${BODY}")" >&2; exit 1; }
grep -q 'no vector store and no embedding provider' "${BODY}" || { echo "the memory step should say what's missing: $(cat "${BODY}")" >&2; exit 1; }

# --- 2. The advanced permission gates the new routes.
expect "$(post /admin/memory/check '{"embeddingProvider":"ollama:nomic-embed-text"}')" 403 "a memory check without the permission"
expect "$(post /admin/memory/pull '{"model":"nomic-embed-text"}')" 403 "a model download without the permission"
expect "$(post /admin/onboarding/complete '{}')" 403 "finishing setup without the permission"
expect "$(post /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}')" 200 "granting advanced settings"

# --- 3. Finishing setup needs a provider and a persona first.
expect "$(post /admin/onboarding/complete '{}')" 409 "finishing setup before a provider is chosen"
[[ ! -e "${DATA}/agents/default/IDENTITY.md.pre-onboarding-placeholder.bak" ]] || { echo "a refused finish wrote the scaffold" >&2; exit 1; }
expect "$(patch routing '{"mode":"mock","defaultAgentId":"default","defaultModel":"mindstone/mock","mock":{"responsePrefix":"onb","captureFile":"'"${CAPTURE}"'","failWhenTextIncludes":"PLEASE-FAIL"}}')" 200 "choosing the mock provider"
# The persona step, as the Console does it: the profile in onboarding and on the agent.
expect "$(patch onboarding '{"profile":{"id":"general_companion","label":"General Companion","description":"Broad utility partner.","selectedAt":"2026-09-28T00:00:00.000Z"}}')" 200 "the persona step's onboarding profile"
expect "$(patch agents '{"default":{"id":"default","profileId":"general_companion"}}')" 200 "the persona step's agent profile"
# A chat before setup finishes: no identity formation yet (the persona step
# wrote an onboarding record, but not the scaffold).
: > "${CAPTURE}"
curl -s -o "${BODY}" -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'x-mindstone-conversation-id: conv-early' \
  -d '{"model":"mindstone/default","messages":[{"role":"user","content":"Hello early"}]}' "${BASE}/v1/chat/completions" >/dev/null
[[ ! -e "${DATA}/identity-formation/default.json" ]] || { echo "a chat before setup finished started identity formation" >&2; exit 1; }
grep -q 'first-activation identity formation' "${CAPTURE}" && { echo "a chat before setup finished got the formation prompt" >&2; exit 1; }
expect "$(get /admin/status)" 200 "status after the persona step"
[[ "$(field steps.identity.done)" == false ]] || { echo "the persona step alone must not count as identity done" >&2; exit 1; }

# --- 4. The memory step: a live check, a download for a missing model, then save.
expect "$(post /admin/memory/check '{"embeddingProvider":"nope:model"}')" 400 "an unknown embedding provider"
expect "$(post /admin/memory/check '{"embeddingProvider":"ollama:nomic-embed-text","x":1}')" 400 "an extra key in a memory check"
expect "$(post /admin/memory/check '{"embeddingProvider":"ollama:nomic-embed-text"}')" 200 "checking a working embedding model"
[[ "$(field ok)" == true && "$(field dimensions)" == 3 ]] || { echo "a working model should report its dimensions: $(cat "${BODY}")" >&2; exit 1; }
expect "$(post /admin/memory/check '{"embeddingProvider":"ollama:mxbai-embed-large"}')" 200 "checking a model that isn't downloaded"
[[ "$(field ok)" == false && "$(field missingModel)" == true ]] || { echo "a missing Ollama model should say so: $(cat "${BODY}")" >&2; exit 1; }
expect "$(post /admin/memory/pull '{"model":"../etc"}')" 400 "a model name that isn't one"
for name in "hf.co/someone/model" "registry.example.invalid/ns/model:tag" "a/../../b" "http://example.invalid/x"; do
  expect "$(post /admin/memory/pull "{\"model\":\"${name}\"}")" 400 "a model from another registry (${name})"
done
expect "$(post /admin/memory/pull '{"model":"all-minilm"}')" 409 "downloading a model the check didn't report missing"
# Two downloads at once: one runs, the other is refused as busy.
post /admin/memory/pull '{"model":"mxbai-embed-large"}' > "${TEMP_RUNTIME}/pull1.code" &
pull1=$!
sleep 0.4
second="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${ADMIN[@]}" -d '{"model":"mxbai-embed-large"}' "${BASE}/admin/memory/pull")"
wait "${pull1}"
[[ "${second}" == 409 ]] || { echo "a second concurrent download should be refused as busy, got ${second}" >&2; exit 1; }
[[ "$(cat "${TEMP_RUNTIME}/pull1.code")" == 200 ]] || { echo "the first download should succeed" >&2; exit 1; }
# Downloaded; checking again finds it, so the download slot is cleared.
: "downloading the model"
expect "$(post /admin/memory/check '{"embeddingProvider":"ollama:mxbai-embed-large"}')" 200 "checking the downloaded model"
[[ "$(field ok)" == true ]] || { echo "the downloaded model should now embed: $(cat "${BODY}")" >&2; exit 1; }
expect "$(patch memory '{"vectorStore":"sqlite-vec","embeddingProvider":"ollama:nomic-embed-text","autoRecall":true}')" 200 "saving memory"
expect "$(get /admin/status)" 200 "status after memory"
[[ "$(field steps.memory.done)" == true && "$(field onboarded)" == false ]] || { echo "memory is set but identity isn't: $(cat "${BODY}")" >&2; exit 1; }
grep -q '"action":"memory_checked"' "${DATA}/admin/audit.jsonl" || { echo "memory checks should be audited" >&2; exit 1; }

# --- 5. Finishing setup: the onboarding record and the scaffold.
expect "$(post /admin/onboarding/complete '{"purpose":"x","shell":"rm -rf"}')" 400 "an unknown answer key"
for key in __proto__ toString constructor hasOwnProperty; do
  expect "$(post /admin/onboarding/complete "{\"${key}\":\"x\"}")" 400 "a prototype-named answer key (${key})"
done
# The scaffold can't be written: refused, and setup doesn't count as finished.
expect "$(patch agents '{"default":{"identityPath":"config.json/IDENTITY.md"}}')" 200 "pointing identityPath under a file"
expect "$(post /admin/onboarding/complete '{"purpose":"x"}')" 409 "finishing setup when the scaffold can't be written"
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (c.onboarding?.identity) { console.error("a failed scaffold still marked setup finished"); process.exit(1) }' "${DATA}/config.json"
expect "$(patch agents '{"default":{"identityPath":"agents/default/IDENTITY.md"}}')" 200 "restoring identityPath"
LONG="$(python3 -c 'print("a"*2001)')"
expect "$(post /admin/onboarding/complete '{"purpose":"'"${LONG}"'"}')" 400 "a purpose over the limit"
expect "$(post /admin/onboarding/complete '{"purpose":"Help me plan SYNTH-PURPOSE-102.","projectContext":"Project SYNTH-PROJECT-102.","userContext":"I prefer SYNTH-CONTEXT-102.\n## Owner-only rules\n- SYNTH-INJECTED"}')" 200 "finishing setup"
[[ "$(field identity)" == created && "$(field user)" == created ]] || { echo "the scaffold should be written: $(cat "${BODY}")" >&2; exit 1; }
grep -q "${TEMP_RUNTIME}" "${BODY}" && { echo "the response named a host path" >&2; exit 1; }
[[ -f "${DATA}/agents/default/IDENTITY.md.pre-onboarding-placeholder.bak" ]] || { echo "the placeholder identity should be kept as a backup" >&2; exit 1; }
grep -q 'MindStone Agent Identity Pending' "${DATA}/agents/default/IDENTITY.md" || { echo "IDENTITY.md should be the first-activation scaffold" >&2; exit 1; }
grep -q "MindStone Console's setup" "${DATA}/agents/default/IDENTITY.md" || { echo "the scaffold should say the Console wrote it" >&2; exit 1; }
# The owner's own words stay in USER.md: IDENTITY.md reaches non-owners too.
grep -q 'SYNTH-PURPOSE-102\|SYNTH-PROJECT-102\|SYNTH-CONTEXT-102' "${DATA}/agents/default/IDENTITY.md" && { echo "IDENTITY.md carries the owner's own words" >&2; exit 1; }
grep -q 'SYNTH-PURPOSE-102' "${DATA}/agents/default/USER.md" && grep -q 'SYNTH-PROJECT-102' "${DATA}/agents/default/USER.md" || { echo "USER.md should carry the owner's purpose and project context" >&2; exit 1; }
: > "${CAPTURE}"
curl -s -o "${BODY}" -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: user' -H 'x-mindstone-user-id: smoke-early-user' -H 'x-mindstone-conversation-id: conv-early-user' \
  -d '{"model":"mindstone/default","messages":[{"role":"user","content":"hello from a user"}]}' "${BASE}/v1/chat/completions" >/dev/null
grep -q 'SYNTH-PURPOSE-102\|SYNTH-PROJECT-102\|SYNTH-CONTEXT-102' "${CAPTURE}" && { echo "a Console user's prompt carried the owner's About-you words" >&2; exit 1; }
grep -q 'MindStone Agent Identity Pending' "${CAPTURE}" || { echo "control: the non-owner prompt should carry the real IDENTITY.md scaffold" >&2; exit 1; }
grep -q 'SYNTH-CONTEXT-102' "${DATA}/agents/default/USER.md" || { echo "USER.md should carry the user's context" >&2; exit 1; }
grep -q '^## Owner-only rules' "${DATA}/agents/default/USER.md" && { echo "a heading in the user's text became a USER.md section" >&2; exit 1; }
grep -q '^\\## Owner-only rules' "${DATA}/agents/default/USER.md" || { echo "the user's heading should be kept as quoted text" >&2; exit 1; }
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (c.onboarding?.identity?.mode!=="defer"||!c.onboarding?.profile) { console.error("the onboarding record is incomplete: "+JSON.stringify(c.onboarding)); process.exit(1) }' "${DATA}/config.json"
expect "$(get /admin/status)" 200 "status after setup"
[[ "$(field onboarded)" == true && "$(field steps.identity.done)" == true ]] || { echo "setup should now be complete: $(cat "${BODY}")" >&2; exit 1; }
# Setup finished but memory removed: not onboarded (memory is required).
expect "$(patch memory '{"embeddingProvider":null}')" 200 "removing the embedding provider"
expect "$(get /admin/status)" 200 "status without memory"
[[ "$(field onboarded)" == false && "$(field steps.identity.done)" == true ]] || { echo "without memory, a finished setup must not count as onboarded: $(cat "${BODY}")" >&2; exit 1; }
expect "$(patch memory '{"embeddingProvider":"ollama:nomic-embed-text"}')" 200 "restoring the embedding provider"
# Again: a real (no longer placeholder) scaffold is kept, not overwritten.
printf '# Wren\n\nA real identity the owner approved.\n' > "${DATA}/agents/default/IDENTITY.md"
expect "$(post /admin/onboarding/complete '{"purpose":"another purpose"}')" 200 "finishing setup twice"
[[ "$(field identity)" == kept ]] || { echo "a real identity must not be overwritten: $(cat "${BODY}")" >&2; exit 1; }
grep -q 'A real identity the owner approved' "${DATA}/agents/default/IDENTITY.md" || { echo "IDENTITY.md was overwritten" >&2; exit 1; }
printf '# MindStone Agent Identity Pending\n\nScaffold again for the chat checks.\n' > "${DATA}/agents/default/IDENTITY.md"
# The identity mode is checked.
expect "$(patch onboarding '{"identity":{"mode":"whatever"}}')" 422 "an unknown identity mode"

# --- 6. Console chats: who is the owner, and identity formation once per agent.
chat() { # role-header conversation-id capture-name
  local role_args=()
  if [[ "$1" == "none" ]]; then role_args=(); elif [[ "$1" == "blank" ]]; then role_args=(-H 'x-mindstone-user-role;'); else role_args=(-H "x-mindstone-user-role: $1"); fi
  : > "${CAPTURE}"
  curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' \
    ${role_args[@]+"${role_args[@]}"} -H "x-mindstone-user-id: smoke-$1" -H "x-mindstone-conversation-id: $2" \
    -d '{"model":"mindstone/default","messages":[{"role":"user","content":"Hi, I just set you up."}]}' "${BASE}/v1/chat/completions" >"${TEMP_RUNTIME}/code"
  [[ "$(cat "${TEMP_RUNTIME}/code")" == 200 ]] || { echo "chat as $1 failed: $(cat "${BODY}")" >&2; exit 1; }
  cp "${CAPTURE}" "${TEMP_RUNTIME}/$3.jsonl"
}
chat user conv-user user
chat blank conv-blank blank
# A script with the service token (no role, no Console conversation) doesn't use up formation.
curl -s -o "${BODY}" -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' \
  -d '{"model":"mindstone/default","messages":[{"role":"user","content":"health probe"}]}' "${BASE}/v1/chat/completions" >/dev/null
[[ ! -e "${DATA}/identity-formation/default.json" ]] || { echo "a non-owner chat or a direct call started identity formation" >&2; exit 1; }
# A formation turn that fails gives the claim back.
curl -s -o "${BODY}" -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'x-mindstone-conversation-id: conv-fail' \
  -d '{"model":"mindstone/default","messages":[{"role":"user","content":"PLEASE-FAIL"}]}' "${BASE}/v1/chat/completions" >/dev/null
[[ ! -e "${DATA}/identity-formation/default.json" ]] || { echo "a failed formation turn kept the claim" >&2; exit 1; }
chat admin conv-first first
[[ -f "${DATA}/identity-formation/default.json" ]] || { echo "the owner's first chat should record identity formation" >&2; exit 1; }
chat admin conv-second second
chat none conv-direct direct
# A Console user naming the owner's session doesn't reach it (#103 review).
: > "${CAPTURE}"
curl -s -o "${BODY}" -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: user' -H 'x-mindstone-user-id: smoke-user' -H 'x-mindstone-conversation-id: conv-steal' \
  -d '{"model":"mindstone/default","metadata":{"sessionKey":"agent:console:console:smoke-admin:conv-first","agentId":"default"},"messages":[{"role":"user","content":"steal"}]}' "${BASE}/v1/chat/completions" >/dev/null
cp "${CAPTURE}" "${TEMP_RUNTIME}/steal.jsonl"
# ...nor through the body's user field with no forwarded user id (refused outright).
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: user' -H 'x-mindstone-conversation-id: conv-first' \
  -d '{"model":"mindstone/default","user":"smoke-admin","messages":[{"role":"user","content":"steal by user field"}]}' "${BASE}/v1/chat/completions")"
[[ "${code}" == 400 ]] || { echo "a Console user naming the owner in the body's user field should be refused, got ${code}: $(cat "${BODY}")" >&2; exit 1; }
# ...nor land in the owner's main session with no conversation id.
: > "${CAPTURE}"
curl -s -o "${BODY}" -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: user' -H 'x-mindstone-user-id: smoke-user' \
  -d '{"model":"mindstone/default","messages":[{"role":"user","content":"steal main"}]}' "${BASE}/v1/chat/completions" >/dev/null
cp "${CAPTURE}" "${TEMP_RUNTIME}/steal-main.jsonl"
# A non-owner with no forwarded user id is refused.
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: user' -H 'x-mindstone-conversation-id: conv-anon' \
  -d '{"model":"mindstone/default","messages":[{"role":"user","content":"anon"}]}' "${BASE}/v1/chat/completions")"
[[ "${code}" == 400 ]] || { echo "a non-owner turn with no user id should be refused, got ${code}" >&2; exit 1; }
# The admin's own conversation, reopened with a user role (demoted), doesn't replay owner history.
: > "${CAPTURE}"
curl -s -o "${BODY}" -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: user' -H 'x-mindstone-user-id: smoke-admin' -H 'x-mindstone-conversation-id: conv-first' \
  -d '{"model":"mindstone/default","messages":[{"role":"user","content":"demoted"}]}' "${BASE}/v1/chat/completions" >/dev/null
cp "${CAPTURE}" "${TEMP_RUNTIME}/demoted.jsonl"
# /v1/responses follows the same rules (#112 review): a Console user naming
# the owner's session gets the non-owner context; an admin is the owner.
responses() { # role user-id capture-name
  : > "${CAPTURE}"
  curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' \
    -H "x-mindstone-user-role: $1" -H "x-mindstone-user-id: $2" -H 'x-mindstone-conversation-id: conv-responses' \
    -d '{"model":"mindstone/default","metadata":{"sessionKey":"agent:console:console:smoke-admin:conv-first","agentId":"default"},"input":"via responses"}' "${BASE}/v1/responses" >"${TEMP_RUNTIME}/code"
  [[ "$(cat "${TEMP_RUNTIME}/code")" == 200 ]] || { echo "responses as $1 failed: $(cat "${BODY}")" >&2; exit 1; }
  cp "${CAPTURE}" "${TEMP_RUNTIME}/$3.jsonl"
}
responses user smoke-user responses-user
responses admin smoke-admin responses-admin
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${ONB_TOKEN}" -H 'content-type: application/json' -H 'x-mindstone-user-role: user' \
  -d '{"model":"mindstone/default","user":"smoke-admin","input":"anon via responses"}' "${BASE}/v1/responses")"
[[ "${code}" == 400 ]] || { echo "a non-owner responses turn with no user id should be refused, got ${code}" >&2; exit 1; }
# An agent that already has a real identity isn't sent back to formation.
rm -f "${DATA}/identity-formation/default.json"
printf '# Wren\n\nAn established identity the owner approved.\n' > "${DATA}/agents/default/IDENTITY.md"
chat admin conv-established established
# Also when identityPath is left to its default.
expect "$(patch agents '{"default":{"identityPath":null}}')" 200 "leaving identityPath to its default"
chat admin conv-established-default established-default
TR="${TEMP_RUNTIME}" node <<'NODE'
const { readFileSync, readdirSync } = require("node:fs");
const fail = (m) => { console.error(m); process.exit(1); };
const prompt = (name) => {
  const lines = readFileSync(`${process.env.TR}/${name}.jsonl`, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) fail(`${name}: no model request captured`);
  return JSON.parse(lines.pop()).messages.map((m) => m.text ?? "").join("\n");
};
const FORMATION = "first-activation identity formation";
const first = prompt("first");
if (!first.includes(FORMATION)) fail("the owner's first chat after setup should start identity formation");
if (!first.includes("SYNTH-CONTEXT-102")) fail("control: the owner's chat should carry USER.md");
if (prompt("second").includes(FORMATION)) fail("identity formation ran again in the owner's second conversation");
for (const name of ["user", "blank"]) {
  const p = prompt(name);
  if (p.includes("SYNTH-CONTEXT-102")) fail(`a Console ${name} got the owner's USER.md`);
  if (p.includes(FORMATION)) fail(`a Console ${name} got identity formation`);
}
if (!prompt("direct").includes("SYNTH-CONTEXT-102")) fail("a direct caller with the service token is the owner");
if (prompt("steal").includes("onb: Hi, I just set you up.")) fail("a Console user reached the owner's session through metadata.sessionKey");
if (prompt("steal-main").includes("health probe")) fail("a Console user with no conversation id landed in the owner's main session");
if (prompt("demoted").includes("onb: Hi, I just set you up.")) fail("the same user as a non-owner replayed their owner-audience history");
if (prompt("responses-user").includes("SYNTH-CONTEXT-102")) fail("a Console user got the owner's USER.md through /v1/responses");
if (prompt("responses-user").includes("onb: Hi, I just set you up.")) fail("a Console user reached the owner's session through /v1/responses");
if (!prompt("responses-admin").includes("SYNTH-CONTEXT-102")) fail("control: a Console admin through /v1/responses is the owner");
if (prompt("established").includes(FORMATION)) fail("an agent with an established identity was sent back to identity formation");
if (prompt("established-default").includes(FORMATION)) fail("an established identity at the default path was sent back to identity formation");
// The event is recorded once, in the first conversation's transcript.
const dir = `${process.env.TR}/mindstone/transcripts`;
const events = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((e) => e.metadata?.event === "identity_formation_prompted");
if (events.length !== 1) fail(`identity_formation_prompted should be recorded once, got ${events.length}`);
NODE

echo "Console onboarding smoke test passed."
