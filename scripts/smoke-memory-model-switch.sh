#!/usr/bin/env bash
# Changing the embedding model after memories are indexed (#140). Each chunk
# records the model that embedded it (`<provider id>:<model>`):
#   - recall compares a query only with chunks the same model embedded; chunks
#     another model embedded (another size or the same size), or embedded
#     before this was recorded, are found by their words until re-embedded
#   - a vector of another size never scores, whatever it is recorded as
#   - the next backfill (the per-turn one included) embeds them again and
#     records the model; re-indexing keeps each vector's model with it
#   - POST /admin/memory/check says how many memories another model embedded
#   - the gateway paces that per-turn share: a few chunks a request, none sent
#     while a turn runs, and off the index update the next turn waits for (#157)
# Binds gateway port base+39 and an embedding stub on base+40; serialize per
# smoke protocol. Synthetic text only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-model-switch-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 39))"
STUB_PORT="$((SMOKE_PORT_BASE + 40))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${stub_pid:-}" ]]; then kill "${stub_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export MS_TOKEN="model-switch-smoke-service-token"
export MS_ADMIN_TOKEN="model-switch-smoke-admin-token"
export EMBEDDER_BASE_URL="http://127.0.0.1:${STUB_PORT}/v1"
cd "${PROJECT_ROOT}"
echo "== Memory embedding model switch smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
mkdir -p "${DATA}/memory"
printf '# Harbour\n\nThe harbour lighthouse call sign is SYNTH-LH-140.\n' > "${DATA}/memory/harbour.md"
printf '# Garden\n\nTomatoes grow along the south fence.\n' > "${DATA}/memory/garden.md"

# --- 1. The recall index, directly: models A (3 numbers), B (4) and C (3, a different model).
npx tsx - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_EMBED_PROBE_TEXT,
  MEMORY_EMBED_REFUSAL_SPACING_MS,
  MEMORY_EMBED_SINGLES_PER_RUN,
  MEMORY_EMBED_SKIP_RETRY_MS,
  MEMORY_EMBED_SKIP_AFTER,
  MEMORY_REEMBED_BATCH,
  maintainSqliteMemoryIndex,
  embeddingFailureCause,
  MEMORY_REEMBED_PER_TURN,
  indexSqliteMemoryTurn,
  reembedSqliteMemoryOtherModel,
  backfillSqliteMemoryEmbeddings,
  backfillSqliteMemoryIndex,
  memoryEmbeddingSpec,
  runtimePathsFromEnv,
  sqliteMemoryDatabasePath,
  sqliteMemoryEmbeddingMix,
  SqliteMemoryRecallProvider,
} from "./packages/mindstone-core/src/index.ts";

const fail = (message: string): never => { console.error(message); process.exit(1); };
const paths = runtimePathsFromEnv();
const dbPath = sqliteMemoryDatabasePath(paths);
// A vector that points one way for the lighthouse and another for anything else: a comparison
// across models would find the lighthouse with a perfect score.
const stub = (model: string, size: number) => ({
  id: "stub",
  model,
  async embedTexts(texts: string[]) {
    return texts.map((text) => {
      const v = new Array(size).fill(0);
      v[/lighthouse/i.test(text) ? 0 : /zebraword/i.test(text) ? 2 : /biscuit/i.test(text) && size > 3 ? 3 : 1] = 1;
      return v;
    });
  },
});
const A = stub("a", 3);
const B = stub("b", 4);
const C = stub("c", 3);
const query = { text: "lighthouse call sign", limit: 4 };
const modes = async (provider: ReturnType<typeof stub>) =>
  (await new SqliteMemoryRecallProvider({ databasePath: dbPath, embeddingProvider: provider }).search(query))
    .map((hit) => `${hit.metadata?.recallMode}:${hit.text.includes("SYNTH-LH-140") ? "lh" : "other"}:${hit.score.toFixed(2)}`);
const specs = () => {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT DISTINCT coalesce(embedding_spec, 'NULL') AS spec FROM memory_chunks WHERE embedding_json IS NOT NULL").all() as Array<{ spec: string }>;
  db.close();
  return rows.map((row) => row.spec).sort();
};

backfillSqliteMemoryIndex({ paths, includeTranscripts: false });
const first = await backfillSqliteMemoryEmbeddings({ paths, provider: A });
if (first.chunksEmbedded < 2) fail(`model A should embed the chunks: ${JSON.stringify(first)}`);
const total = first.chunksEmbedded;
if (JSON.stringify(specs()) !== JSON.stringify(["stub:a"])) fail(`every vector should record stub:a: ${JSON.stringify(specs())}`);
if (memoryEmbeddingSpec(A) !== "stub:a") fail("the spec is <provider id>:<model>");

// Control: the same model finds the lighthouse by its vector.
const same = await modes(A);
if (!same[0]?.startsWith("embedding:lh")) fail(`control: model A should find the lighthouse by embedding: ${JSON.stringify(same)}`);

// Another size, and the same size from another model: never compared, found by words.
for (const [name, provider] of [["B (4 numbers)", B], ["C (3 numbers, another model)", C]] as const) {
  const got = await modes(provider);
  if (got.some((mode) => mode.startsWith("embedding"))) fail(`${name} compared its query with model A's vectors: ${JSON.stringify(got)}`);
  if (!got[0]?.startsWith("lexical:lh")) fail(`${name} should still find the lighthouse by its words: ${JSON.stringify(got)}`);
}
const mixB = sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(B), paths);
if (mixB.embedded !== total || mixB.otherModel !== total) fail(`the mix for B should count every chunk as another model's: ${JSON.stringify(mixB)}`);
const mixA = sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(A), paths);
if (mixA.otherModel !== 0) fail(`the mix for A should count none as another model's: ${JSON.stringify(mixA)}`);

// The next backfill embeds them again with B, and B's recall uses them.
const second = await backfillSqliteMemoryEmbeddings({ paths, provider: B });
if (second.chunksEmbedded !== total) fail(`switching to B should re-embed every chunk once: ${JSON.stringify(second)}`);
if (JSON.stringify(specs()) !== JSON.stringify(["stub:b"])) fail(`every vector should now record stub:b: ${JSON.stringify(specs())}`);
const again = await backfillSqliteMemoryEmbeddings({ paths, provider: B });
if (again.chunksEmbedded !== 0) fail(`a second backfill with B should embed nothing: ${JSON.stringify(again)}`);
const afterB = await modes(B);
if (!afterB[0]?.startsWith("embedding:lh")) fail(`after the re-embed, B should find the lighthouse by embedding: ${JSON.stringify(afterB)}`);

// Mixed: most chunks are B's, the garden is still another model's. B's recall has vector hits, and
// the garden is still found by its words alongside them.
{
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE memory_chunks SET embedding_spec = 'stub:a' WHERE text LIKE '%Tomatoes%'").run();
  db.close();
  const hits = await new SqliteMemoryRecallProvider({ databasePath: dbPath, embeddingProvider: B }).search({ text: "tomatoes fence", limit: 8 });
  if (!hits.some((hit) => hit.metadata?.recallMode === "embedding")) fail(`control: B should have vector hits in the mixed index: ${JSON.stringify(hits.map((h) => h.metadata?.recallMode))}`);
  const garden = hits.find((hit) => hit.text.includes("Tomatoes"));
  if (!garden || garden.metadata?.recallMode !== "lexical") fail(`the garden, another model's, should be found by its words: ${JSON.stringify(hits.map((h) => [h.metadata?.recallMode, h.text.slice(0, 30)]))}`);
  const redo = await backfillSqliteMemoryEmbeddings({ paths, provider: B });
  if (redo.chunksEmbedded !== 1) fail(`only the garden should be embedded again: ${JSON.stringify(redo)}`);
}

// Re-indexing keeps each vector with the model that made it.
const embeddedCount = () => {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT count(*) AS n FROM memory_chunks WHERE embedding_json IS NOT NULL").get() as { n: number };
  db.close();
  return Number(row.n);
};
const before = embeddedCount();
const reindexed = backfillSqliteMemoryIndex({ paths, includeTranscripts: false });
if (reindexed.chunkEmbeddingsPreserved < 1 || embeddedCount() !== before) fail(`re-indexing should keep every vector (${before} before): ${JSON.stringify(reindexed)}`);
if (JSON.stringify(specs()) !== JSON.stringify(["stub:b"])) fail(`re-indexing should keep the model with each vector: ${JSON.stringify(specs())}`);

// A vector of another size never scores, even recorded as B's.
{
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE memory_chunks SET embedding_json = '[1,0,0]' WHERE text LIKE '%SYNTH-LH-140%'").run();
  db.close();
  const got = await modes(B);
  if (got.some((mode) => mode.startsWith("embedding:lh"))) fail(`a 3-number vector scored against B's 4-number query: ${JSON.stringify(got)}`);
}

