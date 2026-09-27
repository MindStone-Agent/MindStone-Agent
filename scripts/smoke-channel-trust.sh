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
#      DMARC/DKIM pass from Gmail's own Authentication-Results header is;
#      text inside comments or quoted strings never counts; DMARC fail vetoes
#   5. another allowlisted sender's DM is not the owner's (ownerSenders)
#   6. the handoff file and owner-only invariants never reach non-owner turns
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
export MINDSTONE_AGENT_MOCK_CAPTURE=1

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
// Text a sender controls, inside a comment or a quoted string, is not a result.
assert.equal(
  emailSenderVerified(gmail('mx.google.com; spf=pass (google.com: domain of "x;dmarc=pass header.from=example.com y"@attacker.test designates 1.2.3.4) smtp.mailfrom="x;dmarc=pass header.from=example.com y"@attacker.test; dmarc=fail (p=NONE) header.from=example.com'), "owner@example.com"),
  false,
  "a DMARC pass smuggled through an SPF comment or quoted local part",
);
// No genuine DMARC result to veto it: only comment stripping stops these.
assert.equal(emailSenderVerified(gmail("mx.google.com; spf=pass (x; dkim=pass header.d=example.com ) smtp.mailfrom=a@attacker.test"), "owner@example.com"), false);
assert.equal(emailSenderVerified(gmail('mx.google.com; spf=pass smtp.mailfrom="x;dkim=pass header.d=example.com y"@attacker.test'), "owner@example.com"), false);
assert.equal(emailSenderVerified(gmail("mx.google.com; dkim=pass header.i=@example.com; dmarc=fail header.from=example.com"), "owner@example.com"), false, "DMARC fail vetoes a DKIM pass");
// Round 3: a sender-controlled local part that closes or opens a comment or a quote.
for (const [label, results] of [
  ["unterminated quote hides dmarc=fail", 'mx.google.com; spf=pass (google.com: domain of "a)b;dkim=pass header.d=example.com c"@attacker.test designates 1.2.3.4) smtp.mailfrom="a)b;dkim=pass header.d=example.com c"@attacker.test; dmarc=fail (p=NONE) header.from=example.com'],
  ["early close plus (( swallows the veto", 'mx.google.com; spf=pass (google.com: domain of "a);dmarc=pass header.from=example.com ((b"@attacker.test designates 1.2.3.4) smtp.mailfrom=x@attacker.test; dmarc=fail header.from=example.com'],
  ["early close, no DMARC record", "mx.google.com; spf=pass (google.com: domain of a);dmarc=pass header.from=example.com ((b@attacker.test designates 1.2.3.4) smtp.mailfrom=x@attacker.test"],
  ["DKIM variant", "mx.google.com; spf=pass (google.com: a);dkim=pass header.d=example.com ((b) smtp.mailfrom=x@attacker.test"],
  ["two DMARC results", "mx.google.com; dmarc=pass header.from=example.com; dmarc=fail header.from=example.com"],
  // Each of these gets past every check but one, so each check is shown able to fail.
  ["quote inside a comment (only the quote rule)", 'mx.google.com; spf=pass (google.com: "a);dkim=pass header.d=example.com (b") smtp.mailfrom=x@attacker.test'],
  ["balanced comments swallow dmarc=fail (only the count rule)", "mx.google.com; spf=pass (a);dkim=pass header.d=example.com ((b) smtp.mailfrom=x@attacker.test; dmarc=fail header.from=example.com)"],
  ["a second DMARC result for another domain (only the one-DMARC rule)", "mx.google.com; dmarc=pass header.from=example.com; dmarc=fail header.from=attacker.test"],
] as const) {
  assert.equal(emailSenderVerified(gmail(results), "owner@example.com"), false, label);
}
// Control: Gmail's real shape still verifies.
assert.equal(
  emailSenderVerified(gmail("mx.google.com; dkim=pass header.i=@example.com header.s=20230601 header.b=AbC+d/E=; spf=pass (google.com: domain of owner@example.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=owner@example.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com"), "owner@example.com"),
  true,
  "control: a real Gmail header verifies",
);
assert.equal(emailSenderVerified(gmail("mx.google.com; dkim=pass header.d=example.com header.i=@other.test"), "owner@example.com"), true, "header.d is the signing domain");
assert.equal(emailSenderVerified(gmail("mx.google.com; dkim=pass header.d=com"), "owner@example.com"), false, "a bare TLD never aligns");
assert.equal(
  gmailMessageToInbound(mail([["Authentication-Results", "mx.google.com; dmarc=pass header.from=attacker.test"], ["From", "owner@example.com, x@attacker.test"]]))?.senderVerified,
  false,
  "a From header with two addresses is never verified",
);
assert.equal(gmailMessageToInbound(mail([from]))?.senderVerified, false);
assert.equal(gmailMessageToInbound(gmail("mx.google.com; dmarc=pass header.from=example.com"))?.senderVerified, true);
console.log("email sender verification assertions passed");
TS

