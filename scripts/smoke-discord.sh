#!/usr/bin/env bash
set -euo pipefail

# Discord connector MVP smoke (issue #19):
#   1. message -> inbound mapping units (guild vs DM, mention detection + tag
#      strip, guild allowlist drop, bot/self skip, attachment marker) + wizard
#   2. least-privilege intents assertion (identify sends EXACTLY
#      GUILD_MESSAGES|DIRECT_MESSAGES|MESSAGE_CONTENT)
#   3. end-to-end against a LOCAL stub REST + gateway WS: DM reply, heartbeat
#      ack loop, fail-closed sender allowlist, guild-mention reply with
#      message_reference, non-allowlisted guild dropped, delivery retry
#   4. bad token fails VISIBLY at startup while the gateway stays healthy
#   Binds gateway port base+16 + stub port base+17 — serialize per smoke protocol.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-discord-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 16))"
STUB_PORT="$((SMOKE_PORT_BASE + 17))"
STUB_URL="http://127.0.0.1:${STUB_PORT}"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${stub_pid:-}" ]]; then kill "${stub_pid}" >/dev/null 2>&1 || true; wait "${stub_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export STUB_DISCORD_PORT="${STUB_PORT}"
export DISCORD_SMOKE_TOKEN="discord-stub-token"

cd "${PROJECT_ROOT}"

echo "== Discord connector smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-discord-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"

# --- 1 + 2. Mapping + intents + wizard units ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { DISCORD_CONNECTOR, DISCORD_LEAST_PRIVILEGE_INTENTS, discordMessageToInbound } from "./packages/mindstone-gateway/src/index.ts";

const BOT = "999002";

// Least-privilege intents: EXACTLY GUILD_MESSAGES|DIRECT_MESSAGES|MESSAGE_CONTENT, nothing else.
assert.equal(DISCORD_LEAST_PRIVILEGE_INTENTS, (1 << 9) | (1 << 12) | (1 << 15));
assert.equal(DISCORD_LEAST_PRIVILEGE_INTENTS & (1 << 1), 0, "GUILD_MEMBERS must NOT be requested");
assert.equal(DISCORD_LEAST_PRIVILEGE_INTENTS & (1 << 8), 0, "GUILD_PRESENCES must NOT be requested");

const dm = discordMessageToInbound({ id: "10", channel_id: "D1", author: { id: "U777", username: "clint" }, content: "hello", timestamp: "2026-07-02T00:00:00Z" }, BOT)!;
assert.equal(dm.chatType, "direct");
assert.equal(dm.mentioned, false);
assert.equal(dm.senderId, "U777");

const guildMention = discordMessageToInbound({ id: "11", channel_id: "C1", guild_id: "G1", author: { id: "U777" }, content: "<@999002> report", mentions: [{ id: "999002" }] }, BOT, ["G1"])!;
assert.equal(guildMention.chatType, "channel");
assert.equal(guildMention.mentioned, true);
assert.equal(guildMention.text, "report", "mention tag must strip");
assert.equal(guildMention.metadata?.guildId, "G1");

const guildNick = discordMessageToInbound({ id: "12", channel_id: "C1", guild_id: "G1", author: { id: "U777" }, content: "<@!999002> hi", mentions: [{ id: "999002" }] }, BOT, ["G1"])!;
assert.equal(guildNick.text, "hi", "nickname mention <@!id> must strip too");

assert.equal(discordMessageToInbound({ id: "13", channel_id: "C9", guild_id: "G-OTHER", author: { id: "U777" }, content: "hi", mentions: [] }, BOT, ["G1"]), undefined, "non-allowlisted guild dropped");
assert.equal(discordMessageToInbound({ id: "14", channel_id: "D1", author: { id: "B1", bot: true }, content: "bot" }, BOT), undefined, "bot messages skipped");
assert.equal(discordMessageToInbound({ id: "15", channel_id: "D1", author: { id: "999002" }, content: "self" }, BOT), undefined, "self messages skipped");

const attach = discordMessageToInbound({ id: "16", channel_id: "D1", author: { id: "U777" }, content: "", attachments: [{ filename: "diagram.png", content_type: "image/png" }] }, BOT)!;
assert.ok(attach.text.includes("image"), "attachment marker surfaces");
assert.equal(attach.metadata?.media, "image");

const reply = discordMessageToInbound({ id: "17", channel_id: "D1", author: { id: "U777" }, content: "re", message_reference: { message_id: "9" } }, BOT)!;
assert.equal(reply.threadId, "9", "reply chain maps to thread lineage");

const texts = ["MY_DISCORD_ENV", "G1,G2", "U777"];
const prompter = { note: async () => undefined, confirm: async () => true, select: async () => "env", text: async () => texts.shift() } as never;
const setup = await DISCORD_CONNECTOR.setup!.configure({ config: {}, prompter });
const section = (setup.config.channels as Record<string, Record<string, unknown>>).discord;
assert.equal(section.tokenEnv, "MY_DISCORD_ENV");
assert.deepEqual(section.allowedGuilds, ["G1", "G2"]);
assert.deepEqual(section.allowedSenders, ["U777"]);
assert.ok(!JSON.stringify(setup.config).includes("discord-stub-token"), "no raw secret in config");
console.log("discord mapping + intents + wizard unit assertions passed");
TS

# --- 3. End-to-end against the stub REST + gateway WS ---
echo "[phase3] starting stub Discord server"
node scripts/stub-discord-server.mjs >/tmp/mindstone-agent-discord-stub.log 2>&1 &
stub_pid=$!
stub_up=""
for _ in $(seq 1 40); do
  if curl -s "${STUB_URL}/_test/sent" >/dev/null 2>&1; then stub_up=1; break; fi
  sleep 0.25
done
test -n "${stub_up}" || { echo "stub Discord server never came up on ${STUB_PORT}" >&2; exit 1; }
echo "[phase3] stub up"

node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "default", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.gateway = { ...(config.gateway ?? {}), auth: { mode: "none" } };
config.session = { mode: "per_surface" };
config.channels = {
  discord: {
    enabled: true,
    tokenEnv: "DISCORD_SMOKE_TOKEN",
    apiBaseUrl: `http://127.0.0.1:${process.env.STUB_DISCORD_PORT}/api/v10`,
    queueDrainMs: 250,
    allowedGuilds: ["G1"],
    allowedSenders: ["U777"],
  },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

echo "[phase3] starting gateway"
./scripts/start-gateway.sh >/tmp/mindstone-agent-discord-gateway.log 2>&1 &
gateway_pid=$!
gw_up=""
for _ in $(seq 1 40); do
  if curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then gw_up=1; break; fi
  sleep 0.5
done
test -n "${gw_up}" || { echo "gateway never came up on ${GATEWAY_PORT}" >&2; cat /tmp/mindstone-agent-discord-gateway.log >&2; exit 1; }
echo "[phase3] gateway up"

push_msg() { curl -s -X POST "${STUB_URL}/_test/push" -H "Content-Type: application/json" -d "$1" >/dev/null; }
sent_count() { curl -s "${STUB_URL}/_test/sent" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).sent.length))'; }
wait_for_sent() {
  local expected="$1"
  for _ in $(seq 1 40); do
    if [[ "$(sent_count)" -ge "${expected}" ]]; then return 0; fi
    sleep 0.25
  done
  echo "stub never received ${expected} message post(s); got $(sent_count)" >&2
  curl -s "${STUB_URL}/_test/sent" >&2 || true
  return 1
}