// Vectors from before the model was recorded count as another model's, and are embedded again.
{
  // Proper B vectors first, and a control: with the model recorded, B finds the lighthouse by its vector.
  await backfillSqliteMemoryEmbeddings({ paths, provider: B, force: true });
  const control = await modes(B);
  if (!control[0]?.startsWith("embedding:lh")) fail(`control: B should find the lighthouse by embedding before the model is cleared: ${JSON.stringify(control)}`);
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE memory_chunks SET embedding_spec = NULL").run();
  db.close();
  const got = await modes(B);
  if (got.some((mode) => mode.startsWith("embedding"))) fail(`unrecorded vectors were compared: ${JSON.stringify(got)}`);
  const mix = sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(B), paths);
  if (mix.otherModel !== total) fail(`unrecorded vectors should count as another model's: ${JSON.stringify(mix)}`);
  const redo = await backfillSqliteMemoryEmbeddings({ paths, provider: B });
  if (redo.chunksEmbedded !== total) fail(`unrecorded vectors should be embedded again: ${JSON.stringify(redo)}`);
}
// A large index (over recall's 5000-row window): re-embedding every chunk, newest first as the
// per-turn backfill does, must not make old chunks look new. The newest one is still recalled.
{
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(`INSERT INTO memory_chunks (chunk_id, source_id, kind, path, title, ordinal, text, token_estimate, embedding_json, embedding_spec, metadata_json, updated_at)
    VALUES (?, ?, 'memory', NULL, NULL, 0, ?, 8, '[0,1,0]', NULL, '{}', ?)`);
  const source = db.prepare("INSERT INTO memory_sources (id, kind, path, title, timestamp, content_hash, metadata_json, updated_at) VALUES (?, 'memory', NULL, NULL, NULL, ?, '{}', ?)");
  db.exec("BEGIN");
  for (let i = 0; i < 5200; i += 1) {
    const at = new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString();
    source.run(`bulk:${i}`, `hash-${i}`, at);
    insert.run(`bulk:${i}#0`, `bulk:${i}`, i === 5199 ? "the newest note mentions zebraword" : `an older note number ${i}`, at);
  }
  db.exec("COMMIT");
  const before = (db.prepare("SELECT updated_at AS at FROM memory_chunks WHERE chunk_id = 'bulk:5199#0'").get() as { at: string }).at;
  db.close();
  const redo = await backfillSqliteMemoryEmbeddings({ paths, provider: B, newestFirst: true });
  if (redo.chunksEmbedded < 5200) fail(`the bulk chunks should be re-embedded: ${JSON.stringify(redo)}`);
  const check = new DatabaseSync(dbPath);
  const after = (check.prepare("SELECT updated_at AS at, embedding_spec AS spec FROM memory_chunks WHERE chunk_id = 'bulk:5199#0'").get() as { at: string; spec: string });
  check.close();
  if (after.at !== before || after.spec !== "stub:b") fail(`re-embedding should keep a chunk's time and record the model: ${before} -> ${JSON.stringify(after)}`);
  const hits = await new SqliteMemoryRecallProvider({ databasePath: dbPath, embeddingProvider: B }).search({ text: "zebraword", limit: 4 });
  if (!hits.some((hit) => hit.text.includes("zebraword") && hit.metadata?.recallMode === "embedding")) {
    fail(`after re-embedding a large index, the newest chunk should still be recalled by its vector: ${JSON.stringify(hits.map((h) => [h.metadata?.recallMode, h.text.slice(0, 30)]))}`);
  }
}
// A switch in progress: every chunk is another model's. One turn's index update embeds that turn's
// own chunks, then only the newest MEMORY_REEMBED_PER_TURN of the others, and a fact said in that
// turn is recalled from another chat by its vector at once.
{
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE memory_chunks SET embedding_spec = 'stub:a' WHERE embedding_json IS NOT NULL").run();
  const otherBefore = sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(B), paths).otherModel;
  const newest = (db.prepare(`SELECT chunk_id AS id FROM memory_chunks WHERE embedding_json IS NOT NULL ORDER BY updated_at DESC, chunk_id ASC LIMIT ?`).all(MEMORY_REEMBED_PER_TURN) as Array<{ id: string }>).map((row) => row.id).sort();
  db.close();
  mkdirSync(paths.transcriptDir, { recursive: true });
  const file = join(paths.transcriptDir, "switch-turn.jsonl");
  writeFileSync(file, JSON.stringify({ id: "t1", sessionKey: "agent:console:console:admin:c1", agentId: "default", role: "user", text: "my dog's name is BISCUIT-9431", timestamp: "t", source: { substrate: "openai", channel: "openai-chat-completions", chatType: "internal" } }) + "\n");
  const turn = await indexSqliteMemoryTurn({ transcriptFile: file, config: { memory: { vectorStore: "sqlite-vec" } }, paths, provider: B });
  const otherAfter = sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(B), paths).otherModel;
  if (otherBefore - otherAfter !== MEMORY_REEMBED_PER_TURN) fail(`one turn should re-embed exactly ${MEMORY_REEMBED_PER_TURN} of another model's chunks: ${otherBefore} -> ${otherAfter}`);
  if (turn.chunksEmbedded !== MEMORY_REEMBED_PER_TURN + 1) fail(`the turn should embed its own chunk and ${MEMORY_REEMBED_PER_TURN} others: ${JSON.stringify(turn)}`);
  const after = new DatabaseSync(dbPath);
  const redone = (after.prepare("SELECT chunk_id AS id FROM memory_chunks WHERE embedding_spec = 'stub:b' AND chunk_id NOT LIKE 'transcript:%'").all() as Array<{ id: string }>).map((row) => row.id).sort();
  after.close();
  if (JSON.stringify(redone) !== JSON.stringify(newest)) fail(`the chunks re-embedded should be the newest ${MEMORY_REEMBED_PER_TURN}: ${redone.length} redone, ${redone.filter((id) => !newest.includes(id)).length} not among the newest`);
  const hits = await new SqliteMemoryRecallProvider({ databasePath: dbPath, embeddingProvider: B }).search({ text: "BISCUIT-9431 dog", limit: 4 });
  if (!hits.some((hit) => hit.text.includes("BISCUIT-9431") && hit.metadata?.recallMode === "embedding")) {
    fail(`a fact said while the switch is in progress should be recalled by its vector: ${JSON.stringify(hits.map((h) => [h.metadata?.recallMode, h.text.slice(0, 30)]))}`);
  }
}
// The gateway's split (#157): its turn update embeds only the turn's own chunks, and the paced
// re-embed does another model's, MEMORY_REEMBED_BATCH a request, waiting on beforeBatch before each.
{
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE memory_chunks SET embedding_spec = 'stub:a' WHERE embedding_json IS NOT NULL").run();
  db.close();
  const file = join(paths.transcriptDir, "paced-turn.jsonl");
  writeFileSync(file, JSON.stringify({ id: "t2", sessionKey: "agent:console:console:admin:c2", agentId: "default", role: "user", text: "the spare key is under PEBBLE-157", timestamp: "t", source: { substrate: "openai", channel: "openai-chat-completions", chatType: "internal" } }) + "\n");
  const otherBefore = sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(B), paths).otherModel;
  if (otherBefore < MEMORY_REEMBED_PER_TURN + 8) fail(`not enough of another model's chunks to measure: ${otherBefore}`);
  const turn = await indexSqliteMemoryTurn({ transcriptFile: file, config: { memory: { vectorStore: "sqlite-vec" } }, paths, provider: B, otherModelLimit: 0 });
  if (turn.chunksEmbedded !== 1) fail(`with otherModelLimit 0, the turn should embed only its own chunk: ${JSON.stringify(turn)}`);
  if (sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(B), paths).otherModel !== otherBefore) fail("with otherModelLimit 0, the turn embedded another model's chunks again");
  // A chunk with no vector is the turn update's, never the paced re-embed's.
  const unembedded = new DatabaseSync(dbPath);
  unembedded.prepare("UPDATE memory_chunks SET embedding_json = NULL, embedding_spec = NULL WHERE chunk_id = 'bulk:0#0'").run();
  const newest = (unembedded.prepare(`SELECT chunk_id AS id FROM memory_chunks WHERE embedding_json IS NOT NULL AND embedding_spec = 'stub:a' ORDER BY updated_at DESC, chunk_id ASC LIMIT ?`).all(MEMORY_REEMBED_PER_TURN) as Array<{ id: string }>).map((row) => row.id).sort();
  const bBefore = new Set((unembedded.prepare("SELECT chunk_id AS id FROM memory_chunks WHERE embedding_spec = 'stub:b'").all() as Array<{ id: string }>).map((row) => row.id));
  unembedded.close();
  const sizes: number[] = [];
  const events: string[] = [];
  const counting = { id: B.id, model: B.model, async embedTexts(texts: string[]) { sizes.push(texts.length); events.push("send"); return B.embedTexts(texts); } };
  const paced = await reembedSqliteMemoryOtherModel({ paths, provider: counting, beforeBatch: async () => { events.push("gate"); } });
  if (paced.chunksEmbedded !== MEMORY_REEMBED_PER_TURN) fail(`the paced re-embed should embed ${MEMORY_REEMBED_PER_TURN} chunks: ${JSON.stringify(paced)}`);
  if (MEMORY_REEMBED_BATCH > 4 || sizes.some((n) => n > MEMORY_REEMBED_BATCH)) fail(`requests of more than ${MEMORY_REEMBED_BATCH} (at most 4) chunks: ${JSON.stringify(sizes)}`);
  if (sizes.length !== Math.ceil(MEMORY_REEMBED_PER_TURN / MEMORY_REEMBED_BATCH)) fail(`expected ${Math.ceil(MEMORY_REEMBED_PER_TURN / MEMORY_REEMBED_BATCH)} requests: ${sizes.length}`);
  if (events.join(",") !== Array(sizes.length).fill("gate,send").join(",")) fail(`beforeBatch should run before every request: ${events.slice(0, 6).join(",")}...`);
  const check = new DatabaseSync(dbPath);
  const redone = (check.prepare("SELECT chunk_id AS id FROM memory_chunks WHERE embedding_spec = 'stub:b'").all() as Array<{ id: string }>).map((row) => row.id).filter((id) => !bBefore.has(id)).sort();
  const stillNull = check.prepare("SELECT embedding_json AS e FROM memory_chunks WHERE chunk_id = 'bulk:0#0'").get() as { e: string | null };
  check.close();
  if (JSON.stringify(redone) !== JSON.stringify(newest)) fail(`the paced re-embed should do the newest ${MEMORY_REEMBED_PER_TURN}: ${redone.length} redone`);
  if (stillNull.e !== null) fail("the paced re-embed embedded a chunk with no vector");
  // Nothing is sent until beforeBatch lets it.
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sent = 0;
  const held = reembedSqliteMemoryOtherModel({ paths, limit: MEMORY_REEMBED_BATCH, provider: { id: B.id, model: B.model, async embedTexts(texts: string[]) { sent += 1; return B.embedTexts(texts); } }, beforeBatch: () => gate });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (sent !== 0) fail("the paced re-embed sent a request before beforeBatch returned");
  release();
  const heldResult = await held;
  if (sent !== 1 || heldResult.chunksEmbedded !== MEMORY_REEMBED_BATCH) fail(`after beforeBatch returned, one request of ${MEMORY_REEMBED_BATCH}: ${sent} sent, ${JSON.stringify(heldResult)}`);
  // A chunk rewritten or removed while the run waited in beforeBatch isn't sent; the others are.
  const pending = new DatabaseSync(dbPath);
  const next = pending.prepare(`SELECT chunk_id AS id, text FROM memory_chunks WHERE embedding_json IS NOT NULL AND embedding_spec = 'stub:a' ORDER BY updated_at DESC, chunk_id ASC LIMIT ?`).all(MEMORY_REEMBED_BATCH) as Array<{ id: string; text: string }>;
  pending.close();
  if (next.length !== MEMORY_REEMBED_BATCH) fail(`not enough chunks left for the rewrite check: ${next.length}`);
  const texts: string[] = [];
  let changedMeanwhile = false;
  await reembedSqliteMemoryOtherModel({ paths, limit: MEMORY_REEMBED_BATCH, provider: { id: B.id, model: B.model, async embedTexts(input: string[]) { texts.push(...input); return B.embedTexts(input); } }, beforeBatch: async () => {
    if (changedMeanwhile) return;
    changedMeanwhile = true;
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE memory_chunks SET text = text || ' (rewritten)' WHERE chunk_id = ?").run(next[0]!.id);
    db.prepare("DELETE FROM memory_chunks WHERE chunk_id = ?").run(next[1]!.id);
    db.close();
  } });
  if (texts.includes(next[0]!.text) || texts.includes(next[1]!.text)) fail("a chunk rewritten or removed while the run waited was sent");
  if (!texts.includes(next[2]!.text) || !texts.includes(next[3]!.text)) fail(`control: the chunks left alone should be sent: ${texts.length} sent`);
}
// One chunk the embedder refuses doesn't stop the rest (#170): the refused request's chunks go one
// at a time, the refused one is recorded and goes last, and after MEMORY_EMBED_SKIP_AFTER refusals it
// isn't sent to that model again while its text is the same. An embedder that is down still stops a run.
{
  const setup = new DatabaseSync(dbPath);
  setup.prepare("UPDATE memory_chunks SET embedding_spec = 'stub:a' WHERE embedding_json IS NOT NULL").run();
  setup.prepare("INSERT INTO memory_sources (id, kind, path, title, timestamp, content_hash, metadata_json, updated_at) VALUES ('refused', 'memory', NULL, NULL, NULL, 'refused-hash', '{}', '2099-01-01T00:00:00.000Z')").run();
  setup.prepare("INSERT INTO memory_chunks (chunk_id, source_id, kind, path, title, ordinal, text, token_estimate, embedding_json, embedding_spec, metadata_json, updated_at) VALUES ('refused#0', 'refused', 'memory', NULL, NULL, 0, 'an old note holding REFUSEDTEXT', 8, '[0,1,0]', 'stub:a', '{}', '2099-01-01T00:00:00.000Z')").run();
  setup.close();
  const sent: string[][] = [];
  const P = { id: "stub", model: "p", async embedTexts(texts: string[]) {
    sent.push(texts);
    if (texts.some((text) => text.includes("REFUSEDTEXT"))) throw Object.assign(new Error("input is too long for the context"), { status: 400 });
    return B.embedTexts(texts);
  } };
  const refusedSends = () => sent.filter((texts) => texts.some((text) => text.includes("REFUSEDTEXT"))).length;
  const rejection = () => {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT failures, reason, updated_at FROM memory_embed_rejections WHERE chunk_id = 'refused#0' AND spec = 'stub:p'").get() as { failures: number; reason: string; updated_at: string } | undefined;
    db.close();
    return row;
  };
  // The paced run: the refused chunk is the newest, so it heads the first request of 4.
  const gates: string[] = [];
  const paced = await reembedSqliteMemoryOtherModel({ paths, provider: P, limit: 8, beforeBatch: async () => { gates.push("gate"); } });
  if (paced.chunksEmbedded !== 7 || paced.chunksRejected !== 1) fail(`one refused chunk should cost only itself: ${JSON.stringify(paced)}`);
  if (refusedSends() !== 2) fail(`the refused request, then the refused chunk alone: ${refusedSends()} sends`);
  if (sent.some((texts) => texts.length > 1 && texts.some((text) => text.includes("REFUSEDTEXT")) && texts.length !== MEMORY_REEMBED_BATCH)) fail("the refused request should be the whole first batch");
  // The gate before each request, the single ones included: 1 (refused), 1 (the test text), 4 (one at a time), 1 (second request).
  if (gates.length !== 7) fail(`beforeBatch should run before every request, one at a time included: ${gates.length}`);
  const first = rejection();
  if (first?.failures !== 1 || !/too long/.test(first.reason)) fail(`the refusal should be recorded with its reason: ${JSON.stringify(first)}`);
  // The next run starts with the others: the refused chunk goes last, so with thousands left it isn't sent.
  sent.length = 0;
  const next = await reembedSqliteMemoryOtherModel({ paths, provider: P, limit: 8 });
  if (next.chunksEmbedded !== 8 || refusedSends() !== 0) fail(`a chunk refused before should go last: ${JSON.stringify(next)}, ${refusedSends()} sends`);
  // A refused chunk isn't sent again for MEMORY_EMBED_REFUSAL_SPACING_MS (#170 review 2), so a turn's update doesn't resend it every turn.
  const firstAt = rejection()?.updated_at;
  sent.length = 0;
  const soon = await backfillSqliteMemoryEmbeddings({ paths, provider: P });
  if (refusedSends() !== 0 || soon.chunksRejected !== 0 || rejection()?.failures !== 1) fail(`a chunk refused just now shouldn't be sent again yet: ${refusedSends()} sends, ${JSON.stringify(soon)}, ${JSON.stringify(rejection())}`);
  // Nor by the paced run, however many it may take.
  const pacedSoon = await reembedSqliteMemoryOtherModel({ paths, provider: P, limit: 100_000 });
  if (refusedSends() !== 0 || pacedSoon.chunksConsidered !== 0) fail(`the paced run shouldn't send a chunk refused just now: ${refusedSends()} sends, ${JSON.stringify(pacedSoon)}`);
  // --force sends it anyway; a refusal inside the spacing isn't counted, and doesn't move the spacing on.
  sent.length = 0;
  await backfillSqliteMemoryEmbeddings({ paths, provider: P, force: true });
  // Sent twice: in its request of 16, then alone.
  if (refusedSends() !== 2 || rejection()?.failures !== 1) fail(`a refusal inside the spacing shouldn't count again: ${refusedSends()} sends, ${JSON.stringify(rejection())}`);
  if (!firstAt || rejection()?.updated_at !== firstAt) fail(`an uncounted refusal shouldn't restart the spacing: ${firstAt} -> ${rejection()?.updated_at}`);
  const age = (ms: number) => {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE memory_embed_rejections SET updated_at = ? WHERE chunk_id = 'refused#0' AND spec = 'stub:p'").run(new Date(Date.now() - ms).toISOString());
    db.close();
  };
  // A minute inside the spacing it still isn't sent.
  age(MEMORY_EMBED_REFUSAL_SPACING_MS - 60_000);
  sent.length = 0;
  await backfillSqliteMemoryEmbeddings({ paths, provider: P });
  if (refusedSends() !== 0 || rejection()?.failures !== 1) fail(`a minute inside the spacing the chunk shouldn't be sent: ${refusedSends()} sends, ${JSON.stringify(rejection())}`);
  // Spaced out, a whole backfill's refusal counts; after MEMORY_EMBED_SKIP_AFTER refusals it is skipped for that model.
  for (let run = 2; run <= MEMORY_EMBED_SKIP_AFTER; run += 1) {
    age(MEMORY_EMBED_REFUSAL_SPACING_MS + 1000);
    const whole = await backfillSqliteMemoryEmbeddings({ paths, provider: P });
    if (whole.chunksRejected !== 1) fail(`backfill ${run} should be refused on that chunk alone: ${JSON.stringify(whole)}`);
  }
  if (rejection()?.failures !== MEMORY_EMBED_SKIP_AFTER) fail(`refusals should reach ${MEMORY_EMBED_SKIP_AFTER}: ${JSON.stringify(rejection())}`);
  const mix = sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(P), paths);
  if (mix.skipped !== 1 || mix.otherModel !== 0) fail(`the refused chunk should count as skipped, not as waiting to be embedded again: ${JSON.stringify(mix)}`);
  // An hour on (past the 10 minutes' hold-back), it is still skipped: not sent.
  age(60 * 60 * 1000);
  sent.length = 0;
  const after = await backfillSqliteMemoryEmbeddings({ paths, provider: P });
  if (refusedSends() !== 0 || after.chunksConsidered !== 0) fail(`a skipped chunk shouldn't be sent again: ${JSON.stringify(after)}, ${refusedSends()} sends`);
  // Another model hasn't refused it: skipped only for the model that refused it.
  if (sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(C), paths).skipped !== 0) fail("a chunk skipped for one model shouldn't count as skipped for another");
  // A skip lasts MEMORY_EMBED_SKIP_RETRY_MS (#170 review 2): until then the chunk isn't sent.
  age(MEMORY_EMBED_SKIP_RETRY_MS - 60_000);
  sent.length = 0;
  await backfillSqliteMemoryEmbeddings({ paths, provider: P });
  if (refusedSends() !== 0) fail("a skipped chunk shouldn't be sent before its day is up");
  // Then it is sent again; until it is, it is still reported as skipped (#170 review 3).
  age(MEMORY_EMBED_SKIP_RETRY_MS + 1000);
  if (sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(P), paths).skipped !== 1) fail("a chunk whose day is up should still be reported as skipped until it is tried");
  sent.length = 0;
  const retried = await backfillSqliteMemoryEmbeddings({ paths, provider: P });
  // Refused again, its count starts again (#170 review 3): it takes 3 spaced refusals to skip it again.
  if (refusedSends() !== 1 || retried.chunksRejected !== 1 || rejection()?.failures !== 1) fail(`after a day the chunk should be tried again and its count start again: ${refusedSends()} sends, ${JSON.stringify(rejection())}`);
  if (sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(P), paths).skipped !== 0) fail("refused again after its day, the chunk should wait for its count again");
  // A refusal time ahead of now (a clock set back since) holds nothing back, and the next refusal counts (#170 review 3).
  age(-60 * 60 * 1000);
  sent.length = 0;
  await backfillSqliteMemoryEmbeddings({ paths, provider: P });
  if (refusedSends() !== 1 || rejection()?.failures !== 2) fail(`a refusal time ahead of now shouldn't hold the chunk back: ${refusedSends()} sends, ${JSON.stringify(rejection())}`);
  // --force sends everything, the skipped chunk included.
  sent.length = 0;
  await backfillSqliteMemoryEmbeddings({ paths, provider: P, force: true });
  if (refusedSends() === 0) fail("--force should send a skipped chunk too");
  // A new text is tried afresh.
  const edit = new DatabaseSync(dbPath);
  edit.prepare("UPDATE memory_chunks SET text = 'an old note holding REFUSEDTEXT, edited' WHERE chunk_id = 'refused#0'").run();
  edit.close();
  if (sqliteMemoryEmbeddingMix(memoryEmbeddingSpec(P), paths).skipped !== 0) fail("a chunk whose text changed shouldn't count as skipped");
  // The record of the old text is dropped by maintenance, so the old text doesn't stay (#170 review 2).
  maintainSqliteMemoryIndex({ paths, removeStaleSources: false, optimize: false, vacuum: false });
  if (rejection()) fail(`maintenance should drop the record of a text that changed: ${JSON.stringify(rejection())}`);
  sent.length = 0;
  await backfillSqliteMemoryEmbeddings({ paths, provider: P });
  if (refusedSends() !== 1 || rejection()?.failures !== 1) fail(`a changed text should be tried again and counted afresh: ${refusedSends()} sends, ${JSON.stringify(rejection())}`);
  // An embedder that is down stops the run, as before, and records no refusal.
  const other = new DatabaseSync(dbPath);
  other.prepare("UPDATE memory_chunks SET embedding_spec = 'stub:a' WHERE chunk_id IN (SELECT chunk_id FROM memory_chunks WHERE chunk_id != 'refused#0' ORDER BY updated_at DESC LIMIT 4)").run();
  const rejectionsBefore = (other.prepare("SELECT count(*) AS n FROM memory_embed_rejections").get() as { n: number }).n;
  other.close();
  let downCalls = 0;
  const down = { id: "stub", model: "p", async embedTexts() { downCalls += 1; throw Object.assign(new Error("service unavailable"), { status: 503 }); } };
  const outage = await backfillSqliteMemoryEmbeddings({ paths, provider: down }).then(() => undefined, (error: unknown) => error);
  if (!(outage instanceof Error)) fail("an embedder that is down should still stop the run");
  // Stopped at the first request: no chunk is tried alone during an outage.
  if (downCalls !== 1) fail(`an outage should cost one request, not a retry of each chunk: ${downCalls}`);
  // And a request of one chunk that meets an outage isn't recorded as a refusal either.
  const lone = new DatabaseSync(dbPath);
  lone.prepare("UPDATE memory_chunks SET embedding_spec = 'stub:p' WHERE embedding_spec = 'stub:a' AND chunk_id != (SELECT chunk_id FROM memory_chunks WHERE embedding_spec = 'stub:a' AND chunk_id != 'refused#0' ORDER BY updated_at DESC LIMIT 1) AND chunk_id != 'refused#0'").run();
  const others = (lone.prepare("SELECT count(*) AS n FROM memory_chunks WHERE embedding_json IS NOT NULL AND (embedding_spec IS NULL OR embedding_spec != 'stub:p') AND chunk_id != 'refused#0'").get() as { n: number }).n;
  lone.close();
  if (others !== 1) fail(`control: one chunk should be left for the one-chunk outage: ${others}`);
  const loneOutage = await backfillSqliteMemoryEmbeddings({ paths, provider: down }).then(() => undefined, (error: unknown) => error);
  if (!(loneOutage instanceof Error)) fail("an outage on a one-chunk request should still stop the run");
  const count = new DatabaseSync(dbPath);
  const rejectionsAfter = (count.prepare("SELECT count(*) AS n FROM memory_embed_rejections").get() as { n: number }).n;
  count.prepare("DELETE FROM memory_chunks WHERE chunk_id = 'refused#0'").run();
  count.prepare("DELETE FROM memory_sources WHERE id = 'refused'").run();
  count.close();
  if (rejectionsAfter !== rejectionsBefore) fail(`an outage shouldn't be recorded as a refusal: ${rejectionsBefore} -> ${rejectionsAfter}`);
  // A record whose chunk is gone is dropped, text and all (#170 review): by maintenance, and at the start of an embedding run.
  if (!rejection()) fail("control: the refused chunk's record should still be there before maintenance");
  maintainSqliteMemoryIndex({ paths, removeStaleSources: false, optimize: false, vacuum: false });
  if (rejection()) fail(`maintenance should drop the record of a chunk that is gone: ${JSON.stringify(rejection())}`);
  // And at the start of an embedding run, a record whose text is no longer the chunk's.
  const ghost = new DatabaseSync(dbPath);
  const live = (ghost.prepare("SELECT chunk_id AS id FROM memory_chunks ORDER BY chunk_id LIMIT 1").get() as { id: string }).id;
  ghost.prepare("INSERT INTO memory_embed_rejections (chunk_id, spec, text, failures, reason, updated_at) VALUES (?, 'stub:p', 'an older text', 1, 'x', '2026-01-01T00:00:00.000Z')").run(live);
  ghost.close();
  await backfillSqliteMemoryEmbeddings({ paths, provider: P });
  const staleLeft = new DatabaseSync(dbPath);
  const stale = staleLeft.prepare("SELECT 1 AS present FROM memory_embed_rejections WHERE chunk_id = ? AND spec = 'stub:p'").get(live);
  staleLeft.close();
  if (stale) fail("an embedding run should drop the record of a text that changed");
}
// #170 review: an embedder that refuses everything isn't a text it can't take.
{
  // The classification, every branch.
  const abort = new Error("aborted"); abort.name = "AbortError";
  const timeout = new Error("timed out"); timeout.name = "TimeoutError";
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error("x"), { status: 429 }), "rate-limited"],
    [Object.assign(new Error("x"), { status: 503 }), "unavailable"],
    ...[401, 403, 404, 408].map((status) => [Object.assign(new Error("x"), { status }), "unavailable"] as [unknown, string]),
    [Object.assign(new Error("x"), { status: 400 }), "rejected"],
    [Object.assign(new Error("x"), { status: 413 }), "rejected"],
    [Object.assign(new TypeError("fetch failed"), { unavailable: true }), "unavailable"],
    [abort, "unavailable"],
    [timeout, "unavailable"],
    [new SyntaxError("Unexpected token <"), "rejected"],
  ];
  for (const [error, cause] of cases) {
    if (embeddingFailureCause(error) !== cause) fail(`${(error as Error).name} ${(error as { status?: number }).status ?? ""}: ${embeddingFailureCause(error)}, not ${cause}`);
  }
  const rejections = (spec: string) => {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT count(*) AS n FROM memory_embed_rejections WHERE spec = ?").get(spec) as { n: number };
    db.close();
    return Number(row.n);
  };
  const toOther = () => {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE memory_chunks SET embedding_spec = 'stub:a' WHERE embedding_json IS NOT NULL").run();
    db.close();
  };
  toOther();
  // A model that refuses every request (a chat model behind the embeddings route): the request, its
  // chunks alone and then a short test text are refused, so the run stops and counts nothing (#170 review).
  let calls = 0;
  let gates = 0;
  const probes: string[] = [];
  const everything = { id: "stub", model: "q", async embedTexts(texts: string[]) {
    calls += 1;
    if (texts.length === 1 && texts[0]!.startsWith(`${MEMORY_EMBED_PROBE_TEXT} `)) probes.push(texts[0]!);
    throw Object.assign(new Error("model does not support embeddings"), { status: 400 });
  } };
  const refusedAll = await reembedSqliteMemoryOtherModel({ paths, provider: everything, limit: 16, beforeBatch: async () => { gates += 1; } }).then(() => undefined, (error: unknown) => error);
  if (!(refusedAll instanceof Error) || !(refusedAll as { refusedEverything?: boolean }).refusedEverything) fail(`an embedder refusing everything should stop the run: ${String(refusedAll)}`);
  if (calls !== 2) fail(`the request and the test text, then stop (#170 review 3: not each chunk alone too): ${calls} requests`);
  if (gates !== calls) fail(`beforeBatch should run before every request, the test text included: ${gates} for ${calls}`);
  if (rejections("stub:q") !== 0) fail(`an embedder refusing everything marked ${rejections("stub:q")} chunks`);
  // An outage on the test text stops the run as an outage, counting nothing.
  const probeDown = { id: "stub", model: "q", async embedTexts(texts: string[]) {
    if (texts.length === 1 && texts[0]!.startsWith(`${MEMORY_EMBED_PROBE_TEXT} `)) throw Object.assign(new Error("service unavailable"), { status: 503 });
    throw Object.assign(new Error("model does not support embeddings"), { status: 400 });
  } };
  const probeOutage = await reembedSqliteMemoryOtherModel({ paths, provider: probeDown, limit: 16 }).then(() => undefined, (error: unknown) => error);
  if (!(probeOutage instanceof Error) || (probeOutage as { refusedEverything?: boolean }).refusedEverything || rejections("stub:q") !== 0) fail(`an outage on the test text should stop the run as an outage: ${String(probeOutage)}, ${rejections("stub:q")}`);
  const wholeBackfill = await backfillSqliteMemoryEmbeddings({ paths, provider: everything }).then(() => undefined, (error: unknown) => error);
  // The test text carries a new random word each time, so a cache can't answer it (#170 review 2).
  if (probes.length !== 2 || probes[0] === probes[1]) fail(`each test text should differ: ${JSON.stringify(probes)}`);
  if (!(wholeBackfill instanceof Error) || rejections("stub:q") !== 0) fail(`a whole backfill against it should stop and count nothing: ${String(wholeBackfill)}, ${rejections("stub:q")}`);
  // One that worked before, and in this run, then refuses everything (a proxy's 400 while its upstream
  // is down): the same, nothing counted, whatever it embedded first (#170 review: it used to count them).
  const worked = { id: "stub", model: "w", embedTexts: (texts: string[]) => B.embedTexts(texts) };
  await reembedSqliteMemoryOtherModel({ paths, provider: worked, limit: 4 });
  toOther();
  let wCalls = 0;
  const flips = { id: "stub", model: "w", async embedTexts(texts: string[]) {
    wCalls += 1;
    if (wCalls > 1) throw Object.assign(new Error("upstream unavailable"), { status: 400 });
    return B.embedTexts(texts);
  } };
  const stopped = await reembedSqliteMemoryOtherModel({ paths, provider: flips, limit: 64 }).then((result) => result, (error: unknown) => error);
  if (!(stopped instanceof Error) || !(stopped as { refusedEverything?: boolean }).refusedEverything) fail(`it should stop the run: ${JSON.stringify(stopped)}`);
  if (rejections("stub:w") !== 0) fail(`an embedder that worked and then refused everything counted ${rejections("stub:w")} chunks`);
  if (wCalls !== 3) fail(`one request that worked, then a refused one and the test text: ${wCalls} requests`);
  // A model that has never worked here, with a first request of texts it can't take: the test text
  // goes in, so they are counted and the run goes on (#170 review: it used to stall there).
  toOther();
  const head = (() => {
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT text FROM memory_chunks WHERE embedding_json IS NOT NULL ORDER BY updated_at DESC, chunk_id ASC LIMIT ?").all(MEMORY_REEMBED_BATCH) as Array<{ text: string }>;
    db.close();
    return new Set(rows.map((row) => row.text));
  })();
  const tooLong = () => Object.assign(new Error("input too long"), { status: 400 });
  const badHead = { id: "stub", model: "h", async embedTexts(texts: string[]) { if (texts.some((text) => head.has(text))) throw tooLong(); return B.embedTexts(texts); } };
  const pastHead = await reembedSqliteMemoryOtherModel({ paths, provider: badHead, limit: 2 * MEMORY_REEMBED_BATCH });
  if (pastHead.chunksRejected !== MEMORY_REEMBED_BATCH || pastHead.chunksEmbedded !== MEMORY_REEMBED_BATCH || rejections("stub:h") !== MEMORY_REEMBED_BATCH) fail(`a head of texts it can't take should be counted and got past: ${JSON.stringify(pastHead)}, ${rejections("stub:h")}`);
  // A success clears a chunk's record for that model (a whole backfill reaches them once the spacing
  // is over: they go last).
  toOther();
  const spaced = new DatabaseSync(dbPath);
  spaced.prepare("UPDATE memory_embed_rejections SET updated_at = ? WHERE spec = 'stub:h'").run(new Date(Date.now() - MEMORY_EMBED_REFUSAL_SPACING_MS - 1000).toISOString());
  spaced.close();
  await backfillSqliteMemoryEmbeddings({ paths, provider: { id: "stub", model: "h", embedTexts: (texts: string[]) => B.embedTexts(texts) } });
  if (rejections("stub:h") !== 0) fail(`a chunk embedded after a refusal should lose its record: ${rejections("stub:h")} left`);
  // A refusal shown to be about its text is kept when an outage stops the run later (#170 review).
  toOther();
  const [firstText] = [...head];
  let lCalls = 0;
  const laterOutage = { id: "stub", model: "l", async embedTexts(texts: string[]) {
    lCalls += 1;
    // The refused request (1), the test text (2), its chunks alone (3-6), one request that works (7), then the outage.
    if (lCalls > 1 + 1 + MEMORY_REEMBED_BATCH + 1) throw Object.assign(new Error("service unavailable"), { status: 503 });
    if (texts.includes(firstText!)) throw tooLong();
    return B.embedTexts(texts);
  } };
  const outageLater = await reembedSqliteMemoryOtherModel({ paths, provider: laterOutage, limit: 3 * MEMORY_REEMBED_BATCH }).then(() => undefined, (error: unknown) => error);
  if (!(outageLater instanceof Error) || rejections("stub:l") !== 1) fail(`the refusal found before the outage should be kept: ${String(outageLater)}, ${rejections("stub:l")}`);
  // A reply with the wrong number of vectors for a chunk alone is a refusal of that chunk.
  toOther();
  const mismatch = { id: "stub", model: "v", async embedTexts(texts: string[]) {
    if (texts.length > 1 && texts.includes(firstText!)) throw tooLong();
    if (texts.length === 1 && texts[0] === firstText) return [];
    return B.embedTexts(texts);
  } };
  await reembedSqliteMemoryOtherModel({ paths, provider: mismatch, limit: MEMORY_REEMBED_BATCH });
  const mismatchRow = (() => { const db = new DatabaseSync(dbPath); const row = db.prepare("SELECT count(*) AS n, max(reason) AS reason FROM memory_embed_rejections WHERE spec = 'stub:v'").get() as { n: number; reason: string | null }; db.close(); return row; })();
  if (Number(mismatchRow.n) !== 1 || !/vectors/.test(mismatchRow.reason ?? "")) fail(`a reply with no vector for a chunk should count as its refusal: ${JSON.stringify(mismatchRow)}`);
  // A run sends at most MEMORY_EMBED_SINGLES_PER_RUN chunks alone, then ends; the next run goes on (#170 review 3).
  toOther();
  const bad = (() => {
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT text FROM memory_chunks WHERE embedding_json IS NOT NULL ORDER BY updated_at DESC, chunk_id ASC LIMIT ?").all(MEMORY_EMBED_SINGLES_PER_RUN + 2 * MEMORY_REEMBED_BATCH) as Array<{ text: string }>;
    db.close();
    return new Set(rows.map((row) => row.text));
  })();
  const capped = { id: "stub", model: "c", async embedTexts(texts: string[]) { if (texts.some((text) => bad.has(text))) throw tooLong(); return B.embedTexts(texts); } };
  const firstCapped = await reembedSqliteMemoryOtherModel({ paths, provider: capped, limit: MEMORY_EMBED_SINGLES_PER_RUN + 4 * MEMORY_REEMBED_BATCH });
  if (firstCapped.chunksRejected !== MEMORY_EMBED_SINGLES_PER_RUN || firstCapped.chunksEmbedded !== 0) fail(`a run should stop after ${MEMORY_EMBED_SINGLES_PER_RUN} chunks alone: ${JSON.stringify(firstCapped)}`);
  const nextCapped = await reembedSqliteMemoryOtherModel({ paths, provider: capped, limit: MEMORY_EMBED_SINGLES_PER_RUN + 4 * MEMORY_REEMBED_BATCH });
  if (nextCapped.chunksRejected !== 2 * MEMORY_REEMBED_BATCH || nextCapped.chunksEmbedded !== MEMORY_EMBED_SINGLES_PER_RUN + 2 * MEMORY_REEMBED_BATCH) fail(`the next run should go on past them: ${JSON.stringify(nextCapped)}`);
  toOther();
  // During the single sends: a stop in beforeBatch stops the run, a row gone meanwhile isn't sent,
  // and an outage stops the run without counting a refusal.
  const newest = (() => {
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT chunk_id AS id, text FROM memory_chunks WHERE embedding_json IS NOT NULL ORDER BY updated_at DESC, chunk_id ASC LIMIT ?").all(MEMORY_REEMBED_BATCH) as Array<{ id: string; text: string }>;
    db.close();
    return rows;
  })();
  const batchRefused = (single: (text: string) => number[] | Error) => ({ id: "stub", model: "s", sent: [] as string[][], async embedTexts(texts: string[]) {
    this.sent.push(texts);
    if (texts.length > 1) throw Object.assign(new Error("input too long"), { status: 400 });
    if (texts[0]!.startsWith(`${MEMORY_EMBED_PROBE_TEXT} `)) return [[0, 1, 0, 0]];
    const out = single(texts[0]!);
    if (out instanceof Error) throw out;
    return [out];
  } });
  class Stop extends Error {}
  let gate = 0;
  const stopMidway = batchRefused(() => [0, 1, 0, 0]);
  const stopResult = await reembedSqliteMemoryOtherModel({ paths, provider: stopMidway, limit: MEMORY_REEMBED_BATCH, beforeBatch: async () => { gate += 1; if (gate === 4) throw new Stop("config changed"); } }).then(() => undefined, (error: unknown) => error);
  if (!(stopResult instanceof Stop)) fail(`a stop during the single sends should stop the run: ${String(stopResult)}`);
  // The request, the test text and the first chunk alone; nothing after the stop.
  if (stopMidway.sent.length !== 3) fail(`nothing after the stop: ${stopMidway.sent.length} requests`);
  toOther();
  gate = 0;
  const gone = batchRefused(() => [0, 1, 0, 0]);
  await reembedSqliteMemoryOtherModel({ paths, provider: gone, limit: MEMORY_REEMBED_BATCH, beforeBatch: async () => {
    gate += 1;
    if (gate === 2) {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE memory_chunks SET text = text || ' (rewritten)' WHERE chunk_id = ?").run(newest[2]!.id);
      db.close();
    }
  } });
  if (gone.sent.some((texts) => texts.length === 1 && texts[0] === newest[2]!.text)) fail("a chunk rewritten during the single sends was sent");
  if (gone.sent.filter((texts) => texts.length === 1 && !texts[0]!.startsWith(`${MEMORY_EMBED_PROBE_TEXT} `)).length !== MEMORY_REEMBED_BATCH - 1) fail(`the other chunks should be sent alone: ${JSON.stringify(gone.sent.map((texts) => texts.length))}`);
  toOther();
  const outageAlone = batchRefused(() => Object.assign(new Error("service unavailable"), { status: 503 }));
  const before = rejections("stub:s");
  const outageResult = await reembedSqliteMemoryOtherModel({ paths, provider: outageAlone, limit: MEMORY_REEMBED_BATCH }).then(() => undefined, (error: unknown) => error);
  if (!(outageResult instanceof Error) || rejections("stub:s") !== before) fail(`an outage during the single sends should stop the run and count nothing: ${String(outageResult)}, ${before} -> ${rejections("stub:s")}`);
  // The request, the test text, then the first single send.
  if (outageAlone.sent.length !== 3) fail(`it should stop at the first single send: ${outageAlone.sent.length} requests`);
  // A turn's own chunk refused on its own is in the turn's result, which the gateway logs.
  const turnFile = join(paths.transcriptDir, "refused-turn.jsonl");
  writeFileSync(turnFile, JSON.stringify({ id: "t3", sessionKey: "agent:console:console:admin:c3", agentId: "default", role: "user", text: "a note holding TURNREFUSED", timestamp: "t", source: { substrate: "openai", channel: "openai-chat-completions", chatType: "internal" } }) + "\n");
  const turnRefuser = { id: "stub", model: "t", async embedTexts(texts: string[]) { if (texts.some((text) => text.includes("TURNREFUSED"))) throw tooLong(); return B.embedTexts(texts); } };
  const refusedTurn = await indexSqliteMemoryTurn({ transcriptFile: turnFile, config: { memory: { vectorStore: "sqlite-vec" } }, paths, provider: turnRefuser, otherModelLimit: 0 });
  if (refusedTurn.chunksRejected !== 1) fail(`the turn's refused chunk should be in its result: ${JSON.stringify(refusedTurn)}`);
  // The update a turn waits for (no vector yet) holds back a chunk skipped for the model, and sends one
  // refused before after the others (#170 review 2).
  toOther();
  const fresh = new DatabaseSync(dbPath);
  const [heldBack, refusedOnce, plain] = fresh.prepare("SELECT chunk_id AS id, text FROM memory_chunks ORDER BY updated_at DESC, chunk_id ASC LIMIT 3").all() as Array<{ id: string; text: string }>;
  fresh.prepare("UPDATE memory_chunks SET embedding_json = NULL, embedding_spec = NULL WHERE chunk_id IN (?, ?, ?)").run(heldBack!.id, refusedOnce!.id, plain!.id);
  const longAgo = new Date(Date.now() - MEMORY_EMBED_REFUSAL_SPACING_MS - 60_000).toISOString();
  fresh.prepare("INSERT INTO memory_embed_rejections (chunk_id, spec, text, failures, reason, updated_at) VALUES (?, 'stub:n', ?, ?, 'x', ?)").run(heldBack!.id, heldBack!.text, MEMORY_EMBED_SKIP_AFTER, new Date().toISOString());
  fresh.prepare("INSERT INTO memory_embed_rejections (chunk_id, spec, text, failures, reason, updated_at) VALUES (?, 'stub:n', ?, 1, 'x', ?)").run(refusedOnce!.id, refusedOnce!.text, longAgo);
  fresh.close();
  const order: string[] = [];
  const noVector = { id: "stub", model: "n", async embedTexts(texts: string[]) { order.push(...texts); return B.embedTexts(texts); } };
  await backfillSqliteMemoryEmbeddings({ paths, provider: noVector, newestFirst: true, otherModelLimit: 0, batchSize: 1 });
  if (order.includes(heldBack!.text)) fail("the turn's update should hold back a chunk skipped for the model");
  if (sqliteMemoryEmbeddingMix("stub:n", paths).skipped !== 1) fail("a skipped chunk with no vector should be counted as skipped");
  if (order.indexOf(refusedOnce!.text) < order.indexOf(plain!.text) || !order.includes(refusedOnce!.text)) fail(`the turn's update should send a chunk refused before after the others: ${order.length} sent`);
  toOther();
  // A failure to write the index (locked by another run) isn't counted as a refusal (#170 review 2).
  const lock = new DatabaseSync(dbPath);
  let locked = false;
  const lockedStore = { id: "stub", model: "k", async embedTexts(texts: string[]) {
    if (texts.length > 1) throw tooLong();
    if (!locked) { lock.exec("BEGIN IMMEDIATE"); locked = true; }
    return B.embedTexts(texts);
  } };
  const storeFailure = await reembedSqliteMemoryOtherModel({ paths, provider: lockedStore, limit: MEMORY_REEMBED_BATCH }).then(() => undefined, (error: unknown) => error);
  if (locked) lock.exec("ROLLBACK");
  lock.close();
  if (!(storeFailure instanceof Error) || !/writing the memory index failed/.test(storeFailure.message) || rejections("stub:k") !== 0) fail(`a locked index should stop the run, counting no refusal: ${String(storeFailure)}, ${rejections("stub:k")}`);
}
console.log(`recall index: ${total} chunks, switching models checked`);
TS

