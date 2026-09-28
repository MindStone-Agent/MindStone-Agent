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
# init-runtime seeds Pi's cache warming off (#129). Remove it again so the
# session turns below show the gateway turns it off by itself too.
PI_SETTINGS="${TEMP_RUNTIME}/pi-agent/settings.json" node -e '
const fs = require("fs"); const p = process.env.PI_SETTINGS;
if (!fs.existsSync(p)) { console.error("init-runtime should seed a Pi settings.json with cacheWarming off"); process.exit(1); }
const s = JSON.parse(fs.readFileSync(p, "utf8"));
if (s.cacheWarming !== "off") { console.error("init-runtime should seed cacheWarming off: " + JSON.stringify(s)); process.exit(1); }
delete s.cacheWarming; fs.writeFileSync(p, JSON.stringify(s));
'

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
    const builtins = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
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
check "$(run_turn '["read","bash","powershell","edit","write","grep","find","ls"]')" "read bash edit write" "builtinTools all eight"
# Pi 0.87's powershell built-in (#127) can't be enabled.
check "$(run_turn '["powershell"]')" "" "builtinTools [powershell]"

check "$(run_turn '"bash"')" "" "builtinTools as a string"
check "$(run_turn '["BASH","bash "]')" "" "builtinTools with near-miss names"

# The fail-closed guard: a session that offers a built-in that was not enabled must throw.
node --input-type=module <<'NODE'
import { assertNoUnexpectedPiBuiltinTools } from "./packages/mindstone-gateway/dist/index.js";
const builtin = (name) => ({ name, sourceInfo: { source: "builtin" } });
const expectThrow = (label, fn) => {
  try { fn(); } catch (e) {
    if (/built-in tools|getAllTools/.test(String(e?.message))) { console.log(`ok: guard: ${label}`); return; }
    console.error(`FAIL: guard: ${label} threw the wrong error: ${e?.message}`); process.exit(1);
  }
  console.error(`FAIL: guard: ${label} did not throw`); process.exit(1);
};
const expectPass = (label, fn) => {
  try { fn(); console.log(`ok: guard: ${label}`); } catch (e) { console.error(`FAIL: guard: ${label}: ${e.message}`); process.exit(1); }
};
expectThrow("bash offered, none enabled", () => assertNoUnexpectedPiBuiltinTools({ getAllTools: () => [builtin("bash")] }, undefined));
expectThrow("unknown future built-in offered", () => assertNoUnexpectedPiBuiltinTools({ getAllTools: () => [builtin("newtool")] }, ["read"]));
expectThrow("no getAllTools", () => assertNoUnexpectedPiBuiltinTools({}, undefined));
expectThrow("bash by name only, labelled extension", () => assertNoUnexpectedPiBuiltinTools({ getAllTools: () => [{ name: "bash", sourceInfo: { source: "extension" } }] }, undefined));
expectThrow("read offered, config is a string", () => assertNoUnexpectedPiBuiltinTools({ getAllTools: () => [builtin("read")] }, "read"));
expectThrow("new built-in with a relabelled source", () => assertNoUnexpectedPiBuiltinTools({ getAllTools: () => [{ name: "newtool", sourceInfo: { source: "core", path: "<builtin:newtool>" } }] }, undefined));
expectPass("read offered and enabled", () => assertNoUnexpectedPiBuiltinTools({ getAllTools: () => [builtin("read"), { name: "mindstone_memory_read", sourceInfo: { source: "extension" } }] }, ["read"]));
NODE

# Pi 0.87's powershell built-in can never be enabled (sessions only turn on
# Pi's default tools, so the turns above can't see this; check the allowlist).
node --input-type=module <<'NODE'
import { piSessionEnabledBuiltinTools, piSessionExcludedBuiltinTools } from "./packages/mindstone-gateway/dist/index.js";
const enabled = piSessionEnabledBuiltinTools(["powershell", "read"]);
if (enabled.includes("powershell")) { console.error("powershell should never be enableable: " + JSON.stringify(enabled)); process.exit(1); }
if (!piSessionExcludedBuiltinTools(["powershell"]).includes("powershell")) { console.error("powershell should always be excluded"); process.exit(1); }
console.log("ok: powershell never enableable");
NODE

