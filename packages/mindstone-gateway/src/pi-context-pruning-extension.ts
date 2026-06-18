import {
  estimatePromptTokens,
  resolveContextManagementPolicy,
  type ContextManagementPolicy,
  type MindStonePiCompactionConfig,
  type ResolvedSlidingWindowContextPolicy,
} from "@mindstone-agent/core";

export type MindStonePiExtensionApi = {
  on(event: "context", handler: MindStonePiContextHandler): void;
  on(event: "session_before_compact", handler: MindStonePiSessionBeforeCompactHandler): void;
};

export type MindStonePiExtensionFactory = (api: MindStonePiExtensionApi) => void;

export type MindStonePiContextMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

export type MindStonePiContextEvent = {
  type: "context";
  messages: MindStonePiContextMessage[];
};

export type MindStonePiContext = {
  model?: {
    contextWindow?: number;
  };
};

export type MindStonePiContextResult = {
  messages: MindStonePiContextMessage[];
};

export type MindStonePiContextHandler = (
  event: MindStonePiContextEvent,
  ctx: MindStonePiContext,
) => MindStonePiContextResult | undefined | Promise<MindStonePiContextResult | undefined>;

export type MindStonePiExtensionFactoryOptions = {
  contextManagement?: ContextManagementPolicy;
  compaction?: MindStonePiCompactionConfig;
  noExtensions?: boolean;
};

export type MindStonePiFileOperations = {
  read?: Iterable<string>;
  edited?: Iterable<string>;
  written?: Iterable<string>;
};

export type MindStonePiCompactionPreparation = {
  messagesToSummarize?: MindStonePiContextMessage[];
  turnPrefixMessages?: MindStonePiContextMessage[];
  firstKeptEntryId?: string;
  tokensBefore?: number;
  fileOps?: MindStonePiFileOperations;
};

export type MindStonePiSessionBeforeCompactEvent = {
  type: "session_before_compact";
  preparation?: MindStonePiCompactionPreparation;
};

export type MindStonePiSessionBeforeCompactContext = {
  model?: unknown;
  modelRegistry?: {
    getApiKey?: (model: unknown) => Promise<unknown> | unknown;
  };
};

export type MindStonePiCompactionSafeguardResult = {
  compaction: {
    summary: string;
    firstKeptEntryId?: string;
    tokensBefore?: number;
    details: {
      readFiles: string[];
      modifiedFiles: string[];
    };
  };
};

export type MindStonePiSessionBeforeCompactHandler = (
  event: MindStonePiSessionBeforeCompactEvent,
  ctx: MindStonePiSessionBeforeCompactContext,
) => MindStonePiCompactionSafeguardResult | undefined | Promise<MindStonePiCompactionSafeguardResult | undefined>;

type PruneUnit = {
  indexes: number[];
  tokens: number;
  forced: boolean;
};

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function compactIterableStrings(value: Iterable<string> | undefined): string[] {
  return [...(value ?? [])].filter((item) => item.trim()).sort();
}

function computeFileLists(fileOps: MindStonePiFileOperations | undefined): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...compactIterableStrings(fileOps?.edited), ...compactIterableStrings(fileOps?.written)]);
  const readFiles = compactIterableStrings(fileOps?.read).filter((file) => !modified.has(file));
  return { readFiles, modifiedFiles: [...modified].sort() };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatToolFailures(messages: readonly MindStonePiContextMessage[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError !== true) continue;
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) continue;
    seen.add(toolCallId);
    const toolName = typeof message.toolName === "string" && message.toolName.trim() ? message.toolName : "tool";
    const details = message.details && typeof message.details === "object" ? message.details as Record<string, unknown> : undefined;
    const status = typeof details?.status === "string" ? details.status : undefined;
    const exitCode = typeof details?.exitCode === "number" && Number.isFinite(details.exitCode) ? details.exitCode : undefined;
    const meta = [status ? `status=${status}` : undefined, exitCode !== undefined ? `exitCode=${exitCode}` : undefined].filter(Boolean).join(" ");
    const summary = truncateText(normalizeWhitespace(textFromContent(message.content)) || (meta ? "failed" : "failed (no output)"), 240);
    lines.push(`- ${toolName}${meta ? ` (${meta})` : ""}: ${summary}`);
    if (lines.length >= 8) break;
  }
  return lines.length > 0 ? `\n\n## Tool Failures\n${lines.join("\n")}` : "";
}

function estimateMessageTokens(message: MindStonePiContextMessage): number {
  return estimatePromptTokens(textFromContent(message.content)) + estimatePromptTokens(message.role) + 4;
}

