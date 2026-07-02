import { estimatePromptTokens } from "../context/index.js";
import type { TranscriptEntry } from "../transcript/index.js";
import { scopeMatchesRecallFilter } from "../app-engine/types.js";
import type {
  MemoryDocument,
  MemoryHit,
  MemoryQuery,
  MemoryRecallConfig,
  MemoryRecallProvider,
  MemoryRecallResult,
} from "./types.js";
import { rankMemoryHitsWithScri } from "./scri-ranking.js";

export type MemoryRecallInput = {
  agentId: string;
  entries: TranscriptEntry[];
  provider?: MemoryRecallProvider;
  config?: MemoryRecallConfig;
  /**
   * App Engine / Agent Mesh recall scope filter. Scoped documents (metadata.scope)
   * are recalled only when their scope matches this filter exactly; unscoped
   * documents remain globally eligible. Absent filter = companion mode: scoped
   * documents never surface.
   */
  scope?: Record<string, string>;
};

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_PROMPT_TOKENS = 2500;
const DEFAULT_MIN_SCORE = 0.15;

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_+-]+/g)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3),
  );
}

function lexicalScore(query: string, text: string): number {
  const queryWords = words(query);
  if (queryWords.size === 0) return 0;
  const textWords = words(text);
  let matches = 0;
  for (const word of queryWords) {
    if (textWords.has(word)) matches += 1;
  }
  return matches / queryWords.size;
}

function lastUserText(entries: TranscriptEntry[]): string | undefined {
  return [...entries].reverse().find((entry) => entry.role === "user" && entry.text?.trim())?.text?.trim();
}

function chunkFromDocument(document: MemoryDocument, ordinal: number): MemoryHit {
  return {
    ...document,
    chunkId: `${document.id}#0`,
    sourceId: document.id,
    ordinal,
    score: 0,
  };
}

export class LocalMemoryRecallProvider implements MemoryRecallProvider {
  readonly id = "local";
  readonly #documents: MemoryDocument[];

  constructor(documents: MemoryDocument[]) {
    this.#documents = documents;
  }

  search(query: MemoryQuery): MemoryHit[] {
    const limit = query.limit ?? DEFAULT_MAX_RESULTS;
    return this.#documents
      .map((document, index) => ({ ...chunkFromDocument(document, index), score: lexicalScore(query.text, document.text) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
}

export function createLocalMemoryRecallProvider(documents: MemoryDocument[] | undefined): MemoryRecallProvider | undefined {
  return documents?.length ? new LocalMemoryRecallProvider(documents) : undefined;
}

function formatHit(hit: MemoryHit, index: number): string {
  const title = hit.title ?? hit.path ?? hit.id;
  const metadata = hit.metadata ?? {};
  const providerScore = typeof metadata.providerScore === "number" ? `, provider ${metadata.providerScore.toFixed(2)}` : "";
  const scri = metadata.scri as { reasons?: unknown } | undefined;
  const reasons = Array.isArray(scri?.reasons) ? ` — ${(scri.reasons as string[]).join(", ")}` : "";
  return [`${index + 1}. ${title} (SCRI ${hit.score.toFixed(2)}${providerScore})${reasons}`, hit.text.trim()].join("\n");
}

export function buildMemoryRecallPrompt(hits: MemoryHit[], maxPromptTokens = DEFAULT_MAX_PROMPT_TOKENS): { text?: string; tokens: number; hits: MemoryHit[] } {
  const selected: MemoryHit[] = [];
  const sections: string[] = [];
  let tokens = estimatePromptTokens("Relevant MindStone memory:\n");

  for (const hit of hits) {
    const next = formatHit(hit, selected.length);
    const nextTokens = estimatePromptTokens(next);
    if (selected.length > 0 && tokens + nextTokens > maxPromptTokens) break;
    selected.push(hit);
    sections.push(next);
    tokens += nextTokens;
  }

  if (sections.length === 0) return { tokens: 0, hits: [] };
  return {
    text: [
      "Relevant MindStone memory follows. Use it as context, not as unquestioned truth. If it conflicts with current user instructions or local evidence, prefer current verified evidence.",
      "",
      ...sections,
    ].join("\n\n"),
    tokens,
    hits: selected,
  };
}

export async function recallMindStoneMemory(input: MemoryRecallInput): Promise<MemoryRecallResult | undefined> {
  const provider = input.provider;
  if (!provider) return undefined;
  const query = lastUserText(input.entries);
  if (!query) return undefined;

  const limit = input.config?.maxResults ?? DEFAULT_MAX_RESULTS;
  const minScore = input.config?.minScore ?? DEFAULT_MIN_SCORE;
  const maxPromptTokens = input.config?.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
  const rawHits = await provider.search({ text: query, limit: Math.max(limit * 3, limit), agentId: input.agentId });
  const scopeRejected: Array<{ id: string; chunkId: string; reason: string }> = [];
  const scopedHits = rawHits.filter((hit) => {
    const documentScope = hit.metadata?.scope as Record<string, unknown> | undefined;
    if (scopeMatchesRecallFilter(documentScope, input.scope)) return true;
    scopeRejected.push({ id: hit.id, chunkId: hit.chunkId, reason: "scope_mismatch" });
    return false;
  });
  const thresholdHits = scopedHits.filter((hit) => hit.score >= minScore);
  const ranked = rankMemoryHitsWithScri(thresholdHits, {
    activeEntries: input.entries,
    dedupAgainstActiveContext: input.config?.dedupAgainstActiveContext,
    maxActiveEntriesForDedup: input.config?.maxActiveEntriesForDedup,
  });
  const hits = ranked.hits.slice(0, limit);
  if (hits.length === 0) {
    return {
      query,
      hits: [],
      promptTokens: 0,
      diagnostics: {
        rawHitCount: rawHits.length,
        rankedHitCount: ranked.hits.length,
        selectedHitCount: 0,
        rejected: [...scopeRejected, ...ranked.rejected],
      },
    };
  }

  const prompt = buildMemoryRecallPrompt(hits, maxPromptTokens);
  return {
    query,
    hits: prompt.hits,
    promptText: prompt.text,
    promptTokens: prompt.tokens,
    diagnostics: {
      rawHitCount: rawHits.length,
      rankedHitCount: ranked.hits.length,
      selectedHitCount: prompt.hits.length,
      rejected: [...scopeRejected, ...ranked.rejected],
    },
  };
}
