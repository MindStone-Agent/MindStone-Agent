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

mkdir -p "${TEMP_RUNTIME}/mindstone/memory" "${TEMP_RUNTIME}/mindstone/agents/default"
cat >"${TEMP_RUNTIME}/mindstone/agents/default/IDENTITY.md" <<'MD'
# Pi Adapter Smoke Identity

Identity sentinel: PI-ADAPTER-SMOKE-IDENTITY.
MD
cat >"${TEMP_RUNTIME}/mindstone/agents/default/USER.md" <<'MD'
# Pi Adapter Smoke User

User sentinel: PI-ADAPTER-SMOKE-USER.
MD
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

Adapter recall sentinel verifies that the MindStone Pi adapter can search local memory and inject ephemeral recall without live model auth.
MD

node <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const path = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(path, 'utf8'));
config.memory = { ...(config.memory ?? {}), autoRecall: true };
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

OUTPUT="$(node <<'NODE'
const { readFileSync, existsSync } = await import('node:fs');
const mod = await import('./packages/mindstone-pi-adapter/dist/index.js');
const commands = new Map();
const tools = new Map();
const handlers = new Map();
mod.default({
  on(event, handler) {
    handlers.set(event, handler);
  },
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
for (const name of ['mindstone-agent-status', 'mindstone-status', 'mindstone-context', 'mindstone-gateway-status', 'mindstone-channels', 'mindstone-transcript-status', 'mindstone-recall-status', 'mindstone-recall-search', 'mindstone-config', 'mindstone-setup']) {
  if (!commands.has(name)) throw new Error(`missing command ${name}`);
}
for (const name of ['mindstone_memory_status', 'mindstone_memory_search', 'mindstone_memory_read', 'mindstone_transcript_status']) {
  if (!tools.has(name)) throw new Error(`missing tool ${name}`);
}
if (!handlers.has('session_shutdown')) throw new Error('missing session_shutdown handler');
if (!handlers.has('session_compact')) throw new Error('missing session_compact handler');
if (!handlers.has('session_tree')) throw new Error('missing session_tree handler');
if (!handlers.has('before_agent_start')) throw new Error('missing before_agent_start handler');
await commands.get('mindstone-agent-status').handler('', ctx);
await commands.get('mindstone-status').handler('', ctx);
await commands.get('mindstone-context').handler('', ctx);
await commands.get('mindstone-gateway-status').handler('', ctx);
await commands.get('mindstone-channels').handler('', ctx);
await commands.get('mindstone-transcript-status').handler('', ctx);
await commands.get('mindstone-recall-status').handler('', ctx);
await commands.get('mindstone-recall-search').handler('adapter recall sentinel --limit 3', ctx);
const statusTool = await tools.get('mindstone_memory_status').execute('tool-status', {});
const searchTool = await tools.get('mindstone_memory_search').execute('tool-search', { query: 'adapter recall sentinel', limit: 3 });
const readTool = await tools.get('mindstone_memory_read').execute('tool-read', { id: 'memory/reference_adapter_recall_smoke.md' });
const missingReadTool = await tools.get('mindstone_memory_read').execute('tool-missing-read', { id: '../not-allowed' });
const transcriptBeforeShutdownTool = await tools.get('mindstone_transcript_status').execute('tool-transcript-before', {});
const promptContextResult = await handlers.get('before_agent_start')({
  type: 'before_agent_start',
  prompt: 'adapter recall sentinel',
  systemPrompt: 'base system prompt',
}, ctx);
await handlers.get('session_compact')({
  type: 'session_compact',
  fromExtension: false,
  compactionEntry: {
    id: 'compact-1',
    parentId: 'parent-1',
    timestamp: '2026-06-18T00:00:00.000Z',
    firstKeptEntryId: 'kept-1',
    tokensBefore: 12345,
    summary: 'RAW-COMPACTION-SUMMARY-SHOULD-NOT-PERSIST',
    details: { rawSecret: 'RAW-COMPACTION-DETAIL-SHOULD-NOT-PERSIST' },
  },
}, ctx);
await handlers.get('session_tree')({
  type: 'session_tree',
  newLeafId: 'leaf-new',
  oldLeafId: 'leaf-old',
  fromExtension: false,
  summaryEntry: {
    id: 'summary-1',
    parentId: 'parent-2',
    timestamp: '2026-06-18T00:00:01.000Z',
    fromId: 'leaf-old',
    summary: 'RAW-TREE-SUMMARY-SHOULD-NOT-PERSIST',
    details: { rawTreeSecret: 'RAW-TREE-DETAIL-SHOULD-NOT-PERSIST' },
  },
}, ctx);
await handlers.get('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, ctx);
const transcriptAfterShutdownTool = await tools.get('mindstone_transcript_status').execute('tool-transcript-after', {});
const transcriptPath = transcriptAfterShutdownTool.details.path;
const transcriptContent = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '';
console.log(JSON.stringify({
  commands: [...commands.keys()].sort(),
  tools: [...tools.keys()].sort(),
  handlers: [...handlers.keys()].sort(),
  notifications,
  promptContextResult,
  toolResults: { statusTool, searchTool, readTool, missingReadTool, transcriptBeforeShutdownTool, transcriptAfterShutdownTool },
  transcriptContent,
}, null, 2));
NODE
)"

echo "${OUTPUT}"

if ! grep -q 'mindstone-status' <<<"${OUTPUT}" || ! grep -q 'mindstone-context' <<<"${OUTPUT}" || ! grep -q 'mindstone-gateway-status' <<<"${OUTPUT}" || ! grep -q 'mindstone-channels' <<<"${OUTPUT}" || ! grep -q 'mindstone-transcript-status' <<<"${OUTPUT}" || ! grep -q 'mindstone-setup' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing status/context/gateway/channels/transcript/setup commands" >&2
  exit 1
fi
if ! grep -q 'session_shutdown' <<<"${OUTPUT}" || ! grep -q 'session_compact' <<<"${OUTPUT}" || ! grep -q 'session_tree' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing lifecycle handlers" >&2
  exit 1
fi
if ! grep -q 'before_agent_start' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing before_agent_start handler" >&2
  exit 1
fi
if ! grep -q 'PI-ADAPTER-SMOKE-IDENTITY' <<<"${OUTPUT}" || ! grep -q 'PI-ADAPTER-SMOKE-USER' <<<"${OUTPUT}" || ! grep -q 'mindstone-identity' <<<"${OUTPUT}"; then
  echo "Pi adapter before_agent_start hook did not inject identity/user prompt context" >&2
  exit 1
fi
if ! grep -q 'mindstone-ephemeral-recall' <<<"${OUTPUT}" || ! grep -q 'Relevant MindStone memory follows' <<<"${OUTPUT}" || ! grep -q 'inject ephemeral recall' <<<"${OUTPUT}"; then
  echo "Pi adapter before_agent_start hook did not inject autoRecall context" >&2
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
if ! grep -q 'mindstone_memory_status' <<<"${OUTPUT}" || ! grep -q 'mindstone_memory_search' <<<"${OUTPUT}" || ! grep -q 'mindstone_memory_read' <<<"${OUTPUT}" || ! grep -q 'mindstone_transcript_status' <<<"${OUTPUT}"; then
  echo "Pi adapter smoke output missing memory/transcript tool registration" >&2
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
if ! grep -q 'MindStone transcript status' <<<"${OUTPUT}" || ! grep -q 'Transcript status is diagnostic only' <<<"${OUTPUT}"; then
  echo "Pi adapter transcript status command/tool did not report diagnostic transcript status" >&2
  exit 1
fi
if ! grep -q 'pi_adapter_session_shutdown' <<<"${OUTPUT}" || ! grep -q 'pi_adapter_session_compact' <<<"${OUTPUT}" || ! grep -q 'pi_adapter_session_tree' <<<"${OUTPUT}" || ! grep -q 'lifecycle_marker_only' <<<"${OUTPUT}"; then
  echo "Pi adapter lifecycle hooks did not append sanitized markers" >&2
  exit 1
fi
if grep -q 'RAW-COMPACTION-SUMMARY-SHOULD-NOT-PERSIST' <<<"${OUTPUT}" || grep -q 'RAW-TREE-SUMMARY-SHOULD-NOT-PERSIST' <<<"${OUTPUT}" || grep -q 'RAW-COMPACTION-DETAIL-SHOULD-NOT-PERSIST' <<<"${OUTPUT}" || grep -q 'RAW-TREE-DETAIL-SHOULD-NOT-PERSIST' <<<"${OUTPUT}"; then
  echo "Pi adapter lifecycle hooks persisted raw summary/detail content" >&2
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
