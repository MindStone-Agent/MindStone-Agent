#!/usr/bin/env bash
set -euo pipefail

# Always-in-force ("invariant") memory tier.
#
# This script is written to FAIL, not to pass. Part C re-runs every assertion
# against deliberately broken inputs and fails the run if any of them still
# reports success. That step exists because the neighbouring file-memory smoke
# test asserts only that a hit with a given id came back — an id derived from
# the file path, never from parsed frontmatter — so blanking every parsed value
# leaves it reporting "29 pass, 0 fail". A check that cannot fail is not a gate,
# and it certified a broken parser green for as long as it existed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-invariants-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 9))"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"

cd "${PROJECT_ROOT}"

echo "== Always-in-force memory tier smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

MEMORY_DIR="${MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/memory"

# A binding rule. Deliberately about a subject the test query never mentions:
# the whole contract of this tier is that a rule binds when nobody is thinking
# about it, so a query-adjacent fixture would prove nothing recall does not.
cat >"${MEMORY_DIR}/reference_deploy_freeze.md" <<'MD'
---
name: reference_deploy_freeze
description: Release windows for the shared cluster.
type: reference
critical: true
invariant: >-
  Never deploy to the shared cluster on a Friday. Roll forward on Monday
  instead, and say so in the release channel before you do.
metadata:
  critical: false
---

# Release windows

The shared cluster has no out-of-hours cover, so a Friday deploy is a weekend
outage waiting to happen.
MD

# Negative control one: authored invariant, NOT critical. Must be absent.
cat >"${MEMORY_DIR}/reference_not_binding.md" <<'MD'
---
name: reference_not_binding
description: A preference the operator chose not to make binding.
type: reference
critical: false
invariant: >-
  Prefer tabs over spaces in generated fixtures.
---

# Formatting preference

Not binding. Recorded for consistency only.
MD

cat >>"${MEMORY_DIR}/MEMORY.md" <<'MD'

## Fixtures

- [reference_deploy_freeze](reference_deploy_freeze.md) — release windows for the shared cluster
- [reference_not_binding](reference_not_binding.md) — a preference, recorded but not binding
- [reference_no_invariant](reference_no_invariant.md) — critical, rule not yet authored
MD

# Negative control two: critical, but no authored invariant. Nothing to inject.
cat >"${MEMORY_DIR}/reference_no_invariant.md" <<'MD'
---
name: reference_no_invariant
description: Critical memory whose rule has not been written down yet.
type: reference
critical: true
---

# Pending

There is no authored rule on this file.
MD

python3 - <<'PY'
import json, os, pathlib
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
config["routing"] = {"mode": "mock", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "invariants-smoke"}}
# autoRecall OFF on purpose. The tier is not recall; it must fire regardless.
config["memory"]["autoRecall"] = False
config["memory"]["vectorStore"] = "memory"
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY

echo
echo "-- Part A: unit assertions against the built module --"

node <<'NODE'
const { parseMarkdown, discoverFileMemoryDocuments } = await import("./packages/mindstone-core/dist/memory/file-memory.js");
const { selectInvariantRules, buildInvariantPrompt, buildInvariantPromptFromDocuments } =
  await import("./packages/mindstone-core/dist/memory/invariants.js");

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  pass  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};

// --- parser contract (uncovered by smoke:file-memory) ---
const raw = [
  "---",
  "name: fixture",
  "critical: true",
  "invariant: >-",
  "  first line",
  "  second line",
  "metadata:",
  "  critical: false",
  "---",
  "",
  "# Body",
].join("\n");
const parsed = parseMarkdown(raw);
check("block scalar folds into its text", parsed.frontmatter.invariant === "first line second line", JSON.stringify(parsed.frontmatter.invariant));
check("top-level critical beats nested", parsed.frontmatter.critical === "true", JSON.stringify(parsed.frontmatter.critical));
check("container key is not a value", !("metadata" in parsed.frontmatter), JSON.stringify(Object.keys(parsed.frontmatter)));

// --- selection contract ---
const docs = discoverFileMemoryDocuments({});
const rules = selectInvariantRules(docs);
const names = rules.map((rule) => rule.name);
check("binding rule selected", names.includes("reference_deploy_freeze"), names.join(","));
check("non-critical invariant excluded", !names.includes("reference_not_binding"), names.join(","));
check("critical without invariant excluded", !names.includes("reference_no_invariant"), names.join(","));

