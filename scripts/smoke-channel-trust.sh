#!/usr/bin/env bash
set -euo pipefail

# Channel-turn trust boundary smoke (issue #61), through the real gateway with
# the loopback connector and a capturing mock provider:
#   1. the owner's direct message gets USER.md, the memory index and recall
#   2. a group turn (session.mode "single") gets none of them, and none of the
#      owner's DM text: it runs in its own per-surface session
#   3. a message with no chat type is not treated as a DM: no reply without a
#      mention, and no owner context when mentioned
#   4. email: an unauthenticated From header is not verified; an aligned
#      DMARC/DKIM pass from Gmail's own Authentication-Results header is
# Synthetic sentinels only. Binds gateway port base+23 — serialize per smoke protocol.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-channel-trust-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 23))"

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

echo "== Channel-turn trust boundary smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-channel-trust-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"
SPOOL_DIR="${RUNTIME_DATA}/connectors/loopback"
CAPTURE="${TEMP_RUNTIME}/capture.jsonl"
export CAPTURE

# --- 4. Email sender verification (no ports) ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { emailSenderVerified, gmailMessageToInbound } from "./packages/mindstone-gateway/src/connectors/email.ts";

const mail = (headers: Array<[string, string]>) => ({
  id: "m1",
  threadId: "t1",
  payload: { headers: headers.map(([name, value]) => ({ name, value })) },
});
const from: [string, string] = ["From", "Owner <owner@example.com>"];
const gmail = (results: string) => mail([["Authentication-Results", results], from]);

assert.equal(emailSenderVerified(mail([from]), "owner@example.com"), false, "no Authentication-Results");
assert.equal(emailSenderVerified(gmail("mx.google.com; dmarc=pass (p=NONE) header.from=example.com"), "owner@example.com"), true);
assert.equal(emailSenderVerified(gmail("mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=x"), "owner@example.com"), true);
assert.equal(emailSenderVerified(gmail("mx.google.com; dkim=pass header.i=@mail.example.com"), "owner@example.com"), false, "a child domain can't vouch for its parent");
assert.equal(emailSenderVerified(gmail("mx.google.com; dkim=pass header.i=@example.com"), "owner@mail.example.com"), true, "a parent domain may vouch for a child");
assert.equal(emailSenderVerified(gmail("mx.google.com; dkim=pass header.i=@attacker.test; dmarc=fail header.from=example.com"), "owner@example.com"), false);
assert.equal(emailSenderVerified(gmail("mx.google.com; spf=pass smtp.mailfrom=example.com"), "owner@example.com"), false, "SPF alone is not From authentication");
assert.equal(emailSenderVerified(gmail("mx.google.com; dmarc=fail header.from=example.com"), "owner@example.com"), false);
assert.equal(emailSenderVerified(gmail("evil.test; dmarc=pass header.from=example.com"), "owner@example.com"), false, "only Gmail's own header counts");
// A forged pass further down is ignored: only the topmost header is read.
assert.equal(
  emailSenderVerified(mail([["Authentication-Results", "mx.google.com; dmarc=fail header.from=example.com"], ["Authentication-Results", "mx.google.com; dmarc=pass header.from=example.com"], from]), "owner@example.com"),
  false,
);
assert.equal(gmailMessageToInbound(mail([from]))?.senderVerified, false);
assert.equal(gmailMessageToInbound(gmail("mx.google.com; dmarc=pass header.from=example.com"))?.senderVerified, true);
console.log("email sender verification assertions passed");
TS

# --- Core contract units (no ports) ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { connectorSessionKey, isOwnerDirectMessage, shouldTriggerConnectorReply } from "./packages/mindstone-core/src/index.ts";

const single = { session: { mode: "single" as const, defaultSessionKey: "agent:default:main" } };
const key = (message: Parameters<typeof isOwnerDirectMessage>[0]) => connectorSessionKey({ config: single, connectorId: "loopback", message });

assert.equal(isOwnerDirectMessage({ text: "x", chatType: "direct" }), true);
for (const chatType of ["group", "channel", "thread", undefined] as const) {
  assert.equal(isOwnerDirectMessage({ text: "x", chatType }), false, `${chatType} is not the owner`);
}
assert.equal(isOwnerDirectMessage({ text: "x", chatType: "direct", senderVerified: false }), false);

assert.equal(key({ text: "x", senderId: "clint", chatId: "dm", chatType: "direct" }), "agent:default:main");
for (const message of [
  { text: "x", senderId: "clint", chatId: "ops", chatType: "group" as const },
  { text: "x", senderId: "clint", chatId: "ops" },
  { text: "x", senderId: "clint", chatId: "dm", chatType: "direct" as const, senderVerified: false },
]) {
  assert.notEqual(key(message), "agent:default:main", `non-owner turn must not share the main session: ${JSON.stringify(message)}`);
}
assert.ok(key({ text: "x", senderId: "clint", chatId: "ops" }).includes("unknown"));

assert.equal(shouldTriggerConnectorReply({}, { text: "x" }).respond, false, "missing chat type needs a mention");
assert.equal(shouldTriggerConnectorReply({}, { text: "x", mentioned: true }).respond, true);
console.log("core trust-boundary assertions passed");
TS

