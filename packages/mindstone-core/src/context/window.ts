import type { TranscriptEntry, TranscriptRole } from "../transcript/index.js";
import { reserveTokensForAutoCompactTarget, resolveContextManagementPolicy, type ResolvedAutoCompactContextPolicy, type ResolvedContextManagementPolicy, type ResolvedSlidingWindowContextPolicy } from "./policy.js";
import type { ContextManagementPolicy } from "./types.js";

export type PromptWindowBuildInput = {
  entries: TranscriptEntry[];
  contextWindowTokens: number;
  policy?: ContextManagementPolicy;
  /** Token budget consumed by system prompt, identity, user profile, SCRI recall, tools, etc. */
  reservedTokens?: number;
  /** Entry IDs that must remain in the prompt window. */
  protectedEntryIds?: string[];
};

export type PromptWindowAutoCompactEvent = {
  event: "auto_compact_warning" | "auto_compact_required";
  mode: "auto_compact";
  tokens: number;
  contextWindowTokens: number;
  utilizationPercent: number;
  checkpointWarningPercent: number;
  compactTargetPercent: number;
  keepRecentTokens: number;
  reserveTokens: number;
  emergencyAutoHandoff: boolean;
  action: "prepare_checkpoint_handoff" | "request_compaction";
};

export type PromptWindowPruneEvent = {
  event: "context_window_pruned";
  mode: "sliding_window";
  tokensBefore: number;
  tokensAfter: number;
  contextWindowTokens: number;
  ceilingPercent: number;
  floorPercent: number;
  minRecentMessages: number;
  prunedEntries: number;
  keptEntries: number;
  prunedEntryIds: string[];
  keptEntryIds: string[];
};

export type PromptWindowBuildResult = {
  policy: ResolvedContextManagementPolicy;
  entries: TranscriptEntry[];
  promptEntries: TranscriptEntry[];
  prunedEntries: TranscriptEntry[];
  tokensBefore: number;
  tokensAfter: number;
  utilizationBeforePercent: number;
  utilizationAfterPercent: number;
  pruned: boolean;
  pruneEvent?: PromptWindowPruneEvent;
  autoCompactEvent?: PromptWindowAutoCompactEvent;
};

type PromptUnit = {
  entries: TranscriptEntry[];
  tokenEstimate: number;
  forced: boolean;
};

const PROMPT_ROLES = new Set<TranscriptRole>(["system", "user", "assistant", "tool"]);

export function estimatePromptTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  return Math.ceil(text.length / 4) + 4;
}

function estimateEntryTokens(entry: TranscriptEntry): number {
  return estimatePromptTokens(entry.text) + estimatePromptTokens(entry.content) + 4;
}

function utilizationPercent(tokens: number, contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return 0;
  return (tokens / contextWindowTokens) * 100;
}

function isPromptEntry(entry: TranscriptEntry): boolean {
  return PROMPT_ROLES.has(entry.role);
}

function recentPromptEntryIds(entries: TranscriptEntry[], count: number): Set<string> {
  return new Set(entries.filter(isPromptEntry).slice(-count).map((entry) => entry.id));
}

function buildPromptUnits(entries: TranscriptEntry[], forcedIds: Set<string>): PromptUnit[] {
  const units: PromptUnit[] = [];
  let current: TranscriptEntry[] = [];

  const flush = () => {
    if (current.length === 0) return;
    units.push({
      entries: current,
      tokenEstimate: current.reduce((total, entry) => total + estimateEntryTokens(entry), 0),
      forced: current.some((entry) => forcedIds.has(entry.id) || entry.role === "system"),
    });
    current = [];
  };

  for (const entry of entries) {
    if (!isPromptEntry(entry)) continue;

    if (entry.role === "system") {
      flush();
      current = [entry];
      flush();
      continue;
    }

    if (entry.role === "user") {
      flush();
      current = [entry];
      continue;
    }

    current.push(entry);
  }
  flush();

  return units;
}

function flattenUnits(units: PromptUnit[]): TranscriptEntry[] {
  return units.flatMap((unit) => unit.entries);
}