// --- unconditional injection: no query is involved at any point ---
const block = buildInvariantPromptFromDocuments(docs, { maxPromptTokens: 4000 });
check("rule text present in block", (block.promptText ?? "").includes("Never deploy to the shared cluster on a Friday"), String(block.promptText).slice(0, 120));
check("full count matches selection", block.full === rules.length, `full=${block.full} rules=${rules.length}`);
check("nothing omitted at a sane budget", block.omitted === 0, `omitted=${block.omitted}`);

// --- degradation, not truncation ---
// Two long rules and one short one. Under a budget that fits neither long rule,
// a `break`-style loop loses everything after the first overflow. This tier must
// degrade each entry to its name and still reach the last rule in the list.
const synthetic = Array.from({ length: 3 }, (_, index) => ({
  id: `mem:${index}`,
  kind: "custom",
  text: "body",
  metadata: {
    name: `rule_${index}`,
    critical: "true",
    invariant: index === 2 ? "short" : "x".repeat(900),
  },
}));
const squeezed = buildInvariantPrompt(selectInvariantRules(synthetic), { maxPromptTokens: 300 });
check("every rule accounted for", squeezed.full + squeezed.degraded + squeezed.omitted === 3, JSON.stringify(squeezed));
check("last rule survives an early overflow", (squeezed.promptText ?? "").includes("rule_2"), String(squeezed.promptText));
check("loss is reported in band", (squeezed.promptText ?? "").includes("NOTE:"), String(squeezed.promptText));
check("names survive when text does not", (squeezed.promptText ?? "").includes("rule_0"), String(squeezed.promptText));

// The case above only ever reaches the DEGRADE branch, so a `break` sitting on
// the omit branch would never execute and the assertions above would pass a
// broken build. Found by mutating the module rather than by reading it. This
// case forces a rule to be omitted outright and then requires a later, shorter
// rule to still be admitted — the property that separates per-item admission
// from abort-on-overflow.
const unshrinkable = [
  { id: "mem:a", kind: "custom", text: "b", metadata: { name: "first_short", critical: "true", invariant: "keep me" } },
  { id: "mem:b", kind: "custom", text: "b", metadata: { name: "n".repeat(700), critical: "true", invariant: "z".repeat(700) } },
  { id: "mem:c", kind: "custom", text: "b", metadata: { name: "last_short", critical: "true", invariant: "keep me too" } },
];
const mixed = buildInvariantPrompt(selectInvariantRules(unshrinkable), { maxPromptTokens: 175 });
console.log(`        admissions: ${mixed.admissions.map((entry) => entry.admission).join(", ")}`);
check("a rule too long even to degrade is omitted", mixed.omitted === 1, JSON.stringify({ full: mixed.full, degraded: mixed.degraded, omitted: mixed.omitted }));
check("an omitted rule does not abort the loop", (mixed.promptText ?? "").includes("last_short"), String(mixed.promptText));

// --- memory index tier ---
const { selectMemoryIndexDocument, buildMemoryIndexPrompt, buildMemoryIndexPromptFromDocuments } =
  await import("./packages/mindstone-core/dist/memory/memory-index.js");

const indexDoc = selectMemoryIndexDocument(docs);
check("index document found", Boolean(indexDoc), String(docs.map((d) => d.kind)));

const wideIndex = buildMemoryIndexPromptFromDocuments(docs, { maxPromptTokens: 4000 });
check("index entries injected in full", wideIndex.full >= 3, JSON.stringify({ full: wideIndex.full, total: wideIndex.total }));
check("index hooks survive at a sane budget", (wideIndex.promptText ?? "").includes("release windows for the shared cluster"), String(wideIndex.promptText).slice(0, 200));

