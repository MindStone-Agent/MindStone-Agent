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

export type MindStoneRoutingMode = "placeholder" | "mock" | "pi" | "pi-session";

export type MindStonePiCompactionConfig = {
  /** Override Pi native compaction enabled state for this isolated route. */
  enabled?: boolean;
  /** Pi native compaction reserve tokens. Raised to reserveTokensFloor when lower. */
  reserveTokens?: number;
  /** Pi native recent-context preservation target. */
  keepRecentTokens?: number;
  /** Minimum reserve tokens to enforce for Pi native compaction. Defaults to 20000. */
  reserveTokensFloor?: number;
  /** Install a fallback-only compaction safeguard hook for no-model/no-api-key compaction paths. Defaults to false. */
  safeguardFallback?: boolean;
};

export type MindStonePiResumeCapConfig = {
  /** Cap Pi SessionManager's in-memory branch after open. Defaults to true for pi-session routes. */
  enabled?: boolean;
  /** Max message-emitting entries to keep in Pi's in-memory branch. Defaults to 800. */
  maxEntries?: number;
  /** Drop assistant turns with stopReason === "error" from the in-memory branch. Defaults to true. */
  dropErrorTurns?: boolean;
};

export type MindStoneRoutingConfig = {
  /** placeholder keeps send/completions transcript-aware without calling a model. */
  mode?: MindStoneRoutingMode;
  defaultAgentId?: string;
  defaultModel?: string;
  mock?: {
    responsePrefix?: string;
  };
  pi?: {
    /** Isolated Pi agent/config directory. Defaults to PI_CODING_AGENT_DIR. */
    agentDir?: string;
    /** Additional Pi extension module paths passed to DefaultResourceLoader. */
    additionalExtensionPaths?: string[];
    /** Additional Pi skill paths passed to DefaultResourceLoader. */
    additionalSkillPaths?: string[];
    /** Additional Pi prompt-template paths passed to DefaultResourceLoader. */
    additionalPromptTemplatePaths?: string[];
    /** Additional Pi theme paths passed to DefaultResourceLoader. */
    additionalThemePaths?: string[];
    /** Session-local Pi native compaction overrides for the isolated route. */
    compaction?: MindStonePiCompactionConfig;
    /** In-memory Pi SessionManager resume cap for long-running isolated sessions. */
    resumeCap?: MindStonePiResumeCapConfig;
    /** Disable Pi extension loading for this route. */
    noExtensions?: boolean;
    /** Disable Pi skill loading for this route. */
    noSkills?: boolean;
    /** Disable Pi prompt-template loading for this route. */
    noPromptTemplates?: boolean;
    /** Disable Pi theme loading for this route. */
    noThemes?: boolean;
    /** Disable Pi context-file loading for this route. */
    noContextFiles?: boolean;
  };
};

export type MindStoneRunnerStreamConfig = {
  /** Persist selected AgentRunner.stream(...) events as transcript event entries. Defaults to false. */
  persistTranscriptEvents?: boolean;
  /** Stream event types to persist. Defaults to substrate_event only. */
  eventTypes?: string[];
  /** Maximum stream events to persist per turn. Defaults to 50. */
  maxEvents?: number;
};

export type MindStoneObservabilityConfig = {
  runnerStream?: MindStoneRunnerStreamConfig;
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
  interactionDetailNotes?: string;
  recommendationStyleNotes?: string;
  workStyleNotes?: string;
  memoryStyle?: MindStoneMemoryStyle;
  memoryStyleNotes?: string;
  setupNotes?: string;
  modelSetupNotes?: string;
  projectContext?: string;
  sensitiveContext?: string;
  selectedAt?: string;
};

export type MindStoneOnboardingConfig = {
  profile?: MindStoneSelectedProfile;
  preferences?: MindStoneOnboardingPreferences;
  identity?: MindStoneOnboardingIdentity;
};

export type MindStonePersonaRouteRuleConfig = {
  personaId: string;
  sessionKeyPrefix?: string;
  sourceChannel?: string;
  sourceSubstrate?: string;
};

export type MindStonePersonasConfigSection = {
  /** Statically activated persona id (route rules take precedence). */
  active?: string;
  /** Override the personas directory (defaults to <dataDir>/personas). */
  dir?: string;
  /** First matching rule wins; falls back to `active`. */
  routes?: MindStonePersonaRouteRuleConfig[];
};

export type MindStoneConfig = {
  workspace?: { root?: string };
  onboarding?: MindStoneOnboardingConfig;
  personas?: MindStonePersonasConfigSection;
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
  observability?: MindStoneObservabilityConfig;
};
