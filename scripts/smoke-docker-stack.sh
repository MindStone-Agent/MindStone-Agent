#!/usr/bin/env bash
# The Docker stack (#171) without Docker: the gateway container's entrypoint
# merges the Console's settings into config.json and keeps everything else, and
# install-stack.sh generates its secrets once, into 600 files, without printing
# them. `docker` and `curl` are stubbed; `docker compose config` checks the
# compose file when Docker is installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
cd "${ROOT}"

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
check() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1" >&2; exit 1; fi; }

echo "== entrypoint: Console settings merged into config.json =="
RT="${TMP_DIR}/runtime"
GW_TOKEN="$(openssl rand -hex 32)"
ADMIN_CRED="$(openssl rand -hex 32)"
ADMIN_SHA="$(printf %s "${ADMIN_CRED}" | sha)"
entry() {
  MINDSTONE_AGENT_RUNTIME_DIR="${RT}" MINDSTONE_AGENT_DATA_DIR="${RT}/data" MINDSTONE_AGENT_CONFIG="" \
    MINDSTONE_AGENT_GATEWAY_TOKEN="${1}" MINDSTONE_ADMIN_TOKEN_SHA256="${2}" \
    ./scripts/docker-gateway-entrypoint.sh bash -c 'printf "%s" "${MINDSTONE_AGENT_GATEWAY_TOKEN:-unset}"'
}
out="$(entry "${GW_TOKEN}" "${ADMIN_SHA}")"
CONFIG="${RT}/data/config.json"
check "the token variable isn't passed on" '[[ "${out}" == *unset ]]'
check "the token isn't printed" '[[ "${out}" != *"${GW_TOKEN}"* ]]'
node -e '
const assert = require("assert");
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
assert.deepEqual(c.gateway.auth, { mode: "token", tokenFile: "secrets/gateway-token" });
assert.equal(c.gateway.http.chatCompletions.enabled, true);
assert.equal(c.gateway.http.responses.enabled, false, "other http settings kept");
assert.equal(c.gateway.admin.tokenSha256, process.argv[2]);
assert.equal(c.routing.mode, "placeholder", "routing untouched");
' "${CONFIG}" "${ADMIN_SHA}"
echo "ok: auth, chat completions and admin digest set; routing untouched"
check "token file holds the token" '[[ "$(cat "${RT}/data/secrets/gateway-token")" == "${GW_TOKEN}" ]]'
check "token file is 600" '[[ "$(mode "${RT}/data/secrets/gateway-token")" == 600 ]]'

# An onboarded config keeps its routing and everything else on the next start.
node -e '
const fs = require("fs"); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f, "utf8"));
c.routing = { mode: "pi-session", defaultAgentId: "default", pi: { model: "ollama/some-model" } };
c.memory.embeddingProvider = "ollama:nomic-embed-text";
c.gateway.admin.note = "kept";
fs.writeFileSync(f, JSON.stringify(c, null, 2));
' "${CONFIG}"
before_routing="$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).routing))' "${CONFIG}")"
entry "${GW_TOKEN}" "${ADMIN_SHA}" >/dev/null
node -e '
const assert = require("assert");
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
assert.equal(JSON.stringify(c.routing), process.argv[2]);
assert.equal(c.memory.embeddingProvider, "ollama:nomic-embed-text");
assert.equal(c.gateway.admin.note, "kept");
' "${CONFIG}" "${before_routing}"
echo "ok: a restart keeps routing, memory and other settings"

cp "${CONFIG}" "${TMP_DIR}/config.before"
check "no token: refused" '! entry "" "${ADMIN_SHA}" >/dev/null 2>&1'
check "digest of the token itself: refused" '! entry "${GW_TOKEN}" "$(printf %s "${GW_TOKEN}" | sha)" >/dev/null 2>&1'
check "digest of an empty credential: refused" '! entry "${GW_TOKEN}" "$(printf "" | sha)" >/dev/null 2>&1'
printf '{ not json' >"${CONFIG}"
check "unreadable config: refused" '! entry "${GW_TOKEN}" "${ADMIN_SHA}" >/dev/null 2>&1'
check "unreadable config: left unchanged" '[[ "$(cat "${CONFIG}")" == "{ not json" ]]'

echo "== install-stack.sh with docker and curl stubbed =="
STUB="${TMP_DIR}/bin"
mkdir -p "${STUB}"
CALLS="${TMP_DIR}/docker-calls"
FIXTURES="${TMP_DIR}/fixtures"
mkdir -p "${FIXTURES}"
cat >"${FIXTURES}/env.example" <<'EOF'
APP_TITLE=MindStone Console
CREDS_KEY=
CREDS_IV=
JWT_SECRET=
JWT_REFRESH_SECRET=
MINDSTONE_GATEWAY_URL=http://host.docker.internal:19789/v1
MINDSTONE_GATEWAY_TOKEN=
MINDSTONE_ADMIN_TOKEN=
ALLOW_REGISTRATION=false
EOF
printf 'version: 1.2.8\n' >"${FIXTURES}/librechat.yaml"
cat >"${STUB}/curl" <<EOF
#!/usr/bin/env bash
# Downloads come from fixtures; health checks answer.
out=""; url=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in -o) out="\$2"; shift 2 ;; --retry|--max-time) shift 2 ;; -*) shift ;; *) url="\$1"; shift ;; esac
done
case "\${url}" in
  */deploy/docker/compose.yml) cp "${ROOT}/deploy/docker/compose.yml" "\${out}" ;;
  */mindstone/librechat.yaml) cp "${FIXTURES}/librechat.yaml" "\${out}" ;;
  */mindstone/.env.example) cp "${FIXTURES}/env.example" "\${out}" ;;
  http://127.0.0.1:*) exit 0 ;;
  *) exit 22 ;;
