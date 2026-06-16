#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"

"${SCRIPT_DIR}/build-pi-base.sh"

cat <<MSG
MindStone-Agent native foundation installed.

Isolated Pi agent dir:     ${PI_CODING_AGENT_DIR}
Isolated Pi session dir:   ${PI_CODING_AGENT_SESSION_DIR}
MindStone-Agent data dir:  ${MINDSTONE_AGENT_DATA_DIR}

Run isolated Pi with:
  ./scripts/pi-agent

Do not run bare 'pi' for this project.
MSG
