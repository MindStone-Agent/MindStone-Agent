/**
 * Recall-usage log — the usage instrument for recall ranking parity (#36,
 * cross-substrate spec: mindstone-for-claude-code#63). One JSONL line per
 * ranked recall candidate so memory-vs-transcript pull and auto-vs-manual
 * behavior can be measured empirically. Logging is NOT weighting. Fail-open
 * by construction: a logging fault must never break recall, so the entry
 * point swallows all errors.
 *
 * Shared cross-substrate schema (per line):
 *   ts, path ("auto" | "manual"), query, source_type, source_path, chunk_id,
 *   similarity, rank, authority_factor, injected
 *
 * In this substrate `similarity` is the raw provider score, `rank` the final
 * post-ranking position, and `authority_factor` the composite SCRI re-rank
 * ratio (finalScore / providerScore) — the closest analogue of the reference
 * implementation's multiplicative factor in an additive-boost architecture
 * (null when the provider score is 0). This substrate has no manual
 * memory-search surface today; if one lands it MUST log path:"manual" with
 * authority_factor null and stay raw-ranked (manual/CLI recall is
 * deliberately unweighted — Clint's 2026-06-10 ruling).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimePathsFromEnv } from "../paths/runtime.js";
import type { ScriRankedHit } from "./scri-ranking.js";

const QUERY_CAP = 300;

export type RecallUsagePath = "auto" | "manual";

export function recallUsageLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(runtimePathsFromEnv(env).memoryDir, "recall-usage.jsonl");
}

export function logRecallUsage(
  pathKind: RecallUsagePath,
  query: string,
  hits: ScriRankedHit[],
  injectedChunkIds: ReadonlySet<string>,
): void {
  try {
    if (hits.length === 0) return;
    const ts = new Date().toISOString();
    const q = (query ?? "").slice(0, QUERY_CAP);
    const lines = hits.map((hit, index) => {
      const providerScore = typeof hit.metadata?.providerScore === "number" ? hit.metadata.providerScore : undefined;
      const authorityFactor =
        pathKind === "auto" && typeof providerScore === "number" && providerScore > 0
          ? hit.score / providerScore
          : null;
      return JSON.stringify({
        ts,
        path: pathKind,
        query: q,
        source_type: hit.kind,
        source_path: (typeof hit.metadata?.relativePath === "string" ? hit.metadata.relativePath : undefined) ?? hit.path ?? hit.id,
        chunk_id: hit.chunkId,
        similarity: providerScore ?? hit.score,
        rank: index + 1,
        authority_factor: authorityFactor,
        injected: injectedChunkIds.has(hit.chunkId),
      });
    });
    const logPath = recallUsageLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${lines.join("\n")}\n`);
  } catch {
    // Fail-open: usage logging must never break recall.
  }
}
