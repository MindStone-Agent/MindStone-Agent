import {
  runMindStoneRoute,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunner,
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
}
