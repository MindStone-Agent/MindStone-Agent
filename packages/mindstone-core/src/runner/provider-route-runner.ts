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

  run(input: AgentRunInput): Promise<AgentRunResult> {
    return runMindStoneRoute(input);
  }
}

export function createProviderRouteAgentRunner(): AgentRunner {
  return new ProviderRouteAgentRunner();
}
