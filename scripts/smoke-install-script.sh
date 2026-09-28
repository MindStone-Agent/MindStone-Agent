#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

bash -n install.sh
help_output="$(./install.sh --help)"
echo "${help_output}"

if ! grep -q "MindStone-Agent installer" <<<"${help_output}"; then
  echo "install.sh help did not render expected title" >&2
  exit 1
fi
if ! grep -q -- "--no-link" <<<"${help_output}"; then
  echo "install.sh help did not document --no-link" >&2
  exit 1
fi
if ! grep -q "curl -fsSL" <<<"${help_output}"; then
  echo "install.sh help did not document curl usage" >&2
  exit 1
fi

# --- #108: the installer's status check uses a per-run temp file ------------------
if grep -q "/tmp/mindstone-agent-install-status.txt" install.sh; then
  echo "install.sh still writes its status to a fixed /tmp path" >&2
  exit 1
fi
grep -q 'STATUS_FILE="$(mktemp ' install.sh || { echo "install.sh does not use mktemp for its status file" >&2; exit 1; }
grep -q "rm -f \"\${STATUS_FILE}\"" install.sh || { echo "install.sh does not remove its status file" >&2; exit 1; }

# --- #108: a first install creates a valid, not-onboarded runtime config ---------
# install.sh runs `npm run install:native`, which runs init-runtime.sh --if-no-config.
grep -q 'init-runtime.sh" --if-no-config' scripts/install-native.sh \
  || { echo "install-native.sh does not initialize the runtime config" >&2; exit 1; }
grep -q "npm run install:native" install.sh || { echo "install.sh no longer runs install:native" >&2; exit 1; }

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-install-smoke.XXXXXX")"
trap 'rm -rf "${TMP_DIR}"' EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TMP_DIR}/runtime"
unset MINDSTONE_AGENT_DATA_DIR MINDSTONE_AGENT_CONFIG
CONFIG="${MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json"

if ./scripts/init-runtime.sh --bogus >/dev/null 2>&1; then
  echo "init-runtime.sh accepted an unknown option" >&2
  exit 1
fi

(umask 022; ./scripts/init-runtime.sh --if-no-config >"${TMP_DIR}/init-1.log")
[[ -f "${CONFIG}" ]] || { echo "init-runtime.sh --if-no-config made no config.json" >&2; exit 1; }
if ls "$(dirname "${CONFIG}")" | grep -q '\.init\.'; then
  echo "init-runtime.sh left a temporary config file behind after a fresh init" >&2
  exit 1
fi

