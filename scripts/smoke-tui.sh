#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-tui-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"

cd "${PROJECT_ROOT}"

echo "== MindStone TUI smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-tui-init.log

node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;
const path = `${runtime}/config.json`;
const config = JSON.parse(readFileSync(path, 'utf8'));
config.routing = {
  mode: 'mock',
  defaultAgentId: 'default',
  defaultModel: 'mindstone/mock',
  mock: { responsePrefix: 'tui-smoke' },
};
config.session = {
  mode: 'single',
  defaultSessionKey: 'agent:default:main',
};
mkdirSync(`${runtime}/agents/default`, { recursive: true });
writeFileSync(`${runtime}/agents/default/IDENTITY.md`, '# TUI Smoke Identity\n\nIdentity sentinel: TUI-SMOKE-IDENTITY.');
writeFileSync(`${runtime}/agents/default/USER.md`, '# TUI Smoke User\n\nUser sentinel: TUI-SMOKE-USER.');
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

OUTPUT="$(./scripts/mindstone tui --smoke --width 72)"
echo "${OUTPUT}"

if ! grep -q "MindStone-Agent" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing title" >&2
  exit 1
fi
if ! grep -q "mindstone" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing assistant label" >&2
  exit 1
fi
if ! grep -q "agent:default:main" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing canonical session" >&2
  exit 1
fi
if ! grep -q "/help" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing command hint" >&2
  exit 1
fi
if ! grep -q "runner stream event smoke" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing event rendering" >&2
  exit 1
fi
if ! grep -q "runner provider-route started" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing runner stream event rendering" >&2
  exit 1
fi
if ! grep -q "transcript dir" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing status panel" >&2
  exit 1
fi
if ! grep -q "provider:" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing status provider details" >&2
  exit 1
fi
if ! grep -q "sessions" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing sessions panel" >&2
  exit 1
fi
if ! grep -q "agents" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing agents panel" >&2
  exit 1
fi
if ! grep -q "models" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing models panel" >&2
  exit 1
fi
if ! grep -q "Selector mutation is not enabled yet" <<<"${OUTPUT}"; then
  echo "TUI smoke output missing selector mutation boundary" >&2
  exit 1
fi

./scripts/mindstone chat --once "history sentinel for tui" --json >/tmp/mindstone-agent-tui-chat.json
HISTORY_OUTPUT="$(./scripts/mindstone tui --smoke-history --history-limit 10 --width 72)"
echo "${HISTORY_OUTPUT}"
if ! grep -q "history sentinel for tui" <<<"${HISTORY_OUTPUT}"; then
  echo "TUI history smoke output missing user transcript entry" >&2
  exit 1
fi
if ! grep -q "tui-smoke: history sentinel for tui" <<<"${HISTORY_OUTPUT}"; then
  echo "TUI history smoke output missing assistant transcript entry" >&2
  exit 1
fi
if ! grep -q "Loaded 2 recent transcript" <<<"${HISTORY_OUTPUT}"; then
  echo "TUI history smoke output missing loaded history count" >&2
  exit 1
fi

HELP="$(./scripts/mindstone help)"
if ! grep -q "mindstone tui" <<<"${HELP}"; then
  echo "CLI help missing tui command" >&2
  exit 1
fi

echo "MindStone TUI smoke test passed."
