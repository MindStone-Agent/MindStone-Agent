import type { TranscriptEntry } from "../transcript/index.js";
import type { MemoryHit, MemoryKind } from "./types.js";

export type ScriScoreBreakdown = {
  providerScore: number;
  kindBoost: number;
  sourceBoost: number;
  criticalBoost: number;
  evergreenBoost: number;
  usageBoost: number;
  recencyBoost: number;
  finalScore: number;
  reasons: string[];
};

export type ScriRankedHit = MemoryHit & {
  metadata?: Record<string, unknown> & {
    providerScore?: number;
    scri?: ScriScoreBreakdown;
  };
};

export type ScriRecallRankingOptions = {
  activeEntries?: TranscriptEntry[];
  dedupAgainstActiveContext?: boolean;
  maxActiveEntriesForDedup?: number;
};

export type ScriRecallRankingResult = {
  hits: ScriRankedHit[];
  rejected: Array<{ id: string; chunkId: string; reason: string }>;
};

const KIND_BOOST: Record<MemoryKind, number> = {
  identity: 0.06,
  custom: 0.06,
  doc: 0.05,
  kb: 0.04,
  wiki: 0.04,
  journal: 0.04,
  checkpoint: 0.035,
  log: 0.025,
  transcript: 0.015,
  index: 0.01,
};

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function textSignature(text: string): string {
  return normalizeText(text).slice(0, 600);
}

function activeContextSignatures(entries: TranscriptEntry[], maxEntries: number): string[] {
  return entries
    .filter((entry) => entry.role === "system" || entry.role === "user" || entry.role === "assistant" || entry.role === "tool")
    .slice(-maxEntries)
    .map((entry) => entry.text ?? (entry.content === undefined ? "" : JSON.stringify(entry.content)))
    .map(textSignature)
    .filter((text) => text.length >= 80);
}

function isDuplicateOfActiveContext(hit: MemoryHit, activeSignatures: string[]): boolean {
  const signature = textSignature(hit.text);
  if (signature.length < 80) return false;
  return activeSignatures.some((active) => active.includes(signature) || signature.includes(active));
}

function sourceBoost(hit: MemoryHit): { boost: number; reason?: string } {
  const relativePath = stringValue(hit.metadata?.relativePath) ?? stringValue(hit.path) ?? hit.id;
  if (/memory\/(project|design|reference|detection|incident|case|feedback)_/i.test(relativePath)) {
    return { boost: 0.055, reason: "structured-memory-source" };
  }
  if (/journals?\//i.test(relativePath)) return { boost: 0.025, reason: "journal-source" };
  if (/LOG\.md$/i.test(relativePath) || hit.kind === "log") return { boost: 0.015, reason: "log-source" };
  if (hit.kind === "transcript") return { boost: 0.005, reason: "transcript-source" };
  return { boost: 0, reason: undefined };
}

function recencyBoost(hit: MemoryHit, now = Date.now()): { boost: number; reason?: string } {
  const timestamp = stringValue(hit.timestamp) ?? stringValue(hit.metadata?.last_applied) ?? stringValue(hit.metadata?.created);
  if (!timestamp || timestamp === "null") return { boost: 0, reason: undefined };
  const dateMs = Date.parse(timestamp);
  if (!Number.isFinite(dateMs)) return { boost: 0, reason: undefined };
  const ageDays = Math.max(0, (now - dateMs) / 86_400_000);
  const halfLifeDays = Math.max(1, numberValue(hit.metadata?.half_life_days) ?? 30);
  const decay = Math.pow(0.5, ageDays / halfLifeDays);
  return { boost: 0.04 * decay, reason: "recency" };
}

function usageBoost(hit: MemoryHit): { boost: number; reason?: string } {
  const hits = Math.max(0, numberValue(hit.metadata?.hits) ?? 0);
  const prevented = Math.max(0, numberValue(hit.metadata?.prevented) ?? 0);
  if (hits === 0 && prevented === 0) return { boost: 0, reason: undefined };
  const boost = Math.min(0.06, Math.log1p(hits + prevented * 2) * 0.015);
  return { boost, reason: "proven-usefulness" };
}

export function rankMemoryHitsWithScri(
  hits: MemoryHit[],
  options: ScriRecallRankingOptions = {},
): ScriRecallRankingResult {
  const rejected: ScriRecallRankingResult["rejected"] = [];
  const activeSignatures = options.dedupAgainstActiveContext === false
    ? []
    : activeContextSignatures(options.activeEntries ?? [], options.maxActiveEntriesForDedup ?? 32);

  const seenChunkIds = new Set<string>();
  const seenTextSignatures = new Set<string>();
  const ranked = hits
    .filter((hit) => {
      if (isDuplicateOfActiveContext(hit, activeSignatures)) {
        rejected.push({ id: hit.id, chunkId: hit.chunkId, reason: "duplicate-active-context" });
        return false;
      }
      const textSig = textSignature(hit.text);
      if (seenChunkIds.has(hit.chunkId) || (textSig.length >= 80 && seenTextSignatures.has(textSig))) {
        rejected.push({ id: hit.id, chunkId: hit.chunkId, reason: "duplicate-candidate" });
        return false;
      }
      seenChunkIds.add(hit.chunkId);
      if (textSig.length >= 80) seenTextSignatures.add(textSig);
      return true;
    })
    .map((hit): ScriRankedHit => {
      const providerScore = clamp01(hit.score);
      const reasons: string[] = [];
      const kindBoost = KIND_BOOST[hit.kind] ?? 0;
      if (kindBoost > 0) reasons.push(`kind:${hit.kind}`);

      const source = sourceBoost(hit);
      if (source.reason) reasons.push(source.reason);

      const criticalBoost = booleanValue(hit.metadata?.critical) ? 0.08 : 0;
      if (criticalBoost) reasons.push("critical");

      const evergreenBoost = booleanValue(hit.metadata?.evergreen) ? 0.035 : 0;
      if (evergreenBoost) reasons.push("evergreen");

      const usage = usageBoost(hit);
      if (usage.reason) reasons.push(usage.reason);

      const recency = recencyBoost(hit);
      if (recency.reason && recency.boost > 0) reasons.push(recency.reason);

      const finalScore = clamp01((providerScore * 0.78) + kindBoost + source.boost + criticalBoost + evergreenBoost + usage.boost + recency.boost);
      const scri: ScriScoreBreakdown = {
        providerScore,
        kindBoost,
        sourceBoost: source.boost,
        criticalBoost,
        evergreenBoost,
        usageBoost: usage.boost,
        recencyBoost: recency.boost,
        finalScore,
        reasons,
      };
      return {
        ...hit,
        score: finalScore,
        metadata: {
          ...(hit.metadata ?? {}),
          providerScore,
          scri,
        },
      };
    })
    .sort((a, b) => b.score - a.score || (b.metadata?.scri?.providerScore ?? 0) - (a.metadata?.scri?.providerScore ?? 0) || a.chunkId.localeCompare(b.chunkId));

  return { hits: ranked, rejected };
}
