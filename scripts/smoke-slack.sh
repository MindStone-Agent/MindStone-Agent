#!/usr/bin/env bash
set -euo pipefail

# Slack connector MVP smoke (issue #18):
#   1. event -> inbound mapping units (im DMs, app_mention channels with
#      mention-tag stripping, subtype/bot/self skip) + setup wizard
#   2. end-to-end against a LOCAL stub Slack (Web API + real Socket Mode
#      WebSocket): DM reply, envelope acks, fail-closed allowlist, channel
#      reply THREADED on the triggering message, delivery retry via the queue
#   3. bad bot token fails VISIBLY at startup while the gateway stays healthy
#   Binds gateway port base+14 + stub port base+15 — serialize per smoke protocol.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-slack-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 14))"
STUB_PORT="$((SMOKE_PORT_BASE + 15))"
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
export STUB_SLACK_PORT="${STUB_PORT}"
export SLACK_SMOKE_BOT_TOKEN="xoxb-stub"
export SLACK_SMOKE_APP_TOKEN="xapp-stub"

cd "${PROJECT_ROOT}"

echo "== Slack connector smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-slack-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"

# --- 1. Event -> inbound mapping + setup wizard units ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { SLACK_CONNECTOR, slackEventToInbound } from "./packages/mindstone-gateway/src/index.ts";

const BOT = "U0BOT";

const dm = slackEventToInbound({ type: "message", channel_type: "im", user: "U777", text: "hello", ts: "111.222", channel: "D01" }, BOT)!;
assert.equal(dm.chatType, "direct");
assert.equal(dm.senderId, "U777");
assert.equal(dm.messageId, "111.222");
assert.equal(dm.mentioned, false);

const mention = slackEventToInbound({ type: "app_mention", user: "U777", text: "<@U0BOT> run the report", ts: "111.333", channel: "C09" }, BOT)!;
assert.equal(mention.chatType, "channel");
assert.equal(mention.mentioned, true);
assert.equal(mention.text, "run the report", "mention tag must strip");

const threaded = slackEventToInbound({ type: "app_mention", user: "U777", text: "<@U0BOT> more", ts: "111.444", channel: "C09", thread_ts: "111.000" }, BOT)!;
assert.equal(threaded.threadId, "111.000");

assert.equal(slackEventToInbound({ type: "message", channel_type: "channel", user: "U777", text: "ambient", ts: "1", channel: "C09" }, BOT), undefined, "non-mention channel messages are never processed");
assert.equal(slackEventToInbound({ type: "message", channel_type: "im", subtype: "message_changed", user: "U777", text: "edit", ts: "1", channel: "D01" }, BOT), undefined, "subtypes skipped");
assert.equal(slackEventToInbound({ type: "message", channel_type: "im", bot_id: "B9", text: "bot", ts: "1", channel: "D01" }, BOT), undefined, "bot messages skipped");
assert.equal(slackEventToInbound({ type: "message", channel_type: "im", user: "U0BOT", text: "self", ts: "1", channel: "D01" }, BOT), undefined, "self messages skipped");

const texts = ["MY_SLACK_BOT_ENV", "MY_SLACK_APP_ENV", "U111,U222"];
const prompter = { note: async () => undefined, confirm: async () => true, select: async () => "env", text: async () => texts.shift() } as never;
const setup = await SLACK_CONNECTOR.setup!.configure({ config: {}, prompter });
const section = (setup.config.channels as Record<string, Record<string, unknown>>).slack;
assert.equal(section.tokenEnv, "MY_SLACK_BOT_ENV");
assert.equal(section.appTokenEnv, "MY_SLACK_APP_ENV");
assert.deepEqual(section.allowedSenders, ["U111", "U222"]);
assert.ok(!JSON.stringify(setup.config).includes("xoxb"), "no raw secret in config");
console.log("slack mapping + setup wizard unit assertions passed");
TS

