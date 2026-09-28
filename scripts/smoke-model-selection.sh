#!/usr/bin/env bash
# Which model a chat runs on (#126 J11, #118). Two stub providers, alpha
# (registered first) and beta, answer with different sentinels:
#   1. a Console chat (model "mindstone/default") uses the model chosen in
#      setup, not the first available provider;
#   2. an agent's own defaultModel beats the install's routing.defaultModel;
#   3. a non-owner can't choose the model; the owner can;
#   4. an unknown model falls back to the configured default, and says so.
# Binds gateway port base+33; stubs pick free ports. The gateway runs with a
# clean environment so no shell API key adds a provider. Synthetic keys only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-model-selection.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 33))"
cleanup() {
  for pid in ${gateway_pid:-} ${alpha_pid:-} ${beta_pid:-}; do kill "${pid}" >/dev/null 2>&1 || true; done
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
cd "${PROJECT_ROOT}"
echo "== Model selection smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
BASE="http://127.0.0.1:${GATEWAY_PORT}"

start_stub() {
  STUB_OPENAI_SENTINEL="$2" node "${PROJECT_ROOT}/scripts/stub-openai-server.mjs" >"${TEMP_RUNTIME}/$1.json" &
  echo $!
}
alpha_pid="$(start_stub alpha ALPHA-ANSWERED)"
beta_pid="$(start_stub beta BETA-ANSWERED)"
for _ in $(seq 1 50); do [[ -s "${TEMP_RUNTIME}/alpha.json" && -s "${TEMP_RUNTIME}/beta.json" ]] && break; sleep 0.1; done
port() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port)' "$1"; }
export ALPHA_URL="http://127.0.0.1:$(port "${TEMP_RUNTIME}/alpha.json")/v1" BETA_URL="http://127.0.0.1:$(port "${TEMP_RUNTIME}/beta.json")/v1"

MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import { upsertIsolatedProvider } from "./packages/mindstone-core/src/index.ts";
const agentDir = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent`;
for (const [id, url] of [["alpha", process.env.ALPHA_URL!], ["beta", process.env.BETA_URL!]]) {
  const result = upsertIsolatedProvider(agentDir, id, { name: id, baseUrl: url, api: "openai-completions", apiKey: `${id}-synthetic-key`, models: [{ id: "stub-model" }] });
  if (!result.wrote) throw new Error(`registering ${id} failed: ${result.error ?? "unknown"}`);
}
TS

# config <routing.defaultModel> [agents.default.defaultModel]
config() {
  DEFAULT_MODEL="$1" AGENT_MODEL="${2:-}" node -e '
const fs = require("fs"); const p = process.env.MINDSTONE_AGENT_RUNTIME_DIR + "/mindstone/config.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.gateway = { ...(c.gateway ?? {}), auth: { mode: "token", tokenEnv: "MS_SMOKE_TOKEN" }, http: { chatCompletions: { enabled: true } } };
c.routing = { mode: "pi-session", defaultAgentId: "default", defaultModel: process.env.DEFAULT_MODEL, pi: { agentDir: process.env.MINDSTONE_AGENT_RUNTIME_DIR + "/pi-agent" } };
c.memory = { ...(c.memory ?? {}), autoRecall: false };
// Without an agent model, the agent keeps the init-runtime alias
// "mindstone/default", as on a fresh install.
c.agents = { ...(c.agents ?? {}), default: { ...(c.agents?.default ?? { id: "default" }), defaultModel: process.env.AGENT_MODEL || "mindstone/default" } };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
}
# A fresh install names the alias "mindstone/default" as the default agent's model.
grep -q '"defaultModel": "mindstone/default"' "${DATA}/config.json" || { echo "expected init-runtime to name mindstone/default as the agent model" >&2; exit 1; }
config "beta/stub-model"

env -i HOME="${HOME}" PATH="${PATH}" MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}" MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}" MS_SMOKE_TOKEN="model-selection-smoke-token" \
  ./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 40); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

# chat <role> <model> <conversation>: prints the reply text
chat() {
  local body
  body="$(curl -s -X POST -H "Authorization: Bearer model-selection-smoke-token" -H 'content-type: application/json' \
    -H "x-mindstone-user-role: $1" -H "x-mindstone-user-id: smoke-$1" -H "x-mindstone-conversation-id: $3" \
    -d "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"which model answers?\"}]}" "${BASE}/v1/chat/completions")"
  node -e 'try { const b = JSON.parse(process.argv[1]); process.stdout.write(b.choices?.[0]?.message?.content ?? JSON.stringify(b)); } catch { process.stdout.write(process.argv[1]); }' "${body}"
}
expect() { [[ "$1" == *"$2"* ]] || { echo "$3: expected $2, got: ${1:0:300}" >&2; exit 1; }; }

# 1. The Console's "mindstone/default" means the model chosen in setup (beta), not the first available (alpha).
expect "$(chat admin mindstone/default c1)" BETA-ANSWERED "a Console chat should use the model chosen in setup"
# ...directly, not by way of the unknown-model fallback.
grep -q 'Pi has no model\|using the first available' "${TEMP_RUNTIME}/gateway.log" && { echo "the Console chat reached the setup model only through a fallback: $(grep 'Pi has no model\|first available' "${TEMP_RUNTIME}/gateway.log" | head -1)" >&2; exit 1; }
# 2. The agent's own default beats the install default (#118).
config "beta/stub-model" "alpha/stub-model"
expect "$(chat admin mindstone/default c2)" ALPHA-ANSWERED "the agent's own defaultModel should win over routing.defaultModel"
# 3. A non-owner can't choose the model; the owner can (#118).
expect "$(chat user beta/stub-model c3)" ALPHA-ANSWERED "a non-owner's requested model should be ignored"
expect "$(chat admin beta/stub-model c4)" BETA-ANSWERED "the owner's requested model should be used"
# 4. An unknown model falls back to the configured default, and the gateway says so.
config "beta/stub-model"
expect "$(chat admin nope/no-such-model c5)" BETA-ANSWERED "an unknown model should fall back to the configured default"
grep -q 'Pi has no model "nope/no-such-model"' "${TEMP_RUNTIME}/gateway.log" || { echo "the fallback to the default model should be logged" >&2; exit 1; }
echo "Model selection smoke test passed."
