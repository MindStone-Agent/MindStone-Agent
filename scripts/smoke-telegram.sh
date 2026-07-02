#!/usr/bin/env bash
set -euo pipefail

# Telegram connector MVP smoke (issue #17):
#   1. update -> inbound mapping units (chat types, topics/threads, mention
#      entity + reply-to-bot detection, media captions, bot-message skip)
#   2. end-to-end against a LOCAL stub Bot API (same execution path as live):
#      allowed DM -> mock reply via sendMessage with reply correlation;
#      non-allowlisted sender denied (no unrestricted access by default);
#      group gated on mention; delivery failure retried by the queue drain
#   3. bad token fails VISIBLY at startup while the gateway stays healthy
#   Binds gateway port 19812 + stub port 19813 — serialize per smoke protocol.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-telegram-smoke.XXXXXX")"
GATEWAY_PORT="19812"
STUB_PORT="19813"
STUB_URL="http://127.0.0.1:${STUB_PORT}"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${stub_pid:-}" ]]; then
    kill "${stub_pid}" >/dev/null 2>&1 || true
    wait "${stub_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export STUB_TELEGRAM_PORT="${STUB_PORT}"
export TELEGRAM_SMOKE_TOKEN="stub-token"

cd "${PROJECT_ROOT}"

echo "== Telegram connector smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-telegram-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"

# --- 1. Update -> inbound mapping units ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { telegramUpdateToInbound } from "./packages/mindstone-gateway/src/index.ts";

const BOT = { id: 999001, username: "mindstone_stub_bot" };

const dm = telegramUpdateToInbound(
  { update_id: 1, message: { message_id: 10, from: { id: 777, username: "clint" }, chat: { id: 777, type: "private" }, text: "hello", date: 1751464800 } },
  BOT,
)!;
assert.equal(dm.chatType, "direct");
assert.equal(dm.senderId, "777");
assert.equal(dm.messageId, "10");
assert.ok(dm.timestamp?.startsWith("2025") || dm.timestamp?.startsWith("2026"));

const topic = telegramUpdateToInbound(
  { update_id: 2, message: { message_id: 11, from: { id: 777 }, chat: { id: -100123, type: "supergroup" }, text: "topic msg", is_topic_message: true, message_thread_id: 42 } },
  BOT,
)!;
assert.equal(topic.chatType, "thread");
assert.equal(topic.threadId, "42");

const mention = telegramUpdateToInbound(
  { update_id: 3, message: { message_id: 12, from: { id: 777 }, chat: { id: -100123, type: "supergroup" }, text: "@mindstone_stub_bot status", entities: [{ type: "mention", offset: 0, length: 19 }] } },
  BOT,
)!;
assert.equal(mention.mentioned, true);

const noMention = telegramUpdateToInbound(
  { update_id: 4, message: { message_id: 13, from: { id: 777 }, chat: { id: -100123, type: "group" }, text: "ambient chatter" } },
  BOT,
)!;
assert.equal(noMention.mentioned, false);
assert.equal(noMention.chatType, "group");

const replyToBot = telegramUpdateToInbound(
  { update_id: 5, message: { message_id: 14, from: { id: 777 }, chat: { id: -100123, type: "group" }, text: "re: that", reply_to_message: { from: { id: 999001 } } } },
  BOT,
)!;
assert.equal(replyToBot.mentioned, true, "replying to the bot counts as a mention");

const media = telegramUpdateToInbound(
  { update_id: 6, message: { message_id: 15, from: { id: 777 }, chat: { id: 777, type: "private" }, photo: [{}], caption: "look at this" } },
  BOT,
)!;
assert.equal(media.text, "look at this");
assert.equal(media.metadata?.media, "photo");
const bareMedia = telegramUpdateToInbound(
  { update_id: 7, message: { message_id: 16, from: { id: 777 }, chat: { id: 777, type: "private" }, voice: {} } },
  BOT,
)!;
assert.equal(bareMedia.text, "[voice]");

const fromBot = telegramUpdateToInbound(
  { update_id: 8, message: { message_id: 17, from: { id: 5, is_bot: true }, chat: { id: 777, type: "private" }, text: "bot echo" } },
  BOT,
);
assert.equal(fromBot, undefined, "bot-authored messages are skipped");

// Setup wizard: collects a token REF + allowlist; the raw token never enters config.
const { TELEGRAM_CONNECTOR } = await import("./packages/mindstone-gateway/src/index.ts");
const selects = ["env"];
const texts = ["MY_TG_TOKEN_ENV", "111, 222"];
const prompter = {
  note: async () => undefined,
  confirm: async () => true,
  select: async () => selects.shift(),
  text: async () => texts.shift(),
} as never;
const setupResult = await TELEGRAM_CONNECTOR.setup!.configure({ config: {}, prompter });
const section = (setupResult.config.channels as Record<string, Record<string, unknown>>).telegram;
assert.equal(section.enabled, true);
assert.equal(section.tokenEnv, "MY_TG_TOKEN_ENV");
assert.deepEqual(section.allowedSenders, ["111", "222"]);
assert.ok(!JSON.stringify(setupResult.config).includes("stub-token"), "no raw secret in config");
const disabled = TELEGRAM_CONNECTOR.setup!.disable!(setupResult.config);
assert.equal((disabled.channels as Record<string, Record<string, unknown>>).telegram.enabled, false);
console.log("telegram mapping + setup wizard unit assertions passed");
TS

