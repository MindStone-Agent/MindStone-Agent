import type { AgentId } from "../identity/types.js";

export type TranscriptRole = "user" | "assistant" | "tool" | "system" | "event";

export type TranscriptSource = {
  substrate?: string;
  channel?: string;
  accountId?: string;
  senderId?: string;
  senderName?: string;
  chatType?: "direct" | "group" | "channel" | "thread" | "internal";
};

export type TranscriptEntry = {
  id: string;
  sessionKey: string;
  agentId: AgentId;
  role: TranscriptRole;
  text?: string;
  content?: unknown;
  timestamp: string;
  source?: TranscriptSource;
  runId?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
};
