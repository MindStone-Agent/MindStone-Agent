import { runMindStoneRoute } from "../routing/run.js";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./types.js";

/**
 * Default MindStone-Agent runner for current routed provider execution.
 *
 * This preserves existing behavior while giving CLI/Gateway/channel surfaces a
 * stable AgentRunner boundary. Future runners can own a live Pi AgentSession,
 * stream events, coordinate substrate compaction, or route through other
 * substrates without changing surface code.
 */
export class ProviderRouteAgentRunner implements AgentRunner {
  readonly id = "provider-route";

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = input.runContext?.startedAt ?? new Date().toISOString();
    const startedMs = Date.now();
    const route = await runMindStoneRoute(input);
    const completedAt = new Date().toISOString();
    return {
      ...route,
      runner: {
        id: this.id,
        mode: "provider-route",
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        runId: input.runContext?.runId,
        surface: input.runContext?.surface,
      },
    };
  }
}

export function createProviderRouteAgentRunner(): AgentRunner {
  return new ProviderRouteAgentRunner();
}
