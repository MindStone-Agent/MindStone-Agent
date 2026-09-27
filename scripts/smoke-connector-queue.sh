#!/usr/bin/env bash
set -euo pipefail

# Connector delivery queue + reply gating smoke (issue #63):
#   1. an entry enqueued while a drain is sending is not lost, and goes out in
#      the same drain call
#   2. two concurrent drains deliver each entry once
#   3. a stale lock from a crashed writer is broken; an enqueue from another
#      process during a drain is kept; three processes enqueueing at once
#      lose nothing; CLI approve decides first (a draft rejected while the
#      confirm prompt is open is never queued) and undoes the approval when
#      the queue is locked
#   4. through the gateway: a failed run posts nothing to the chat (DM or
#      group) and stays recorded in the transcript; a whitespace-only reply
#      posts nothing
# Needs `expect` (for the confirm-prompt race in 3d); macOS ships it, on
# Linux install the expect package.
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
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"

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
// 3c. Three processes enqueueing at once: every entry is kept (the lock).
{
  const child = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/enqueue-child.ts`;
  writeFileSync(child, `import { ConnectorDeliveryQueue } from "${process.env.PROJECT_ROOT}/packages/mindstone-core/src/index.ts";
const q = new ConnectorDeliveryQueue("unit-stress");
for (let n = 0; n < 300; n += 1) q.enqueue({ text: process.argv[2] + "-" + n });
`);
  const { spawn } = await import("node:child_process");
  const run = (tag: string) =>
    new Promise<void>((resolve, reject) => {
      const proc = spawn("npx", ["tsx", child, tag], { stdio: "inherit", env: process.env });
      proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${tag} exited ${code}`))));
    });
  await Promise.all(["a", "b", "c"].map(run));
  const kept = new ConnectorDeliveryQueue("unit-stress").pending().length;
  assert.equal(kept, 900, `three processes enqueued 900 entries; ${kept} were kept`);
}
// 3e. An unreadable or corrupt queue file is never replaced by a write (#77 review).
{
  const { chmodSync, readdirSync, writeFileSync: write } = await import("node:fs");
  const queue = new ConnectorDeliveryQueue("unit-unreadable");
  for (let n = 0; n < 5; n += 1) queue.enqueue({ text: `keep-${n}` });
  chmodSync(queue.path, 0o000);
  assert.throws(() => queue.enqueue({ text: "late" }));
  chmodSync(queue.path, 0o600);
  assert.equal(queue.pending().length, 5, "an unreadable queue was overwritten");
  const corrupt = new ConnectorDeliveryQueue("unit-corrupt");
  corrupt.enqueue({ text: "one" });
  write(corrupt.path, '{"entries": [');
  assert.throws(() => corrupt.enqueue({ text: "two" }), /moved aside/);
  assert.ok(readdirSync(dirname(corrupt.path)).some((name) => name.startsWith("queue.json.corrupt-")), "the corrupt file was not kept");
  // Reads outside the lock report it and never move it (#77 review round 2).
  const listed = new ConnectorDeliveryQueue("unit-corrupt-read");
  listed.enqueue({ text: "one" });
  write(listed.path, '{"entries": [');
  assert.throws(() => listed.pending(), /unreadable/);
  assert.throws(() => listed.deadLetters(), /unreadable/);
  assert.match(listed.status().error ?? "", /unreadable/, "status must report an unreadable queue, not 0 entries");
  await assert.rejects(listed.drain(async () => {}), /unreadable/);
  assert.ok(!readdirSync(dirname(listed.path)).some((name) => name.startsWith("queue.json.corrupt-")), "a read-only path moved the queue aside");
}
// 3f. A failed delivery backs off instead of retrying at once; delivered entries are pruned.
{
  const queue = new ConnectorDeliveryQueue("unit-backoff");
  queue.enqueue({ text: "flaky" });
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("connector down");
  };
  await queue.drain(failing);
  await queue.drain(failing);
  assert.equal(calls, 1, `a failed entry was retried with no backoff (${calls} attempts)`);
  assert.equal(queue.pending().length, 1, "a failed entry must stay pending, not dead, after one failure");
  const big = new ConnectorDeliveryQueue("unit-prune");
  for (let n = 0; n < 510; n += 1) big.enqueue({ text: `d-${n}` });
  await big.drain(async () => {});
  assert.ok(big.status().delivered <= 500, `delivered entries are not pruned (${big.status().delivered})`);
  // An approval's entry is never pruned: it records that the approval was queued.
  const kept = new ConnectorDeliveryQueue("unit-prune-approval");
  assert.equal(kept.enqueueForApproval({ text: "approved" }, "approval-1").queued, true);
  await kept.drain(async () => {});
  for (let n = 0; n < 510; n += 1) kept.enqueue({ text: `d-${n}` });
  await kept.drain(async () => {});
  assert.equal(kept.enqueueForApproval({ text: "approved" }, "approval-1").queued, false, "a pruned approval entry let the approval be queued again");
}
// 3h. Backoff doubles from 2 s and the entry dead-letters on its 8th failure (about 4.2 minutes in all).
{
  const queue = new ConnectorDeliveryQueue("unit-deadletter");
  queue.enqueue({ text: "doomed" });
  let t = 1_000_000;
  const waits: number[] = [];
  for (let n = 0; n < 20 && queue.pending().length > 0; n += 1) {
    await queue.drain(async () => {
      throw new Error("down");
    }, { nowMs: t });
    const next = queue.pending()[0]?.nextAttemptAt;
    if (next === undefined) break;
    waits.push(next - t);
    t = next;
  }
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000], `unexpected backoff: ${waits}`);
  const [dead] = queue.deadLetters();
  assert.equal(dead?.attempts, 8, "an entry should dead-letter on its 8th failed attempt");
}
// 3i. A send that never settles times out and counts as a failure, so the drain moves on.
{
  const queue = new ConnectorDeliveryQueue("unit-hung");
  queue.enqueue({ text: "hangs" });
  queue.enqueue({ text: "fine" });
  const sent: string[] = [];
  await queue.drain(async (entry) => {
    if (entry.message.text === "hangs") await new Promise(() => {});
    sent.push(entry.message.text);
  }, { sendTimeoutMs: 100 });
  assert.deepEqual(sent, ["fine"], "a hung send stalled the drain");
  assert.match(queue.pending()[0]?.lastError ?? "", /timed out/);
}
// 3g. Queueing an approval from three processes at once queues it once.
{
  const child = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/approve-child.ts`;
  writeFileSync(child, `import { ConnectorDeliveryQueue } from "${process.env.PROJECT_ROOT}/packages/mindstone-core/src/index.ts";
new ConnectorDeliveryQueue("unit-approval-race").enqueueForApproval({ text: "once" }, "approval-race");
`);
  const { spawn } = await import("node:child_process");
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const proc = spawn("npx", ["tsx", child], { stdio: "inherit", env: process.env });
      proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    });
  await Promise.all([run(), run(), run()]);
  const entries = new ConnectorDeliveryQueue("unit-approval-race").pending().length;
  assert.equal(entries, 1, `three processes queued one approval ${entries} times`);
}
console.log("queue unit assertions passed");
TS

# --- 3d. CLI approve: decide first, undo if the queue is locked ---
MS="./scripts/mindstone"
propose() {
  PROJECT_ROOT="${PROJECT_ROOT}" TEXT="$1" npx tsx -e '
import { ApprovalStore } from "'"${PROJECT_ROOT}"'/packages/mindstone-core/src/index.ts";
const a = new ApprovalStore().propose({ kind: "connector_send", connectorId: "clitest", summary: "synthetic", send: { text: process.env.TEXT, chatId: "dm-clint" }, createdAt: new Date().toISOString() });
console.log(a.id);'
}
queued() {
  PROJECT_ROOT="${PROJECT_ROOT}" TEXT="$1" npx tsx -e '
import { ConnectorDeliveryQueue } from "'"${PROJECT_ROOT}"'/packages/mindstone-core/src/index.ts";
console.log(new ConnectorDeliveryQueue("clitest").pending().filter((e) => e.message.text === process.env.TEXT).length);'
}
status_of() { ${MS} approvals list --all --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).find(a=>a.id===process.argv[1]).status))' "$1"; }
# Its own connector id, so nothing here reaches the loopback gateway test below.
QUEUE_LOCK="${TEMP_RUNTIME}/mindstone/connectors/clitest/queue.json.lock"

# A locked queue: the approval is undone, the action is pending again, nothing is queued.
LOCKED_ID="$(propose SYNTHETIC-DRAFT-LOCKED)"
mkdir -p "$(dirname "${QUEUE_LOCK}")"
printf 'held-by-smoke' > "${QUEUE_LOCK}"
( for _ in $(seq 1 16); do touch "${QUEUE_LOCK}" 2>/dev/null; sleep 0.5; done ) &
toucher_pid=$!
if approve_out="$(${MS} approvals approve "${LOCKED_ID}" --yes 2>&1)"; then
  echo "approve should fail while the queue is locked: ${approve_out}" >&2; exit 1
fi
grep -q "pending again" <<<"${approve_out}" || { echo "the locked-queue error should say the action is pending again: ${approve_out}" >&2; exit 1; }
[[ "$(status_of "${LOCKED_ID}")" == "pending" ]] || { echo "a locked-queue approval was left approved but never queued" >&2; exit 1; }
kill "${toucher_pid}" 2>/dev/null || true; wait "${toucher_pid}" 2>/dev/null || true
rm -f "${QUEUE_LOCK}"
${MS} approvals approve "${LOCKED_ID}" --yes >/dev/null
[[ "$(queued SYNTHETIC-DRAFT-LOCKED)" == "1" ]] || { echo "the re-approved draft should be queued once" >&2; exit 1; }
[[ "$(status_of "${LOCKED_ID}")" == "approved" ]] || { echo "the re-approval should stand" >&2; exit 1; }

# An approve killed after the decision but before the send was queued leaves
# it approved and unqueued; approving again queues it, exactly once (#77 review).
KILLED_ID="$(propose SYNTHETIC-DRAFT-KILLED)"
printf 'held-by-smoke' > "${QUEUE_LOCK}"
( for _ in $(seq 1 12); do touch "${QUEUE_LOCK}" 2>/dev/null; sleep 0.5; done ) &
toucher_pid=$!
node "${PROJECT_ROOT}/packages/mindstone-cli/dist/index.js" approvals approve "${KILLED_ID}" --yes >/dev/null 2>&1 &
approve_pid=$!
sleep 1.5
kill -INT "${approve_pid}" 2>/dev/null || true
wait "${approve_pid}" 2>/dev/null || true
kill "${toucher_pid}" 2>/dev/null || true; wait "${toucher_pid}" 2>/dev/null || true
rm -f "${QUEUE_LOCK}"
[[ "$(queued SYNTHETIC-DRAFT-KILLED)" == "0" ]] || { echo "the killed approve should not have queued anything" >&2; exit 1; }
if [[ "$(status_of "${KILLED_ID}")" == "approved" ]]; then
  ${MS} approvals approve "${KILLED_ID}" --yes >/dev/null
  [[ "$(queued SYNTHETIC-DRAFT-KILLED)" == "1" ]] || { echo "re-approving an approved but unqueued action should queue it once" >&2; exit 1; }
  if ${MS} approvals approve "${KILLED_ID}" --yes >/dev/null 2>&1; then
    echo "a third approve of a queued action should be refused" >&2; exit 1
  fi
  [[ "$(queued SYNTHETIC-DRAFT-KILLED)" == "1" ]] || { echo "the action was queued twice" >&2; exit 1; }
else
  echo "the killed approve did not get past the decision (status $(status_of "${KILLED_ID}")); the repair path was not exercised" >&2; exit 1
fi

# The repair only runs for an approval marked mid-queue (#77 review round 2).
decide_raw() {
  PROJECT_ROOT="${PROJECT_ROOT}" ID="$1" STATE="$2" npx tsx -e '
import { ApprovalStore } from "'"${PROJECT_ROOT}"'/packages/mindstone-core/src/index.ts";
new ApprovalStore().decide(process.env.ID, { status: "approved", decidedBy: "smoke", now: new Date().toISOString(), ...(process.env.STATE ? { queueState: process.env.STATE } : {}) });'
}
queue_raw() {
  PROJECT_ROOT="${PROJECT_ROOT}" ID="$1" TEXT="$2" npx tsx -e '
import { ConnectorDeliveryQueue } from "'"${PROJECT_ROOT}"'/packages/mindstone-core/src/index.ts";
new ConnectorDeliveryQueue("clitest").enqueueForApproval({ text: process.env.TEXT, chatId: "dm-clint" }, process.env.ID);'
}
# An approval from before queueState (delivered long ago, entry pruned) is never re-queued.
OLD_ID="$(propose SYNTHETIC-DRAFT-OLD)"
decide_raw "${OLD_ID}" ""
if ${MS} approvals approve "${OLD_ID}" --yes >/dev/null 2>&1; then
  echo "re-approving an old approval (no queueState) should be refused" >&2; exit 1
fi
[[ "$(queued SYNTHETIC-DRAFT-OLD)" == "0" ]] || { echo "an old approval was queued again" >&2; exit 1; }
# Killed after the entry was written but before it was marked queued: nothing is added.
WRITTEN_ID="$(propose SYNTHETIC-DRAFT-WRITTEN)"
decide_raw "${WRITTEN_ID}" queuing
queue_raw "${WRITTEN_ID}" SYNTHETIC-DRAFT-WRITTEN
written_out="$(${MS} approvals approve "${WRITTEN_ID}" --yes 2>&1)"
grep -q "Already queued" <<<"${written_out}" || { echo "expected 'Already queued': ${written_out}" >&2; exit 1; }
[[ "$(queued SYNTHETIC-DRAFT-WRITTEN)" == "1" ]] || { echo "an already-queued approval was queued twice" >&2; exit 1; }
if ${MS} approvals approve "${WRITTEN_ID}" --yes >/dev/null 2>&1; then
  echo "once marked queued, the approval should be refused" >&2; exit 1
fi
# Two repairs at once, released together from a held lock: queued once.
TWICE_ID="$(propose SYNTHETIC-DRAFT-TWICE)"
decide_raw "${TWICE_ID}" queuing
printf 'held-by-smoke' > "${QUEUE_LOCK}"
${MS} approvals approve "${TWICE_ID}" --yes >"${TEMP_RUNTIME}/twice-a.log" 2>&1 &
twice_a=$!
${MS} approvals approve "${TWICE_ID}" --yes >"${TEMP_RUNTIME}/twice-b.log" 2>&1 &
twice_b=$!
sleep 1
rm -f "${QUEUE_LOCK}"
wait "${twice_a}" || true; wait "${twice_b}" || true
[[ "$(queued SYNTHETIC-DRAFT-TWICE)" == "1" ]] || { echo "two concurrent repairs queued the draft $(queued SYNTHETIC-DRAFT-TWICE) times" >&2; cat "${TEMP_RUNTIME}"/twice-*.log >&2; exit 1; }
# The repair asks first, like any approve.
ASK_ID="$(propose SYNTHETIC-DRAFT-ASK)"
decide_raw "${ASK_ID}" queuing
if ask_out="$(${MS} approvals approve "${ASK_ID}" </dev/null 2>&1)"; then
  echo "a repair with no --yes and no terminal should be refused: ${ask_out}" >&2; exit 1
fi
[[ "$(queued SYNTHETIC-DRAFT-ASK)" == "0" ]] || { echo "the repair queued without confirmation" >&2; exit 1; }

# Rejected while the confirm prompt is open: approving must not queue it.
command -v expect >/dev/null || { echo "smoke-connector-queue needs expect (install the expect package)" >&2; exit 1; }
RACE_ID="$(propose SYNTHETIC-DRAFT-RACE)"
cat > "${TEMP_RUNTIME}/approve-race.exp" <<EXP
set timeout 60
spawn ${MS} approvals approve ${RACE_ID}
expect "Approve this action now?"
exec -ignorestderr ${MS} approvals reject ${RACE_ID} --note owner-said-no
# The confirm is an arrow-key list that starts on "No": up to "Yes", then Enter.
send "\033\[A"
sleep 0.3
send "\r"
expect {
  eof {}
  timeout { puts "approve-race: the CLI never exited"; exit 99 }
}
catch wait result
exit [lindex \$result 3]
EXP
if race_out="$(expect "${TEMP_RUNTIME}/approve-race.exp" 2>&1)"; then
  echo "approving a draft rejected during the prompt should fail: ${race_out}" >&2; exit 1
fi
grep -q "already rejected" <<<"${race_out}" || { echo "expected an 'already rejected' refusal: ${race_out}" >&2; exit 1; }
[[ "$(queued SYNTHETIC-DRAFT-RACE)" == "0" ]] || { echo "a draft the owner rejected was queued for sending" >&2; exit 1; }
[[ "$(status_of "${RACE_ID}")" == "rejected" ]] || { echo "the rejection should stand" >&2; exit 1; }
echo "CLI approve assertions passed"

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

./scripts/start-gateway.sh >${TEMP_RUNTIME}/gateway.log 2>&1 &
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
grep -q '"inReplyToMessageId":"ok1"' "${OUTBOX}" || { echo "control reply never arrived" >&2; tail -30 ${TEMP_RUNTIME}/gateway.log >&2; exit 1; }
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
# A reply the queue refuses is retried and still sent, and the failure is logged (#77 review round 2).
chmod 000 "${SPOOL_DIR}/queue.json"
printf '%s\n' '{"messageId":"r1","text":"hello again","senderId":"clint","chatId":"dm-clint","chatType":"direct"}' >> "${INBOX}"
for _ in $(seq 1 40); do
  grep -q "could not queue a reply" "${TEMP_RUNTIME}/gateway.log" && break
  sleep 0.25
done
chmod 600 "${SPOOL_DIR}/queue.json"
grep -q "could not queue a reply" "${TEMP_RUNTIME}/gateway.log" || { echo "a refused enqueue was not logged" >&2; tail -20 "${TEMP_RUNTIME}/gateway.log" >&2; exit 1; }
for _ in $(seq 1 60); do
  grep -q '"inReplyToMessageId":"r1"' "${OUTBOX}" 2>/dev/null && break
  sleep 0.25
done
grep -q '"inReplyToMessageId":"r1"' "${OUTBOX}" || { echo "the refused reply was never sent after the queue recovered" >&2; tail -20 "${TEMP_RUNTIME}/gateway.log" >&2; exit 1; }
# Both failures stay visible to the owner: the transcripts record them.
failed_runs="$(cat "${TEMP_RUNTIME}"/mindstone/transcripts/*.jsonl | grep -c '"routing_failed"' || true)"
if [[ "${failed_runs}" -lt 2 ]]; then
  echo "expected 2 routing_failed transcript events, got ${failed_runs}" >&2
  exit 1
fi

# A corrupt queue is reported by the drain timer and status, and left where it is.
printf '{"entries": [' > "${SPOOL_DIR}/queue.json"
for _ in $(seq 1 40); do
  grep -q "delivery queue: .*unreadable" "${TEMP_RUNTIME}/gateway.log" && break
  sleep 0.25
done
grep -q "delivery queue: .*unreadable" "${TEMP_RUNTIME}/gateway.log" || { echo "an unreadable queue was not reported by the drain timer" >&2; tail -20 "${TEMP_RUNTIME}/gateway.log" >&2; exit 1; }
[[ -f "${SPOOL_DIR}/queue.json" ]] || { echo "a read-only path moved the corrupt queue aside" >&2; exit 1; }
${MS} status 2>&1 | grep -q "queue UNREADABLE" || { echo "mindstone status should show the queue as unreadable" >&2; ${MS} status >&2; exit 1; }

echo "Connector queue smoke test passed."
