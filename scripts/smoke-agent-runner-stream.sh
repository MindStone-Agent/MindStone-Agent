#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

echo "== AgentRunner stream contract smoke test =="

npm run build:mindstone

node --input-type=module <<'NODE'
import { createProviderRouteAgentRunner } from './packages/mindstone-core/dist/index.js';
import { PiSessionAgentRunner } from './packages/mindstone-gateway/dist/index.js';

const transcriptEntry = {
  id: 'entry-1',
  sessionKey: 'agent:default:main',
  agentId: 'default',
  role: 'user',
  text: 'stream contract sentinel',
  timestamp: new Date().toISOString(),
};

const model = { id: 'mindstone/mock', provider: 'mock' };

const fakeProvider = {
  id: 'fake-stream-provider',
  listModels() { return [model]; },
  async completeChat(request) {
    return {
      role: 'assistant',
      text: `stream response: ${request.messages.at(-1)?.text ?? ''}`,
      model: request.model,
      raw: {
        piSession: {
          events: [
            { type: 'agent_start' },
            { type: 'tool_execution_start', toolName: 'read', toolCallId: 'tool-1' },
          ],
        },
      },
    };
  },
};

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function assertLifecycle(events, runnerId) {
  if (events.length !== 2) throw new Error(`${runnerId}: expected 2 lifecycle events, got ${events.length}`);
  if (events[0].type !== 'run_started') throw new Error(`${runnerId}: first event was not run_started`);
  if (events[1].type !== 'run_completed') throw new Error(`${runnerId}: second event was not run_completed`);
  if (events[0].sequence !== 0 || events[1].sequence !== 1) throw new Error(`${runnerId}: stream sequence was not monotonic from zero`);
  if (events[0].runnerId !== runnerId || events[1].runnerId !== runnerId) throw new Error(`${runnerId}: runnerId missing from stream events`);
  if (events[1].result.runner.id !== runnerId) throw new Error(`${runnerId}: completed result runner diagnostics missing`);
  if (!events[1].result.result.text.includes('stream contract sentinel')) throw new Error(`${runnerId}: completed result text missing sentinel`);
}

const baseInput = {
  agentId: 'default',
  sessionKey: 'agent:default:main',
  entries: [transcriptEntry],
  model,
  provider: fakeProvider,
  runContext: { runId: 'run-stream-smoke', surface: 'smoke', metadata: { smoke: true } },
};

assertLifecycle(await collect(createProviderRouteAgentRunner().stream(baseInput)), 'provider-route');

const piSessionEvents = await collect(new PiSessionAgentRunner({ provider: fakeProvider }).stream(baseInput));
if (piSessionEvents.length !== 4) throw new Error(`pi-session: expected started+2 substrate+completed events, got ${piSessionEvents.length}`);
if (piSessionEvents[0].type !== 'run_started') throw new Error('pi-session: first event was not run_started');
if (piSessionEvents[1].type !== 'substrate_event' || piSessionEvents[1].substrate !== 'pi') throw new Error('pi-session: first diagnostic was not a Pi substrate_event');
if (piSessionEvents[2].type !== 'substrate_event' || piSessionEvents[2].event.toolName !== 'read') throw new Error('pi-session: tool diagnostic substrate_event missing');
if (piSessionEvents[3].type !== 'run_completed') throw new Error('pi-session: final event was not run_completed');
if (piSessionEvents.some((event, index) => event.sequence !== index)) throw new Error('pi-session: stream sequence was not monotonic from zero');
if (piSessionEvents[3].result.runner.id !== 'pi-session') throw new Error('pi-session: completed result runner diagnostics missing');

const failingProvider = {
  id: 'failing-stream-provider',
  listModels() { return [model]; },
  async completeChat() { throw new Error('stream failure sentinel'); },
};

const failingRunner = createProviderRouteAgentRunner();
const failureEvents = [];
try {
  for await (const event of failingRunner.stream({ ...baseInput, provider: failingProvider })) failureEvents.push(event);
  throw new Error('expected stream failure was not thrown');
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'stream failure sentinel') throw error;
}
if (failureEvents.length !== 2) throw new Error(`expected started+failed events, got ${failureEvents.length}`);
if (failureEvents[0].type !== 'run_started' || failureEvents[1].type !== 'run_failed') throw new Error('failure stream did not emit started then failed');
if (failureEvents[1].error.message !== 'stream failure sentinel') throw new Error('failure stream did not serialize error message');

console.log(JSON.stringify({ ok: true, providerRouteEvents: 2, piSessionEvents: piSessionEvents.length, failureEvents: 2 }, null, 2));
NODE

echo "AgentRunner stream contract smoke test passed."
