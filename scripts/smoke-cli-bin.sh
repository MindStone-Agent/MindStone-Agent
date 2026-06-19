#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"
cd "${MINDSTONE_AGENT_ROOT}"

npm run build:mindstone >/tmp/mindstone-agent-cli-bin-build.log

BIN="${MINDSTONE_AGENT_ROOT}/node_modules/.bin/mindstone"
if [[ ! -x "${BIN}" ]]; then
  echo "mindstone bin is not executable: ${BIN}" >&2
  exit 1
fi

output="$(PATH="${MINDSTONE_AGENT_ROOT}/node_modules/.bin:${PATH}" mindstone status)"
echo "${output}"

if ! grep -q "MindStone-Agent status" <<<"${output}"; then
  echo "mindstone status did not run through the package bin" >&2
  exit 1
fi
if ! grep -q "Pi agent dir: ${MINDSTONE_AGENT_ROOT}/.runtime/pi-agent" <<<"${output}"; then
  echo "mindstone package bin did not bootstrap isolated Pi agent dir" >&2
  exit 1
fi
if ! grep -q "Data dir: ${MINDSTONE_AGENT_ROOT}/.runtime/mindstone" <<<"${output}"; then
  echo "mindstone package bin did not bootstrap isolated MindStone data dir" >&2
  exit 1
fi

echo "mindstone package bin smoke passed."