# --- Gateway end to end ---
cat >"${RUNTIME_DATA}/agents/default/USER.md" <<'MD'
# User

Owner profile sentinel: TEAL-OWNER-PROFILE.
MD
cat >"${RUNTIME_DATA}/memory/project_heron_budget.md" <<'MD'
---
name: project_heron_budget
description: Heron budget memory sentinel.
type: project
created: 2026-09-27
critical: false
evergreen: true
---

# Heron budget

The heron budget sentinel is AMBER-RECALL-SECRET.
MD

printf '%s\n' '# Memory index' '' '- [Heron budget](project_heron_budget.md) — heron budget pointer' >> "${RUNTIME_DATA}/memory/MEMORY.md"

node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = {
  mode: "mock",
  defaultAgentId: "default",
  defaultModel: "mindstone/mock",
  mock: { responsePrefix: "Mock response", captureFile: process.env.CAPTURE },
};
config.gateway = { ...(config.gateway ?? {}), auth: { mode: "none" } };
config.session = { mode: "single" };
config.memory = {
  ...(config.memory ?? {}),
  autoRecall: true,
  vectorStore: "memory",
  recall: { maxResults: 3, maxPromptTokens: 500, minScore: 0.1 },
};
config.channels = { loopback: { enabled: true, allowedSenders: ["clint"], pollMs: 100 } };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-channel-trust-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

INBOX="${SPOOL_DIR}/inbox.jsonl"
OUTBOX="${SPOOL_DIR}/outbox.jsonl"
mkdir -p "${SPOOL_DIR}"

wait_for_lines() {
  local file="$1" expected="$2"
  for _ in $(seq 1 40); do
    if [[ -f "${file}" && "$(grep -c . "${file}" 2>/dev/null || echo 0)" -ge "${expected}" ]]; then
      return 0
    fi
    sleep 0.25
  done
  echo "${file} never reached ${expected} line(s)" >&2
  cat "${file}" 2>/dev/null >&2 || true
  tail -40 /tmp/mindstone-agent-channel-trust-gateway.log >&2 || true
  return 1
}

# 1. The owner's DM: owner context goes in, and its text becomes owner DM history.
printf '%s\n' '{"messageId":"d1","text":"What is the heron budget? My DM note is VIOLET-DM-HISTORY.","senderId":"clint","chatId":"dm-clint","chatType":"direct"}' >> "${INBOX}"
wait_for_lines "${CAPTURE}" 1
wait_for_lines "${OUTBOX}" 1

# 2. A mentioned group message asking the same thing.
printf '%s\n' '{"messageId":"g1","text":"What is the heron budget?","senderId":"clint","chatId":"ops","chatType":"group","mentioned":true}' >> "${INBOX}"
wait_for_lines "${CAPTURE}" 2
wait_for_lines "${OUTBOX}" 2

# 3a. No chat type and no mention: not treated as a DM, so no reply.
printf '%s\n' '{"messageId":"u1","text":"ambient heron chatter","senderId":"clint","chatId":"ops2"}' >> "${INBOX}"
# 3b. No chat type, mentioned: a reply, without owner context.
printf '%s\n' '{"messageId":"u2","text":"What is the heron budget?","senderId":"clint","chatId":"ops3","mentioned":true}' >> "${INBOX}"
wait_for_lines "${CAPTURE}" 3
wait_for_lines "${OUTBOX}" 3
sleep 1

node <<'NODE'
const { readFileSync } = require("node:fs");
const requests = readFileSync(process.env.CAPTURE, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const outbox = readFileSync(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/connectors/loopback/outbox.jsonl`, "utf8").trim().split("\n");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (requests.length !== 3) fail(`expected 3 model requests (DM, group, mentioned no-chat-type), got ${requests.length}`);
if (outbox.length !== 3) fail(`expected 3 replies; the unmentioned no-chat-type message must not reply. Outbox:\n${outbox.join("\n")}`);
if (outbox.some((line) => line.includes('"inReplyToMessageId":"u1"'))) fail("replied to an unmentioned message with no chat type");

const text = (request) => request.messages.map((message) => message.text ?? "").join("\n");
const [dm, group, unknown] = requests.map(text);
for (const sentinel of ["TEAL-OWNER-PROFILE", "AMBER-RECALL-SECRET", "project_heron_budget"]) {
  if (!dm.includes(sentinel)) fail(`control failed: the owner's DM is missing ${sentinel}, so this smoke can't show it being withheld`);
}
for (const [label, payload] of [["group", group], ["no-chat-type", unknown]]) {
  for (const sentinel of ["TEAL-OWNER-PROFILE", "AMBER-RECALL-SECRET", "project_heron_budget", "VIOLET-DM-HISTORY"]) {
    if (payload.includes(sentinel)) fail(`${label} turn payload leaked ${sentinel}:\n${payload}`);
  }
  if (!payload.includes("heron budget")) fail(`${label} turn payload is missing its own message`);
}
console.log("gateway trust-boundary assertions passed");
NODE

echo "Channel-turn trust boundary smoke test passed."
