#!/usr/bin/env bash
# MindStone, the whole stack in Docker (#171): the MindStone-Agent gateway, the
# MindStone Console and MongoDB, set up and started with one command.
#
#   curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.sh | bash
#
# Re-running it updates the stack. Secrets are generated once, into 600 files,
# and never printed; existing secrets and data are never replaced.
#
# Everything runs inside main(), called on the last line, so a download cut off
# part-way runs nothing.
set -euo pipefail

RAW_MSA="https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent"
RAW_CONSOLE="https://raw.githubusercontent.com/MindStone-Agent/mindstone-console"
INSTALL_URL="${RAW_MSA}/main/install-stack.sh"
DEFAULT_DIR_NAME=".mindstone-stack"
# The file that marks a folder as this installer's, so --dir never takes over another folder.
MARKER=".mindstone-stack"
HOST_OLLAMA_URL="http://host.docker.internal:11434/v1"
STACK_OLLAMA_URL="http://ollama:11434/v1"
# Everything the installer creates in the install folder, and nothing else:
# the printed delete removes exactly these.
CREATED_FILES=(compose.yml librechat.yaml console.env.example .env gateway.env console.env admin-password .admin-created "${MARKER}")

usage() {
  cat <<'USAGE'
MindStone stack installer: the MindStone-Agent gateway, the MindStone Console and
MongoDB in Docker.

Usage:
  install-stack.sh [options]

Options:
  --dir PATH            Install folder. Default: ~/.mindstone-stack. It must be new,
                        empty, or an earlier stack install
  --ref REF             MindStone-Agent git ref to install. Default: main
  --console-ref REF     MindStone Console git ref to install. Default: main
  --admin-email EMAIL   Create the Console admin without prompts: the password is
                        generated into <dir>/admin-password (mode 600), never printed
  --admin-name NAME     The admin's display name, 3 to 80 characters. Default: Admin
  --with-ollama         Also run Ollama in a container (Linux, or no Ollama on this machine)
  --without-ollama      Go back to Ollama on this machine (undoes --with-ollama)
  --ollama-url URL      Ollama as the gateway container sees it, ending in /v1.
                        Default: http://host.docker.internal:11434/v1
  --uninstall           Stop and remove the stack's containers. Data is kept
  --help                Show this help

Environment (only these names are read; COMPOSE_* and the other variables
compose.yml uses come from <dir>/.env only, and are unset for the installer's
own docker compose commands):
  MINDSTONE_DIR, MINDSTONE_REF, CONSOLE_REF
  CONSOLE_PORT               the Console's port on 127.0.0.1. Default: 3080
  MINDSTONE_GATEWAY_PORT     the gateway's port on 127.0.0.1. Default: 19789
  MINDSTONE_PROJECT          the Docker Compose project name. Default: mindstone-stack
  MINDSTONE_OLLAMA_BASE_URL  same as --ollama-url
Set them on bash, not on curl:
  curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.sh | \
    CONSOLE_PORT=3090 bash -s -- --admin-email you@example.com

Your own changes to the stack (a GPU for Ollama, extra mounts) go in
<dir>/compose.override.yml: the installer uses it and never overwrites it.

Don't run this with sudo: add yourself to the docker group instead.
USAGE
}

log() { printf '\033[38;5;214m[MindStone]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[MindStone warning]\033[0m %s\n' "$*" >&2; }
fail() {
  printf '\033[31m[MindStone install error]\033[0m %s\n' "$*" >&2
  exit 1
}

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

# Remove KEY from an env file.
env_unset() {
  local file="$1" key="$2" tmp
  [[ -f "${file}" ]] || return 0
  tmp="$(mktemp "${file}.XXXXXX")"
  chmod 600 "${tmp}"
  K="${key}" awk '$0 !~ "^" ENVIRON["K"] "=" { print }' "${file}" >"${tmp}"
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
  local url="$1" dest="$2" tmp backup
  tmp="$(mktemp "${dest}.download.XXXXXX")"
  if ! curl -fsSL --retry 3 "${url}" -o "${tmp}"; then
    rm -f "${tmp}"
    fail "Could not download ${url}. Check the ref and your network."
  fi
  if [[ -f "${dest}" ]] && ! cmp -s "${tmp}" "${dest}"; then
    backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "${dest}" "${backup}"
    log "Updated $(basename "${dest}"); the previous copy is ${backup}"
  fi
  chmod 644 "${tmp}"
  mv -f "${tmp}" "${dest}"
}