# --- 2. The gateway's memory check says how many memories another model embedded.
# The stub answers any model; ollama:model-a gives 3 numbers, anything else 4.
STUB_PORT="${STUB_PORT}" node <<'NODE' >"${TEMP_RUNTIME}/stub.log" 2>&1 &
const { createServer } = require("node:http");
// Every embedding request is logged (arrival and answer time) for the pacing check (#157).
const state = { mode: "ok", requests: [], queue: Promise.resolve() };
createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk)).on("end", () => {
    if (req.url === "/_test/state") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ requests: state.requests })); return; }
    if (req.url === "/_test/mode") { state.mode = JSON.parse(raw).mode; res.writeHead(200); res.end("{}"); return; }
    const body = raw ? JSON.parse(raw) : {};
    const input = Array.isArray(body.input) ? body.input : [body.input];
    const request = { model: body.model, input, t: Date.now() };
    state.requests.push(request);
    if (state.mode === "reembed503" && !input.some((text) => String(text).includes("switch"))) {
      request.done = Date.now();
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "service unavailable" } }));
      return;
    }
    if (input.some((text) => String(text).includes("POISON-CHUNK"))) {
      request.done = Date.now();
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "input is too long for the context" } }));
      return;
    }
    const size = body.model === "model-a" ? 3 : 4;
    const answer = () => {
      request.done = Date.now();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: size }, (_, i) => (i === 0 ? 1 : 0)) })) }));
    };
    // One request at a time, 150 ms a chunk, like Ollama's default (#157).
    if (state.mode === "serial") { state.queue = state.queue.then(() => new Promise((resolve) => setTimeout(() => { answer(); resolve(); }, 150 * input.length))); return; }
    // model-slow answers after 12 s, as a cold model loading would: past the 10 s chat timeout.
    setTimeout(answer, body.model === "model-slow" ? 12_000 : 0);
  });
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");
NODE
stub_pid=$!
# The index now holds vectors from "stub:b"; re-embed them as ollama:model-a, as a saved setup would.
npx tsx - <<'TS'
import { backfillSqliteMemoryEmbeddings, createMemoryEmbeddingProvider, runtimePathsFromEnv } from "./packages/mindstone-core/src/index.ts";
const provider = createMemoryEmbeddingProvider({ memory: { embeddingProvider: "ollama:model-a" } } as never);
if (!provider) { console.error("no provider for ollama:model-a"); process.exit(1); }
const result = await backfillSqliteMemoryEmbeddings({ paths: runtimePathsFromEnv(), provider });
if (result.chunksEmbedded < 2) { console.error(`re-embedding as ollama:model-a failed: ${JSON.stringify(result)}`); process.exit(1); }
TS

