#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

npm run build:mindstone
npm link

cat <<MSG
MindStone-Agent CLI linked.

You should now be able to run:
  mindstone status
  mindstone onboard
  mindstone config

This command uses the package bin wrapper, which bootstraps isolated runtime paths under:
  ${ROOT}/.runtime
MSG
