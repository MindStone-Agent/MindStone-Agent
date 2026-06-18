#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"

cd "${MINDSTONE_AGENT_ROOT}"

echo "== Pi session live validation probe =="

if [[ "${MINDSTONE_PI_SESSION_LIVE:-0}" != "1" ]]; then
  cat <<'MSG'
Skipping live Pi session validation.
Set MINDSTONE_PI_SESSION_LIVE=1 to opt in.
This probe intentionally does not read global Pi auth and only uses an isolated PI_CODING_AGENT_DIR.
MSG
  exit 0
fi

LIVE_AGENT_DIR="${MINDSTONE_PI_SESSION_LIVE_AGENT_DIR:-${PI_CODING_AGENT_DIR}}"
LIVE_MODEL="${MINDSTONE_PI_SESSION_LIVE_MODEL:-openai/gpt-5.1}"
LIVE_PROMPT="${MINDSTONE_PI_SESSION_LIVE_PROMPT:-Reply with exactly: mindstone pi session live ok}"
GLOBAL_PI_AGENT_DIR="${HOME}/.pi/agent"

LIVE_AGENT_DIR_RESOLVED="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().resolve(strict=False))' "${LIVE_AGENT_DIR}")"
GLOBAL_PI_AGENT_DIR_RESOLVED="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().resolve(strict=False))' "${GLOBAL_PI_AGENT_DIR}")"

