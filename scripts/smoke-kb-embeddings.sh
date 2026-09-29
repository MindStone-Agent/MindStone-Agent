#!/usr/bin/env bash
set -euo pipefail

# KB embeddings smoke (#125 §5): a KB's entries are embedded at ingest with
# the install's embedder, and recall ranks KB sources by meaning.
#   1. unit: vectors file (write, read, stale rules, float32 range, time
#      limit), the KB recall provider (cosine, threshold, dimension, embedder
#      down, partial vectors, cap), the quota merge and selection, and the
#      shared query embedder
#   2. end to end against a stub embedder: no embedder -> no vectors; ingest
#      writes vectors.json; a question with no shared words recalls the KB
#      source by meaning; the query is embedded once per turn, with and
#      without the sqlite-vec index; embedder down, another dimension or
#      another model -> word match only, status says why; a failed embed
#      keeps the ingest and removes old vectors; the quota keeps a KB slot
#      against better-scoring memory; a persona's private KB, and a private
#      vectors.json that is a link; a partly embedded source stays on word
#      match; through the gateway, an admin ingest embeds a private KB and a
#      chat turn recalls by meaning with one query embedding
#   Binds stub port base+38 and gateway port base+39.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-kbembed-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
EMBED_PORT="$((SMOKE_PORT_BASE + 38))"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 39))"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${embed_pid:-}" ]]; then
    kill "${embed_pid}" >/dev/null 2>&1 || true
    wait "${embed_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export EMBEDDER_BASE_URL="http://127.0.0.1:${EMBED_PORT}/v1"
export EMBEDDER_TIMEOUT_MS=1500
export EMBED_PORT
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export KBE_TOKEN="kb-embed-smoke-service-token"
export KBE_ADMIN_TOKEN="kb-embed-smoke-admin-token"

cd "${PROJECT_ROOT}"

echo "== KB embeddings smoke test =="

# A stub embedder: a vector per topic, so meaning can match with no shared words.
node --input-type=module <<'NODE' >"${TEMP_RUNTIME}/embedder.log" 2>&1 &
import { createServer } from "node:http";
const TOPICS = [
  /\b(car|automobile|sedan|vehicle|tire|tires|wheel|wheels)\b/i,
  /\b(bread|oven|bake|baking|recipe|kitchen|flour|dough)\b/i,
  /\b(tomato|tomatoes|garden|soil|seedling|seedlings|loamy)\b/i,
  /mindstone embedding health check/i,
];
const state = { mode: "ok", requests: [] };
function vectorFor(text, dims) {
  const vector = new Array(dims).fill(0);
  TOPICS.forEach((pattern, index) => { if (index < dims && pattern.test(text)) vector[index] = 1; });
  if (vector.every((value) => value === 0)) vector[dims - 1] = 1;
  return vector;
}
createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/_test/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.url === "/_test/mode") {
      state.mode = JSON.parse(raw).mode;
      state.requests = [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/embeddings") { res.writeHead(404); res.end("{}"); return; }
    const body = JSON.parse(raw);
    const input = Array.isArray(body.input) ? body.input : [body.input];
    const request = { model: body.model, input, t: Date.now() };
    state.requests.push(request);
    if (state.mode === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub embedder is down" } }));
      return;
    }
    const dims = state.mode === "dim5" ? 5 : 6;
    const answer = () => {
      request.done = Date.now();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", model: body.model, data: input.map((text, index) => ({ object: "embedding", index, embedding: vectorFor(text, dims) })) }));
    };
    if (state.mode === "slow") setTimeout(answer, 6000);
    // One request at a time, 150 ms an entry, like Ollama's default (#156 review).
    else if (state.mode === "serial") state.queue = (state.queue ?? Promise.resolve()).then(() => new Promise((resolve) => setTimeout(() => { answer(); resolve(); }, 150 * input.length)));
    else answer();
  });
}).listen(Number(process.env.EMBED_PORT), "127.0.0.1", () => console.log("stub embedder up"));
NODE
embed_pid=$!

npm run build:mindstone >/dev/null
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"

DATA="${TEMP_RUNTIME}/mindstone"
MS=./scripts/mindstone
STUB="http://127.0.0.1:${EMBED_PORT}"

stub_mode() { curl -s -X POST -d "{\"mode\":\"$1\"}" "${STUB}/_test/mode" >/dev/null; }
# stub_count <text>: requests that embedded exactly this one text.
stub_count() { STUB_TEXT="$1" node -e 'fetch(process.argv[1]).then((r)=>r.json()).then((s)=>console.log(s.requests.filter((q)=>q.input.length===1&&q.input[0]===process.env.STUB_TEXT).length))' "${STUB}/_test/state"; }
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s "${STUB}/_test/state" >/dev/null 2>&1 && break; sleep 0.3; done

# --- 1. Unit ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  KB_EMBED_LIMITS, KB_REEMBED_STATE_FILE, KB_VECTORS_FILE, cosineSimilarity, kbEntryEmbeddingText, kbVectorsCachedPaths, readKbReembedState, readKbVectors, writeKbReembedState, writeKbVectors,
} from "./packages/mindstone-core/src/knowledgebase/vectors.ts";
import { KB_REEMBED_LIMITS, ingestMindStoneKnowledgebase, knowledgebaseReembedState, mindStoneKbStatus, privateKnowledgebaseLinkError, reembedState, reembedStaleKnowledgebase, resetKnowledgebaseReembed, turnsHoldReembed, waitWhileTurnsRun } from "./packages/mindstone-core/src/knowledgebase/load.ts";
import { KnowledgebaseRecallProvider, knowledgebaseRecallSettings } from "./packages/mindstone-core/src/knowledgebase/recall.ts";
import { buildMemoryRecallPrompt, CombinedMemoryRecallProvider, KB_RECALL_QUOTA, isQuotaHit, recallMindStoneMemory, selectRecallHits } from "./packages/mindstone-core/src/memory/recall.ts";
import { createMemoryEmbeddingProvider, sharedQueryEmbedder } from "./packages/mindstone-core/src/memory/embedding.ts";

const entry = (id: string, text: string, section?: string) => ({
  entryId: id, sourceId: "s.md", sourcePath: "s.md", sourceTitle: "Title", section, citation: `s.md § ${section ?? id}`, summary: text.slice(0, 40), text, sourceMtimeMs: 0,
});
const fixed = (vectors: Record<string, number[]>, fallback = [0, 0, 1]) => ({
  id: "stub", model: "m1", calls: 0,
  async embedTexts(texts: string[]) { this.calls += 1; return texts.map((t) => Object.entries(vectors).find(([k]) => t.includes(k))?.[1] ?? fallback); },
});

// Embedding text: title and heading first, capped.
assert.equal(kbEntryEmbeddingText(entry("a", "body", "Head")), "Title — Head\n\nbody");
assert.equal(kbEntryEmbeddingText(entry("a", "x".repeat(9000))).length, 6000);

const dir = mkdtempSync(join(tmpdir(), "kbvec-"));
const entries = [entry("e1", "alpha text", "A"), entry("e2", "beta text", "B")];
const indexText = JSON.stringify({ kbId: "k", entries });

// Written: provider, model, dimension, index digest; every entry.
let written = await writeKbVectors({ kbDir: dir, kbId: "k", entries, indexText, embedder: fixed({ alpha: [1, 0, 0], beta: [0, 1, 0] }), batchSize: 1 });
assert.equal(written.state, "ready");
const file = JSON.parse(readFileSync(join(dir, KB_VECTORS_FILE), "utf8"));
assert.equal(file.provider, "stub"); assert.equal(file.model, "m1"); assert.equal(file.dimension, 3);
assert.match(file.indexSha256, /^[0-9a-f]{64}$/);
assert.deepEqual(Object.keys(file.vectors).sort(), ["e1", "e2"]);
let read = readKbVectors(dir, indexText, { id: "stub", model: "m1" });
assert.equal(read.state, "ready");
assert.deepEqual([...(read as any).loaded.vectors.get("e1")], [1, 0, 0]);

// Stale: another provider, another model, a changed index. Unused: no embedder.
assert.equal(readKbVectors(dir, indexText, { id: "other", model: "m1" }).state, "stale");
const otherModel = readKbVectors(dir, indexText, { id: "stub", model: "m2" });
assert.equal(otherModel.state, "stale"); assert.match((otherModel as any).reason, /re-ingest/);
assert.match((readKbVectors(dir, indexText + " ", { id: "stub", model: "m1" }) as any).reason, /index changed/);
assert.equal(readKbVectors(dir, indexText, undefined).state, "unused");
// A vector of the wrong length makes the file stale, not half used.
const broken = { ...file, vectors: { ...file.vectors, e2: Buffer.from(new Float32Array([1, 2]).buffer).toString("base64") } };
writeFileSync(join(dir, KB_VECTORS_FILE), JSON.stringify(broken));
assert.equal(readKbVectors(dir, indexText, { id: "stub", model: "m1" }).state, "stale");

// Failures keep nothing: a throwing embedder, a short answer, mixed
// dimensions, a value past float32, and the time limit all remove the file.
// An all-zero vector (or one that rounds to zero in float32) fails the embed, and says why.
for (const zero of [[0, 0, 0], [1e-50, 0, -1e-50]]) {
  const zdir = mkdtempSync(join(tmpdir(), "kbvec-zero-"));
  const zeroed = await writeKbVectors({ kbDir: zdir, kbId: "k", entries, indexText, embedder: { id: "stub", model: "m1", async embedTexts(texts: string[]) { return texts.map(() => zero); } } as any });
  assert.match((zeroed as any).reason ?? "", /all-zero vector/, `a zero vector ${JSON.stringify(zero)} must fail the embed`);
}
const failing = [
  { id: "stub", model: "m1", async embedTexts() { throw new Error("down"); } },
  { id: "stub", model: "m1", async embedTexts(texts: string[]) { return texts.slice(1).map(() => [1, 0]); } },
  { id: "stub", model: "m1", async embedTexts(texts: string[]) { return [...texts, "extra"].map(() => [1, 0]); } },
  { id: "stub", model: "m1", async embedTexts(texts: string[]) { return texts.map((_, i) => (i ? [1, 0] : [1, 0, 0])); } },
  { id: "stub", model: "m1", async embedTexts(texts: string[]) { return texts.map(() => [1e39, 0]); } },
];
for (const embedder of failing) {
  await writeKbVectors({ kbDir: dir, kbId: "k", entries, indexText, embedder: fixed({ alpha: [1, 0, 0] }) });
  assert.ok(existsSync(join(dir, KB_VECTORS_FILE)));
  written = await writeKbVectors({ kbDir: dir, kbId: "k", entries, indexText, embedder });
  assert.equal(written.state, "missing");
  assert.ok(!existsSync(join(dir, KB_VECTORS_FILE)), "a failed embed must remove the old vectors");
}
const slow = { id: "stub", model: "m1", embedTexts: () => new Promise<number[][]>(() => {}) };
const started = Date.now();
written = await writeKbVectors({ kbDir: dir, kbId: "k", entries, indexText, embedder: slow as any, timeoutMs: 300 });
assert.equal(written.state, "missing"); assert.match((written as any).reason, /longer than/);
assert.ok(Date.now() - started < 3000, "the time limit must end the embed");
await writeKbVectors({ kbDir: dir, kbId: "k", entries, indexText, embedder: fixed({ alpha: [1, 0, 0] }) });
written = await writeKbVectors({ kbDir: dir, kbId: "k", entries, indexText, embedder: undefined });
assert.match((written as any).reason, /no embedder/);
assert.ok(!existsSync(join(dir, KB_VECTORS_FILE)), "ingest with no embedder must remove old vectors");

// A private KB's vectors.json that is a link is not read.
await writeKbVectors({ kbDir: dir, kbId: "k", entries, indexText, embedder: fixed({ alpha: [1, 0, 0] }) });
const linked = mkdtempSync(join(tmpdir(), "kbvec-link-"));
symlinkSync(join(dir, KB_VECTORS_FILE), join(linked, KB_VECTORS_FILE));
assert.equal(readKbVectors(linked, indexText, { id: "stub", model: "m1" }, { noLinks: true }).state, "missing");
assert.equal(readKbVectors(linked, indexText, { id: "stub", model: "m1" }).state, "ready");

