import {
  agentRunStreamErrorFromUnknown,
  runMindStoneRoute,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunner,
  type AgentRunStreamEvent,
  type MindStoneModelProvider,
} from "@mindstone-agent/core";
import {
  PI_SESSION_EVENT_CALLBACK_METADATA_KEY,
  PiSessionExecutor,
  type PiSessionEventCallbackPayload,
  type PiSessionExecutorOptions,
} from "./pi-session-executor.js";

export type PiSessionAgentRunnerOptions = PiSessionExecutorOptions & {
  provider?: MindStoneModelProvider;
};

type PiSessionStreamDiagnostics = {
  events: unknown[];
};

type PiSessionQueuedStreamEvent =
  | { type: "substrate_event"; event: unknown }
  | { type: "text_delta"; text: string };

type AsyncQueueResult<T> = IteratorResult<T>;

class AsyncEventQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: AsyncQueueResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  next(): Promise<AsyncQueueResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function piSessionStreamDiagnosticsFromRaw(raw: unknown): PiSessionStreamDiagnostics | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const piSession = record.piSession;
  if (!piSession || typeof piSession !== "object") return undefined;
  const piRecord = piSession as Record<string, unknown>;
  const events = Array.isArray(piRecord.events) ? piRecord.events : [];
  return { events };
}

/**
 * AgentRunner implementation for Pi AgentSession-backed execution.
 *
 * This keeps the legacy provider compatibility path available while moving
 * pi-session execution behind the runner boundary selected by CLI/Gateway
 * surfaces. The runner still reuses Core route planning for identity, SCRI,
 * handoff replay, prompt-window selection, and memory recall.
 */
export class PiSessionAgentRunner implements AgentRunner {
  readonly id = "pi-session";
  readonly #provider: MindStoneModelProvider;

  constructor(options: PiSessionAgentRunnerOptions = {}) {
    this.#provider = options.provider ?? new PiSessionExecutor(options);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = input.runContext?.startedAt ?? new Date().toISOString();
    const startedMs = Date.now();
    const route = await runMindStoneRoute({
      ...input,
      provider: this.#provider,
    });
    return {
      ...route,
      runner: {
        id: this.id,
        mode: "pi-session",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedMs),
        runId: input.runContext?.runId,
        surface: input.runContext?.surface,
      },
    };
  }

  async *stream(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent> {
    const startedAt = input.runContext?.startedAt ?? new Date().toISOString();
    const runContext = { ...input.runContext, startedAt };
    let sequence = 0;
    yield {
      type: "run_started",
      sequence: sequence++,
      timestamp: startedAt,
      runnerId: this.id,
      runId: runContext.runId,
      surface: runContext.surface,
      metadata: runContext.metadata,
      input: {
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        model: input.model,
      },
    };
    const liveEvents = new AsyncEventQueue<PiSessionQueuedStreamEvent>();
    let didLiveCapture = false;
    let didLiveTextCapture = false;
    let result: AgentRunResult | undefined;
    let runError: unknown;
    const onPiSessionEvent = (payload: PiSessionEventCallbackPayload): void => {
      didLiveCapture = true;
      if (payload.textDelta) {
        didLiveTextCapture = true;
        liveEvents.push({ type: "text_delta", text: payload.textDelta });
        return;
      }
      liveEvents.push({ type: "substrate_event", event: payload.summary });
    };
    const runPromise = this.run({
      ...input,
      metadata: {
        ...input.metadata,
        [PI_SESSION_EVENT_CALLBACK_METADATA_KEY]: onPiSessionEvent,
      },
      runContext,
    }).then(
      (value) => {
        result = value;
      },
      (error) => {
        runError = error;
      },
    ).finally(() => liveEvents.close());

    try {
      while (true) {
        const next = await liveEvents.next();
        if (next.done) break;
        if (next.value.type === "text_delta") {
          yield {
            type: "text_delta",
            sequence: sequence++,
            timestamp: new Date().toISOString(),
            runnerId: this.id,
            runId: runContext.runId,
            surface: runContext.surface,
            metadata: {
              ...runContext.metadata,
              liveCapture: true,
            },
            text: next.value.text,
          };
          continue;
        }
        yield {
          type: "substrate_event",
          sequence: sequence++,
          timestamp: new Date().toISOString(),
          runnerId: this.id,
          runId: runContext.runId,
          surface: runContext.surface,
          metadata: {
            ...runContext.metadata,
            liveCapture: true,
          },
          substrate: "pi",
          event: next.value.event,
        };
      }
      await runPromise;
      if (runError) throw runError;
      if (!result) throw new Error("PiSessionAgentRunner stream completed without run result");
      const diagnostics = piSessionStreamDiagnosticsFromRaw(result.result.raw);
      if (!didLiveCapture) {
        for (const event of diagnostics?.events ?? []) {
          yield {
            type: "substrate_event",
            sequence: sequence++,
            timestamp: new Date().toISOString(),
            runnerId: this.id,
            runId: runContext.runId,
            surface: runContext.surface,
            metadata: {
              ...runContext.metadata,
              diagnosticReplay: true,
            },
            substrate: "pi",
            event,
          };
        }
      }
      if (result.result.text && !didLiveTextCapture) {
        yield {
          type: "text_delta",
          sequence: sequence++,
          timestamp: new Date().toISOString(),
          runnerId: this.id,
          runId: runContext.runId,
          surface: runContext.surface,
          metadata: {
            ...runContext.metadata,
            completedTextReplay: true,
          },
          text: result.result.text,
        };
      }
      yield {
        type: "run_completed",
        sequence: sequence++,
        timestamp: result.runner.completedAt,
        runnerId: this.id,
        runId: runContext.runId,
        surface: runContext.surface,
        metadata: runContext.metadata,
        result,
      };
    } catch (error) {
      yield {
        type: "run_failed",
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        runnerId: this.id,
        runId: runContext.runId,
        surface: runContext.surface,
        metadata: runContext.metadata,
        error: agentRunStreamErrorFromUnknown(error),
      };
      throw error;
    }
  }
}