# --- 2. End-to-end against the stub Slack (Web API + Socket Mode WS) ---
node scripts/stub-slack-server.mjs >/tmp/mindstone-agent-slack-stub.log 2>&1 &
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
  slack: {
    enabled: true,
    tokenEnv: "SLACK_SMOKE_BOT_TOKEN",
    appTokenEnv: "SLACK_SMOKE_APP_TOKEN",
    apiBaseUrl: `http://127.0.0.1:${process.env.STUB_SLACK_PORT}/api`,
    queueDrainMs: 250,
    allowedSenders: ["U777"],
  },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-slack-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

push_event() {
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
  echo "stub never received ${expected} chat.postMessage call(s); got $(sent_count)" >&2
  curl -s "${STUB_URL}/_test/sent" >&2 || true
  return 1
}

# Allowed DM -> mock reply, envelope acked, DM reply NOT threaded.
push_event '{"event":{"type":"message","channel_type":"im","user":"U777","text":"hello agent","ts":"200.100","channel":"D0CLINT"}}'
wait_for_sent 1
SENT="$(curl -s "${STUB_URL}/_test/sent")"
grep -q 'Mock response' <<<"${SENT}"
grep -q '"channel":"D0CLINT"' <<<"${SENT}"
if grep -q '"thread_ts"' <<<"${SENT}"; then
  echo "DM replies must not be threaded" >&2
  exit 1
fi
ACKS="$(curl -s "${STUB_URL}/_test/acks")"
grep -q '"envelope_id":"env-1"' <<<"${ACKS}"

# Non-allowlisted sender -> denied (fail closed), no send; denial counted.
push_event '{"event":{"type":"message","channel_type":"im","user":"U666","text":"let me in","ts":"200.200","channel":"D0MALLORY"}}'
# Channel mention from an allowed sender -> reply THREADED on the triggering message.
push_event '{"event":{"type":"app_mention","user":"U777","text":"<@U0BOT> report please","ts":"200.300","channel":"C0OPS"}}'
wait_for_sent 2
test "$(sent_count)" -eq 2
SENT="$(curl -s "${STUB_URL}/_test/sent")"
grep -q '"channel":"C0OPS"' <<<"${SENT}"
grep -q '"thread_ts":"200.300"' <<<"${SENT}"
sleep 0.5
grep -q '"deniedCount": 1' "${RUNTIME_DATA}/connectors/slack/status.json"

# Delivery failure -> retried by the periodic queue drain.
curl -s -X POST "${STUB_URL}/_test/fail" -H "Content-Type: application/json" -d '{"count":1}' >/dev/null
push_event '{"event":{"type":"message","channel_type":"im","user":"U777","text":"retry me","ts":"200.400","channel":"D0CLINT"}}'
wait_for_sent 3
QUEUE_FILE="${RUNTIME_DATA}/connectors/slack/queue.json"
grep -q '"attempts": 2' "${QUEUE_FILE}"
grep -q '"status": "delivered"' "${QUEUE_FILE}"

# Transcript entries carry connector source metadata.
grep -rq 'connector:slack' "${RUNTIME_DATA}/transcripts/"

kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# --- 3. Bad bot token fails visibly at startup; gateway stays healthy ---
SLACK_SMOKE_BOT_TOKEN="xoxb-wrong" ./scripts/start-gateway.sh >/tmp/mindstone-agent-slack-gateway2.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/health")"
test "${HEALTH_CODE}" = "200"
sleep 0.5
grep -q '"state": "error"' "${RUNTIME_DATA}/connectors/slack/status.json"
grep -q 'auth.test failed' "${RUNTIME_DATA}/connectors/slack/status.json"
kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# Status stays secret-free.
STATUS_JSON="$(./scripts/mindstone status --json)"
grep -q '"connectorId": "slack"' <<<"${STATUS_JSON}"
if grep -q 'xoxb-stub\|xapp-stub' <<<"${STATUS_JSON}"; then
  echo "status output must never contain Slack tokens" >&2
  exit 1
fi

echo "Slack connector smoke test passed."
