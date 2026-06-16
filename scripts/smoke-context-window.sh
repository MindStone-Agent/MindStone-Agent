#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

echo "== Context window smoke test =="

npm run build:mindstone

npx tsx <<'TS'
import assert from "node:assert/strict";
import { buildPromptWindow, type TranscriptEntry } from "./packages/mindstone-core/src/index.ts";

function entry(index: number, role: TranscriptEntry["role"], text: string): TranscriptEntry {
  return {
    id: `e${index}`,
    timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    sessionKey: "agent:default:test:direct:context-window",
    agentId: "default",
    role,
    text,
  };
}

const largeText = "x".repeat(1200);
const entries: TranscriptEntry[] = [
  entry(0, "system", "system prompt must stay"),
  ...Array.from({ length: 30 }, (_, index) => entry(index + 1, index % 2 === 0 ? "user" : "assistant", `${index}:${largeText}`)),
  entry(31, "event", "transcript event is preserved but not sent to prompt"),
];

const under = buildPromptWindow({
  entries,
  contextWindowTokens: 100_000,
  policy: { mode: "sliding_window", ceilingPercent: 92, floorPercent: 70, minRecentMessages: 6, preserveTranscript: true },
});
assert.equal(under.pruned, false);
assert.equal(under.entries.length, entries.length);
assert.equal(under.promptEntries.some((item) => item.role === "event"), false);

const pruned = buildPromptWindow({
  entries,
  contextWindowTokens: 5_000,
  policy: { mode: "sliding_window", ceilingPercent: 60, floorPercent: 35, minRecentMessages: 6, preserveTranscript: true },
});
assert.equal(pruned.pruned, true);
assert.equal(pruned.entries.length, entries.length, "full transcript input must remain represented");
assert.ok(pruned.prunedEntries.length > 0, "old prompt entries should be pruned from prompt window");
assert.ok(pruned.tokensAfter < pruned.tokensBefore, "token estimate should decrease after pruning");
assert.ok(pruned.promptEntries.some((item) => item.id === "e0"), "system entry must stay");
for (const id of ["e25", "e26", "e27", "e28", "e29", "e30"]) {
  assert.ok(pruned.promptEntries.some((item) => item.id === id), `${id} should be retained by minRecentMessages`);
}
assert.equal(pruned.promptEntries.some((item) => item.id === "e31"), false, "events are transcript-only by default");
assert.equal(pruned.pruneEvent?.event, "context_window_pruned");
assert.equal(pruned.pruneEvent?.prunedEntries, pruned.prunedEntries.length);

const protectedRun = buildPromptWindow({
  entries,
  contextWindowTokens: 5_000,
  protectedEntryIds: ["e3"],
  policy: { mode: "sliding_window", ceilingPercent: 60, floorPercent: 35, minRecentMessages: 6, preserveTranscript: true },
});
assert.ok(protectedRun.promptEntries.some((item) => item.id === "e3"), "explicitly protected entry should stay");

const autoCompact = buildPromptWindow({
  entries,
  contextWindowTokens: 5_000,
  policy: { mode: "auto_compact", checkpointWarningPercent: 85, compactTargetPercent: 92, keepRecentTokens: 20_000 },
});
assert.equal(autoCompact.pruned, false);
assert.equal(autoCompact.promptEntries.length, entries.filter((item) => item.role !== "event").length);

console.log(JSON.stringify({
  underCeilingPruned: under.pruned,
  prunedEntries: pruned.prunedEntries.length,
  tokensBefore: pruned.tokensBefore,
  tokensAfter: pruned.tokensAfter,
  utilizationBeforePercent: pruned.utilizationBeforePercent,
  utilizationAfterPercent: pruned.utilizationAfterPercent,
}, null, 2));
TS

echo "Context window smoke test passed."