// The KB provider.
const doc = (id: string, text: string) => ({ id, kind: "kb" as const, text, metadata: { kbId: id } });
const vec = (values: number[]) => new Float32Array(values);
const recall = {
  documents: [doc("kb:a", "header\n- a1\nfooter"), doc("kb:b", "header\n- b1\nfooter"), doc("kb:c", "zebra words only"), doc("kb:d", "header\n- d1")],
  vectors: () => new Map([
    ["kb:a", { dimension: 3, header: ["header"], footer: ["footer"], entries: [{ line: "- a0", citation: "a0", vector: vec([0, 1, 0]) }, { line: "- a1", citation: "a1", vector: vec([1, 0, 0]) }] }],
    ["kb:b", { dimension: 3, header: ["header"], footer: ["footer"], entries: [{ line: "- b1", citation: "b1", vector: vec([0.6, 0.8, 0]) }] }],
    ["kb:d", { dimension: 2, header: ["header"], footer: [], entries: [{ line: "- d1", citation: "d1", vector: vec([1, 0]) }] }],
  ]),
};
const queryEmbedder = fixed({ question: [1, 0, 0] });
let hits = await new KnowledgebaseRecallProvider(recall as any, { embedder: queryEmbedder, minSimilarity: 0.5 }).search({ text: "question zebra", limit: 8 });
const semantic = hits.filter(isQuotaHit);
assert.deepEqual(semantic.map((h) => h.id), ["kb:a", "kb:b"], "ranked by cosine; kb:d's other dimension ignored");
assert.equal(semantic[0].score, 1);
assert.equal(semantic[0].text, "header\n- a1\n- a0\nfooter", "closest section first");
assert.equal(semantic[0].metadata?.bestCitation, "a1");
assert.ok(hits.some((h) => h.id === "kb:c" && !isQuotaHit(h)), "word match still runs");
assert.equal(hits.find((h) => h.id === "kb:c")?.metadata?.recallMode, "lexical", "a KB word-match hit says so (#151)");
assert.equal(queryEmbedder.calls, 1);
// A source found by meaning and by words comes back twice; the selection keeps one copy.
hits = await new KnowledgebaseRecallProvider(recall as any, { embedder: fixed({ question: [1, 0, 0] }), minSimilarity: 0.5 }).search({ text: "question header", limit: 8 });
const copies = hits.filter((h) => h.id === "kb:a");
assert.equal(copies.length, 2, "both copies of kb:a");
assert.notEqual(copies[0].chunkId, copies[1].chunkId, "each copy has its own chunk id");
assert.deepEqual(selectRecallHits(hits, 8).filter((h) => h.id === "kb:a").map(isQuotaHit), [true], "the meaning copy is kept, the word copy dropped");
// A weak meaning score never loses an exact-term source: a quota hit meets its own threshold, not minScore.
{
  const weak = { id: "stub", model: "m1", async embedTexts() { return [[0.55, Math.sqrt(1 - 0.55 * 0.55), 0]]; } };
  const provider = new KnowledgebaseRecallProvider(recall as any, { embedder: weak as any, minSimilarity: 0.5 });
  const result = await recallMindStoneMemory({ agentId: "unit", entries: [{ role: "user", text: "question header" }] as any, provider, config: { minScore: 0.9, maxResults: 4 } });
  assert.ok(result?.hits.some((h) => h.id === "kb:a"), `the source must survive a high minScore: ${JSON.stringify(result?.hits.map((h) => h.id))}`);
}
// A source found by meaning shows its 5 closest sections, then says how many more.
{
  const many = { documents: [doc("kb:m", "x")], vectors: () => new Map([["kb:m", { dimension: 3, header: ["h"], footer: ["f"], entries: Array.from({ length: 8 }, (_, i) => ({ line: `- s${i}`, citation: `s${i}`, vector: vec([1, i / 10, 0]) })) }]]) };
  const [meaning] = (await new KnowledgebaseRecallProvider(many as any, { embedder: fixed({ q: [1, 0, 0] }), minSimilarity: 0 }).search({ text: "q", limit: 8 })).filter(isQuotaHit);
  assert.equal(meaning.text, "h\n- s0\n- s1\n- s2\n- s3\n- s4\n- …and 3 more section(s) of this source\nf");
}
// A turn that doesn't rank by meaning never reads vectors.json.
{
  const unread = { documents: recall.documents, vectors: () => { throw new Error("vectors were read"); } };
  await new KnowledgebaseRecallProvider(unread as any, { embedder: fixed({ question: [1, 0, 0] }), maxResults: 0 }).search({ text: "question", limit: 8 });
  await new KnowledgebaseRecallProvider(unread as any, {}).search({ text: "question", limit: 8 });
}
// A source exactly at minSimilarity is recalled (#151).
{
  const edge = { documents: [doc("kb:e", "x")], vectors: () => new Map([["kb:e", { dimension: 3, header: [], footer: [], entries: [{ line: "- e", citation: "e", vector: vec([1, 1, 0]) }] }]]) };
  const at = cosineSimilarity([1, 0, 0], vec([1, 1, 0]));
  const found = await new KnowledgebaseRecallProvider(edge as any, { embedder: fixed({ q: [1, 0, 0] }), minSimilarity: at }).search({ text: "q", limit: 8 });
  assert.equal(found.filter(isQuotaHit).length, 1, "a source at exactly minSimilarity must be recalled");
}
// knowledgebases.recall: out of range falls back to the default.
assert.deepEqual(knowledgebaseRecallSettings({ knowledgebases: { recall: { maxResults: 20, minSimilarity: -0.5 } } } as any), { maxResults: 20, minSimilarity: -0.5 });
assert.deepEqual(knowledgebaseRecallSettings({ knowledgebases: { recall: { maxResults: 21, minSimilarity: 1.5 } } } as any), { maxResults: undefined, minSimilarity: undefined });
assert.deepEqual(knowledgebaseRecallSettings({ knowledgebases: { recall: { maxResults: 2.5 } } } as any).maxResults, undefined);
assert.deepEqual(knowledgebaseRecallSettings({ knowledgebases: { recall: { maxResults: -1, minSimilarity: -1.5 } } } as any), { maxResults: undefined, minSimilarity: undefined });
assert.deepEqual(knowledgebaseRecallSettings({ knowledgebases: { recall: { maxResults: 0, minSimilarity: -1 } } } as any), { maxResults: 0, minSimilarity: -1 });
// An all-zero question vector recalls nothing by meaning, even with minSimilarity at -1.
{
  const zeroQuery = await new KnowledgebaseRecallProvider(recall as any, { embedder: fixed({ question: [0, 0, 0] }), minSimilarity: -1 }).search({ text: "question", limit: 8 });
  assert.equal(zeroQuery.filter(isQuotaHit).length, 0, "an all-zero question vector must match nothing");
}
// Threshold, cap, embedder down, no embedder.
hits = await new KnowledgebaseRecallProvider(recall as any, { embedder: fixed({ question: [1, 0, 0] }), minSimilarity: 0.7 }).search({ text: "question", limit: 8 });
assert.deepEqual(hits.filter(isQuotaHit).map((h) => h.id), ["kb:a"]);
hits = await new KnowledgebaseRecallProvider(recall as any, { embedder: fixed({ question: [1, 0, 0] }), maxResults: 1, minSimilarity: 0 }).search({ text: "question", limit: 8 });
assert.equal(hits.filter(isQuotaHit).length, 1);
hits = await new KnowledgebaseRecallProvider(recall as any, { embedder: failing[0] as any }).search({ text: "question zebra", limit: 8 });
assert.deepEqual(hits.map((h) => h.id), ["kb:c"], "embedder down: word match only");
hits = await new KnowledgebaseRecallProvider(recall as any, {}).search({ text: "question zebra", limit: 8 });
assert.deepEqual(hits.map((h) => h.id), ["kb:c"]);
hits = await new KnowledgebaseRecallProvider(recall as any, { embedder: fixed({ question: [1, 0, 0] }), maxResults: 0 }).search({ text: "question zebra", limit: 8 });
assert.equal(hits.filter(isQuotaHit).length, 0, "maxResults 0 turns meaning off");

// Quota: only KB hits with the marker count; they keep slots in the merge and the selection.
const hit = (id: string, score: number, quota = false, kind = "doc") => ({ id, chunkId: `${id}#0`, sourceId: id, ordinal: 0, kind, text: id, score, metadata: quota ? { recallQuota: KB_RECALL_QUOTA } : {} } as any);
assert.equal(isQuotaHit(hit("x", 1, true, "doc")), false, "only a kb hit can take a quota slot");
assert.equal(isQuotaHit(hit("x", 1, true, "kb")), true);
const merged = await new CombinedMemoryRecallProvider([
  { id: "m", search: () => [hit("m1", 0.99), hit("m2", 0.98), hit("m3", 0.97)] },
  { id: "k", search: () => [hit("k1", 0.51, true, "kb")] },
]).search({ text: "q", limit: 2 });
assert.deepEqual(merged.map((h) => h.id), ["k1", "m1", "m2"]);
assert.deepEqual(selectRecallHits(merged, 2).map((h) => h.id), ["k1", "m1"]);
// The prompt budget goes to quota hits first: a long memory hit ranked above can't push them out.
{
  const long = { ...hit("long", 0.99), text: "word ".repeat(4000) };
  const kbHit = { ...hit("k1", 0.5, true, "kb"), text: "a short KB source" };
  const prompt = buildMemoryRecallPrompt([long, kbHit], 2500);
  assert.deepEqual(prompt.hits.map((h) => h.id), ["long", "k1"], "the quota hit fits before the long memory hit, and the best memory hit still goes in");
  // Quota hits take at most half the budget: three large KB sources leave room for memory.
  // Each about 600 tokens: all three would fit the whole budget, two fit half of it.
  const kbBig = (id: string) => ({ ...hit(id, 0.5, true, "kb"), text: "section ".repeat(300) });
  const memory = { ...hit("m-top", 0.9), text: "memory ".repeat(600) };
  const crowded = buildMemoryRecallPrompt([memory, kbBig("k1"), kbBig("k2"), kbBig("k3"), hit("m2", 0.4)], 2500);
  assert.ok(crowded.hits.some((h) => h.id === "m-top"), "the best memory hit must stay in");
  assert.ok(crowded.hits.filter(isQuotaHit).length <= 2, `quota hits took more than half the budget: ${crowded.hits.map((h) => h.id)}`);
  // The best quota hit always goes in, even past half the budget, as the best memory hit does.
  const oversize = { ...hit("k-big", 0.5, true, "kb"), text: "section ".repeat(700) };
  assert.deepEqual(buildMemoryRecallPrompt([oversize], 1000).hits.map((h) => h.id), ["k-big"], "a lone quota hit past half the budget must still go in");
  // Budget memory leaves unused goes back to the quota hits left out.
  const small = buildMemoryRecallPrompt([kbBig("k1"), kbBig("k2"), kbBig("k3"), hit("m-small", 0.9)], 2500);
  assert.deepEqual(small.hits.filter(isQuotaHit).map((h) => h.id), ["k1", "k2", "k3"], `unused budget must go to the quota hits left out: ${small.hits.map((h) => h.id)}`);
  // Other KB sources stop at half of what is left, so later memory hits fit; memory stops at the budget.
  const memHit = (id: string) => ({ ...hit(id, 0.5), text: "memory ".repeat(340) });
  const shared = buildMemoryRecallPrompt([hit("m-top", 0.9), kbBig("k1"), kbBig("k2"), kbBig("k3"), memHit("m2"), memHit("m3"), memHit("m4")], 2500);
  const ids = shared.hits.map((h) => h.id);
  assert.ok(ids.includes("m3"), `KB sources past half of what was left pushed memory out: ${ids}`);
  assert.ok(!ids.includes("m4"), `memory went past the budget: ${ids} (${shared.tokens} tokens)`);
  assert.deepEqual(buildMemoryRecallPrompt([long, hit("m2", 0.5)], 2500).hits.map((h) => h.id), ["long"], "with no quota hit, the order decides as before");
}
assert.deepEqual(selectRecallHits([hit("m1", 0.9), hit("m2", 0.8)], 1).map((h) => h.id), ["m1"]);
// KB slots come out of memory's limit, and memory keeps one when it has a hit (#151).
{
  const three = [hit("k1", 0.9, true, "kb"), hit("k2", 0.8, true, "kb"), hit("k3", 0.7, true, "kb")];
  assert.deepEqual(selectRecallHits([...three, hit("m1", 0.9), hit("m2", 0.8)], 3).map((h) => h.id), ["k1", "k2", "m1"], "memory keeps a slot");
  assert.deepEqual(selectRecallHits(three, 3).map((h) => h.id), ["k1", "k2", "k3"], "with no memory hit, KB sources take every slot");
  assert.deepEqual(selectRecallHits([...three, hit("m1", 0.9)], 1).map((h) => h.id), ["m1"], "one slot: memory's");
  // A KB source's word copy isn't memory: it doesn't take a slot from the quota.
  assert.deepEqual(selectRecallHits([...three, hit("k3", 0.95, false, "kb")], 3).map((h) => `${h.id}:${isQuotaHit(h) ? "meaning" : "words"}`), ["k1:meaning", "k2:meaning", "k3:meaning"]);
  // A capped-out source's word copy, ranked above memory's hit, doesn't take memory's slot.
  const tag = (h: any) => `${h.id}:${isQuotaHit(h) ? "meaning" : h.id.startsWith("k") ? "words" : "memory"}`;
  assert.deepEqual(selectRecallHits([...three, hit("k3", 0.95, false, "kb"), hit("m1", 0.5)], 3).map(tag), ["k1:meaning", "k2:meaning", "m1:memory"]);
  assert.deepEqual(selectRecallHits([...three, hit("k1", 0.95, false, "kb"), hit("m1", 0.5)], 1).map(tag), ["m1:memory"]);
  // A KB source found only by words (no meaning copy) isn't memory either.
  const kbWords = (id: string) => hit(id, 0.95, false, "kb");
  const kindTag = (h: any) => `${h.id}:${isQuotaHit(h) ? "meaning" : h.kind === "kb" ? "kb-words" : "memory"}`;
  assert.deepEqual(selectRecallHits([...three, kbWords("kx"), hit("m1", 0.5)], 3).map(kindTag), ["k1:meaning", "k2:meaning", "m1:memory"]);
  assert.deepEqual(selectRecallHits([...three, kbWords("kx")], 3).map(kindTag), ["k1:meaning", "k2:meaning", "k3:meaning"], "with no memory hit, KB sources keep every slot");
  // With no KB source ranked by meaning, selection is by rank alone, as before #151.
  assert.deepEqual(selectRecallHits([kbWords("ka"), kbWords("kb"), kbWords("kc"), hit("m1", 0.5)], 3).map(kindTag), ["ka:kb-words", "kb:kb-words", "kc:kb-words"]);
  // In the prompt, the forced hit is memory's own, not a word copy ranked above it.
  const wordCopy = { ...hit("k8", 0.95, false, "kb"), text: "words ".repeat(900) };
  const promptWithCopy = buildMemoryRecallPrompt([hit("k8", 0.9, true, "kb"), wordCopy, hit("m1", 0.5)], 500);
  assert.ok(promptWithCopy.hits.some((h) => h.id === "m1"), `the best memory hit must go in before a word copy: ${promptWithCopy.hits.map((h) => h.id)}`);
  const promptWithKbWords = buildMemoryRecallPrompt([hit("k8", 0.9, true, "kb"), { ...kbWords("kx"), text: "words ".repeat(900) }, hit("m1", 0.5)], 500);
  assert.ok(promptWithKbWords.hits.some((h) => h.id === "m1"), `the best memory hit must go in before a KB source found by words: ${promptWithKbWords.hits.map((h) => h.id)}`);
}

