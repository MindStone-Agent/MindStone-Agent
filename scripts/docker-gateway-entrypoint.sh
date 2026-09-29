#!/usr/bin/env bash
# The gateway container's entrypoint in the Docker stack (deploy/docker/compose.yml, #171).
#
# On every start:
#   1. init-runtime.sh --if-no-config: a first start gets the runtime config
#      with safe defaults (not onboarded); an existing one is left as it is.
#   2. The Console's gateway settings are merged into config.json, keeping
#      everything else: token auth (the token from MINDSTONE_AGENT_GATEWAY_TOKEN,
#      written to secrets/gateway-token, 600), chat completions on, and
#      gateway.admin.tokenSha256 from MINDSTONE_ADMIN_TOKEN_SHA256. `routing` is
#      never touched: onboarding in the Console sets it.
#   3. The gateway runs in the foreground (exec), so the container's restart
#      policy brings it back after a restart from the Console (exit 75).
#
# With arguments, the same setup runs and then the arguments are exec'd instead
# of the gateway (for example `mindstone status`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"

CONFIG_PATH="${MINDSTONE_AGENT_CONFIG:-${MINDSTONE_AGENT_DATA_DIR}/config.json}"
export CONFIG_PATH
# The image puts the data dir beside the runtime dir, not in it; the runtime dir
# (where env.local goes) still has to exist, or `mindstone doctor` fails it.
mkdir -p "${MINDSTONE_AGENT_RUNTIME_DIR}"

"${SCRIPT_DIR}/init-runtime.sh" --if-no-config >/dev/null

# Secrets reach node through the environment only, and are never printed.
umask 077
node - <<'NODE'
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const fail = (message) => {
  console.error(`[docker-gateway-entrypoint] ${message}`);
  process.exit(1);
};
const configPath = process.env.CONFIG_PATH;
const token = (process.env.MINDSTONE_AGENT_GATEWAY_TOKEN || "").trim();
const digest = (process.env.MINDSTONE_ADMIN_TOKEN_SHA256 || "").trim().toLowerCase();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

if (token.length < 16) fail("MINDSTONE_AGENT_GATEWAY_TOKEN is not set (or shorter than 16 characters): the gateway won't start without token auth. Check gateway.env.");
if (!/^[0-9a-f]{64}$/.test(digest) || digest === sha256("")) fail("MINDSTONE_ADMIN_TOKEN_SHA256 must be the sha256 (64 hex characters) of the admin credential. Check gateway.env.");
if (digest === sha256(token)) fail("the admin credential must differ from the gateway token, or the admin API stays off.");

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^﻿/, ""));
} catch (error) {
  fail(`${configPath} could not be read as JSON (${error.message}); it was left unchanged.`);
}
if (!config || typeof config !== "object" || Array.isArray(config)) fail(`${configPath} is not a JSON object; it was left unchanged.`);

const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const writeAtomic = (file, text, mode) => {
  const tmp = `${file}.entrypoint.${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
};

// The service token, in a 600 file beside the config (relative paths are
// relative to the config's folder), as the native install keeps it.
const secretsDir = path.join(path.dirname(configPath), "secrets");
fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
fs.chmodSync(secretsDir, 0o700);
const tokenFile = path.join(secretsDir, "gateway-token");
let current;
try { current = fs.readFileSync(tokenFile, "utf8").trim(); } catch { current = undefined; }
if (current !== token) writeAtomic(tokenFile, `${token}\n`, 0o600);
fs.chmodSync(tokenFile, 0o600);

const before = JSON.stringify(config);
const gateway = object(config.gateway);
const http = object(gateway.http);
gateway.auth = { mode: "token", tokenFile: "secrets/gateway-token" };
gateway.http = { ...http, chatCompletions: { ...object(http.chatCompletions), enabled: true } };
gateway.admin = { ...object(gateway.admin), tokenSha256: digest };
config.gateway = gateway;
if (JSON.stringify(config) !== before) {
  const mode = fs.statSync(configPath).mode & 0o777;
  writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, mode);
  console.log("[docker-gateway-entrypoint] Console settings merged into config.json (token auth, chat completions, admin digest).");
} else {
  console.log("[docker-gateway-entrypoint] config.json already has the Console settings.");
}
NODE

# The gateway reads its token from the file above; the variable isn't passed on,
# so the agent's own processes don't inherit it.
unset MINDSTONE_AGENT_GATEWAY_TOKEN

cd "${MINDSTONE_AGENT_ROOT}"
if [[ $# -gt 0 ]]; then
  exec "$@"
fi
exec node packages/mindstone-gateway/dist/main.js
