#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"
cat <<MSG
MindStone-Agent isolation paths

Project root:              ${MINDSTONE_AGENT_ROOT}
Runtime dir:               ${MINDSTONE_AGENT_RUNTIME_DIR}
Pi agent/config dir:       ${PI_CODING_AGENT_DIR}
Pi session dir:            ${PI_CODING_AGENT_SESSION_DIR}
Pi package dir:            ${PI_PACKAGE_DIR}
MindStone data dir:        ${MINDSTONE_AGENT_DATA_DIR}
MindStone token dir:       ${MINDSTONE_AGENT_TOKEN_DIR}
MindStone vector dir:      ${MINDSTONE_AGENT_VECTOR_DIR}
MindStone transcript dir:  ${MINDSTONE_AGENT_TRANSCRIPT_DIR}

Host provider env allowed: ${MSA_ALLOW_HOST_PROVIDER_ENV:-0}
Project env file:          ${MINDSTONE_AGENT_RUNTIME_DIR}/env.local
MSG
