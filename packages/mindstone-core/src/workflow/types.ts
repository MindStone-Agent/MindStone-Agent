export type MindStoneWorkflowCondition = {
  /** Match when the canonical session key starts with this prefix. */
  sessionKeyPrefix?: string;
  /** Match when the turn's source channel equals this value. */
  sourceChannel?: string;
  /** Match when the turn's source substrate equals this value. */
  sourceSubstrate?: string;
  /** Match when the latest user message starts with this prefix (case-insensitive). */
  messagePrefix?: string;
};

export type MindStoneWorkflowGate = {
  /** Passes when the referenced persona's artifacts load cleanly. */
  personaLoadable?: string;
  /** Passes when the turn matches this condition. */
  condition?: MindStoneWorkflowCondition;
};

export type MindStoneWorkflowStep = {
  id: string;
  kind: "route" | "gate";
  /** route: produce this decision when `when` matches (or unconditionally when absent). */
  when?: MindStoneWorkflowCondition;
  personaId?: string;
  skills?: string[];
  knowledgebases?: string[];
  /** gate: requirement that must pass before later steps are considered. */
  gate?: MindStoneWorkflowGate;
  /** Re-evaluate a failing gate up to maxAttempts times before applying onFail. */
  retry?: { maxAttempts?: number };
  /** Gate failure policy: stop = workflow fails (no decision); continue = skip the gate. */
  onFail?: "stop" | "continue";
};

export type MindStoneWorkflowDefinition = {
  id: string;
  dir: string;
  name: string;
  version?: string;
  description?: string;
  steps: MindStoneWorkflowStep[];
};

export type MindStoneWorkflowSummary = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  dir: string;
  stepCount: number;
  error?: string;
};

export type MindStoneWorkflowDecision = {
  workflowId: string;
  stepId: string;
  personaId?: string;
  skills: string[];
  knowledgebases: string[];
};

export type MindStoneWorkflowEvent = {
  event: "workflow_started" | "workflow_step" | "workflow_gate" | "workflow_finished" | "workflow_failed";
  text: string;
  metadata: Record<string, unknown>;
};

export type MindStoneWorkflowOutcome = {
  workflowId: string;
  /** Why this workflow ran: "route:<fields>" or "config.active". */
  reason: string;
  decision?: MindStoneWorkflowDecision;
  failed: boolean;
  events: MindStoneWorkflowEvent[];
};
