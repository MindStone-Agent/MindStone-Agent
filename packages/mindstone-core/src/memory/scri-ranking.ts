import type { TranscriptEntry } from "../transcript/index.js";
import type { MemoryHit, MemoryKind } from "./types.js";

export type ScriScoreBreakdown = {
  providerScore: number;
  kindBoost: number;
  sourceBoost: number;
  criticalBoost: number;
  evergreenBoost: number;
  /** Dampened hits-odometer contribution (log1p, capped low). */
  usageBoost: number;
  /** Human-confirmed mistake-prevention authority contribution (bounded saturation). */
  preventedBoost: number;
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

// Usage/authority tunables (recall ranking parity — #36, spec: ms4cc#63).
// `hits` is an age-odometer: it accumulates with a memory's PRESENCE over time,
// not its usefulness, so it enters dampened (log1p) and capped LOW. `prevented`
// is the human-confirmed "this memory stopped a real mistake" signal: weighted
// OUTSIDE the log (3:1, matching the reference impl) through a bounded
// saturation, so an old memory's odometer can never numerically swamp it and a
// runaway value can never dominate the score. Behavioral anchor from the
// reference battery: prevented=3 outranks hits=2400 at equal similarity
// (3*3=9 > log1p(2400)=7.78 there; 0.030 > 0.020-cap here), while prevented=1
// still loses to that odometer in both implementations.
const HITS_BOOST_SCALE = 0.004;
const HITS_BOOST_CAP = 0.02;
const PREVENTED_WEIGHT = 3;
const PREVENTED_SAT_K = 12;
const PREVENTED_BOOST_CAP = 0.07;

function usageBoost(hit: MemoryHit): { hitsBoost: number; preventedBoost: number; reasons: string[] } {
  const hits = Math.max(0, numberValue(hit.metadata?.hits) ?? 0);
  const prevented = Math.max(0, numberValue(hit.metadata?.prevented) ?? 0);
  const reasons: string[] = [];
  const hitsBoost = hits > 0 ? Math.min(HITS_BOOST_CAP, Math.log1p(hits) * HITS_BOOST_SCALE) : 0;
  if (hitsBoost > 0) reasons.push("usage");
  const preventedRaw = PREVENTED_WEIGHT * prevented;
  const preventedBoost = prevented > 0 ? PREVENTED_BOOST_CAP * (preventedRaw / (preventedRaw + PREVENTED_SAT_K)) : 0;
  if (preventedBoost > 0) reasons.push("prevented-authority");
  return { hitsBoost, preventedBoost, reasons };
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
      reasons.push(...usage.reasons);

      const recency = recencyBoost(hit);
      if (recency.reason && recency.boost > 0) reasons.push(recency.reason);

      const finalScore = clamp01((providerScore * 0.78) + kindBoost + source.boost + criticalBoost + evergreenBoost + usage.hitsBoost + usage.preventedBoost + recency.boost);
      const scri: ScriScoreBreakdown = {
        providerScore,
        kindBoost,
        sourceBoost: source.boost,
        criticalBoost,
        evergreenBoost,
        usageBoost: usage.hitsBoost,
        preventedBoost: usage.preventedBoost,
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
