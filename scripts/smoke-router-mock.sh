#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-router-mock-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE - 2))"
CHAT_SESSION_KEY="agent:default:webchat:direct:router-mock-smoke"
RPC_SESSION_KEY="agent:default:rpc:direct:router-mock-smoke"
OPENAI_SESSION_KEY="agent:default:openai:direct:router-mock-smoke"
OPENRESPONSES_SESSION_KEY="agent:default:openresponses:direct:router-mock-smoke"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export CHAT_SESSION_KEY RPC_SESSION_KEY OPENAI_SESSION_KEY OPENRESPONSES_SESSION_KEY

cd "${PROJECT_ROOT}"

echo "== Gateway mock router smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = {
  mode: "mock",
  defaultModel: "mindstone/mock",
  mock: { responsePrefix: "router-smoke" },
};
config.gateway.http.chatCompletions.enabled = true;
config.gateway.http.responses.enabled = true;
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, '# Router Mock Identity\n\nIdentity sentinel: ROUTER-MOCK-IDENTITY.');
writeFileSync(`${runtime}/agents/default/USER.md`, '# Router Mock User\n\nUser sentinel: ROUTER-MOCK-USER.');
writeFileSync(path, JSON.stringify(config, null, 2));
console.log(path);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-router-mock-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;

async function post(path, body, expectedStatus = 200) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(payload, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  return payload;
}

const chat = await post("/chat/send", {
  sessionKey: process.env.CHAT_SESSION_KEY,
  agentId: "default",
  text: "hello chat router",
});
if (!chat.ok || !chat.entry?.text?.includes("hello chat router")) process.exit(1);
if (!chat.runId || chat.provider !== "mock") process.exit(1);
if (chat.runner?.id !== "provider-route" || chat.runner?.runId !== chat.runId) process.exit(1);
if (!chat.identityContext?.injected || chat.identityContext.name !== "Router Mock Identity") process.exit(1);
if (!chat.identityContext.identityPath?.endsWith("IDENTITY.md") || !chat.identityContext.userPath?.endsWith("USER.md")) process.exit(1);

const rpc = await post("/rpc", {
  id: "1",
  method: "chat.send",
  params: { sessionKey: process.env.RPC_SESSION_KEY, message: "hello rpc router" },
});
if (!rpc.ok || !rpc.result?.entry?.text?.includes("hello rpc router")) process.exit(1);
if (rpc.result.provider !== "mock") process.exit(1);
if (rpc.result.runner?.id !== "provider-route" || rpc.result.runner?.runId !== rpc.result.runId) process.exit(1);
if (!rpc.result.identityContext?.injected || rpc.result.identityContext.name !== "Router Mock Identity") process.exit(1);

const openai = await post("/v1/chat/completions", {
  model: "mindstone/mock",
  messages: [{ role: "user", content: "hello openai router" }],
  metadata: { sessionKey: process.env.OPENAI_SESSION_KEY, agentId: "default" },
});
if (openai.object !== "chat.completion") process.exit(1);
if (!openai.choices?.[0]?.message?.content?.includes("hello openai router")) process.exit(1);
if (!openai.mindstone?.identityContext?.injected || openai.mindstone.identityContext.name !== "Router Mock Identity") process.exit(1);
if (openai.mindstone.entries?.[1]?.metadata?.runner?.id !== "provider-route") process.exit(1);

const responses = await post("/v1/responses", {
  model: "mindstone/mock",
  input: [{ role: "user", content: [{ type: "input_text", text: "hello responses router" }] }],
  metadata: { sessionKey: process.env.OPENRESPONSES_SESSION_KEY, agentId: "default" },
});
if (responses.object !== "response" || responses.status !== "completed") process.exit(1);
if (!responses.output_text?.includes("hello responses router")) process.exit(1);
if (!responses.output?.[0]?.content?.[0]?.text?.includes("hello responses router")) process.exit(1);
if (!responses.mindstone?.identityContext?.injected || responses.mindstone.identityContext.name !== "Router Mock Identity") process.exit(1);
if (responses.mindstone.entries?.[1]?.metadata?.runner?.id !== "provider-route") process.exit(1);

const history = await fetch(`${base}/chat/history?sessionKey=${encodeURIComponent(process.env.CHAT_SESSION_KEY)}`);
const body = await history.json();
if (!body.entries.some((entry) => entry.role === "assistant" && entry.metadata?.event === "assistant_response" && entry.metadata?.runner?.id === "provider-route")) process.exit(1);
NODE

echo "Gateway mock router smoke test passed."