# docker compose for this install: its folder, its .env, compose.override.yml
# when present, and none of the calling shell's COMPOSE_* or stack variables,
# which would override .env.
dc() {
  local files=(-f "${INSTALL_DIR}/compose.yml") unset=() name
  [[ -f "${INSTALL_DIR}/compose.override.yml" ]] && files+=(-f "${INSTALL_DIR}/compose.override.yml")
  # Every COMPOSE_* variable, and every variable compose.yml reads, comes from .env only.
  for name in $(compgen -e); do
    case "${name}" in
      COMPOSE_* | OLLAMA_BASE_URL | CONSOLE_PORT | MINDSTONE_GATEWAY_PORT | MINDSTONE_REF | CONSOLE_REF | \
        MINDSTONE_BUILD_CONTEXT | CONSOLE_BUILD_CONTEXT | UID | GID) unset+=(-u "${name}") ;;
    esac
  done
  env ${unset[@]+"${unset[@]}"} docker compose --project-directory "${INSTALL_DIR}" "${files[@]}" "$@"
}

have_tty() {
  [[ -r /dev/tty && -w /dev/tty ]] && { : </dev/tty; } 2>/dev/null
}

# A folder's physical path, found the way `mkdir -p` and then `cd -P` would,
# without creating anything: an existing component is followed (so /tmp is
# /private/tmp on macOS), a missing one is taken as given, and ".." goes back
# up from wherever that leaves it (so "$HOME/new/.." is $HOME). Prints the path;
# returns 2 when the last component is a symlink, 3 when a component exists
# but isn't a folder, 4 when a symlink can't be followed.
resolve_dir() {
  local path="$1" cur="" comp i last
  local -a parts
  IFS=/ read -r -a parts <<<"${path}"
  last=$(( ${#parts[@]} - 1 ))
  while (( last >= 0 )) && [[ -z "${parts[last]}" || "${parts[last]}" == "." ]]; do last=$((last - 1)); done
  for (( i = 0; i < ${#parts[@]}; i++ )); do
    comp="${parts[i]}"
    case "${comp}" in
      "" | .) continue ;;
      ..) cur="${cur%/*}"; continue ;;
    esac
    if [[ -L "${cur}/${comp}" ]]; then
      (( i != last )) || return 2
      cur="$(cd -P "${cur}/${comp}" 2>/dev/null && pwd -P)" || return 4
      [[ "${cur}" != "/" ]] || cur=""
    elif [[ -d "${cur}/${comp}" ]]; then
      cur="${cur}/${comp}"
    elif [[ -e "${cur}/${comp}" ]]; then
      return 3
    else
      cur="${cur}/${comp}"
    fi
  done
  printf '%s\n' "${cur:-/}"
}

# Whether a folder is a stack from before the marker file existed: it has the
# installer's own files, and its compose file runs the stack's gateway.
legacy_stack() {
  [[ -f "$1/compose.yml" && -f "$1/gateway.env" && -f "$1/console.env" ]] &&
    grep -q "docker-gateway-entrypoint.sh" "$1/compose.yml" 2>/dev/null
}

# Resolve --dir to its physical path (INSTALL_DIR becomes that path), and
# refuse any folder the installer shouldn't own: a symlink, the home folder,
# the root, an ancestor of the home folder, or a folder with other things in
# it. Every check runs on the resolved path, and nothing is created here.
check_install_dir() {
  local given="${INSTALL_DIR}" dir home rc=0
  dir="$(resolve_dir "${given}")" || rc=$?
  case "${rc}" in
    0) ;;
    2) fail "Refusing ${given}: it is a symbolic link. Give the folder itself." ;;
    3) fail "Refusing ${given}: part of that path exists and isn't a folder." ;;
    *) fail "Refusing ${given}: a symbolic link in that path can't be followed." ;;
  esac
  home="$(cd -P "${HOME}" 2>/dev/null && pwd -P)" || fail "Your home folder (${HOME}) can't be read."
  if [[ "${dir}" == "/" || "${dir}" == "${home}" || "${home}/" == "${dir}/"* ]]; then
    fail "Refusing to install into ${given} (${dir}): that is your home folder, the root, or a folder that contains your home folder. Choose a folder of its own, such as ~/${DEFAULT_DIR_NAME}."
  fi
  if [[ -d "${dir}" && ! -f "${dir}/${MARKER}" ]] && ! legacy_stack "${dir}" && [[ -n "$(ls -A "${dir}/" 2>/dev/null)" ]]; then
    fail "${given} isn't empty and isn't a MindStone stack install (no ${MARKER} file), so it was left alone. Choose a new or empty folder with --dir."
  fi
  INSTALL_DIR="${dir}"
  HOME_PHYSICAL="${home}"
}