// A request the embedder can't finish in time: the batch once more, an entry a request; one that
// times out alone says so.
{
  const abort = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  const onlySingles = { id: "stub", model: "m1", async embedTexts(texts: string[]) { if (texts.length > 1) throw abort(); return [[1, 0]]; } };
  const retried = await writeKbVectors({ kbDir: mkdtempSync(join(tmpdir(), "kbvec-retry-")), kbId: "k", entries, indexText, embedder: onlySingles as any });
  assert.equal(retried.state, "ready", "a batch that timed out is retried an entry a request");
  const never = { id: "stub", model: "m1", async embedTexts() { throw abort(); } };
  const gaveUp = await writeKbVectors({ kbDir: mkdtempSync(join(tmpdir(), "kbvec-abort-")), kbId: "k", entries, indexText, embedder: never as any });
  assert.match((gaveUp as any).reason, /didn't answer a request in time/);
}
// Another file version, or a file over the size limit, is stale.
{
  const vdir = mkdtempSync(join(tmpdir(), "kbvec-version-"));
  await writeKbVectors({ kbDir: vdir, kbId: "k", entries, indexText, embedder: fixed({ alpha: [1, 0, 0] }) });
  const v2 = JSON.parse(readFileSync(join(vdir, KB_VECTORS_FILE), "utf8"));
  writeFileSync(join(vdir, KB_VECTORS_FILE), JSON.stringify({ ...v2, version: 2 }));
  assert.equal(readKbVectors(vdir, indexText, { id: "stub", model: "m1" }).state, "stale");
  const big = mkdtempSync(join(tmpdir(), "kbvec-big-"));
  await writeKbVectors({ kbDir: big, kbId: "k", entries, indexText, embedder: fixed({ alpha: [1, 0, 0] }) });
  const cap = KB_EMBED_LIMITS.maxFileBytes;
  KB_EMBED_LIMITS.maxFileBytes = 10;
  try {
    assert.match((readKbVectors(big, indexText, { id: "stub", model: "m1" }) as any).reason, /larger than/);
  } finally {
    KB_EMBED_LIMITS.maxFileBytes = cap;
  }
}
// The cache follows the file, not only its size and mtime: a new file moved into place with the
// same size and mtime (a re-ingest within a second on a coarse clock) is read again.
{
  const cdir = mkdtempSync(join(tmpdir(), "kbvec-cache-"));
  await writeKbVectors({ kbDir: cdir, kbId: "k", entries, indexText, embedder: fixed({ alpha: [1, 0, 0] }) });
  const path = join(cdir, KB_VECTORS_FILE);
  // A whole-second mtime, as a coarse clock gives, so the new file can match it exactly.
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  assert.equal(readKbVectors(cdir, indexText, { id: "stub", model: "m1" }).state, "ready");
  const before = statSync(path);
  const other = JSON.parse(readFileSync(path, "utf8"));
  other.indexSha256 = other.indexSha256.replace(/./, (c: string) => (c === "0" ? "1" : "0"));
  writeFileSync(join(cdir, "next.json"), `${JSON.stringify(other)}\n`);
  renameSync(join(cdir, "next.json"), path);
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  assert.equal(statSync(path).size, before.size, "fixture: same size");
  assert.equal(statSync(path).mtimeMs, before.mtimeMs, "fixture: same mtime");
  assert.match((readKbVectors(cdir, indexText, { id: "stub", model: "m1" }) as any).reason ?? "", /index changed/, "a new file with the same size and mtime must be read again");
}
// The cache: a file too large to read holds no memory; past the byte budget the least recently used goes.
{
  const make = async () => {
    const d = mkdtempSync(join(tmpdir(), "kbvec-lru-"));
    await writeKbVectors({ kbDir: d, kbId: "k", entries, indexText, embedder: fixed({ alpha: [1, 0, 0] }) });
    return d;
  };
  const [a, b, c] = [await make(), await make(), await make()];
  const size = statSync(join(a, KB_VECTORS_FILE)).size;
  const saved = { ...KB_EMBED_LIMITS };
  try {
    KB_EMBED_LIMITS.cacheBytes = size + 10;
    readKbVectors(a, indexText, { id: "stub", model: "m1" });
    KB_EMBED_LIMITS.maxFileBytes = 10;
    assert.match((readKbVectors(b, indexText, { id: "stub", model: "m1" }) as any).reason, /larger than/);
    KB_EMBED_LIMITS.maxFileBytes = saved.maxFileBytes;
    assert.ok(kbVectorsCachedPaths().includes(join(a, KB_VECTORS_FILE)), "a file not read must not push others out");
    readKbVectors(c, indexText, { id: "stub", model: "m1" });
    const cached = kbVectorsCachedPaths();
    assert.ok(cached.includes(join(c, KB_VECTORS_FILE)) && !cached.includes(join(a, KB_VECTORS_FILE)), `past the budget the least recently used goes: ${cached}`);
  } finally {
    Object.assign(KB_EMBED_LIMITS, saved);
  }
}
// A vectors.json that is a pipe is never waited on.
{
  const d = mkdtempSync(join(tmpdir(), "kbvec-fifo-"));
  execFileSync("mkfifo", [join(d, KB_VECTORS_FILE)]);
  assert.equal(readKbVectors(d, indexText, { id: "stub", model: "m1" }).state, "missing");
}
// After a model switch, a KB is embedded again from its index, one a call (#151): only one another
// model made, not one whose index changed or that is too large; a claimed-out KB is left for later.
{
  const kb = async (root: string, id: string, text: string, model: string) => {
    mkdirSync(join(root, id, "sources"), { recursive: true });
    writeFileSync(join(root, id, "kb.json"), JSON.stringify({ name: id }));
    writeFileSync(join(root, id, "sources", "a.md"), text);
    await ingestMindStoneKnowledgebase(root, id, { embedder: { ...fixed({ alpha: [1, 0, 0] }), model } as any });
  };
  const modelOf = (root: string, id: string) => JSON.parse(readFileSync(join(root, id, KB_VECTORS_FILE), "utf8")).model;
  const now = { ...fixed({ alpha: [1, 0, 0] }), model: "m1" } as any;
  // The rules: a-big (2 entries) over a limit of 1; b-index (this model) changed after its vectors; c-old another model.
  const rules = mkdtempSync(join(tmpdir(), "kbvec-reembed-"));
  await kb(rules, "a-big", "# A\n\n## One\n\nalpha one\n\n## Two\n\nalpha two\n", "old");
  await kb(rules, "b-index", "# B\n\nalpha b\n", "m1");
  writeFileSync(join(rules, "b-index", "index.json"), readFileSync(join(rules, "b-index", "index.json"), "utf8") + " ");
  await kb(rules, "c-old", "# C\n\nalpha c\n", "old");
  let result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: rules }], embedder: now, maxEntries: 1, claim: ({ kbId }) => (kbId === "c-old" ? undefined : () => undefined) });
  assert.deepEqual(result, { deferred: 1 }, "a claimed-out KB is left for later, and nothing else qualifies");
  result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: rules }], embedder: now, maxEntries: 1 });
  assert.equal(result.reembedded?.kbId, "c-old");
  assert.equal(modelOf(rules, "c-old"), "m1");
  assert.deepEqual(await reembedStaleKnowledgebase({ kbDirs: [{ dir: rules }], embedder: now, maxEntries: 1 }), { deferred: 0 }, "nothing left under the limit");
  assert.equal((await reembedStaleKnowledgebase({ kbDirs: [{ dir: rules }], embedder: now })).reembedded?.kbId, "a-big", "a-big within the default limit");
  assert.deepEqual(await reembedStaleKnowledgebase({ kbDirs: [{ dir: rules }], embedder: now }), { deferred: 0 }, "a KB whose index changed under this model is left for kb ingest");
  // A failed attempt keeps the stale vectors and waits before trying again (#151 review).
  const failing2 = mkdtempSync(join(tmpdir(), "kbvec-reembed-fail-"));
  await kb(failing2, "f-kb", "# F\n\nalpha f\n", "old");
  const down = { id: "stub", model: "m1", async embedTexts() { throw new Error("down"); } } as any;
  result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: failing2 }], embedder: down });
  assert.equal(result.reembedded?.vectors.state, "missing");
  assert.equal(modelOf(failing2, "f-kb"), "old", "a failed re-embed keeps the old vectors");
  assert.deepEqual(await reembedStaleKnowledgebase({ kbDirs: [{ dir: failing2 }], embedder: now }), { deferred: 1 }, "not tried again at once");
  // Retries double, and after five failures the KB is given up on for that model: not deferred any more (#156 review).
  const realNow = Date.now;
  try {
    let clock = realNow();
    Date.now = () => clock;
    let last: any;
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      clock += 24 * 3600_000;
      last = await reembedStaleKnowledgebase({ kbDirs: [{ dir: failing2 }], embedder: down });
      assert.equal(last.reembedded?.vectors.state, "missing", `attempt ${attempt} must run`);
    }
    assert.equal(last.reembedded?.gaveUp, true, "the fifth failure gives up");
    clock += 365 * 24 * 3600_000;
    assert.deepEqual(await reembedStaleKnowledgebase({ kbDirs: [{ dir: failing2 }], embedder: now }), { deferred: 0 }, "a given-up KB is neither tried nor counted as waiting");
  } finally {
    Date.now = realNow;
  }
  // An ingest that finishes while a re-embed runs keeps its own vectors.
  const race = mkdtempSync(join(tmpdir(), "kbvec-reembed-race-"));
  await kb(race, "e-race", "# E\n\nalpha e\n", "old");
  const racing = {
    ...fixed({ alpha: [1, 0, 0] }), model: "m1",
    async embedTexts(texts: string[]) {
      writeFileSync(join(race, "e-race", "index.json"), readFileSync(join(race, "e-race", "index.json"), "utf8") + "\n");
      return texts.map(() => [1, 0, 0]);
    },
  } as any;
  const beforeRace = readFileSync(join(race, "e-race", KB_VECTORS_FILE), "utf8");
  result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: race }], embedder: racing });
  assert.match((result.reembedded?.vectors as any).reason ?? "", /index changed while/);
  assert.equal(readFileSync(join(race, "e-race", KB_VECTORS_FILE), "utf8"), beforeRace, "vectors made from an index replaced meanwhile are not written");
  assert.equal((result.reembedded?.vectors as any).superseded, true);
  assert.equal((await reembedStaleKnowledgebase({ kbDirs: [{ dir: race }], embedder: now })).reembedded?.kbId, "e-race", "an overtaken attempt isn't a failure: tried again at once");
}
// Why an embed stopped, and how far it got (#158): an outage, a 429 or the text refused.
{
  const cdir = mkdtempSync(join(tmpdir(), "kbvec-cause-"));
  const failWith = (error: unknown) => ({ id: "stub", model: "m1", async embedTexts() { throw error; } }) as any;
  for (const [error, cause] of [
    [Object.assign(new Error("x"), { status: 429 }), "rate-limited"],
    [Object.assign(new Error("x"), { status: 503 }), "unavailable"],
    [Object.assign(new Error("x"), { status: 401 }), "unavailable"],
    [Object.assign(new Error("x"), { status: 400 }), "rejected"],
    [Object.assign(new TypeError("fetch failed"), { unavailable: true }), "unavailable"],
    [new TypeError("x is null"), "rejected"],
    [Object.assign(new Error("no key"), { unavailable: true }), "unavailable"],
    [new Error("odd"), "rejected"],
  ] as const) {
    const result = await writeKbVectors({ kbDir: cdir, kbId: "k", entries, indexText, embedder: failWith(error) }) as any;
    assert.deepEqual([result.cause, result.embedded], [cause, 0], `${(error as Error).message} ${(error as any).status ?? ""}`);
  }
  let calls = 0;
  const partial = { id: "stub", model: "m1", async embedTexts(texts: string[]) { if (calls++ >= 1) throw Object.assign(new TypeError("fetch failed"), { unavailable: true }); return texts.map(() => [1, 0, 0]); } } as any;
  const partly = await writeKbVectors({ kbDir: cdir, kbId: "k", entries, indexText, embedder: partial, batchSize: 1 }) as any;
  assert.deepEqual([partly.cause, partly.embedded], ["unavailable", 1], "an outage after one entry says so");
  const zeroed = await writeKbVectors({ kbDir: cdir, kbId: "k", entries, indexText, embedder: { id: "stub", model: "m1", async embedTexts(texts: string[]) { return texts.map(() => [0, 0, 0]); } } as any }) as any;
  assert.equal(zeroed.cause, "rejected", "a zero vector is the text's");
  const limited = await writeKbVectors({ kbDir: cdir, kbId: "k", entries, indexText, embedder: failWith(Object.assign(new Error("x"), { status: 429 })) }) as any;
  assert.match(limited.reason, /limiting requests/);
}
// The provider carries the HTTP status on its error, JSON or not (#158).
{
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.includes("limited")) { res.writeHead(429, { "content-type": "application/json" }); res.end('{"error":{"message":"slow down"}}'); return; }
      res.writeHead(502, { "content-type": "text/html" }); res.end("<html>bad gateway</html>");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    for (const [path, status, message] of [["limited", 429, /slow down/], ["proxy", 502, /HTTP 502/]] as const) {
      const provider = createMemoryEmbeddingProvider(undefined, { MINDSTONE_EMBEDDING_PROVIDER: "ollama:m1", EMBEDDER_BASE_URL: `http://127.0.0.1:${port}/${path}` } as any)!;
      const error = await provider.embedTexts(["x"]).then(() => undefined, (e) => e);
      assert.equal(error?.status, status, `${path}: ${error?.message}`);
      assert.match(error.message, message);
    }
  } finally {
    server.close();
  }
}
// Paused time never counts against the budget (#158, N6).
{
  const pdir = mkdtempSync(join(tmpdir(), "kbvec-paused-"));
  let first = true;
  // An embedder that takes 50 ms: past a spent budget, the timeout would win the race.
  const slowish = { id: "stub", model: "m1", async embedTexts(texts: string[]) { await new Promise((resolve) => setTimeout(resolve, 50)); return texts.map(() => [1, 0, 0]); } } as any;
  const paused = await writeKbVectors({
    kbDir: pdir, kbId: "k", entries, indexText, embedder: slowish, batchSize: 1, timeoutMs: 300,
    beforeBatch: async () => { if (first) { first = false; await new Promise((resolve) => setTimeout(resolve, 400)); } },
  });
  assert.equal(paused.state, "ready", "a 400 ms pause under a 300 ms budget still embeds");
}
// A turn running past turnWaitMs no longer holds the re-embed back: it may never end (#158).
{
  const now = 1_000_000_000;
  assert.equal(turnsHoldReembed([], now), false);
  assert.equal(turnsHoldReembed([now - 1000], now), true);
  assert.equal(turnsHoldReembed([now - KB_REEMBED_LIMITS.turnWaitMs], now), false);
  assert.equal(turnsHoldReembed([now - KB_REEMBED_LIMITS.turnWaitMs - 1, now - 5], now), true);
}
// The re-embed's state (#158): kept in the KB, so a restart keeps it; only failures that cost
// something count (exact doubling, N3); an outage or a 429 only waits; another model starts afresh;
// status says so; embedding the KB clears it.
{
  const kb = async (root: string, id: string, text: string, model: string) => {
    mkdirSync(join(root, id, "sources"), { recursive: true });
    writeFileSync(join(root, id, "kb.json"), JSON.stringify({ name: id }));
    writeFileSync(join(root, id, "sources", "a.md"), text);
    await ingestMindStoneKnowledgebase(root, id, { embedder: { ...fixed({ alpha: [1, 0, 0] }), model } as any });
  };
  const failing = (error: () => unknown, model = "m1") => ({ id: "stub", model, calls: 0, async embedTexts() { this.calls += 1; throw error(); } }) as any;
  const working = { ...fixed({ alpha: [1, 0, 0] }), model: "m1" } as any;
  const MIN = 60_000;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    // Refused text: 30, 60, 120, 240 minutes to the minute, then given up; never early.
    const refused = mkdtempSync(join(tmpdir(), "kbvec-state-refused-"));
    await kb(refused, "r-kb", "# R\n\nalpha r\n", "old");
    const bad = failing(() => Object.assign(new Error("x"), { status: 400 }));
    let result: any;
    for (const [attempt, wait] of [[1, 30], [2, 60], [3, 120], [4, 240]] as const) {
      result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: refused }], embedder: bad });
      assert.equal(result.reembedded?.kbId, "r-kb", `attempt ${attempt} runs`);
      const state = readKbReembedState(join(refused, "r-kb"))!;
      assert.deepEqual([state.failures, Date.parse(state.nextAttemptAt!) - clock], [attempt, wait * MIN], `after failure ${attempt}, ${wait} minutes`);
      clock += wait * MIN - 1;
      const calls = bad.calls;
      assert.deepEqual(await reembedStaleKnowledgebase({ kbDirs: [{ dir: refused }], embedder: bad }), { deferred: 1 }, `not a millisecond early (${attempt})`);
      assert.equal(bad.calls, calls, "waiting sends nothing");
      clock += 1;
    }
    result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: refused }], embedder: bad });
    assert.equal(result.reembedded?.gaveUp, true, "the fifth failure gives up");
    const given = readKbReembedState(join(refused, "r-kb"))!;
    assert.deepEqual([given.gaveUp, given.failures, given.nextAttemptAt, given.spec], [true, 5, undefined, "stub:m1"], "the give-up is in the file, for a restart");
    const status = mindStoneKbStatus(refused, "r-kb", { embedder: working }) as any;
    assert.equal(status.vectors.reembed?.gaveUp, true);
    assert.match(status.vectors.reason, /stopped embedding it again after 5 failures/);
    assert.doesNotMatch(status.vectors.reason, /also embedded again after an owner's chat/);
    // Another model starts afresh (b -> c -> b): its attempt runs, and its own state replaces the old one.
    const other = failing(() => Object.assign(new Error("x"), { status: 400 }), "m2");
    assert.equal((await reembedStaleKnowledgebase({ kbDirs: [{ dir: refused }], embedder: other })).reembedded?.kbId, "r-kb", "another model's give-up doesn't apply");
    assert.equal(readKbReembedState(join(refused, "r-kb"))!.spec, "stub:m2");
    assert.equal((await reembedStaleKnowledgebase({ kbDirs: [{ dir: refused }], embedder: working })).reembedded?.vectors.state, "ready", "back on m1: tried again, and embedded");
    assert.ok(!existsSync(join(refused, "r-kb", KB_REEMBED_STATE_FILE)), "embedding the KB clears the state");
    // An embedder that can't be reached, or limits requests, never gives up: 30 minutes each time.
    for (const [name, error] of [["down", () => Object.assign(new TypeError("fetch failed"), { unavailable: true })], ["limited", () => Object.assign(new Error("x"), { status: 429 })]] as const) {
      const root = mkdtempSync(join(tmpdir(), `kbvec-state-${name}-`));
      await kb(root, "o-kb", "# O\n\nalpha o\n", "old");
      const embedder = failing(error);
      for (let attempt = 1; attempt <= 7; attempt += 1) {
        result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: root }], embedder, rateLimit: { minMs: 1, maxMs: 1, maxWaits: 1, maxTotalMs: 10 } });
        assert.ok(result.reembedded && !result.reembedded.gaveUp, `${name}: attempt ${attempt} runs and doesn't give up`);
        const state = readKbReembedState(join(root, "o-kb"))!;
        assert.deepEqual([state.failures, Date.parse(state.nextAttemptAt!) - clock], [0, 30 * MIN], `${name}: nothing counted`);
        clock += 30 * MIN;
      }
      assert.equal((mindStoneKbStatus(root, "o-kb", { embedder: working }) as any).vectors.reembed?.failures, 0);
    }
    // An outage after some entries were embedded cost something, so it counts.
    const spent = mkdtempSync(join(tmpdir(), "kbvec-state-spent-"));
    await kb(spent, "s-kb", "# S\n\n## One\n\nalpha one\n\n## Two\n\nalpha two\n", "old");
    let calls = 0;
    const halfway = { id: "stub", model: "m1", async embedTexts(texts: string[]) { if (calls++ >= 1) throw Object.assign(new TypeError("fetch failed"), { unavailable: true }); return texts.map(() => [1, 0, 0]); } } as any;
    await reembedStaleKnowledgebase({ kbDirs: [{ dir: spent }], embedder: halfway });
    assert.equal(readKbReembedState(join(spent, "s-kb"))!.failures, 1, "an outage after an entry counts");
  } finally {
    Date.now = realNow;
  }
}
// #158 review, round 2.
{
  const kb = async (root: string, id: string, text: string, model: string) => {
    mkdirSync(join(root, id, "sources"), { recursive: true });
    writeFileSync(join(root, id, "kb.json"), JSON.stringify({ name: id }));
    writeFileSync(join(root, id, "sources", "a.md"), text);
    await ingestMindStoneKnowledgebase(root, id, { embedder: { ...fixed({ alpha: [1, 0, 0] }), model } as any });
  };
  const two = "# T\n\n## One\n\nalpha one\n\n## Two\n\nalpha two\n";
  const quick = { minMs: 1, maxMs: 5, maxWaits: 2, maxTotalMs: 1000 };
  const limited = () => Object.assign(new Error("x"), { status: 429 });
  // A 429 pauses and the same entry is sent again: the KB is embedded, the wait off the budget.
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r2-pause-"));
    await kb(root, "p-kb", two, "old");
    let calls = 0;
    let gates = 0;
    const once = { id: "stub", model: "m1", async embedTexts(texts: string[]) { calls += 1; if (calls === 2) throw Object.assign(limited(), { retryAfterMs: 3 }); return texts.map(() => [1, 0, 0]); } } as any;
    const done = await reembedStaleKnowledgebase({ kbDirs: [{ dir: root }], embedder: once, rateLimit: quick, beforeBatch: async () => { gates += 1; } });
    assert.equal(done.reembedded?.vectors.state, "ready", "a 429 is a pause, then the entry again");
    assert.equal(calls, 3, "two entries, one sent twice");
    assert.equal(gates, 3, "the resend waits for turns like every request");
  }
  // A 429 wait: Retry-After honoured and capped, off the budget, up to maxWaits in a row, and
  // at most maxTotalMs in all per run, so a rate limit can't hold the job for days.
  {
    const run = async (name: string, script: (call: number) => unknown, rateLimit: any, timeoutMs?: number) => {
      const dir = mkdtempSync(join(tmpdir(), `kbvec-r3-${name}-`));
      let calls = 0;
      // 20 ms an answer: past a spent budget, the timeout would win the race (a microtask never loses).
      const embedder = { id: "stub", model: "m1", async embedTexts(texts: string[]) { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); const error = script(calls); if (error) throw error; return texts.map(() => [1, 0, 0]); } } as any;
      const started = Date.now();
      const result = await writeKbVectors({ kbDir: dir, kbId: "k", entries, indexText, embedder, batchSize: 1, rateLimit, ...(timeoutMs ? { timeoutMs } : {}) }) as any;
      return { result, calls, ms: Date.now() - started };
    };
    const once = (retryAfterMs: number) => (call: number) => (call === 1 ? Object.assign(limited(), { retryAfterMs }) : undefined);
    const honoured = await run("honoured", once(80), { minMs: 1, maxMs: 1000, maxWaits: 1, maxTotalMs: 5000 });
    assert.ok(honoured.result.state === "ready" && honoured.ms >= 75, `Retry-After honoured: ${honoured.ms} ms`);
    const capped = await run("capped", once(5000), { minMs: 1, maxMs: 40, maxWaits: 1, maxTotalMs: 5000 });
    assert.ok(capped.result.state === "ready" && capped.ms < 1000, `Retry-After capped at maxMs: ${capped.ms} ms`);
    // Three 20 ms calls fit a 100 ms budget; with the 150 ms wait counted too, they wouldn't.
    const offBudget = await run("budget", once(150), { minMs: 150, maxMs: 1000, maxWaits: 1, maxTotalMs: 5000 }, 100);
    assert.equal(offBudget.result.state, "ready", "a 429 wait longer than the budget doesn't spend it");
    const twice = await run("twice", (call) => (call <= 2 ? limited() : undefined), { minMs: 1, maxMs: 1, maxWaits: 2, maxTotalMs: 5000 });
    assert.equal(twice.result.state, "ready", "two 429s in a row, within maxWaits");
    const always = await run("total", () => limited(), { minMs: 5, maxMs: 5, maxWaits: 5, maxTotalMs: 12 });
    assert.deepEqual([always.result.cause, always.calls], ["rate-limited", 3], "stopped once 12 ms of waiting in all is spent (two 5 ms waits)");
  }
  // A 429 after entries were embedded, past the waits, counts: the work is lost.
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r2-429late-"));
    await kb(root, "l-kb", two, "old");
    let calls = 0;
    const late = { id: "stub", model: "m1", async embedTexts(texts: string[]) { calls += 1; if (calls > 1) throw limited(); return texts.map(() => [1, 0, 0]); } } as any;
    const result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: root }], embedder: late, rateLimit: quick }) as any;
    assert.deepEqual([result.reembedded?.vectors.cause, result.reembedded?.vectors.embedded], ["rate-limited", 1]);
    assert.equal(readKbReembedState(join(root, "l-kb"))!.failures, 1, "a 429 after an entry counts");
  }
  // Vectors that couldn't be written, after the embedding was done, count (a read-only folder).
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r2-ro-"));
    await kb(root, "w-kb", two, "old");
    execFileSync("chmod", ["555", join(root, "w-kb")]);
    try {
      const result = await reembedStaleKnowledgebase({ kbDirs: [{ dir: root }], embedder: { ...fixed({ alpha: [1, 0, 0] }), model: "m1" } as any }) as any;
      assert.match(result.reembedded?.vectors.reason ?? "", /could not be written/);
      assert.equal(reembedState(join(root, "w-kb"), "stub:m1")?.failures, 1, "a write that failed after the embedding counts (kept in memory, the folder is read-only)");
    } finally {
      execFileSync("chmod", ["755", join(root, "w-kb")]);
    }
  }
  // A give-up for a model no longer applies once the KB is embedded for it some other way.
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r2-other-"));
    await kb(root, "o-kb", "# O\n\nalpha o\n", "m1");
    assert.ok(writeKbReembedState(join(root, "o-kb"), { version: 1, spec: "stub:m1", failures: 5, gaveUp: true, updatedAt: new Date().toISOString() }));
    assert.deepEqual(await reembedStaleKnowledgebase({ kbDirs: [{ dir: root }], embedder: { ...fixed({ alpha: [1, 0, 0] }), model: "m1" } as any }), { deferred: 0 });
    assert.ok(!existsSync(join(root, "o-kb", KB_REEMBED_STATE_FILE)), "a scan that finds the KB ready clears an old give-up");
  }
  // An ingest that wins while the re-embed fails leaves no state behind.
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r2-won-"));
    await kb(root, "i-kb", "# I\n\nalpha i\n", "old");
    const losing = { id: "stub", model: "m1", async embedTexts() {
      await ingestMindStoneKnowledgebase(root, "i-kb", { embedder: { ...fixed({ alpha: [1, 0, 0] }), model: "m1" } as any });
      throw Object.assign(new Error("x"), { status: 400 });
    } } as any;
    await reembedStaleKnowledgebase({ kbDirs: [{ dir: root }], embedder: losing });
    assert.ok(!existsSync(join(root, "i-kb", KB_REEMBED_STATE_FILE)), "no state once an ingest embedded it");
  }
  // A folder named reembed.json never costs an ingest its vectors.
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r2-dir-"));
    mkdirSync(join(root, "d-kb", KB_REEMBED_STATE_FILE), { recursive: true });
    await kb(root, "d-kb", "# D\n\nalpha d\n", "m1");
    assert.ok(existsSync(join(root, "d-kb", KB_VECTORS_FILE)), "the ingest kept its vectors");
  }
  // A state with more failures than a give-up takes is a hand edit: not read.
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r3-failures-"));
    writeFileSync(join(root, KB_REEMBED_STATE_FILE), JSON.stringify({ version: 1, spec: "stub:m1", failures: 12, nextAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    assert.equal(readKbReembedState(root), undefined);
  }
  // A private KB's reembed.json can't be a link: read with O_NOFOLLOW, and the KB counts as linked.
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r3-link-"));
    await kb(root, "l-kb", "# L\n\nalpha l\n", "old");
    const target = join(root, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ version: 1, spec: "stub:m1", failures: 5, gaveUp: true, updatedAt: new Date().toISOString() }));
    symlinkSync(target, join(root, "l-kb", KB_REEMBED_STATE_FILE));
    assert.equal(readKbReembedState(join(root, "l-kb"), { noLinks: true }), undefined, "a link isn't followed for a private KB");
    assert.equal(readKbReembedState(join(root, "l-kb"))?.gaveUp, true, "control: the same file read without noLinks");
    assert.ok(privateKnowledgebaseLinkError(root, "l-kb"), "a linked reembed.json makes a private KB linked");
    assert.equal(resetKnowledgebaseReembed(root, "l-kb", { noLinks: true }), false, "a linked private KB isn't reset");
    assert.ok(existsSync(join(root, "l-kb", KB_REEMBED_STATE_FILE)), "and its link is left alone");
  }
  // The wait for turns: a turn that runs holds it, one past turnWaitMs doesn't.
  {
    const starts = new Map<string, number>([["turn", Date.now()]]);
    let done = false;
    const waiting = waitWhileTurnsRun(() => starts.values(), 5).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(done, false, "held while the turn runs");
    starts.delete("turn");
    await waiting;
    starts.set("hung", Date.now() - KB_REEMBED_LIMITS.turnWaitMs - 1);
    await waitWhileTurnsRun(() => starts.values(), 5);
  }
  // A state whose reason has control or direction characters isn't read.
  for (const reason of ["x\u001b[2Jy", "x\u202Ey"]) {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r2-reason-"));
    writeFileSync(join(root, KB_REEMBED_STATE_FILE), JSON.stringify({ version: 1, spec: "stub:m1", failures: 1, nextAttemptAt: new Date().toISOString(), reason, updatedAt: new Date().toISOString() }));
    assert.equal(readKbReembedState(root), undefined, JSON.stringify(reason));
  }
  // The Console sees a state only while the KB is still stale for the model; a scan clears it otherwise.
  {
    const root = mkdtempSync(join(tmpdir(), "kbvec-r2-shown-"));
    await kb(root, "s-kb", "# S\n\nalpha s\n", "old");
    const m1 = { id: "stub", model: "m1" };
    assert.ok(writeKbReembedState(join(root, "s-kb"), { version: 1, spec: "stub:m1", failures: 5, gaveUp: true, updatedAt: new Date().toISOString() }));
    assert.equal(knowledgebaseReembedState(root, "s-kb", m1)?.gaveUp, true, "stale for the model: shown");
    rmSync(join(root, "s-kb", KB_VECTORS_FILE));
    assert.equal(knowledgebaseReembedState(root, "s-kb", m1), undefined, "its vectors gone: not stale for the model, not shown");
    await reembedStaleKnowledgebase({ kbDirs: [{ dir: root }], embedder: { ...fixed({ alpha: [1, 0, 0] }), model: "m1" } as any });
    assert.ok(!existsSync(join(root, "s-kb", KB_REEMBED_STATE_FILE)), "and a scan clears it");
  }
  // The provider: a server it can't reach is marked; a 200 it can't use isn't; a 429's Retry-After is kept.
  {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url?.includes("junk")) { res.writeHead(200, { "content-type": "application/json" }); res.end("null"); return; }
        if (req.url?.includes("dated")) { res.writeHead(429, { "content-type": "application/json", "retry-after": new Date(Date.now() + 3000).toUTCString() }); res.end("{}"); return; }
        res.writeHead(429, { "content-type": "application/json", "retry-after": "2" }); res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const provider = (path: string) => createMemoryEmbeddingProvider(undefined, { MINDSTONE_EMBEDDING_PROVIDER: "ollama:m1", EMBEDDER_BASE_URL: `http://127.0.0.1:${port}/${path}` } as any)!;
    try {
      const limitedError = await provider("limited").embedTexts(["x"]).then(() => undefined, (e) => e);
      assert.equal(limitedError?.retryAfterMs, 2000, "Retry-After, in ms");
      const dated = (await provider("dated").embedTexts(["x"]).then(() => undefined, (e) => e))?.retryAfterMs;
      assert.ok(typeof dated === "number" && dated > 1000 && dated <= 3000, `an HTTP-date Retry-After: ${dated}`);
      const junkDir = mkdtempSync(join(tmpdir(), "kbvec-r2-junk-"));
      const junk = await writeKbVectors({ kbDir: junkDir, kbId: "k", entries, indexText, embedder: provider("junk") }) as any;
      assert.equal(junk.cause, "rejected", "a 200 the provider can't use is the embedder's work, not an outage");
    } finally {
      server.close();
    }
    const closed = createMemoryEmbeddingProvider(undefined, { MINDSTONE_EMBEDDING_PROVIDER: "ollama:m1", EMBEDDER_BASE_URL: `http://127.0.0.1:${port}/v1` } as any)!;
    const unreachable = await writeKbVectors({ kbDir: mkdtempSync(join(tmpdir(), "kbvec-r2-closed-")), kbId: "k", entries, indexText, embedder: closed }) as any;
    assert.equal(unreachable.cause, "unavailable", "a server that isn't there");
  }
}
// Two ingests of one KB: the one whose index was replaced meanwhile keeps nothing and removes nothing (#156 review).
{
  const root = mkdtempSync(join(tmpdir(), "kbvec-ingest-race-"));
  mkdirSync(join(root, "r", "sources"), { recursive: true });
  writeFileSync(join(root, "r", "kb.json"), JSON.stringify({ name: "r" }));
  writeFileSync(join(root, "r", "sources", "a.md"), "# R\n\nalpha r\n");
  await ingestMindStoneKnowledgebase(root, "r", { embedder: fixed({ alpha: [1, 0, 0] }) });
  const kept = readFileSync(join(root, "r", KB_VECTORS_FILE), "utf8");
  const overlapping = {
    ...fixed({ alpha: [0, 1, 0] }),
    async embedTexts(texts: string[]) {
      // Another ingest writes a newer index while this one embeds.
      writeFileSync(join(root, "r", "index.json"), readFileSync(join(root, "r", "index.json"), "utf8") + "\n");
      return texts.map(() => [0, 1, 0]);
    },
  };
  const raced = await ingestMindStoneKnowledgebase(root, "r", { embedder: overlapping as any });
  assert.match((raced as any).vectors.reason ?? "", /index changed while/);
  assert.equal(readFileSync(join(root, "r", KB_VECTORS_FILE), "utf8"), kept, "the ingest overtaken by a newer index writes and removes nothing");
}
// Sections whose headings slug alike get their own ids, and so their own vectors.
{
  const kbRoot = mkdtempSync(join(tmpdir(), "kbvec-dup-"));
  mkdirSync(join(kbRoot, "d", "sources"), { recursive: true });
  writeFileSync(join(kbRoot, "d", "kb.json"), JSON.stringify({ name: "d" }));
  writeFileSync(join(kbRoot, "d", "sources", "a.md"), "# A\n\n## Example\n\nalpha one\n\n## Example\n\nbeta two\n\n## C++\n\nalpha three\n\n## C#\n\nbeta four\n");
  const ingested = await ingestMindStoneKnowledgebase(kbRoot, "d", { embedder: fixed({ alpha: [1, 0, 0], beta: [0, 1, 0] }) });
  assert.ok(ingested.ok);
  const index = JSON.parse(readFileSync(join(kbRoot, "d", "index.json"), "utf8"));
  const ids = index.entries.map((e: any) => e.entryId);
  assert.equal(new Set(ids).size, ids.length, `entry ids must be unique: ${ids}`);
  assert.equal((ingested as any).vectors.count, ids.length, "one vector per entry");
}

