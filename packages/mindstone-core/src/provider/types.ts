import type { TranscriptEntry } from "../transcript/index.js";

export type MindStoneModelInfo = {
  id: string;
  provider: string;
  name?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
};

export type MindStoneChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  text?: string;
  content?: unknown;
  sourceEntryId?: string;
};

export type MindStoneChatRequest = {
  agentId: string;
  sessionKey: string;
  model: MindStoneModelInfo;
  messages: MindStoneChatMessage[];
  transcriptEntries: TranscriptEntry[];
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type MindStoneChatResult = {
  role: "assistant";
  text: string;
  content?: unknown;
  model?: MindStoneModelInfo;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  raw?: unknown;
};

export interface MindStoneModelProvider {
  id: string;
  listModels(): Promise<MindStoneModelInfo[]> | MindStoneModelInfo[];
  completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult>;
}