# The config validates, routing is a placeholder, it isn't onboarded (so the Console
# shows its setup banner), and its file mode is what the onboarding wizard writes.
(umask 022; CONFIG="${CONFIG}" WIZARD_COPY="${TMP_DIR}/wizard-config.json" npx tsx --eval '
import { readFileSync, statSync } from "node:fs";
import { validateMindStoneConfig, writeMindStoneConfig } from "./packages/mindstone-core/src/index.ts";
import { onboardingSteps } from "./packages/mindstone-gateway/src/admin-api.ts";
const fail = (message: string) => { console.error(message); process.exit(1); };
const config = JSON.parse(readFileSync(process.env.CONFIG!, "utf8"));
const issues = validateMindStoneConfig(config);
if (issues.length) fail(`fresh config does not validate: ${issues.join("; ")}`);
if (config.routing?.mode !== "placeholder") fail(`fresh routing.mode is ${config.routing?.mode}, want placeholder`);
if (config.gateway?.host !== "127.0.0.1" || config.gateway?.port !== 19789) fail("fresh gateway is not 127.0.0.1:19789");
if (config.gateway?.auth?.mode !== "none") fail("fresh gateway auth is not none");
if (config.gateway?.admin) fail("fresh config must not carry an admin credential");
const status = onboardingSteps(config);
if (status.onboarded !== false || status.steps.provider.done !== false) fail(`fresh config must not count as onboarded: ${JSON.stringify(status)}`);
if (status.steps.persona.done !== true) fail("fresh config has no default persona for guided setup to build on");
writeMindStoneConfig(process.env.WIZARD_COPY!, config);
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
if (mode(process.env.CONFIG!) !== mode(process.env.WIZARD_COPY!)) {
  fail(`config.json mode ${mode(process.env.CONFIG!)} differs from what the wizard writes, ${mode(process.env.WIZARD_COPY!)}`);
}
console.log(`fresh config: valid, routing placeholder, onboarded=false, mode ${mode(process.env.CONFIG!)}`);
')

# --- #108 QA F1: the wizards over the fresh config, every default accepted --------
# The fresh config must not preselect a model: the provider menu's default is
# "Leave unset", so accepting every default keeps routing on "placeholder" (and the
# gateway not onboarded) instead of pi-session with a model that doesn't exist.
for wizard in onboard routing; do
  cp "${CONFIG}" "${TMP_DIR}/wizard-${wizard}.json"
  (umask 022; WIZARD="${wizard}" WCONFIG="${TMP_DIR}/wizard-${wizard}.json" PI_CODING_AGENT_DIR="${MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent" npx tsx --eval '
import { readFileSync } from "node:fs";
import { runMindStoneConfigWizard, runMindStoneOnboardingWizard, type MindStonePrompter } from "./packages/mindstone-core/src/index.ts";
import { onboardingSteps } from "./packages/mindstone-gateway/src/admin-api.ts";
const fail = (message: string) => { console.error(`[${process.env.WIZARD}] ${message}`); process.exit(1); };
const configPath = process.env.WCONFIG!;
let prompts = 0;
const providerDefaults: string[] = [];
const guard = () => { if (++prompts > 200) fail("the wizard kept prompting (a loop?)"); };
// Accept every default: the initial value, else the first option; confirm the default
// (or yes). The one exception is the risk notice, which must be accepted to go on.
const prompter: MindStonePrompter = {
  intro: async () => undefined,
  outro: async () => undefined,
  note: async () => undefined,
  confirm: async ({ message, initialValue }) => { guard(); return /risky\. Continue onboarding/.test(message) ? true : initialValue ?? true; },
  select: async ({ message, options, initialValue }) => {
    guard();
    const value = initialValue ?? options[0]!.value;
    if (/model provider/i.test(message)) providerDefaults.push(String(value));
    return value;
  },
  text: async ({ initialValue, placeholder }) => { guard(); return initialValue ?? placeholder ?? "smoke default"; },
};
void (async () => {
const models = [{ id: "example-model", provider: "example" }];
const providers = [{ id: "example", name: "Example", modelCount: 1, availableModelCount: 1 }];
if (process.env.WIZARD === "onboard") {
  await runMindStoneOnboardingWizard(prompter, { configPath, showHeader: false, availableModels: models, availableProviders: providers });
} else {
  await runMindStoneConfigWizard(prompter, { configPath, sections: ["routing"], showHeader: false, availableModels: models, availableProviders: providers });
}
if (providerDefaults.length === 0) fail("the provider menu was never shown");
if (providerDefaults.some((value) => value !== "unset")) fail(`the provider menu preselected ${providerDefaults.join(", ")}, want unset`);
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (config.routing?.mode !== "placeholder") fail(`accepting every default set routing.mode ${config.routing?.mode}, want placeholder`);
if (config.routing?.defaultModel !== undefined) fail(`accepting every default set routing.defaultModel ${config.routing.defaultModel}`);
if (onboardingSteps(config).onboarded !== false) fail("accepting every default counted as onboarded");
console.log(`${process.env.WIZARD} wizard, every default accepted: provider default unset, routing placeholder, not onboarded`);
})().catch((error) => fail(error instanceof Error ? error.message : String(error)));
') 2> >(grep -v -e ExperimentalWarning -e trace-warnings >&2)
done

# --- #108 QA F4: a symlink at config.json, even a dangling one, is never written through
LINK_RUNTIME="${TMP_DIR}/link-runtime"
mkdir -p "${LINK_RUNTIME}/mindstone"
ln -s "${TMP_DIR}/elsewhere/config.json" "${LINK_RUNTIME}/mindstone/config.json"
mkdir -p "${TMP_DIR}/elsewhere"
for flag in --if-no-config ""; do
  MINDSTONE_AGENT_RUNTIME_DIR="${LINK_RUNTIME}" ./scripts/init-runtime.sh ${flag} >"${TMP_DIR}/init-link.log" 2>&1 \
    || { cat "${TMP_DIR}/init-link.log" >&2; echo "init-runtime.sh ${flag} failed on a dangling config symlink" >&2; exit 1; }
  if [[ -e "${TMP_DIR}/elsewhere/config.json" ]]; then
    echo "init-runtime.sh ${flag:-(no flag)} wrote through a dangling config.json symlink" >&2
    exit 1
  fi
  [[ -L "${LINK_RUNTIME}/mindstone/config.json" ]] || { echo "init-runtime.sh replaced the config.json symlink" >&2; exit 1; }
done
if ls "${LINK_RUNTIME}/mindstone/" | grep -q '\.init\.'; then
  echo "init-runtime.sh left a temporary config file behind" >&2
  exit 1
fi
echo "dangling config.json symlink: not written through, not replaced"

# --- #108: a re-run (the update path) leaves an existing runtime untouched --------
snapshot() {
  node -e '
    const { readdirSync, statSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { createHash } = require("node:crypto");
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        const st = statSync(path);
        const hash = entry.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "-";
        out.push(`${(st.mode & 0o7777).toString(8)} ${st.mtimeMs} ${hash} ${path}`);
        if (entry.isDirectory()) walk(path);
      }
    };
    walk(process.argv[1]);
    console.log(out.join("\n"));' "${MINDSTONE_AGENT_RUNTIME_DIR}"
}
# Look like an onboarded install: a real route, a 0600 config (as the gateway's admin
# API may leave it), and no default identity file.
node -e '
  const fs = require("node:fs"), f = process.argv[1], c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.routing = { ...c.routing, mode: "pi-session", defaultModel: "example/model" };
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");' "${CONFIG}"
chmod 600 "${CONFIG}"
rm "${MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/agents/default/IDENTITY.md"
before="$(snapshot)"
./scripts/init-runtime.sh --if-no-config >"${TMP_DIR}/init-2.log"
after="$(snapshot)"
if [[ "${before}" != "${after}" ]]; then
  echo "init-runtime.sh --if-no-config changed an existing runtime:" >&2
  diff <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") >&2 || true
  exit 1
fi
grep -q "left unchanged" "${TMP_DIR}/init-2.log" || { echo "init-runtime.sh --if-no-config did not report the kept config" >&2; exit 1; }
echo "re-run: existing runtime untouched (config, modes and files)"

echo "install.sh smoke passed."
