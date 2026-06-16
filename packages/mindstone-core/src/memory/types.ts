export type MemoryKind = "identity" | "journal" | "doc" | "wiki" | "transcript" | "checkpoint" | "custom";

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
