import type { ContextManagementPolicy } from "../context/index.js";
import type { MindStoneSelectedProfile } from "../profile/index.js";

export type GatewayAuthConfig =
  | { mode: "none" }
  | { mode: "token"; tokenFile?: string; tokenEnv?: string }
  | { mode: "password"; passwordEnv?: string };

export type MindStoneAgentConfig = {
  id: string;
  identityPath?: string;
  userPath?: string;
  defaultModel?: string;
  /** Configured maximum context window for the agent's current/default model. */
  contextWindowTokens?: number;
  /** Selected onboarding profile that seeded this agent. */
  profileId?: string;
};

export type MindStoneMemoryConfig = {
  autoRecall?: boolean;
  vectorStore?: "lancedb" | "sqlite-vec" | "memory";
  embeddingProvider?: string;
};

export type MindStoneRoutingConfig = {
  /** placeholder keeps send/completions transcript-aware without calling a model. */
  mode?: "placeholder" | "mock" | "pi";
  defaultAgentId?: string;
  defaultModel?: string;
  mock?: {
    responsePrefix?: string;
  };
  pi?: {
    /** Isolated Pi agent/config directory. Defaults to PI_CODING_AGENT_DIR. */
    agentDir?: string;
  };
};

export type MindStoneInteractionDetail = "concise" | "balanced" | "detailed";
export type MindStoneRecommendationStyle = "direct" | "options_tradeoffs" | "ask_first";
export type MindStoneWorkStyle = "act_directly" | "plan_first" | "ask_first";
export type MindStoneApprovalMode = "standard" | "strict" | "custom";
export type MindStoneMemoryStyle = "propose_checkpoint_memories" | "minimal" | "ask_each_time";

export type MindStoneOnboardingPreferences = {
  interactionDetail?: MindStoneInteractionDetail;
  recommendationStyle?: MindStoneRecommendationStyle;
  workStyle?: MindStoneWorkStyle;
  approvalMode?: MindStoneApprovalMode;
  approvalNotes?: string;
  memoryStyle?: MindStoneMemoryStyle;
  projectContext?: string;
  sensitiveContext?: string;
  selectedAt?: string;
};

export type MindStoneOnboardingConfig = {
  profile?: MindStoneSelectedProfile;
  preferences?: MindStoneOnboardingPreferences;
};

export type MindStoneConfig = {
  workspace?: { root?: string };
  onboarding?: MindStoneOnboardingConfig;
  gateway?: {
    host?: string;
    port?: number;
    auth?: GatewayAuthConfig;
    http?: {
      chatCompletions?: { enabled?: boolean };
      responses?: { enabled?: boolean };
    };
  };
  agents?: Record<string, MindStoneAgentConfig>;
  channels?: Record<string, unknown>;
  memory?: MindStoneMemoryConfig;
  contextManagement?: ContextManagementPolicy;
  routing?: MindStoneRoutingConfig;
};
