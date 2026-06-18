#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

echo "== MindStone Core boundary smoke test =="

npx tsc -b packages/mindstone-core

if rg -n "@mindstone-agent/(gateway|pi-adapter|cli)|packages/mindstone-(gateway|pi-adapter|cli)|\.\./(\.\./)?mindstone-(gateway|pi-adapter|cli)" packages/mindstone-core/src; then
  echo "mindstone-core imports a non-Core package" >&2
  exit 1
fi

if rg -n "from ['\"](@earendil-works/pi-coding-agent|@earendil-works/pi-ai|@earendil-works/pi-tui)|from ['\"]\.\./\.\./\.\./vendor/pi" packages/mindstone-core/src; then
  echo "mindstone-core imports Pi-specific packages directly" >&2
  exit 1
fi

echo "MindStone Core boundary smoke test passed."
