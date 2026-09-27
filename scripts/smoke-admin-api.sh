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
echo "Admin API smoke test passed."
