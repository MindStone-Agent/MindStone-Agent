#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CONFIG="$TMP_DIR/config.json"

cd "$ROOT"
MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" npx tsx <<'TS'
import { writeFileSync } from "node:fs";
import {
  formatMindStoneChannelCatalog,
  getMindStoneChannelCatalog,
  runMindStoneConfigWizard,
  type MindStonePrompter,
  type MindStoneSelectOption,
} from "./packages/mindstone-core/src/index.ts";

const configPath = process.env.MINDSTONE_AGENT_CONFIG!;
writeFileSync(configPath, JSON.stringify({
  gateway: {
    host: "127.0.0.1",
    port: 19789,
    auth: { mode: "none" },
    http: { chatCompletions: { enabled: true }, responses: { enabled: true } }
  },
  session: { mode: "single", defaultSessionKey: "agent:default:main" },
  channels: {
    telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN" }
  }
}, null, 2));

const loaded = JSON.parse(JSON.stringify({
  gateway: {
    host: "127.0.0.1",
    port: 19789,
    auth: { mode: "none" },
    http: { chatCompletions: { enabled: true }, responses: { enabled: true } }
  },
  session: { mode: "single", defaultSessionKey: "agent:default:main" },
  channels: {
    telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN" }
  }
}));
const catalog = getMindStoneChannelCatalog(loaded);
if (!catalog.configuredChannelKeys.includes("telegram")) throw new Error("Configured telegram key missing");
const telegram = catalog.entries.find((entry) => entry.id === "telegram");
if (!telegram?.configured) throw new Error("Telegram not marked configured");
if (telegram.status !== "not_implemented") throw new Error(`Unexpected telegram status: ${telegram?.status}`);
const responses = catalog.entries.find((entry) => entry.id === "openresponses");
if (responses?.status !== "available" || responses.enabled !== true) throw new Error(`Unexpected OpenResponses status: ${responses?.status}`);
const formatted = formatMindStoneChannelCatalog(loaded);
if (!formatted.includes("Telegram: not implemented/validated yet")) throw new Error("Formatted catalog missing Telegram honest status");
if (!formatted.includes("diagnostic only")) throw new Error("Formatted catalog missing diagnostic-only warning");

const notes: string[] = [];
const prompter: MindStonePrompter = {
  note: async (message, title) => { notes.push(`${title ?? ""}\n${message}`); },
  confirm: async () => { throw new Error("Channels dry-run section should not ask to write"); },
  select: async <T extends string>({ options }: { message: string; options: Array<MindStoneSelectOption<T>>; initialValue?: T }): Promise<T> => options[0].value,
  text: async () => { throw new Error("Channels section should not ask for text"); },
};
const result = await runMindStoneConfigWizard(prompter, { configPath, sections: ["channels"], dryRun: true, showHeader: false, showIntro: false });
if (result.changedSections.length !== 0) throw new Error("Channels diagnostic section mutated config");
if (!notes.some((note) => note.includes("Channel/plugin catalog") && note.includes("Telegram: not implemented/validated yet"))) throw new Error("Wizard channels section did not list catalog");

console.log(`channel catalog core smoke passed: ${configPath}`);
TS

if [[ -f "$ROOT/packages/mindstone-cli/dist/index.js" ]]; then
  CLI_CONFIG="$TMP_DIR/cli-config.json"
  cat > "$CLI_CONFIG" <<'JSON'
{
  "gateway": { "host": "127.0.0.1", "port": 19789, "auth": { "mode": "none" }, "http": { "chatCompletions": { "enabled": true }, "responses": { "enabled": false } } },
  "channels": { "telegram": { "tokenEnv": "TELEGRAM_BOT_TOKEN" } }
}
JSON
  OUTPUT="$(MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CLI_CONFIG" node "$ROOT/packages/mindstone-cli/dist/index.js" channels)"
  if ! grep -q "MindStone channels" <<<"$OUTPUT" || ! grep -q "Telegram: not implemented/validated yet" <<<"$OUTPUT" || ! grep -q "diagnostic only" <<<"$OUTPUT"; then
    echo "channels CLI output missing expected catalog content" >&2
    echo "$OUTPUT" >&2
    exit 1
  fi
  JSON_OUTPUT="$(MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CLI_CONFIG" node "$ROOT/packages/mindstone-cli/dist/index.js" channels --json)"
  JSON_PAYLOAD="$JSON_OUTPUT" node <<'NODE'
const payload = JSON.parse(process.env.JSON_PAYLOAD);
if (!payload.configuredChannelKeys.includes('telegram')) throw new Error('JSON configured channel missing');
const telegram = payload.entries.find((entry) => entry.id === 'telegram');
if (!telegram || telegram.status !== 'not_implemented') throw new Error('JSON telegram status mismatch');
NODE
else
  echo "CLI dist not built; skipped CLI channel catalog smoke path"
fi

echo "channel catalog smoke passed"
