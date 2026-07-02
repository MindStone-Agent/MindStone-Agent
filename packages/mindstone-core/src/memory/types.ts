export type MemoryKind = "identity" | "journal" | "doc" | "wiki" | "transcript" | "checkpoint" | "log" | "index" | "kb" | "custom";

export type MemoryDocument = {
  id: string;
  kind: MemoryKind;
  text: string;
  path?: string;
  title?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export type MemoryChunk = MemoryDocument & {
  chunkId: string;
  sourceId: string;
  ordinal: number;
};

export type MemoryHit = MemoryChunk & {
  score: number;
  distance?: number;
};

export type MemoryQuery = {
  text: string;
  limit?: number;
  agentId?: string;
  filters?: Record<string, unknown>;
};

export type MemoryRecallConfig = {
  maxResults?: number;
  maxPromptTokens?: number;
  minScore?: number;
  dedupAgainstActiveContext?: boolean;
  maxActiveEntriesForDedup?: number;
};

export type MemoryRecallRejectedHit = {
  id: string;
  chunkId: string;
  reason: string;
};

export type MemoryRecallResult = {
  query: string;
  hits: MemoryHit[];
  promptText?: string;
  promptTokens: number;
  diagnostics?: {
    rawHitCount: number;
    rankedHitCount: number;
    selectedHitCount: number;
    rejected: MemoryRecallRejectedHit[];
  };
};

export interface MemoryRecallProvider {
  id: string;
  search(query: MemoryQuery): Promise<MemoryHit[]> | MemoryHit[];
}