// The shared embedder: one request for one text, however many ask at once.
const base = fixed({});
const shared = sharedQueryEmbedder(base as any)!;
await Promise.all([shared.embedTexts(["same"]), shared.embedTexts(["same"]), shared.embedTexts(["other"])]);
assert.equal(base.calls, 2);
await shared.embedTexts(["a", "b"]);
assert.equal(base.calls, 3, "several texts pass straight through");
console.log("unit assertions passed");
TS

# --- 2. End to end ---
python3 - <<'PY'
import json, os, pathlib
data = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone"
def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
def kb(root, kb_id, name, sources):
    write(root / kb_id / "kb.json", json.dumps({"name": name, "version": "0.1.0"}))
    for file, text in sources.items():
        write(root / kb_id / "sources" / file, text)
kb(data / "knowledgebases", "garage", "Garage", {
    "fleet.md": "# Fleet\n\n## Sedan upkeep\n\nSedan tire rotation every 5000 miles.\n\n## Paperwork\n\nRegistration renewal forms.\n",
})
kb(data / "knowledgebases", "pantry", "Pantry", {
    "loaf.md": "# Loaf\n\n## Dough\n\nBake bread in a hot oven.\n",
})
p = data / "personas" / "grower"
write(p / "PERSONA.md", "# grower\n\nA persona for growing things.\n")
kb(p / "knowledgebases", "plots", "Plots", {"plots.md": "# Plots\n\n## Beds\n\nTomato plants want loamy soil.\n"})
config_path = data / "config.json"
config = json.loads(config_path.read_text())
config["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "kbembed"}}
config["session"] = {"mode": "single", "defaultSessionKey": "agent:default:main"}
config["memory"] = {"autoRecall": True}
config.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "KBE_TOKEN"}
config["gateway"]["admin"] = {"tokenEnv": "KBE_ADMIN_TOKEN"}
config["gateway"]["http"] = {"chatCompletions": {"enabled": True}}
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY

