#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

echo "== AgentRunner stream contract smoke test =="

npm run build:mindstone

node --input-type=module <<'NODE'
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRouteAgentRunner, readTranscriptEntries, runMindStoneChatTurn } from './packages/mindstone-core/dist/index.js';
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
            { type: 'message_update', messageRole: 'assistant', assistantStreamEventType: 'text_delta', assistantStreamDeltaChars: 6 },
            { type: 'tool_execution_start', toolName: 'read', toolCallId: 'tool-1', toolArgsKeys: ['path'] },
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
  if (events.length !== 3) throw new Error(`${runnerId}: expected started+text_delta+completed events, got ${events.length}`);
  if (events[0].type !== 'run_started') throw new Error(`${runnerId}: first event was not run_started`);
  if (events[1].type !== 'text_delta') throw new Error(`${runnerId}: second event was not text_delta`);
  if (events[2].type !== 'run_completed') throw new Error(`${runnerId}: third event was not run_completed`);
  if (events.some((event, index) => event.sequence !== index)) throw new Error(`${runnerId}: stream sequence was not monotonic from zero`);
  if (!events.every((event) => event.runnerId === runnerId)) throw new Error(`${runnerId}: runnerId missing from stream events`);
  if (events[1].metadata?.completedTextReplay !== true) throw new Error(`${runnerId}: text_delta was not marked as completed text replay`);
  if (!events[1].text.includes('stream contract sentinel')) throw new Error(`${runnerId}: text_delta missing sentinel`);
  if (events[2].result.runner.id !== runnerId) throw new Error(`${runnerId}: completed result runner diagnostics missing`);
  if (!events[2].result.result.text.includes('stream contract sentinel')) throw new Error(`${runnerId}: completed result text missing sentinel`);
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
if (piSessionEvents.length !== 6) throw new Error(`pi-session: expected started+3 substrate+text_delta+completed events, got ${piSessionEvents.length}`);
if (piSessionEvents[0].type !== 'run_started') throw new Error('pi-session: first event was not run_started');
if (piSessionEvents[1].type !== 'substrate_event' || piSessionEvents[1].substrate !== 'pi') throw new Error('pi-session: first diagnostic was not a Pi substrate_event');
if (piSessionEvents[2].type !== 'substrate_event' || piSessionEvents[2].event.assistantStreamEventType !== 'text_delta') throw new Error('pi-session: assistant diagnostic substrate_event missing');
if (piSessionEvents[3].type !== 'substrate_event' || piSessionEvents[3].event.toolName !== 'read' || !piSessionEvents[3].event.toolArgsKeys?.includes('path')) throw new Error('pi-session: tool diagnostic substrate_event missing');
if (piSessionEvents[4].type !== 'text_delta' || piSessionEvents[4].metadata?.completedTextReplay !== true) throw new Error('pi-session: completed text replay delta missing');
if (piSessionEvents[5].type !== 'run_completed') throw new Error('pi-session: final event was not run_completed');
if (piSessionEvents.some((event, index) => event.sequence !== index)) throw new Error('pi-session: stream sequence was not monotonic from zero');
if (piSessionEvents[5].result.runner.id !== 'pi-session') throw new Error('pi-session: completed result runner diagnostics missing');

const runtimeDir = mkdtempSync(join(tmpdir(), 'mindstone-agent-runner-stream-transcript.'));
process.env.MINDSTONE_AGENT_RUNTIME_DIR = runtimeDir;
try {
  const turn = await runMindStoneChatTurn({
    agentId: 'default',
    sessionKey: 'agent:default:main',
    message: 'persist stream diagnostics sentinel',
    config: {
      observability: {
        runnerStream: {
          persistTranscriptEvents: true,
          eventTypes: ['substrate_event'],
          maxEvents: 10,
        },
      },
    },
    provider: fakeProvider,
    model,
    runner: new PiSessionAgentRunner({ provider: fakeProvider }),
    source: { substrate: 'smoke', channel: 'runner-stream', chatType: 'internal' },
  });
  if (turn.runnerStream?.eventCount !== 6 || turn.runnerStream?.persistedEventCount !== 3) {
    throw new Error(`unexpected runnerStream summary: ${JSON.stringify(turn.runnerStream)}`);
  }
  if (turn.events.filter((entry) => entry.metadata?.event === 'runner_stream_event').length !== 3) {
    throw new Error('runner stream events were not returned from chat turn');
  }
  const transcript = readTranscriptEntries('agent:default:main');
  const streamEntries = transcript.filter((entry) => entry.metadata?.event === 'runner_stream_event');
  if (streamEntries.length !== 3) throw new Error(`expected 3 persisted runner stream events, got ${streamEntries.length}`);
  if (!streamEntries.every((entry) => entry.metadata?.streamType === 'substrate_event' && entry.metadata?.substrate === 'pi')) {
    throw new Error('persisted runner stream events were not Pi substrate events');
  }
  const assistantIndex = transcript.findIndex((entry) => entry.role === 'assistant');
  const lastStreamIndex = transcript.findLastIndex((entry) => entry.metadata?.event === 'runner_stream_event');
  if (assistantIndex < 0 || lastStreamIndex < 0 || lastStreamIndex > assistantIndex) {
    throw new Error('runner stream transcript events were not persisted before assistant response');
  }
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}

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

console.log(JSON.stringify({ ok: true, providerRouteEvents: 3, piSessionEvents: piSessionEvents.length, persistedStreamEvents: 3, failureEvents: 2 }, null, 2));
NODE

echo "AgentRunner stream contract smoke test passed."
