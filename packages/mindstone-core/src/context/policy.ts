import type { ContextManagementPolicy } from "./types.js";

export type ResolvedAutoCompactContextPolicy = {
  mode: "auto_compact";
  checkpointWarningPercent: number;
  compactTargetPercent: number;
  keepRecentTokens: number;
  emergencyAutoHandoff: boolean;
};

export type ResolvedSlidingWindowContextPolicy = {
  mode: "sliding_window";
  ceilingPercent: number;
  floorPercent: number;
  minRecentMessages: number;
  preserveTranscript: boolean;
};

export type ResolvedContextManagementPolicy =
  | ResolvedAutoCompactContextPolicy
  | ResolvedSlidingWindowContextPolicy;

const DEFAULT_AUTO_COMPACT: ResolvedAutoCompactContextPolicy = {
  mode: "auto_compact",
  checkpointWarningPercent: 85,
  compactTargetPercent: 92,
  keepRecentTokens: 20_000,
  emergencyAutoHandoff: false,
};

const DEFAULT_SLIDING_WINDOW: ResolvedSlidingWindowContextPolicy = {
  mode: "sliding_window",
  ceilingPercent: 92,
  floorPercent: 70,
  minRecentMessages: 24,
  preserveTranscript: true,
};

function clampPercent(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 1), 99);
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

export function resolveContextManagementPolicy(
  policy?: ContextManagementPolicy,
): ResolvedContextManagementPolicy {
  if (policy?.mode === "auto_compact") {
    return {
      mode: "auto_compact",
      checkpointWarningPercent: clampPercent(
        policy.checkpointWarningPercent,
        DEFAULT_AUTO_COMPACT.checkpointWarningPercent,
      ),
      compactTargetPercent: clampPercent(
        policy.compactTargetPercent,
        DEFAULT_AUTO_COMPACT.compactTargetPercent,
      ),
      keepRecentTokens: positiveInteger(policy.keepRecentTokens, DEFAULT_AUTO_COMPACT.keepRecentTokens),
      emergencyAutoHandoff: policy.emergencyAutoHandoff ?? DEFAULT_AUTO_COMPACT.emergencyAutoHandoff,
    };
  }

  const ceilingPercent = clampPercent(policy?.ceilingPercent, DEFAULT_SLIDING_WINDOW.ceilingPercent);
  const rawFloorPercent = clampPercent(policy?.floorPercent, DEFAULT_SLIDING_WINDOW.floorPercent);
  return {
    mode: "sliding_window",
    ceilingPercent,
    floorPercent: Math.min(rawFloorPercent, ceilingPercent - 1),
    minRecentMessages: positiveInteger(policy?.minRecentMessages, DEFAULT_SLIDING_WINDOW.minRecentMessages),
    preserveTranscript: policy?.preserveTranscript ?? DEFAULT_SLIDING_WINDOW.preserveTranscript,
  };
}

export function reserveTokensForAutoCompactTarget(contextWindow: number, targetPercent: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.ceil(contextWindow * (1 - targetPercent / 100));
}
