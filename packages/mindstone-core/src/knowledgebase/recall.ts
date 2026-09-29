import type { MindStoneConfig } from "../config/types.js";
import type { MemoryEmbeddingProvider } from "../memory/embedding.js";
import { KB_RECALL_QUOTA, LocalMemoryRecallProvider } from "../memory/recall.js";
import type { MemoryHit, MemoryQuery, MemoryRecallProvider } from "../memory/types.js";
import { discoverKnowledgebaseRecall, type KnowledgebaseRecall, type KnowledgebaseRecallOptions } from "./load.js";
import { cosineSimilarity } from "./vectors.js";

/** Sections a KB source found by meaning shows in the prompt. */
export const KB_MEANING_SECTIONS = 5;

export const KB_RECALL_DEFAULTS = {
  /** Slots a turn keeps for KB sources ranked by meaning. */
  maxResults: 3,
  /** Least cosine similarity between the query and a KB entry for its source to be recalled. */
  minSimilarity: 0.5,
};

/**
 * The turn's KB recall provider (#125 §5), or none when no KB takes part.
 * `embedder` is the turn's shared one, so the query is embedded once for
 * memory and KB recall together.
 */
export function createKnowledgebaseRecallProvider(
  options: Omit<KnowledgebaseRecallOptions, "embedder"> & { embedder?: MemoryEmbeddingProvider },
): MemoryRecallProvider | undefined {
  const recall = discoverKnowledgebaseRecall(options);
  if (recall.documents.length === 0) return undefined;
  return new KnowledgebaseRecallProvider(recall, { embedder: options.embedder, ...knowledgebaseRecallSettings(options.config) });
}

/** `knowledgebases.recall` from the config; a value out of range is left to the default. */
export function knowledgebaseRecallSettings(config: MindStoneConfig | undefined): { maxResults?: number; minSimilarity?: number } {
  const settings = config?.knowledgebases?.recall;
  const maxResults = settings?.maxResults;
  const minSimilarity = settings?.minSimilarity;
  return {
    maxResults: typeof maxResults === "number" && Number.isInteger(maxResults) && maxResults >= 0 && maxResults <= 20 ? maxResults : undefined,
    minSimilarity: typeof minSimilarity === "number" && Number.isFinite(minSimilarity) && minSimilarity >= -1 && minSimilarity <= 1 ? minSimilarity : undefined,
  };
}

/**
 * KB recall documents searched two ways. Every document is scored by word
 * match, as before. A document whose KB has vectors from the install's
 * embedder is also ranked by meaning: the query is embedded (once per turn,
 * through the shared embedder), each entry scored by cosine, and the best
 * `maxResults` sources at or above `minSimilarity` returned as quota hits.
 * If the embedder fails, only the word-match hits are returned.
 */
export class KnowledgebaseRecallProvider implements MemoryRecallProvider {
  readonly id = "knowledgebase";
  readonly #recall: KnowledgebaseRecall;
  readonly #lexical: LocalMemoryRecallProvider;
  readonly #embedder?: MemoryEmbeddingProvider;
  readonly #maxResults: number;
  readonly #minSimilarity: number;

  constructor(recall: KnowledgebaseRecall, options: { embedder?: MemoryEmbeddingProvider; maxResults?: number; minSimilarity?: number } = {}) {
    this.#recall = recall;
    this.#lexical = new LocalMemoryRecallProvider(recall.documents);
    this.#embedder = options.embedder;
    this.#maxResults = options.maxResults ?? KB_RECALL_DEFAULTS.maxResults;
    this.#minSimilarity = options.minSimilarity ?? KB_RECALL_DEFAULTS.minSimilarity;
  }

  /**
   * A source can come back twice, by meaning and by words (its own chunk ids):
   * the turn's selection keeps the meaning copy when it takes a slot, and the
   * word-match copy otherwise, so an exact term is never lost to a weak
   * meaning score (#125 §5 review).
   */
  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const semantic = await this.#semanticSearch(query.text);
    // Word-match hits say so, as memory's do (#140, #151).
    const lexical = this.#lexical.search(query).map((hit) => ({ ...hit, metadata: { ...(hit.metadata ?? {}), recallMode: "lexical" } }));
    return [...semantic, ...lexical];
  }

  async #semanticSearch(text: string): Promise<MemoryHit[]> {
    if (!this.#embedder || this.#maxResults <= 0) return [];
    const allVectors = this.#recall.vectors();
    if (allVectors.size === 0) return [];
    let queryVector: number[] | undefined;
    try {
      [queryVector] = await this.#embedder.embedTexts([text]);
    } catch {
      return [];
    }
    // An all-zero question vector matches nothing (cosine 0), however low minSimilarity is set.
    if (!queryVector?.length || queryVector.every((value) => value === 0)) return [];
    const hits: MemoryHit[] = [];
    this.#recall.documents.forEach((document, ordinal) => {
      const vectors = allVectors.get(document.id);
      // Vectors of another dimension than the query's came from another model: ignored.
      if (!vectors || vectors.dimension !== queryVector!.length) return;
      const scored = vectors.entries
        .map((entry) => ({ entry, similarity: cosineSimilarity(queryVector!, entry.vector) }))
        .sort((a, b) => b.similarity - a.similarity);
      const best = scored[0];
      if (!best || !(best.similarity >= this.#minSimilarity)) return;
      // The sections closest to the question first, at most KB_MEANING_SECTIONS
      // of them, so one long source can't use up the prompt's recall budget.
      const shown = scored.slice(0, KB_MEANING_SECTIONS).map(({ entry }) => entry.line);
      const more = scored.length - shown.length;
      hits.push({
        ...document,
        text: [...vectors.header, [...shown, ...(more > 0 ? [`- …and ${more} more section(s) of this source`] : [])].join("\n"), ...vectors.footer].join("\n"),
        chunkId: `${document.id}#meaning`,
        sourceId: document.id,
        ordinal,
        score: best.similarity,
        metadata: {
          ...(document.metadata ?? {}),
          recallMode: "embedding",
          recallQuota: KB_RECALL_QUOTA,
          bestCitation: best.entry.citation,
        },
      });
    });
    return hits
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, this.#maxResults);
  }
}
