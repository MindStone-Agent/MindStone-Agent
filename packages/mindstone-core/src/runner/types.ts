import type { MindStoneRouteInput, MindStoneRouteResult } from "../routing/run.js";

export type AgentRunContext = {
  runId?: string;
  surface?: string;
  startedAt?: string;
  metadata?: Record<string, unknown>;
};

export type AgentRunnerDiagnostics = {
  id: string;
  mode?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  runId?: string;
  surface?: string;
};

export type AgentRunInput = MindStoneRouteInput & {
  runContext?: AgentRunContext;
};

export type AgentRunResult = MindStoneRouteResult & {
  runner: AgentRunnerDiagnostics;
};

export interface AgentRunner {
  id: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
