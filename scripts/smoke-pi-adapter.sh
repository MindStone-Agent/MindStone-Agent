#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-pi-adapter-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"

cd "${PROJECT_ROOT}"

echo "== MindStone Pi adapter smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-pi-adapter-init.log

mkdir -p "${TEMP_RUNTIME}/mindstone/memory"
cat >"${TEMP_RUNTIME}/mindstone/memory/reference_adapter_recall_smoke.md" <<'MD'
---
name: reference_adapter_recall_smoke
description: Adapter recall smoke sentinel.
type: reference
tags: [pi-adapter, smoke]
projects: [MindStone-Agent]
critical: false
evergreen: false
---

# Adapter recall smoke

Adapter recall sentinel verifies that the MindStone Pi adapter can search local memory without live model auth.
MD

OUTPUT="$(node <<'NODE'
const mod = await import('./packages/mindstone-pi-adapter/dist/index.js');
const commands = new Map();
mod.default({
  registerCommand(name, command) {
    commands.set(name, command);
  },
});
const notifications = [];
const ctx = {
  ui: {
    async select(_title, options) { return options[0]; },
    async confirm() { return true; },
    async input(_title, placeholder) { return placeholder; },
    notify(message, kind = 'info') { notifications.push({ kind, message }); },
  },
};
for (const name of ['mindstone-agent-status', 'mindstone-recall-status', 'mindstone-recall-search', 'mindstone-config']) {
  if (!commands.has(name)) throw new Error(`missing command ${name}`);
}
await commands.get('mindstone-agent-status').handler('', ctx);
await commands.get('mindstone-recall-status').handler('', ctx);
await commands.get('mindstone-recall-search').handler('adapter recall sentinel --limit 3', ctx);
console.log(JSON.stringify({
  commands: [...commands.keys()].sort(),
  notifications,
}, null, 2));
NODE
)"

echo "${OUTPUT}"

if ! grep -q 'mindstone-recall-status' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing recall status command" >&2
  exit 1
fi
if ! grep -q 'mindstone-recall-search' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing recall search command" >&2
  exit 1
fi
if ! grep -q 'MindStone-Agent runtime isolation' <<<"${OUTPUT}"; then
  echo "Pi adapter status command did not report runtime isolation" >&2
  exit 1
fi
if ! grep -q 'MindStone memory status' <<<"${OUTPUT}"; then
  echo "Pi adapter recall status command did not report memory status" >&2
  exit 1
fi
if ! grep -q 'MindStone recall search: adapter recall sentinel' <<<"${OUTPUT}"; then
  echo "Pi adapter recall search command did not report query" >&2
  exit 1
fi
if ! grep -q 'Adapter recall sentinel verifies' <<<"${OUTPUT}"; then
  echo "Pi adapter recall search command did not return local memory hit" >&2
  exit 1
fi

echo "MindStone Pi adapter smoke test passed."
