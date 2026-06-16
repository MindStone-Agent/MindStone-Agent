export type ContextManagementMode = "auto_compact" | "sliding_window";

export type AutoCompactContextPolicy = {
  mode: "auto_compact";
  /** Prompt/draft checkpoint + handoff before native compaction danger zone. */
  checkpointWarningPercent?: number;
  /** Native compaction target as utilization percentage of current model context window. */
  compactTargetPercent?: number;
  /** Recent token budget to preserve when native compaction summarizes older context. */
  keepRecentTokens?: number;
  /** Whether checkpoint/handoff content may be written without interactive approval in emergencies. */
  emergencyAutoHandoff?: boolean;
};

export type SlidingWindowContextPolicy = {
  mode: "sliding_window";
  /** Fire pruning when utilization reaches this percent of the current model context window. */
  ceilingPercent?: number;
  /** Prune down toward this percent of the current model context window. */
  floorPercent?: number;
  /** Never prune below this many recent prompt-window messages, even if the floor target would. */
  minRecentMessages?: number;
  /** Preserve the full transcript even when older messages are removed from the prompt window. */
  preserveTranscript?: boolean;
};

export type ContextManagementPolicy = AutoCompactContextPolicy | SlidingWindowContextPolicy;