case "${LIVE_AGENT_DIR_RESOLVED}" in
  "${GLOBAL_PI_AGENT_DIR_RESOLVED}"|"${GLOBAL_PI_AGENT_DIR_RESOLVED}"/*)
    echo "Refusing to use global Pi auth dir: ${LIVE_AGENT_DIR}" >&2
    echo "Provide an isolated dir via MINDSTONE_PI_SESSION_LIVE_AGENT_DIR, or configure ${PI_CODING_AGENT_DIR}." >&2
    exit 1
    ;;
esac

if [[ ! -f "${LIVE_AGENT_DIR}/auth.json" ]]; then
  echo "Skipping live Pi session validation: isolated auth.json not found at ${LIVE_AGENT_DIR}/auth.json"
  exit 0
fi
if [[ ! -f "${LIVE_AGENT_DIR}/models.json" ]]; then
  echo "Skipping live Pi session validation: isolated models.json not found at ${LIVE_AGENT_DIR}/models.json"
  exit 0
fi

TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-pi-session-live.XXXXXX")"
cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export PI_CODING_AGENT_DIR="${LIVE_AGENT_DIR}"
export PI_CODING_AGENT_SESSION_DIR="${TEMP_RUNTIME}/pi-sessions"
export PI_OFFLINE=0
unset MINDSTONE_AGENT_DATA_DIR MINDSTONE_AGENT_TOKEN_DIR MINDSTONE_AGENT_VECTOR_DIR \
  MINDSTONE_AGENT_TRANSCRIPT_DIR MINDSTONE_AGENT_MEMORY_DIR MINDSTONE_AGENT_JOURNAL_DIR \
  MINDSTONE_AGENT_LOG_PATH MINDSTONE_AGENT_MEMORY_INDEX_PATH MINDSTONE_AGENT_CONFIG || true
# Re-source after overriding runtime dirs so MindStone data/transcript paths are temp-only.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-pi-session-live-init.log

SESSION_KEY="agent:default:live-probe-$(date +%s)"
export SESSION_KEY LIVE_MODEL

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const runtime = process.env.MINDSTONE_AGENT_DATA_DIR;
const piAgentDir = process.env.PI_CODING_AGENT_DIR;
const configPath = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.routing = {
  mode: 'pi-session',
  defaultAgentId: 'default',
  defaultModel: process.env.LIVE_MODEL,
  pi: { agentDir: piAgentDir },
};
config.session = {
  mode: 'single',
  defaultSessionKey: process.env.SESSION_KEY,
};
config.agents = {
  default: {
    id: 'default',
    identityPath: 'agents/default/IDENTITY.md',
    userPath: 'agents/default/USER.md',
    defaultModel: process.env.LIVE_MODEL,
    contextWindowTokens: 128000,
  },
};
config.observability = {
  runnerStream: {
    persistTranscriptEvents: true,
    eventTypes: ['run_started', 'text_delta', 'substrate_event', 'run_completed', 'run_failed'],
    maxEvents: 50,
  },
};
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, '# Live Probe Identity\n\nYou are a MindStone-Agent live Pi session validation probe.');
writeFileSync(`${runtime}/agents/default/USER.md`, '# Live Probe User\n\nThe user is validating isolated Pi AgentSession execution.');
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

OUTPUT_FILE="${TEMP_RUNTIME}/live-output.txt"
set +e
./scripts/mindstone chat --once "${LIVE_PROMPT}" --json --session "${SESSION_KEY}" --model "${LIVE_MODEL}" >"${OUTPUT_FILE}" 2>&1
STATUS=$?
set -e
cat "${OUTPUT_FILE}"

if [[ "${STATUS}" -ne 0 ]]; then
  if grep -Eq "No isolated Pi model is available/configured|not available in isolated runtime auth" "${OUTPUT_FILE}"; then
    echo "Live Pi session validation unavailable: isolated auth/model is not configured for ${LIVE_MODEL}."
    exit 0
  fi
  echo "Live Pi session validation failed unexpectedly." >&2
  exit "${STATUS}"
fi

node --input-type=commonjs - "${OUTPUT_FILE}" <<'NODE'
const { readFileSync } = require('node:fs');
const outputPath = process.argv[2];
const result = JSON.parse(readFileSync(outputPath, 'utf8'));
const text = result?.assistantEntry?.text ?? result?.result?.text ?? '';
const runnerId = result?.runner?.id ?? result?.runnerResult?.runner?.id ?? result?.providerDiagnostics?.runner?.id;
const model = result?.model ?? result?.assistantEntry?.metadata?.model ?? result?.result?.model;
if (typeof text !== 'string' || text.trim().length === 0) {
  throw new Error('live probe produced no assistant text');
}
if (runnerId !== 'pi-session') {
  throw new Error(`unexpected runner id: ${runnerId}`);
}
if (!result?.runnerStream || result.runnerStream.eventCount < 3 || result.runnerStream.persistedEventCount < 3) {
  throw new Error(`runner stream validation missing or incomplete: ${JSON.stringify(result?.runnerStream)}`);
}
console.log(JSON.stringify({
  ok: true,
  sessionKey: process.env.SESSION_KEY,
  model,
  assistantTextChars: text.length,
  runnerStream: result.runnerStream,
}, null, 2));
NODE

if [[ "${MINDSTONE_PI_SESSION_LIVE_COMPACT:-0}" == "1" ]]; then
  echo "== Pi session live compaction probe =="
  node --input-type=module <<'NODE'
import { PiSessionAgentRunner } from './packages/mindstone-gateway/dist/index.js';

const runner = new PiSessionAgentRunner({
  projectRoot: process.env.MINDSTONE_AGENT_ROOT,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
  cwd: process.env.MINDSTONE_AGENT_ROOT,
  defaultModel: process.env.LIVE_MODEL,
});

const result = await runner.compact({
  agentId: 'default',
  sessionKey: process.env.SESSION_KEY,
  model: { id: process.env.LIVE_MODEL, provider: 'pi-session' },
  customInstructions: 'MindStone-Agent live probe compaction after successful temporary prompt/stream validation.',
  runContext: { runId: `live_compact_${Date.now().toString(36)}`, surface: 'smoke-pi-session-live' },
});

console.log(JSON.stringify(result, null, 2));
if (!result.available || !result.requested || result.reason !== 'pi_agent_session_compact_completed') {
  throw new Error(`live compaction did not complete: ${JSON.stringify(result)}`);
}
NODE
else
  echo "Skipping live Pi session compaction validation. Set MINDSTONE_PI_SESSION_LIVE_COMPACT=1 to opt in after prompt/stream validation."
fi

echo "Pi session live validation probe completed."
