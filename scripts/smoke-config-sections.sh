#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CONFIG="$TMP_DIR/config.json"

cat > "$CONFIG" <<'JSON'
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 19789,
    "auth": { "mode": "none" },
    "http": { "chatCompletions": { "enabled": true }, "responses": { "enabled": false } }
  },
  "channels": {
    "telegram": { "tokenEnv": "TELEGRAM_BOT_TOKEN" }
  }
}
JSON

cd "$ROOT"
if [[ ! -f "$ROOT/packages/mindstone-cli/dist/index.js" ]]; then
  echo "MindStone-Agent CLI is not built yet." >&2
  echo "Run npm run build:mindstone before this smoke." >&2
  exit 1
fi

BEFORE="$(cat "$CONFIG")"
OUTPUT="$(MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" node "$ROOT/packages/mindstone-cli/dist/index.js" config --section channels --dry-run)"
AFTER="$(cat "$CONFIG")"

if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "config --section channels --dry-run mutated config" >&2
  exit 1
fi
if ! grep -q "Channel/plugin catalog" <<<"$OUTPUT" || ! grep -q "Telegram: not implemented/validated yet" <<<"$OUTPUT" || ! grep -q "MindStone config not written" <<<"$OUTPUT"; then
  echo "config section output missing expected channel catalog/dry-run content" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

set +e
BAD_OUTPUT="$(MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" node "$ROOT/packages/mindstone-cli/dist/index.js" config --section bogus --dry-run 2>&1)"
BAD_STATUS=$?
set -e
if [[ $BAD_STATUS -eq 0 ]] || ! grep -q "Invalid config section: bogus" <<<"$BAD_OUTPUT"; then
  echo "invalid config section did not fail clearly" >&2
  echo "$BAD_OUTPUT" >&2
  exit 1
fi

echo "config section CLI smoke passed"