# --- Core contract units (no ports) ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { connectorOwnerSenders, connectorSessionKey, isOwnerDirectMessage, shouldTriggerConnectorReply } from "./packages/mindstone-core/src/index.ts";

const single = {
  session: { mode: "single" as const, defaultSessionKey: "agent:default:main" },
  channels: { loopback: { allowedSenders: ["clint", "alice", "*"], ownerSenders: [" Clint ", "*"] } },
};
const key = (message: Parameters<typeof isOwnerDirectMessage>[0]) => connectorSessionKey({ config: single, connectorId: "loopback", message });
const owners = connectorOwnerSenders(single, "loopback");
assert.deepEqual(owners, ["clint"], "ownerSenders is trimmed, lower-cased, and never includes *");
assert.deepEqual(connectorOwnerSenders({ channels: { loopback: { allowedSenders: ["clint"] } } }, "loopback"), [], "no ownerSenders means nobody is the owner");

assert.equal(isOwnerDirectMessage({ text: "x", senderId: "clint", chatType: "direct" }, owners), true);
assert.equal(isOwnerDirectMessage({ text: "x", senderId: "CLINT", chatType: " Direct " }, owners), true);
assert.equal(isOwnerDirectMessage({ text: "x", senderId: "alice", chatType: "direct" }, owners), false, "an allowlisted non-owner is not the owner");
assert.equal(isOwnerDirectMessage({ text: "x", chatType: "direct" }, owners), false, "no sender id");
for (const chatType of ["group", "channel", "thread", undefined] as const) {
  assert.equal(isOwnerDirectMessage({ text: "x", senderId: "clint", chatType }, owners), false, `${chatType} is not the owner`);
}
assert.equal(isOwnerDirectMessage({ text: "x", senderId: "clint", chatType: "direct", senderVerified: false }, owners), false);
const kate = connectorOwnerSenders({ channels: { email: { ownerSenders: ["kate@victim.test"] } } }, "email");
assert.equal(isOwnerDirectMessage({ text: "x", senderId: "kate@victim.test", chatType: "direct" }, kate), true);
assert.equal(isOwnerDirectMessage({ text: "x", senderId: "\u212Aate@victim.test", chatType: "direct" }, kate), false, "a Unicode lookalike never case-folds onto the owner");

assert.equal(key({ text: "x", senderId: "clint", chatId: "dm", chatType: "direct" }), "agent:default:main");
for (const message of [
  { text: "x", senderId: "alice", chatId: "dm-alice", chatType: "direct" as const },
  { text: "x", senderId: "clint", chatId: "ops", chatType: "group" as const },
  { text: "x", senderId: "clint", chatId: "ops" },
  { text: "x", senderId: "clint", chatId: "dm", chatType: "direct" as const, senderVerified: false },
  { text: "x", senderId: "clint", chatId: "dm", chatType: "DIRECT" as never, senderVerified: false },
]) {
  assert.notEqual(key(message), "agent:default:main", `non-owner turn must not share the main session: ${JSON.stringify(message)}`);
}
assert.ok(key({ text: "x", senderId: "clint", chatId: "ops" }).includes("unknown"));

