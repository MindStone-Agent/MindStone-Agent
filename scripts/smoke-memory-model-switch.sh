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
import {
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
      v[/lighthouse/i.test(text) ? 0 : /zebraword/i.test(text) ? 2 : 1] = 1;
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
console.log(`recall index: ${total} chunks, switching models checked`);
TS

# --- 2. The gateway's memory check says how many memories another model embedded.
# The stub answers any model; ollama:model-a gives 3 numbers, anything else 4.
STUB_PORT="${STUB_PORT}" node <<'NODE' >"${TEMP_RUNTIME}/stub.log" 2>&1 &
const { createServer } = require("node:http");
createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk)).on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const size = body.model === "model-a" ? 3 : 4;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: Array.from({ length: size }, (_, i) => (i === 0 ? 1 : 0)) })) }));
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

echo "Memory embedding model switch smoke test passed."
