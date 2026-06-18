import {
  estimatePromptTokens,
  resolveContextManagementPolicy,
  type ContextManagementPolicy,
  type ResolvedSlidingWindowContextPolicy,
} from "@mindstone-agent/core";

export type MindStonePiExtensionApi = {
  on(event: "context", handler: MindStonePiContextHandler): void;
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
  noExtensions?: boolean;
};

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

export function buildMindStonePiExtensionFactories(
  options: MindStonePiExtensionFactoryOptions = {},
): MindStonePiExtensionFactory[] {
  if (options.noExtensions) return [];
  const contextPruning = createMindStoneContextPruningExtension(options.contextManagement);
  return contextPruning ? [contextPruning] : [];
}