assert.equal(shouldTriggerConnectorReply({}, { text: "x" }).respond, false, "missing chat type needs a mention");
assert.equal(shouldTriggerConnectorReply({}, { text: "x", mentioned: true }).respond, true);
assert.equal(shouldTriggerConnectorReply({}, { text: "x", chatType: " Direct " as never }).respond, true, "one chat-type normalizer everywhere");
const other = connectorSessionKey({ config: single, connectorId: "slack", message: { text: "x", senderId: "clint", chatId: "ops", chatType: "group" } });
assert.notEqual(other, key({ text: "x", senderId: "clint", chatId: "ops", chatType: "group" }), "two connectors never share a non-owner session");
console.log("core trust-boundary assertions passed");
TS

# --- Pi session options per audience (no ports, no model) ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { piSessionRunnerOptions } from "./packages/mindstone-gateway/src/index.ts";
import { piSessionResourceOptions } from "./packages/mindstone-gateway/src/pi-session-executor.ts";

const config = {
  routing: { mode: "pi-session" as const, pi: { builtinTools: ["read", "bash"], additionalExtensionPaths: ["/x/adapter"], additionalSkillPaths: ["/x/skills"], additionalPromptTemplatePaths: ["/x/pt"] } },
  contextManagement: { pruning: { enabled: true } },
} as never;
const owner = piSessionRunnerOptions(config, "owner");
const guest = piSessionRunnerOptions(config, "non_owner");
assert.deepEqual(owner.builtinTools, ["read", "bash"], "control: the owner keeps configured built-ins");
assert.deepEqual(guest.builtinTools, [], "a non-owner turn gets no built-in tools");
assert.deepEqual(guest.additionalExtensionPaths, []);
assert.deepEqual(guest.additionalSkillPaths, []);
assert.equal(guest.noSkills, true);
assert.equal(guest.noContextFiles, true);
assert.equal(guest.noPromptTemplates, true, "a non-owner /name can't expand the owner's prompt templates");
assert.deepEqual(guest.additionalPromptTemplatePaths, []);
const ownerResources = piSessionResourceOptions(owner);
const guestResources = piSessionResourceOptions(guest);
assert.ok(!ownerResources.noExtensions, "control: the owner's discovered extensions load");
assert.equal(guestResources.noExtensions, true, "a non-owner turn skips discovered extensions (the MindStone adapter)");
assert.equal(
  guestResources.extensionFactories?.length,
  ownerResources.extensionFactories?.length,
  "MindStone's own pruning/compaction extensions still run on a non-owner turn",
);
console.log("pi audience assertions passed");
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
cat >"${RUNTIME_DATA}/memory/feedback_private_rule.md" <<'MD'
---
name: feedback_private_rule
description: Owner-only rule.
type: feedback
critical: true
invariant: Never mention the PLUM-INVARIANT-PRIVATE arrangement.
---

Owner-only rule body.
MD
cat >"${RUNTIME_DATA}/memory/feedback_public_rule.md" <<'MD'
---
name: feedback_public_rule
description: Rule for every audience.
type: feedback
critical: true
invariant: Always answer politely (SAGE-INVARIANT-PUBLIC).
invariant_audience: all
---

Public rule body.
MD
mkdir -p "${RUNTIME_DATA}/transcripts"
printf '%s\n' '# MindStone-Agent Auto-Compact Handoff' '' '- Session: agent:default:main' '' '## Recent transcript tail' '' 'CORAL-HANDOFF-TAIL owner DM text' > "${RUNTIME_DATA}/transcripts/.handoff.md"

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
config.channels = { loopback: { enabled: true, allowedSenders: ["clint", "alice"], ownerSenders: ["clint"], pollMs: 100 } };
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

# 5. Another allowlisted sender's DM: allowed to talk, but not the owner.
printf '%s\n' '{"messageId":"a1","text":"What is the heron budget?","senderId":"alice","chatId":"dm-alice","chatType":"direct"}' >> "${INBOX}"
wait_for_lines "${CAPTURE}" 4
wait_for_lines "${OUTBOX}" 4
sleep 1

