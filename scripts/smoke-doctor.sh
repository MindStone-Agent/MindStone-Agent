#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$ROOT"
MINDSTONE_AGENT_RUNTIME_DIR="$TMP_DIR/runtime" ./scripts/init-runtime.sh >/tmp/mindstone-agent-doctor-init.log

output="$(MINDSTONE_AGENT_RUNTIME_DIR="$TMP_DIR/runtime" ./scripts/mindstone doctor)"
printf '%s\n' "$output"

grep -q "MindStone-Agent doctor" <<<"$output"
grep -q "session.mode" <<<"$output"
grep -q "routing.mode" <<<"$output"
grep -q "Result: ok" <<<"$output"

echo "doctor smoke passed"
