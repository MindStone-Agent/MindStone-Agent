#!/usr/bin/env bash
set -euo pipefail

# Connector delivery queue + reply gating smoke (issue #63):
#   1. an entry enqueued while a drain is sending is not lost, and goes out in
#      the same drain call
#   2. two concurrent drains deliver each entry once
#   3. a stale lock from a crashed writer is broken; an enqueue from another
#      process during a drain is kept
#   4. through the gateway: a failed run posts nothing to the chat (DM or
#      group) and stays recorded in the transcript; an empty reply posts nothing
# Binds gateway port base+24 — serialize per smoke protocol.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-connector-queue-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 24))"

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
echo "== Connector queue smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-connector-queue-init.log

# --- 1-3. Queue units (no ports) ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" PROJECT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConnectorDeliveryQueue } from "./packages/mindstone-core/src/index.ts";

// 1. Enqueue during a drain: kept, and delivered by the same drain call.
{
  const queue = new ConnectorDeliveryQueue("unit-concurrent");
  queue.enqueue({ text: "first" });
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const draining = queue.drain(async (entry) => {
    if (entry.message.text === "first") await gate;
    sent.push(entry.message.text);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  new ConnectorDeliveryQueue("unit-concurrent").enqueue({ text: "second" });
  // A drain asked for mid-drain (the per-message drain) joins the running one.
  const joined = queue.drain(async (entry) => {
    sent.push(`joined:${entry.message.text}`);
  });
  release();
  await Promise.all([draining, joined]);
  assert.deepEqual(sent, ["first", "second"], `each entry sent once, by the running drain: ${JSON.stringify(sent)}`);
  const status = queue.status();
  assert.equal(status.delivered, 2, "the entry enqueued mid-drain must be kept and delivered");
  assert.equal(status.pending, 0);
}

// 2. Two concurrent drains deliver once.
{
  const queue = new ConnectorDeliveryQueue("unit-double");
  queue.enqueue({ text: "only-once" });
  let sends = 0;
  const deliver = async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  await Promise.all([queue.drain(deliver), new ConnectorDeliveryQueue("unit-double").drain(deliver)]);
  assert.equal(sends, 1, `delivered ${sends} times`);
}

// 3a. A stale lock from a crashed writer is broken.
{
  const queue = new ConnectorDeliveryQueue("unit-stale");
  const lock = `${queue.path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  queue.enqueue({ text: "after-crash" });
  assert.equal(queue.pending().length, 1);
}

// 3b. Another process enqueues while this one is mid-drain: kept.
{
  const queue = new ConnectorDeliveryQueue("unit-crossproc");
  queue.enqueue({ text: "local" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const draining = queue.drain(async () => {
    await gate;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  execFileSync(
    "npx",
    ["tsx", "-e", `import { ConnectorDeliveryQueue } from "${process.env.PROJECT_ROOT}/packages/mindstone-core/src/index.ts"; new ConnectorDeliveryQueue("unit-crossproc").enqueue({ text: "from-cli" });`],
    { stdio: "inherit", env: process.env },
  );
  release();
  await draining;
  assert.deepEqual(queue.pending().map((entry) => entry.message.text), ["from-cli"], `the other process's entry was lost: ${JSON.stringify(queue.status())}`);
  assert.equal(queue.status().delivered, 1);
}
console.log("queue unit assertions passed");
TS

# --- 4. Gateway: failed and empty runs post nothing ---
node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = {
  mode: "mock",
  defaultAgentId: "default",
  defaultModel: "mindstone/mock",
  mock: { responsePrefix: "Mock response", failWhenTextIncludes: "PLEASE-FAIL", emptyWhenTextIncludes: "PLEASE-SILENCE" },
};
config.gateway = { ...(config.gateway ?? {}), auth: { mode: "none" } };
config.session = { mode: "per_surface" };
config.channels = { loopback: { enabled: true, allowedSenders: ["clint"], pollMs: 100 } };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

./scripts/start-gateway.sh >/tmp/mindstone-agent-connector-queue-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

SPOOL_DIR="${TEMP_RUNTIME}/mindstone/connectors/loopback"
INBOX="${SPOOL_DIR}/inbox.jsonl"
OUTBOX="${SPOOL_DIR}/outbox.jsonl"
mkdir -p "${SPOOL_DIR}"

printf '%s\n' '{"messageId":"f1","text":"PLEASE-FAIL in a DM","senderId":"clint","chatId":"dm-clint","chatType":"direct"}' >> "${INBOX}"
printf '%s\n' '{"messageId":"f2","text":"PLEASE-FAIL in a group","senderId":"clint","chatId":"ops","chatType":"group","mentioned":true}' >> "${INBOX}"
printf '%s\n' '{"messageId":"s1","text":"PLEASE-SILENCE","senderId":"clint","chatId":"dm-clint","chatType":"direct"}' >> "${INBOX}"
# A normal DM last: once its reply lands, the earlier three have been handled.
printf '%s\n' '{"messageId":"ok1","text":"hello","senderId":"clint","chatId":"dm-clint","chatType":"direct"}' >> "${INBOX}"

for _ in $(seq 1 60); do
  grep -q '"inReplyToMessageId":"ok1"' "${OUTBOX}" 2>/dev/null && break
  sleep 0.25
done
grep -q '"inReplyToMessageId":"ok1"' "${OUTBOX}" || { echo "control reply never arrived" >&2; tail -30 /tmp/mindstone-agent-connector-queue-gateway.log >&2; exit 1; }
sleep 1
lines="$(grep -c . "${OUTBOX}")"
if [[ "${lines}" -ne 1 ]]; then
  echo "expected only the control reply in the outbox, got ${lines} line(s):" >&2
  cat "${OUTBOX}" >&2
  exit 1
fi
if grep -q 'not available' "${OUTBOX}"; then
  echo "a run error was posted into a chat" >&2
  exit 1
fi
# Both failures stay visible to the owner: the transcripts record them.
failed_runs="$(cat "${TEMP_RUNTIME}"/mindstone/transcripts/*.jsonl | grep -c '"routing_failed"' || true)"
if [[ "${failed_runs}" -lt 2 ]]; then
  echo "expected 2 routing_failed transcript events, got ${failed_runs}" >&2
  exit 1
fi

echo "Connector queue smoke test passed."
