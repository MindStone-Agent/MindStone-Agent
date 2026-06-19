#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO="https://github.com/MindStone-Agent/MindStone-Agent.git"
DEFAULT_BRANCH="main"
DEFAULT_DIR="${HOME}/.mindstone-agent/MindStone-Agent"

REPO="${MINDSTONE_AGENT_INSTALL_REPO:-${DEFAULT_REPO}}"
BRANCH="${MINDSTONE_AGENT_INSTALL_BRANCH:-${DEFAULT_BRANCH}}"
INSTALL_DIR="${MINDSTONE_AGENT_INSTALL_DIR:-${DEFAULT_DIR}}"
LINK_CLI=1
RUN_ONBOARD=0
UPDATE_EXISTING=1

usage() {
  cat <<'USAGE'
MindStone-Agent installer

Usage:
  install.sh [options]

Options:
  --dir PATH        Install/checkout directory. Default: ~/.mindstone-agent/MindStone-Agent
  --repo URL        Git repository URL. Default: https://github.com/MindStone-Agent/MindStone-Agent.git
  --branch NAME     Git branch/ref to checkout. Default: main
  --no-link         Do not run npm link; use ./node_modules/.bin/mindstone instead
  --no-update       If checkout already exists, do not git fetch/pull
  --onboard         Run mindstone onboard after install
  --help            Show this help

Environment overrides:
  MINDSTONE_AGENT_INSTALL_DIR
  MINDSTONE_AGENT_INSTALL_REPO
  MINDSTONE_AGENT_INSTALL_BRANCH

Examples:
  curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install.sh | bash

  curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install.sh | \
    bash -s -- --dir "$HOME/Projects/MindStone-Agent" --no-link
USAGE
}

log() {
  printf '\033[38;5;214m[MindStone-Agent]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[31m[MindStone-Agent install error]\033[0m %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      [[ $# -ge 2 ]] || fail "--dir requires a path"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || fail "--repo requires a URL"
      REPO="$2"
      shift 2
      ;;
    --branch)
      [[ $# -ge 2 ]] || fail "--branch requires a branch/ref"
      BRANCH="$2"
      shift 2
      ;;
    --no-link)
      LINK_CLI=0
      shift
      ;;
    --no-update)
      UPDATE_EXISTING=0
      shift
      ;;
    --onboard)
      RUN_ONBOARD=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

need_cmd git
need_cmd node
need_cmd npm

node - <<'NODE' || fail "Node.js >= 22.19.0 is required. Install a current Node.js first."
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)))) process.exit(0);
process.exit(1);
NODE

INSTALL_DIR="$(python3 -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "${INSTALL_DIR}" 2>/dev/null || printf '%s' "${INSTALL_DIR}")"

log "Repository: ${REPO}"
log "Branch/ref: ${BRANCH}"
log "Install dir: ${INSTALL_DIR}"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log "Existing checkout found."
  cd "${INSTALL_DIR}"
  if [[ "${UPDATE_EXISTING}" == "1" ]]; then
    log "Updating existing checkout..."
    git fetch origin "${BRANCH}"
    git checkout "${BRANCH}" 2>/dev/null || git checkout -B "${BRANCH}" "origin/${BRANCH}"
    git pull --ff-only origin "${BRANCH}"
  else
    log "Skipping checkout update because --no-update was supplied."
  fi
elif [[ -e "${INSTALL_DIR}" && -n "$(find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]]; then
  fail "Install directory exists and is not an empty git checkout: ${INSTALL_DIR}"
else
  log "Cloning MindStone-Agent..."
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone --branch "${BRANCH}" "${REPO}" "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
fi

log "Installing npm dependencies..."
npm install

log "Building and initializing isolated native runtime..."
npm run install:native

if [[ "${LINK_CLI}" == "1" ]]; then
  log "Linking mindstone CLI onto PATH with npm link..."
  npm run link:cli
  MINDSTONE_CMD="mindstone"
else
  log "Skipping global CLI link."
  MINDSTONE_CMD="${INSTALL_DIR}/node_modules/.bin/mindstone"
fi

log "Verifying CLI status..."
"${MINDSTONE_CMD}" status >/tmp/mindstone-agent-install-status.txt
cat /tmp/mindstone-agent-install-status.txt

cat <<MSG

MindStone-Agent installed.

Next commands:
  ${MINDSTONE_CMD} onboard
  ${MINDSTONE_CMD} config
  ${MINDSTONE_CMD} status

Runtime state is isolated under:
  ${INSTALL_DIR}/.runtime

For OpenAI subscription/Codex auth, configure routing to Pi AgentSession, then use isolated Pi login when prompted:
  cd ${INSTALL_DIR}
  ./scripts/pi-agent
  /login openai-codex
MSG

if [[ "${RUN_ONBOARD}" == "1" ]]; then
  log "Starting onboarding..."
  "${MINDSTONE_CMD}" onboard
fi
