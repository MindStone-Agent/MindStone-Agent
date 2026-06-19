#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-pi-config-sections.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"

cd "${PROJECT_ROOT}"

npm run build:mindstone >/tmp/mindstone-agent-pi-config-sections-build.log
./scripts/init-runtime.sh >/tmp/mindstone-agent-pi-config-sections-init.log

OUTPUT="$(node <<'NODE'
const { readFileSync } = await import('node:fs');
const mod = await import('./packages/mindstone-pi-adapter/dist/index.js');
const commands = new Map();
const notifications = [];
const uiEvents = [];
mod.default({
  on() {},
  registerTool() {},
  registerCommand(name, command) {
    commands.set(name, command);
  },
});
if (!commands.has('mindstone-config')) throw new Error('missing mindstone-config command');
if (!commands.has('mindstone-setup')) throw new Error('missing mindstone-setup command');

const ctx = {
  ui: {
    async select(title, options) {
      uiEvents.push({ type: 'select', title, options });
      return options[0];
    },
    async confirm(title, message) {
      uiEvents.push({ type: 'confirm', title, message });
      return false;
    },
    async input(title, placeholder) {
      uiEvents.push({ type: 'input', title, placeholder });
      return placeholder;
    },
    notify(message, kind = 'info') {
      notifications.push({ kind, message });
    },
  },
};

const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const before = readFileSync(configPath, 'utf8');
for (const section of ['gateway', 'memory', 'identity', 'channels']) {
  await commands.get('mindstone-config').handler(`${section} --dry-run`, ctx);
  const after = readFileSync(configPath, 'utf8');
  if (after !== before) throw new Error(`/mindstone-config ${section} --dry-run mutated config`);
}
await commands.get('mindstone-setup').handler('--sections gateway,memory,identity,channels --dry-run', ctx);
const afterSetup = readFileSync(configPath, 'utf8');
if (afterSetup !== before) throw new Error('/mindstone-setup section dry-run mutated config');
await commands.get('mindstone-config').handler('--section bogus --dry-run', ctx);

const text = [
  ...notifications.map((entry) => `[${entry.kind}] ${entry.message}`),
  ...uiEvents.map((entry) => `[ui:${entry.type}] ${entry.title ?? entry.message}`),
].join('\n---\n');
console.log(JSON.stringify({ notifications, uiEvents, text }, null, 2));
NODE
)"

echo "${OUTPUT}"

for section in gateway memory identity channels; do
  if ! grep -q "Requested sections: ${section}" <<<"${OUTPUT}"; then
    echo "Pi config section smoke missing requested section ${section}" >&2
    exit 1
  fi
done
if ! grep -q 'Requested sections: gateway, memory, identity, channels' <<<"${OUTPUT}"; then
  echo "Pi setup sections smoke missing combined requested sections" >&2
  exit 1
fi
if ! grep -q 'Dry run: true' <<<"${OUTPUT}" || ! grep -q 'MindStone config not written' <<<"${OUTPUT}"; then
  echo "Pi config section smoke missing dry-run/no-write confirmation" >&2
  exit 1
fi
if ! grep -q 'Changed sections: none' <<<"${OUTPUT}"; then
  echo "Pi config section smoke expected no changed sections under default choices" >&2
  exit 1
fi
if ! grep -q 'Gateway network' <<<"${OUTPUT}" || ! grep -q 'Vector store' <<<"${OUTPUT}" || ! grep -q 'Agent id' <<<"${OUTPUT}" || ! grep -q 'Channel/plugin catalog' <<<"${OUTPUT}"; then
  echo "Pi config section smoke did not exercise gateway/memory/identity/channels prompts" >&2
  exit 1
fi
if ! grep -q 'Invalid config section: bogus' <<<"${OUTPUT}"; then
  echo "Pi config section smoke did not reject invalid section clearly" >&2
  exit 1
fi

echo "Pi adapter config sections smoke passed."