# --- 2. End-to-end against the stub Bot API ---
node scripts/stub-telegram-server.mjs >/tmp/mindstone-agent-telegram-stub.log 2>&1 &
stub_pid=$!
for _ in $(seq 1 20); do
  curl -s "${STUB_URL}/_test/sent" >/dev/null 2>&1 && break
  sleep 0.25
done

node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "default", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.gateway = { ...(config.gateway ?? {}), auth: { mode: "none" } };
config.session = { mode: "per_surface" };
config.channels = {
  telegram: {
    enabled: true,
    tokenEnv: "TELEGRAM_SMOKE_TOKEN",
    apiBaseUrl: `http://127.0.0.1:${process.env.STUB_TELEGRAM_PORT}`,
    pollIntervalMs: 100,
    queueDrainMs: 250,
    allowedSenders: ["777"],
  },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-telegram-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

push_update() {
  curl -s -X POST "${STUB_URL}/_test/push" -H "Content-Type: application/json" -d "$1" >/dev/null
}

sent_count() {
  curl -s "${STUB_URL}/_test/sent" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).sent.length))'
}

wait_for_sent() {
  local expected="$1"
  for _ in $(seq 1 40); do
    if [[ "$(sent_count)" -ge "${expected}" ]]; then return 0; fi
    sleep 0.25
  done
  echo "stub never received ${expected} sendMessage call(s); got $(sent_count)" >&2
  curl -s "${STUB_URL}/_test/sent" >&2 || true
  return 1
}

# Allowed DM -> mock reply with chat + reply correlation.
push_update '{"message":{"message_id":100,"from":{"id":777,"username":"clint"},"chat":{"id":777,"type":"private"},"text":"hello agent"}}'
wait_for_sent 1
SENT="$(curl -s "${STUB_URL}/_test/sent")"
grep -q 'Mock response' <<<"${SENT}"
grep -q '"chat_id":777' <<<"${SENT}"
grep -q '"reply_to_message_id":100' <<<"${SENT}"

# Non-allowlisted sender -> denied, fail closed: no send, denial counted.
push_update '{"message":{"message_id":101,"from":{"id":666,"username":"mallory"},"chat":{"id":666,"type":"private"},"text":"let me in"}}'
# Group message without mention -> no reply.
push_update '{"message":{"message_id":102,"from":{"id":777},"chat":{"id":-100500,"type":"supergroup"},"text":"ambient chatter"}}'
# Group message WITH a mention -> reply.
push_update '{"message":{"message_id":103,"from":{"id":777},"chat":{"id":-100500,"type":"supergroup"},"text":"@mindstone_stub_bot report","entities":[{"type":"mention","offset":0,"length":19}]}}'
wait_for_sent 2
test "$(sent_count)" -eq 2
sleep 0.5
grep -q '"deniedCount": 1' "${RUNTIME_DATA}/connectors/telegram/status.json"

# Delivery failure -> retried by the periodic queue drain (queued, not lost).
curl -s -X POST "${STUB_URL}/_test/fail" -H "Content-Type: application/json" -d '{"count":1}' >/dev/null
push_update '{"message":{"message_id":104,"from":{"id":777},"chat":{"id":777,"type":"private"},"text":"retry me"}}'
wait_for_sent 3
QUEUE_FILE="${RUNTIME_DATA}/connectors/telegram/queue.json"
grep -q '"attempts": 2' "${QUEUE_FILE}"
grep -q '"status": "delivered"' "${QUEUE_FILE}"

# Transcript entries carry connector source metadata.
grep -rq 'connector:telegram' "${RUNTIME_DATA}/transcripts/"

kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# --- 3. Bad token fails visibly at startup; gateway stays healthy ---
TELEGRAM_SMOKE_TOKEN="wrong-token" ./scripts/start-gateway.sh >/tmp/mindstone-agent-telegram-gateway2.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/health")"
test "${HEALTH_CODE}" = "200"
sleep 0.5
grep -q '"state": "error"' "${RUNTIME_DATA}/connectors/telegram/status.json"
grep -q 'getMe failed' "${RUNTIME_DATA}/connectors/telegram/status.json"
kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# Doctor + status surface the telegram connector without leaking the token.
DOCTOR_OUT="$(./scripts/mindstone doctor 2>&1 || true)"
grep -q "connectors.catalog" <<<"${DOCTOR_OUT}"
STATUS_JSON="$(TELEGRAM_SMOKE_TOKEN="stub-token" ./scripts/mindstone status --json)"
grep -q '"connectorId": "telegram"' <<<"${STATUS_JSON}"
grep -q '"present": true' <<<"${STATUS_JSON}"
if grep -q 'stub-token' <<<"${STATUS_JSON}"; then
  echo "status output must never contain the bot token" >&2
  exit 1
fi

echo "Telegram connector smoke test passed."