# Pi 0.87's paid cache warming (#128 review): off in MindStone's agent dir unless its settings.json names a mode.
AGENT_DIR="${TEMP_RUNTIME}/pi-agent" node --input-type=module <<'NODE'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { disablePiCacheWarmingUnlessSet } from "./packages/mindstone-gateway/dist/index.js";
import { SettingsManager } from "./vendor/pi/packages/coding-agent/dist/core/settings-manager.js";
const fail = (m) => { console.error(m); process.exit(1); };
// The session turns above ran in this agent dir: warming was turned off there.
const written = JSON.parse(readFileSync(join(process.env.AGENT_DIR, "settings.json"), "utf8"));
if (written.cacheWarming !== "off") fail("a session turn should have turned cache warming off in the agent dir: " + JSON.stringify(written));
// Unset: turned off, and Pi reads it back.
const fresh = mkdtempSync(join(tmpdir(), "pi-warm-"));
const manager = SettingsManager.create(fresh, fresh);
if (!disablePiCacheWarmingUnlessSet({ settingsManager: manager, agentDir: fresh })) fail("unset cache warming should be turned off");
if (manager.getCacheWarmingMode() !== "off") fail("the session's own settings should read cache warming as off");
await manager.flush();
if (SettingsManager.create(fresh, fresh).getCacheWarmingMode() !== "off") fail("Pi should read cache warming as off from the file");
// An invalid value (a typo, null) is not a choice: Pi would fall back to streaming.
for (const bad of [null, "Off", "warm"]) {
  const dir = mkdtempSync(join(tmpdir(), "pi-warm-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ cacheWarming: bad }));
  const m = SettingsManager.create(dir, dir);
  if (!disablePiCacheWarmingUnlessSet({ settingsManager: m, agentDir: dir })) fail("an invalid cacheWarming value should be replaced: " + JSON.stringify(bad));
  if (m.getCacheWarmingMode() !== "off") fail("an invalid cacheWarming value left warming on: " + JSON.stringify(bad));
}
// A BOM is stripped before reading the choice; a file that doesn't parse is left alone.
{
  const dir = mkdtempSync(join(tmpdir(), "pi-warm-"));
  writeFileSync(join(dir, "settings.json"), "\uFEFF" + JSON.stringify({ cacheWarming: "streaming" }));
  if (disablePiCacheWarmingUnlessSet({ settingsManager: SettingsManager.create(dir, dir), agentDir: dir })) fail("a streaming choice behind a BOM should be kept");
  const unset = mkdtempSync(join(tmpdir(), "pi-warm-"));
  writeFileSync(join(unset, "settings.json"), "\uFEFF" + JSON.stringify({ theme: "dark" }));
  if (!disablePiCacheWarmingUnlessSet({ settingsManager: SettingsManager.create(unset, unset), agentDir: unset })) fail("a settings file with a BOM and no choice should get warming off");
  const broken = mkdtempSync(join(tmpdir(), "pi-warm-"));
  writeFileSync(join(broken, "settings.json"), '{"theme":"dark",}');
  const calls = [];
  if (disablePiCacheWarmingUnlessSet({ settingsManager: { setCacheWarmingMode: (m) => calls.push(m) }, agentDir: broken }) || calls.length) fail("a settings file that does not parse should be left alone");
}
// Chosen by the owner: left alone.
const chosen = mkdtempSync(join(tmpdir(), "pi-warm-"));
writeFileSync(join(chosen, "settings.json"), JSON.stringify({ cacheWarming: "streaming" }));
if (disablePiCacheWarmingUnlessSet({ settingsManager: SettingsManager.create(chosen, chosen), agentDir: chosen })) fail("an owner's cache warming choice should be kept");
if (SettingsManager.create(chosen, chosen).getCacheWarmingMode() !== "streaming") fail("the owner's streaming choice was changed");
console.log("ok: cache warming off unless chosen");
NODE
# init-runtime keeps an owner's choice, and replaces an invalid value.
for pair in 'streaming:streaming' 'null:off'; do
  given="${pair%%:*}" want="${pair##*:}"
  RT="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-seed.XXXXXX")"
  mkdir -p "${RT}/pi-agent"
  if [[ "${given}" == null ]]; then printf '{"cacheWarming":null}' > "${RT}/pi-agent/settings.json"; else printf '{"cacheWarming":"%s"}' "${given}" > "${RT}/pi-agent/settings.json"; fi
  MINDSTONE_AGENT_RUNTIME_DIR="${RT}" PI_CODING_AGENT_DIR="${RT}/pi-agent" ./scripts/init-runtime.sh >/dev/null
  got="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).cacheWarming))' "${RT}/pi-agent/settings.json")"
  rm -rf "${RT}"
  [[ "${got}" == "${want}" ]] || { echo "init-runtime with cacheWarming ${given} should leave ${want}, got ${got}" >&2; exit 1; }
done
# A settings file Pi can read but a plain JSON.parse cannot (a BOM), or one
# that doesn't parse at all, is never replaced (#130 review).
RT="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-seed.XXXXXX")"; mkdir -p "${RT}/pi-agent"
printf '\xEF\xBB\xBF{"cacheWarming":"streaming","theme":"dark"}' > "${RT}/pi-agent/settings.json"
MINDSTONE_AGENT_RUNTIME_DIR="${RT}" PI_CODING_AGENT_DIR="${RT}/pi-agent" ./scripts/init-runtime.sh >/dev/null
grep -q '"theme":"dark"' "${RT}/pi-agent/settings.json" && grep -q '"cacheWarming":"streaming"' "${RT}/pi-agent/settings.json" || { echo "init-runtime replaced a settings file with a BOM: $(cat "${RT}/pi-agent/settings.json")" >&2; exit 1; }
printf '\xEF\xBB\xBF{"theme":"dark"}' > "${RT}/pi-agent/settings.json"
MINDSTONE_AGENT_RUNTIME_DIR="${RT}" PI_CODING_AGENT_DIR="${RT}/pi-agent" ./scripts/init-runtime.sh >/dev/null
grep -q '"theme": "dark"' "${RT}/pi-agent/settings.json" && grep -q '"cacheWarming": "off"' "${RT}/pi-agent/settings.json" || { echo "init-runtime should read past a BOM, keep the file and seed off: $(cat "${RT}/pi-agent/settings.json")" >&2; exit 1; }
printf '{"theme":"dark","cacheWarming":"streaming",}' > "${RT}/pi-agent/settings.json"
before="$(shasum "${RT}/pi-agent/settings.json" | cut -d" " -f1)"
MINDSTONE_AGENT_RUNTIME_DIR="${RT}" PI_CODING_AGENT_DIR="${RT}/pi-agent" ./scripts/init-runtime.sh >/dev/null
[[ "$(shasum "${RT}/pi-agent/settings.json" | cut -d" " -f1)" == "${before}" ]] || { echo "init-runtime rewrote a settings file it could not parse" >&2; exit 1; }
rm -rf "${RT}"
echo "ok: init-runtime seeds cache warming"

echo "Pi session built-in tool allowlist smoke test passed."
