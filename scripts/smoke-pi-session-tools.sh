#!/usr/bin/env bash
set -euo pipefail

# GHSA-c6pf-xqf8-mf2q: a pi-session turn must not offer Pi's built-in tools
# (read, bash, edit, write, grep, find, ls) unless routing.pi.builtinTools names
# them. Checks what the model is actually offered: a stub OpenAI-compatible
# server records the tool names in each real chat request.
#   1. default config            -> no built-in tool offered
#   2. builtinTools ["read"]     -> read offered, the other six not
#   3. builtinTools = read, bash, edit, write, grep, find, ls
#                                -> read, bash, edit, write offered (proves the recorder
#                                   can see them); grep, find, ls stay off

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-pi-tools-smoke.XXXXXX")"
STUB_PID=""

cleanup() {
  [[ -n "${STUB_PID}" ]] && kill "${STUB_PID}" 2>/dev/null || true
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export CHAT_SESSION_KEY="agent:default:main"
export STUB_OPENAI_RECORD_TOOLS="${TEMP_RUNTIME}/tools.jsonl"

cd "${PROJECT_ROOT}"

echo "== Pi session built-in tool allowlist smoke test =="

npm run build:mindstone >/dev/null
./scripts/init-runtime.sh >/tmp/mindstone-agent-pi-tools-init.log

node "${PROJECT_ROOT}/scripts/stub-openai-server.mjs" >"${TEMP_RUNTIME}/stub.json" &
STUB_PID=$!
disown
for _ in $(seq 1 50); do
  [[ -s "${TEMP_RUNTIME}/stub.json" ]] && break
  sleep 0.1
done
STUB_PORT="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8")).port)' "${TEMP_RUNTIME}/stub.json")"
export STUB_URL="http://127.0.0.1:${STUB_PORT}/v1"

MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS' >/dev/null
import { upsertIsolatedProvider } from "./packages/mindstone-core/src/index.ts";
const result = upsertIsolatedProvider(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent`, "local-openai", {
  name: "Local OpenAI-compatible server",
  baseUrl: process.env.STUB_URL!,
  api: "openai-completions",
  apiKey: "stub-key",
  models: [{ id: "stub-model" }],
});
if (!result.wrote) throw new Error(`Provider registration failed: ${result.error ?? "unknown"}`);
TS

# $1 = JSON for routing.pi.builtinTools, or "none" to leave it unset.
run_turn() {
  BUILTIN_TOOLS="$1" node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
const pi = { agentDir: `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent` };
if (process.env.BUILTIN_TOOLS !== "none") pi.builtinTools = JSON.parse(process.env.BUILTIN_TOOLS);
config.routing = { mode: "pi-session", defaultAgentId: "default", defaultModel: "local-openai/stub-model", pi };
config.session = { mode: "single", defaultSessionKey: "agent:default:main" };
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE
  : >"${STUB_OPENAI_RECORD_TOOLS}"
  ./scripts/mindstone chat --once "tool allowlist ping" >"${TEMP_RUNTIME}/chat.log" 2>&1 || true
  if [[ ! -s "${STUB_OPENAI_RECORD_TOOLS}" ]]; then
    echo "FAIL: the stub saw no chat request, so nothing was checked. Chat output:" >&2
    tail -20 "${TEMP_RUNTIME}/chat.log" >&2
    exit 1
  fi
  node -e '
    const lines = require("node:fs").readFileSync(process.argv[1], "utf-8").trim().split("\n");
    console.log(JSON.stringify([...new Set(lines.flatMap((l) => JSON.parse(l)))].sort()));
  ' "${STUB_OPENAI_RECORD_TOOLS}"
}

# $1 = offered JSON, $2 = expected built-ins (space separated, may be empty)
check() {
  node -e '
    const offered = new Set(JSON.parse(process.argv[1]));
    const expected = new Set(process.argv[2].split(" ").filter(Boolean));
    const builtins = ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const got = builtins.filter((n) => offered.has(n));
    const want = builtins.filter((n) => expected.has(n));
    if (got.join() !== want.join()) {
      console.error(`FAIL: ${process.argv[3]}: built-ins offered ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      process.exit(1);
    }
    console.log(`ok: ${process.argv[3]}: built-ins offered ${JSON.stringify(got)}`);
  ' "$1" "$2" "$3"
}

check "$(run_turn none)" "" "default config"
check "$(run_turn '["read"]')" "read" "builtinTools [read]"
check "$(run_turn '["read","bash","edit","write","grep","find","ls"]')" "read bash edit write" "builtinTools all seven"

echo "Pi session built-in tool allowlist smoke test passed."