# Runtime status is written async by the connector — POLL with a wide budget
# and print the actual state on timeout; never assert after a fixed sleep.
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

# Identify happens asynchronously after gateway startup (getMe -> gateway/bot ->
# WS connect -> hello -> identify), so poll for it rather than checking immediately.
EXPECTED_INTENTS=$(( (1<<9) | (1<<12) | (1<<15) ))
identify_landed() { curl -s "${STUB_URL}/_test/identifies" | grep -q "\"intents\":${EXPECTED_INTENTS}"; }
wait_for_identify() {
  for _ in $(seq 1 80); do
    if identify_landed; then return 0; fi
    sleep 0.25
  done
  echo "connector never sent an identify with the least-privilege intents" >&2
  echo "identifies: $(curl -s "${STUB_URL}/_test/identifies")" >&2
  echo "connector status: $(cat "${RUNTIME_DATA}/connectors/discord/status.json" 2>/dev/null)" >&2
  return 1
}
echo "[phase3] waiting for identify"
wait_for_identify
echo "[phase3] identify landed"

# Allowed DM -> mock reply with reply reference.
push_msg '{"message":{"id":"100","channel_id":"D0CLINT","author":{"id":"U777","username":"clint"},"content":"hello agent"}}'
wait_for_sent 1
SENT="$(curl -s "${STUB_URL}/_test/sent")"
grep -q 'Mock response' <<<"${SENT}"
grep -q '"channel_id":"D0CLINT"' <<<"${SENT}"
grep -q '"message_reference"' <<<"${SENT}"

