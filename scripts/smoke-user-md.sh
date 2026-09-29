#!/usr/bin/env bash
# What the agent knows about the owner, from the Console's Settings (#140):
#   - GET /admin/user: the default agent's USER.md (the file the agent reads),
#     its size and an etag; never a host path
#   - PATCH /admin/user { markdown }: replaces it whole, with the advanced-
#     settings permission and the etag read with it (If-Match; "*" and none
#     are refused), so a file the agent changed meanwhile is never overwritten
#   - at most 64 KiB, no control characters but newline, CR and tab, the
#     file's mode kept, audited without the text
#   - the owner's next chat carries the new text; a non-owner's doesn't
#   - only a plain file named USER.md under the config folder's agents/
#     folder: a userPath elsewhere (a stored secret, the config folder, another
#     file name), a link as the file, or a linked folder on the way (the agents
#     folder included) is refused, read or write
# Binds gateway port base+38; serialize per smoke protocol. Synthetic text only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-user-md-smoke.XXXXXX")"
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
export UMD_TOKEN="user-md-smoke-service-token"
export UMD_ADMIN_TOKEN="user-md-smoke-admin-token"
export CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
cd "${PROJECT_ROOT}"
echo "== USER.md admin route smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
USER_MD="${DATA}/agents/default/USER.md"
OUTSIDE="${TEMP_RUNTIME}/outside"
mkdir -p "${OUTSIDE}"
BASE="http://127.0.0.1:${GATEWAY_PORT}"
BODY="${TEMP_RUNTIME}/body.json"

python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "UMD_TOKEN"}
c["gateway"]["admin"] = {"tokenEnv": "UMD_ADMIN_TOKEN"}
c["gateway"]["http"] = {"chatCompletions": {"enabled": True}}
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock",
                "mock": {"responsePrefix": "umd", "captureFile": os.environ["CAPTURE"]}}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
# A real identity, so the owner's chats carry USER.md (a pending scaffold would start identity formation).
printf '# Smoke Agent\n\nAn agent for the USER.md smoke.\n' > "${DATA}/agents/default/IDENTITY.md"

./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

ADMIN=(-H "Authorization: Bearer ${UMD_TOKEN}" -H "x-mindstone-admin-token: ${UMD_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
get() { curl -s -o "${BODY}" -w '%{http_code}' "${ADMIN[@]}" "${BASE}$1"; }
post() { curl -s -o "${BODY}" -w '%{http_code}' -X POST "${ADMIN[@]}" -d "$2" "${BASE}$1"; }
patch_config() { curl -s -o "${BODY}" -w '%{http_code}' -X PATCH "${ADMIN[@]}" -d "$2" "${BASE}/admin/config/$1"; }
# put_user <if-match or "none"> <json body file>
put_user() {
  local match=()
  [[ "$1" != none ]] && match=(-H "If-Match: $1")
  curl -s -o "${BODY}" -w '%{http_code}' -X PATCH "${ADMIN[@]}" ${match[@]+"${match[@]}"} --data-binary "@$2" "${BASE}/admin/user"
}
expect() { local got="$1" want="$2" label="$3"; [[ "${got}" == "${want}" ]] || { echo "${label}: expected ${want}, got ${got}: $(cat "${BODY}")" >&2; exit 1; }; }
field() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); let v=b; for (const k of process.argv[2].split(".")) v=v?.[k]; console.log(typeof v==="object"?JSON.stringify(v):String(v))' "${BODY}" "$1"; }
body_file() { node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(JSON.parse(process.argv[2])))' "$1" "$2"; }
owner_chat() { # capture-name role
  : > "${CAPTURE}"
  curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${UMD_TOKEN}" -H 'content-type: application/json' \
    -H "x-mindstone-user-role: $2" -H "x-mindstone-user-id: smoke-$2" -H "x-mindstone-conversation-id: conv-$1" \
    -d '{"model":"mindstone/default","messages":[{"role":"user","content":"What do you know about me?"}]}' "${BASE}/v1/chat/completions" >"${TEMP_RUNTIME}/code"
  [[ "$(cat "${TEMP_RUNTIME}/code")" == 200 ]] || { echo "chat as $2 failed: $(cat "${BODY}")" >&2; exit 1; }
  cp "${CAPTURE}" "${TEMP_RUNTIME}/$1.jsonl"
}