function protectedIndexes(messages: MindStonePiContextMessage[], minRecentMessages: number): Set<number> {
  const protectedSet = new Set<number>();
  const recentStart = Math.max(0, messages.length - minRecentMessages);
  for (let index = recentStart; index < messages.length; index += 1) protectedSet.add(index);
  messages.forEach((message, index) => {
    if (message.role === "system" || message.role === "custom") protectedSet.add(index);
  });
  return protectedSet;
}

function buildPruneUnits(messages: MindStonePiContextMessage[], forcedIndexes: Set<number>): PruneUnit[] {
  const units: PruneUnit[] = [];
  let current: number[] = [];

  const flush = () => {
    if (current.length === 0) return;
    units.push({
      indexes: current,
      tokens: current.reduce((total, index) => total + estimateMessageTokens(messages[index]!), 0),
      forced: current.some((index) => forcedIndexes.has(index)),
    });
    current = [];
  };

  messages.forEach((message, index) => {
    if (message.role === "system" || message.role === "custom") {
      flush();
      current = [index];
      flush();
      return;
    }

    if (message.role === "user") {
      flush();
      current = [index];
      return;
    }

    current.push(index);
  });
  flush();

  return units;
}

function pruneMessagesForPolicy(
  messages: MindStonePiContextMessage[],
  contextWindowTokens: number,
  policy: ResolvedSlidingWindowContextPolicy,
): MindStonePiContextMessage[] | undefined {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return undefined;
  const tokensBefore = messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  if ((tokensBefore / contextWindowTokens) * 100 < policy.ceilingPercent) return undefined;

  const forcedIndexes = protectedIndexes(messages, policy.minRecentMessages);
  const units = buildPruneUnits(messages, forcedIndexes);
  const keptUnits = [...units];
  const floorTokens = Math.floor(contextWindowTokens * (policy.floorPercent / 100));
  let currentTokens = keptUnits.reduce((total, unit) => total + unit.tokens, 0);
  let pruned = false;

  for (let index = 0; index < keptUnits.length && currentTokens > floorTokens;) {
    const unit = keptUnits[index]!;
    if (unit.forced) {
      index += 1;
      continue;
    }
    currentTokens -= unit.tokens;
    keptUnits.splice(index, 1);
    pruned = true;
  }

  if (!pruned) return undefined;
  const keptIndexes = new Set(keptUnits.flatMap((unit) => unit.indexes));
  return messages.filter((_, index) => keptIndexes.has(index));
}

export function createMindStoneContextPruningExtension(
  contextManagement?: ContextManagementPolicy,
): MindStonePiExtensionFactory | undefined {
  const policy = resolveContextManagementPolicy(contextManagement);
  if (policy.mode !== "sliding_window") return undefined;

  return (api: MindStonePiExtensionApi): void => {
    api.on("context", (event, ctx) => {
      const pruned = pruneMessagesForPolicy(event.messages, ctx.model?.contextWindow ?? 0, policy);
      return pruned ? { messages: pruned } : undefined;
    });
  };
}

export function createMindStoneCompactionSafeguardExtension(
  compaction?: MindStonePiCompactionConfig,
): MindStonePiExtensionFactory | undefined {
  if (compaction?.safeguardFallback !== true) return undefined;

  return (api: MindStonePiExtensionApi): void => {
    api.on("session_before_compact", async (event, ctx) => {
      if (ctx.model && typeof ctx.modelRegistry?.getApiKey === "function") {
        const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
        if (apiKey) return undefined;
      }

      const preparation = event.preparation;
      const { readFiles, modifiedFiles } = computeFileLists(preparation?.fileOps);
      const messages = [
        ...(preparation?.messagesToSummarize ?? []),
        ...(preparation?.turnPrefixMessages ?? []),
      ];
      const summary = [
        "Summary unavailable because Pi compaction had no authenticated model context. Older messages were truncated by MindStone-Agent's fallback safeguard.",
        formatToolFailures(messages),
        formatFileOperations(readFiles, modifiedFiles),
      ].join("");

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation?.firstKeptEntryId,
          tokensBefore: preparation?.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    });
  };
}

export function buildMindStonePiExtensionFactories(
  options: MindStonePiExtensionFactoryOptions = {},
): MindStonePiExtensionFactory[] {
  if (options.noExtensions) return [];
  return [
    createMindStoneContextPruningExtension(options.contextManagement),
    createMindStoneCompactionSafeguardExtension(options.compaction),
  ].filter((factory): factory is MindStonePiExtensionFactory => Boolean(factory));
}
