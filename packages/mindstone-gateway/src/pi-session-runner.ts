import {
  agentRunStreamErrorFromUnknown,
  runMindStoneRoute,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunner,
  type AgentRunStreamEvent,
  type MindStoneModelProvider,
} from "@mindstone-agent/core";
import { PiSessionExecutor, type PiSessionExecutorOptions } from "./pi-session-executor.js";

export type PiSessionAgentRunnerOptions = PiSessionExecutorOptions & {
  provider?: MindStoneModelProvider;
};

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
    try {
      const result = await this.run({ ...input, runContext });
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
