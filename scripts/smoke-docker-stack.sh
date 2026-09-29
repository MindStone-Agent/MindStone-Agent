#!/usr/bin/env bash
# The Docker stack (#171) without Docker: the gateway container's entrypoint
# merges the Console's settings into config.json and keeps everything else, and
# install-stack.sh generates its secrets once, into 600 files, without printing
# them. `docker` and `curl` are stubbed; `docker compose config` checks the
# compose file when Docker is installed.
# Each check is a string that check() evals, so its variables are expanded
# there, not where it is written.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Physical, as the installer prints paths (on macOS the temp folder is under a symlink).
TMP_DIR="$(cd -P "$(mktemp -d)" && pwd -P)"
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
check "the runtime dir exists" '[[ -d "${RT}" ]]'

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
# The stubbed Console database: one "email username role" line per account.
# Like the Console, create-user makes only the first account ADMIN.
export USERS_DB="${TMP_DIR}/users-db" NO_PROMOTE="${TMP_DIR}/no-promote" CALLS
: >"${USERS_DB}"
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
cat >"${STUB}/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"${CALLS}"
arg() { printf '%s' "$*" | sed -n "s/.*$1: '\([^']*\)'.*/\1/p"; }
case "$*" in
  info*) exit 0 ;;
  "compose version --short") echo "2.33.1" ;;
  ps\ *) exit 0 ;;
  *mongosh*"findOne({ email:"*)
    role="$(awk -v e="$(arg email "$*")" '$1 == e { print $3 }' "${USERS_DB}")"
    echo "OK:${role:-none}" ;;
  *mongosh*"countDocuments({})"*) echo "OK:$(wc -l <"${USERS_DB}" | tr -d ' ')" ;;
  *mongosh*"countDocuments({ username:"*) echo "OK:$(awk -v u="$(arg username "$*")" '$2 == u' "${USERS_DB}" | wc -l | tr -d ' ')" ;;
  *mongosh*"updateOne({ email:"*)
    if [[ ! -e "${NO_PROMOTE}" ]]; then
      e="$(arg email "$*")"
      awk -v e="${e}" '$1 == e { $3 = "ADMIN" } { print }' "${USERS_DB}" >"${USERS_DB}.tmp" && mv "${USERS_DB}.tmp" "${USERS_DB}"
    fi
    echo "OK:1" ;;
  *" exec -T console npm run --silent create-user -- "*)
    IFS= read -r password
    [[ ${#password} -ge 8 ]] || { echo "Error: password too short"; exit 1; }
    args="$*"
    set -- ${args##*create-user -- }
    role=USER; [[ -s "${USERS_DB}" ]] || role=ADMIN
    echo "$1 $3 ${role}" >>"${USERS_DB}"
    echo "User created successfully!" ;;
esac
exit 0
EOF
chmod +x "${STUB}/curl" "${STUB}/docker"

# The calling shell's generic variables must not be adopted (#173 review, 5).
run_installer() {
  local dir="$1"
  shift
  PATH="${STUB}:${PATH}" MINDSTONE_REF="" CONSOLE_REF="" CONSOLE_PORT=27990 MINDSTONE_GATEWAY_PORT=27991 \
    COMPOSE_PROJECT_NAME=other-project COMPOSE_PROFILES=ollama OLLAMA_BASE_URL=http://localhost:11434 \
    MINDSTONE_PROJECT=smoketest bash ./install-stack.sh --dir "${dir}" "$@" </dev/null
}
INSTALL="${TMP_DIR}/install"
value() { awk -F= -v k="$2" '$1 == k { sub(/^[^=]*=/, ""); print }' "${INSTALL}/$1"; }
creates() { grep -c "create-user" "${CALLS}" 2>/dev/null || true; }

first_out="$(run_installer "${INSTALL}" --admin-email Owner@Example.com 2>&1)"
check "prints the Console address" '[[ "${first_out}" == *"Open http://localhost:27990"* ]]'
check "prints the password file, not the password" '[[ "${first_out}" == *"${INSTALL}/admin-password"* ]]'
check "install dir is 700 and carries the marker" '[[ "$(mode "${INSTALL}")" == 700 && -f "${INSTALL}/.mindstone-stack" ]]'
for f in .env gateway.env console.env admin-password; do
  check "${f} is 600" '[[ "$(mode "${INSTALL}/${f}")" == 600 ]]'
done
check "console.env has its 6 secrets" '[[ "$(grep -cE "^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+" "${INSTALL}/console.env")" == 6 ]]'
check "one gateway token in both files" '[[ "$(value gateway.env MINDSTONE_AGENT_GATEWAY_TOKEN)" == "$(value console.env MINDSTONE_GATEWAY_TOKEN)" ]]'
check "the gateway gets only the admin digest" '[[ "$(value gateway.env MINDSTONE_ADMIN_TOKEN_SHA256)" == "$(printf %s "$(value console.env MINDSTONE_ADMIN_TOKEN)" | sha)" ]] && ! grep -q "^MINDSTONE_ADMIN_TOKEN=" "${INSTALL}/gateway.env"'
check "the Console reaches the gateway on the stack network" '[[ "$(value console.env MINDSTONE_GATEWAY_URL)" == "http://gateway:19789/v1" ]]'
check ".env names the project and ports" '[[ "$(value .env COMPOSE_PROJECT_NAME)" == smoketest && "$(value .env CONSOLE_PORT)" == 27990 && "$(value .env MINDSTONE_GATEWAY_PORT)" == 27991 ]]'
check "the shell's COMPOSE_PROFILES and OLLAMA_BASE_URL aren't adopted" '! grep -q "^COMPOSE_PROFILES=" "${INSTALL}/.env" && [[ "$(value .env OLLAMA_BASE_URL)" == "http://host.docker.internal:11434/v1" ]]'
check "compose runs without the shell's COMPOSE_* (stub saw the install's project dir)" 'grep -q -- "--project-directory ${INSTALL}" "${CALLS}"'
leaks=0
for key in CREDS_KEY CREDS_IV JWT_SECRET JWT_REFRESH_SECRET MINDSTONE_GATEWAY_TOKEN MINDSTONE_ADMIN_TOKEN; do
  secret="$(value console.env "${key}")"
  [[ "${first_out}" != *"${secret}"* ]] || leaks=$((leaks + 1))
done
[[ "${first_out}" != *"$(head -n 1 "${INSTALL}/admin-password")"* ]] || leaks=$((leaks + 1))
check "no secret in the installer's output (${leaks} found)" '[[ "${leaks}" == 0 ]]'
check "the stack was built and started" 'grep -q "up -d --build --remove-orphans" "${CALLS}"'
check "the admin was created once, lowercased, with its local part as username" '[[ "$(creates)" == 1 ]] && grep -q "create-user -- owner@example.com Admin owner --email-verified=true" "${CALLS}"'

sums_before="$(cat "${INSTALL}/gateway.env" "${INSTALL}/console.env" "${INSTALL}/admin-password" | sha)"
second_out="$(run_installer "${INSTALL}" 2>&1)"
sums_after="$(cat "${INSTALL}/gateway.env" "${INSTALL}/console.env" "${INSTALL}/admin-password" | sha)"
check "a re-run keeps every secret" '[[ "${sums_before}" == "${sums_after}" ]]'
check "a re-run doesn't create the admin again" '[[ "$(creates)" == 1 ]] && [[ "${second_out}" == *"set up by an earlier run"* ]]'

# An earlier install without the marker (before #173's review) is still adopted.
rm "${INSTALL}/.mindstone-stack"
check "an earlier stack install is adopted and marked" 'run_installer "${INSTALL}" >/dev/null 2>&1 && [[ -f "${INSTALL}/.mindstone-stack" ]]'

ollama_out="$(run_installer "${INSTALL}" --with-ollama 2>&1)"
check "--with-ollama turns the profile and in-stack address on" '[[ "$(value .env COMPOSE_PROFILES)" == ollama && "$(value .env OLLAMA_BASE_URL)" == "http://ollama:11434/v1" ]]'
check "--with-ollama says Ollama runs in the stack, and how to switch back" '[[ "${ollama_out}" == *"Ollama runs in the stack"* && "${ollama_out}" == *"--without-ollama"* && "${ollama_out}" != *"Ollama on this machine is reached"* ]]'
check "switching tells to change the provider address in Settings" '[[ "${ollama_out}" == *"change the Ollama provider"* ]]'
back_out="$(run_installer "${INSTALL}" --without-ollama 2>&1)"
check "--without-ollama goes back" '! grep -q "^COMPOSE_PROFILES=" "${INSTALL}/.env" && [[ "$(value .env OLLAMA_BASE_URL)" == "http://host.docker.internal:11434/v1" && "${back_out}" == *"Ollama is reached by the gateway as http://host.docker.internal"* ]]'
check "--without-ollama stops the in-stack Ollama" 'grep -q "rm --stop --force ollama" "${CALLS}"'
warn_out="$(run_installer "${INSTALL}" --ollama-url http://localhost:11434 2>&1)"
check "a loopback Ollama address and a missing /v1 are warned about" '[[ "${warn_out}" == *"is the container itself"* && "${warn_out}" == *"should end in /v1"* ]]'
run_installer "${INSTALL}" --without-ollama >/dev/null 2>&1

uninstall_out="$(PATH="${STUB}:${PATH}" bash ./install-stack.sh --dir "${INSTALL}" --uninstall 2>&1)"
check "uninstall stops the stack and keeps volumes" 'tail -n 1 "${CALLS}" | grep -q " down --remove-orphans$"'
check "uninstall never prints down -v or rm -rf of the folder" '[[ "${uninstall_out}" != *"down -v"* && "${uninstall_out}" != *"rm -rf \"${INSTALL}\""* ]]'
check "uninstall names only this project's volumes" '[[ "${uninstall_out}" == *"docker volume rm smoketest_gateway-runtime smoketest_pi-agent smoketest_pi-sessions smoketest_console-data"* ]]'
check "uninstall keeps the files" '[[ -f "${INSTALL}/console.env" && -d "${INSTALL}/data/mongo" ]]'
# The printed delete removes the installer's files and leaves a file of the user's.
touch "${INSTALL}/compose.override.yml" "${INSTALL}/compose.yml.bak.20260101000000"
delete_line="$(grep -E '^  cd ".*" && rm -rf data' <<<"${uninstall_out}")"
(eval "${delete_line}") 2>/dev/null || true
check "the printed delete removes only what the installer made" '[[ -d "${INSTALL}" && "$(ls -A "${INSTALL}")" == "compose.override.yml" ]]'

echo "== --dir refusals =="
FAKE_HOME="${TMP_DIR}/home/me"
mkdir -p "${FAKE_HOME}"
refuse() { HOME="${FAKE_HOME}" run_installer "$1" --admin-email owner@example.com 2>&1; }
OTHER="${TMP_DIR}/project"
mkdir -p "${OTHER}"
printf 'console.log(1)\n' >"${OTHER}/app.js"
printf 'PROJECT_SETTING=1\n' >"${OTHER}/.env"
chmod 755 "${OTHER}"
calls_before="$(wc -l <"${CALLS}")"
out="$(refuse "${OTHER}" || true)"
check "a folder with other files is refused" '[[ "${out}" == *"isn'"'"'t empty and isn'"'"'t a MindStone stack install"* ]]'
check "a refused folder is left exactly as it was" '[[ "$(cat "${OTHER}/.env")" == "PROJECT_SETTING=1" && "$(mode "${OTHER}")" == 755 && ! -e "${OTHER}/.mindstone-stack" ]]'
out="$(refuse "${FAKE_HOME}" || true)"
check "the home folder is refused" '[[ "${out}" == *"Refusing to install"* ]]'
out="$(refuse "${TMP_DIR}/home" || true)"
check "a folder that contains the home folder is refused" '[[ "${out}" == *"Refusing to install"* ]]'
out="$(refuse / || true)"
check "the root is refused" '[[ "${out}" == *"Refusing to install"* ]]'
# A symlink as the folder: refused whatever it points at (#173 review, round 2).
ln -s "${OTHER}" "${TMP_DIR}/link-to-project"
out="$(refuse "${TMP_DIR}/link-to-project" || true)"
check "a symlink to a full folder is refused" '[[ "${out}" == *"is a symbolic link"* ]]'
check "the folder behind it is left exactly as it was" '[[ "$(cat "${OTHER}/.env")" == "PROJECT_SETTING=1" && "$(mode "${OTHER}")" == 755 && ! -e "${OTHER}/.mindstone-stack" ]]'
mkdir -p "${TMP_DIR}/empty-target"
ln -s "${TMP_DIR}/empty-target" "${TMP_DIR}/link-to-empty"
out="$(refuse "${TMP_DIR}/link-to-empty/" || true)"
check "a symlink to an empty folder (with a trailing slash) is refused too" '[[ "${out}" == *"is a symbolic link"* && -z "$(ls -A "${TMP_DIR}/empty-target")" ]]'
# ".." after a folder that doesn't exist yet resolves to where mkdir -p would land.
printf 'HOME_SETTING=1\n' >"${FAKE_HOME}/.env"
out="$(refuse "${FAKE_HOME}/newdir/.." || true)"
check "HOME/newdir/.. is refused as the home folder" '[[ "${out}" == *"Refusing to install"* ]]'
check "and nothing was created or changed" '[[ ! -e "${FAKE_HOME}/newdir" && "$(cat "${FAKE_HOME}/.env")" == "HOME_SETTING=1" && ! -e "${FAKE_HOME}/.mindstone-stack" ]]'
out="$(refuse "${OTHER}/new/../" || true)"
check "a full folder reached through .. is refused" '[[ "${out}" == *"isn'"'"'t empty"* && ! -e "${OTHER}/new" ]]'
check "nothing ran for any refused folder" '[[ "$(wc -l <"${CALLS}")" == "${calls_before}" ]]'
# A symlink earlier in the path (as /tmp is on macOS) is followed: the install
# goes to the physical folder, and every check ran on that path.
mkdir -p "${TMP_DIR}/real-parent"
ln -s "${TMP_DIR}/real-parent" "${TMP_DIR}/linked-parent"
out="$(run_installer "${TMP_DIR}/linked-parent/stack" 2>&1)"
real_parent="$(cd -P "${TMP_DIR}/real-parent" && pwd -P)"
check "a symlinked parent is followed to the physical folder" '[[ -f "${real_parent}/stack/.mindstone-stack" && "${out}" == *"Install dir:        ${real_parent}/stack"* ]]'
mkdir -p "${TMP_DIR}/empty"
check "an empty folder is adopted" 'run_installer "${TMP_DIR}/empty" >/dev/null 2>&1 && [[ -f "${TMP_DIR}/empty/.mindstone-stack" ]]'

echo "== admin account =="
fresh() { rm -rf "${TMP_DIR}/a"; mkdir -p "${TMP_DIR}/a"; }
fresh
out="$(run_installer "${TMP_DIR}/a" --admin-email owner@example.com --admin-name Al 2>&1 || true)"
check "a name under 3 characters is refused before the build" '[[ "${out}" == *"3 to 80 characters"* && "${out}" != *"Building"* ]]'
fresh
out="$(run_installer "${TMP_DIR}/a" --admin-email "o'\''x@example.com" 2>&1 || true)"
check "an email with a quote is refused" '[[ "${out}" == *"is not an email address"* ]]'
fresh
run_installer "${TMP_DIR}/a" --admin-email a@example.com >/dev/null 2>&1 || true
check "a one-letter local part gets a longer username" 'grep -qE "create-user -- a@example.com Admin a_[0-9a-f]{4} --email-verified=true" "${CALLS}"'
fresh; : >"${USERS_DB}"
printf 'owner@home.example owner ADMIN\n' >"${USERS_DB}"
out="$(run_installer "${TMP_DIR}/a" --admin-email owner@work.example 2>&1 || true)"
check "a taken username gets a longer one" 'grep -qE "create-user -- owner@work.example Admin owner_[0-9a-f]{4} --email-verified=true" "${CALLS}" && [[ "${out}" == *"(username owner_"* ]]'
check "with other accounts, the new one is made ADMIN and it says so" 'grep -q "^owner@work.example owner_.* ADMIN$" "${USERS_DB}" && [[ "${out}" == *"already had 1 account(s)"* && "${out}" == *"role ADMIN"* ]]'
fresh; : >"${USERS_DB}"
run_installer "${TMP_DIR}/a" --admin-email first@example.com >/dev/null 2>&1 || true
check "the first account is ADMIN without a promotion" 'grep -q "^first@example.com first ADMIN$" "${USERS_DB}" && ! tail -n 3 "${CALLS}" | grep -q updateOne'
fresh; printf 'someone@example.com someone ADMIN\n' >"${USERS_DB}"; touch "${NO_PROMOTE}"
out="$(run_installer "${TMP_DIR}/a" --admin-email second@example.com 2>&1 || true)"
rm -f "${NO_PROMOTE}"
check "an account that doesn't end up ADMIN fails, with the command to promote it" '[[ "${out}" == *"its role is USER, not ADMIN"* && "${out}" == *"updateOne({ email: '"'"'second@example.com'"'"' }"* && ! -e "${TMP_DIR}/a/.admin-created" ]]'
fresh; printf 'owner@example.com owner USER\n' >"${USERS_DB}"
creates_before="$(creates)"
out="$(run_installer "${TMP_DIR}/a" --admin-email owner@example.com 2>&1 || true)"
check "an existing email: its own status, no account created" '[[ "$(creates)" == "${creates_before}" && "${out}" == *"already exists in this Console as a"* && "${out}" != *"The password is in"* ]]'
check "an existing regular user: the message gives the promote command" '[[ "${out}" == *"regular user (role USER)"* && "${out}" == *"\$set: { role: '"'"'ADMIN'"'"' }"* ]]'
check "an existing email: no password file is claimed or made, and no marker" '[[ ! -e "${TMP_DIR}/a/admin-password" && ! -e "${TMP_DIR}/a/.admin-created" ]]'
out="$(run_installer "${TMP_DIR}/a" --admin-email other@example.com 2>&1 || true)"
check "after that, another --admin-email creates an admin" 'grep -q "^other@example.com other ADMIN$" "${USERS_DB}" && [[ "${out}" == *"Admin account created: other@example.com"* ]]'
fresh; printf 'boss@example.com boss ADMIN\n' >"${USERS_DB}"
out="$(run_installer "${TMP_DIR}/a" --admin-email boss@example.com 2>&1 || true)"
check "an existing admin: says so, nothing created" '[[ "${out}" == *"An admin account with the email boss@example.com already exists"* ]]'
: >"${USERS_DB}"
for bad in .lead@example.com trail.@example.com two..dots@example.com pct%x@example.com; do
  fresh
  out="$(run_installer "${TMP_DIR}/a" --admin-email "${bad}" 2>&1 || true)"
  check "the Console's email rules: ${bad} is refused before the build" '[[ "${out}" == *"is not an email address"* && "${out}" != *"Building"* ]]'
done

echo "== ports and truncation =="
fresh
node -e 'require("net").createServer().listen(27993, "127.0.0.1", () => setTimeout(() => process.exit(0), 20000))' &
listener=$!
disown "${listener}" 2>/dev/null || true
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/27993) 2>/dev/null && break; sleep 0.1; done
out="$(CONSOLE_PORT=27993 PATH="${STUB}:${PATH}" MINDSTONE_GATEWAY_PORT=27991 bash ./install-stack.sh --dir "${TMP_DIR}/a" 2>&1 || true)"
kill "${listener}" 2>/dev/null || true
check "a taken port stops the install with its name" '[[ "${out}" == *"Port 27993 on 127.0.0.1 is already in use (CONSOLE_PORT)"* && "${out}" != *"Building"* ]]'
head -n "$(( $(wc -l <install-stack.sh) - 1 ))" install-stack.sh >"${TMP_DIR}/truncated.sh"
PATH="${STUB}:${PATH}" bash "${TMP_DIR}/truncated.sh" --dir "${TMP_DIR}/cut" --admin-email owner@example.com >/dev/null 2>&1 || true
check "a download cut before its last line runs nothing" '[[ ! -e "${TMP_DIR}/cut" ]]'

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "== compose file =="
  CFG_DIR="${TMP_DIR}/cfg"
  mkdir -p "${CFG_DIR}"
  touch "${CFG_DIR}/gateway.env" "${CFG_DIR}/console.env"
  cfg="$(docker compose --project-directory "${CFG_DIR}" -f "${ROOT}/deploy/docker/compose.yml" --profile ollama config 2>&1)"
  check "compose file is valid" '[[ "${cfg}" == *"services:"* ]]'
  check "only loopback ports are published" '[[ "$(grep -c "host_ip: 127.0.0.1" <<<"${cfg}")" == 2 && "$(grep -c "published:" <<<"${cfg}")" == 2 ]]'
  check "the gateway declares docker as its supervisor" 'grep -q "MINDSTONE_AGENT_SUPERVISOR: docker" <<<"${cfg}"'
  nets="$(docker compose --project-directory "${CFG_DIR}" -f "${ROOT}/deploy/docker/compose.yml" --profile ollama config --format json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log(Object.entries(c.services).map(([k,v])=>k+":"+Object.keys(v.networks||{}).sort().join(",")).sort().join(" "))})')"
  check "MongoDB shares a network with the Console only (${nets})" '[[ "${nets}" == "console:app,db gateway:app mongodb:db ollama:app" ]]'
fi

echo "Docker stack smoke passed."
