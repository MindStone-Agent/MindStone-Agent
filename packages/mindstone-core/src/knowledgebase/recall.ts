import type { MemoryEmbeddingProvider } from "../memory/embedding.js";
import { KB_RECALL_QUOTA, LocalMemoryRecallProvider } from "../memory/recall.js";
import type { MemoryHit, MemoryQuery, MemoryRecallProvider } from "../memory/types.js";
import { discoverKnowledgebaseRecall, type KnowledgebaseRecall, type KnowledgebaseRecallOptions } from "./load.js";
import { cosineSimilarity } from "./vectors.js";

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
  const settings = options.config?.knowledgebases?.recall;
  const maxResults = settings?.maxResults;
  const minSimilarity = settings?.minSimilarity;
  return new KnowledgebaseRecallProvider(recall, {
    embedder: options.embedder,
    maxResults: typeof maxResults === "number" && Number.isInteger(maxResults) && maxResults >= 0 && maxResults <= 20 ? maxResults : undefined,
    minSimilarity: typeof minSimilarity === "number" && Number.isFinite(minSimilarity) && minSimilarity >= -1 && minSimilarity <= 1 ? minSimilarity : undefined,
  });
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

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const semantic = await this.#semanticSearch(query.text);
    const taken = new Set(semantic.map((hit) => hit.id));
    const lexical = this.#lexical.search({ ...query, limit: (query.limit ?? 8) + taken.size }).filter((hit) => !taken.has(hit.id));
    return [...semantic, ...lexical.slice(0, query.limit ?? 8)];
  }

  async #semanticSearch(text: string): Promise<MemoryHit[]> {
    if (!this.#embedder || this.#maxResults <= 0 || this.#recall.vectors.size === 0) return [];
    let queryVector: number[] | undefined;
    try {
      [queryVector] = await this.#embedder.embedTexts([text]);
    } catch {
      return [];
    }
    if (!queryVector?.length) return [];
    const hits: MemoryHit[] = [];
    this.#recall.documents.forEach((document, ordinal) => {
      const vectors = this.#recall.vectors.get(document.id);
      // Vectors of another dimension than the query's came from another model: ignored.
      if (!vectors || vectors.dimension !== queryVector!.length) return;
      const scored = vectors.entries
        .map((entry) => ({ entry, similarity: cosineSimilarity(queryVector!, entry.vector) }))
        .sort((a, b) => b.similarity - a.similarity);
      const best = scored[0];
      if (!best || !(best.similarity >= this.#minSimilarity)) return;
      hits.push({
        ...document,
        // The sections closest to the question first.
        text: [...vectors.header, scored.map(({ entry }) => entry.line).join("\n"), ...vectors.footer].join("\n"),
        chunkId: `${document.id}#0`,
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
