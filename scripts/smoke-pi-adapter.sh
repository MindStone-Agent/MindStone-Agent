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
const tools = new Map();
mod.default({
  registerCommand(name, command) {
    commands.set(name, command);
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
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
for (const name of ['mindstone-agent-status', 'mindstone-status', 'mindstone-context', 'mindstone-gateway-status', 'mindstone-channels', 'mindstone-recall-status', 'mindstone-recall-search', 'mindstone-config', 'mindstone-setup']) {
  if (!commands.has(name)) throw new Error(`missing command ${name}`);
}
for (const name of ['mindstone_memory_status', 'mindstone_memory_search', 'mindstone_memory_read']) {
  if (!tools.has(name)) throw new Error(`missing tool ${name}`);
}
await commands.get('mindstone-agent-status').handler('', ctx);
await commands.get('mindstone-status').handler('', ctx);
await commands.get('mindstone-context').handler('', ctx);
await commands.get('mindstone-gateway-status').handler('', ctx);
await commands.get('mindstone-channels').handler('', ctx);
await commands.get('mindstone-recall-status').handler('', ctx);
await commands.get('mindstone-recall-search').handler('adapter recall sentinel --limit 3', ctx);
const statusTool = await tools.get('mindstone_memory_status').execute('tool-status', {});
const searchTool = await tools.get('mindstone_memory_search').execute('tool-search', { query: 'adapter recall sentinel', limit: 3 });
const readTool = await tools.get('mindstone_memory_read').execute('tool-read', { id: 'memory/reference_adapter_recall_smoke.md' });
const missingReadTool = await tools.get('mindstone_memory_read').execute('tool-missing-read', { id: '../not-allowed' });
console.log(JSON.stringify({
  commands: [...commands.keys()].sort(),
  tools: [...tools.keys()].sort(),
  notifications,
  toolResults: { statusTool, searchTool, readTool, missingReadTool },
}, null, 2));
NODE
)"

echo "${OUTPUT}"

if ! grep -q 'mindstone-status' <<<"${OUTPUT}" || ! grep -q 'mindstone-context' <<<"${OUTPUT}" || ! grep -q 'mindstone-gateway-status' <<<"${OUTPUT}" || ! grep -q 'mindstone-channels' <<<"${OUTPUT}" || ! grep -q 'mindstone-setup' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing status/context/gateway/channels/setup commands" >&2
  exit 1
fi
if ! grep -q 'mindstone-recall-status' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing recall status command" >&2
  exit 1
fi
if ! grep -q 'mindstone-recall-search' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing recall search command" >&2
  exit 1
fi
if ! grep -q 'mindstone_memory_status' <<<"${OUTPUT}" || ! grep -q 'mindstone_memory_search' <<<"${OUTPUT}" || ! grep -q 'mindstone_memory_read' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing memory tool registration" >&2
  exit 1
fi
if ! grep -q 'MindStone-Agent runtime isolation' <<<"${OUTPUT}"; then
  echo "Pi adapter status command did not report runtime isolation" >&2
  exit 1
fi
if ! grep -q 'MindStone context status' <<<"${OUTPUT}" || ! grep -q 'Default agent:' <<<"${OUTPUT}"; then
  echo "Pi adapter context command did not report context status" >&2
  exit 1
fi
if ! grep -q 'MindStone Gateway status' <<<"${OUTPUT}" || ! grep -q 'Live probe: not run by this command' <<<"${OUTPUT}"; then
  echo "Pi adapter gateway status command did not report non-probing gateway status" >&2
  exit 1
fi
if ! grep -q 'MindStone channel/surface status' <<<"${OUTPUT}" || ! grep -q 'Telegram: not implemented/validated' <<<"${OUTPUT}" || ! grep -q 'diagnostic only' <<<"${OUTPUT}"; then
  echo "Pi adapter channels command did not report honest channel status" >&2
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
if ! grep -q 'MindStone memory document' <<<"${OUTPUT}" || ! grep -q 'reference_adapter_recall_smoke.md' <<<"${OUTPUT}"; then
  echo "Pi adapter memory read tool did not return the discovered memory document" >&2
  exit 1
fi
if ! grep -q "No MindStone memory document matched '../not-allowed'" <<<"${OUTPUT}"; then
  echo "Pi adapter memory read tool did not reject undiscovered path" >&2
  exit 1
fi

echo "MindStone Pi adapter smoke test passed."
