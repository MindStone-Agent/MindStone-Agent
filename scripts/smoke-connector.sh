#!/usr/bin/env bash
set -euo pipefail

# Channel connector framework smoke (issue #16):
#   1. shared contract units: credential refs (env/file, masked, mode warning),
#      allowlist/pairing FAIL-CLOSED, mention/trigger policy, thread/session
#      mapping, delivery queue retry + dead-letter
#   2. loopback reference connector end-to-end THROUGH the gateway: inbound
#      spool -> access -> trigger -> session/source metadata -> route (mock)
#      -> delivery queue -> outbox
#   3. connector failures surface in doctor/status WITHOUT crashing the gateway
#   Binds gateway port base+11 — serialize per smoke protocol.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-connector-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 11))"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"

cd "${PROJECT_ROOT}"

echo "== Channel connector framework smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-connector-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"
SPOOL_DIR="${RUNTIME_DATA}/connectors/loopback"

# --- 1. Shared contract unit assertions (no ports) ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import {
  ConnectorDeliveryQueue,
  connectorSessionKey,
  connectorTranscriptSource,
  evaluateConnectorAccess,
  maskCredential,
  resolveConnectorCredential,
  shouldTriggerConnectorReply,
} from "./packages/mindstone-core/src/index.ts";

const runtime = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone`;

// Credential refs: env wins, file fallback, empty/missing fail visibly, preview masks.
process.env.CONNECTOR_SMOKE_TOKEN = "tok-abcdef-123456";
const fromEnv = resolveConnectorCredential({ tokenEnv: "CONNECTOR_SMOKE_TOKEN" });
assert.ok(fromEnv.present && fromEnv.source === "env" && fromEnv.value === "tok-abcdef-123456");
mkdirSync(`${runtime}/secrets`, { recursive: true });
writeFileSync(`${runtime}/secrets/loopback.token`, "file-secret-value\n");
chmodSync(`${runtime}/secrets/loopback.token`, 0o600);
const fromFile = resolveConnectorCredential({ tokenFile: "secrets/loopback.token" });
assert.ok(fromFile.present && fromFile.source === "file" && fromFile.value === "file-secret-value" && !fromFile.warning);
chmodSync(`${runtime}/secrets/loopback.token`, 0o644);
const loose = resolveConnectorCredential({ tokenFile: "secrets/loopback.token" });
assert.ok(loose.present && loose.warning?.includes("chmod 600"), "world-readable secret file must warn");
const missing = resolveConnectorCredential({ tokenEnv: "CONNECTOR_SMOKE_TOKEN_MISSING" });
assert.ok(!missing.present && missing.error);
assert.ok(!resolveConnectorCredential(undefined).present);
const masked = maskCredential("tok-abcdef-123456");
assert.ok(!masked.includes("abcdef"), "mask must not reveal the secret body");

// Access: FAILS CLOSED — empty policy denies; paired or allowlisted or "*" allows; chat list enforced.
const deny = evaluateConnectorAccess({}, { text: "hi", senderId: "mallory" });
assert.equal(deny.allowed, false);
assert.equal(evaluateConnectorAccess({ allowedSenders: ["clint"] }, { text: "hi" }).allowed, false, "no senderId fails closed");
assert.equal(evaluateConnectorAccess({ allowedSenders: ["clint"] }, { text: "hi", senderId: "clint" }).allowed, true);
assert.equal(evaluateConnectorAccess({ pairedSenders: ["dev-1"] }, { text: "hi", senderId: "dev-1" }).allowed, true);
assert.equal(evaluateConnectorAccess({ allowedSenders: ["*"] }, { text: "hi", senderId: "anyone" }).allowed, true);
assert.equal(
  evaluateConnectorAccess({ allowedSenders: ["clint"], allowedChats: ["ops"] }, { text: "hi", senderId: "clint", chatId: "random" }).allowed,
  false,
  "chat allowlist enforced",
);

// Trigger policy: DM always; group needs mention/prefix unless opted in; prefix strips.
assert.equal(shouldTriggerConnectorReply({}, { text: "hi", chatType: "direct" }).respond, true);
assert.equal(shouldTriggerConnectorReply({}, { text: "hi", chatType: "group" }).respond, false);
assert.equal(shouldTriggerConnectorReply({}, { text: "hi", chatType: "group", mentioned: true }).respond, true);
assert.equal(shouldTriggerConnectorReply({ respondWithoutMention: true }, { text: "hi", chatType: "group" }).respond, true);
const prefixed = shouldTriggerConnectorReply({ triggerPrefix: "!ms" }, { text: "!ms run report", chatType: "group" });
assert.ok(prefixed.respond && prefixed.text === "run report", "trigger prefix must strip");

// Session mapping: single mode collapses to canonical; per_surface keys threads separately.
const single = connectorSessionKey({
  config: { session: { mode: "single", defaultSessionKey: "agent:default:main" } },
  connectorId: "loopback",
  message: { text: "hi", senderId: "clint", chatId: "dm", chatType: "direct" },
});
assert.equal(single, "agent:default:main");
const perThread = connectorSessionKey({
  config: { session: { mode: "per_surface" } },
  connectorId: "loopback",
  message: { text: "hi", senderId: "clint", chatId: "ops", chatType: "thread", threadId: "th-99" },
});
assert.ok(perThread.includes("th-99") && perThread.includes("ops"), `thread mapping: ${perThread}`);
const source = connectorTranscriptSource({ connectorId: "loopback", message: { text: "hi", senderId: "clint", chatId: "ops", chatType: "group" } });
assert.equal(source.substrate, "connector:loopback");
assert.equal(source.channel, "ops");

// Delivery queue: retry then success; permanent failure dead-letters with the error kept.
const queue = new ConnectorDeliveryQueue("unit-conn");
queue.enqueue({ text: "flaky" });
queue.enqueue({ text: "doomed" });
let flakyAttempts = 0;
for (let round = 0; round < 3; round += 1) {
  await queue.drain(async (entry) => {
    if (entry.message.text === "flaky") {
      flakyAttempts += 1;
      if (flakyAttempts < 3) throw new Error("transient");
      return;
    }
    throw new Error("permanent failure");
  });
}
const status = queue.status();
assert.equal(status.delivered, 1, "flaky entry delivers on retry");
assert.equal(status.dead, 1, "doomed entry dead-letters");
assert.equal(status.pending, 0);
assert.equal(queue.deadLetters()[0].lastError, "permanent failure");
console.log("connector contract unit assertions passed");
TS

# --- 2. Loopback connector end-to-end through the gateway ---
node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "default", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.gateway = { ...(config.gateway ?? {}), auth: { mode: "none" } };
config.session = { mode: "per_surface" };
config.channels = {
  loopback: { enabled: true, allowedSenders: ["clint"], triggerPrefix: "!ms", pollMs: 100 },
  "ghost-connector": { enabled: true },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-connector-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

INBOX="${SPOOL_DIR}/inbox.jsonl"
OUTBOX="${SPOOL_DIR}/outbox.jsonl"
mkdir -p "${SPOOL_DIR}"

wait_for_outbox_lines() {
  local expected="$1"
  for _ in $(seq 1 40); do
    if [[ -f "${OUTBOX}" && "$(grep -c . "${OUTBOX}" 2>/dev/null || echo 0)" -ge "${expected}" ]]; then
      return 0
    fi
    sleep 0.25
  done
  echo "outbox never reached ${expected} line(s)" >&2
  cat "${OUTBOX}" 2>/dev/null >&2 || true
  return 1
}

# Runtime status is written async by the connector runtime — POLL with a wide
# budget and print the actual state on timeout; never assert after a fixed
# sleep (or, worse, immediately after /health answers).
wait_for_status() {
  local file="$1" pattern="$2"
  for _ in $(seq 1 40); do
    grep -q "${pattern}" "${file}" 2>/dev/null && return 0
    sleep 0.25
  done
  echo "status never matched: ${pattern}" >&2
  echo "actual status: $(cat "${file}" 2>/dev/null || echo '<missing>')" >&2
  return 1
}

# Allowed DM -> mock reply lands in the outbox with thread correlation.
printf '%s\n' '{"messageId":"m1","text":"hello agent","senderId":"clint","chatId":"dm-clint","chatType":"direct"}' >> "${INBOX}"
wait_for_outbox_lines 1
grep -q '"inReplyToMessageId":"m1"' "${OUTBOX}"
grep -q 'Mock response' "${OUTBOX}"

# Disallowed sender -> denied (fail closed), outbox does NOT grow.
printf '%s\n' '{"messageId":"m2","text":"let me in","senderId":"mallory","chatId":"dm-mallory","chatType":"direct"}' >> "${INBOX}"
# Group message without mention/prefix -> no reply.
printf '%s\n' '{"messageId":"m3","text":"ambient chatter","senderId":"clint","chatId":"ops","chatType":"group"}' >> "${INBOX}"
# Group message WITH the trigger prefix -> reply.
printf '%s\n' '{"messageId":"m4","text":"!ms status please","senderId":"clint","chatId":"ops","chatType":"group"}' >> "${INBOX}"
wait_for_outbox_lines 2
test "$(grep -c . "${OUTBOX}")" -eq 2
grep -q '"inReplyToMessageId":"m4"' "${OUTBOX}"

# Denial is counted in runtime status; the listener is still running.
STATUS_FILE="${RUNTIME_DATA}/connectors/loopback/status.json"
wait_for_status "${STATUS_FILE}" '"deniedCount": 1'
grep -q '"state": "running"' "${STATUS_FILE}"

# Transcript for the DM session carries connector source metadata.
DM_KEY_FILE="${RUNTIME_DATA}/transcripts/$(node -p 'Buffer.from("agent:default:dm-clint:direct:clint","utf-8").toString("base64url")').jsonl"
test -f "${DM_KEY_FILE}"
grep -q '"substrate": *"connector:loopback"' "${DM_KEY_FILE}" || grep -q '"substrate":"connector:loopback"' "${DM_KEY_FILE}"

# --- 3. Failures are VISIBLE, not fatal ---
# The gateway is still healthy despite a configured connector with no implementation.
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/health")"
test "${HEALTH_CODE}" = "200"
wait_for_status "${RUNTIME_DATA}/connectors/ghost-connector/status.json" '"state": "error"'
# Reason lands in the same atomic status write as the error state.
grep -q 'no registered connector implementation' "${RUNTIME_DATA}/connectors/ghost-connector/status.json"

kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# Phase 2: a REGISTERED connector with an unresolvable credential ref must fail
# visibly at startup (error status) while the gateway keeps serving.
node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.channels = {
  loopback: { enabled: true, tokenEnv: "DEFINITELY_MISSING_TOKEN_ENV", allowedSenders: ["clint"] },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
./scripts/start-gateway.sh >/tmp/mindstone-agent-connector-gateway2.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/health")"
test "${HEALTH_CODE}" = "200"
wait_for_status "${RUNTIME_DATA}/connectors/loopback/status.json" '"state": "error"'
# Reason lands in the same atomic status write as the error state.
grep -q 'credential unresolved' "${RUNTIME_DATA}/connectors/loopback/status.json"
kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# Doctor surfaces the troubled connector as a warn (no crash; warns are non-fatal).
DOCTOR_OUT="$(./scripts/mindstone doctor 2>&1 || true)"
grep -q "connectors.catalog" <<<"${DOCTOR_OUT}"
grep -q "loopback" <<<"${DOCTOR_OUT}"
grep -q "credential unresolved" <<<"${DOCTOR_OUT}"

# Status exposes consolidated, secret-free connector rows.
STATUS_JSON="$(./scripts/mindstone status --json)"
grep -q '"connectorId": "loopback"' <<<"${STATUS_JSON}"
grep -q '"present": false' <<<"${STATUS_JSON}"
if grep -q 'DEFINITELY_MISSING_TOKEN_ENV_VALUE\|tok-abcdef' <<<"${STATUS_JSON}"; then
  echo "status output must never contain secret values" >&2
  exit 1
fi

echo "Channel connector framework smoke test passed."
