import { buildPromptWindow, type PromptWindowBuildResult } from "../context/index.js";
import type { ContextManagementPolicy } from "../context/index.js";
import { recallMindStoneMemory, type MemoryRecallConfig, type MemoryRecallProvider, type MemoryRecallResult } from "../memory/index.js";
import type { MindStoneChatMessage, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider } from "../provider/index.js";
import type { TranscriptEntry } from "../transcript/index.js";

export type MindStoneRouteInput = {
  agentId: string;
  sessionKey: string;
  entries: TranscriptEntry[];
  model: MindStoneModelInfo;
  provider: MindStoneModelProvider;
  contextManagement?: ContextManagementPolicy;
  reservedTokens?: number;
  protectedEntryIds?: string[];
  memoryRecall?: {
    enabled?: boolean;
    provider?: MemoryRecallProvider;
    config?: MemoryRecallConfig;
  };
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type MindStoneRoutePlan = {
  agentId: string;
  sessionKey: string;
  model: MindStoneModelInfo;
  promptWindow: PromptWindowBuildResult;
  messages: MindStoneChatMessage[];
  memoryRecall?: MemoryRecallResult;
};

export type MindStoneRouteResult = MindStoneRoutePlan & {
  result: MindStoneChatResult;
};

function transcriptEntryToChatMessage(entry: TranscriptEntry): MindStoneChatMessage | undefined {
  if (entry.role !== "system" && entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") return undefined;
  return {
    role: entry.role,
    text: entry.text,
    content: entry.content,
    sourceEntryId: entry.id,
  };
}

export function buildMindStoneRoutePlan(input: Omit<MindStoneRouteInput, "provider" | "signal" | "memoryRecall"> & { memoryRecall?: MemoryRecallResult }): MindStoneRoutePlan {
  const promptWindow = buildPromptWindow({
    entries: input.entries,
    contextWindowTokens: input.model.contextWindowTokens ?? 128_000,
    policy: input.contextManagement,
    reservedTokens: (input.reservedTokens ?? 0) + (input.memoryRecall?.promptTokens ?? 0),
    protectedEntryIds: input.protectedEntryIds,
  });
  const messages = promptWindow.promptEntries.map(transcriptEntryToChatMessage).filter((message): message is MindStoneChatMessage => Boolean(message));
  if (input.memoryRecall?.promptText) {
    messages.unshift({ role: "system", text: input.memoryRecall.promptText });
  }
  return {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    model: input.model,
    promptWindow,
    messages,
    memoryRecall: input.memoryRecall,
  };
}

export async function runMindStoneRoute(input: MindStoneRouteInput): Promise<MindStoneRouteResult> {
  const memoryRecall = input.memoryRecall?.enabled
    ? await recallMindStoneMemory({
        agentId: input.agentId,
        entries: input.entries,
        provider: input.memoryRecall.provider,
        config: input.memoryRecall.config,
      })
    : undefined;
  const plan = buildMindStoneRoutePlan({ ...input, memoryRecall });
  const result = await input.provider.completeChat({
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    model: input.model,
    messages: plan.messages,
    transcriptEntries: input.entries,
    signal: input.signal,
    metadata: input.metadata,
  });
  return { ...plan, result };
}
