#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$ROOT"
export MINDSTONE_AGENT_RUNTIME_DIR="$TMP_DIR/runtime"
./scripts/init-runtime.sh >/tmp/mindstone-agent-doctor-init.log

output="$(./scripts/mindstone doctor)"
printf '%s\n' "$output"

grep -q "MindStone-Agent doctor" <<<"$output"
grep -q "session.mode" <<<"$output"
grep -q "webchat.shell" <<<"$output"
grep -q "webchat.session" <<<"$output"
grep -q "routing.mode" <<<"$output"
grep -q "piSession.safety" <<<"$output"
grep -q "Result: ok" <<<"$output"

status_output="$(./scripts/mindstone status)"
printf '%s\n' "$status_output"
grep -q "WebChat: http://127.0.0.1:19789/webchat" <<<"$status_output"
grep -q "WebChat default session: agent:default:main" <<<"$status_output"
grep -q "WebChat source: gateway-rest/webchat/internal" <<<"$status_output"
grep -q "Pi-session safety active: false" <<<"$status_output"

node <<'NODE'
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(path, 'utf8'));
const piAgentDir = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent`;
mkdirSync(piAgentDir, { recursive: true });
config.routing = {
  ...(config.routing ?? {}),
  mode: 'pi-session',
  defaultAgentId: 'default',
  defaultModel: 'openai/gpt-5.1',
  pi: {
    agentDir: piAgentDir,
    resumeCap: { maxEntries: 321, dropErrorTurns: true },
    compaction: { reserveTokensFloor: 25000, safeguardFallback: true },
  },
};
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

pi_output="$(./scripts/mindstone doctor)"
printf '%s\n' "$pi_output"
grep -q "piSession.isolation" <<<"$pi_output"
grep -q "piSession.resumeCap" <<<"$pi_output"
grep -q "321 entries" <<<"$pi_output"
grep -q "piSession.compactionFloor" <<<"$pi_output"
grep -q "25000" <<<"$pi_output"
grep -q "piSession.safeguardFallback" <<<"$pi_output"
grep -q "Result: ok" <<<"$pi_output"

pi_status_output="$(./scripts/mindstone status)"
printf '%s\n' "$pi_status_output"
grep -q "Pi-session safety active: true" <<<"$pi_status_output"
grep -q "Pi-session resume cap: true (321 entries, dropErrorTurns=true)" <<<"$pi_status_output"
grep -q "Pi-session compaction floor: 25000" <<<"$pi_status_output"
grep -q "Pi-session safeguard fallback: true" <<<"$pi_status_output"

echo "doctor smoke passed"