node <<'NODE'
const { readFileSync } = require("node:fs");
const requests = readFileSync(process.env.CAPTURE, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const outbox = readFileSync(`${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/connectors/loopback/outbox.jsonl`, "utf8").trim().split("\n");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (requests.length !== 4) fail(`expected 4 model requests (owner DM, group, mentioned no-chat-type, alice DM), got ${requests.length}`);
if (outbox.length !== 4) fail(`expected 4 replies; the unmentioned no-chat-type message must not reply. Outbox:\n${outbox.join("\n")}`);
if (outbox.some((line) => line.includes('"inReplyToMessageId":"u1"'))) fail("replied to an unmentioned message with no chat type");

const text = (request) => request.messages.map((message) => message.text ?? "").join("\n");
const [dm, group, unknown, alice] = requests.map(text);
for (const sentinel of ["TEAL-OWNER-PROFILE", "AMBER-RECALL-SECRET", "project_heron_budget", "CORAL-HANDOFF-TAIL", "PLUM-INVARIANT-PRIVATE", "SAGE-INVARIANT-PUBLIC"]) {
  if (!dm.includes(sentinel)) fail(`control failed: the owner's DM is missing ${sentinel}, so this smoke can't show it being withheld`);
}
for (const [label, payload] of [["group", group], ["no-chat-type", unknown], ["allowlisted non-owner DM", alice]]) {
  for (const sentinel of ["TEAL-OWNER-PROFILE", "AMBER-RECALL-SECRET", "project_heron_budget", "VIOLET-DM-HISTORY", "CORAL-HANDOFF-TAIL", "PLUM-INVARIANT-PRIVATE", "feedback_private_rule"]) {
    if (payload.includes(sentinel)) fail(`${label} turn payload leaked ${sentinel}:\n${payload}`);
  }
  if (!payload.includes("heron budget")) fail(`${label} turn payload is missing its own message`);
  if (!payload.includes("SAGE-INVARIANT-PUBLIC")) fail(`${label} turn lost the rule marked invariant_audience: all`);
}
console.log("gateway trust-boundary assertions passed");
NODE

# --- 7. A non-owner session never writes the shared handoff (auto-compact) ---
kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid
rm -f "${RUNTIME_DATA}/transcripts/.handoff.md"
node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.agents.default.contextWindowTokens = 400;
config.contextManagement = { mode: "auto_compact", checkpointWarningPercent: 20, compactTargetPercent: 30, keepRecentTokens: 120, emergencyAutoHandoff: true };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
RESTART_MARK="${TEMP_RUNTIME}/restart.mark"
touch "${RESTART_MARK}"
sleep 1
./scripts/start-gateway.sh >/tmp/mindstone-agent-channel-trust-gateway2.log 2>&1 &
gateway_pid=$!
# The loopback connector starts reading at the inbox's end when it starts, so
# wait until it has actually (re)started before writing to the inbox.
for _ in $(seq 1 40); do
  [[ "${SPOOL_DIR}/status.json" -nt "${RESTART_MARK}" ]] && grep -q '"startedAt"' "${SPOOL_DIR}/status.json" && break
  sleep 0.25
done
before="$(grep -c . "${OUTBOX}")"
printf '%s\n' '{"messageId":"h1","text":"PEWTER-GROUP-TAIL long group message to push the window over its limit PEWTER-GROUP-TAIL","senderId":"alice","chatId":"ops9","chatType":"group","mentioned":true}' >> "${INBOX}"
wait_for_lines "${OUTBOX}" "$((before + 1))"
sleep 1
if [[ -f "${RUNTIME_DATA}/transcripts/.handoff.md" ]] && grep -q PEWTER-GROUP-TAIL "${RUNTIME_DATA}/transcripts/.handoff.md"; then
  echo "a non-owner turn wrote the shared handoff" >&2
  exit 1
fi
grep -q '"emergency_auto_handoff_disabled"' "${RUNTIME_DATA}"/transcripts/*.jsonl || {
  echo "control: the group turn never reached auto_compact_required, so this check proves nothing" >&2
  exit 1
}
# Control: the owner's own turn does write it.
printf '%s\n' '{"messageId":"h2","text":"SLATE-OWNER-TAIL owner message to push the window over its limit SLATE-OWNER-TAIL","senderId":"clint","chatId":"dm-clint","chatType":"direct"}' >> "${INBOX}"
wait_for_lines "${OUTBOX}" "$((before + 2))"
sleep 1
grep -q SLATE-OWNER-TAIL "${RUNTIME_DATA}/transcripts/.handoff.md" || { echo "control: the owner's handoff was not written" >&2; exit 1; }
echo "handoff suppression assertions passed"

echo "Channel-turn trust boundary smoke test passed."
