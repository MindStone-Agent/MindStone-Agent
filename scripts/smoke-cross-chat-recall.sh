#!/usr/bin/env bash
# Cross-chat recall (#106): with automatic recall on, a fact the owner tells
# the agent in one Console chat is recalled in a new chat, with no manual
# backfill. The gateway indexes each turn as it is written.
#   - chat 1 plants a fact; a new chat 2 gets it through recall, and the
#     gateway transcript's recall event points at chat 1
#   - a Console user's chat is never indexed into the owner's recall
#   - with recall off, the fact doesn't carry over (control)
#   - an embedder that fails for a turn doesn't fail the reply, and the
#     missed turn is indexed with the next one
# Binds gateway port base+31 and an embedding stub on base+32; serialize per
# smoke protocol. Synthetic secrets only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-cross-chat-recall-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 31))"
STUB_PORT="$((SMOKE_PORT_BASE + 32))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${stub_pid:-}" ]]; then kill "${stub_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export RECALL_TOKEN="cross-chat-recall-smoke-service-token"
export RECALL_ADMIN_TOKEN="cross-chat-recall-smoke-admin-token"
export EMBEDDER_BASE_URL="http://127.0.0.1:${STUB_PORT}/v1"
export CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
cd "${PROJECT_ROOT}"
echo "== Cross-chat recall smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
BASE="http://127.0.0.1:${GATEWAY_PORT}"
BODY="${TEMP_RUNTIME}/body.json"

# --- 0. Unit: a Console user's turn in an older transcript (no ownerTurn
# recorded) is known by its session key and left out of the index.
npx tsx -e '
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexSqliteMemoryTurn, runtimePathsFromEnv, sqliteMemoryDatabasePath } from "./packages/mindstone-core/src/index.ts";
(async () => {
const paths = runtimePathsFromEnv();
mkdirSync(paths.transcriptDir, { recursive: true });
const file = join(paths.transcriptDir, "legacy-unit.jsonl");
const entry = (id, sessionKey, text) => JSON.stringify({ id, sessionKey, agentId: "default", role: "user", text, timestamp: "t", source: { substrate: "openai", channel: "openai-chat-completions", chatType: "internal" } });
writeFileSync(file, [entry("a", "agent:console:console:non-owner%3Ajo:c1", "LEGACY-USER-7123"), entry("b", "agent:console:console:admin:c2", "LEGACY-OWNER-7124")].join("\n") + "\n");
await indexSqliteMemoryTurn({ transcriptFile: file, config: { memory: { vectorStore: "sqlite-vec" } } });
const db = new DatabaseSync(sqliteMemoryDatabasePath(paths));
const texts = db.prepare("SELECT text FROM memory_chunks").all().map((row) => row.text).join(" ");
db.close();
if (!texts.includes("LEGACY-OWNER-7124")) { console.error("control: an owner turn should be indexed"); process.exit(1); }
if (texts.includes("LEGACY-USER-7123")) { console.error("an older Console user turn was indexed into the owner recall"); process.exit(1); }
rmSync(file);
rmSync(sqliteMemoryDatabasePath(paths));
})().catch((error) => { console.error(error); process.exit(1); });
' || exit 1

# The embedding stub: shared words give similar vectors (hashed bag of words),
# so recall ranks like a real embedder would for these sentences, and it takes
# 0.6 s per call. POST /fail
# and /heal switch it between failing and answering.
STUB_PORT="${STUB_PORT}" node <<'NODE' >"${TEMP_RUNTIME}/stub.log" 2>&1 &
const { createServer } = require("node:http");
let failing = false;
const embed = (text) => {
  const v = new Array(64).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
};
createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk)).on("end", () => {
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/fail") { failing = true; return send(200, { ok: true }); }
    if (req.url === "/heal") { failing = false; return send(200, { ok: true }); }
    if (req.url === "/v1/embeddings") {
      if (failing) return send(500, { error: { message: "embedder down" } });
      const body = raw ? JSON.parse(raw) : {};
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      // About as slow as a real local embedder.
      return setTimeout(() => send(200, { data: inputs.map((text, index) => ({ index, embedding: embed(text) })) }), 600);
    }
    send(404, { error: "not found" });
  });
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");
NODE
stub_pid=$!

python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "RECALL_TOKEN"}
c["gateway"]["admin"] = {"tokenEnv": "RECALL_ADMIN_TOKEN"}
c["gateway"]["http"] = {"chatCompletions": {"enabled": True}}
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "recall", "captureFile": os.environ["CAPTURE"]}}
c["memory"] = {"autoRecall": True, "vectorStore": "sqlite-vec", "embeddingProvider": "ollama:nomic-embed-text"}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:${STUB_PORT}/heal" -X POST && break; sleep 0.25; done

./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

