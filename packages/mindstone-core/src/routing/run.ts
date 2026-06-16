import { buildPromptWindow, type PromptWindowBuildResult } from "../context/index.js";
import type { ContextManagementPolicy } from "../context/index.js";
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
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type MindStoneRoutePlan = {
  agentId: string;
  sessionKey: string;
  model: MindStoneModelInfo;
  promptWindow: PromptWindowBuildResult;
  messages: MindStoneChatMessage[];
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

export function buildMindStoneRoutePlan(input: Omit<MindStoneRouteInput, "provider" | "signal">): MindStoneRoutePlan {
  const promptWindow = buildPromptWindow({
    entries: input.entries,
    contextWindowTokens: input.model.contextWindowTokens ?? 128_000,
    policy: input.contextManagement,
    reservedTokens: input.reservedTokens,
    protectedEntryIds: input.protectedEntryIds,
  });
  return {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    model: input.model,
    promptWindow,
    messages: promptWindow.promptEntries.map(transcriptEntryToChatMessage).filter((message): message is MindStoneChatMessage => Boolean(message)),
  };
}

export async function runMindStoneRoute(input: MindStoneRouteInput): Promise<MindStoneRouteResult> {
  const plan = buildMindStoneRoutePlan(input);
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
