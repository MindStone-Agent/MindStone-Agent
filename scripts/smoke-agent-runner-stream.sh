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
import { PI_SESSION_EVENT_CALLBACK_METADATA_KEY, PiSessionAgentRunner } from './packages/mindstone-gateway/dist/index.js';

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
            { type: 'tool_execution_start', toolName: 'read', toolCallId: 'tool-1', toolArgsKeys: ['path'], args: { path: 'SECRET_PATH_SHOULD_NOT_PERSIST', token: 'SECRET_TOKEN_SHOULD_NOT_PERSIST' }, result: { content: 'SECRET_RESULT_SHOULD_NOT_PERSIST' } },
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
  if (events.length !== 4) throw new Error(`${runnerId}: expected started+route_planned+text_delta+completed events, got ${events.length}`);
  if (events[0].type !== 'run_started') throw new Error(`${runnerId}: first event was not run_started`);
  if (events[1].type !== 'route_planned') throw new Error(`${runnerId}: second event was not route_planned`);
  if (events[1].plan?.promptWindow?.promptEntries?.length !== 1) throw new Error(`${runnerId}: route_planned prompt window missing`);
  if (events[2].type !== 'text_delta') throw new Error(`${runnerId}: third event was not text_delta`);
  if (events[3].type !== 'run_completed') throw new Error(`${runnerId}: fourth event was not run_completed`);
  if (events.some((event, index) => event.sequence !== index)) throw new Error(`${runnerId}: stream sequence was not monotonic from zero`);
  if (!events.every((event) => event.runnerId === runnerId)) throw new Error(`${runnerId}: runnerId missing from stream events`);
  if (events[2].metadata?.completedTextReplay !== true) throw new Error(`${runnerId}: text_delta was not marked as completed text replay`);
  if (!events[2].text.includes('stream contract sentinel')) throw new Error(`${runnerId}: text_delta missing sentinel`);
  if (events[3].result.runner.id !== runnerId) throw new Error(`${runnerId}: completed result runner diagnostics missing`);
  if (!events[3].result.result.text.includes('stream contract sentinel')) throw new Error(`${runnerId}: completed result text missing sentinel`);
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
if (piSessionEvents.length !== 7) throw new Error(`pi-session: expected started+route_planned+3 substrate+text_delta+completed events, got ${piSessionEvents.length}`);
if (piSessionEvents[0].type !== 'run_started') throw new Error('pi-session: first event was not run_started');
if (piSessionEvents[1].type !== 'route_planned' || piSessionEvents[1].plan?.promptWindow?.promptEntries?.length !== 1) throw new Error('pi-session: route_planned event missing');
if (piSessionEvents[2].type !== 'substrate_event' || piSessionEvents[2].substrate !== 'pi') throw new Error('pi-session: first diagnostic was not a Pi substrate_event');
if (piSessionEvents[3].type !== 'substrate_event' || piSessionEvents[3].event.assistantStreamEventType !== 'text_delta') throw new Error('pi-session: assistant diagnostic substrate_event missing');
if (piSessionEvents[4].type !== 'substrate_event' || piSessionEvents[4].event.toolName !== 'read' || !piSessionEvents[4].event.toolArgsKeys?.includes('path')) throw new Error('pi-session: tool diagnostic substrate_event missing');
if (piSessionEvents[5].type !== 'text_delta' || piSessionEvents[5].metadata?.completedTextReplay !== true) throw new Error('pi-session: completed text replay delta missing');
if (piSessionEvents[6].type !== 'run_completed') throw new Error('pi-session: final event was not run_completed');
if (piSessionEvents.some((event, index) => event.sequence !== index)) throw new Error('pi-session: stream sequence was not monotonic from zero');
if (piSessionEvents[6].result.runner.id !== 'pi-session') throw new Error('pi-session: completed result runner diagnostics missing');

