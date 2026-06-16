#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"

cd "${MINDSTONE_AGENT_ROOT}/vendor/pi"
if [[ ! -d node_modules ]]; then
  HUSKY=0 npm install
fi
HUSKY=0 npm run build
