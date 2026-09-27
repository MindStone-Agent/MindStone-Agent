#!/usr/bin/env bash
# Admin API smoke (#38, P2): the Console's server-to-server admin endpoints.
#   - absent (404) with gateway auth "none" or no admin credential configured
#   - 401 without the service token or the admin credential, 403 without the admin role
#   - /admin/config masks every secret shape; secret references (tokenEnv…) stay
#   - /admin/status reports onboarding: false until a provider and a persona exist
#   - writes: default-deny advanced settings, If-Match, slow-body staleness,
#     secrets 0600 in 0700, audit of writes and refusals
# Binds gateway port base+26 — serialize per smoke protocol. Synthetic secrets only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-admin-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 26))"
stop_gateway() { if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; unset gateway_pid; fi; }
cleanup() { stop_gateway; rm -rf "${TEMP_RUNTIME}"; }
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export ADMIN_SMOKE_TOKEN="admin-smoke-service-token"
export ADMIN_SMOKE_ADMIN_TOKEN="admin-smoke-admin-token"
cd "${PROJECT_ROOT}"
echo "== Admin API smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
CONFIG="${TEMP_RUNTIME}/mindstone/config.json"
BASE="http://127.0.0.1:${GATEWAY_PORT}"

configure() {
  AUTH_MODE="$1" ROUTING="$2" ADMIN_TOKEN_MODE="${3:-env}" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
mode = os.environ["AUTH_MODE"]
gw = c.setdefault("gateway", {})
gw["auth"] = {"mode": "none"} if mode == "none" else {"mode": "token", "tokenEnv": "ADMIN_SMOKE_TOKEN"}
if os.environ["ADMIN_TOKEN_MODE"] == "env":
    gw["admin"] = {"tokenEnv": "ADMIN_SMOKE_ADMIN_TOKEN"}
else:
    gw.pop("admin", None)
c["routing"] = {"mode": os.environ["ROUTING"], "defaultAgentId": "default", "defaultModel": "mindstone/mock"}
c.setdefault("memory", {})["embedding"] = {"apiKey": "SENTINEL-APIKEY-7731", "model": "x"}
c["channels"] = {"telegram": {
    "enabled": False, "botToken": "SENTINEL-BOT-TOKEN-7731", "tokenEnv": "TELEGRAM_TOKEN_ENV_NAME",
    "allowedSenders": ["alice"], "allowedChats": ["chat-1"],
    # Masking shapes (#38 review round 1): none of these values may reach the browser.
    "credentials": {"user": "u", "pass": "SENTINEL-OBJECT-7731"},
    "apiKeys": ["SENTINEL-ARRAY-7731"],
    "client_secret": "SENTINEL-SNAKE-7731",
    "AWS_SECRET_ACCESS_KEY": "SENTINEL-UPPER-7731",
    "authorization": "Bearer SENTINEL-AUTHZ-7731",
    "cookie": "sid=SENTINEL-COOKIE-7731",
    "dsn": "SENTINEL-DSN-7731",
    "headers": {"X-Custom": "SENTINEL-HEADER-7731"},
    "env": {"SOME_VAR": "SENTINEL-ENVMAP-7731"},
    "apiBaseUrl": "https://user:SENTINEL-USERINFO-7731@api.example.test/v1?api_key=SENTINEL-QUERY-7731&page=2",
    "tokenFile": "secrets/example",
}}
agents = c.setdefault("agents", {})
agents["default"] = {**agents.get("default", {"id": "default"}), "contextWindowTokens": 64000}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
}
start_gateway() {
  ./scripts/start-gateway.sh >>"${TEMP_RUNTIME}/gateway.log" 2>&1 &
  gateway_pid=$!
  for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
AUTH=(-H "Authorization: Bearer ${ADMIN_SMOKE_TOKEN}")
ADMIN_TOK=(-H "x-mindstone-admin-token: ${ADMIN_SMOKE_ADMIN_TOKEN}")

# 1. Auth "none": the admin API does not exist, admin credential and role or not.
configure none mock
start_gateway
test "$(code "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/status")" = "404" || { echo "admin API reachable with auth none" >&2; exit 1; }
test "$(code "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/config")" = "404" || { echo "admin config reachable with auth none" >&2; exit 1; }
stop_gateway

# 1b. Token auth but no admin credential configured: still absent.
configure token mock none
start_gateway
test "$(code "${AUTH[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/status")" = "404" || { echo "admin API reachable with no admin credential configured" >&2; exit 1; }
stop_gateway

# 2. Token auth plus the admin credential.
configure token placeholder
start_gateway
test "$(code "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/status")" = "401" || { echo "admin API without the service token must be 401" >&2; exit 1; }
# The service token alone (what webchat and API callers hold) is not enough, whatever role they claim.
test "$(code "${AUTH[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/status")" = "401" || { echo "the service token alone must not reach the admin API" >&2; exit 1; }
test "$(code "${AUTH[@]}" -H 'x-mindstone-admin-token: wrong-admin-token' -H 'x-mindstone-user-role: admin' "${BASE}/admin/status")" = "401" || { echo "a wrong admin token must be 401" >&2; exit 1; }
test "$(code "${AUTH[@]}" "${ADMIN_TOK[@]}" "${BASE}/admin/status")" = "403" || { echo "admin API without a role must be 403" >&2; exit 1; }
test "$(code "${AUTH[@]}" "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: user' "${BASE}/admin/status")" = "403" || { echo "admin API as role user must be 403" >&2; exit 1; }

STATUS="$(curl -s "${AUTH[@]}" "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: Admin' "${BASE}/admin/status")"
CONF="$(curl -s "${AUTH[@]}" "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/config")"
STATUS="${STATUS}" CONF="${CONF}" node <<'NODE'
const fail = (m) => { console.error(m); process.exit(1); };
const status = JSON.parse(process.env.STATUS);
const conf = JSON.parse(process.env.CONF);
if (status.onboarded !== false || status.steps?.provider?.done !== false) fail(`placeholder routing must not count as onboarded: ${JSON.stringify(status.steps)}`);
const sentinels = ["APIKEY", "BOT-TOKEN", "OBJECT", "ARRAY", "SNAKE", "UPPER", "AUTHZ", "COOKIE", "DSN", "HEADER", "ENVMAP", "USERINFO", "QUERY"].map((s) => `SENTINEL-${s}-7731`);
for (const [label, text] of [["status", process.env.STATUS], ["config", process.env.CONF]]) {
  for (const secret of [...sentinels, "admin-smoke-service-token", "admin-smoke-admin-token"]) {
    if (text.includes(secret)) fail(`${label} leaked ${secret}`);
  }
}
const tg = conf.config?.channels?.telegram ?? {};
if (conf.config?.memory?.embedding?.apiKey?.set !== true) fail(`apiKey should be masked to {set:true}: ${JSON.stringify(conf.config?.memory?.embedding)}`);
for (const key of ["botToken", "credentials", "apiKeys", "client_secret", "AWS_SECRET_ACCESS_KEY", "authorization", "cookie", "dsn"]) {
  if (tg[key]?.set !== true) fail(`${key} should be masked to {set:true}: ${JSON.stringify(tg[key])}`);
}
if (tg.headers?.["X-Custom"]?.set !== true || tg.env?.SOME_VAR?.set !== true) fail("header and env map values should be masked");
if (!tg.apiBaseUrl?.includes("api.example.test") || !tg.apiBaseUrl.includes("page=2")) fail(`the URL should stay readable apart from its credentials: ${tg.apiBaseUrl}`);
if (tg.tokenEnv !== "TELEGRAM_TOKEN_ENV_NAME" || tg.tokenFile !== "secrets/example") fail("secret references (tokenEnv, tokenFile) should stay visible");
if (conf.config?.gateway?.auth?.tokenEnv !== "ADMIN_SMOKE_TOKEN") fail("gateway.auth.tokenEnv should stay visible");
if (conf.config?.agents?.default?.contextWindowTokens !== 64000) fail("a token budget is not a secret");
if (typeof conf.etag !== "string") fail("GET /admin/config should return an etag");
console.log("admin read assertions passed");
NODE
stop_gateway

# 3. A provider and a persona make it onboarded.
configure token mock
chmod 640 "${CONFIG}"
start_gateway
curl -s "${AUTH[@]}" "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/status" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const status = JSON.parse(s);
  if (status.onboarded !== true) { console.error(`mock routing plus the default persona should be onboarded: ${JSON.stringify(status.steps)}`); process.exit(1); }
  console.log("onboarding assertions passed");
});'

# 4. Write side.
BODY="${TEMP_RUNTIME}/body.json"
ADMIN=("${AUTH[@]}" "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
patch() { local section="$1" body="$2"; shift 2; curl -s -o "${BODY}" -w '%{http_code}' -X PATCH "${ADMIN[@]}" "$@" -d "${body}" "${BASE}/admin/config/${section}"; }
post() { curl -s -o "${BODY}" -w '%{http_code}' -X POST "${ADMIN[@]}" -d "$2" "${BASE}$1"; }
expect() { local got="$1" want="$2" label="$3"; [[ "${got}" == "${want}" ]] || { echo "${label}: expected ${want}, got ${got}: $(cat "${BODY}")" >&2; exit 1; }; }
mode_of() { node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }
has() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],c); process.exit(JSON.stringify(v)===process.argv[3]?0:1)' "${CONFIG}" "$1" "$2"; }

expect "$(patch memory '{"autoRecall":true}')" 200 "a plain memory patch"
grep -q '"memory.autoRecall"' "${BODY}" || { echo "changed paths missing" >&2; exit 1; }
has memory.autoRecall true || { echo "the patch was not written" >&2; exit 1; }
[[ "$(mode_of "${CONFIG}")" == "640" ]] || { echo "the config file's mode was not kept: $(mode_of "${CONFIG}")" >&2; exit 1; }
# The Console sends back what it read: a masked secret must not wipe the stored value.
expect "$(patch channels '{"telegram":{"botToken":{"set":true},"headers":{"X-Custom":{"set":true}},"enabled":false}}')" 200 "masked round trip"
grep -q 'SENTINEL-BOT-TOKEN-7731' "${CONFIG}" && grep -q 'SENTINEL-HEADER-7731' "${CONFIG}" || { echo "a masked round trip wiped a stored secret" >&2; exit 1; }
expect "$(patch nosuchsection '{"a":1}')" 404 "an unknown section"
# Writes need a user id.
expect "$(curl -s -o "${BODY}" -w '%{http_code}' -X PATCH "${AUTH[@]}" "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: admin' -H 'content-type: application/json' -d '{"autoRecall":false}' "${BASE}/admin/config/memory")" 400 "a write without a user id"

# Safe settings: free without the permission.
expect "$(patch channels '{"telegram":{"allowedSenders":["alice","bob"]}}')" 200 "adding a named sender"
expect "$(patch channels '{"telegram":{"tokenFile":"secrets/tg.token"}}')" 200 "a tokenFile under secrets/"
expect "$(patch personas '{"active":"analyst"}')" 200 "choosing a persona"
expect "$(patch agents '{"default":{"contextWindowTokens":96000}}')" 200 "an agent's context window"
# Default deny: everything else needs the permission (#38 review round 1).
while IFS='|' read -r section body label; do
  [[ -n "${section}" ]] || continue
  expect "$(patch "${section}" "${body}")" 403 "${label} without the permission"
done <<'CASES'
channels|{"telegram":{"tokenEnv":"HOME"}}|an env reference
channels|{"telegram":{"apiBaseUrl":"https://attacker.example.test"}}|a connector URL
channels|{"telegram":{"allowedSenders":["*"]}}|a wildcard sender
channels|{"telegram":{"allowedChats":null}}|removing a chat allowlist
channels|{"telegram":{"ownerSenders":["mallory"]}}|who counts as the owner
channels|{"telegram":{"tokenFile":"/etc/passwd"}}|a tokenFile outside secrets/
channels|{"telegram":{"sendPolicy":"open"}}|an unlisted connector setting
memory|{"transcripts":{"includeNonOwner":true}}|indexing non-owner turns
memory|{"embeddingProvider":"openai:text-embedding-3-small"}|a new embedding provider
routing|{"pi":{"builtinTools":["bash"]}}|Pi built-in tools
agents|{"default":{"identityPath":"/etc/passwd"}}|a path setting
personas|{"active":"../x"}|a persona id with a path
workspace|{"root":"/"}|workspace
CASES
grep -q 'attacker\|mallory\|"bash"\|includeNonOwner\|/etc/passwd' "${CONFIG}" && { echo "a refused patch was written" >&2; exit 1; }
expect "$(patch routing '{"mode":"bogus"}')" 422 "an invalid change"
grep -q '"bogus"' "${CONFIG}" && { echo "an invalid patch was written" >&2; exit 1; }
# Malformed patches.
expect "$(patch memory '{"__proto__":{"x":1}}')" 400 "a prototype key"
DEEP="$(node -e 'let s="1"; for (let i = 0; i < 40; i++) s = `{"a":${s}}`; console.log(s)')"
expect "$(patch onboarding "${DEEP}")" 400 "a deeply nested patch"
# If-Match: a stale etag is refused; the current one is accepted.
ETAG="$(curl -s "${AUTH[@]}" "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/config" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).etag))')"
expect "$(patch memory '{"autoRecall":false}' -H 'If-Match: "stale"')" 412 "a stale If-Match"
expect "$(patch memory '{"autoRecall":false}' -H "If-Match: ${ETAG}")" 200 "a current If-Match"

# The advanced permission.
expect "$(post /admin/permissions/advanced '{"enabled":true}')" 400 "granting advanced settings without the confirmation"
expect "$(post /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}')" 200 "granting advanced settings"
expect "$(patch routing '{"pi":{"builtinTools":["read"]}}')" 200 "an advanced patch with the permission"
expect "$(patch gateway '{"auth":{"mode":"none"}}')" 422 "turning gateway auth off, even with the permission"
has gateway.auth.mode '"token"' || { echo "gateway auth was turned off" >&2; exit 1; }
# A patch whose body arrives slowly is judged against the config and permission
# at the time it lands, not when it started: revoking in between wins, and a
# change made in between is kept.
SLOW_DONE="${TEMP_RUNTIME}/slow.code"
BASE="${BASE}" TOKEN="${ADMIN_SMOKE_TOKEN}" ADMIN_TOKEN="${ADMIN_SMOKE_ADMIN_TOKEN}" OUT="${SLOW_DONE}" node <<'NODE' &
const http = require("http");
const body = JSON.stringify({ pi: { builtinTools: ["read", "bash"] } });
const req = http.request(`${process.env.BASE}/admin/config/routing`, { method: "PATCH", headers: {
  authorization: `Bearer ${process.env.TOKEN}`, "x-mindstone-admin-token": process.env.ADMIN_TOKEN,
  "x-mindstone-user-role": "admin", "x-mindstone-user-id": "smoke-admin", "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
  (res) => { res.resume(); res.on("end", () => require("fs").writeFileSync(process.env.OUT, String(res.statusCode))); });
req.write(body.slice(0, 5));
setTimeout(() => req.end(body.slice(5)), 1500);
NODE
slow_pid=$!
sleep 0.5
expect "$(post /admin/permissions/advanced '{"enabled":false}')" 200 "revoking advanced settings mid-request"
expect "$(patch memory '{"autoRecall":true}')" 200 "a change made while another request is in flight"
wait "${slow_pid}"
[[ "$(cat "${SLOW_DONE}")" == "403" ]] || { echo "a slow advanced patch was judged on the permission it started with: $(cat "${SLOW_DONE}")" >&2; exit 1; }
has memory.autoRecall true || { echo "a change made during a slow request was lost" >&2; exit 1; }
grep -q '"bash"' "${CONFIG}" && { echo "the slow advanced patch was written" >&2; exit 1; }

# Secrets: stored 0600 in a 0700 directory, never echoed.
expect "$(post /admin/secrets/tg.token '{"value":"SECRET-VALUE-4412"}')" 200 "storing a secret"
grep -q 'SECRET-VALUE-4412' "${BODY}" && { echo "the secret was echoed back" >&2; exit 1; }
SECRET_FILE="${TEMP_RUNTIME}/mindstone/secrets/tg.token"
[[ "$(cat "${SECRET_FILE}")" == "SECRET-VALUE-4412" ]] || { echo "the secret was not stored" >&2; exit 1; }
[[ "$(mode_of "${SECRET_FILE}")" == "600" ]] || { echo "the secret file is not 0600" >&2; exit 1; }
[[ "$(mode_of "$(dirname "${SECRET_FILE}")")" == "700" ]] || { echo "the secrets directory is not 0700" >&2; exit 1; }
expect "$(post /admin/secrets/..%2Fescape '{"value":"x"}')" 400 "a secret name with a path"
expect "$(post /admin/secrets/%E0%A4%A '{"value":"x"}')" 400 "a secret name with bad encoding"
# Every write and every refusal is audited with the user, and no secret value is in the audit.
AUDIT="${TEMP_RUNTIME}/mindstone/admin/audit.jsonl"
[[ "$(grep -c '"userId":"smoke-admin"' "${AUDIT}")" -ge 5 ]] || { echo "admin writes are not audited with the user id" >&2; cat "${AUDIT}" >&2; exit 1; }
grep -q '"action":"refused".*"reason":"advanced"' "${AUDIT}" || { echo "refused writes are not audited" >&2; exit 1; }
grep -q 'SECRET-VALUE-4412\|SENTINEL' "${AUDIT}" && { echo "a secret value reached the audit log" >&2; exit 1; }
# A non-admin can't write, even holding both credentials.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "${AUTH[@]}" "${ADMIN_TOK[@]}" -H 'x-mindstone-user-role: user' -H 'content-type: application/json' -d '{"autoRecall":false}' "${BASE}/admin/config/memory")" == "403" ]] || { echo "a user-role patch must be 403" >&2; exit 1; }
echo "admin write assertions passed"

echo "Admin API smoke test passed."
