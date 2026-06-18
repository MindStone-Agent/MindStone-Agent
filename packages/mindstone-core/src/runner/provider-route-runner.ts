import { completeMindStoneRoutePlan, planMindStoneRoute, runMindStoneRoute } from "../routing/run.js";
import { agentRunStreamErrorFromUnknown } from "./stream.js";
import type { AgentCompactionInput, AgentCompactionResult, AgentRunInput, AgentRunResult, AgentRunner, AgentRunStreamEvent } from "./types.js";

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

  async compact(input: AgentCompactionInput): Promise<AgentCompactionResult> {
    const startedAt = input.runContext?.startedAt ?? new Date().toISOString();
    const startedMs = Date.now();
    return {
      requested: false,
      available: false,
      runnerId: this.id,
      substrate: "provider",
      reason: "provider_route_runner_has_no_substrate_compaction",
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      model: input.model,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedMs),
      runId: input.runContext?.runId,
      surface: input.runContext?.surface,
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
      const startedMs = Date.now();
      const plan = await planMindStoneRoute(input);
      yield {
        type: "route_planned",
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        runnerId: this.id,
        runId: runContext.runId,
        surface: runContext.surface,
        metadata: runContext.metadata,
        plan,
      };
      const route = await completeMindStoneRoutePlan(input, plan);
      const completedAt = new Date().toISOString();
      const result: AgentRunResult = {
        ...route,
        runner: {
          id: this.id,
          mode: "provider-route",
          startedAt,
          completedAt,
          durationMs: Math.max(0, Date.now() - startedMs),
          runId: runContext.runId,
          surface: runContext.surface,
        },
      };
      if (result.result.text) {
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

export function createProviderRouteAgentRunner(): AgentRunner {
  return new ProviderRouteAgentRunner();
}