// The structural failure this tier exists to fix: an index larger than any
// per-hit budget is not merely unlikely to be recalled, it can never be
// admitted at all, so the agent loses its map of what it knows entirely.
// Degrading line by line must leave pointers behind rather than nothing.
const fatIndex = {
  id: "memory:MEMORY.md",
  kind: "index",
  text: ["# Index", "", ...Array.from({ length: 60 }, (_, i) => `- [entry_${i}](entry_${i}.md) — ${"h".repeat(200)}`)].join("\n"),
};
// Pass 2: too big for hooks, big enough for every pointer. Coverage must be
// total. A single greedy loop cannot reach this state — it spends the budget on
// detail for the first few entries and then drops the existence of the rest,
// which measured 9 full / 1 degraded / 50 omitted before this was fixed.
const allPointers = buildMemoryIndexPrompt(fatIndex, { maxPromptTokens: 900 });
console.log(`        index pass2: full=${allPointers.full} degraded=${allPointers.degraded} omitted=${allPointers.omitted} total=${allPointers.total}`);
check("no entry is lost when pointers alone fit", allPointers.omitted === 0, JSON.stringify(allPointers));
check("every entry degraded rather than a few kept fat", allPointers.degraded === 60, JSON.stringify(allPointers));
check("hooks are gone once degraded", !(allPointers.promptText ?? "").includes("h".repeat(200)), "hook text still present");
check("pointers survive when hooks do not", (allPointers.promptText ?? "").includes("](entry_59.md)"), String(allPointers.promptText).slice(-200));
check("index loss is reported in band", (allPointers.promptText ?? "").includes("NOTE:"), String(allPointers.promptText).slice(-200));
// Headings are what an index's grouping is made of, and grouping is
// information. They survive as long as the pointers do; only the last-resort
// pass spends them, and then only because a heading costs an entry its
// existence. Asserted because without it a fallthrough to that last pass looks
// identical from the outside: same counts, quietly less usable list.
check("section structure survives while pointers fit", (allPointers.promptText ?? "").includes("# Index"), String(allPointers.promptText).slice(0, 300));

// Pass 3: not even every pointer fits. Coverage should still be most of the
// list, not a tenth of it, and the shortfall must be stated.
const squeezedIndex = buildMemoryIndexPrompt(fatIndex, { maxPromptTokens: 700 });
console.log(`        index pass3: full=${squeezedIndex.full} degraded=${squeezedIndex.degraded} omitted=${squeezedIndex.omitted} total=${squeezedIndex.total}`);
check("an oversized index still yields something", Boolean(squeezedIndex.promptText), "empty promptText");
check("most of the list survives as pointers", squeezedIndex.degraded >= 40, JSON.stringify(squeezedIndex));
check("every index entry accounted for", squeezedIndex.full + squeezedIndex.degraded + squeezedIndex.omitted === 60, JSON.stringify(squeezedIndex));
check("the shortfall is stated", (squeezedIndex.promptText ?? "").includes("left out of this turn's budget"), String(squeezedIndex.promptText).slice(-200));

// Force the OMIT branch and require a later entry through it. Written this way
// from the start because the invariant tier's equivalent assertion only ever
// reached the degrade branch, so a `break` on the omit branch went undetected
// until the module was mutated.
const mixedIndex = buildMemoryIndexPrompt({
  id: "memory:MEMORY.md",
  kind: "index",
  text: [
    "- [short_first](a.md) — hook",
    `- [${"L".repeat(600)}](b.md) — hook`,
    "- [short_last](c.md) — hook",
  ].join("\n"),
}, { maxPromptTokens: 190 });
console.log(`        index mixed: full=${mixedIndex.full} degraded=${mixedIndex.degraded} omitted=${mixedIndex.omitted}`);
check("an index entry too long to degrade is omitted", mixedIndex.omitted === 1, JSON.stringify(mixedIndex));
check("an omitted index entry does not abort the loop", (mixedIndex.promptText ?? "").includes("short_last"), String(mixedIndex.promptText));

if (failures > 0) {
  console.log(`Part A: ${failures} failing assertion(s).`);
  process.exit(1);
}
console.log("Part A: all assertions passed.");
NODE

echo
echo "-- Part B: end to end, unrelated query, autoRecall off --"

./scripts/start-gateway.sh >/tmp/mindstone-agent-invariants-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;

const send = await fetch(`${base}/chat/send`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  // Nothing to do with deploys, clusters, Fridays or release windows.
  body: JSON.stringify({ text: "What is a good name for a tabby cat?" }),
});
const body = await send.json();
console.log(`/chat/send -> ${send.status}`);
if (send.status !== 200 || !body.ok) process.exit(1);

const history = await (await fetch(`${base}/chat/history`)).json();
const event = history.entries.find((entry) => entry.metadata?.event === "memory_invariants_injected");
if (!event) {
  console.log("  FAIL  no memory_invariants_injected event on an unrelated query");
  process.exit(1);
}
console.log(`  pass  event fired: ${JSON.stringify({ full: event.metadata.full, degraded: event.metadata.degraded, omitted: event.metadata.omitted, total: event.metadata.total })}`);

if (event.metadata.full !== 1 || event.metadata.total !== 1) {
  console.log(`  FAIL  expected exactly 1 rule in full, got ${JSON.stringify(event.metadata)}`);
  process.exit(1);
}
console.log("  pass  exactly the binding rule was injected, with autoRecall off");

