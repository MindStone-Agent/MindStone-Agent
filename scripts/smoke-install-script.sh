#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

bash -n install.sh
help_output="$(./install.sh --help)"
echo "${help_output}"

if ! grep -q "MindStone-Agent installer" <<<"${help_output}"; then
  echo "install.sh help did not render expected title" >&2
  exit 1
fi
if ! grep -q -- "--no-link" <<<"${help_output}"; then
  echo "install.sh help did not document --no-link" >&2
  exit 1
fi
if ! grep -q "curl -fsSL" <<<"${help_output}"; then
  echo "install.sh help did not document curl usage" >&2
  exit 1
fi

echo "install.sh smoke passed."