python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "MS_TOKEN"}
c["gateway"]["admin"] = {"tokenEnv": "MS_ADMIN_TOKEN"}
c["memory"] = {"vectorStore": "sqlite-vec", "embeddingProvider": "ollama:model-a"}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
BASE="http://127.0.0.1:${GATEWAY_PORT}"
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done
BODY="${TEMP_RUNTIME}/body.json"
ADMIN=(-H "Authorization: Bearer ${MS_TOKEN}" -H "x-mindstone-admin-token: ${MS_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
post() { curl -s -o "${BODY}" -w '%{http_code}' -X POST "${ADMIN[@]}" -d "$2" "${BASE}$1"; }
[[ "$(post /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}')" == 200 ]] || { echo "granting advanced settings failed" >&2; exit 1; }
# judge <label> <js condition on b>: the answer in BODY, judged in node, so a missing field fails (never a shell error).
judge() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!(new Function("b", "return " + process.argv[2]))(b)) { console.error(process.argv[3] + ": " + JSON.stringify(b)); process.exit(1); }' "${BODY}" "$2" "$1"; }
[[ "$(post /admin/memory/check '{"embeddingProvider":"ollama:model-b"}')" == 200 ]] || { echo "checking model-b failed: $(cat "${BODY}")" >&2; exit 1; }
judge "the check for model-b should count every memory as another model's" 'b.ok === true && Number.isInteger(b.index?.embedded) && b.index.embedded >= 2 && b.index.otherModel === b.index.embedded'
[[ "$(post /admin/memory/check '{"embeddingProvider":"ollama:model-a"}')" == 200 ]] || { echo "checking model-a failed: $(cat "${BODY}")" >&2; exit 1; }
judge "the check for the model that embedded them should count none" 'b.ok === true && Number.isInteger(b.index?.embedded) && b.index.embedded >= 2 && b.index.otherModel === 0'
# A model that takes 12 s to answer (loading) still passes the check, which waits 45 s for it.
[[ "$(post /admin/memory/check '{"embeddingProvider":"ollama:model-slow"}')" == 200 ]] || { echo "checking model-slow failed: $(cat "${BODY}")" >&2; exit 1; }
judge "the check should wait for a model that takes 12 s to load" 'b.ok === true && b.dimensions === 4'

