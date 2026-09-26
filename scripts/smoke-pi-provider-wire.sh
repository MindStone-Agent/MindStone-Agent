#!/usr/bin/env bash
set -euo pipefail

# Proves what routing.mode "pi" actually SENDS to the provider. A stub
# OpenAI-compatible server records every request body; the assertions read those
# bodies, not MindStone's own logs. Earlier smokes stopped before the wire, so
# system messages (recall, identity, handoff) were dropped for months while the
# gateway logged them as injected.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-pi-wire-smoke.XXXXXX")"
STUB_PID=""

cleanup() {
  [[ -n "${STUB_PID}" ]] && kill "${STUB_PID}" 2>/dev/null || true
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export STUB_OPENAI_RECORD_BODIES="${TEMP_RUNTIME}/bodies.jsonl"
mkdir -p "${PI_CODING_AGENT_DIR}"

cd "${PROJECT_ROOT}"
echo "== Pi provider wire smoke test =="

if [[ "${SKIP_BUILD:-}" != "1" ]]; then npm run build:mindstone; fi

node "${PROJECT_ROOT}/scripts/stub-openai-server.mjs" >"${TEMP_RUNTIME}/stub.json" &
STUB_PID=$!
disown
for _ in $(seq 1 50); do
  [[ -s "${TEMP_RUNTIME}/stub.json" ]] && break
  sleep 0.1
done
STUB_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port)' "${TEMP_RUNTIME}/stub.json")"
export STUB_URL="http://127.0.0.1:${STUB_PORT}/v1"

npx tsx <<'TS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { upsertIsolatedProvider } from "./packages/mindstone-core/src/index.ts";
import { PiMindStoneProvider } from "./packages/mindstone-gateway/src/pi-provider.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const reg = upsertIsolatedProvider(agentDir, "local-openai", {
  name: "Local OpenAI-compatible server",
  baseUrl: process.env.STUB_URL!,
  api: "openai-completions",
  apiKey: "stub-key",
  models: [{ id: "stub-model" }],
});
assert.ok(reg.wrote, `provider registration failed: ${reg.error ?? "unknown"}`);

const provider = new PiMindStoneProvider({ agentDir, defaultProvider: "local-openai", defaultModel: "stub-model" });
const model = (await provider.listModels()).find((m) => m.id === "local-openai/stub-model");
assert.ok(model, "stub model not registered");

// The shape core/routing/run.ts builds: system messages (identity, recall,
// handoff) plus a multi-turn history including an earlier assistant reply.
const result = await provider.completeChat({
  agentId: "default",
  sessionKey: "agent:default:main",
  model,
  transcriptEntries: [],
  messages: [
    { role: "system", text: "IDENTITY-CANARY you are the test agent" },
    { role: "system", text: "RECALL-CANARY <relevant-memories>the sky is green</relevant-memories>" },
    { role: "user", text: "first question" },
    { role: "assistant", text: "ASSISTANT-CANARY first answer" },
    { role: "user", text: "second question" },
  ],
});

const raw = result.raw as { stopReason?: string; errorMessage?: string };
assert.equal(result.text, "STUB-OK local route verified",
  `reply did not come back (stopReason=${raw?.stopReason}, error=${raw?.errorMessage}); an error stopReason used to surface as an empty reply`);

const bodies = readFileSync(process.env.STUB_OPENAI_RECORD_BODIES!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(bodies.length, 1, `expected exactly one provider request, got ${bodies.length}`);
const sent = bodies[0].messages as Array<{ role: string; content: unknown }>;
const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const system = sent.filter((m) => m.role === "system" || m.role === "developer").map(text).join("\n");
assert.match(system, /IDENTITY-CANARY/, "identity system message did not reach the provider");
assert.match(system, /RECALL-CANARY/, "recall system message did not reach the provider");
assert.ok(sent.some((m) => m.role === "assistant" && /ASSISTANT-CANARY/.test(text(m))), "assistant history did not reach the provider");
assert.equal(text(sent[sent.length - 1]).includes("second question"), true, "latest user turn is not last");
console.log(`ok: ${sent.length} messages on the wire; system, recall, assistant history and latest user turn all present`);
TS

echo "== Pi provider wire smoke test passed =="