const liveProvider = {
  id: 'fake-live-pi-session-provider',
  listModels() { return [model]; },
  async completeChat(request) {
    const callback = request.metadata?.[PI_SESSION_EVENT_CALLBACK_METADATA_KEY];
    if (typeof callback !== 'function') throw new Error('live Pi session event callback missing');
    callback({ summary: { type: 'agent_start' } });
    callback({ summary: { type: 'message_update', assistantStreamEventType: 'text_delta', assistantStreamDeltaChars: 11 }, textDelta: 'live delta ' });
    return {
      role: 'assistant',
      text: 'live stream response',
      model: request.model,
      raw: {
        piSession: {
          events: [{ type: 'should_not_replay_when_live_capture_exists' }],
        },
      },
    };
  },
};
const liveEvents = await collect(new PiSessionAgentRunner({ provider: liveProvider }).stream({ ...baseInput, provider: liveProvider }));
const liveSubstrateEvents = liveEvents.filter((event) => event.type === 'substrate_event');
const liveTextEvents = liveEvents.filter((event) => event.type === 'text_delta');
if (liveSubstrateEvents.length !== 1) throw new Error(`expected 1 live substrate event, got ${liveSubstrateEvents.length}`);
if (liveTextEvents.length !== 1) throw new Error(`expected 1 live text delta, got ${liveTextEvents.length}`);
if (!liveEvents.filter((event) => event.type === 'substrate_event' || event.type === 'text_delta').every((event) => event.metadata?.liveCapture === true)) throw new Error('live stream events were not marked liveCapture');
if (liveSubstrateEvents.some((event) => event.event?.type === 'should_not_replay_when_live_capture_exists')) throw new Error('diagnostic replay was not skipped after live capture');
if (liveTextEvents[0].text !== 'live delta ') throw new Error('live assistant text delta was not yielded');
if (liveTextEvents.some((event) => event.metadata?.completedTextReplay === true)) throw new Error('live text delta was incorrectly marked as completed replay');
if (liveEvents.some((event) => event.type === 'text_delta' && event.text === 'live stream response')) throw new Error('completed text replay was not suppressed after live text capture');

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
  if (turn.runnerStream?.eventCount !== 7 || turn.runnerStream?.persistedEventCount !== 3) {
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
  const serializedStreamEntries = JSON.stringify(streamEntries);
  if (serializedStreamEntries.includes('SECRET_PATH_SHOULD_NOT_PERSIST') || serializedStreamEntries.includes('SECRET_TOKEN_SHOULD_NOT_PERSIST') || serializedStreamEntries.includes('SECRET_RESULT_SHOULD_NOT_PERSIST')) {
    throw new Error('persisted runner stream events leaked raw substrate args/result values');
  }
  const sanitizedToolEntry = streamEntries.find((entry) => entry.metadata?.payload?.toolName === 'read');
  if (!sanitizedToolEntry) throw new Error('sanitized tool stream entry missing');
  if (!sanitizedToolEntry.metadata?.payload?.unknownKeys?.includes('args') || !sanitizedToolEntry.metadata?.payload?.unknownKeys?.includes('result')) {
    throw new Error(`sanitized tool stream entry did not preserve unknown key names: ${JSON.stringify(sanitizedToolEntry.metadata?.payload)}`);
  }
  if (JSON.stringify(sanitizedToolEntry.content) !== JSON.stringify(sanitizedToolEntry.metadata.payload)) {
    throw new Error('persisted stream content and metadata payload sanitizer output diverged');
  }
  const assistantIndex = transcript.findIndex((entry) => entry.role === 'assistant');
  const lastStreamIndex = transcript.findLastIndex((entry) => entry.metadata?.event === 'runner_stream_event');
  if (assistantIndex < 0 || lastStreamIndex < 0 || lastStreamIndex > assistantIndex) {
    throw new Error('runner stream transcript events were not persisted before assistant response');
  }
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}

const abortedController = new AbortController();
abortedController.abort();
const abortAwareProvider = {
  id: 'abort-aware-stream-provider',
  listModels() { return [model]; },
  async completeChat(request) {
    if (!request.signal?.aborted) throw new Error('abort signal was not propagated');
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  },
};
const abortEvents = [];
try {
  for await (const event of new PiSessionAgentRunner({ provider: abortAwareProvider }).stream({ ...baseInput, provider: abortAwareProvider, signal: abortedController.signal })) abortEvents.push(event);
  throw new Error('expected aborted stream was not thrown');
} catch (error) {
  if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
}
if (abortEvents.length !== 3) throw new Error(`expected started+planned+failed abort events, got ${abortEvents.length}`);
if (abortEvents[0].type !== 'run_started' || abortEvents[1].type !== 'route_planned' || abortEvents[2].type !== 'run_failed') throw new Error('abort stream did not emit started, planned, then failed');
if (abortEvents[2].error.name !== 'AbortError') throw new Error('abort stream did not serialize AbortError name');

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
if (failureEvents.length !== 3) throw new Error(`expected started+planned+failed events, got ${failureEvents.length}`);
if (failureEvents[0].type !== 'run_started' || failureEvents[1].type !== 'route_planned' || failureEvents[2].type !== 'run_failed') throw new Error('failure stream did not emit started, planned, then failed');
if (failureEvents[2].error.message !== 'stream failure sentinel') throw new Error('failure stream did not serialize error message');

console.log(JSON.stringify({ ok: true, providerRouteEvents: 4, piSessionEvents: piSessionEvents.length, livePiSessionEvents: liveEvents.length, persistedStreamEvents: 3, abortEvents: 3, failureEvents: 3 }, null, 2));
NODE

echo "AgentRunner stream contract smoke test passed."
