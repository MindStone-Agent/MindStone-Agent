import type { MemoryHit } from "../memory/types.js";

export type ScriRecallInput = {
  agentId: string;
  prompt: string;
  sessionKey?: string;
  sessionTail?: string;
  maxHits?: number;
  maxChars?: number;
};

export type ScriRecallResult = {
  hits: MemoryHit[];
  injection: string;
  stats: {
    searched: number;
    selected: number;
    budgetChars: number;
  };
};
