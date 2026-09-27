#!/usr/bin/env bash
# Chat completions transcript dedup (#38): clients such as LibreChat resend the whole
# conversation every turn. The gateway must store each user message once (only the new
# turn), keep the reply, and not re-store resent history or a client system prompt.
# Binds gateway port base+25 — serialize per smoke protocol.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-dedup-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 25))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
cd "${PROJECT_ROOT}"
echo "== Chat completions dedup smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-dedup-init.log
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "none"}
c["gateway"].setdefault("http", {}).setdefault("chatCompletions", {})["enabled"] = True
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "dedup-smoke"}}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
./scripts/start-gateway.sh >/tmp/mindstone-agent-dedup-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
// A Console "user": resent history and the client system prompt are not stored.
const headers = { "content-type": "application/json", "x-mindstone-user-id": "dedup-user", "x-mindstone-user-role": "user", "x-mindstone-conversation-id": "conv-1" };
const fail = (m) => { console.error(m); process.exit(1); };
const history = [{ role: "system", content: "CLIENT-SYSTEM-PROMPT" }];
let sessionKey;
for (const n of [1, 2, 3]) {
  history.push({ role: "user", content: `turn ${n} TURN-${n}` });
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "mindstone/default", messages: history }) });
  const body = await response.json();
  if (response.status !== 200) fail(`turn ${n}: ${response.status} ${JSON.stringify(body)}`);
  sessionKey = body.mindstone?.sessionKey;
  history.push({ role: "assistant", content: body.choices[0].message.content });
}
// A turn that ends with two new user messages stores both.
history.push({ role: "user", content: "TURN-4a" }, { role: "user", content: "TURN-4b" });
let response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "mindstone/default", messages: history }) });
if (response.status !== 200) fail(`turn 4: ${response.status}`);

const historyResponse = await fetch(`${base}/chat/history?sessionKey=${encodeURIComponent(sessionKey)}`);
const { entries } = await historyResponse.json();
const users = entries.filter((e) => e.role === "user").map((e) => e.text);
const count = (needle) => entries.filter((e) => (e.text ?? "").includes(needle)).length;
for (const n of [1, 2, 3]) {
  if (count(`TURN-${n}`) < 1) fail(`TURN-${n} was not stored`);
  if (users.filter((t) => t.includes(`TURN-${n}`)).length !== 1) fail(`TURN-${n} stored ${users.filter((t) => t.includes(`TURN-${n}`)).length} times as a user message:\n${users.join("\n")}`);
}
if (users.filter((t) => t.includes("TURN-4a")).length !== 1 || users.filter((t) => t.includes("TURN-4b")).length !== 1) fail("both new user messages of turn 4 should be stored once");
if (count("CLIENT-SYSTEM-PROMPT") !== 0) fail("a Console user's system prompt was stored");
const ignoredEvents = entries.filter((e) => e.metadata?.event === "client_system_prompt_ignored");
if (ignoredEvents.length !== 1) fail(`the ignored system prompt should be logged once, got ${ignoredEvents.length}`);
const assistants = entries.filter((e) => e.role === "assistant");
if (assistants.length !== 4) fail(`expected 4 stored replies, got ${assistants.length}`);
const skipped = entries.find((e) => e.role === "user" && (e.text ?? "").includes("TURN-3"))?.metadata?.resentMessagesSkipped;
if (skipped !== 4) fail(`TURN-3 should record 4 resent messages skipped (system prompts don't count), got ${skipped}`);
// An admin or direct API caller (no forwarded role): the system prompt is kept, once.
{
  const adminHeaders = { "content-type": "application/json", "x-mindstone-user-id": "dedup-admin" };
  const conv = [{ role: "system", content: "ADMIN-SYSTEM-PROMPT" }];
  let key;
  for (const n of [1, 2, 3]) {
    conv.push({ content: `admin turn ${n} ADMIN-TURN-${n}` }); // no role: counts as user
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ model: "mindstone/default", messages: conv }) });
    const b = await r.json();
    if (r.status !== 200) fail(`admin turn ${n}: ${r.status} ${JSON.stringify(b)}`);
    key = b.mindstone?.sessionKey;
    conv.push({ role: "assistant", content: b.choices[0].message.content });
  }
  const adminEntries = (await (await fetch(`${base}/chat/history?sessionKey=${encodeURIComponent(key)}`)).json()).entries;
  const systems = adminEntries.filter((e) => e.role === "system" && (e.text ?? "").includes("ADMIN-SYSTEM-PROMPT"));
  if (systems.length !== 1) fail(`an admin's system prompt should be stored once, got ${systems.length}`);
  for (const n of [1, 2, 3]) {
    if (adminEntries.filter((e) => e.role === "user" && (e.text ?? "").includes(`ADMIN-TURN-${n}`)).length !== 1) fail(`ADMIN-TURN-${n} (no role) should be stored once as a user message`);
  }
}

// A request that doesn't end with a user message is rejected.
response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { ...headers, "x-mindstone-user-id": "dedup-other" }, body: JSON.stringify({ model: "mindstone/default", messages: [{ role: "user", content: "TAIL-REJECT" }, { role: "assistant", content: "prefill" }] }) });
if (response.status !== 400) fail(`a request ending in an assistant message should be 400, got ${response.status}`);
console.log(`dedup assertions passed: ${users.length} user entries, ${assistants.length} replies`);
NODE
# --- Separate Console conversations: separate sessions, one memory ---
kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; unset gateway_pid
export CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
c["routing"]["mock"]["captureFile"] = os.environ["CAPTURE"]
c["memory"] = {**c.get("memory", {}), "autoRecall": True, "vectorStore": "sqlite-vec", "recall": {"maxResults": 5, "maxPromptTokens": 800, "minScore": 0.05}}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
./scripts/start-gateway.sh >>/tmp/mindstone-agent-dedup-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
ask() { curl -s -H 'content-type: application/json' -H 'x-mindstone-user-id: console-user' -H 'x-mindstone-user-role: admin' -H "x-mindstone-conversation-id: $1" -d "{\"model\":\"mindstone/default\",\"messages\":[{\"role\":\"user\",\"content\":\"$2\"}]}" "http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions"; }
KEY_A="$(ask conv-A 'Remember this: the osprey vault code is OSPREY-FACT-9911.' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).mindstone.sessionKey))')"
./scripts/mindstone memory backfill >/tmp/mindstone-agent-dedup-backfill.log
: > "${CAPTURE}"
KEY_B="$(ask conv-B 'What is the osprey vault code?' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).mindstone.sessionKey))')"
KEY_A="${KEY_A}" KEY_B="${KEY_B}" node <<'NODE'
const { readFileSync } = require("node:fs");
const fail = (m) => { console.error(m); process.exit(1); };
if (!process.env.KEY_A || process.env.KEY_A === process.env.KEY_B) fail(`two Console conversations must get two sessions: ${process.env.KEY_A} / ${process.env.KEY_B}`);
if (!process.env.KEY_B.includes("console")) fail(`unexpected Console session key ${process.env.KEY_B}`);
const request = JSON.parse(readFileSync(process.env.CAPTURE, "utf8").trim().split("\n").pop());
const history = request.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => m.text ?? "").join("\n");
const all = request.messages.map((m) => m.text ?? "").join("\n");
if (history.includes("Remember this")) fail("conversation B's history contains conversation A's turn: the sessions are shared");
if (!all.includes("OSPREY-FACT-9911")) fail(`conversation B's prompt should recall the fact said in conversation A:\n${all}`);
console.log("separate conversations, one memory: passed");
NODE
echo "Chat completions dedup smoke test passed."
