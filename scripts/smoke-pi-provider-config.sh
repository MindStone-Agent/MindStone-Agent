#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-pi-provider-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export PI_CODING_AGENT_SESSION_DIR="${TEMP_RUNTIME}/pi-sessions"
export MINDSTONE_AGENT_DATA_DIR="${TEMP_RUNTIME}/mindstone"

mkdir -p "${PI_CODING_AGENT_DIR}" "${PI_CODING_AGENT_SESSION_DIR}" "${MINDSTONE_AGENT_DATA_DIR}"

cat >"${PI_CODING_AGENT_DIR}/settings.json" <<'JSON'
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.5"
}
JSON

cd "${PROJECT_ROOT}"

echo "== Pi provider config smoke test =="

npm run build:mindstone

npx tsx <<'TS'
import assert from "node:assert/strict";
import { PiMindStoneProvider } from "./packages/mindstone-gateway/src/pi-provider.ts";

const provider = new PiMindStoneProvider({ agentDir: process.env.PI_CODING_AGENT_DIR });
const models = await provider.listModels();
const target = models.find((model) => model.id === "openai-codex/gpt-5.5");
assert.ok(target, "expected openai-codex/gpt-5.5 from vendored Pi model registry");
assert.equal(target.provider, "pi");
assert.ok((target.contextWindowTokens ?? 0) > 0, "expected context window metadata");

console.log(JSON.stringify({
  modelCount: models.length,
  target,
  isolatedPiAgentDir: process.env.PI_CODING_AGENT_DIR,
}, null, 2));
TS

echo "Pi provider config smoke test passed."