# Create the install folder, and check it is where check_install_dir resolved it.
make_install_dir() {
  mkdir -p "${INSTALL_DIR}"
  [[ "$(cd -P "${INSTALL_DIR}" && pwd -P)" == "${INSTALL_DIR}" ]] || fail "${INSTALL_DIR} changed while installing (a symbolic link?); stopping."
}

# The commands that delete what the installer created, and nothing else.
print_delete_commands() {
  local project="$1" files
  files="$(printf '%s ' "${CREATED_FILES[@]}")"
  cat <<MSG
To delete the stack's data as well, which can't be undone:
  docker volume rm ${project}_gateway-runtime ${project}_pi-agent ${project}_pi-sessions ${project}_console-data
  docker volume rm ${project}_ollama-models    # only if you used --with-ollama
  cd "${INSTALL_DIR}" && rm -rf data && rm -f ${files}&& find . -maxdepth 1 -type f \( -name 'compose.yml.bak.*' -o -name 'librechat.yaml.bak.*' -o -name 'console.env.example.bak.*' \) -delete && cd .. && rmdir "${INSTALL_DIR}"
(Only the files the installer made are deleted; rmdir then fails, and leaves the folder, if you added files of your own such as compose.override.yml.)
MSG
}

# An email the Console accepts (its zod check), without quotes: the local part
# is letters, digits and _ + - ., with no dot first, last or doubled.
valid_email() {
  [[ "$1" =~ ^[A-Za-z0-9_+-]([A-Za-z0-9_+.-]*[A-Za-z0-9_+-])?@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$ ]] && [[ "$1" != *..* ]]
}
valid_name() { [[ "${#1}" -ge 3 && "${#1}" -le 80 && "$1" != *[[:cntrl:]]* ]]; }

# The Console's username from an email's local part: letters, digits, . and _
# (the Console refuses "--", "/", "=" and quotes). Too short: a longer one.
username_for() {
  local name
  name="$(printf '%s' "${1%%@*}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._' '_' | cut -c1-60)"
  if [[ "${#name}" -lt 2 ]]; then
    name="$(fallback_username "${name}")"
  fi
  printf '%s' "${name}"
}

fallback_username() {
  # The name (or "admin") with an underscore and 4 random characters.
  printf '%s_%s' "${1:-admin}" "$(random_hex 2)"
}

# A value from the Console's database, read in the mongodb container (the
# gateway isn't on its network). EXPR is a mongosh expression; the values put in
# it are checked above to hold no quotes. Retries while MongoDB starts.
mongo_query() {
  local out="" tries=0
  while (( tries < 10 )); do
    out="$(dc exec -T -e HOME=/tmp mongodb mongosh --quiet --norc MindStoneConsole \
      --eval "print('OK:' + (${1}))" 2>/dev/null | grep '^OK:' | tail -n 1)" || out=""
    if [[ -n "${out}" ]]; then
      printf '%s' "${out#OK:}"
      return 0
    fi
    tries=$((tries + 1))
    sleep 3
  done
  fail "Could not read the Console's accounts in MongoDB. The stack is running; re-run this command to try again."
}

# The role of the account with this email, or "none".
account_role() {
  mongo_query "(db.users.findOne({ email: '$1' }) || {}).role || 'none'"
}

# The command that makes the account with this email a Console admin
# (printed, not run: the $set is for mongosh).
# shellcheck disable=SC2016
promote_command() {
  printf 'cd "%s" && docker compose exec -T -e HOME=/tmp mongodb mongosh --quiet MindStoneConsole --eval "db.users.updateOne({ email: '"'"'%s'"'"' }, { \\$set: { role: '"'"'ADMIN'"'"' } })"' "${INSTALL_DIR}" "$1"
}