set_config() { # set_config <python statements on c>
  CFG_EDIT="$1" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
exec(os.environ["CFG_EDIT"])
p.write_text(json.dumps(c, indent=2) + "\n")
PY
}

# chat_hits <question>: the KB hits of that turn's recall, as "id|recallMode" lines.
chat_hits() {
  ${MS} chat --once "$1" >/dev/null
  QUESTION="$1" node -e '
    const fs = require("node:fs"), path = require("node:path");
    const dir = path.join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "mindstone", "transcripts");
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".jsonl")) files.push(p); } })(dir);
    let last;
    for (const f of files) for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.metadata?.event === "memory_recall_injected" && entry.metadata.query === process.env.QUESTION) last = entry;
    }
    for (const h of last?.metadata?.hits ?? []) console.log(`${h.id}|${h.recallMode ?? "lexical"}`);
  '
}

SEMANTIC="automobile wheels servicing cadence?"
LEXICAL="sedan tire rotation"

# No embedder configured: ingest works, no vectors, status says why.
${MS} kb ingest garage --json > "${TEMP_RUNTIME}/ingest0.json"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!r.ok || r.vectors.state!=="missing" || !/no embedder/.test(r.vectors.reason)) { console.error("no embedder must leave vectors missing", JSON.stringify(r.vectors)); process.exit(1); }' "${TEMP_RUNTIME}/ingest0.json"
[[ ! -e "${DATA}/knowledgebases/garage/vectors.json" ]] || { echo "vectors.json written with no embedder" >&2; exit 1; }
if chat_hits "${SEMANTIC}" | grep -q 'kb:garage'; then echo "a KB with no vectors was recalled by meaning" >&2; exit 1; fi