const indexEvent = history.entries.find((entry) => entry.metadata?.event === "memory_index_injected");
if (!indexEvent) {
  console.log("  FAIL  no memory_index_injected event on an unrelated query");
  process.exit(1);
}
console.log(`  pass  index injected: ${JSON.stringify({ full: indexEvent.metadata.full, degraded: indexEvent.metadata.degraded, omitted: indexEvent.metadata.omitted, total: indexEvent.metadata.total })}`);
if (indexEvent.metadata.omitted !== 0) {
  console.log("  FAIL  index entries omitted at the default budget on a three-file runtime");
  process.exit(1);
}
console.log("  pass  the whole index fit, so nothing was silently lost");

const recall = history.entries.find((entry) => entry.metadata?.event === "memory_recall_injected");
if (recall) {
  console.log("  FAIL  recall fired with autoRecall off — the tier under test is not isolated");
  process.exit(1);
}
console.log("  pass  no recall event, so both injections came from tiers and not from search");
NODE

kill "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

echo
echo "-- Part C: prove the assertions can fail --"

# Each case below is a real defect this tier has had or could have. If any of
# them still reports success, the corresponding assertion in Part A is decorative
# and this script must not be trusted.
node <<'NODE'
const { selectInvariantRules, buildInvariantPrompt } =
  await import("./packages/mindstone-core/dist/memory/invariants.js");

let undetected = 0;
const mustFail = (label, assertion) => {
  if (assertion()) {
    undetected += 1;
    console.log(`  UNDETECTED  ${label}`);
  } else {
    console.log(`  detected    ${label}`);
  }
};

const doc = (overrides) => ({ id: "mem:x", kind: "custom", text: "body", metadata: { name: "rule", ...overrides } });

// A parser that leaves the block-scalar indicator as the value produces a rule
// whose text is literally ">-": present, injected, and carrying nothing.
mustFail("literal block-scalar indicator passes as a rule", () => {
  const rules = selectInvariantRules([doc({ critical: "true", invariant: ">-" })]);
  const block = buildInvariantPrompt(rules, { maxPromptTokens: 4000 });
  return (block.promptText ?? "").includes("Never deploy");
});

// Nested critical:false silently demoting a top-level critical:true.
mustFail("non-critical document reaches the tier", () => {
  const rules = selectInvariantRules([doc({ critical: "false", invariant: "some rule" })]);
  return rules.length > 0;
});

// The break-on-overflow shape: one oversized entry swallowing the rest.
mustFail("later rules survive when the budget is zero", () => {
  const rules = selectInvariantRules([
    doc({ name: "big", critical: "true", invariant: "y".repeat(900) }),
    doc({ name: "small", critical: "true", invariant: "s" }),
  ]);
  const block = buildInvariantPrompt(rules, { maxPromptTokens: 1 });
  return (block.promptText ?? "").includes("small");
});

// Silence on loss. If nothing fits, the result must still report the loss
// rather than returning an empty block that reads as "no rules exist".
mustFail("total loss is reported as an empty tier", () => {
  const rules = selectInvariantRules([doc({ critical: "true", invariant: "z".repeat(900) })]);
  const block = buildInvariantPrompt(rules, { maxPromptTokens: 1 });
  return block.total === 0;
});

const { buildMemoryIndexPrompt: buildIndex } = await import("./packages/mindstone-core/dist/memory/memory-index.js");
const fatIndex = (count, hookLength) => ({
  id: "memory:MEMORY.md",
  kind: "index",
  text: Array.from({ length: count }, (_, i) => `- [entry_${i}](entry_${i}.md) — ${"h".repeat(hookLength)}`).join("\n"),
});

// All-or-nothing admission: the shape where an index larger than the budget is
// dropped whole and the agent silently loses its map.
mustFail("an oversized index survives whole-document admission", () => {
  const block = buildIndex(fatIndex(60, 200), { maxPromptTokens: 700 });
  return !block.promptText;
});

// Degradation that keeps the hook buys nothing and would report success.
mustFail("hooks are still present after degradation", () => {
  const block = buildIndex(fatIndex(60, 200), { maxPromptTokens: 700 });
  return (block.promptText ?? "").includes("h".repeat(200));
});

if (undetected > 0) {
  console.log(`Part C: ${undetected} assertion(s) could not fail. This gate is not trustworthy.`);
  process.exit(1);
}
console.log("Part C: every assertion demonstrated failing on a real defect.");
NODE

echo
echo "Always-in-force memory tier smoke test passed."
