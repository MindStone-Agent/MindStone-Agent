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
import { logRecallUsage } from "./recall-usage.js";

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
  /** Not the owner's turn: the owner's chat transcripts are left out (#106 review). */
  excludeOwnerTranscripts?: boolean;
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

/** Letters and digits in any script, compared case- and width-insensitively (#106 review). */
function normalizedQuestion(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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

/** The quota of KB sources ranked by meaning (#125 §5). */
export const KB_RECALL_QUOTA = "knowledgebase";

/**
 * A hit with its own quota (#125 §5: KB sources ranked by meaning). Its score
 * is on another scale, so it never competes with other hits on score: the
 * merge keeps it next to the best `limit` others, and the turn's selection
 * gives it a slot of its own. The provider that marks hits caps how many.
 */
export function isQuotaHit(hit: MemoryHit): boolean {
  return hit.kind === "kb" && hit.metadata?.recallQuota === KB_RECALL_QUOTA;
}

/**
 * The `limit` hits a turn keeps: quota hits first claim their slots, the rest
 * go to the best others. A source already in by its quota copy isn't taken
 * again by its other copy. Order is kept.
 */
export function selectRecallHits(hits: MemoryHit[], limit: number): MemoryHit[] {
  const allQuota = hits.filter(isQuotaHit);
  // KB slots come out of the same limit: when memory has a hit of its own
  // (not a KB source's word copy), it keeps at least one slot (#151).
  // Memory's own: not a KB source, whether found by meaning or only by words (#151 review).
  const memoryWaiting = hits.some((hit) => hit.kind !== "kb");
  const quota = allQuota.slice(0, Math.max(0, memoryWaiting ? limit - 1 : limit));
  const inByQuota = new Set(quota.map((hit) => hit.id));
  const candidates = hits.filter((hit) => !isQuotaHit(hit) && !inByQuota.has(hit.id));
  const room = Math.max(0, limit - quota.length);
  let others = candidates.slice(0, room);
  // The slot kept for memory goes to a hit of memory's own, not to a KB
  // source's word copy ranked above it (#151 review).
  if (memoryWaiting && room > 0 && !others.some((hit) => hit.kind !== "kb")) {
    const memory = candidates.find((hit) => hit.kind !== "kb");
    if (memory) others = [...others.slice(0, room - 1), memory];
  }
  const kept = new Set([...quota, ...others]);
  return hits.filter((hit) => kept.has(hit));
}

/** Several providers searched as one: their hits merged by score, quota hits kept beside them. */
export class CombinedMemoryRecallProvider implements MemoryRecallProvider {
  readonly id: string;
  readonly #providers: MemoryRecallProvider[];

  constructor(providers: MemoryRecallProvider[]) {
    this.#providers = providers;
    this.id = providers.map((provider) => provider.id).join("+");
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const limit = query.limit ?? DEFAULT_MAX_RESULTS;
    const results = (await Promise.all(this.#providers.map((provider) => provider.search(query)))).flat();
    const byScore = (a: MemoryHit, b: MemoryHit) => b.score - a.score || a.chunkId.localeCompare(b.chunkId);
    // Quota hits first: when a source's two copies carry the same text, the
    // repeat check keeps the first one it sees.
    return [
      ...results.filter(isQuotaHit).sort(byScore),
      ...results.filter((hit) => !isQuotaHit(hit)).sort(byScore).slice(0, limit),
    ];
  }
}

/**
 * The recall provider for a turn. With the sqlite-vec index present, it holds
 * memory files and transcripts; knowledge-base documents and configured local
 * documents aren't in it, so they are searched next to it (#106: live
 * indexing creates the index on the first turn, which had dropped them).
 * Without the index, memory files are searched locally too. Knowledge bases
 * have their own provider (#125 §5), which also ranks by meaning.
 */
export function selectMemoryRecallProvider(options: {
  sqlite?: MemoryRecallProvider;
  localDocuments?: MemoryDocument[];
  fileMemory: MemoryDocument[];
  knowledgebases?: MemoryRecallProvider;
}): MemoryRecallProvider | undefined {
  const local = createLocalMemoryRecallProvider([...(options.localDocuments ?? []), ...(options.sqlite ? [] : options.fileMemory)]);
  const providers = [options.sqlite, local, options.knowledgebases].filter((provider): provider is MemoryRecallProvider => Boolean(provider));
  if (providers.length <= 1) return providers[0];
  return new CombinedMemoryRecallProvider(providers);
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
  let selected: MemoryHit[] = [];
  let sections: string[] = [];
  let tokens = estimatePromptTokens("Relevant MindStone memory:\n");

  if (hits.some(isQuotaHit)) {
    // Quota hits (#125 §5) and memory share the budget: the best of each
    // always goes in (as the best hit always did), other quota hits up to half
    // the budget, then memory in order, then any quota hit left out, in what
    // memory didn't use. The prompt keeps the ranked order.
    const chosen = new Set<MemoryHit>();
    const cost = (hit: MemoryHit) => estimatePromptTokens(formatHit(hit, hits.length));
    const quota = hits.filter(isQuotaHit);
    const others = hits.filter((candidate) => !isQuotaHit(candidate));
    const take = (hit: MemoryHit) => {
      chosen.add(hit);
      tokens += cost(hit);
    };
    take(quota[0]!);
    // The best hit of memory's own, not a KB source found by words (#151 review).
    const bestMemory = others.find((hit) => hit.kind !== "kb") ?? others[0];
    if (bestMemory) take(bestMemory);
    const quotaBudget = tokens + Math.max(0, Math.floor((maxPromptTokens - tokens) / 2));
    for (const hit of quota.slice(1)) {
      if (tokens + cost(hit) <= quotaBudget) take(hit);
    }
    for (const hit of others.filter((candidate) => candidate !== bestMemory)) {
      if (tokens + cost(hit) > maxPromptTokens) break;
      take(hit);
    }
    for (const hit of quota) {
      if (!chosen.has(hit) && tokens + cost(hit) <= maxPromptTokens) take(hit);
    }
    selected = hits.filter((hit) => chosen.has(hit));
    sections = selected.map((hit, index) => formatHit(hit, index));
  } else {
    for (const hit of hits) {
      const next = formatHit(hit, selected.length);
      const nextTokens = estimatePromptTokens(next);
      if (selected.length > 0 && tokens + nextTokens > maxPromptTokens) break;
      selected.push(hit);
      sections.push(next);
      tokens += nextTokens;
    }
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
  const rawHits = await provider.search({
    text: query,
    limit: Math.max(limit * 3, limit),
    agentId: input.agentId,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.excludeOwnerTranscripts ? { excludeOwnerTranscripts: true } : {}),
  });
  const scopeRejected: Array<{ id: string; chunkId: string; reason: string }> = [];
  const scopedHits = rawHits.filter((hit) => {
    const documentScope = hit.metadata?.scope as Record<string, unknown> | undefined;
    if (scopeMatchesRecallFilter(documentScope, input.scope)) return true;
    scopeRejected.push({ id: hit.id, chunkId: hit.chunkId, reason: "scope_mismatch" });
    return false;
  });
  // An earlier chat that asked the same question carries no answer, and
  // repeats of it could crowd out the chunk that does (#106 review).
  const asked = normalizedQuestion(query);
  const repeatRejected: Array<{ id: string; chunkId: string; reason: string }> = [];
  // The same text said in several chats (a repeated reply) takes one slot:
  // hits arrive best first, so the first copy is kept.
  const seenTexts = new Set<string>();
  const freshHits = scopedHits.filter((hit) => {
    const text = normalizedQuestion(hit.text);
    // Text with no letters or digits left never counts as a repeat.
    if (!text) return true;
    if (text === asked) {
      repeatRejected.push({ id: hit.id, chunkId: hit.chunkId, reason: "duplicate-active-context" });
      return false;
    }
    if (seenTexts.has(text)) {
      repeatRejected.push({ id: hit.id, chunkId: hit.chunkId, reason: "duplicate_text" });
      return false;
    }
    seenTexts.add(text);
    return true;
  });
  // A quota hit met its own threshold (knowledgebases.recall.minSimilarity), on its own scale (#125 §5).
  const thresholdHits = freshHits.filter((hit) => hit.score >= minScore || isQuotaHit(hit));
  const ranked = rankMemoryHitsWithScri(thresholdHits, {
    activeEntries: input.entries,
    dedupAgainstActiveContext: input.config?.dedupAgainstActiveContext,
    maxActiveEntriesForDedup: input.config?.maxActiveEntriesForDedup,
  });
  const hits = selectRecallHits(ranked.hits, limit);
  if (hits.length === 0) {
    return {
      query,
      hits: [],
      promptTokens: 0,
      diagnostics: {
        rawHitCount: rawHits.length,
        rankedHitCount: ranked.hits.length,
        selectedHitCount: 0,
        rejected: [...scopeRejected, ...repeatRejected, ...ranked.rejected],
      },
    };
  }

  const prompt = buildMemoryRecallPrompt(hits, maxPromptTokens);
  // Usage instrumentation (#36): log every ranked candidate with its injected
  // flag. This is the AUTO path by definition (per-turn recall); logging is
  // NOT weighting and the logger is fail-open, so recall never breaks on it.
  logRecallUsage("auto", query, ranked.hits, new Set(prompt.hits.map((hit) => hit.chunkId)));
  return {
    query,
    hits: prompt.hits,
    promptText: prompt.text,
    promptTokens: prompt.tokens,
    diagnostics: {
      rawHitCount: rawHits.length,
      rankedHitCount: ranked.hits.length,
      selectedHitCount: prompt.hits.length,
      rejected: [...scopeRejected, ...repeatRejected, ...ranked.rejected],
    },
  };
}