# With the stub embedder: every entry embedded, the file says with what.
set_config 'c["memory"]["embeddingProvider"] = "ollama:kbstub-a"'
stub_mode ok
${MS} kb ingest garage --json > "${TEMP_RUNTIME}/ingest1.json"
${MS} kb ingest pantry --json >/dev/null
node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const v = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const index = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (r.vectors.state !== "ready" || r.vectors.dimension !== 6 || r.vectors.count !== index.entries.length) { console.error("ingest vectors:", JSON.stringify(r.vectors)); process.exit(1); }
if (v.provider !== "ollama" || v.model !== "kbstub-a" || v.dimension !== 6) { console.error("vectors.json header:", v.provider, v.model, v.dimension); process.exit(1); }
if (Object.keys(v.vectors).length !== index.entries.length) { console.error("not every entry embedded"); process.exit(1); }
' "${TEMP_RUNTIME}/ingest1.json" "${DATA}/knowledgebases/garage/vectors.json" "${DATA}/knowledgebases/garage/index.json"
${MS} kb status garage --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d); if (s.vectors.state!=="ready") { console.error("status after ingest:", JSON.stringify(s.vectors)); process.exit(1); }})'
${MS} kb status garage | grep -q "vectors: ready (ollama:kbstub-a, 6 dimensions" || { echo "kb status must show the vectors" >&2; exit 1; }
# --embed-timeout: <seconds> or =<seconds>, a whole number 1 to 86400; anything else is refused, never ignored.
for bad in "--embed-timeout" "--embed-timeout --json" "--embed-timeout 0" "--embed-timeout 0.5" "--embed-timeout=abc" "--embed-timeout 300 --embed-timeout=abc"; do
  # shellcheck disable=SC2086
  if out="$(${MS} kb ingest garage ${bad} 2>&1)"; then echo "kb ingest accepted ${bad}" >&2; exit 1; fi
  grep -q "whole number of seconds" <<<"${out}" || { echo "kb ingest ${bad}: ${out}" >&2; exit 1; }
done
${MS} kb ingest garage --embed-timeout=300 --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{if (JSON.parse(d).vectors.state!=="ready") process.exit(1);})'
${MS} kb ingest garage --embed-timeout 300 --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{if (JSON.parse(d).vectors.state!=="ready") process.exit(1);})'
# Ingest gives a request 60 s, whatever the query-time EMBEDDER_TIMEOUT_MS (1.5 s here): an embedder slower than that still embeds.
stub_mode slow
${MS} kb ingest pantry --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d); if (r.vectors.state!=="ready") { console.error("slow embedder at ingest:", JSON.stringify(r.vectors)); process.exit(1); }})'
stub_mode ok
# A request timeout that isn't a number falls back to the default, rather than aborting every request.
EMBEDDER_TIMEOUT_MS=abc ${MS} kb ingest garage --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d); if (r.vectors.state!=="ready") { console.error("EMBEDDER_TIMEOUT_MS=abc:", JSON.stringify(r.vectors)); process.exit(1); }})'

# A question sharing no words with the KB recalls it by meaning, and only the
# source that matches; the query is embedded once.
stub_mode ok
hits="$(chat_hits "${SEMANTIC}")"
grep -q '^kb:garage:fleet.md|embedding$' <<<"${hits}" || { echo "semantic question did not recall the KB source: ${hits}" >&2; exit 1; }
if grep -q 'kb:pantry' <<<"${hits}"; then echo "an unrelated KB source was recalled: ${hits}" >&2; exit 1; fi
[[ "$(stub_count "${SEMANTIC}")" == "1" ]] || { echo "query embedded $(stub_count "${SEMANTIC}") times" >&2; exit 1; }
# A request timeout that isn't a number doesn't abort the question's embedding at recall either.
export EMBEDDER_TIMEOUT_MS=abc
hits="$(chat_hits "timeout check: ${SEMANTIC}")"
export EMBEDDER_TIMEOUT_MS=1500
grep -q '^kb:garage:fleet.md|embedding$' <<<"${hits}" || { echo "EMBEDDER_TIMEOUT_MS=abc broke recall by meaning: ${hits}" >&2; exit 1; }

# With the sqlite-vec index too: memory and KB recall share one query embedding.
set_config 'c["memory"]["vectorStore"] = "sqlite-vec"'
${MS} memory backfill --embed >/dev/null
stub_mode ok
Q2="car wheels cadence, again?"
hits="$(chat_hits "${Q2}")"
grep -q '^kb:garage:fleet.md|embedding$' <<<"${hits}" || { echo "sqlite-vec on: KB not recalled by meaning: ${hits}" >&2; exit 1; }
[[ "$(stub_count "${Q2}")" == "1" ]] || { echo "sqlite-vec on: query embedded $(stub_count "${Q2}") times" >&2; exit 1; }
set_config 'c["memory"].pop("vectorStore", None)'

# Embedder down at recall: word match takes over; the turn still runs.
stub_mode fail
hits="$(chat_hits "semantic check while the embedder is down: ${SEMANTIC}")"
if grep -q 'kb:garage' <<<"${hits}"; then echo "embedder down, yet recalled by meaning: ${hits}" >&2; exit 1; fi
hits="$(chat_hits "${LEXICAL}")"
grep -q '^kb:garage:fleet.md|lexical$' <<<"${hits}" || { echo "embedder down: word match must still recall: ${hits}" >&2; exit 1; }

# A query vector of another dimension: the KB's vectors are ignored.
stub_mode dim5
hits="$(chat_hits "dimension check: ${SEMANTIC}")"
if grep -q 'kb:garage' <<<"${hits}"; then echo "vectors of another dimension were used: ${hits}" >&2; exit 1; fi

# Quota: memory that matches every word can't push the KB source out.
stub_mode ok
set_config '
c["memory"]["recall"] = {"maxResults": 2}
c["memory"]["localDocuments"] = [{"id": f"local-{i}", "kind": "custom", "text": f"automobile wheels servicing cadence note {i}"} for i in range(3)]'
hits="$(chat_hits "${SEMANTIC}")"
grep -q '^kb:garage:fleet.md|embedding$' <<<"${hits}" || { echo "quota: KB source pushed out by memory: ${hits}" >&2; exit 1; }
[[ "$(grep -c . <<<"${hits}")" == "2" ]] || { echo "quota: expected 2 hits, got: ${hits}" >&2; exit 1; }
set_config 'c["knowledgebases"] = {"recall": {"maxResults": 0}}'
hits="$(chat_hits "quota off: ${SEMANTIC}")"
if grep -q 'kb:garage' <<<"${hits}"; then echo "maxResults 0 must turn meaning off: ${hits}" >&2; exit 1; fi
[[ "$(stub_count "quota off: ${SEMANTIC}")" == "0" ]] || { echo "maxResults 0 still embedded the question" >&2; exit 1; }
set_config '
c.pop("knowledgebases", None)
c["memory"].pop("recall", None)
c["memory"].pop("localDocuments", None)'

