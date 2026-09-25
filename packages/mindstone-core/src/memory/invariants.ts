import { estimatePromptTokens } from "../context/index.js";
import type { MemoryDocument } from "./types.js";

/**
 * The invariant tier.
 *
 * Recall is query-conditional: a document reaches the prompt only when it scores
 * near whatever the user just typed. That is the correct contract for reference
 * material and the wrong one for a rule that must bind precisely when nobody is
 * thinking about it. `critical: true` alone only buys a similarity boost, so a
 * binding rule competes for a slot and usually loses.
 *
 * This tier removes the competition. Selection takes no query, applies no
 * similarity threshold and honours no result cap: a memory that declares an
 * `invariant` and is marked critical is injected on every turn, full stop.
 *
 * The `invariant` field is AUTHORED, not extracted. A summariser can only
 * restate what a memory says; it cannot state the rule the memory exists to
 * enforce, because that rule is usually the residue of an incident and is
 * invisible in the prose. Authoring is also measurably better as a retrieval
 * probe, which was not the reason for doing it.
 */

export type InvariantRule = {
  /** Document id, used for diagnostics and dedup. */
  id: string;
  /** Short human label. Preserved even when the rule text is dropped. */
  name: string;
  /** The authored rule. */
  text: string;
  path?: string;
};

export type InvariantAdmission = "full" | "degraded" | "omitted";

export type InvariantPromptResult = {
  promptText?: string;
  tokens: number;
  /** Rules injected with their full authored text. */
  full: number;
  /** Rules injected as a name only, because the full text did not fit. */
  degraded: number;
  /** Rules that did not fit even as a name. */
  omitted: number;
  /** Every candidate considered. Equals full + degraded + omitted. */
  total: number;
  admissions: Array<{ id: string; name: string; admission: InvariantAdmission }>;
};

export type InvariantPromptOptions = {
  /** Hard ceiling for the block. Defaults to the model-derived budget below. */
  maxPromptTokens?: number;
};

const HEADER = [
  "The following rules are always in force. They are not suggestions, not context,",
  "and not ranked by relevance to this turn — they were selected without reference",
  "to what was asked. Apply them whether or not they appear related.",
].join(" ");

/** Absolute cap, and the share of a model window the tier may claim. */
const MAX_BUDGET_TOKENS = 8_000;
const BUDGET_FRACTION = 0.12;
const MIN_BUDGET_TOKENS = 256;

/**
 * The tier is constitutional, so it gets a real budget rather than the leftovers
 * of the recall allowance. It is still bounded: a small-context model must not
 * have its entire window consumed by rules, which is why this scales with the
 * window instead of being a flat constant.
 */
