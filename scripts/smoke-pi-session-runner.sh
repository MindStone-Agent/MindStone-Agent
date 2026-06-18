#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-pi-session-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== Pi session-backed runner smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-pi-session-init.log

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const piAgentDir = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = {
  mode: "pi-session",
  defaultAgentId: "default",
  defaultModel: "openai/gpt-5.1",
  pi: { agentDir: piAgentDir },
};
config.session = {
  mode: "single",
  defaultSessionKey: "agent:default:main",
};
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, '# Pi Session Smoke Identity\n\nIdentity sentinel: PI-SESSION-SMOKE-IDENTITY.');
writeFileSync(`${runtime}/agents/default/USER.md`, '# Pi Session Smoke User\n\nUser sentinel: PI-SESSION-SMOKE-USER.');
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

node --input-type=module <<'NODE'
import { createProviderRouteAgentRunner, providerDiagnosticsFromChatResult } from './packages/mindstone-core/dist/index.js';
import { applyPiSessionCompactionSettings, buildMindStonePiExtensionFactories, buildPiSessionPromptParts, buildPiSessionResourceLoaderOptions, capPiSessionManagerOnLoad, createMindStoneCompactionSafeguardExtension, createPiSessionEventCapture, DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR, PiSessionAgentRunner, piSessionFileForKey, repairPiSessionFileTailIfNeeded, resolvePiSessionResumeCapOptions, withPiSessionFileLock } from './packages/mindstone-gateway/dist/index.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const expected = resolve(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions/${Buffer.from(process.env.CHAT_SESSION_KEY, 'utf8').toString('base64url')}.jsonl`);
const actual = piSessionFileForKey(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions`, process.env.CHAT_SESSION_KEY);
console.log(JSON.stringify({ sessionKey: process.env.CHAT_SESSION_KEY, sessionFile: actual }, null, 2));
if (actual !== expected) process.exit(1);

const lockOrder = [];
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const firstLock = withPiSessionFileLock('/tmp/mindstone-pi-session-lock-smoke.jsonl', async () => {
  lockOrder.push('first:start');
  await delay(25);
  lockOrder.push('first:end');
  return 'first';
});
const secondLock = withPiSessionFileLock('/tmp/mindstone-pi-session-lock-smoke.jsonl', async () => {
  lockOrder.push('second:start');
  lockOrder.push('second:end');
  return 'second';
});
const lockResults = await Promise.all([firstLock, secondLock]);
if (lockResults.join(',') !== 'first,second') throw new Error('session lock results were unexpected');
if (lockOrder.join(',') !== 'first:start,first:end,second:start,second:end') throw new Error(`session lock did not serialize same-file operations: ${lockOrder.join(',')}`);

const staleSessionFile = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions/stale-lock-smoke.jsonl`;
const staleLockFile = `${staleSessionFile}.lock`;
mkdirSync(dirname(staleLockFile), { recursive: true });
writeFileSync(staleLockFile, JSON.stringify({ token: 'stale', pid: 0, createdAt: '1970-01-01T00:00:00.000Z' }));
await delay(20);
const staleResult = await withPiSessionFileLock(staleSessionFile, async () => 'stale-cleared', {
  staleMs: 1,
  timeoutMs: 500,
  retryDelayMs: 5,
});
if (staleResult !== 'stale-cleared') throw new Error('stale cross-process lock was not cleared');
if (existsSync(staleLockFile)) throw new Error('cross-process lock file was not released');

const repairSessionFile = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions/repair-tail-smoke.jsonl`;
const validHeader = JSON.stringify({ type: 'session', version: 3, id: 'repair-smoke', timestamp: new Date().toISOString(), cwd: process.cwd() });
const validMessage = JSON.stringify({ type: 'message', id: 'msg-1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'repair sentinel' } });
writeFileSync(repairSessionFile, `${validHeader}\n${validMessage}\n{"type":"message","id":"partial`);
const repairResult = repairPiSessionFileTailIfNeeded(repairSessionFile);
if (!repairResult.repaired || repairResult.reason !== 'trailing_malformed_jsonl') throw new Error(`session tail repair did not run: ${JSON.stringify(repairResult)}`);
if (!repairResult.backupFile || !existsSync(repairResult.backupFile)) throw new Error('session tail repair backup missing');
const repairedContent = readFileSync(repairSessionFile, 'utf-8');
if (repairedContent.includes('partial')) throw new Error('session tail repair did not trim malformed tail');
if (repairedContent.trim().split('\n').length !== 2) throw new Error('session tail repair did not preserve valid entries');
const cleanRepairResult = repairPiSessionFileTailIfNeeded(repairSessionFile);
if (cleanRepairResult.repaired || cleanRepairResult.reason !== 'clean') throw new Error(`clean session file should not repair: ${JSON.stringify(cleanRepairResult)}`);

function createFakeSessionManager(entries, sessionFile = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions/resume-cap-smoke.jsonl`) {
  const header = { type: 'session', id: 'resume-cap-smoke', version: 3, timestamp: new Date().toISOString(), cwd: process.cwd() };
  const manager = {
    fileEntries: [header, ...entries],
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    labelsById: new Map(),
    labelTimestampsById: new Map(),
    leafId: entries.at(-1)?.id ?? null,
    flushed: true,
    getSessionFile() { return sessionFile; },
    getBranch() {
      const out = [];
      let current = this.leafId ? this.byId.get(this.leafId) : undefined;
      while (current) {
        out.unshift(current);
        current = current.parentId ? this.byId.get(current.parentId) : undefined;
      }
      return out;
    },
  };
  return manager;
}
function msg(id, parentId, role = 'user', extra = {}) {
  return { type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role, content: `${role}:${id}`, ...extra } };
}
const resumeCapOptions = resolvePiSessionResumeCapOptions({ maxEntries: 3 });
if (!resumeCapOptions || resumeCapOptions.maxEntries !== 3 || resumeCapOptions.dropErrorTurns !== true) throw new Error('resume cap options did not resolve');
if (resolvePiSessionResumeCapOptions({ enabled: false }) !== undefined) throw new Error('disabled resume cap should resolve undefined');
const resumeFile = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions/resume-cap-disk-preserve.jsonl`;
mkdirSync(dirname(resumeFile), { recursive: true });
writeFileSync(resumeFile, 'disk must remain untouched');
const cappedManager = createFakeSessionManager([
  msg('m1', null), msg('m2', 'm1'), msg('m3', 'm2'), msg('m4', 'm3'), msg('m5', 'm4'),
], resumeFile);
const capStats = capPiSessionManagerOnLoad(cappedManager, resumeCapOptions);
if (capStats.action !== 'capped' || capStats.dropped !== 2 || capStats.kept !== 3 || capStats.messageEmittersKept !== 3) throw new Error(`resume cap stats wrong: ${JSON.stringify(capStats)}`);
if (cappedManager.fileEntries.length !== 4 || cappedManager.leafId !== 'm5' || cappedManager.fileEntries[1].id !== 'm3' || cappedManager.fileEntries[1].parentId !== null) throw new Error('resume cap did not rebuild in-memory branch correctly');
if (readFileSync(resumeFile, 'utf-8') !== 'disk must remain untouched') throw new Error('resume cap rewrote the session file');
const errorManager = createFakeSessionManager([
  msg('u1', null),
  msg('e1', 'u1', 'assistant', { stopReason: 'error' }),
  msg('u2', 'e1'),
]);
const errorStats = capPiSessionManagerOnLoad(errorManager, resolvePiSessionResumeCapOptions({ maxEntries: 10 }));
if (errorStats.action !== 'capped' || errorStats.errorTurnsDropped !== 1 || errorManager.fileEntries.some((entry) => entry.id === 'e1')) throw new Error(`error-turn resume cap failed: ${JSON.stringify(errorStats)}`);
if (errorManager.byId.get('u2')?.parentId !== 'u1') throw new Error('resume cap did not reparent through dropped error turn');
const compactionManager = createFakeSessionManager([
  msg('c1', null),
  msg('c2', 'c1'),
  { type: 'compaction', id: 'compact-1', parentId: 'c2', timestamp: new Date().toISOString(), summary: 'summary', firstKeptEntryId: 'c1', tokensBefore: 1000 },
  msg('c3', 'compact-1'),
]);
const compactionStats = capPiSessionManagerOnLoad(compactionManager, resolvePiSessionResumeCapOptions({ maxEntries: 2 }));
if (compactionStats.action !== 'noop' || !compactionStats.compactionExpanded || compactionManager.fileEntries[1].id !== 'c1') throw new Error(`compaction resume cap expansion failed: ${JSON.stringify(compactionStats)}`);
const toolManager = createFakeSessionManager([
  { ...msg('tool-call', null, 'assistant'), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } }] } },
  { ...msg('tool-result', 'tool-call', 'toolResult'), message: { role: 'toolResult', toolCallId: 'call-1', content: 'ok' } },
]);
const toolStats = capPiSessionManagerOnLoad(toolManager, resolvePiSessionResumeCapOptions({ maxEntries: 1 }));
if (toolStats.action !== 'noop' || !toolStats.toolPairExpanded || toolManager.fileEntries[1].id !== 'tool-call') throw new Error(`tool-pair resume cap expansion failed: ${JSON.stringify(toolStats)}`);

