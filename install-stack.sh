#!/usr/bin/env bash
# MindStone, the whole stack in Docker (#171): the MindStone-Agent gateway, the
# MindStone Console and MongoDB, set up and started with one command.
#
#   curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.sh | bash
#
# Re-running it updates the stack. Secrets are generated once, into 600 files,
# and never printed; existing secrets and data are never replaced.
set -euo pipefail

RAW_MSA="https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent"
RAW_CONSOLE="https://raw.githubusercontent.com/MindStone-Agent/mindstone-console"
INSTALL_URL="${RAW_MSA}/main/install-stack.sh"

INSTALL_DIR="${MINDSTONE_DIR:-${HOME}/.mindstone}"
# Settings from flags, then the environment, then the install's .env, then defaults.
ARG_REF=""
ARG_CONSOLE_REF=""
ADMIN_EMAIL=""
ADMIN_NAME=""
WITH_OLLAMA=0
UNINSTALL=0

usage() {
  cat <<'USAGE'
MindStone stack installer: the MindStone-Agent gateway, the MindStone Console and
MongoDB in Docker.

Usage:
  install-stack.sh [options]

Options:
  --dir PATH            Install directory. Default: ~/.mindstone
  --ref REF             MindStone-Agent git ref to install. Default: main
  --console-ref REF     MindStone Console git ref to install. Default: main
  --admin-email EMAIL   Create the Console admin without prompts: the password is
                        generated into <dir>/admin-password (mode 600), never printed
  --admin-name NAME     The admin's display name. Default: Admin
  --with-ollama         Also run Ollama in a container (for Linux, or no Ollama on this machine)
  --uninstall           Stop and remove the stack's containers. Data is kept
  --help                Show this help

Environment:
  MINDSTONE_DIR, MINDSTONE_REF, CONSOLE_REF
  CONSOLE_PORT            the Console's port on 127.0.0.1. Default: 3080
  MINDSTONE_GATEWAY_PORT  the gateway's port on 127.0.0.1. Default: 19789
  MINDSTONE_PROJECT       the Docker Compose project name. Default: mindstone
  OLLAMA_BASE_URL         Ollama as the gateway container sees it.
                          Default: http://host.docker.internal:11434/v1

Pass options after `bash -s --`:
  curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.sh | \
    bash -s -- --admin-email you@example.com
USAGE
}