export function defaultInvariantBudgetTokens(contextWindowTokens: number | undefined): number {
  if (!Number.isFinite(contextWindowTokens) || (contextWindowTokens ?? 0) <= 0) return MAX_BUDGET_TOKENS;
  const share = Math.floor((contextWindowTokens as number) * BUDGET_FRACTION);
  return Math.max(MIN_BUDGET_TOKENS, Math.min(MAX_BUDGET_TOKENS, share));
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function labelFor(document: MemoryDocument): string {
  return text(document.metadata?.name) ?? text(document.title) ?? document.path ?? document.id;
}

/**
 * Candidates are `critical: true` AND carry a non-empty `invariant`.
 *
 * Both halves are load-bearing. Critical without an invariant is a memory whose
 * rule has not been written down yet and there is nothing to inject; an
 * invariant without critical is an authored rule the operator chose not to make
 * binding. Neither is an error, so neither warns.
 */
export function selectInvariantRules(documents: MemoryDocument[]): InvariantRule[] {
  const rules: InvariantRule[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    if (!truthy(document.metadata?.critical)) continue;
    const invariant = text(document.metadata?.invariant);
    if (!invariant) continue;
    if (seen.has(document.id)) continue;
    seen.add(document.id);
    rules.push({ id: document.id, name: labelFor(document), text: invariant, path: document.path });
  }
  return rules;
}

function fullLine(rule: InvariantRule): string {
  return `- **${rule.name}** — ${rule.text}`;
}

function degradedLine(rule: InvariantRule): string {
  return `- **${rule.name}** — (rule text dropped to fit the budget; recall this memory by name before relying on its absence)`;
}

/**
 * Build the block.
 *
 * Overflow is handled PER ITEM and never aborts. The recall path stops at the
 * first entry that does not fit, so one oversized entry silently truncates
 * every entry behind it; for a constitution that means a single long rule can
 * cost you all the rest. Here an entry that does not fit is degraded to its
 * name, and only an entry whose name does not fit is dropped. Degrade the
 * description, never the existence: a name alone still gives the agent
 * something to search for, whereas a dropped entry recreates the invisibility
 * this tier exists to remove.
 *
 * Any loss is reported IN BAND, in the prompt itself, because a diagnostic the
 * model cannot see does not change the model's behaviour.
 */
export function buildInvariantPrompt(
  rules: InvariantRule[],
  options: InvariantPromptOptions = {},
): InvariantPromptResult {
  const empty: InvariantPromptResult = { tokens: 0, full: 0, degraded: 0, omitted: 0, total: rules.length, admissions: [] };
  if (rules.length === 0) return empty;

  const budget = Math.max(0, Math.floor(options.maxPromptTokens ?? MAX_BUDGET_TOKENS));
  const admissions: InvariantPromptResult["admissions"] = [];
  const lines: string[] = [];
  let tokens = estimatePromptTokens(HEADER);
  // Hold back room for the notice so reporting the loss can never itself be the
  // thing that gets lost.
  const noticeReserve = estimatePromptTokens(
    "NOTE: 999 of 999 always-in-force rules were shortened and 999 could not be included at all in this turn's budget. Treat this list as incomplete and search memory before concluding that no rule applies.",
  );

  let full = 0;
  let degraded = 0;
  let omitted = 0;

  for (const rule of rules) {
    const candidate = fullLine(rule);
    const candidateTokens = estimatePromptTokens(candidate);
    if (tokens + candidateTokens + noticeReserve <= budget) {
      lines.push(candidate);
      tokens += candidateTokens;
      full += 1;
      admissions.push({ id: rule.id, name: rule.name, admission: "full" });
      continue;
    }

    const fallback = degradedLine(rule);
    const fallbackTokens = estimatePromptTokens(fallback);
    if (tokens + fallbackTokens + noticeReserve <= budget) {
      lines.push(fallback);
      tokens += fallbackTokens;
      degraded += 1;
      admissions.push({ id: rule.id, name: rule.name, admission: "degraded" });
      continue;
    }

    // No `break`. A later rule may be short enough to fit where this one was not.
    omitted += 1;
    admissions.push({ id: rule.id, name: rule.name, admission: "omitted" });
  }

  if (lines.length === 0) {
    return { ...empty, omitted, admissions };
  }

  const sections = [HEADER, "", ...lines];
  if (degraded > 0 || omitted > 0) {
    const parts: string[] = [];
    if (degraded > 0) parts.push(`${degraded} of ${rules.length} always-in-force rules were shortened to their names`);
    if (omitted > 0) parts.push(`${omitted} could not be included at all`);
    sections.push(
      "",
      `NOTE: ${parts.join(" and ")} in this turn's budget. Treat this list as incomplete and search memory before concluding that no rule applies.`,
    );
  }

  const promptText = sections.join("\n");
  return { promptText, tokens: estimatePromptTokens(promptText), full, degraded, omitted, total: rules.length, admissions };
}

/** Convenience: select and build in one call. */
export function buildInvariantPromptFromDocuments(
  documents: MemoryDocument[],
  options: InvariantPromptOptions = {},
): InvariantPromptResult {
  return buildInvariantPrompt(selectInvariantRules(documents), options);
}
