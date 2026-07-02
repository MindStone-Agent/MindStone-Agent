export type MindStoneKnowledgebaseCatalog = {
  name?: string;
  version?: string;
  description?: string;
};

export type MindStoneKnowledgebase = {
  id: string;
  dir: string;
  name: string;
  version?: string;
  description?: string;
  sourcesDir: string;
  indexPath: string;
};

/** One indexed section of one source document. Citations always survive ingest. */
export type MindStoneKbIndexEntry = {
  /** Stable id: <relative-source-path>#<section-slug or 0-based ordinal>. */
  entryId: string;
  sourceId: string;
  /** Source path relative to the KB's sources dir. */
  sourcePath: string;
  sourceTitle?: string;
  /** Heading of the section this entry covers, when the source has headings. */
  section?: string;
  /** Human-readable citation, e.g. "guides/setup.md § Install". */
  citation: string;
  /** Deterministic extractive summary (first paragraph, truncated) — never model-generated. */
  summary: string;
  text: string;
  sourceMtimeMs: number;
};

export type MindStoneKbIndex = {
  kbId: string;
  ingestedAt?: string;
  entries: MindStoneKbIndexEntry[];
};

export type MindStoneKbSourceStatus = {
  sourceId: string;
  sourcePath: string;
  state: "indexed" | "stale" | "unindexed" | "missing";
  entryCount: number;
};

export type MindStoneKbStatus = {
  kbId: string;
  dir: string;
  indexed: boolean;
  ingestedAt?: string;
  entryCount: number;
  sourceCount: number;
  staleCount: number;
  sources: MindStoneKbSourceStatus[];
};

export type MindStoneKbSearchHit = {
  entry: MindStoneKbIndexEntry;
  score: number;
};

export type MindStoneKnowledgebaseSummary = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  dir: string;
  indexed: boolean;
  entryCount: number;
  sourceCount: number;
  error?: string;
};