# --- 3. A switch in progress never slows a turn (#157). The index holds thousands of model-a
# chunks; on an embedder that answers one request at a time, each turn's query embedding waits
# behind one small request of them at most, none is sent while it waits, and the next turn
# never waits for them.
STUB="http://127.0.0.1:${STUB_PORT}"
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c["memory"]["embeddingProvider"] = "ollama:model-b"
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "switch"}}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
curl -s -X POST -d '{"mode":"serial"}' "${STUB}/_test/mode" >/dev/null
chat() { # chat <text>: prints the ms the gateway took to answer
  local started
  started=$(node -e 'console.log(Date.now())')
  curl -s --max-time 30 -o "${BODY}" -X POST -H "Authorization: Bearer ${MS_TOKEN}" -H 'content-type: application/json' -d "{\"text\":\"$1\"}" "${BASE}/chat/send" || { echo "chat \"$1\" failed or got no answer in 30 s" >&2; exit 1; }
  echo $(( $(node -e 'console.log(Date.now())') - started ))
}
chat "the first question after the switch" >/dev/null
judge "the first chat after the switch should be answered" 'b.ok === true'
sleep 2
turn_ms=()
for i in 1 2 3; do turn_ms+=("$(chat "question ${i} during the switch")"); sleep 0.5; done
node -e 'fetch(process.argv[1]).then((r)=>r.json()).then((s)=>{
  const b = s.requests.filter((q)=>q.model === "model-b");
  const queries = b.filter((q)=>q.input.length === 1 && /^question \d during the switch$/.test(q.input[0]));
  // Everything else sent for model-b that holds none of these chats text is the re-embed.
  const reembed = b.filter((q)=>!queries.includes(q) && !q.input.some((t)=>/switch/.test(t)) && q.input[0] !== "MindStone embedding health check");
  if (queries.length !== 3) { console.error(`expected 3 query embeddings, saw ${queries.length}: ${JSON.stringify(b.filter((q)=>!reembed.includes(q)).map((q)=>q.input))}`); process.exit(1); }
  const big = reembed.filter((q)=>q.input.length > 4).length;
  if (big) { console.error(`the re-embed sent ${big} requests of more than 4 chunks`); process.exit(1); }
  // The re-embed was running throughout: a request before the first query and between each two.
  const bounds = [0, ...queries.map((q)=>q.t)];
  for (let i = 1; i < bounds.length; i += 1) {
    if (!reembed.some((r)=>r.t > bounds[i - 1] && r.t < bounds[i])) { console.error(`no re-embed request before query ${i}: nothing was measured`); process.exit(1); }
  }
  for (const q of queries) {
    if (!(q.done >= q.t)) { console.error("a query embedding was never answered"); process.exit(1); }
    const sent = reembed.filter((r)=>r.t > q.t && r.t < q.done).length;
    if (sent) { console.error(`the re-embed sent ${sent} requests while a turn waited on the embedder`); process.exit(1); }
    // Behind one request of 4 at most: 600 ms, its own 150 ms, and 300 ms of slack (16 a request took 2.4 s).
    if (q.done - q.t > 1050) { console.error(`a turn waited ${q.done - q.t} ms for its query embedding`); process.exit(1); }
  }
  console.log(`query waits ${queries.map((q)=>q.done - q.t).join(", ")} ms; ${reembed.length} re-embed requests so far`);
})' "${STUB}/_test/state" || exit 1
# The turn itself: never the 5 s the next turn would wait if the re-embed held up the index update.
for ms in "${turn_ms[@]}"; do (( ms < 3000 )) || { echo "a turn took ${ms} ms during the switch (turns: ${turn_ms[*]})" >&2; exit 1; }; done
echo "turns during the switch: ${turn_ms[*]} ms"
# reembed_chunks [after ms]: chunks the re-embed sent for model-b (after that time, if given); as above.
reembed_chunks() { # reembed_chunks [after ms] [model, default model-b]
node -e 'fetch(process.argv[1]).then((r)=>r.json()).then((s)=>{
  const b = s.requests.filter((q)=>q.model === (process.argv[3] || "model-b") && q.t > Number(process.argv[2] || 0));
  const reembed = b.filter((q)=>!(q.input.length === 1 && /^question \d during the switch$/.test(q.input[0])) && !q.input.some((t)=>/switch/.test(t)) && q.input[0] !== "MindStone embedding health check");
  console.log(reembed.reduce((n, q)=>n + q.input.length, 0));
})' "${STUB}/_test/state" "${1:-0}" "${2:-}"; }
# One run does 128 at most: with the embedder fast again, the first run ends there, and nothing more
# is sent until a turn starts another run.
curl -s -X POST -d '{"mode":"ok"}' "${STUB}/_test/mode" >/dev/null
for _ in $(seq 1 60); do [[ "$(reembed_chunks)" -ge 128 ]] && break; sleep 0.5; done
sleep 1
first_run="$(reembed_chunks)"
[[ "${first_run}" == 128 ]] || { echo "one run should embed 128 of another model's chunks again: ${first_run}" >&2; exit 1; }
chat "a switch question after the first run" >/dev/null
for _ in $(seq 1 60); do [[ "$(reembed_chunks)" -gt 128 ]] && break; sleep 0.5; done
[[ "$(reembed_chunks)" -gt 128 ]] || { echo "a turn after the first run ended started no second run" >&2; exit 1; }
# A run stops when the config changes under it (#157 review): here the embedding model.
curl -s -X POST -d '{"mode":"serial"}' "${STUB}/_test/mode" >/dev/null
sleep 1
before_run3="$(reembed_chunks)"
chat "a switch question before the model changes again" >/dev/null
for _ in $(seq 1 20); do [[ "$(reembed_chunks)" -gt "${before_run3}" ]] && break; sleep 0.5; done
[[ "$(reembed_chunks)" -gt "${before_run3}" ]] || { echo "control: the third run sent nothing, so the config change can't be measured" >&2; exit 1; }
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c["memory"]["embeddingProvider"] = "ollama:model-c"
p.write_text(json.dumps(c, indent=2) + "\n")
PY
changed_at=$(node -e 'console.log(Date.now())')
sleep 3
# One request may have passed its check just before the change; nothing is sent after it.
late="$(reembed_chunks $((changed_at + 250)))"
[[ "${late}" == 0 ]] || { echo "the run sent ${late} chunks for the old model after the config changed" >&2; exit 1; }
third_run=$(( $(reembed_chunks) - before_run3 ))
(( third_run < 128 )) || { echo "control: the third run had already finished (${third_run} chunks) before the change" >&2; exit 1; }
echo "a run stopped at the config change after ${third_run} chunks"
# A stop isn't a failure (#157 review round 2): the next turn starts a run for the new model at once.
chat "a switch question once the model is model-c" >/dev/null
for _ in $(seq 1 20); do [[ "$(reembed_chunks 0 model-c)" -gt 0 ]] && break; sleep 0.5; done
[[ "$(reembed_chunks 0 model-c)" -gt 0 ]] || { echo "after a stop, the next turn started no run for the new model" >&2; exit 1; }
# Turning automatic recall off stops a run too.
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c["memory"]["autoRecall"] = False
p.write_text(json.dumps(c, indent=2) + "\n")
PY
off_at=$(node -e 'console.log(Date.now())')
sleep 3
late_c="$(reembed_chunks $((off_at + 250)) model-c)"
[[ "${late_c}" == 0 ]] || { echo "the run sent ${late_c} chunks after automatic recall was turned off" >&2; exit 1; }
c_run="$(reembed_chunks 0 model-c)"
(( c_run < 128 )) || { echo "control: the model-c run had already finished (${c_run} chunks) before recall was turned off" >&2; exit 1; }
echo "a run stopped when recall was turned off after ${c_run} chunks"
# A registered endpoint whose key changes under the same model name stops a run too (#157 review
# round 3): the run's embedder is the one resolved when it started, address and key included.
STUB_PORT="${STUB_PORT}" python3 - <<'PY'
import json, os, pathlib
agent = pathlib.Path(os.environ["PI_CODING_AGENT_DIR"])
agent.mkdir(parents=True, exist_ok=True)
models = agent / "models.json"
m = json.loads(models.read_text()) if models.exists() else {}
m.setdefault("providers", {})["enterprise-openai"] = {"baseUrl": "http://127.0.0.1:" + os.environ["STUB_PORT"] + "/v1"}
models.write_text(json.dumps(m, indent=2) + "\n")
auth = agent / "auth.json"
a = json.loads(auth.read_text()) if auth.exists() else {}
a["enterprise-openai"] = {"type": "api_key", "key": "synthetic-endpoint-key-a"}
auth.write_text(json.dumps(a, indent=2) + "\n")
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c["memory"]["embeddingProvider"] = "enterprise-openai:model-e"
c["memory"].pop("autoRecall", None)
p.write_text(json.dumps(c, indent=2) + "\n")
PY
chat "a switch question once the model is model-e" >/dev/null
for _ in $(seq 1 20); do [[ "$(reembed_chunks 0 model-e)" -gt 0 ]] && break; sleep 0.5; done
[[ "$(reembed_chunks 0 model-e)" -gt 0 ]] || { echo "control: no run started for the registered endpoint, so a key change can't be measured" >&2; exit 1; }
python3 - <<'PY'
import json, os, pathlib
auth = pathlib.Path(os.environ["PI_CODING_AGENT_DIR"]) / "auth.json"
a = json.loads(auth.read_text())
a["enterprise-openai"]["key"] = "synthetic-endpoint-key-b"
auth.write_text(json.dumps(a, indent=2) + "\n")
PY
key_at=$(node -e 'console.log(Date.now())')
sleep 3
late_e="$(reembed_chunks $((key_at + 250)) model-e)"
[[ "${late_e}" == 0 ]] || { echo "the run sent ${late_e} chunks with the old key after the key changed" >&2; exit 1; }
e_run="$(reembed_chunks 0 model-e)"
(( e_run < 128 )) || { echo "control: the model-e run had already finished (${e_run} chunks) before the key changed" >&2; exit 1; }
echo "a run stopped when the endpoint key changed after ${e_run} chunks"
# And when its address changes (#157 review round 4): the same stub under another name, so a run
# that didn't notice would go on sending.
before_addr="$(reembed_chunks 0 model-e)"
chat "a switch question with the new endpoint key" >/dev/null
for _ in $(seq 1 20); do [[ "$(reembed_chunks 0 model-e)" -gt "${before_addr}" ]] && break; sleep 0.5; done
[[ "$(reembed_chunks 0 model-e)" -gt "${before_addr}" ]] || { echo "control: no run started with the new key, so an address change can't be measured" >&2; exit 1; }
STUB_PORT="${STUB_PORT}" python3 - <<'PY'
import json, os, pathlib
models = pathlib.Path(os.environ["PI_CODING_AGENT_DIR"]) / "models.json"
m = json.loads(models.read_text())
m["providers"]["enterprise-openai"]["baseUrl"] = "http://localhost:" + os.environ["STUB_PORT"] + "/v1"
models.write_text(json.dumps(m, indent=2) + "\n")
PY
addr_at=$(node -e 'console.log(Date.now())')
sleep 3
late_addr="$(reembed_chunks $((addr_at + 250)) model-e)"
[[ "${late_addr}" == 0 ]] || { echo "the run sent ${late_addr} chunks to the old address after it changed" >&2; exit 1; }
addr_run=$(( $(reembed_chunks 0 model-e) - before_addr ))
(( addr_run < 128 )) || { echo "control: that run had already finished (${addr_run} chunks) before the address changed" >&2; exit 1; }
echo "a run stopped when the endpoint address changed after ${addr_run} chunks"