# --- 1. Read: the file the agent reads, with an etag and no host path.
printf '# User Context\n\nSYNTH-OLD-140 likes short answers.\n' > "${USER_MD}"
expect "$(get /admin/user)" 200 "reading USER.md"
[[ "$(field exists)" == true && "$(field markdown)" == *"SYNTH-OLD-140"* ]] || { echo "GET should return the file's text: $(cat "${BODY}")" >&2; exit 1; }
grep -q "${TEMP_RUNTIME}" "${BODY}" && { echo "GET leaked a host path: $(cat "${BODY}")" >&2; exit 1; }
ETAG="$(field etag)"
[[ "${ETAG}" =~ ^\"[0-9a-f]+\"$ ]] || { echo "the etag should be a quoted hex string: ${ETAG}" >&2; exit 1; }

# --- 2. Writing needs advanced settings, then the etag read.
NEW="${TEMP_RUNTIME}/new.json"
body_file "${NEW}" '{"markdown":"# User Context\n\nSYNTH-NEW-140 prefers tables.\r\n\tIndented.\n"}'
expect "$(put_user "${ETAG}" "${NEW}")" 403 "a write without the permission"
expect "$(post /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}')" 200 "granting advanced settings"
expect "$(put_user none "${NEW}")" 428 "a write without If-Match"
expect "$(put_user '*' "${NEW}")" 428 "a write with If-Match: *"
expect "$(put_user '"0000"' "${NEW}")" 412 "a write with a wrong etag"
grep -q 'SYNTH-OLD-140' "${USER_MD}" || { echo "a refused write changed USER.md" >&2; exit 1; }

# --- 3. Bad bodies are refused before anything is read.
BAD="${TEMP_RUNTIME}/bad.json"
body_file "${BAD}" '{"markdown":"bell \u0007 here"}'
expect "$(put_user "${ETAG}" "${BAD}")" 400 "a control character"
body_file "${BAD}" '{"markdown":"x","path":"/etc/passwd"}'
expect "$(put_user "${ETAG}" "${BAD}")" 400 "an unknown field"
body_file "${BAD}" '{"markdown":42}'
expect "$(put_user "${ETAG}" "${BAD}")" 400 "markdown that isn't text"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ markdown: "a".repeat(64 * 1024 + 1) }))' "${BAD}"
expect "$(put_user "${ETAG}" "${BAD}")" 413 "more than 64 KiB"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ markdown: "a".repeat(64 * 1024) }))' "${BAD}"
[[ "$(wc -c <"${BAD}")" -gt $((64 * 1024)) ]] || { echo "control: the 64 KiB body should be over 64 KiB as JSON" >&2; exit 1; }

# --- 4. The write: the text replaced whole, the mode kept, audited without the text.
chmod 640 "${USER_MD}"
expect "$(put_user "${ETAG}" "${NEW}")" 200 "replacing USER.md"
NEW_ETAG="$(field etag)"
node -e 'const want=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")).markdown; const got=require("fs").readFileSync(process.argv[1],"utf8"); if (got!==want) { console.error("USER.md is not exactly the text sent: "+JSON.stringify(got)); process.exit(1); }' "${USER_MD}" "${NEW}"
[[ "$(stat -f '%Lp' "${USER_MD}" 2>/dev/null || stat -c '%a' "${USER_MD}")" == 640 ]] || { echo "the write should keep the file's mode (640)" >&2; exit 1; }
ls "${DATA}/agents/default" | grep -q '\.tmp-' && { echo "the write left a temp file" >&2; exit 1; }
grep -q '"action":"user_md_replaced"' "${DATA}/admin/audit.jsonl" || { echo "the write wasn't audited" >&2; exit 1; }
grep -q 'SYNTH-NEW-140' "${DATA}/admin/audit.jsonl" && { echo "the audit holds USER.md's text" >&2; exit 1; }
expect "$(get /admin/user)" 200 "reading USER.md back"
[[ "$(field etag)" == "${NEW_ETAG}" && "$(field markdown)" == *"SYNTH-NEW-140"* ]] || { echo "GET should return the new text and the etag the write gave: $(cat "${BODY}")" >&2; exit 1; }

