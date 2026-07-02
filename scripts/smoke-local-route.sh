#!/usr/bin/env bash
set -euo pipefail

# Proves the local/OpenAI-compatible model route end-to-end from a fresh runtime:
# stub OpenAI-compatible server -> isolated models.json provider -> pi-session
# routing -> real `mindstone chat --once` turn -> stub response lands in the
# transcript. No cloud accounts, no global Pi state.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-local-route-smoke.XXXXXX")"
STUB_PID=""

cleanup() {
  [[ -n "${STUB_PID}" ]] && kill "${STUB_PID}" 2>/dev/null || true
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"

cd "${PROJECT_ROOT}"

echo "== Local/OpenAI-compatible route smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-local-route-init.log

node "${PROJECT_ROOT}/scripts/stub-openai-server.mjs" >"${TEMP_RUNTIME}/stub.json" &
STUB_PID=$!
disown
for _ in $(seq 1 50); do
  [[ -s "${TEMP_RUNTIME}/stub.json" ]] && break
  sleep 0.1
done
STUB_PORT="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8")).port)' "${TEMP_RUNTIME}/stub.json")"
export STUB_URL="http://127.0.0.1:${STUB_PORT}/v1"

# Register the stub as a local provider in the isolated models.json (the same
# write path the onboarding/config wizard local lane uses).
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import { upsertIsolatedProvider } from "./packages/mindstone-core/src/index.ts";

const agentDir = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent`;
const result = upsertIsolatedProvider(agentDir, "local-openai", {
  name: "Local OpenAI-compatible server",
  baseUrl: process.env.STUB_URL!,
  api: "openai-completions",
  apiKey: "stub-key",
  models: [{ id: "stub-model" }],
});
if (!result.wrote) throw new Error(`Provider registration failed: ${result.error ?? "unknown"}`);
console.log(`registered local provider at ${result.path}`);
TS

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const piAgentDir = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.routing = {
  mode: "pi-session",
  defaultAgentId: "default",
  defaultModel: "local-openai/stub-model",
  pi: { agentDir: piAgentDir },
};
config.session = { mode: "single", defaultSessionKey: "agent:default:main" };
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, "# Local Route Smoke Identity\n\nIdentity sentinel: LOCAL-ROUTE-SMOKE.");
writeFileSync(`${runtime}/agents/default/USER.md`, "# Local Route Smoke User\n\nUser sentinel: LOCAL-ROUTE-SMOKE-USER.");
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

CHAT_OUTPUT="$(./scripts/mindstone chat --once "local route ping" 2>&1)"
if [[ "${CHAT_OUTPUT}" != *"STUB-OK local route verified"* ]]; then
  echo "Expected stub sentinel in chat output" >&2
  echo "${CHAT_OUTPUT}" >&2
  exit 1
fi

TRANSCRIPT_HITS="$(grep -l "STUB-OK local route verified" "${TEMP_RUNTIME}"/mindstone/transcripts/*.jsonl | wc -l | tr -d ' ')"
if [[ "${TRANSCRIPT_HITS}" -lt 1 ]]; then
  echo "Expected stub sentinel persisted in canonical transcript" >&2
  ls -la "${TEMP_RUNTIME}/mindstone/transcripts" >&2 || true
  exit 1
fi

echo "Local/OpenAI-compatible route smoke test passed."
