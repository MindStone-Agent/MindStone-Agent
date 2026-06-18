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
import { buildPiSessionPromptParts, createPiSessionEventCapture, PiSessionAgentRunner, piSessionFileForKey } from './packages/mindstone-gateway/dist/index.js';
import { resolve } from 'node:path';
const expected = resolve(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions/${Buffer.from(process.env.CHAT_SESSION_KEY, 'utf8').toString('base64url')}.jsonl`);
const actual = piSessionFileForKey(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions`, process.env.CHAT_SESSION_KEY);
console.log(JSON.stringify({ sessionKey: process.env.CHAT_SESSION_KEY, sessionFile: actual }, null, 2));
if (actual !== expected) process.exit(1);

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

const providerDiagnostics = providerDiagnosticsFromChatResult({
  role: 'assistant',
  text: 'assistant text',
  raw: {
    sessionId: 'session-1',
    sessionFile: actual,
    piSession: {
      prompt: promptParts.diagnostics,
      eventCounts: capture.eventCounts,
      events: capture.events,
      assistantTexts: capture.assistantTexts,
    },
  },
});
if (providerDiagnostics?.piSession?.sessionId !== 'session-1') throw new Error('provider diagnostics did not preserve pi session id');
if (providerDiagnostics?.piSession?.prompt?.appendSystemPromptCount !== 1) throw new Error('provider diagnostics did not preserve prompt diagnostics');
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
