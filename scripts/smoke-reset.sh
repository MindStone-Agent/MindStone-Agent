#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

cd "$ROOT"

mkdir -p "$TMP_ROOT/.runtime/mindstone/agents/default" "$TMP_ROOT/.runtime/pi-agent" "$TMP_ROOT/.runtime/pi-sessions"
printf '{"ok":true}\n' > "$TMP_ROOT/.runtime/mindstone/config.json"
printf '# Test Identity\n' > "$TMP_ROOT/.runtime/mindstone/agents/default/IDENTITY.md"
printf '{"auth":"sentinel"}\n' > "$TMP_ROOT/.runtime/pi-agent/auth.json"
printf '{"models":"sentinel"}\n' > "$TMP_ROOT/.runtime/pi-agent/models.json"
printf 'session sentinel\n' > "$TMP_ROOT/.runtime/pi-sessions/test.jsonl"

MINDSTONE_AGENT_ROOT="$TMP_ROOT" node packages/mindstone-cli/dist/index.js reset --dry-run >/tmp/mindstone-reset-dry-run.txt
if [ ! -f "$TMP_ROOT/.runtime/mindstone/config.json" ]; then
  echo "dry-run deleted config" >&2
  exit 1
fi

MINDSTONE_AGENT_ROOT="$TMP_ROOT" node packages/mindstone-cli/dist/index.js reset --keep-pi-auth --confirm "RESET MINDSTONE" >/tmp/mindstone-reset-run.txt
if [ -f "$TMP_ROOT/.runtime/mindstone/config.json" ]; then
  echo "reset did not delete config" >&2
  exit 1
fi
if [ -f "$TMP_ROOT/.runtime/pi-sessions/test.jsonl" ]; then
  echo "reset did not delete pi session state" >&2
  exit 1
fi
if [ ! -f "$TMP_ROOT/.runtime/pi-agent/auth.json" ] || [ ! -f "$TMP_ROOT/.runtime/pi-agent/models.json" ]; then
  echo "reset --keep-pi-auth did not preserve auth/models" >&2
  exit 1
fi
if ! grep -q 'auth' "$TMP_ROOT/.runtime/pi-agent/auth.json"; then
  echo "auth sentinel not preserved" >&2
  exit 1
fi
if ! grep -q 'MindStone runtime reset complete' /tmp/mindstone-reset-run.txt; then
  echo "reset output missing completion line" >&2
  exit 1
fi

mkdir -p "$TMP_ROOT/.runtime/mindstone"
printf '{}\n' > "$TMP_ROOT/.runtime/mindstone/config.json"
set +e
MINDSTONE_AGENT_ROOT="$TMP_ROOT" node packages/mindstone-cli/dist/index.js reset --confirm WRONG >/tmp/mindstone-reset-wrong.txt 2>&1
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "reset accepted wrong confirmation" >&2
  exit 1
fi
if [ ! -f "$TMP_ROOT/.runtime/mindstone/config.json" ]; then
  echo "wrong confirmation deleted config" >&2
  exit 1
fi

echo "reset smoke passed: $TMP_ROOT"
