import type { ContextManagementPolicy } from "../context/index.js";
import type { MemoryDocument, MemoryRecallConfig } from "../memory/index.js";
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

export type MindStoneFileMemoryConfig = {
  enabled?: boolean;
  memoryDir?: string;
  journalsDir?: string;
  logPath?: string;
  indexPath?: string;
  includeMemoryFiles?: boolean;
  includeJournals?: boolean;
  includeLog?: boolean;
};

export type MindStoneMemoryConfig = {
  autoRecall?: boolean;
  vectorStore?: "lancedb" | "sqlite-vec" | "memory";
  /** Embedding provider spec, e.g. ollama:nomic-embed-text or openai:text-embedding-3-small. */
  embeddingProvider?: string;
  recall?: MemoryRecallConfig;
  files?: MindStoneFileMemoryConfig;
  /** Deterministic local memory docs for development/smoke tests before live vector providers are wired. */
  localDocuments?: MemoryDocument[];
};

export type MindStoneSessionConfig = {
  /** single routes all surfaces into one continuity session by default; per_surface keeps channel-derived keys. */
  mode?: "single" | "per_surface";
  /** Default session key used when mode is single, or as fallback when no surface key can be derived. */
  defaultSessionKey?: string;
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
export type MindStoneIdentityEmergenceMode = "defer" | "seed" | "custom";

export type MindStoneOnboardingIdentity = {
  mode?: MindStoneIdentityEmergenceMode;
  candidateName?: string;
  identityDirection?: string;
  namingNotes?: string;
  selectedAt?: string;
};

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
  identity?: MindStoneOnboardingIdentity;
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
  session?: MindStoneSessionConfig;
  memory?: MindStoneMemoryConfig;
  contextManagement?: ContextManagementPolicy;
  routing?: MindStoneRoutingConfig;
};