const { capture, record } = createPiSessionEventCapture(5);
record({ type: 'agent_start' });
record({ type: 'message_update', message: { role: 'assistant', content: 'partial assistant text' }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial', partial: { role: 'assistant', content: 'partial assistant text' } } });
record({ type: 'message_end', message: { role: 'assistant', content: 'hello from event capture', stopReason: 'stop' } });
record({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'tool-1', args: { path: 'README.md' } });
record({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'tool-1', result: { content: [{ type: 'text', text: 'tool result text' }] }, isError: false });
record({ type: 'agent_end', messages: [{ role: 'assistant', content: 'final assistant text' }], willRetry: false });
if (capture.events.length !== 5) throw new Error(`expected bounded event capture length 5, got ${capture.events.length}`);
if (capture.eventCounts.agent_start !== 1 || capture.eventCounts.message_update !== 1 || capture.eventCounts.message_end !== 1 || capture.eventCounts.agent_end !== 1) throw new Error('event counts not captured');
if (capture.lastAssistantText !== 'final assistant text') throw new Error('last assistant text not captured from agent_end');
if (!capture.events.some((event) => event.assistantStreamEventType === 'text_delta' && event.assistantStreamDeltaChars === 7)) throw new Error('assistant stream event summary not captured');
if (!capture.events.some((event) => event.toolName === 'read' && event.toolCallId === 'tool-1' && event.toolArgsKeys?.includes('path'))) throw new Error('tool event summary not captured');
if (!capture.events.some((event) => event.type === 'tool_execution_end' && event.toolResultTextChars === 16 && event.toolResultIsError === false)) throw new Error('tool result summary not captured');

const promptParts = buildPiSessionPromptParts([
  { role: 'system', text: 'identity and SCRI context' },
  { role: 'assistant', text: 'prior assistant text should not become the new prompt' },
  { role: 'tool', text: 'tool result should not become the new prompt' },
  { role: 'user', text: 'latest user turn' },
]);
if (promptParts.appendSystemPrompt.length !== 1) throw new Error('system context was not moved to appendSystemPrompt');
if (!promptParts.appendSystemPrompt[0].includes('<mindstone_context index="1">')) throw new Error('system context wrapper missing');
if (promptParts.promptText !== 'latest user turn') throw new Error('latest user turn was not selected as prompt text');
if (promptParts.diagnostics.nonUserPromptMessagesSkipped !== 2) throw new Error('non-user prompt skip diagnostics wrong');

const resourceOptions = buildPiSessionResourceLoaderOptions({
  cwd: '/tmp/mindstone-cwd',
  agentDir: '/tmp/mindstone-agent',
  settingsManager: { sentinel: true },
  appendSystemPrompt: ['system context'],
  options: {
    additionalExtensionPaths: ['/tmp/ext-a.js'],
    additionalSkillPaths: ['/tmp/skills'],
    additionalPromptTemplatePaths: ['/tmp/prompts'],
    additionalThemePaths: ['/tmp/themes'],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [() => undefined],
  },
});
if (resourceOptions.cwd !== '/tmp/mindstone-cwd' || resourceOptions.agentDir !== '/tmp/mindstone-agent') throw new Error('resource loader base options missing');
if (resourceOptions.appendSystemPrompt?.[0] !== 'system context') throw new Error('resource loader appendSystemPrompt missing');
if (resourceOptions.additionalExtensionPaths?.[0] !== '/tmp/ext-a.js') throw new Error('resource loader extension paths missing');
if (resourceOptions.additionalSkillPaths?.[0] !== '/tmp/skills') throw new Error('resource loader skill paths missing');
if (resourceOptions.additionalPromptTemplatePaths?.[0] !== '/tmp/prompts') throw new Error('resource loader prompt paths missing');
if (resourceOptions.additionalThemePaths?.[0] !== '/tmp/themes') throw new Error('resource loader theme paths missing');
if (!resourceOptions.noExtensions || !resourceOptions.noSkills || !resourceOptions.noPromptTemplates || !resourceOptions.noThemes || !resourceOptions.noContextFiles) throw new Error('resource loader disable flags missing');
if (!Array.isArray(resourceOptions.extensionFactories) || resourceOptions.extensionFactories.length !== 1) throw new Error('resource loader extension factories missing');

const contextPruningFactories = buildMindStonePiExtensionFactories({
  contextManagement: { mode: 'sliding_window', ceilingPercent: 2, floorPercent: 1, minRecentMessages: 1 },
});
if (contextPruningFactories.length !== 1) throw new Error('sliding-window context policy did not create Pi extension factory');
if (buildMindStonePiExtensionFactories({ contextManagement: { mode: 'auto_compact' } }).length !== 0) throw new Error('auto-compact policy should not create context-pruning extension by default');
if (buildMindStonePiExtensionFactories({ contextManagement: { mode: 'auto_compact' }, compaction: { safeguardFallback: true } }).length !== 1) throw new Error('compaction safeguard fallback did not create Pi extension factory');
if (buildMindStonePiExtensionFactories({ contextManagement: { mode: 'sliding_window' }, compaction: { safeguardFallback: true } }).length !== 2) throw new Error('context pruning plus compaction safeguard should create two Pi extension factories');
if (buildMindStonePiExtensionFactories({ contextManagement: { mode: 'sliding_window' }, compaction: { safeguardFallback: true }, noExtensions: true }).length !== 0) throw new Error('noExtensions should suppress MindStone inline factories');
const contextHandlers = [];
contextPruningFactories[0]({ on(event, handler) { if (event === 'context') contextHandlers.push(handler); } });
if (contextHandlers.length !== 1) throw new Error('context pruning factory did not register context handler');
const bulky = 'x'.repeat(900);
const prunedContext = await contextHandlers[0]({
  type: 'context',
  messages: [
    { role: 'system', content: 'preserve system context' },
    { role: 'user', content: bulky },
    { role: 'assistant', content: bulky },
    { role: 'user', content: 'preserve latest user' },
  ],
}, { model: { contextWindow: 1000 } });
if (!prunedContext || prunedContext.messages.length >= 4) throw new Error('context pruning extension did not prune live context');
if (prunedContext.messages[0].role !== 'system') throw new Error('context pruning extension pruned system context');
if (prunedContext.messages.at(-1)?.content !== 'preserve latest user') throw new Error('context pruning extension pruned latest user message');

const safeguardFactory = createMindStoneCompactionSafeguardExtension({ safeguardFallback: true });
if (!safeguardFactory) throw new Error('compaction safeguard factory missing');
const compactHandlers = [];
safeguardFactory({ on(event, handler) { if (event === 'session_before_compact') compactHandlers.push(handler); } });
if (compactHandlers.length !== 1) throw new Error('compaction safeguard did not register session_before_compact handler');
const fallbackCompaction = await compactHandlers[0]({
  type: 'session_before_compact',
  preparation: {
    firstKeptEntryId: 'keep-1',
    tokensBefore: 1234,
    fileOps: { read: ['README.md', 'src/changed.ts'], edited: ['src/changed.ts'], written: ['src/new.ts'] },
    messagesToSummarize: [
      { role: 'toolResult', toolCallId: 'tool-1', toolName: 'bash', isError: true, details: { status: 'failed', exitCode: 2 }, content: [{ type: 'text', text: 'command failed with sentinel output' }] },
    ],
    turnPrefixMessages: [],
  },
}, { model: undefined, modelRegistry: { getApiKey: async () => undefined } });
if (!fallbackCompaction?.compaction?.summary.includes('Summary unavailable') || !fallbackCompaction.compaction.summary.includes('## Tool Failures')) throw new Error('fallback compaction summary missing expected sections');
if (!fallbackCompaction.compaction.summary.includes('README.md') || fallbackCompaction.compaction.summary.includes('<read-files>\nREADME.md\nsrc/changed.ts')) throw new Error('fallback compaction read file list was wrong');
if (!fallbackCompaction.compaction.summary.includes('src/changed.ts') || !fallbackCompaction.compaction.summary.includes('src/new.ts')) throw new Error('fallback compaction modified file list was wrong');
if (fallbackCompaction.compaction.firstKeptEntryId !== 'keep-1' || fallbackCompaction.compaction.tokensBefore !== 1234) throw new Error('fallback compaction metadata was not preserved');
const normalCompaction = await compactHandlers[0]({ type: 'session_before_compact', preparation: {} }, { model: { id: 'model' }, modelRegistry: { getApiKey: async () => 'configured-key' } });
if (normalCompaction !== undefined) throw new Error('compaction safeguard should not override normal authenticated Pi compaction');

const compactionOverrides = [];
const compactionSettingsResult = applyPiSessionCompactionSettings({
  settingsManager: {
    getCompactionEnabled: () => true,
    getCompactionReserveTokens: () => 16384,
    getCompactionKeepRecentTokens: () => 20000,
    applyOverrides: (overrides) => compactionOverrides.push(overrides),
  },
  compaction: { enabled: false, reserveTokens: 12000, keepRecentTokens: 30000 },
});
if (!compactionSettingsResult.didOverride) throw new Error('Pi compaction settings override was not reported');
if (compactionSettingsResult.compaction.enabled !== false) throw new Error('Pi compaction enabled override missing');
if (compactionSettingsResult.compaction.reserveTokens !== DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR) throw new Error('Pi compaction reserve floor was not enforced');
if (compactionSettingsResult.compaction.keepRecentTokens !== 30000) throw new Error('Pi compaction keepRecent override missing');
if (compactionOverrides.length !== 1) throw new Error('Pi compaction settings did not apply exactly one override');
if (compactionOverrides[0].compaction.enabled !== false || compactionOverrides[0].compaction.reserveTokens !== DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR || compactionOverrides[0].compaction.keepRecentTokens !== 30000) throw new Error('Pi compaction overrides payload was wrong');
const compactionNoopResult = applyPiSessionCompactionSettings({
  settingsManager: {
    getCompactionEnabled: () => true,
    getCompactionReserveTokens: () => DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
    getCompactionKeepRecentTokens: () => 20000,
    applyOverrides: () => { throw new Error('unexpected compaction override'); },
  },
});
if (compactionNoopResult.didOverride) throw new Error('Pi compaction settings should not override when already at defaults/floor');

const providerDiagnostics = providerDiagnosticsFromChatResult({
  role: 'assistant',
  text: 'assistant text',
  raw: {
    sessionId: 'session-1',
    sessionFile: actual,
    piSession: {
      prompt: promptParts.diagnostics,
      resumeCap: capStats,
      eventCounts: capture.eventCounts,
      events: capture.events,
      assistantTexts: capture.assistantTexts,
    },
  },
});
if (providerDiagnostics?.piSession?.sessionId !== 'session-1') throw new Error('provider diagnostics did not preserve pi session id');
if (providerDiagnostics?.piSession?.prompt?.appendSystemPromptCount !== 1) throw new Error('provider diagnostics did not preserve prompt diagnostics');
if (providerDiagnostics?.piSession?.resumeCap?.action !== 'capped' || providerDiagnostics?.piSession?.resumeCap?.dropped !== 2) throw new Error('provider diagnostics did not preserve resume-cap diagnostics');
if (providerDiagnostics?.piSession?.eventCounts?.agent_end !== 1) throw new Error('provider diagnostics did not preserve event counts');
if (!providerDiagnostics?.piSession?.events?.some((event) => event.toolName === 'read' && event.toolArgsKeys?.includes('path'))) throw new Error('provider diagnostics did not preserve event summaries');
if (!providerDiagnostics?.piSession?.events?.some((event) => event.assistantStreamEventType === 'text_delta')) throw new Error('provider diagnostics did not preserve assistant stream event summaries');
if (providerDiagnostics?.piSession?.assistantTextCount !== 3) throw new Error('provider diagnostics did not preserve assistant text count');

const fakeProvider = {
  id: 'fake-pi-session-provider',
  listModels() { return []; },
  async completeChat(request) {
    return {
      role: 'assistant',
      text: `fake pi-session runner: ${request.messages.at(-1)?.text ?? ''}`,
      model: request.model,
    };
  },
};
const runner = new PiSessionAgentRunner({ provider: fakeProvider });
const runnerResult = await runner.run({
  agentId: 'default',
  sessionKey: process.env.CHAT_SESSION_KEY,
  entries: [{
    id: 'entry-1',
    timestamp: new Date().toISOString(),
    sessionKey: process.env.CHAT_SESSION_KEY,
    agentId: 'default',
    role: 'user',
    text: 'runner boundary sentinel',
  }],
  model: { id: 'fake/model', provider: 'pi-session' },
  provider: fakeProvider,
  runContext: { runId: 'run-smoke', surface: 'smoke' },
});
if (runnerResult.runner.id !== 'pi-session' || runnerResult.runner.mode !== 'pi-session') throw new Error('pi-session runner diagnostics missing');
if (runnerResult.runner.runId !== 'run-smoke' || runnerResult.runner.surface !== 'smoke') throw new Error('pi-session runner context missing');
if (!runnerResult.result.text.includes('runner boundary sentinel')) throw new Error('pi-session runner did not execute routed provider path');

const providerRouteCompact = await createProviderRouteAgentRunner().compact({
  agentId: 'default',
  sessionKey: process.env.CHAT_SESSION_KEY,
  model: { id: 'fake/model', provider: 'provider-route' },
  runContext: { runId: 'compact-provider-route-smoke', surface: 'smoke' },
});
if (providerRouteCompact.available !== false || providerRouteCompact.reason !== 'provider_route_runner_has_no_substrate_compaction') throw new Error('provider-route compact boundary should be unavailable');

const injectedRunnerCompact = await runner.compact({
  agentId: 'default',
  sessionKey: process.env.CHAT_SESSION_KEY,
  model: { id: 'fake/model', provider: 'pi-session' },
  runContext: { runId: 'compact-injected-provider-smoke', surface: 'smoke' },
});
if (injectedRunnerCompact.available !== false || injectedRunnerCompact.reason !== 'pi_session_compaction_unavailable_for_injected_provider') throw new Error('pi-session compact should be unavailable for injected provider');

const realRunnerCompact = await new PiSessionAgentRunner().compact({
  agentId: 'default',
  sessionKey: process.env.CHAT_SESSION_KEY,
  model: { id: 'openai/gpt-5.1', provider: 'pi-session' },
  runContext: { runId: 'compact-no-auth-smoke', surface: 'smoke' },
});
if (realRunnerCompact.available !== false || realRunnerCompact.reason !== 'pi_model_unavailable_for_compaction') throw new Error(`unexpected real pi-session compact result: ${JSON.stringify(realRunnerCompact)}`);
NODE

set +e
OUTPUT="$(./scripts/mindstone chat --once "hello pi session runner" --json 2>&1)"
STATUS=$?
set -e

echo "${OUTPUT}"
if [[ "${STATUS}" -eq 0 ]]; then
  echo "Expected pi-session runner to fail without isolated provider auth, but it succeeded" >&2
  exit 1
fi
if ! grep -Eq "No isolated Pi model is available/configured|not available in isolated runtime auth" <<<"${OUTPUT}"; then
  echo "Unexpected pi-session failure mode" >&2
  exit 1
fi

echo "Pi session-backed runner smoke test passed with expected unavailable-model/auth result."