esac
EOF
cat >"${STUB}/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"${CALLS}"
case "\$*" in
  info*) exit 0 ;;
  "compose version --short") echo "2.33.1" ;;
  *" exec -T console npm run --silent create-user -- "*)
    IFS= read -r password
    [[ \${#password} -ge 8 ]] || { echo "Error: password too short"; exit 1; }
    echo "User created successfully!" ;;
esac
exit 0
EOF
chmod +x "${STUB}/curl" "${STUB}/docker"

INSTALL="${TMP_DIR}/install"
run_installer() {
  PATH="${STUB}:${PATH}" MINDSTONE_REF="" CONSOLE_REF="" CONSOLE_PORT=27990 MINDSTONE_GATEWAY_PORT=27991 \
    MINDSTONE_PROJECT=smoketest bash ./install-stack.sh --dir "${INSTALL}" "$@" </dev/null
}
first_out="$(run_installer --admin-email owner@example.com 2>&1)"
check "prints the Console address" '[[ "${first_out}" == *"Open http://localhost:27990"* ]]'
check "prints the password file, not the password" '[[ "${first_out}" == *"${INSTALL}/admin-password"* ]]'
check "install dir is 700" '[[ "$(mode "${INSTALL}")" == 700 ]]'
for f in .env gateway.env console.env admin-password; do
  check "${f} is 600" '[[ "$(mode "${INSTALL}/${f}")" == 600 ]]'
done
check "console.env has its 6 secrets" '[[ "$(grep -cE "^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+" "${INSTALL}/console.env")" == 6 ]]'
value() { awk -F= -v k="$2" '$1 == k { sub(/^[^=]*=/, ""); print }' "${INSTALL}/$1"; }
check "one gateway token in both files" '[[ "$(value gateway.env MINDSTONE_AGENT_GATEWAY_TOKEN)" == "$(value console.env MINDSTONE_GATEWAY_TOKEN)" ]]'
check "the gateway gets only the admin digest" '[[ "$(value gateway.env MINDSTONE_ADMIN_TOKEN_SHA256)" == "$(printf %s "$(value console.env MINDSTONE_ADMIN_TOKEN)" | sha)" ]] && ! grep -q "^MINDSTONE_ADMIN_TOKEN=" "${INSTALL}/gateway.env"'
check "the Console reaches the gateway on the stack network" '[[ "$(value console.env MINDSTONE_GATEWAY_URL)" == "http://gateway:19789/v1" ]]'
check ".env names the project and ports" '[[ "$(value .env COMPOSE_PROJECT_NAME)" == smoketest && "$(value .env CONSOLE_PORT)" == 27990 && "$(value .env MINDSTONE_GATEWAY_PORT)" == 27991 ]]'
leaks=0
for key in CREDS_KEY CREDS_IV JWT_SECRET JWT_REFRESH_SECRET MINDSTONE_GATEWAY_TOKEN MINDSTONE_ADMIN_TOKEN; do
  secret="$(value console.env "${key}")"
  [[ "${first_out}" != *"${secret}"* ]] || leaks=$((leaks + 1))
done
[[ "${first_out}" != *"$(head -n 1 "${INSTALL}/admin-password")"* ]] || leaks=$((leaks + 1))
check "no secret in the installer's output (${leaks} found)" '[[ "${leaks}" == 0 ]]'
check "the stack was built and started" 'grep -q "up -d --build --remove-orphans" "${CALLS}"'
check "the admin was created once" '[[ "$(grep -c "create-user" "${CALLS}")" == 1 ]]'

sums_before="$(cat "${INSTALL}/gateway.env" "${INSTALL}/console.env" "${INSTALL}/admin-password" | sha)"
second_out="$(run_installer 2>&1)"
sums_after="$(cat "${INSTALL}/gateway.env" "${INSTALL}/console.env" "${INSTALL}/admin-password" | sha)"
check "a re-run keeps every secret" '[[ "${sums_before}" == "${sums_after}" ]]'
check "a re-run doesn't create the admin again" '[[ "$(grep -c "create-user" "${CALLS}")" == 1 ]] && [[ "${second_out}" == *"already created"* ]]'

uninstall_out="$(PATH="${STUB}:${PATH}" bash ./install-stack.sh --dir "${INSTALL}" --uninstall 2>&1)"
check "uninstall stops the stack and keeps volumes" 'tail -n 1 "${CALLS}" | grep -q " down --remove-orphans$"'
check "uninstall says how to delete the data" '[[ "${uninstall_out}" == *"down -v"* ]]'
check "uninstall keeps the files" '[[ -f "${INSTALL}/console.env" && -d "${INSTALL}/data/mongo" ]]'

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "== compose file =="
  cfg="$(docker compose --project-directory "${INSTALL}" -f "${ROOT}/deploy/docker/compose.yml" config 2>&1)"
  check "compose file is valid" '[[ "${cfg}" == *"services:"* ]]'
  check "only loopback ports are published" '[[ "$(grep -c "host_ip: 127.0.0.1" <<<"${cfg}")" == 2 && "$(grep -c "published:" <<<"${cfg}")" == 2 ]]'
  check "the gateway declares docker as its supervisor" 'grep -q "MINDSTONE_AGENT_SUPERVISOR: docker" <<<"${cfg}"'
fi

echo "Docker stack smoke passed."
