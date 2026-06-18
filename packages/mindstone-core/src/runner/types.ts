import type { MindStoneRouteInput, MindStoneRoutePlan, MindStoneRouteResult } from "../routing/run.js";

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

export type AgentCompactionInput = {
  agentId: string;
  sessionKey: string;
  model: MindStoneRouteInput["model"];
  customInstructions?: string;
  signal?: AbortSignal;
  runContext?: AgentRunContext;
};

export type AgentCompactionResult = {
  requested: boolean;
  available: boolean;
  runnerId: string;
  substrate: "pi" | "provider" | "none" | string;
  reason: string;
  sessionKey: string;
  agentId: string;
  model?: MindStoneRouteInput["model"];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  runId?: string;
  surface?: string;
  details?: Record<string, unknown>;
};

export type AgentRunResult = MindStoneRouteResult & {
  runner: AgentRunnerDiagnostics;
};

export type AgentRunStreamEventBase = {
  sequence: number;
  timestamp: string;
  runnerId: string;
  runId?: string;
  surface?: string;
  metadata?: Record<string, unknown>;
};

export type AgentRunStartedEvent = AgentRunStreamEventBase & {
  type: "run_started";
  input: {
    agentId: string;
    sessionKey: string;
    model: MindStoneRouteInput["model"];
  };
};

export type AgentRunRoutePlannedEvent = AgentRunStreamEventBase & {
  type: "route_planned";
  plan: MindStoneRoutePlan;
};

export type AgentRunTextDeltaEvent = AgentRunStreamEventBase & {
  type: "text_delta";
  text: string;
};

export type AgentRunSubstrateEvent = AgentRunStreamEventBase & {
  type: "substrate_event";
  substrate: "pi" | "provider" | "mindstone" | string;
  event: unknown;
};

export type AgentRunCompletedEvent = AgentRunStreamEventBase & {
  type: "run_completed";
  result: AgentRunResult;
};

export type AgentRunFailedEvent = AgentRunStreamEventBase & {
  type: "run_failed";
  error: {
    name?: string;
    message: string;
    stack?: string;
  };
};

export type AgentRunStreamEvent =
  | AgentRunStartedEvent
  | AgentRunRoutePlannedEvent
  | AgentRunTextDeltaEvent
  | AgentRunSubstrateEvent
  | AgentRunCompletedEvent
  | AgentRunFailedEvent;

export interface AgentRunner {
  id: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  stream(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent>;
  compact?(input: AgentCompactionInput): Promise<AgentCompactionResult>;
}
