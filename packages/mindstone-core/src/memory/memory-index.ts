import { estimatePromptTokens } from "../context/index.js";
import type { MemoryDocument } from "./types.js";

/**
 * The memory index tier.
 *
 * The index is the agent's map of what it knows: one line per memory, each a
 * pointer plus a short hook. It is the thing you consult to discover that a
 * memory exists at all, which makes it exactly the wrong document to gate on
 * similarity to the current turn. An agent that cannot see its index does not
 * know what it does not know, and confidently reports absence.
 *
 * Worse, the index fails as a UNIT. It is one document, so it either wins a
 * recall slot whole or loses whole, and a mature index outgrows any per-hit
 * budget long before it stops being useful. Past that point it is not merely
 * unlikely to be recalled, it is structurally unadmittable: no query can
 * retrieve it, because it cannot fit whatever slot it wins.
 *
 * So this tier injects it with no query, and degrades it a LINE at a time. A
 * line that does not fit loses its hook and keeps its pointer, because a
 * pointer alone still tells the agent the memory exists and can be searched
 * for, whereas a dropped line recreates the invisibility this tier exists to
 * remove.
 */

export type MemoryIndexPromptResult = {
  promptText?: string;
  tokens: number;
  /** Entries injected with their hook intact. */
  full: number;
  /** Entries reduced to their pointer because the hook did not fit. */
  degraded: number;
  /** Entries that did not fit even as a pointer. */
  omitted: number;
  /** Every index entry considered. */
  total: number;
};

export type MemoryIndexPromptOptions = {
  maxPromptTokens?: number;
};

const HEADER = [
  "Index of the agent's durable memories. This is a map, not content: each line names a",
  "memory that exists and can be read or searched in full. Absence from this list is the",
  "only evidence that a memory does not exist; presence with no detail means the entry was",
  "shortened, not that the memory is empty.",
].join(" ");

const MAX_BUDGET_TOKENS = 6_000;
const BUDGET_FRACTION = 0.08;
const MIN_BUDGET_TOKENS = 256;

export function defaultMemoryIndexBudgetTokens(contextWindowTokens: number | undefined): number {
  if (!Number.isFinite(contextWindowTokens) || (contextWindowTokens ?? 0) <= 0) return MAX_BUDGET_TOKENS;
  const share = Math.floor((contextWindowTokens as number) * BUDGET_FRACTION);
  return Math.max(MIN_BUDGET_TOKENS, Math.min(MAX_BUDGET_TOKENS, share));
}

export function selectMemoryIndexDocument(documents: MemoryDocument[]): MemoryDocument | undefined {
  return documents.find((document) => document.kind === "index" && document.text.trim());
}

/**
 * Strip the hook from an index line, keeping the pointer.
 *
 * Entries are conventionally `- [Title](file.md) — hook`. Both dash forms are
 * accepted because the separator is a writing convention, not a schema, and a
 * line that does not match either is kept whole rather than mangled.
 */
function pointerOnly(line: string): string {
  const separator = / [—-] /.exec(line);
  if (!separator || separator.index <= 0) return line;
  return line.slice(0, separator.index).trimEnd();
}

/** Headings, blank lines and prose carry no pointer, so they are structure. */
function isEntry(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function assemble(header: string, kept: string[], degraded: number, omitted: number): string {
  const sections = [header, "", ...kept];
  if (degraded > 0 || omitted > 0) {
    const parts: string[] = [];
    if (degraded > 0) parts.push(`${degraded} index entries were shortened to their pointers`);
    if (omitted > 0) parts.push(`${omitted} were left out of this turn's budget`);
    sections.push(
      "",
      `NOTE: ${parts.join(" and ")}. Search memory directly rather than treating this list as complete.`,
    );
  }
  return sections.join("\n");
}

function totalCost(header: string, lines: string[]): number {
  return lines.reduce((sum, line) => sum + estimatePromptTokens(line), estimatePromptTokens(header));
}

/**
 * Admission is whole-list first, greedy only as a last resort.
 *
 * The obvious implementation walks the list once and degrades each entry as the
 * budget runs out. It is wrong here, and measurably so: on a 60-entry index at a
 * tight budget it admitted 9 entries in full, degraded 1, and dropped 50. That
 * spends the whole allowance on detail for the first sixth of the list and
 * loses the existence of the rest, which is the opposite of what an index is
 * for. A map's value is coverage; the hook is a convenience.
 *
 * So: try the whole list in full, then the whole list as pointers, and only
 * then fall back to admitting pointers until the budget runs out. The middle
 * pass is the one that matters, and it is the one a single greedy loop cannot
 * express, because by the time it discovers the list is too long it has already
 * spent the budget.
 */
export function buildMemoryIndexPrompt(
  document: MemoryDocument | undefined,
  options: MemoryIndexPromptOptions = {},
): MemoryIndexPromptResult {
  const empty: MemoryIndexPromptResult = { tokens: 0, full: 0, degraded: 0, omitted: 0, total: 0 };
  const body = document?.text?.trim();
  if (!body) return empty;

  const budget = Math.max(0, Math.floor(options.maxPromptTokens ?? MAX_BUDGET_TOKENS));
  const lines = body.split("\n");
  const total = lines.filter(isEntry).length;
  if (total === 0) return empty;

  // Reserved so that reporting the loss can never be the thing that is lost.
  const noticeReserve = estimatePromptTokens(
    "NOTE: 9999 index entries were shortened to their pointers and 9999 were left out of this turn's budget. Search memory directly rather than treating this list as complete.",
  );

  // Pass 1 — everything, hooks intact. No notice, so no reserve.
  if (totalCost(HEADER, lines) <= budget) {
    const promptText = assemble(HEADER, lines, 0, 0);
    return { promptText, tokens: estimatePromptTokens(promptText), full: total, degraded: 0, omitted: 0, total };
  }

  // Pass 2 — everything, pointers only. Coverage preserved, detail spent.
  const pointers = lines.map((line) => (isEntry(line) ? pointerOnly(line) : line));
  const shortened = lines.filter((line, index) => isEntry(line) && pointers[index] !== line).length;
  if (totalCost(HEADER, pointers) + noticeReserve <= budget) {
    const promptText = assemble(HEADER, pointers, shortened, 0);
    return {
      promptText,
      tokens: estimatePromptTokens(promptText),
      full: total - shortened,
      degraded: shortened,
      omitted: 0,
      total,
    };
  }

  // Pass 3 — not even the pointers fit. Admit what does, per item, and say so.
  // Structural lines are dropped here: a heading costs an entry its existence.
  const kept: string[] = [];
  let tokens = estimatePromptTokens(HEADER);
  let full = 0;
  let degraded = 0;
  let omitted = 0;

  for (const [index, line] of lines.entries()) {
    if (!isEntry(line)) continue;
    const candidate = pointers[index];
    const cost = estimatePromptTokens(candidate);
    if (tokens + cost + noticeReserve > budget) {
      // No `break`. Entries vary in length, so a later one may still fit.
      omitted += 1;
      continue;
    }
    kept.push(candidate);
    tokens += cost;
    if (candidate === line) full += 1;
    else degraded += 1;
  }

  if (kept.length === 0) return { ...empty, total, omitted };

  const promptText = assemble(HEADER, kept, degraded, omitted);
  return { promptText, tokens: estimatePromptTokens(promptText), full, degraded, omitted, total };
}

export function buildMemoryIndexPromptFromDocuments(
  documents: MemoryDocument[],
  options: MemoryIndexPromptOptions = {},
): MemoryIndexPromptResult {
  return buildMemoryIndexPrompt(selectMemoryIndexDocument(documents), options);
}