# --- 5. The agent reads the new text: the owner's chat has it, a non-owner's doesn't.
owner_chat owner admin
grep -q 'SYNTH-NEW-140' "${TEMP_RUNTIME}/owner.jsonl" || { echo "the owner's chat should carry the new USER.md" >&2; exit 1; }
grep -q 'SYNTH-OLD-140' "${TEMP_RUNTIME}/owner.jsonl" && { echo "the owner's chat still has the old USER.md" >&2; exit 1; }
owner_chat other user
grep -q 'SYNTH-NEW-140' "${TEMP_RUNTIME}/other.jsonl" && { echo "a non-owner's chat carried USER.md" >&2; exit 1; }

# --- 6. The agent changed it meanwhile: the etag read before is refused, and its change stays.
printf '# User Context\n\nSYNTH-AGENT-140 wrote this.\n' > "${USER_MD}"
expect "$(put_user "${NEW_ETAG}" "${NEW}")" 412 "a write over the agent's change"
grep -q 'SYNTH-AGENT-140' "${USER_MD}" || { echo "a stale write overwrote the agent's change" >&2; exit 1; }

# --- 7. A missing file: read as not existing, and created by a write with its etag.
rm "${USER_MD}"
expect "$(get /admin/user)" 200 "reading a missing USER.md"
[[ "$(field exists)" == false ]] || { echo "a missing USER.md should read as exists: false" >&2; exit 1; }
expect "$(put_user "$(field etag)" "${NEW}")" 200 "creating USER.md"
[[ "$(stat -f '%Lp' "${USER_MD}" 2>/dev/null || stat -c '%a' "${USER_MD}")" == 600 ]] || { echo "a new USER.md should be 600" >&2; exit 1; }