port_in_use() {
  # Whether something answers on 127.0.0.1:PORT.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

port_is_ours() {
  # Whether this stack's own containers publish 127.0.0.1:PORT (a re-run).
  docker ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" --format '{{.Ports}}' 2>/dev/null |
    grep -q "127.0.0.1:$1->"
}

main() {
  local arg_ref="" arg_console_ref="" arg_ollama_url="" admin_email="" admin_name="" ollama_mode="" uninstall=0

  INSTALL_DIR="${MINDSTONE_DIR:-${HOME}/${DEFAULT_DIR_NAME}}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) [[ $# -ge 2 ]] || fail "--dir needs a path"; INSTALL_DIR="$2"; shift 2 ;;
      --ref) [[ $# -ge 2 ]] || fail "--ref needs a git ref"; arg_ref="$2"; shift 2 ;;
      --console-ref) [[ $# -ge 2 ]] || fail "--console-ref needs a git ref"; arg_console_ref="$2"; shift 2 ;;
      --admin-email) [[ $# -ge 2 ]] || fail "--admin-email needs an address"; admin_email="$2"; shift 2 ;;
      --admin-name) [[ $# -ge 2 ]] || fail "--admin-name needs a name"; admin_name="$2"; shift 2 ;;
      --with-ollama) ollama_mode="stack"; shift ;;
      --without-ollama) ollama_mode="host"; shift ;;
      --ollama-url) [[ $# -ge 2 ]] || fail "--ollama-url needs a URL"; arg_ollama_url="$2"; shift 2 ;;
      --uninstall) uninstall=1; shift ;;
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
  while [[ "${INSTALL_DIR}" == */ && "${INSTALL_DIR}" != "/" ]]; do INSTALL_DIR="${INSTALL_DIR%/}"; done
  check_install_dir
  ENV_FILE="${INSTALL_DIR}/.env"
  # How to name this install again in the commands printed at the end.
  local dir_flag=""
  [[ "${INSTALL_DIR}" == "${HOME_PHYSICAL}/${DEFAULT_DIR_NAME}" ]] || dir_flag=" --dir \"${INSTALL_DIR}\""

  # -------------------------------------------------------------------------
  # Uninstall: stop and remove the containers. Volumes and files stay.
  if [[ "${uninstall}" == "1" ]]; then
    [[ -f "${INSTALL_DIR}/compose.yml" ]] || fail "No MindStone stack found in ${INSTALL_DIR} (no compose.yml)."
    command -v docker >/dev/null 2>&1 || fail "docker is not installed."
    COMPOSE_PROJECT_NAME="$(env_get "${ENV_FILE}" COMPOSE_PROJECT_NAME)"
    COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mindstone-stack}"
    log "Stopping the MindStone stack (project ${COMPOSE_PROJECT_NAME})..."
    dc --profile ollama down --remove-orphans
    cat <<MSG

The MindStone stack is stopped and its containers are removed.
Your data is kept: the Docker volumes ${COMPOSE_PROJECT_NAME}_*, ${INSTALL_DIR}/data
(the Console's database, uploads and logs) and the secrets in ${INSTALL_DIR}.

Start it again:  cd "${INSTALL_DIR}" && docker compose up -d
MSG
    print_delete_commands "${COMPOSE_PROJECT_NAME}"
    exit 0
  fi

  # -------------------------------------------------------------------------
  # Requirements
  if [[ "$(id -u)" == "0" ]]; then
    warn "Running as root: the stack would be installed for root (in its home folder, with its ids). If that's because of curl | sudo bash, stop and add your user to the docker group instead."
  fi
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v docker >/dev/null 2>&1 || fail "Docker is required: install Docker Desktop (macOS) or Docker Engine (Linux), then run this again."
  if ! docker info >/dev/null 2>&1; then
    fail "Docker isn't reachable (docker info failed). Start Docker. On Linux, if Docker is running, your user may not be in the docker group: run 'sudo usermod -aG docker \$USER', log out and back in, then run this again. Don't run this installer with sudo: it would install into root's home with root's ids."
  fi
  local compose_version
  compose_version="$(docker compose version --short 2>/dev/null || true)"
  [[ "${compose_version#v}" =~ ^2\. ]] || fail "Docker Compose v2 is required ('docker compose version'); found: ${compose_version:-none}."
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail "sha256sum or shasum is required."
  fi

  # -------------------------------------------------------------------------
  # Settings: a flag, else the stack's own environment variable, else .env,
  # else the default. No other variable of the calling shell is read.
  setting() {
    # setting KEY FLAG_VALUE ENV_NAME DEFAULT
    local key="$1" value="$2" env_name="$3" default="$4"
    [[ -n "${value}" || -z "${env_name}" ]] || value="${!env_name:-}"
    [[ -n "${value}" ]] || value="$(env_get "${ENV_FILE}" "${key}")"
    [[ -n "${value}" ]] || value="${default}"
    printf '%s' "${value}"
  }

  MINDSTONE_REF="$(setting MINDSTONE_REF "${arg_ref}" MINDSTONE_REF main)"
  CONSOLE_REF="$(setting CONSOLE_REF "${arg_console_ref}" CONSOLE_REF main)"
  CONSOLE_PORT="$(setting CONSOLE_PORT "" CONSOLE_PORT 3080)"
  MINDSTONE_GATEWAY_PORT="$(setting MINDSTONE_GATEWAY_PORT "" MINDSTONE_GATEWAY_PORT 19789)"
  COMPOSE_PROJECT_NAME="$(setting COMPOSE_PROJECT_NAME "" MINDSTONE_PROJECT mindstone-stack)"
  local profiles ollama_url
  profiles="$(env_get "${ENV_FILE}" COMPOSE_PROFILES)"
  case "${ollama_mode}" in
    stack) profiles="ollama"; ollama_url="${STACK_OLLAMA_URL}" ;;
    host) profiles=""; ollama_url="${HOST_OLLAMA_URL}" ;;
    *) ollama_url="" ;;
  esac
  [[ -z "${arg_ollama_url}" ]] || ollama_url="${arg_ollama_url}"
  local previous_ollama_url
  previous_ollama_url="$(env_get "${ENV_FILE}" OLLAMA_BASE_URL)"
  ollama_url="$(setting OLLAMA_BASE_URL "${ollama_url}" MINDSTONE_OLLAMA_BASE_URL "${HOST_OLLAMA_URL}")"

  for port in "${CONSOLE_PORT}" "${MINDSTONE_GATEWAY_PORT}"; do
    if ! [[ "${port}" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
      fail "Not a port number: ${port}"
    fi
  done
  [[ "${CONSOLE_PORT}" != "${MINDSTONE_GATEWAY_PORT}" ]] || fail "CONSOLE_PORT and MINDSTONE_GATEWAY_PORT must differ."
  [[ "${COMPOSE_PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "MINDSTONE_PROJECT must be lowercase letters, digits, - and _."
  for ref in "${MINDSTONE_REF}" "${CONSOLE_REF}"; do
    [[ "${ref}" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Not a git ref: ${ref}"
  done
  # The address the gateway container uses for Ollama.
  [[ "${ollama_url}" =~ ^https?://[^/[:space:]]+(/[^[:space:]]*)?$ ]] || fail "Not an http(s) URL for Ollama: ${ollama_url}"
  local ollama_host="${ollama_url#*://}"
  ollama_host="${ollama_host%%/*}"
  ollama_host="${ollama_host%:*}"
  case "${ollama_host}" in
    localhost|127.*|0.0.0.0|"[::1]"|"[::]")
      warn "Ollama at ${ollama_url}: inside the gateway container, ${ollama_host} is the container itself, not this machine. Use ${HOST_OLLAMA_URL} for Ollama on this machine." ;;
  esac
  [[ "${ollama_url%/}" == */v1 ]] || warn "Ollama at ${ollama_url}: the address should end in /v1 (Ollama's OpenAI-compatible API), as in ${HOST_OLLAMA_URL}."

  # -------------------------------------------------------------------------
  # The admin account's details, asked for or checked before the long build.
  local admin_marker="${INSTALL_DIR}/.admin-created" admin_mode="none" admin_username="" admin_password=""
  if [[ -f "${admin_marker}" ]]; then
    admin_mode="done"
  elif [[ -n "${admin_email}" ]]; then
    valid_email "${admin_email}" || fail "--admin-email is not an email address the Console accepts (letters, digits and _ + - . before the @, no dot first, last or doubled)."
    admin_name="${admin_name:-Admin}"
    valid_name "${admin_name}" || fail "--admin-name must be 3 to 80 characters."
    admin_mode="generated"
  elif have_tty; then
    printf '\nThe MindStone Console admin account.\n' >/dev/tty
    while :; do
      printf 'Email: ' >/dev/tty; IFS= read -r admin_email </dev/tty
      valid_email "${admin_email}" && break
      printf 'That is not an email address.\n' >/dev/tty
    done
    while :; do
      printf 'Name [Admin]: ' >/dev/tty; IFS= read -r admin_name </dev/tty
      admin_name="${admin_name:-Admin}"
      valid_name "${admin_name}" && break
      printf 'The name must be 3 to 80 characters.\n' >/dev/tty
    done
    local again=""
    while :; do
      printf 'Password (8 to 128 characters, not shown): ' >/dev/tty; IFS= read -rs admin_password </dev/tty; printf '\n' >/dev/tty
      printf 'Password again: ' >/dev/tty; IFS= read -rs again </dev/tty; printf '\n' >/dev/tty
      if [[ "${#admin_password}" -lt 8 || "${#admin_password}" -gt 128 ]]; then
        printf 'It must be 8 to 128 characters.\n' >/dev/tty
      elif [[ "${admin_password}" != "${again}" ]]; then
        printf 'They do not match.\n' >/dev/tty
      else
        break
      fi
    done
    again=""
    admin_mode="asked"
  fi
  if [[ "${admin_mode}" == "generated" || "${admin_mode}" == "asked" ]]; then
    admin_email="$(printf '%s' "${admin_email}" | tr '[:upper:]' '[:lower:]')"
    admin_username="$(username_for "${admin_email}")"
  fi

  # -------------------------------------------------------------------------
  # The install folder and its settings
  log "Install dir:        ${INSTALL_DIR}"
  log "MindStone-Agent:    ${MINDSTONE_REF}"
  log "MindStone Console:  ${CONSOLE_REF}"
  log "Console port:       127.0.0.1:${CONSOLE_PORT}   gateway port: 127.0.0.1:${MINDSTONE_GATEWAY_PORT}"
  log "Compose project:    ${COMPOSE_PROJECT_NAME}"

  # Both ports must be free, or held by this stack already (a re-run).
  local name
  for name in CONSOLE_PORT MINDSTONE_GATEWAY_PORT; do
    if port_in_use "${!name}" && ! port_is_ours "${!name}"; then
      fail "Port ${!name} on 127.0.0.1 is already in use (${name}). Stop what uses it (a native MindStone gateway uses 19789), or choose another port: curl ... | ${name}=<port> bash -s -- ..."
    fi
  done

  make_install_dir
  chmod 700 "${INSTALL_DIR}"
  [[ -f "${INSTALL_DIR}/${MARKER}" ]] || printf 'This folder is a MindStone stack install (install-stack.sh). Delete it only with the commands --uninstall prints.\n' >"${INSTALL_DIR}/${MARKER}"
  [[ -f "${ENV_FILE}" ]] || { (umask 077; : >"${ENV_FILE}"); }
  chmod 600 "${ENV_FILE}"

  # Compose's own settings (no secrets): read by every `docker compose` in the install dir.
  env_set "${ENV_FILE}" COMPOSE_PROJECT_NAME <<<"${COMPOSE_PROJECT_NAME}"
  env_set "${ENV_FILE}" MINDSTONE_REF <<<"${MINDSTONE_REF}"
  env_set "${ENV_FILE}" CONSOLE_REF <<<"${CONSOLE_REF}"
  env_set "${ENV_FILE}" CONSOLE_PORT <<<"${CONSOLE_PORT}"
  env_set "${ENV_FILE}" MINDSTONE_GATEWAY_PORT <<<"${MINDSTONE_GATEWAY_PORT}"
  env_set "${ENV_FILE}" OLLAMA_BASE_URL <<<"${ollama_url}"
  env_set "${ENV_FILE}" UID <<<"$(id -u)"
  env_set "${ENV_FILE}" GID <<<"$(id -g)"
  if [[ -n "${profiles}" ]]; then
    env_set "${ENV_FILE}" COMPOSE_PROFILES <<<"${profiles}"
  else
    env_unset "${ENV_FILE}" COMPOSE_PROFILES
  fi

  # -------------------------------------------------------------------------
  # Files, pinned to the refs
  log "Downloading the stack's files..."
  download "${RAW_MSA}/${MINDSTONE_REF}/deploy/docker/compose.yml" "${INSTALL_DIR}/compose.yml"
  download "${RAW_CONSOLE}/${CONSOLE_REF}/mindstone/librechat.yaml" "${INSTALL_DIR}/librechat.yaml"
  download "${RAW_CONSOLE}/${CONSOLE_REF}/mindstone/.env.example" "${INSTALL_DIR}/console.env.example"
  mkdir -p "${INSTALL_DIR}/data/mongo" "${INSTALL_DIR}/data/uploads" "${INSTALL_DIR}/data/logs"
  if [[ -f "${INSTALL_DIR}/compose.override.yml" ]]; then
    log "Using your compose.override.yml."
  fi

  # -------------------------------------------------------------------------
  # Secrets: generated once, into 600 files, never printed. A re-run keeps them.
  local gateway_env="${INSTALL_DIR}/gateway.env" console_env="${INSTALL_DIR}/console.env" created_console_env=0
  umask 077
  if [[ ! -f "${console_env}" ]]; then
    cp "${INSTALL_DIR}/console.env.example" "${console_env}"
    created_console_env=1
  fi
  [[ -f "${gateway_env}" ]] || : >"${gateway_env}"
  chmod 600 "${console_env}" "${gateway_env}"

  fill_if_empty() {
    # fill_if_empty FILE KEY BYTES: a new random value, only when KEY has none.
    if [[ -z "$(env_get "$1" "$2")" ]]; then
      random_hex "$3" | env_set "$1" "$2"
    fi
  }
  fill_if_empty "${console_env}" CREDS_KEY 32
  fill_if_empty "${console_env}" CREDS_IV 16
  fill_if_empty "${console_env}" JWT_SECRET 32
  fill_if_empty "${console_env}" JWT_REFRESH_SECRET 32
  fill_if_empty "${console_env}" MINDSTONE_ADMIN_TOKEN 32
  fill_if_empty "${gateway_env}" MINDSTONE_AGENT_GATEWAY_TOKEN 32

  # The gateway token is the same in both files: gateway.env holds it.
  local gateway_token
  gateway_token="$(env_get "${gateway_env}" MINDSTONE_AGENT_GATEWAY_TOKEN)"
  if [[ "$(env_get "${console_env}" MINDSTONE_GATEWAY_TOKEN)" != "${gateway_token}" ]]; then
    printf '%s' "${gateway_token}" | env_set "${console_env}" MINDSTONE_GATEWAY_TOKEN
    [[ "${created_console_env}" == "1" ]] || log "console.env: the gateway token was brought in line with gateway.env."
  fi
  gateway_token=""
  # The admin credential's plaintext lives only in console.env; the gateway gets its sha256.
  printf '%s' "$(env_get "${console_env}" MINDSTONE_ADMIN_TOKEN)" | sha256_hex | env_set "${gateway_env}" MINDSTONE_ADMIN_TOKEN_SHA256
  # The Console reaches the gateway on the stack's network (compose.yml sets it too).
  env_set "${console_env}" MINDSTONE_GATEWAY_URL <<<"http://gateway:19789/v1"
  # Sign-up from the page stays off: the admin is created below.
  if [[ -z "$(env_get "${console_env}" ALLOW_REGISTRATION)" ]]; then
    env_set "${console_env}" ALLOW_REGISTRATION <<<"false"
  fi
  umask 022

  local secret_count
  secret_count="$(grep -cE '^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+' "${console_env}" || true)"
  [[ "${secret_count}" == "6" ]] || fail "console.env should have 6 secrets set; it has ${secret_count}."
  log "Secrets are in ${console_env} and ${gateway_env} (mode 600)."

  # -------------------------------------------------------------------------
  # Build and start
  log "Building and starting the stack. The first build takes several minutes..."
  if [[ -z "${profiles}" ]]; then
    # Back from --with-ollama: the in-stack Ollama stops; its models volume stays.
    dc --profile ollama rm --stop --force ollama >/dev/null 2>&1 || true
  fi
  dc up -d --build --remove-orphans

  wait_for() {
    # wait_for NAME URL SECONDS
    local waited=0
    until curl -fsS -o /dev/null --max-time 5 "$2" 2>/dev/null; do
      if (( waited >= $3 )); then
        dc ps >&2 || true
        fail "$1 did not answer at $2 within $3s. See: cd \"${INSTALL_DIR}\" && docker compose logs $1"
      fi
      sleep 3
      waited=$((waited + 3))
    done
    log "$1 is up."
  }
  wait_for gateway "http://127.0.0.1:${MINDSTONE_GATEWAY_PORT}/health" 180
  wait_for console "http://127.0.0.1:${CONSOLE_PORT}/" 300

  # -------------------------------------------------------------------------
  # The Console's admin account
  local password_file="${INSTALL_DIR}/admin-password" admin_status="${admin_mode}" output existing_role="" other_accounts=0 role=""
  if [[ "${admin_mode}" == "done" ]]; then
    log "The admin account was set up by an earlier run: $(head -n 1 "${admin_marker}")."
  elif [[ "${admin_mode}" == "generated" || "${admin_mode}" == "asked" ]]; then
    existing_role="$(account_role "${admin_email}")"
    if [[ "${existing_role}" != "none" ]]; then
      # The account exists already: it keeps its own password and role. No
      # marker, so a later run with another --admin-email still creates one.
      admin_status="exists"
    else
      # The Console makes only its first account an admin: count them first.
      other_accounts="$(mongo_query "db.users.countDocuments({})")"
      # A username another account has gets a longer one.
      local tries=0
      while [[ "$(mongo_query "db.users.countDocuments({ username: '${admin_username}' })")" != "0" ]]; do
        tries=$((tries + 1))
        (( tries <= 5 )) || fail "Could not find a free username for ${admin_email}. The stack is running; re-run this command to try again."
        admin_username="$(fallback_username "$(username_for "${admin_email}")")"
      done
      if [[ "${admin_mode}" == "generated" ]]; then
        [[ -s "${password_file}" ]] || (umask 077; random_hex 18 >"${password_file}")
        chmod 600 "${password_file}"
        admin_password="$(head -n 1 "${password_file}")"
      fi
      if ! { output="$(printf '%s\n' "${admin_password}" | dc exec -T console npm run --silent create-user -- "${admin_email}" "${admin_name}" "${admin_username}" --email-verified=true 2>&1)" &&
        grep -q "User created successfully" <<<"${output}"; }; then
        # Only the tool's own error lines, which never contain the password.
        grep -iE "error" <<<"${output}" | head -n 5 >&2 || true
        fail "Could not create the admin account ${admin_email}. The stack is running; re-run this command to try again."
      fi
      if [[ "${other_accounts}" != "0" ]]; then
        # The Console created it as a regular user: the installer was asked for
        # the admin, so it sets the role in the database (no Console script does).
        mongo_query "db.users.updateOne({ email: '${admin_email}' }, { \$set: { role: 'ADMIN' } }).matchedCount" >/dev/null
        log "The Console already had ${other_accounts} account(s), so it made ${admin_email} a regular user; the installer set its role to ADMIN."
      fi
      role="$(account_role "${admin_email}")"
      if [[ "${role}" != "ADMIN" ]]; then
        fail "The account ${admin_email} was created, but its role is ${role}, not ADMIN. Make it an admin with: $(promote_command "${admin_email}")"
      fi
      printf '%s (username %s, role ADMIN)\n' "${admin_email}" "${admin_username}" >"${admin_marker}"
      log "Admin account created: ${admin_email} (username ${admin_username}, role ADMIN)"
    fi
  fi
  admin_password=""

  # -------------------------------------------------------------------------
  # Done
  cat <<MSG

MindStone is running.

  Open http://localhost:${CONSOLE_PORT}
MSG
  case "${admin_status}" in
    generated)
      cat <<MSG
  Sign in as ${admin_email}. The password is in ${password_file} (mode 600).
  Read it from there, then delete the file once you've stored it somewhere safe.
MSG
      ;;
    asked) printf '  Sign in as %s with the password you chose.\n' "${admin_email}" ;;
    exists)
      if [[ "${existing_role}" == "ADMIN" ]]; then
        cat <<MSG
  An admin account with the email ${admin_email} already exists in this Console,
  so no account was created and no password was set. Sign in with its own
  password. If you've lost it:
    cd "${INSTALL_DIR}" && docker compose exec console npm run reset-password
MSG
      else
        cat <<MSG
  An account with the email ${admin_email} already exists in this Console as a
  regular user (role ${existing_role}), so no account was created and no password
  was set. To make it an admin:
    $(promote_command "${admin_email}")
  Or re-run with another --admin-email: the installer then creates that account
  and makes it an admin.
MSG
      fi
      ;;
    done) ;;
    none)
      cat <<MSG
  No admin account yet (no terminal to ask in, and no --admin-email). Create one:
    curl -fsSL ${INSTALL_URL} | bash -s --${dir_flag} --admin-email you@example.com
MSG
      ;;
  esac
  if [[ "${profiles}" == *ollama* && "${ollama_url}" == "${STACK_OLLAMA_URL}" ]]; then
    cat <<MSG

  Ollama runs in the stack (service ollama), reached by the gateway as ${ollama_url}.
  Pull a chat model with: cd "${INSTALL_DIR}" && docker compose exec ollama ollama pull <model>
  Back to Ollama on this machine: run the install command again with --without-ollama.
MSG
  elif [[ "${profiles}" == *ollama* ]]; then
    cat <<MSG

  Ollama also runs in the stack (service ollama), but the gateway uses ${ollama_url}.
  To use the stack's Ollama, re-run with --with-ollama; to stop it, with --without-ollama.
MSG
  else
    printf '\n  Ollama is reached by the gateway as %s.\n' "${ollama_url}"
  fi
  if [[ -n "${previous_ollama_url}" && "${previous_ollama_url}" != "${ollama_url}" ]]; then
    cat <<MSG
  The Ollama address changed (it was ${previous_ollama_url}). If setup is already
  done, change the Ollama provider's address to ${ollama_url} in the Console
  (Settings, Your setup, model provider): chat keeps the address it was set up
  with, while memory follows the new one.
MSG
  fi
  cat <<MSG

  The Console shows a "Set up MindStone" banner until guided setup is done: it
  picks the model, the persona and memory.

Manage it (in ${INSTALL_DIR}; plain docker compose there reads .env, but a
COMPOSE_* or OLLAMA_BASE_URL exported in your shell overrides it, so unset those first):
  Status:     cd "${INSTALL_DIR}" && docker compose ps
  Logs:       cd "${INSTALL_DIR}" && docker compose logs -f gateway
  CLI:        cd "${INSTALL_DIR}" && docker compose exec gateway ./scripts/mindstone status
  Stop:       cd "${INSTALL_DIR}" && docker compose stop
  Start:      cd "${INSTALL_DIR}" && docker compose up -d
  Customise:  put your changes in ${INSTALL_DIR}/compose.override.yml (never overwritten)
  Update:     curl -fsSL ${INSTALL_URL} | bash${dir_flag:+ -s --${dir_flag}}
              (the same refs and ports as now; secrets and data are kept)
  Uninstall:  curl -fsSL ${INSTALL_URL} | bash -s --${dir_flag} --uninstall
              (stops the stack; data is kept, and it says how to delete it)
MSG
}

main "$@"