# --- 4. Another model's chunk the new embedder refuses never costs a turn its own vectors (Hearth's
# #167 review, #155 item 2): the turn's update leaves other models' chunks to the paced run. That run
# sends the refused request's chunks one at a time and goes on (#170), and a run that fails (the
# embedder down) is left alone for a while (a minute), so the turns right after it don't retry it.
STUB_PORT="${STUB_PORT}" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c["memory"]["embeddingProvider"] = "ollama:model-f"
c["memory"].pop("autoRecall", None)
p.write_text(json.dumps(c, indent=2) + "\n")
PY
curl -s -X POST -d '{"mode":"ok"}' "${STUB}/_test/mode" >/dev/null
# The newest chunk another model made, so every batch of another model's chunks starts with it.
npx tsx - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { runtimePathsFromEnv, sqliteMemoryDatabasePath } from "./packages/mindstone-core/src/index.ts";
const db = new DatabaseSync(sqliteMemoryDatabasePath(runtimePathsFromEnv()));
db.prepare("INSERT INTO memory_sources (id, kind, path, title, timestamp, content_hash, metadata_json, updated_at) VALUES ('poison', 'memory', NULL, NULL, NULL, 'poison-hash', '{}', '2099-01-01T00:00:00.000Z')").run();
db.prepare("INSERT INTO memory_chunks (chunk_id, source_id, kind, path, title, ordinal, text, token_estimate, embedding_json, embedding_spec, metadata_json, updated_at) VALUES ('poison#0', 'poison', 'memory', NULL, NULL, 0, 'an old note, POISON-CHUNK, too long for the new model', 8, '[1,0,0,0]', 'ollama:model-old', '{}', '2099-01-01T00:00:00.000Z')").run();
db.close();
TS
poison_sent() { node -e 'fetch(process.argv[1]).then((r)=>r.json()).then((s)=>console.log(s.requests.filter((q)=>q.input.some((t)=>String(t).includes("POISON-CHUNK"))).length))' "${STUB}/_test/state"; }
chat "a switch question: the vault code is TOKEN-157Q" >/dev/null
judge "the chat with an unembeddable old chunk around should be answered" 'b.ok === true'
# The turn's own chunks get vectors from the new model, though the old chunk can't be embedded.
tokens_embedded() { npx tsx - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { runtimePathsFromEnv, sqliteMemoryDatabasePath } from "./packages/mindstone-core/src/index.ts";
const db = new DatabaseSync(sqliteMemoryDatabasePath(runtimePathsFromEnv()));
const rows = db.prepare("SELECT embedding_json AS e, embedding_spec AS spec FROM memory_chunks WHERE text LIKE '%TOKEN-157Q%'").all() as Array<{ e: string | null; spec: string | null }>;
db.close();
console.log(rows.length > 0 && rows.every((row) => row.e !== null && row.spec === "ollama:model-f") ? "yes" : `no ${JSON.stringify(rows.map((row) => row.spec))}`);
TS
}
for _ in $(seq 1 20); do [[ "$(tokens_embedded)" == yes ]] && break; sleep 0.5; done
state="$(tokens_embedded)"
[[ "${state}" == yes ]] || { echo "the turn's own chunks weren't embedded because another model's chunk was refused: ${state}" >&2; exit 1; }
# The paced run sent the refused chunk twice (in its request of 4, then alone) and went on (#170).
for _ in $(seq 1 20); do [[ "$(poison_sent)" -ge 2 ]] && break; sleep 0.5; done
first_poison="$(poison_sent)"
[[ "${first_poison}" == 2 ]] || { echo "the paced run should send the refused chunk in its request, then alone: ${first_poison}" >&2; exit 1; }
# The gateway logs it.
for _ in $(seq 1 20); do grep -q "the embedding model refused 1 memory chunks while embedding them again" "${TEMP_RUNTIME}/gateway.log" && break; sleep 0.5; done
grep -q "the embedding model refused 1 memory chunks while embedding them again" "${TEMP_RUNTIME}/gateway.log" || { echo "the gateway should log the paced run's refusal" >&2; exit 1; }
model_f_others() { npx tsx - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { runtimePathsFromEnv, sqliteMemoryDatabasePath } from "./packages/mindstone-core/src/index.ts";
const db = new DatabaseSync(sqliteMemoryDatabasePath(runtimePathsFromEnv()));
const row = db.prepare("SELECT count(*) AS n FROM memory_chunks WHERE embedding_spec = 'ollama:model-f' AND text NOT LIKE '%switch%'").get() as { n: number };
db.close();
console.log(Number(row.n));
TS
}
for _ in $(seq 1 20); do [[ "$(model_f_others)" -ge 3 ]] && break; sleep 0.5; done
[[ "$(model_f_others)" -ge 3 ]] || { echo "the paced run stopped at the refused chunk instead of embedding the rest: $(model_f_others)" >&2; exit 1; }
# The next runs go on with the others: the refused chunk goes last, so it isn't sent again yet.
progress_before="$(model_f_others)"
chat "a switch question after the refused chunk" >/dev/null
for _ in $(seq 1 20); do [[ "$(model_f_others)" -gt "${progress_before}" ]] && break; sleep 0.5; done
[[ "$(model_f_others)" -gt "${progress_before}" ]] || { echo "the next run made no progress after a refused chunk" >&2; exit 1; }
[[ "$(poison_sent)" == 2 ]] || { echo "the refused chunk should go last, not head the next run: $(poison_sent) sends" >&2; exit 1; }
echo "a refused old chunk cost only itself: the turn and the runs went on"
# A run that fails (the embedder down for everything but the turn's own chunks) is left alone: the two
# turns right after it don't retry it (the pause is a minute; this covers the next few seconds).
reembed_sent() { node -e 'fetch(process.argv[1]).then((r)=>r.json()).then((s)=>console.log(s.requests.filter((q)=>q.model === "model-f" && !q.input.some((t)=>String(t).includes("switch"))).length))' "${STUB}/_test/state"; }
curl -s -X POST -d '{"mode":"reembed503"}' "${STUB}/_test/mode" >/dev/null
before_down="$(reembed_sent)"
chat "a switch question while the embedder is down for the rest" >/dev/null
for _ in $(seq 1 20); do [[ "$(reembed_sent)" -gt "${before_down}" ]] && break; sleep 0.5; done
failed_at="$(reembed_sent)"
[[ "${failed_at}" -gt "${before_down}" ]] || { echo "control: no run was tried while the embedder was down" >&2; exit 1; }
sleep 1
chat "a switch question right after the failed run" >/dev/null
sleep 1
chat "another switch question right after the failed run" >/dev/null
sleep 2
[[ "$(reembed_sent)" == "${failed_at}" ]] || { echo "the turns right after a failed run retried it: $(reembed_sent) requests, ${failed_at} after the failure" >&2; exit 1; }
curl -s -X POST -d '{"mode":"ok"}' "${STUB}/_test/mode" >/dev/null
echo "a failed run wasn't retried by the turns right after it"
# The count of chunks a model can't embed is reported (#170): the memory check and memory status.
# The refused chunk has 1 refusal so far (the paced run's); make it the last one of MEMORY_EMBED_SKIP_AFTER.
npx tsx - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { MEMORY_EMBED_SKIP_AFTER, runtimePathsFromEnv, sqliteMemoryDatabasePath } from "./packages/mindstone-core/src/index.ts";
const db = new DatabaseSync(sqliteMemoryDatabasePath(runtimePathsFromEnv()));
const changed = db.prepare("UPDATE memory_embed_rejections SET failures = ? WHERE chunk_id = 'poison#0' AND spec = 'ollama:model-f'").run(MEMORY_EMBED_SKIP_AFTER);
db.close();
if (Number(changed.changes) !== 1) { console.error("control: the paced run recorded no refusal for the refused chunk"); process.exit(1); }
TS
[[ "$(post /admin/memory/check '{"embeddingProvider":"ollama:model-f"}')" == 200 ]] || { echo "checking model-f failed: $(cat "${BODY}")" >&2; exit 1; }
judge "the memory check should count the chunk model-f can't embed" 'b.ok === true && b.index?.skipped === 1'
[[ "$(post /admin/memory/check '{"embeddingProvider":"ollama:model-a"}')" == 200 ]] || { echo "checking model-a failed: $(cat "${BODY}")" >&2; exit 1; }
judge "a chunk model-f refused isn't skipped for model-a" 'b.ok === true && b.index?.skipped === 0'
./scripts/mindstone memory status --json > "${BODY}"
judge "memory status should report the chunk the configured model can't embed" 'b.embeddingModel?.spec === "ollama:model-f" && b.embeddingModel?.skippedChunks === 1'
./scripts/mindstone memory status | grep -q "Chunks ollama:model-f refused 3 or more times, skipped (found by their words, tried again a day after): 1" || { echo "memory status should print the skipped count" >&2; exit 1; }
echo "the count of chunks a model can't embed is reported"
# A turn's own chunk the embedder refuses is logged by the turn's update.
chat "a switch question about POISON-CHUNK in a turn" >/dev/null
for _ in $(seq 1 20); do grep -q "memory chunks in this turn's index update" "${TEMP_RUNTIME}/gateway.log" && break; sleep 0.5; done
turn_refused="$(npx tsx - <<'TS'
import { DatabaseSync } from "node:sqlite";
import { runtimePathsFromEnv, sqliteMemoryDatabasePath } from "./packages/mindstone-core/src/index.ts";
const db = new DatabaseSync(sqliteMemoryDatabasePath(runtimePathsFromEnv()));
const row = db.prepare("SELECT count(*) AS n FROM memory_chunks WHERE text LIKE '%POISON-CHUNK in a turn%'").get() as { n: number };
db.close();
console.log(Number(row.n));
TS
)"
(( turn_refused > 0 )) || { echo "control: the turn about POISON-CHUNK wasn't indexed" >&2; exit 1; }
grep -q "the embedding model refused ${turn_refused} memory chunks in this turn's index update" "${TEMP_RUNTIME}/gateway.log" || { echo "the gateway should log the turn's ${turn_refused} refused chunks: $(grep "this turn's index update" "${TEMP_RUNTIME}/gateway.log")" >&2; exit 1; }
# memory backfill --embed prints how many chunks the embedder refused.
./scripts/mindstone memory backfill --embed > "${TEMP_RUNTIME}/backfill.out" 2>&1 || { echo "memory backfill --embed failed: $(tail -5 "${TEMP_RUNTIME}/backfill.out")" >&2; exit 1; }
# Every refused chunk is held back now (just refused, or skipped), so none is sent and none refused.
grep -q "^Chunks the embedder refused: 0$" "${TEMP_RUNTIME}/backfill.out" || { echo "memory backfill --embed should print the refused count: $(cat "${TEMP_RUNTIME}/backfill.out")" >&2; exit 1; }
echo "refusals are logged and printed"

echo "Memory embedding model switch smoke test passed."
