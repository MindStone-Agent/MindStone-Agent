#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-unified-session-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 7))"
CANONICAL_SESSION_KEY="agent:default:main"
LEGACY_SESSION_ALIAS="mindstone"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export CANONICAL_SESSION_KEY
export LEGACY_SESSION_ALIAS

cd "${PROJECT_ROOT}"

echo "== Unified session/transcript invariant smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

python3 - <<'PY'
import json, os, pathlib
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
gateway = config.setdefault("gateway", {})
http = gateway.setdefault("http", {})
http.setdefault("chatCompletions", {})["enabled"] = True
http.setdefault("responses", {})["enabled"] = True
gateway["auth"] = {"mode": "none"}
config.setdefault("session", {})["mode"] = "single"
config["session"]["defaultSessionKey"] = "agent:default:main"
config.setdefault("routing", {})["mode"] = "placeholder"
config["routing"]["defaultAgentId"] = "default"
config["routing"]["defaultModel"] = "mindstone/default"
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY

./scripts/start-gateway.sh >/tmp/mindstone-agent-unified-session-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const canonicalSessionKey = process.env.CANONICAL_SESSION_KEY;
const legacyAlias = process.env.LEGACY_SESSION_ALIAS;

async function request(path, init, expectedStatus) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  return body;
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}/rpc`);
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
}

function wsCall(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 5000);
    const onMessage = (event) => {
      const body = JSON.parse(String(event.data));
      if (body.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      console.log(`${method} ->`);
      console.log(JSON.stringify(body, null, 2));
      resolve(body);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const rest = await request(
  "/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "default", text: "rest default continuity" }),
  },
  501,
);
if (rest.entries?.[0]?.sessionKey !== canonicalSessionKey) process.exit(1);
if (rest.entries?.[0]?.source?.substrate !== "gateway-rest") process.exit(1);

const rpc = await request(
  "/rpc",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "rpc-1", method: "chat.send", params: { agentId: "default", message: "rpc default continuity" } }),
  },
  200,
);
if (rpc.result?.entries?.[0]?.sessionKey !== canonicalSessionKey) process.exit(1);
if (rpc.result?.entries?.[0]?.source?.substrate !== "gateway-rpc") process.exit(1);

const ws = await openSocket();
const wsSent = await wsCall(ws, "ws-1", "chat.send", { agentId: "default", message: "ws default continuity" });
if (wsSent.result?.entries?.[0]?.sessionKey !== canonicalSessionKey) process.exit(1);
if (wsSent.result?.entries?.[0]?.source?.substrate !== "gateway-rpc") process.exit(1);
ws.close();

const openai = await request(
  "/v1/chat/completions",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mindstone/default",
      metadata: { agentId: "default" },
      messages: [{ role: "user", content: "openai default continuity" }],
    }),
  },
  501,
);
if (openai.mindstone?.sessionKey !== canonicalSessionKey) process.exit(1);
if (openai.mindstone?.entries?.[0]?.source?.substrate !== "openai") process.exit(1);
if (openai.mindstone?.entries?.[0]?.source?.channel !== "openai-chat-completions") process.exit(1);

const responses = await request(
  "/v1/responses",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mindstone/default",
      metadata: { agentId: "default" },
      input: "responses default continuity",
    }),
  },
  501,
);
if (responses.mindstone?.sessionKey !== canonicalSessionKey) process.exit(1);
if (responses.mindstone?.entries?.[0]?.source?.substrate !== "openai") process.exit(1);
if (responses.mindstone?.entries?.[0]?.source?.channel !== "openai-responses") process.exit(1);

const aliasInject = await request(
  "/chat/inject",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "default", sessionKey: legacyAlias, role: "assistant", text: "legacy alias continuity" }),
  },
  201,
);
if (aliasInject.entry?.sessionKey !== canonicalSessionKey) process.exit(1);

const sessions = await request("/chat/sessions", undefined, 200);
if (!Array.isArray(sessions.sessions) || sessions.sessions.length !== 1) process.exit(1);
if (sessions.sessions[0].sessionKey !== canonicalSessionKey) process.exit(1);
if (sessions.sessions[0].entries !== 11) process.exit(1);

const history = await request("/chat/history", undefined, 200);
if (history.sessionKey !== canonicalSessionKey) process.exit(1);
if (!Array.isArray(history.entries) || history.entries.length !== 11) process.exit(1);

const aliasHistory = await request(`/chat/history?sessionKey=${encodeURIComponent(legacyAlias)}`, undefined, 200);
if (aliasHistory.sessionKey !== canonicalSessionKey) process.exit(1);
if (!Array.isArray(aliasHistory.entries) || aliasHistory.entries.length !== 11) process.exit(1);

const texts = new Set(history.entries.map((entry) => entry.text));
for (const expected of [
  "rest default continuity",
  "rpc default continuity",
  "ws default continuity",
  "openai default continuity",
  "responses default continuity",
  "legacy alias continuity",
]) {
  if (!texts.has(expected)) process.exit(1);
}

const substrates = history.entries.reduce((counts, entry) => {
  const substrate = entry.source?.substrate ?? "missing";
  counts[substrate] = (counts[substrate] ?? 0) + 1;
  return counts;
}, {});
if ((substrates["gateway-rest"] ?? 0) < 3) process.exit(1);
if ((substrates["gateway-rpc"] ?? 0) < 4) process.exit(1);
if ((substrates.openai ?? 0) < 4) process.exit(1);

const openAiChannels = history.entries.reduce((counts, entry) => {
  if (entry.source?.substrate !== "openai") return counts;
  const channel = entry.source?.channel ?? "missing";
  counts[channel] = (counts[channel] ?? 0) + 1;
  return counts;
}, {});
if ((openAiChannels["openai-chat-completions"] ?? 0) < 2) process.exit(1);
if ((openAiChannels["openai-responses"] ?? 0) < 2) process.exit(1);

const routingEvents = history.entries.filter((entry) => entry.metadata?.event === "routing_not_implemented");
if (routingEvents.length !== 5) process.exit(1);
NODE

echo "Unified session/transcript invariant smoke test passed."