# Non-allowlisted sender -> denied; non-allowlisted guild -> dropped before access.
push_msg '{"message":{"id":"101","channel_id":"D0MALLORY","author":{"id":"U666"},"content":"let me in"}}'
push_msg '{"message":{"id":"102","channel_id":"C-OTHER","guild_id":"G-OTHER","author":{"id":"U777"},"content":"<@999002> hi","mentions":[{"id":"999002"}]}}'
# Allowed guild + mention -> reply.
push_msg '{"message":{"id":"103","channel_id":"C0OPS","guild_id":"G1","author":{"id":"U777"},"content":"<@999002> report","mentions":[{"id":"999002"}]}}'
wait_for_sent 2
test "$(sent_count)" -eq 2
grep -q '"channel_id":"C0OPS"' <<<"$(curl -s "${STUB_URL}/_test/sent")"
# Denial count lands async on the inbound handler — POLL, don't sleep-and-hope
# (a fixed 0.5s budget flaked under regression-sweep CPU load, 2026-07-02).
wait_for_status "${RUNTIME_DATA}/connectors/discord/status.json" '"deniedCount": 1'

# Heartbeat loop is alive (hello interval is 400ms) — an async counter, so
# poll for it like everything else instead of assuming enough time has passed.
hb_count() { curl -s "${STUB_URL}/_test/heartbeats" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).heartbeats))'; }
hb_ok=""
for _ in $(seq 1 40); do
  if [[ "$(hb_count)" -ge 1 ]]; then hb_ok=1; break; fi
  sleep 0.25
done
test -n "${hb_ok}" || { echo "heartbeat never arrived; got $(hb_count)" >&2; exit 1; }

# Delivery failure -> retried by the periodic queue drain.
curl -s -X POST "${STUB_URL}/_test/fail" -H "Content-Type: application/json" -d '{"count":1}' >/dev/null
push_msg '{"message":{"id":"104","channel_id":"D0CLINT","author":{"id":"U777"},"content":"retry me"}}'
wait_for_sent 3
QUEUE_FILE="${RUNTIME_DATA}/connectors/discord/queue.json"
grep -q '"attempts": 2' "${QUEUE_FILE}"
grep -q '"status": "delivered"' "${QUEUE_FILE}"

grep -rq 'connector:discord' "${RUNTIME_DATA}/transcripts/"

kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# --- 4. Bad token fails visibly at startup; gateway stays healthy ---
DISCORD_SMOKE_TOKEN="wrong-token" ./scripts/start-gateway.sh >/tmp/mindstone-agent-discord-gateway2.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/health")"
test "${HEALTH_CODE}" = "200"
wait_for_status "${RUNTIME_DATA}/connectors/discord/status.json" '"state": "error"'
# Reason lands in the same atomic status write as the error state.
grep -q 'users/@me failed' "${RUNTIME_DATA}/connectors/discord/status.json"
kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

STATUS_JSON="$(./scripts/mindstone status --json)"
grep -q '"connectorId": "discord"' <<<"${STATUS_JSON}"
if grep -q 'discord-stub-token' <<<"${STATUS_JSON}"; then
  echo "status output must never contain the bot token" >&2
  exit 1
fi

echo "Discord connector smoke test passed."
