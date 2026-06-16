#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"

AGENT_DIR="${MINDSTONE_AGENT_DATA_DIR}/agents/default"
CONFIG_PATH="${MINDSTONE_AGENT_CONFIG:-${MINDSTONE_AGENT_DATA_DIR}/config.json}"

mkdir -p "${AGENT_DIR}" "$(dirname "${CONFIG_PATH}")"

if [[ ! -f "${AGENT_DIR}/IDENTITY.md" ]]; then
  cat >"${AGENT_DIR}/IDENTITY.md" <<'EOF'
# Default MindStone Agent

This is a placeholder identity for a newly initialized MindStone-Agent runtime.
Replace it during onboarding with the agent's real identity.
EOF
fi

if [[ ! -f "${AGENT_DIR}/USER.md" ]]; then
  cat >"${AGENT_DIR}/USER.md" <<'EOF'
# User Context

This is placeholder user context for a newly initialized MindStone-Agent runtime.
Replace it during onboarding with approved user/project context.
EOF
fi

if [[ ! -f "${CONFIG_PATH}" ]]; then
  cat >"${CONFIG_PATH}" <<'EOF'
{
  "workspace": {
    "root": "."
  },
  "gateway": {
    "host": "127.0.0.1",
    "port": 19789,
    "auth": {
      "mode": "none"
    },
    "http": {
      "chatCompletions": {
        "enabled": false
      },
      "responses": {
        "enabled": false
      }
    }
  },
  "agents": {
    "default": {
      "id": "default",
      "identityPath": "agents/default/IDENTITY.md",
      "userPath": "agents/default/USER.md"
    }
  },
  "memory": {
    "autoRecall": false,
    "vectorStore": "sqlite-vec"
  }
}
EOF
fi

cat <<MSG
Initialized MindStone-Agent runtime if missing.

Config:   ${CONFIG_PATH}
Identity: ${AGENT_DIR}/IDENTITY.md
User:     ${AGENT_DIR}/USER.md
MSG