ADMIN=(-H "Authorization: Bearer ${RECALL_TOKEN}" -H "x-mindstone-admin-token: ${RECALL_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
patch() { curl -s -o "${BODY}" -w '%{http_code}' -X PATCH "${ADMIN[@]}" -d "$2" "${BASE}/admin/config/$1"; }
# chat <role> <user> <conversation> <text>: the model's prompt lands in ${TEMP_RUNTIME}/<conversation>.prompt
chat() {
  : > "${CAPTURE}"
  local payload code
  payload="$(TEXT="$4" node -e 'process.stdout.write(JSON.stringify({ model: "mindstone/default", messages: [{ role: "user", content: process.env.TEXT }] }))')"
  code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${RECALL_TOKEN}" -H 'content-type: application/json' \
    -H "x-mindstone-user-role: $1" -H "x-mindstone-user-id: $2" -H "x-mindstone-conversation-id: $3" -d "${payload}" "${BASE}/v1/chat/completions")"
  [[ "${code}" == 200 ]] || { echo "chat $3 failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
  node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); process.stdout.write(JSON.parse(l.pop()).messages.map((m)=>m.text??"").join("\n"))' "${CAPTURE}" > "${TEMP_RUNTIME}/$3.prompt"
}
prompt_has() { grep -q "$2" "${TEMP_RUNTIME}/$1.prompt"; }

# --- 1. A fact told in chat 1 is recalled in a new chat 2, asked right away.
# First, a Console user tells the agent something in their own chat.
chat user smoke-user conv-user "Remember this: my dog's name is ZEBRA-5521."
# Like a real install, the index already holds embedded owner chats, so a
# fact that isn't embedded yet can't be found by the lexical fallback.
chat admin smoke-admin conv-earlier "Hello, my name is Sam and I like tea."
sleep 2
chat admin smoke-admin conv-plant "Remember this: my dog's name is BISCUIT-9431."
chat admin smoke-admin conv-ask "What is my dog's name?"
prompt_has conv-ask 'BISCUIT-9431' || { echo "a new chat should recall the fact from the owner's earlier chat" >&2; exit 1; }
prompt_has conv-plant 'BISCUIT-9431' && ! prompt_has conv-ask 'Remember this: my dog' && { echo "control: the fact should reach chat 2 only through recall" >&2; exit 1; }
# --- 2. A Console user's chat never reaches the owner's recall.
prompt_has conv-ask 'ZEBRA-5521' && { echo "a Console user's chat reached the owner's recall" >&2; exit 1; }
# The recall is on record in the gateway transcript, pointing at chat 1.
DIR="${DATA}/transcripts" node -e '
const fs = require("fs"), path = require("path");
const entries = fs.readdirSync(process.env.DIR).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => fs.readFileSync(path.join(process.env.DIR, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((e) => String(e.sessionKey).endsWith(":conv-ask"));
const recall = entries.find((e) => e.metadata?.event === "memory_recall" || /recalled memory chunk/.test(e.text ?? ""));
if (!recall) { console.error("no recall event in the new chat transcript: " + JSON.stringify(entries.map((e) => e.metadata?.event ?? e.role))); process.exit(1); }
const hits = JSON.stringify(recall.metadata?.hits ?? []);
if (!hits.includes("conv-plant")) { console.error("the recall event should point at chat 1: " + hits.slice(0, 400)); process.exit(1); }
if (hits.includes("conv-user")) { console.error("the recall event points at a Console user chat"); process.exit(1); }
'

# --- 3. An embedder failure doesn't fail the reply; the missed turn is indexed with the next one.
curl -s -o /dev/null -X POST "http://127.0.0.1:${STUB_PORT}/fail"
chat admin smoke-admin conv-down "Remember this: my falcon is called FALCON-7788."
# Heal only once the index update for that turn has failed.
for _ in $(seq 1 40); do grep -q 'recall index update failed' "${TEMP_RUNTIME}/gateway.log" && break; sleep 0.25; done
curl -s -o /dev/null -X POST "http://127.0.0.1:${STUB_PORT}/heal"
chat admin smoke-admin conv-between "Good morning."
chat admin smoke-admin conv-falcon "What is my falcon called?"
prompt_has conv-falcon 'FALCON-7788' || { echo "a turn missed while the embedder was down should be indexed with the next turn" >&2; exit 1; }
grep -q 'recall index update failed' "${TEMP_RUNTIME}/gateway.log" || { echo "control: the embedder failure should have been logged" >&2; exit 1; }

# --- 4. With recall off, the fact doesn't carry over (turning it off needs no permission).
code="$(patch memory '{"autoRecall":false}')"
[[ "${code}" == 200 ]] || { echo "turning recall off should work without the permission: ${code} $(cat "${BODY}")" >&2; exit 1; }
chat admin smoke-admin conv-off "What is my dog's name?"
prompt_has conv-off 'BISCUIT-9431' && { echo "with recall off, a new chat still got the earlier fact" >&2; exit 1; }

echo "Cross-chat recall smoke test passed."