function buildSlidingWindow(input: PromptWindowBuildInput, policy: ResolvedSlidingWindowContextPolicy): PromptWindowBuildResult {
  const reservedTokens = Math.max(0, Math.floor(input.reservedTokens ?? 0));
  const promptEntries = input.entries.filter(isPromptEntry);
  const tokensBefore = reservedTokens + promptEntries.reduce((total, entry) => total + estimateEntryTokens(entry), 0);
  const utilizationBefore = utilizationPercent(tokensBefore, input.contextWindowTokens);

  if (utilizationBefore < policy.ceilingPercent) {
    return {
      policy,
      entries: input.entries,
      promptEntries,
      prunedEntries: [],
      tokensBefore,
      tokensAfter: tokensBefore,
      utilizationBeforePercent: utilizationBefore,
      utilizationAfterPercent: utilizationBefore,
      pruned: false,
    };
  }

  const forcedIds = new Set(input.protectedEntryIds ?? []);
  for (const id of recentPromptEntryIds(input.entries, policy.minRecentMessages)) forcedIds.add(id);

  const units = buildPromptUnits(input.entries, forcedIds);
  const keptUnits = [...units];
  const prunedUnits: PromptUnit[] = [];
  const floorTokens = Math.floor(input.contextWindowTokens * (policy.floorPercent / 100));
  let currentTokens = reservedTokens + keptUnits.reduce((total, unit) => total + unit.tokenEstimate, 0);

  for (let index = 0; index < keptUnits.length && currentTokens > floorTokens;) {
    const unit = keptUnits[index];
    if (unit.forced) {
      index += 1;
      continue;
    }
    prunedUnits.push(unit);
    currentTokens -= unit.tokenEstimate;
    keptUnits.splice(index, 1);
  }

  const selectedEntries = flattenUnits(keptUnits);
  const prunedEntries = flattenUnits(prunedUnits);
  const tokensAfter = reservedTokens + selectedEntries.reduce((total, entry) => total + estimateEntryTokens(entry), 0);
  const utilizationAfter = utilizationPercent(tokensAfter, input.contextWindowTokens);
  const pruned = prunedEntries.length > 0;

  return {
    policy,
    entries: input.entries,
    promptEntries: selectedEntries,
    prunedEntries,
    tokensBefore,
    tokensAfter,
    utilizationBeforePercent: utilizationBefore,
    utilizationAfterPercent: utilizationAfter,
    pruned,
    pruneEvent: pruned
      ? {
          event: "context_window_pruned",
          mode: "sliding_window",
          tokensBefore,
          tokensAfter,
          contextWindowTokens: input.contextWindowTokens,
          ceilingPercent: policy.ceilingPercent,
          floorPercent: policy.floorPercent,
          minRecentMessages: policy.minRecentMessages,
          prunedEntries: prunedEntries.length,
          keptEntries: selectedEntries.length,
          prunedEntryIds: prunedEntries.map((entry) => entry.id),
          keptEntryIds: selectedEntries.map((entry) => entry.id),
        }
      : undefined,
  };
}

function autoCompactEvent(
  tokens: number,
  contextWindowTokens: number,
  utilization: number,
  policy: ResolvedAutoCompactContextPolicy,
): PromptWindowAutoCompactEvent | undefined {
  if (utilization < policy.checkpointWarningPercent) return undefined;
  const required = utilization >= policy.compactTargetPercent;
  return {
    event: required ? "auto_compact_required" : "auto_compact_warning",
    mode: "auto_compact",
    tokens,
    contextWindowTokens,
    utilizationPercent: utilization,
    checkpointWarningPercent: policy.checkpointWarningPercent,
    compactTargetPercent: policy.compactTargetPercent,
    keepRecentTokens: policy.keepRecentTokens,
    reserveTokens: reserveTokensForAutoCompactTarget(contextWindowTokens, policy.compactTargetPercent),
    emergencyAutoHandoff: policy.emergencyAutoHandoff,
    action: required ? "request_compaction" : "prepare_checkpoint_handoff",
  };
}

export function buildPromptWindow(input: PromptWindowBuildInput): PromptWindowBuildResult {
  const policy = resolveContextManagementPolicy(input.policy);
  if (policy.mode === "auto_compact") {
    const promptEntries = input.entries.filter(isPromptEntry);
    const tokens = Math.max(0, Math.floor(input.reservedTokens ?? 0)) + promptEntries.reduce((total, entry) => total + estimateEntryTokens(entry), 0);
    const utilization = utilizationPercent(tokens, input.contextWindowTokens);
    return {
      policy,
      entries: input.entries,
      promptEntries,
      prunedEntries: [],
      tokensBefore: tokens,
      tokensAfter: tokens,
      utilizationBeforePercent: utilization,
      utilizationAfterPercent: utilization,
      pruned: false,
      autoCompactEvent: autoCompactEvent(tokens, input.contextWindowTokens, utilization, policy),
    };
  }

  return buildSlidingWindow(input, policy);
}
