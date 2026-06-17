import type { MindStoneRouteInput, MindStoneRouteResult } from "../routing/run.js";

export type AgentRunInput = MindStoneRouteInput;
export type AgentRunResult = MindStoneRouteResult;

export interface AgentRunner {
  id: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