log() { printf '\033[38;5;214m[MindStone]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31m[MindStone install error]\033[0m %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) [[ $# -ge 2 ]] || fail "--dir needs a path"; INSTALL_DIR="$2"; shift 2 ;;
    --ref) [[ $# -ge 2 ]] || fail "--ref needs a git ref"; ARG_REF="$2"; shift 2 ;;
    --console-ref) [[ $# -ge 2 ]] || fail "--console-ref needs a git ref"; ARG_CONSOLE_REF="$2"; shift 2 ;;
    --admin-email) [[ $# -ge 2 ]] || fail "--admin-email needs an address"; ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-name) [[ $# -ge 2 ]] || fail "--admin-name needs a name"; ADMIN_NAME="$2"; shift 2 ;;
    --with-ollama) WITH_OLLAMA=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

# A literal ~ (from a quoted --dir) means the home folder.
# shellcheck disable=SC2088
case "${INSTALL_DIR}" in
  "~" | "~/"*) INSTALL_DIR="${HOME}${INSTALL_DIR:1}" ;;
esac
[[ "${INSTALL_DIR}" == /* ]] || INSTALL_DIR="${PWD}/${INSTALL_DIR}"
ENV_FILE="${INSTALL_DIR}/.env"
# How to name this install again in the commands printed at the end.
DIR_FLAG=""
[[ "${INSTALL_DIR}" == "${HOME}/.mindstone" ]] || DIR_FLAG=" --dir \"${INSTALL_DIR}\""

# ---------------------------------------------------------------------------
# Helpers. Values are passed to awk through the environment, never as
# arguments, so a secret doesn't show in the process list either.

# The value of KEY in an env file (empty when missing). Only for use in $(...).
env_get() {
  [[ -f "$1" ]] || return 0
  K="$2" awk -F= '$1 == ENVIRON["K"] { sub(/^[^=]*=/, ""); v = $0 } END { print v }' "$1"
}

# Set KEY in an env file to the value read from stdin (printf is a shell
# builtin, so piping a secret in doesn't show it either): replace the line if
# the key is there, append it if not. The file ends up mode 600.
env_set() {
  local file="$1" key="$2" value tmp
  value="$(cat)"
  tmp="$(mktemp "${file}.XXXXXX")"
  chmod 600 "${tmp}"
  K="${key}" V="${value}" awk '
    BEGIN { done = 0 }
    $0 ~ "^" ENVIRON["K"] "=" { if (!done) { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1 }; next }
    { print }
    END { if (!done) print ENVIRON["K"] "=" ENVIRON["V"] }
  ' "${file}" >"${tmp}"
  mv -f "${tmp}" "${file}"
}

random_hex() {
  # $1 bytes of randomness, as hex.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

sha256_hex() {
  # The sha256 of stdin, as hex.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

download() {
  # download URL DEST: fetched to a temporary file first, so a failed download
  # never leaves a half-written file in place.
  local url="$1" dest="$2" tmp
  tmp="$(mktemp "${dest}.download.XXXXXX")"
  if ! curl -fsSL --retry 3 "${url}" -o "${tmp}"; then
    rm -f "${tmp}"
    fail "Could not download ${url}. Check the ref and your network."
  fi
  if [[ -f "${dest}" ]] && ! cmp -s "${tmp}" "${dest}"; then
    local backup
    backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "${dest}" "${backup}"
    log "Updated $(basename "${dest}"); the previous copy is ${backup}"
  fi
  chmod 644 "${tmp}"
  mv -f "${tmp}" "${dest}"
}

dc() {
  docker compose --project-directory "${INSTALL_DIR}" -f "${INSTALL_DIR}/compose.yml" "$@"
}

have_tty() {
  [[ -r /dev/tty && -w /dev/tty ]] && { : </dev/tty; } 2>/dev/null
}

# ---------------------------------------------------------------------------
# Uninstall: stop and remove the containers. Volumes and files stay.

if [[ "${UNINSTALL}" == "1" ]]; then
  [[ -f "${INSTALL_DIR}/compose.yml" ]] || fail "No MindStone stack found in ${INSTALL_DIR} (no compose.yml)."
  command -v docker >/dev/null 2>&1 || fail "docker is not installed."
  project="$(env_get "${ENV_FILE}" COMPOSE_PROJECT_NAME)"
  log "Stopping the MindStone stack (project ${project:-mindstone})..."
  dc --profile ollama down --remove-orphans
  cat <<MSG

The MindStone stack is stopped and its containers are removed.
Your data is kept:
  - Docker volumes ${project:-mindstone}_gateway-runtime, _pi-agent, _pi-sessions, _console-data (and _ollama-models)
  - ${INSTALL_DIR}/data (the Console's database, uploads and logs)
  - ${INSTALL_DIR}/*.env (the secrets)

Start it again:  cd "${INSTALL_DIR}" && docker compose up -d
To delete everything, which can't be undone:
  cd "${INSTALL_DIR}" && docker compose --profile ollama down -v && cd .. && rm -rf "${INSTALL_DIR}"
MSG
  exit 0
fi

# ---------------------------------------------------------------------------
# Requirements

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v docker >/dev/null 2>&1 || fail "Docker is required: install Docker Desktop (macOS) or Docker Engine (Linux), then run this again."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running (docker info failed). Start Docker, then run this again."
compose_version="$(docker compose version --short 2>/dev/null || true)"
[[ "${compose_version#v}" =~ ^2\. ]] || fail "Docker Compose v2 is required ('docker compose version'); found: ${compose_version:-none}."
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  fail "sha256sum or shasum is required."
fi

# ---------------------------------------------------------------------------
# Settings

mkdir -p "${INSTALL_DIR}"
chmod 700 "${INSTALL_DIR}"
[[ -f "${ENV_FILE}" ]] || { (umask 077; : >"${ENV_FILE}"); }
chmod 600 "${ENV_FILE}"

setting() {
  # setting KEY FLAG_VALUE DEFAULT: the flag, else the environment, else .env, else the default.
  local key="$1" flag="$2" default="$3" value
  value="${flag}"
  [[ -n "${value}" ]] || value="${!key:-}"
  [[ -n "${value}" ]] || value="$(env_get "${ENV_FILE}" "${key}")"
  [[ -n "${value}" ]] || value="${default}"
  printf '%s' "${value}"
}

MINDSTONE_REF="$(setting MINDSTONE_REF "${ARG_REF}" main)"
CONSOLE_REF="$(setting CONSOLE_REF "${ARG_CONSOLE_REF}" main)"
CONSOLE_PORT="$(setting CONSOLE_PORT "" 3080)"
MINDSTONE_GATEWAY_PORT="$(setting MINDSTONE_GATEWAY_PORT "" 19789)"
COMPOSE_PROJECT_NAME="$(setting COMPOSE_PROJECT_NAME "${MINDSTONE_PROJECT:-}" mindstone)"
if [[ "${WITH_OLLAMA}" == "1" ]]; then
  COMPOSE_PROFILES="ollama"
  OLLAMA_BASE_URL="http://ollama:11434/v1"
fi
OLLAMA_BASE_URL="$(setting OLLAMA_BASE_URL "" "http://host.docker.internal:11434/v1")"
COMPOSE_PROFILES="$(setting COMPOSE_PROFILES "" "")"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

for port in "${CONSOLE_PORT}" "${MINDSTONE_GATEWAY_PORT}"; do
  if ! [[ "${port}" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    fail "Not a port number: ${port}"
  fi
done
[[ "${COMPOSE_PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "MINDSTONE_PROJECT must be lowercase letters, digits, - and _."
for ref in "${MINDSTONE_REF}" "${CONSOLE_REF}"; do
  [[ "${ref}" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Not a git ref: ${ref}"
done

log "Install dir:        ${INSTALL_DIR}"
log "MindStone-Agent:    ${MINDSTONE_REF}"
log "MindStone Console:  ${CONSOLE_REF}"
log "Console port:       127.0.0.1:${CONSOLE_PORT}   gateway port: 127.0.0.1:${MINDSTONE_GATEWAY_PORT}"

# Compose's own settings (no secrets): read by every `docker compose` in the install dir.
env_set "${ENV_FILE}" COMPOSE_PROJECT_NAME <<<"${COMPOSE_PROJECT_NAME}"
env_set "${ENV_FILE}" MINDSTONE_REF <<<"${MINDSTONE_REF}"
env_set "${ENV_FILE}" CONSOLE_REF <<<"${CONSOLE_REF}"
env_set "${ENV_FILE}" CONSOLE_PORT <<<"${CONSOLE_PORT}"
env_set "${ENV_FILE}" MINDSTONE_GATEWAY_PORT <<<"${MINDSTONE_GATEWAY_PORT}"
env_set "${ENV_FILE}" OLLAMA_BASE_URL <<<"${OLLAMA_BASE_URL}"
env_set "${ENV_FILE}" UID <<<"${HOST_UID}"
env_set "${ENV_FILE}" GID <<<"${HOST_GID}"
if [[ -n "${COMPOSE_PROFILES}" ]]; then
  env_set "${ENV_FILE}" COMPOSE_PROFILES <<<"${COMPOSE_PROFILES}"
fi

# ---------------------------------------------------------------------------
# Files, pinned to the refs

log "Downloading the stack's files..."
download "${RAW_MSA}/${MINDSTONE_REF}/deploy/docker/compose.yml" "${INSTALL_DIR}/compose.yml"
download "${RAW_CONSOLE}/${CONSOLE_REF}/mindstone/librechat.yaml" "${INSTALL_DIR}/librechat.yaml"
download "${RAW_CONSOLE}/${CONSOLE_REF}/mindstone/.env.example" "${INSTALL_DIR}/console.env.example"
mkdir -p "${INSTALL_DIR}/data/mongo" "${INSTALL_DIR}/data/uploads" "${INSTALL_DIR}/data/logs"

# ---------------------------------------------------------------------------
# Secrets: generated once, into 600 files, never printed. A re-run keeps them.

GATEWAY_ENV="${INSTALL_DIR}/gateway.env"
CONSOLE_ENV="${INSTALL_DIR}/console.env"
umask 077
if [[ ! -f "${CONSOLE_ENV}" ]]; then
  cp "${INSTALL_DIR}/console.env.example" "${CONSOLE_ENV}"
  created_console_env=1
else
  created_console_env=0
fi
[[ -f "${GATEWAY_ENV}" ]] || : >"${GATEWAY_ENV}"
chmod 600 "${CONSOLE_ENV}" "${GATEWAY_ENV}"

fill_if_empty() {
  # fill_if_empty FILE KEY BYTES: a new random value, only when KEY has none.
  local file="$1" key="$2" bytes="$3"
  if [[ -z "$(env_get "${file}" "${key}")" ]]; then
    random_hex "${bytes}" | env_set "${file}" "${key}"
  fi
}

fill_if_empty "${CONSOLE_ENV}" CREDS_KEY 32
fill_if_empty "${CONSOLE_ENV}" CREDS_IV 16
fill_if_empty "${CONSOLE_ENV}" JWT_SECRET 32
fill_if_empty "${CONSOLE_ENV}" JWT_REFRESH_SECRET 32
fill_if_empty "${CONSOLE_ENV}" MINDSTONE_ADMIN_TOKEN 32
fill_if_empty "${GATEWAY_ENV}" MINDSTONE_AGENT_GATEWAY_TOKEN 32

# The gateway token is the same in both files: gateway.env holds it.
gateway_token="$(env_get "${GATEWAY_ENV}" MINDSTONE_AGENT_GATEWAY_TOKEN)"
if [[ "$(env_get "${CONSOLE_ENV}" MINDSTONE_GATEWAY_TOKEN)" != "${gateway_token}" ]]; then
  printf '%s' "${gateway_token}" | env_set "${CONSOLE_ENV}" MINDSTONE_GATEWAY_TOKEN
  [[ "${created_console_env}" == "1" ]] || log "console.env: the gateway token was brought in line with gateway.env."
fi
# The admin credential's plaintext lives only in console.env; the gateway gets its sha256.
printf '%s' "$(env_get "${CONSOLE_ENV}" MINDSTONE_ADMIN_TOKEN)" | sha256_hex | env_set "${GATEWAY_ENV}" MINDSTONE_ADMIN_TOKEN_SHA256
unset gateway_token
# The Console reaches the gateway on the stack's network (compose.yml sets it too).
env_set "${CONSOLE_ENV}" MINDSTONE_GATEWAY_URL <<<"http://gateway:19789/v1"
# Sign-up from the page stays off: the admin is created below.
if [[ -z "$(env_get "${CONSOLE_ENV}" ALLOW_REGISTRATION)" ]]; then
  env_set "${CONSOLE_ENV}" ALLOW_REGISTRATION <<<"false"
fi
umask 022

secret_count="$(grep -cE '^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+' "${CONSOLE_ENV}" || true)"
[[ "${secret_count}" == "6" ]] || fail "console.env should have 6 secrets set; it has ${secret_count}."
log "Secrets are in ${CONSOLE_ENV} and ${GATEWAY_ENV} (mode 600)."

# ---------------------------------------------------------------------------
# Build and start

log "Building and starting the stack. The first build takes several minutes..."
dc up -d --build --remove-orphans

wait_for() {
  # wait_for NAME URL SECONDS
  local name="$1" url="$2" seconds="$3" waited=0
  until curl -fsS -o /dev/null --max-time 5 "${url}" 2>/dev/null; do
    if (( waited >= seconds )); then
      dc ps >&2 || true
      fail "${name} did not answer at ${url} within ${seconds}s. See: cd \"${INSTALL_DIR}\" && docker compose logs ${name}"
    fi
    sleep 3
    waited=$((waited + 3))
  done
  log "${name} is up."
}

wait_for gateway "http://127.0.0.1:${MINDSTONE_GATEWAY_PORT}/health" 180
wait_for console "http://127.0.0.1:${CONSOLE_PORT}/" 300

# ---------------------------------------------------------------------------
# The Console's admin account

ADMIN_MARKER="${INSTALL_DIR}/.admin-created"
PASSWORD_FILE="${INSTALL_DIR}/admin-password"
admin_status="exists"

create_admin() {
  # create_admin EMAIL NAME: the password comes from the variable admin_password, on stdin.
  local email="$1" name="$2" username output
  username="$(printf '%s' "${email%%@*}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '_')"
  [[ -n "${username}" ]] || username="admin"
  if output="$(printf '%s\n' "${admin_password}" | dc exec -T console npm run --silent create-user -- "${email}" "${name}" "${username}" --email-verified=true 2>&1)"; then
    printf '%s\n' "${email}" >"${ADMIN_MARKER}"
    log "Admin account created: ${email}"
    return 0
  fi
  if grep -q "already exists" <<<"${output}"; then
    printf '%s\n' "${email}" >"${ADMIN_MARKER}"
    log "An account with that email or username already exists; it was left as it is."
    return 0
  fi
  # Only the tool's own error lines, which never contain the password.
  grep -iE "error" <<<"${output}" | head -n 5 >&2 || true
  return 1
}

valid_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }

if [[ -f "${ADMIN_MARKER}" ]]; then
  log "The admin account was already created ($(head -n 1 "${ADMIN_MARKER}"))."
elif [[ -n "${ADMIN_EMAIL}" ]]; then
  valid_email "${ADMIN_EMAIL}" || fail "--admin-email is not an email address."
  if [[ ! -s "${PASSWORD_FILE}" ]]; then
    (umask 077; random_hex 18 >"${PASSWORD_FILE}")
  fi
  chmod 600 "${PASSWORD_FILE}"
  admin_password="$(head -n 1 "${PASSWORD_FILE}")"
  create_admin "${ADMIN_EMAIL}" "${ADMIN_NAME:-Admin}" || fail "Could not create the admin account. The stack is running; re-run this command to try again."
  admin_status="generated"
elif have_tty; then
  printf '\nCreate the MindStone Console admin account.\n' >/dev/tty
  while :; do
    printf 'Email: ' >/dev/tty; IFS= read -r ADMIN_EMAIL </dev/tty
    valid_email "${ADMIN_EMAIL}" && break
    printf 'That is not an email address.\n' >/dev/tty
  done
  printf 'Name [Admin]: ' >/dev/tty; IFS= read -r ADMIN_NAME </dev/tty
  while :; do
    printf 'Password (8 characters or more, not shown): ' >/dev/tty; IFS= read -rs admin_password </dev/tty; printf '\n' >/dev/tty
    printf 'Password again: ' >/dev/tty; IFS= read -rs admin_password_again </dev/tty; printf '\n' >/dev/tty
    if [[ "${#admin_password}" -lt 8 ]]; then
      printf 'Too short.\n' >/dev/tty
    elif [[ "${admin_password}" != "${admin_password_again}" ]]; then
      printf 'They do not match.\n' >/dev/tty
    else
      break
    fi
  done
  unset admin_password_again
  create_admin "${ADMIN_EMAIL}" "${ADMIN_NAME:-Admin}" || fail "Could not create the admin account. The stack is running; re-run this command to try again."
  admin_status="asked"
else
  admin_status="missing"
fi
unset admin_password

# ---------------------------------------------------------------------------
# Done

cat <<MSG

MindStone is running.

  Open http://localhost:${CONSOLE_PORT}
MSG
case "${admin_status}" in
  generated)
    cat <<MSG
  Sign in as ${ADMIN_EMAIL}. The password is in ${PASSWORD_FILE} (mode 600).
  Read it from there, then delete the file once you've stored it somewhere safe.
MSG
    ;;
  asked) printf '  Sign in as %s with the password you chose.\n' "${ADMIN_EMAIL}" ;;
  missing)
    cat <<MSG
  No admin account yet (no terminal to ask in, and no --admin-email). Create one:
    curl -fsSL ${INSTALL_URL} | bash -s --${DIR_FLAG} --admin-email you@example.com
MSG
    ;;
esac
cat <<MSG

  The Console shows a "Set up MindStone" banner: guided setup picks the model,
  persona and memory. Ollama on this machine is reached as ${OLLAMA_BASE_URL}.

Manage it (in ${INSTALL_DIR}):
  Status:     cd "${INSTALL_DIR}" && docker compose ps
  Logs:       cd "${INSTALL_DIR}" && docker compose logs -f gateway
  CLI:        cd "${INSTALL_DIR}" && docker compose exec gateway ./scripts/mindstone status
  Stop:       cd "${INSTALL_DIR}" && docker compose stop
  Start:      cd "${INSTALL_DIR}" && docker compose up -d
  Update:     curl -fsSL ${INSTALL_URL} | bash${DIR_FLAG:+ -s --${DIR_FLAG}}
              (the same refs and ports as now; secrets and data are kept)
  Uninstall:  curl -fsSL ${INSTALL_URL} | bash -s --${DIR_FLAG} --uninstall
              (stops the stack; data is kept, and it says how to delete it)
MSG