# A source with an entry missing from vectors.json stays on word match.
cp "${DATA}/knowledgebases/garage/vectors.json" "${TEMP_RUNTIME}/garage-vectors.json"
node -e '
const fs = require("fs"); const p = process.argv[1]; const v = JSON.parse(fs.readFileSync(p, "utf8"));
const paperwork = Object.keys(v.vectors).find((id) => id.includes("paperwork"));
if (!paperwork || Object.keys(v.vectors).length < 2) { console.error("fixture: expected a paperwork entry", Object.keys(v.vectors)); process.exit(1); }
delete v.vectors[paperwork]; fs.writeFileSync(p, JSON.stringify(v));' "${DATA}/knowledgebases/garage/vectors.json"
hits="$(chat_hits "partial check: ${SEMANTIC}")"
if grep -q 'kb:garage' <<<"${hits}"; then echo "a partly embedded source was ranked by meaning: ${hits}" >&2; exit 1; fi
cp "${TEMP_RUNTIME}/garage-vectors.json" "${DATA}/knowledgebases/garage/vectors.json"

# Another model: stale, and status says re-ingest; recall ignores the vectors.
set_config 'c["memory"]["embeddingProvider"] = "ollama:kbstub-b"'
${MS} kb status garage --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d); if (s.vectors.state!=="stale" || !/re-ingest/.test(s.vectors.reason)) { console.error("model change:", JSON.stringify(s.vectors)); process.exit(1); }})'
hits="$(chat_hits "model check: ${SEMANTIC}")"
if grep -q 'kb:garage' <<<"${hits}"; then echo "vectors from another model were used: ${hits}" >&2; exit 1; fi
${MS} kb ingest garage --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d); if (r.vectors.state!=="ready") process.exit(1);})'
grep -q '"model":"kbstub-b"' "${DATA}/knowledgebases/garage/vectors.json" || { echo "re-ingest must re-embed with the new model" >&2; exit 1; }

# An index changed after its vectors: stale.
printf ' ' >> "${DATA}/knowledgebases/garage/index.json"
${MS} kb status garage --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d); if (s.vectors.state!=="stale" || !/index changed/.test(s.vectors.reason)) { console.error("index change:", JSON.stringify(s.vectors)); process.exit(1); }})'

# A failed embed at ingest: the index is written, the old vectors removed.
stub_mode fail
${MS} kb ingest garage --json > "${TEMP_RUNTIME}/ingest-fail.json"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!r.ok || r.vectors.state!=="missing" || /stub embedder is down/.test(JSON.stringify(r))) { console.error("failed embed:", JSON.stringify(r.vectors)); process.exit(1); }' "${TEMP_RUNTIME}/ingest-fail.json"
[[ ! -e "${DATA}/knowledgebases/garage/vectors.json" ]] || { echo "old vectors kept after a failed embed" >&2; exit 1; }
${MS} kb status garage --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d); if (s.vectors.state!=="missing") process.exit(1);})'

# A persona's private KB: embedded at ingest, recalled by meaning under its persona.
stub_mode ok
${MS} kb ingest --persona grower plots --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d); if (r.vectors.state!=="ready") { console.error("private ingest:", JSON.stringify(r.vectors)); process.exit(1); }})'
[[ -f "${DATA}/personas/grower/knowledgebases/plots/vectors.json" ]] || { echo "private vectors.json missing" >&2; exit 1; }
set_config 'c["personas"] = {"active": "grower"}'
hits="$(chat_hits "seedling nurturing?")"
grep -q '^pkb:grower:plots:plots.md|embedding$' <<<"${hits}" || { echo "private KB not recalled by meaning: ${hits}" >&2; exit 1; }
${MS} kb status --persona grower plots --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d); if (s.vectors.state!=="ready") process.exit(1);})'

# Under another persona, grower's private KB is never recalled, by meaning or by words.
mkdir -p "${DATA}/personas/other"
printf '# other\n\nAnother persona.\n' > "${DATA}/personas/other/PERSONA.md"
set_config 'c["personas"] = {"active": "other"}'
hits="$(chat_hits "seedling nurturing, other persona?")"
if grep -q 'pkb:grower' <<<"${hits}"; then echo "another persona got grower's private KB: ${hits}" >&2; exit 1; fi
set_config 'c["personas"] = {"active": "grower"}'

# A private vectors.json that is a link: the KB is refused and left out of recall.
mv "${DATA}/personas/grower/knowledgebases/plots/vectors.json" "${TEMP_RUNTIME}/plots-vectors.json"
ln -s "${TEMP_RUNTIME}/plots-vectors.json" "${DATA}/personas/grower/knowledgebases/plots/vectors.json"
if out="$(${MS} kb ingest --persona grower plots 2>&1)"; then echo "ingest through a linked vectors.json must fail" >&2; exit 1; fi
grep -q "vectors.json is a link" <<<"${out}" || { echo "unexpected refusal: ${out}" >&2; exit 1; }
if ${MS} kb status --persona grower plots --json 2>/dev/null | grep -q '"state": "ready"'; then echo "kb status read a private KB's linked vectors.json" >&2; exit 1; fi
hits="$(chat_hits "seedling nurturing, linked?")"
if grep -q 'pkb:grower' <<<"${hits}"; then echo "a private KB with a linked vectors.json was recalled: ${hits}" >&2; exit 1; fi

# --- 3. Through the gateway: an admin ingest embeds, a chat turn recalls by meaning. ---
set_config 'c["memory"]["embeddingProvider"] = "ollama:kbstub-a"; c["memory"]["vectorStore"] = "sqlite-vec"; c["personas"] = {"active": "grower"}'
./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
BASE="http://127.0.0.1:${GATEWAY_PORT}"
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done
ADMIN=(-H "Authorization: Bearer ${KBE_TOKEN}" -H "x-mindstone-admin-token: ${KBE_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
BODY="${TEMP_RUNTIME}/body.json"
call() { curl -s -o "${BODY}" -w '%{http_code}' -X "$1" "${ADMIN[@]}" ${3:+-d "$3"} "${BASE}$2"; }
[[ "$(call POST /admin/personas/grower/knowledgebases '{"id":"beds"}')" == "201" ]] || { echo "create private KB: $(cat "${BODY}")" >&2; exit 1; }
[[ "$(call POST /admin/personas/grower/knowledgebases/beds/sources '{"kind":"text","name":"beds","text":"# Beds\n\nRaised garden beds drain well.\n"}')" == "201" ]] || { echo "add source: $(cat "${BODY}")" >&2; exit 1; }
stub_mode fail
[[ "$(call POST /admin/personas/grower/knowledgebases/beds/ingest '{}')" == "200" ]] || { echo "admin ingest, embedder down: $(cat "${BODY}")" >&2; exit 1; }
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=b.knowledgebase.vectors; if (v.state!=="missing" || /stub embedder is down/.test(JSON.stringify(b))) { console.error("admin ingest, embedder down:", JSON.stringify(b)); process.exit(1); }' "${BODY}"
stub_mode ok
[[ "$(call POST /admin/personas/grower/knowledgebases/beds/ingest '{}')" == "200" ]] || { echo "admin ingest: $(cat "${BODY}")" >&2; exit 1; }
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=b.knowledgebase.vectors; if (v.state!=="ready" || v.dimension!==6 || !(v.count>=1)) { console.error("admin ingest vectors:", JSON.stringify(b)); process.exit(1); }' "${BODY}"
[[ -f "${DATA}/personas/grower/knowledgebases/beds/vectors.json" ]] || { echo "admin ingest wrote no vectors.json" >&2; exit 1; }
stub_mode ok
GQ="seedling nurturing through the gateway?"
code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${KBE_TOKEN}" -H 'content-type: application/json' -d "{\"text\":\"${GQ}\"}" "${BASE}/chat/send")"
[[ "${code}" == "200" ]] || { echo "gateway chat ${code}: $(cat "${BODY}")" >&2; exit 1; }
QUESTION="${GQ}" node -e '
  const fs = require("node:fs"), path = require("node:path");
  const dir = path.join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "mindstone", "transcripts");
  const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".jsonl")) files.push(p); } })(dir);
  let last; for (const f of files) for (const line of fs.readFileSync(f, "utf8").split("\n")) { if (!line.trim()) continue; const e = JSON.parse(line); if (e.metadata?.event === "memory_recall_injected" && e.metadata.query === process.env.QUESTION) last = e; }
  const ids = (last?.metadata?.hits ?? []).filter((h) => h.recallMode === "embedding").map((h) => h.id);
  if (!ids.includes("pkb:grower:beds:beds.md")) { console.error("gateway turn did not recall the private KB by meaning:", JSON.stringify(last?.metadata?.hits)); process.exit(1); }'
[[ "$(stub_count "${GQ}")" == "1" ]] || { echo "gateway: query embedded $(stub_count "${GQ}") times" >&2; exit 1; }

# An agent-proposed private KB is embedded when its card is approved, through the gateway and the CLI.
stub_mode ok
cards="$(MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import { applyActionProposalDiscipline, ApprovalStore } from "./packages/mindstone-core/src/index.ts";
const store = new ApprovalStore();
const ids: string[] = [];
for (const id of ["pa-gateway", "pa-cli"]) {
  const block = { id, name: id, voice: "Plain.", components: { new: { privateKnowledgebases: [{ id: "beds", sources: [{ text: "# Beds\n\nRaised garden beds drain well." }] }] } } };
  const made = applyActionProposalDiscipline({ replyText: "Here.\n```mindstone-persona-proposal\n" + JSON.stringify(block) + "\n```", origin: "smoke", allowPersona: true, store, sessionKey: "smoke:approve" });
  if (made.proposals.length !== 2) throw new Error(`expected a persona card and a KB card for ${id}, got ${made.proposals.length}`);
  ids.push(...made.proposals.map((card) => card.id));
}
console.log(ids.join(" "));
TS
)"
read -r gw_persona gw_kb cli_persona cli_kb <<<"${cards}"
[[ "$(call POST "/admin/approvals/${gw_persona}/approve" '{}')" == "200" ]] || { echo "approve persona: $(cat "${BODY}")" >&2; exit 1; }
# The approve-path ingest embeds outside the admin write lock: another admin write goes through meanwhile.
stub_mode slow
curl -s -o "${TEMP_RUNTIME}/approve-kb.json" -w '%{http_code}' -X POST "${ADMIN[@]}" -d '{}' "${BASE}/admin/approvals/${gw_kb}/approve" > "${TEMP_RUNTIME}/approve-kb.code" &
approve_pid=$!
# Only once the approve is embedding (the stub has its request) does the write below prove anything.
for _ in $(seq 1 50); do
  seen="$(node -e 'fetch(process.argv[1]).then((r)=>r.json()).then((s)=>console.log(s.requests.length))' "${STUB}/_test/state")"
  [[ "${seen}" -gt 0 ]] && break
  sleep 0.1
done
[[ "${seen}" -gt 0 ]] || { echo "the approve never reached the embedder" >&2; exit 1; }
# Its key is held: an admin ingest of the same KB is refused meanwhile.
[[ "$(call POST /admin/personas/pa-gateway/knowledgebases/beds/ingest '{}')" == "409" ]] || { echo "admin ingest during the approve's ingest: $(cat "${BODY}")" >&2; exit 1; }
grep -q ingest_running "${BODY}" || { echo "expected ingest_running: $(cat "${BODY}")" >&2; exit 1; }
started=$(node -e 'console.log(Date.now())')
[[ "$(call POST /admin/personas/grower/knowledgebases '{"id":"meanwhile"}')" == "201" ]] || { echo "admin write during an approve: $(cat "${BODY}")" >&2; exit 1; }
took=$(( $(node -e 'console.log(Date.now())') - started ))
[[ "${took}" -lt 3000 ]] || { echo "an admin write waited ${took} ms behind an approve-path ingest" >&2; exit 1; }
wait "${approve_pid}"
[[ "$(cat "${TEMP_RUNTIME}/approve-kb.code")" == "200" ]] || { echo "approve KB: $(cat "${TEMP_RUNTIME}/approve-kb.json")" >&2; exit 1; }
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (b.result?.ingested?.vectors?.state!=="ready") { console.error("gateway approve-path ingest vectors:", JSON.stringify(b)); process.exit(1); }' "${TEMP_RUNTIME}/approve-kb.json"
stub_mode ok
[[ -f "${DATA}/personas/pa-gateway/knowledgebases/beds/vectors.json" ]] || { echo "the gateway's approved KB has no vectors.json" >&2; exit 1; }
${MS} approvals approve "${cli_persona}" --yes >/dev/null
${MS} approvals approve "${cli_kb}" --yes > "${TEMP_RUNTIME}/cli-approve.txt"
grep -q "vectors: ready" "${TEMP_RUNTIME}/cli-approve.txt" || { echo "CLI approve-path ingest: $(cat "${TEMP_RUNTIME}/cli-approve.txt")" >&2; exit 1; }
[[ -f "${DATA}/personas/pa-cli/knowledgebases/beds/vectors.json" ]] || { echo "the CLI's approved KB has no vectors.json" >&2; exit 1; }

