#!/usr/bin/env bash
# Admin API smoke (#38, P2 read side): the Console's server-to-server admin endpoints.
#   - absent (404) when gateway auth is "none", even with the admin role
#   - 401 without the service token, 403 without the admin role
#   - /admin/config masks every secret value; secret references (tokenEnv…) stay
#   - /admin/status reports onboarding: false until a provider and a persona exist
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
cd "${PROJECT_ROOT}"
echo "== Admin API smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-admin-init.log
CONFIG="${TEMP_RUNTIME}/mindstone/config.json"
BASE="http://127.0.0.1:${GATEWAY_PORT}"

configure() {
  AUTH_MODE="$1" ROUTING="$2" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
mode = os.environ["AUTH_MODE"]
c.setdefault("gateway", {})["auth"] = {"mode": "none"} if mode == "none" else {"mode": "token", "tokenEnv": "ADMIN_SMOKE_TOKEN"}
c["routing"] = {"mode": os.environ["ROUTING"], "defaultAgentId": "default", "defaultModel": "mindstone/mock"}
c.setdefault("memory", {})["embedding"] = {"apiKey": "SENTINEL-APIKEY-7731", "model": "x"}
c["channels"] = {"telegram": {"enabled": False, "botToken": "SENTINEL-BOT-TOKEN-7731", "tokenEnv": "TELEGRAM_TOKEN_ENV_NAME"}}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
}
start_gateway() {
  ./scripts/start-gateway.sh >>/tmp/mindstone-agent-admin-gateway.log 2>&1 &
  gateway_pid=$!
  for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# 1. Auth "none": the admin API does not exist, admin role or not.
configure none mock
start_gateway
test "$(code -H 'x-mindstone-user-role: admin' "${BASE}/admin/status")" = "404" || { echo "admin API reachable with auth none" >&2; exit 1; }
test "$(code -H 'x-mindstone-user-role: admin' "${BASE}/admin/config")" = "404" || { echo "admin config reachable with auth none" >&2; exit 1; }
stop_gateway

# 2. Token auth.
configure token placeholder
start_gateway
AUTH=(-H "Authorization: Bearer ${ADMIN_SMOKE_TOKEN}")
test "$(code -H 'x-mindstone-user-role: admin' "${BASE}/admin/status")" = "401" || { echo "admin API without the token must be 401" >&2; exit 1; }
test "$(code "${AUTH[@]}" "${BASE}/admin/status")" = "403" || { echo "admin API without a role must be 403" >&2; exit 1; }
test "$(code "${AUTH[@]}" -H 'x-mindstone-user-role: user' "${BASE}/admin/status")" = "403" || { echo "admin API as role user must be 403" >&2; exit 1; }

STATUS="$(curl -s "${AUTH[@]}" -H 'x-mindstone-user-role: Admin' "${BASE}/admin/status")"
CONF="$(curl -s "${AUTH[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/config")"
STATUS="${STATUS}" CONF="${CONF}" node <<'NODE'
const fail = (m) => { console.error(m); process.exit(1); };
const status = JSON.parse(process.env.STATUS);
const conf = JSON.parse(process.env.CONF);
if (status.onboarded !== false || status.steps?.provider?.done !== false) fail(`placeholder routing must not count as onboarded: ${JSON.stringify(status.steps)}`);
for (const [label, text] of [["status", process.env.STATUS], ["config", process.env.CONF]]) {
  for (const secret of ["SENTINEL-APIKEY-7731", "SENTINEL-BOT-TOKEN-7731", "admin-smoke-service-token"]) {
    if (text.includes(secret)) fail(`${label} leaked ${secret}`);
  }
}
if (conf.config?.memory?.embedding?.apiKey?.set !== true) fail(`apiKey should be masked to {set:true}: ${JSON.stringify(conf.config?.memory?.embedding)}`);
if (conf.config?.channels?.telegram?.botToken?.set !== true) fail("botToken should be masked to {set:true}");
if (conf.config?.channels?.telegram?.tokenEnv !== "TELEGRAM_TOKEN_ENV_NAME") fail("a secret reference (tokenEnv) should stay visible");
if (conf.config?.gateway?.auth?.tokenEnv !== "ADMIN_SMOKE_TOKEN") fail("gateway.auth.tokenEnv should stay visible");
console.log("admin read assertions passed");
NODE
stop_gateway

# 3. A provider and a persona make it onboarded.
configure token mock
start_gateway
curl -s "${AUTH[@]}" -H 'x-mindstone-user-role: admin' "${BASE}/admin/status" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const status = JSON.parse(s);
  if (status.onboarded !== true) { console.error(`mock routing plus the default persona should be onboarded: ${JSON.stringify(status.steps)}`); process.exit(1); }
  console.log("onboarding assertions passed");
});'
# 4. Write side: section patches, masked-secret round trip, advanced permission, secrets.
ADMIN=(-H "Authorization: Bearer ${ADMIN_SMOKE_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
patch() { curl -s -o /tmp/mindstone-agent-admin-body.json -w '%{http_code}' -X PATCH "${ADMIN[@]}" -d "$2" "${BASE}/admin/config/$1"; }
post() { curl -s -o /tmp/mindstone-agent-admin-body.json -w '%{http_code}' -X POST "${ADMIN[@]}" -d "$2" "${BASE}$1"; }
expect() { local got="$1" want="$2" label="$3"; [[ "${got}" == "${want}" ]] || { echo "${label}: expected ${want}, got ${got}: $(cat /tmp/mindstone-agent-admin-body.json)" >&2; exit 1; }; }

expect "$(patch memory '{"autoRecall":true}')" 200 "a plain memory patch"
grep -q '"memory.autoRecall"' /tmp/mindstone-agent-admin-body.json || { echo "changed paths missing" >&2; exit 1; }
node -e 'const c=require(process.argv[1]); if (c.memory.autoRecall!==true) process.exit(1)' "${CONFIG}" || { echo "the patch was not written" >&2; exit 1; }
# The Console sends back what it read: a masked secret must not wipe the stored value.
expect "$(patch channels '{"telegram":{"botToken":{"set":true},"enabled":false}}')" 200 "masked round trip"
grep -q 'SENTINEL-BOT-TOKEN-7731' "${CONFIG}" || { echo "a masked round trip wiped the stored secret" >&2; exit 1; }
expect "$(patch nosuchsection '{"a":1}')" 404 "an unknown section"
expect "$(patch routing '{"pi":{"builtinTools":["bash"]}}')" 403 "Pi built-in tools without the permission"
expect "$(patch agents '{"default":{"identityPath":"/etc/passwd"}}')" 403 "a path setting without the permission"
expect "$(patch workspace '{"root":"/"}')" 403 "workspace without the permission"
grep -q 'bash' "${CONFIG}" && { echo "a refused patch was written" >&2; exit 1; }
expect "$(patch routing '{"mode":"bogus"}')" 422 "an invalid change"
grep -q '"bogus"' "${CONFIG}" && { echo "an invalid patch was written" >&2; exit 1; }
expect "$(post /admin/permissions/advanced '{"enabled":true}')" 400 "granting advanced settings without the confirmation"
expect "$(post /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}')" 200 "granting advanced settings"
expect "$(patch routing '{"pi":{"builtinTools":["read"]}}')" 200 "an advanced patch with the permission"
expect "$(post /admin/permissions/advanced '{"enabled":false}')" 200 "revoking advanced settings"
expect "$(patch routing '{"pi":{"builtinTools":["read","bash"]}}')" 403 "an advanced patch after revoking"
# Secrets: stored 0600, never echoed.
expect "$(post /admin/secrets/tg.token '{"value":"SECRET-VALUE-4412"}')" 200 "storing a secret"
grep -q 'SECRET-VALUE-4412' /tmp/mindstone-agent-admin-body.json && { echo "the secret was echoed back" >&2; exit 1; }
SECRET_FILE="${TEMP_RUNTIME}/mindstone/secrets/tg.token"
[[ "$(cat "${SECRET_FILE}")" == "SECRET-VALUE-4412" ]] || { echo "the secret was not stored" >&2; exit 1; }
[[ "$(stat -f '%Lp' "${SECRET_FILE}" 2>/dev/null || stat -c '%a' "${SECRET_FILE}")" == "600" ]] || { echo "the secret file is not 0600" >&2; exit 1; }
expect "$(post /admin/secrets/..%2Fescape '{"value":"x"}')" 400 "a secret name with a path"
# Every write is audited with the user, and no secret value is in the audit.
AUDIT="${TEMP_RUNTIME}/mindstone/admin/audit.jsonl"
[[ "$(grep -c '"userId":"smoke-admin"' "${AUDIT}")" -ge 5 ]] || { echo "admin writes are not audited with the user id" >&2; cat "${AUDIT}" >&2; exit 1; }
grep -q 'SECRET-VALUE-4412\|SENTINEL' "${AUDIT}" && { echo "a secret value reached the audit log" >&2; exit 1; }
# A non-admin can't write.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer ${ADMIN_SMOKE_TOKEN}" -H 'x-mindstone-user-role: user' -H 'content-type: application/json' -d '{"autoRecall":false}' "${BASE}/admin/config/memory")" == "403" ]] || { echo "a user-role patch must be 403" >&2; exit 1; }
echo "admin write assertions passed"

echo "Admin API smoke test passed."
