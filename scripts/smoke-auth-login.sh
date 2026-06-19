#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"
cd "${MINDSTONE_AGENT_ROOT}"

npm run build:mindstone >/tmp/mindstone-agent-auth-login-build.log

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "${TMP_ROOT}"' EXIT
RUNTIME_DIR="${TMP_ROOT}/runtime"
AUTH_PATH="${RUNTIME_DIR}/pi-agent/auth.json"

output="$(PATH="${MINDSTONE_AGENT_ROOT}/node_modules/.bin:${PATH}" \
  MINDSTONE_AGENT_RUNTIME_DIR="${RUNTIME_DIR}" \
  PI_CODING_AGENT_DIR="${RUNTIME_DIR}/pi-agent" \
  PI_CODING_AGENT_SESSION_DIR="${RUNTIME_DIR}/pi-sessions" \
  MINDSTONE_AGENT_DATA_DIR="${RUNTIME_DIR}/mindstone" \
  mindstone auth login openai-codex --dry-run)"

echo "${output}"

if ! grep -q "MindStone would start embedded subscription/OAuth login for openai-codex" <<<"${output}"; then
  echo "auth login dry-run did not use the embedded MindStone OAuth path" >&2
  exit 1
fi
if ! grep -q "Credential target: ${AUTH_PATH}" <<<"${output}"; then
  echo "auth login dry-run did not target isolated auth.json" >&2
  exit 1
fi
if ! grep -q "Global Pi auth is not used" <<<"${output}"; then
  echo "auth login dry-run did not state global Pi auth is avoided" >&2
  exit 1
fi
if grep -Eq "scripts/pi-agent|/login|type:|cannot be completed" <<<"${output}"; then
  echo "auth login dry-run regressed to instructing users to operate Pi directly" >&2
  exit 1
fi
if [[ -f "${AUTH_PATH}" ]]; then
  echo "auth login dry-run created an auth file" >&2
  exit 1
fi

echo "mindstone auth login smoke passed."
