import type { TranscriptEntry } from "../transcript/index.js";

export type MindStoneModelInfo = {
  id: string;
  provider: string;
  name?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
};

export type MindStoneProviderAuthStatus = {
  configured: boolean;
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command" | "oauth" | "api_key";
  label?: string;
};

export type MindStoneProviderInfo = {
  id: string;
  name: string;
  authStatus?: MindStoneProviderAuthStatus;
  modelCount: number;
  availableModelCount: number;
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