# After a switch of embedding model, an owner's chat through the gateway has a stale KB embedded again (#151).
set_config 'c["memory"]["embeddingProvider"] = "ollama:kbstub-b"'
stub_mode ok
${MS} kb status pantry --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d); if (s.vectors.state!=="stale") { console.error("pantry before the chat:", JSON.stringify(s.vectors)); process.exit(1); }})'
# 20 s at most: a turn never waits for the re-embed (#156 review).
code="$(curl -s --max-time 20 -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${KBE_TOKEN}" -H 'content-type: application/json' -d '{"text":"anything new about the garden?"}' "${BASE}/chat/send")" || true
[[ "${code}" == "200" ]] || { echo "gateway chat after the switch ${code} (000: no answer in 20 s): $(cat "${BODY}")" >&2; exit 1; }
for _ in $(seq 1 40); do
  grep -q '"model":"kbstub-b"' "${DATA}/knowledgebases/pantry/vectors.json" 2>/dev/null && break
  sleep 0.5
done
grep -q '"model":"kbstub-b"' "${DATA}/knowledgebases/pantry/vectors.json" || { echo "the stale KB was not embedded again after the owner's chat" >&2; exit 1; }
${MS} kb status pantry --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d); if (s.vectors.state!=="ready") { console.error("pantry after the chat:", JSON.stringify(s.vectors)); process.exit(1); }})'

# A background re-embed never slows the owner's turns, even with a one-at-a-time embedder (#156 review),
# and only an owner's chat starts one.
python3 - <<'PY'
import json, os, pathlib
root = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "knowledgebases" / "library"
(root / "sources").mkdir(parents=True, exist_ok=True)
(root / "kb.json").write_text(json.dumps({"name": "Library", "version": "0.1.0"}))
(root / "sources" / "shelves.md").write_text("# Shelves\n\n" + "".join(f"## Shelf {i}\n\nBook row {i} holds bound volumes.\n\n" for i in range(40)))
PY
stub_mode ok
${MS} kb ingest library --json >/dev/null
chat_ms() { # chat_ms <text> [role]: prints "<start ms> <end ms>" of one gateway chat
  local started ended role="${2:-}"
  : > "${BODY}" # a check on the body never reads an earlier chat's
  started=$(node -e 'console.log(Date.now())')
  if [[ -n "${role}" ]]; then
    # A Console user's turn, as the Console sends it: the OpenAI endpoint with the user's role.
    curl -s --max-time 20 -o "${BODY}" -X POST -H "Authorization: Bearer ${KBE_TOKEN}" -H "x-mindstone-user-role: ${role}" -H "x-mindstone-user-id: smoke-${role}" -H 'content-type: application/json' -d "{\"model\":\"mindstone/default\",\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" "${BASE}/v1/chat/completions" || { echo "chat \"$1\" failed or got no answer in 20 s" >&2; exit 1; }
  else
    curl -s --max-time 20 -o "${BODY}" -X POST -H "Authorization: Bearer ${KBE_TOKEN}" -H 'content-type: application/json' -d "{\"text\":\"$1\"}" "${BASE}/chat/send" || { echo "chat \"$1\" failed or got no answer in 20 s" >&2; exit 1; }
  fi
  ended=$(node -e 'console.log(Date.now())')
  echo "${started} ${ended}"
}
# library_requests_between <from ms> <to ms>: how many library entries the stub was sent in that window.
library_requests_between() { node -e 'fetch(process.argv[1]).then((r)=>r.json()).then((s)=>console.log(s.requests.filter((q)=>q.input.some((t)=>t.includes("Book row")) && q.t > Number(process.argv[2]) && q.t < Number(process.argv[3])).length))' "${STUB}/_test/state" "$1" "$2"; }
# Memory's own backfill after a model switch (#140) isn't this PR's: without the sqlite-vec index only the KB re-embed runs.
set_config 'c["memory"].pop("vectorStore", None)'
stub_mode serial
set_config 'c["memory"]["embeddingProvider"] = "ollama:kbstub-c"'
# A KB already embedded with the new model, so each turn embeds its question as a real install does.
python3 - <<'PY2'
import json, os, pathlib
root = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "knowledgebases" / "atlas"
(root / "sources").mkdir(parents=True, exist_ok=True)
(root / "kb.json").write_text(json.dumps({"name": "Atlas", "version": "0.1.0"}))
(root / "sources" / "maps.md").write_text("# Maps\n\n## Coast\n\nCoastal charts of the bay.\n")
PY2
${MS} kb ingest atlas --json >/dev/null
read -r member_start member_end <<<"$(chat_ms "a member's question after the switch" member)"
grep -q '"choices"' "${BODY}" || { echo "the member's chat didn't run: $(cat "${BODY}")" >&2; exit 1; }
sleep 3
[[ "$(library_requests_between "${member_start}" "$(node -e 'console.log(Date.now())')")" == "0" ]] || { echo "a non-owner chat started a re-embed" >&2; exit 1; }
chat_ms "the owner's first question after the switch" >/dev/null
sleep 1
for i in 1 2 3; do chat_ms "owner question ${i} during the re-embed" >/dev/null; sleep 0.5; done
grep -q '"model":"kbstub-c"' "${DATA}/knowledgebases/library/vectors.json" && { echo "the re-embed finished before the timed chats: nothing was measured" >&2; exit 1; }
# Each owner turn's query embedding, as the stub saw it: no library entry is sent while it waits,
# and it waits behind one entry at most (150 ms here, so 300 ms with its own), not a batch.
node -e 'fetch(process.argv[1]).then((r)=>r.json()).then((s)=>{
  const library = s.requests.filter((q)=>q.input.some((t)=>t.includes("Book row")));
  const queries = s.requests.filter((q)=>q.input.some((t)=>t.includes("during the re-embed")));
  const batched = library.filter((l)=>l.input.length > 1).length;
  if (batched) { console.error(`the re-embed sent ${batched} requests of more than one entry`); process.exit(1); }
  if (queries.length !== 3) { console.error(`expected 3 owner query embeddings, saw ${queries.length}`); process.exit(1); }
  // The re-embed was running throughout: an entry before the first query and between each two.
  const bounds = [0, ...queries.map((q)=>q.t)];
  for (let i = 1; i < bounds.length; i += 1) {
    if (!library.some((l)=>l.t > bounds[i - 1] && l.t < bounds[i])) { console.error(`the re-embed sent nothing before owner query ${i}: nothing was measured`); process.exit(1); }
  }
  for (const q of queries) {
    if (!(q.done >= q.t)) { console.error("an owner query embedding was never answered"); process.exit(1); }
    const sent = library.filter((l)=>l.t > q.t && l.t < q.done).length;
    if (sent) { console.error(`the re-embed sent ${sent} entries while an owner turn waited on the embedder`); process.exit(1); }
    if (q.done - q.t > 450) { console.error(`an owner turn waited ${q.done - q.t} ms behind the re-embed`); process.exit(1); }
  }
})' "${STUB}/_test/state" || exit 1
[[ "$(library_requests_between 0 "$(node -e 'console.log(Date.now())')")" -gt 0 ]] || { echo "no re-embed request was seen at all" >&2; exit 1; }
for _ in $(seq 1 120); do grep -q '"model":"kbstub-c"' "${DATA}/knowledgebases/library/vectors.json" && break; sleep 0.5; done
grep -q '"model":"kbstub-c"' "${DATA}/knowledgebases/library/vectors.json" || { echo "the library KB was never embedded again" >&2; exit 1; }
grep -q '"action":"kb_reembedded"' "${DATA}/admin/audit.jsonl" || { echo "the re-embed left no audit entry" >&2; exit 1; }
# The admin API's KB list shows a KB the gateway is still trying to embed again (#158): an embedder
# that is down costs nothing, so nothing counts, and it says when it tries next.
set_config 'c["memory"]["embeddingProvider"] = "ollama:kbstub-d"'
stub_mode fail
chat_ms "an owner question while the embedder is down" >/dev/null
for _ in $(seq 1 60); do grep -q '"cause":"unavailable"' "${DATA}/admin/audit.jsonl" && break; sleep 0.5; done
grep -q '"cause":"unavailable"' "${DATA}/admin/audit.jsonl" || { echo "no re-embed attempt recorded its cause" >&2; exit 1; }
[[ "$(call GET /admin/knowledgebases)" == 200 ]] || { echo "admin KB list: $(cat "${BODY}")" >&2; exit 1; }
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const kbs=(b.knowledgebases??[]).filter((k)=>k.reembed); if (kbs.length !== 1 || kbs[0].reembed.failures !== 0 || !kbs[0].reembed.nextAttemptAt || kbs[0].reembed.gaveUp) { console.error("the admin KB list should show one KB waiting to be embedded again: " + JSON.stringify(b.knowledgebases)); process.exit(1); }' "${BODY}"
# The Console's retry (#158 review): resetting clears it, so the next owner chat tries again.
WAITING="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(b.knowledgebases.find((k)=>k.reembed).id)' "${BODY}")"
[[ "$(call POST "/admin/knowledgebases/${WAITING}/reembed" '{}')" == 200 ]] || { echo "reset ${WAITING}: $(cat "${BODY}")" >&2; exit 1; }
[[ "$(call GET /admin/knowledgebases)" == 200 ]] || exit 1
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if ((b.knowledgebases??[]).some((k)=>k.reembed)) { console.error("a reset KB still shows its state: " + JSON.stringify(b.knowledgebases)); process.exit(1); }' "${BODY}"
grep -q '"action":"kb_reembed_reset"' "${DATA}/admin/audit.jsonl" || { echo "the reset wasn't audited" >&2; exit 1; }
[[ "$(call POST /admin/knowledgebases/no-such-kb/reembed '{}')" == 404 ]] || { echo "resetting a KB that doesn't exist: $(cat "${BODY}")" >&2; exit 1; }
# A persona's KB: a reembed.json that is a link isn't read for its list; a real one is, and resets.
SPEC="$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map((x)=>JSON.parse(x)).filter((e)=>e.action==="kb_reembedded"); process.stdout.write(l.pop().embeddingProvider)' "${DATA}/admin/audit.jsonl")"
BEDS="${DATA}/personas/grower/knowledgebases/beds"
SPEC="${SPEC}" node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ version: 1, spec: process.env.SPEC, failures: 5, gaveUp: true, reason: "synthetic", updatedAt: new Date().toISOString() }))' "${TEMP_RUNTIME}/state-elsewhere.json"
ln -s "${TEMP_RUNTIME}/state-elsewhere.json" "${BEDS}/reembed.json"
[[ "$(call GET /admin/personas/grower/knowledgebases)" == 200 ]] || { echo "private KB list: $(cat "${BODY}")" >&2; exit 1; }
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if ((b.knowledgebases??[]).some((k)=>k.reembed)) { console.error("a linked reembed.json was read for a persona KB: " + JSON.stringify(b.knowledgebases)); process.exit(1); }' "${BODY}"
[[ "$(call GET /admin/personas/grower)" == 200 ]] || { echo "persona detail: $(cat "${BODY}")" >&2; exit 1; }
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if ((b.persona?.privateKnowledgebases??[]).some((k)=>k.reembed)) { console.error("a linked reembed.json was read for the persona detail: " + JSON.stringify(b.persona?.privateKnowledgebases)); process.exit(1); }' "${BODY}"
rm "${BEDS}/reembed.json" && cp "${TEMP_RUNTIME}/state-elsewhere.json" "${BEDS}/reembed.json"
[[ "$(call GET /admin/personas/grower/knowledgebases)" == 200 ]] || exit 1
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const p=(b.knowledgebases??[]).find((k)=>k.id==="beds"); if (!p?.reembed?.gaveUp) { console.error("control: a real reembed.json should show: " + JSON.stringify(b.knowledgebases)); process.exit(1); }' "${BODY}"
[[ "$(call POST /admin/personas/grower/knowledgebases/beds/reembed '{}')" == 200 ]] || { echo "reset beds: $(cat "${BODY}")" >&2; exit 1; }
[[ ! -e "${BEDS}/reembed.json" ]] || { echo "the private reset left the state" >&2; exit 1; }
stub_mode ok

echo "KB embeddings smoke test passed."