# --- 8. Only a plain file inside the config's folder, read or write.
expect "$(get /admin/user)" 200 "reading before the path checks"
GOOD_ETAG="$(field etag)"
printf 'SYNTH-OUTSIDE-140\n' > "${OUTSIDE}/USER.md"
# A userPath outside the config folder.
expect "$(patch_config agents '{"default":{"userPath":"'"${OUTSIDE}/USER.md"'"}}')" 200 "pointing userPath outside"
expect "$(get /admin/user)" 409 "reading a USER.md outside the config folder"
grep -q 'SYNTH-OUTSIDE-140' "${BODY}" && { echo "GET read a file outside the config folder" >&2; exit 1; }
expect "$(put_user "${GOOD_ETAG}" "${NEW}")" 409 "writing a USER.md outside the config folder"
grep -q 'SYNTH-OUTSIDE-140' "${OUTSIDE}/USER.md" || { echo "a file outside the config folder was written" >&2; exit 1; }
# ../ out of the config folder, relative.
expect "$(patch_config agents '{"default":{"userPath":"../outside/USER.md"}}')" 200 "a relative userPath out of the folder"
expect "$(get /admin/user)" 409 "reading ../outside/USER.md"
# A link as the file.
expect "$(patch_config agents '{"default":{"userPath":"agents/default/USER.md"}}')" 200 "userPath back"
rm -f "${USER_MD}"
ln -s "${OUTSIDE}/USER.md" "${USER_MD}"
expect "$(get /admin/user)" 409 "reading a USER.md that is a link"
expect "$(put_user "${GOOD_ETAG}" "${NEW}")" 409 "writing a USER.md that is a link"
[[ -L "${USER_MD}" ]] || { echo "the link was replaced" >&2; exit 1; }
grep -q 'SYNTH-OUTSIDE-140' "${OUTSIDE}/USER.md" || { echo "a write went through the link" >&2; exit 1; }
rm "${USER_MD}"
# A linked folder on the way, inside the config folder.
ln -s "${OUTSIDE}" "${DATA}/agents/linked"
expect "$(patch_config agents '{"default":{"userPath":"agents/linked/USER.md"}}')" 200 "userPath through a linked folder"
expect "$(get /admin/user)" 409 "reading through a linked folder"
expect "$(put_user "${GOOD_ETAG}" "${NEW}")" 409 "writing through a linked folder"
grep -q 'SYNTH-OUTSIDE-140' "${OUTSIDE}/USER.md" || { echo "a write went through the linked folder" >&2; exit 1; }
# Inside the config folder but not an agent's USER.md: a stored secret, the config folder itself, another file name.
mkdir -p "${DATA}/secrets"
printf 'SYNTH-SECRET-140\n' > "${DATA}/secrets/USER.md"
expect "$(patch_config agents '{"default":{"userPath":"secrets/USER.md"}}')" 200 "userPath at the secrets folder"
expect "$(get /admin/user)" 409 "reading a USER.md in the secrets folder"
grep -q 'SYNTH-SECRET-140' "${BODY}" && { echo "GET read a stored secret" >&2; exit 1; }
expect "$(put_user "${GOOD_ETAG}" "${NEW}")" 409 "writing a USER.md in the secrets folder"
grep -q 'SYNTH-SECRET-140' "${DATA}/secrets/USER.md" || { echo "a stored secret was overwritten" >&2; exit 1; }
printf 'SYNTH-ROOT-140\n' > "${DATA}/USER.md"
expect "$(patch_config agents '{"default":{"userPath":"USER.md"}}')" 200 "userPath at the config folder"
expect "$(get /admin/user)" 409 "reading a USER.md next to the config"
printf 'SYNTH-NOTES-140\n' > "${DATA}/agents/default/NOTES.md"
expect "$(patch_config agents '{"default":{"userPath":"agents/default/NOTES.md"}}')" 200 "userPath at another file name"
expect "$(get /admin/user)" 409 "reading a file not named USER.md"
grep -q 'SYNTH-NOTES-140' "${BODY}" && { echo "GET read a file not named USER.md" >&2; exit 1; }
# A link from one agent's folder to another, both inside agents/.
printf 'SYNTH-ALIAS-140\n' > "${USER_MD}"
ln -s "${DATA}/agents/default" "${DATA}/agents/alias"
expect "$(patch_config agents '{"default":{"userPath":"agents/alias/USER.md"}}')" 200 "userPath through a link between agent folders"
expect "$(get /admin/user)" 409 "reading through a link between agent folders"
rm "${DATA}/agents/alias" "${USER_MD}"
# No userPath: the agent reads none, so there is none to show or write.
expect "$(patch_config agents '{"default":{"userPath":null}}')" 200 "removing userPath"
expect "$(get /admin/user)" 409 "reading with no userPath"
expect "$(put_user "${GOOD_ETAG}" "${NEW}")" 409 "writing with no userPath"
[[ ! -e "${USER_MD}" ]] || { echo "a write with no userPath created a file" >&2; exit 1; }

# The agents folder itself a link to a folder elsewhere.
expect "$(patch_config agents '{"default":{"userPath":"agents/default/USER.md"}}')" 200 "userPath back again"
mv "${DATA}/agents" "${OUTSIDE}/agents"
ln -s "${OUTSIDE}/agents" "${DATA}/agents"
printf 'SYNTH-MOVED-140\n' > "${OUTSIDE}/agents/default/USER.md"
expect "$(get /admin/user)" 409 "reading through an agents folder that is a link"
grep -q 'SYNTH-MOVED-140' "${BODY}" && { echo "GET read through an agents folder that is a link" >&2; exit 1; }
expect "$(put_user "${GOOD_ETAG}" "${NEW}")" 409 "writing through an agents folder that is a link"
grep -q 'SYNTH-MOVED-140' "${OUTSIDE}/agents/default/USER.md" || { echo "a write went through the linked agents folder" >&2; exit 1; }

echo "USER.md admin route smoke test passed."
