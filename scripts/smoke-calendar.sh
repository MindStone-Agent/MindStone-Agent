#!/usr/bin/env bash
set -euo pipefail

# Calendar connector MVP smoke (issue #22):
#   1. unit assertions: proposal extraction (calendar fence, both-fences,
#      malformed), mutation validation (create/update fail-closed), outbound
#      payload roundtrip, agenda formatting, reply-refusal, setup wizard refs
#   2. end-to-end against a LOCAL stub Google Calendar API + OAuth endpoint
#      (the exact live code path with apiBaseUrl/tokenUrl swapped):
#      `calendar upcoming` pulls the seeded agenda (+ --summarize via mock);
#      a CHAT-ORIGIN proposal (fenced block in a chat turn) becomes a PENDING
#      connector_mutation and the visible reply is stripped; approve ->
#      queue -> stub receives the insert; reject -> archived, no patch;
#      mutation failure -> retried by the queue drain
#   3. bad refresh token fails VISIBLY at startup while the gateway stays up
#   4. status visibility; secrets never leak
#   Binds gateway port base+20 + stub port base+21 — serialize per smoke protocol.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-calendar-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 20))"
STUB_PORT="$((SMOKE_PORT_BASE + 21))"
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
export STUB_GCAL_PORT="${STUB_PORT}"
export CAL_SMOKE_REFRESH_TOKEN="stub-gcal-refresh-token"
export CAL_SMOKE_CLIENT_ID="stub-gcal-client-id"
export CAL_SMOKE_CLIENT_SECRET="stub-gcal-client-secret"

cd "${PROJECT_ROOT}"

echo "== Calendar connector smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-calendar-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"

# --- 1. Unit assertions ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" MINDSTONE_AGENT_DATA_DIR="${RUNTIME_DATA}" npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  CALENDAR_CONNECTOR,
  formatUpcomingEvents,
  mutationFromOutbound,
  validateCalendarMutation,
} from "./packages/mindstone-gateway/src/index.ts";
import { extractActionProposals } from "@mindstone-agent/core";

// Calendar fence -> connector_mutation payload; reply stripped.
const reply = 'Booked it.\n```mindstone-calendar-proposal\n{ "operation": "create", "resource": "event", "data": { "summary": "Sync with Bob", "start": { "dateTime": "2026-07-03T15:00:00Z" }, "end": { "dateTime": "2026-07-03T15:30:00Z" } } }\n```\nAnything else?';
const extracted = extractActionProposals(reply);
assert.equal(extracted.mutations.length, 1);
assert.equal(extracted.mutations[0].connectorId, "calendar");
assert.equal(extracted.mutations[0].operation, "create");
assert.ok(!extracted.text.includes("mindstone-calendar-proposal"));
assert.ok(extracted.text.includes("Booked it.") && extracted.text.includes("Anything else?"));

// Both fences in one reply -> memory + mutation, both stripped.
const both = extractActionProposals(
  'A.\n```mindstone-memory-proposal\n{ "path": "cal/pref.md", "content": "Prefers mornings" }\n```\nB.\n```mindstone-calendar-proposal\n{ "operation": "update", "data": { "eventId": "ev9", "summary": "Moved" } }\n```\nC.',
);
assert.ok(both.memory && both.mutations.length === 1);
assert.equal(both.mutations[0].operation, "update");
assert.equal(both.text, "A.\n\nB.\n\nC.");

// Malformed calendar blocks are dropped, never proposed.
assert.equal(extractActionProposals('```mindstone-calendar-proposal\nnot json\n```').mutations.length, 0);
assert.equal(extractActionProposals('```mindstone-calendar-proposal\n{ "operation": "delete", "data": {} }\n```').mutations.length, 0, "unsupported operation dropped");

// Mutation validation fails closed.
const good = validateCalendarMutation({ connectorId: "calendar", operation: "create", resource: "event", data: { summary: "X", start: { date: "2026-07-04" }, end: { date: "2026-07-04" } } });
assert.equal(good.operation, "create");
assert.throws(() => validateCalendarMutation({ connectorId: "calendar", operation: "create", resource: "event", data: { summary: "no times" } }), /requires/);
const upd = validateCalendarMutation({ connectorId: "calendar", operation: "update", resource: "event", data: { eventId: "ev1", summary: "Y" } });
assert.ok(upd.operation === "update" && upd.eventId === "ev1" && !("eventId" in upd.body));
assert.throws(() => validateCalendarMutation({ connectorId: "calendar", operation: "update", resource: "event", data: { summary: "no id" } }), /eventId/);
assert.throws(() => validateCalendarMutation({ connectorId: "calendar", operation: "create", resource: "task", data: {} }), /not supported/);

// Outbound payload roundtrip; non-mutation outbound is refused (reply-refusal
// keeps "mutations are always approval-gated" structural).
const outbound = { text: "x", metadata: { kind: "connector_mutation", mutation: { connectorId: "calendar", operation: "create", resource: "event", data: { summary: "S", start: {}, end: {} } } } };
assert.ok(mutationFromOutbound(outbound));
assert.equal(mutationFromOutbound({ text: "plain reply" }), undefined);
await assert.rejects(
  () => CALENDAR_CONNECTOR.sendOutbound({ config: undefined, channelConfig: {} }, { text: "plain reply" }),
  /only applies approved connector_mutation/,
);

// Agenda formatting.
const agenda = formatUpcomingEvents(
  [
    { summary: "Standup", start: { dateTime: "2026-07-03T09:00:00Z" }, location: "Zoom", attendees: [{ email: "a@b.c" }] },
    { summary: "Dentist", start: { date: "2026-07-04" } },
  ],
  { days: 7 },
);
assert.ok(agenda.includes("Standup") && agenda.includes("@ Zoom") && agenda.includes("(1 attendee(s))"));
assert.ok(agenda.includes("2026-07-04 — Dentist"));
assert.ok(formatUpcomingEvents([], { days: 3 }).includes("No upcoming events"));

// REGRESSION (Slate #22 QA blocker): fences must not survive in assistant
// `content` (string OR structured) or transcript JSONL — providers may return
// content alongside text, and context/auto-compact/webchat paths read it.
{
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const isolated = mkdtempSync(join(tmpdir(), "content-strip-regression."));
  const prevDataDir = process.env.MINDSTONE_AGENT_DATA_DIR;
  process.env.MINDSTONE_AGENT_DATA_DIR = isolated;
  try {
    const { runMindStoneChatTurn, ApprovalStore: IsolatedStore } = await import("@mindstone-agent/core");
    const FENCE = '```mindstone-calendar-proposal\n{ "operation": "create", "resource": "event", "data": { "summary": "Sneaky", "start": { "date": "2026-07-05" }, "end": { "date": "2026-07-05" } } }\n```';
    const model = { id: "fake/model", provider: "fake", name: "Fake", contextWindowTokens: 8192 };
    const makeProvider = (reply: { text: string; content?: unknown }) => ({
      id: "fake",
      listModels: () => [model],
      completeChat: async () => ({ role: "assistant", text: reply.text, content: reply.content, model: "fake/model" }),
    });

    // Slate's repro shape: content is a string equal to the fence-bearing text.
    const stringCase = await runMindStoneChatTurn({
      agentId: "default",
      sessionKey: "agent:default:main",
      message: "schedule it",
      provider: makeProvider({ text: `Visible.\n${FENCE}`, content: `Visible.\n${FENCE}` }) as never,
      model: model as never,
    });
    assert.equal(stringCase.assistantEntry.text, "Visible.");
    assert.equal(stringCase.assistantEntry.content, "Visible.");

    // Structured content: fences stripped from every nested string.
    const structuredCase = await runMindStoneChatTurn({
      agentId: "default",
      sessionKey: "agent:default:main",
      message: "again",
      provider: makeProvider({
        text: `Also visible.\n${FENCE}`,
        content: [{ type: "text", text: `Also visible.\n${FENCE}` }, { type: "meta", nested: { deep: FENCE } }],
      }) as never,
      model: model as never,
    });
    const structured = JSON.stringify(structuredCase.assistantEntry.content);
    assert.ok(!structured.includes("mindstone-calendar-proposal"), "structured content must be deep-stripped");
    assert.ok(structured.includes("Also visible."), "non-fence content survives");

    // Divergent case: text clean, fence ONLY in content -> stripped, NOT proposed.
    const divergentBefore = new IsolatedStore().list().length;
    const divergent = await runMindStoneChatTurn({
      agentId: "default",
      sessionKey: "agent:default:main",
      message: "divergent",
      provider: makeProvider({ text: "Clean text.", content: `Clean text.\n${FENCE}` }) as never,
      model: model as never,
    });
    assert.equal(JSON.stringify(divergent.assistantEntry.content).includes("mindstone-calendar-proposal"), false);
    assert.equal(new IsolatedStore().list().length, divergentBefore, "content-only fences are dropped, never proposed (text is the single proposal source)");

    // Proposing still works from text (both earlier turns) and is pending-only.
    const store = new IsolatedStore();
    assert.equal(store.pending().filter((a) => a.kind === "connector_mutation").length, 2);

    // Transcript JSONL: neither fence name anywhere.
    const transcriptDir = join(isolated, "transcripts");
    for (const file of readdirSync(transcriptDir)) {
      const body = readFileSync(join(transcriptDir, file), "utf-8");
      assert.ok(!body.includes("mindstone-calendar-proposal"), `fence leaked into transcript ${file}`);
      assert.ok(!body.includes("mindstone-memory-proposal"), `memory fence leaked into transcript ${file}`);
    }

    // Strip helper is identity on fence-free strings (no trim side-effects).
    const { stripProposalFences } = await import("@mindstone-agent/core");
    assert.equal(stripProposalFences("  keep my whitespace  "), "  keep my whitespace  ");
  } finally {
    if (prevDataDir === undefined) delete process.env.MINDSTONE_AGENT_DATA_DIR;
    else process.env.MINDSTONE_AGENT_DATA_DIR = prevDataDir;
  }
}

// Setup wizard: three REFS; no raw secret enters config.
const texts = ["MY_GCAL_REFRESH", "MY_GCAL_CLIENT_ID", "MY_GCAL_CLIENT_SECRET", "primary"];
const prompter = { note: async () => undefined, confirm: async () => true, select: async () => "env", text: async () => texts.shift() } as never;
const setupResult = await CALENDAR_CONNECTOR.setup!.configure({ config: {}, prompter });
const section = (setupResult.config.channels as Record<string, Record<string, unknown>>).calendar;
assert.equal(section.tokenEnv, "MY_GCAL_REFRESH");
assert.equal(section.clientIdEnv, "MY_GCAL_CLIENT_ID");
assert.equal(section.clientSecretEnv, "MY_GCAL_CLIENT_SECRET");
assert.ok(!JSON.stringify(setupResult.config).includes("stub-gcal-refresh-token"), "no raw secret in config");
const disabled = CALENDAR_CONNECTOR.setup!.disable!(setupResult.config);
assert.equal((disabled.channels as Record<string, Record<string, unknown>>).calendar.enabled, false);
console.log("calendar extraction + validation + formatting + setup unit assertions passed");
TS

# --- 2. End-to-end against the stub Calendar API ---
node scripts/stub-gcal-server.mjs >/tmp/mindstone-agent-calendar-stub.log 2>&1 &
stub_pid=$!
for _ in $(seq 1 20); do
  curl -s "${STUB_URL}/_test/state" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -s "${STUB_URL}/_test/state" >/dev/null 2>&1 || { echo "stub-gcal never came up" >&2; exit 1; }

node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configPath = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "default", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.gateway = { ...(config.gateway ?? {}), auth: { mode: "none" } };
config.session = { mode: "single", defaultSessionKey: "agent:default:main" };
config.channels = {
  calendar: {
    enabled: true,
    tokenEnv: "CAL_SMOKE_REFRESH_TOKEN",
    clientIdEnv: "CAL_SMOKE_CLIENT_ID",
    clientSecretEnv: "CAL_SMOKE_CLIENT_SECRET",
    apiBaseUrl: `http://127.0.0.1:${process.env.STUB_GCAL_PORT}`,
    tokenUrl: `http://127.0.0.1:${process.env.STUB_GCAL_PORT}/token`,
    queueDrainMs: 250,
  },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

# Seed two upcoming events.
curl -s -X POST "${STUB_URL}/_test/seed" -H "Content-Type: application/json" -d '{"summary":"Standup","start":{"dateTime":"2026-07-03T09:00:00Z"},"end":{"dateTime":"2026-07-03T09:15:00Z"},"location":"Zoom"}' >/dev/null
curl -s -X POST "${STUB_URL}/_test/seed" -H "Content-Type: application/json" -d '{"summary":"Board review","start":{"dateTime":"2026-07-04T17:00:00Z"},"end":{"dateTime":"2026-07-04T18:00:00Z"}}' >/dev/null

MS="./scripts/mindstone"

# Pull surface: agenda + json + summarize (mock-routed).
UPCOMING="$(${MS} calendar upcoming --days 7)"
grep -q 'Standup' <<<"${UPCOMING}"
grep -q 'Board review' <<<"${UPCOMING}"
${MS} calendar upcoming --json | grep -q '"summary": "Standup"'
SUMMARIZED="$(${MS} calendar upcoming --days 7 --summarize)"
grep -q 'Summary' <<<"${SUMMARIZED}"
grep -q 'Mock response' <<<"${SUMMARIZED}"
# The scoped time window reached the API (timeMin/timeMax present).
curl -s "${STUB_URL}/_test/state" | grep -q 'timeMin'

# CHAT-ORIGIN proposal: a fenced calendar block in a chat turn becomes a
# PENDING connector_mutation; the visible reply is stripped. This is the
# architecture leg — proposal discipline lives in the CORE turn, so the chat
# surface (not just connector pipelines) proposes.
CHAT_OUT="$(${MS} chat --once 'Please schedule this. ```mindstone-calendar-proposal
{ "operation": "create", "resource": "event", "data": { "summary": "Sync with Bob", "start": { "dateTime": "2026-07-03T15:00:00Z" }, "end": { "dateTime": "2026-07-03T15:30:00Z" } } }
```' )"
if grep -q 'mindstone-calendar-proposal' <<<"${CHAT_OUT}"; then
  echo "proposal block must be stripped from the visible chat reply" >&2
  exit 1
fi
APPROVALS_JSON="$(${MS} approvals list --json)"
grep -q '"kind": "connector_mutation"' <<<"${APPROVALS_JSON}"
MUT_ID="$(node -e 'const a=JSON.parse(process.argv[1]);console.log(a.find(x=>x.kind==="connector_mutation").id)' "${APPROVALS_JSON}")"
${MS} approvals show "${MUT_ID}" > /tmp/mindstone-agent-calendar-show.log
grep -q 'Sync with Bob' /tmp/mindstone-agent-calendar-show.log
grep -rq 'approval_proposed' "${RUNTIME_DATA}/transcripts/"
# Nothing applied yet.
curl -s "${STUB_URL}/_test/created" | grep -v -c '"summary":"Sync with Bob"' >/dev/null

# Start the gateway (drains the calendar queue), approve -> stub receives the insert.
./scripts/start-gateway.sh >/tmp/mindstone-agent-calendar-gateway.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 || { echo "gateway never came up" >&2; exit 1; }

created_count() {
  curl -s "${STUB_URL}/_test/created" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).created.length))'
}
wait_for_created() {
  local expected="$1"
  for _ in $(seq 1 60); do
    if [[ "$(created_count)" -ge "${expected}" ]]; then return 0; fi
    sleep 0.25
  done
  echo "stub never received ${expected} insert(s); got $(created_count)" >&2
  cat "${RUNTIME_DATA}/connectors/calendar/queue.json" >&2 || true
  return 1
}

test "$(created_count)" -eq 0
${MS} approvals approve "${MUT_ID}" --yes
wait_for_created 1
curl -s "${STUB_URL}/_test/created" | grep -q '"summary":"Sync with Bob"'
grep -q '"status": "delivered"' "${RUNTIME_DATA}/connectors/calendar/queue.json"
grep -rq 'approval_decided' "${RUNTIME_DATA}/transcripts/"

# Reject leg: an update proposal is rejected -> archived, nothing patched.
${MS} chat --once 'Move it. ```mindstone-calendar-proposal
{ "operation": "update", "data": { "eventId": "ev1", "summary": "Standup (moved)" } }
```' >/dev/null
REJ_ID="$(${MS} approvals list --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).find(x=>x.kind==="connector_mutation").id))')"
${MS} approvals reject "${REJ_ID}" --note "wrong slot"
curl -s "${STUB_URL}/_test/patched" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d).patched;if(p.length!==0){console.error("rejected mutation must not apply");process.exit(1)}})'
${MS} approvals list --all --json | grep -q '"decisionNote": "wrong slot"'

# Mutation failure -> retried by the periodic queue drain (applied once).
curl -s -X POST "${STUB_URL}/_test/fail" -H "Content-Type: application/json" -d '{"count":1}' >/dev/null
${MS} chat --once 'Add focus time. ```mindstone-calendar-proposal
{ "operation": "create", "resource": "event", "data": { "summary": "Focus block", "start": { "dateTime": "2026-07-05T09:00:00Z" }, "end": { "dateTime": "2026-07-05T11:00:00Z" } } }
```' >/dev/null
RETRY_ID="$(${MS} approvals list --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).find(x=>x.kind==="connector_mutation").id))')"
${MS} approvals approve "${RETRY_ID}" --yes
wait_for_created 2
grep -q '"attempts": 2' "${RUNTIME_DATA}/connectors/calendar/queue.json"

kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# --- 3. Bad refresh token fails visibly at startup; gateway stays healthy ---
CAL_SMOKE_REFRESH_TOKEN="wrong-refresh-token" ./scripts/start-gateway.sh >/tmp/mindstone-agent-calendar-gateway2.log 2>&1 &
gateway_pid=$!
for _ in $(seq 1 20); do
  curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/health")"
test "${HEALTH_CODE}" = "200"
for _ in $(seq 1 20); do
  grep -q '"state": "error"' "${RUNTIME_DATA}/connectors/calendar/status.json" 2>/dev/null && break
  sleep 0.25
done
grep -q '"state": "error"' "${RUNTIME_DATA}/connectors/calendar/status.json"
grep -q 'token exchange failed' "${RUNTIME_DATA}/connectors/calendar/status.json"
kill "${gateway_pid}" >/dev/null 2>&1 || true
wait "${gateway_pid}" >/dev/null 2>&1 || true
unset gateway_pid

# Blanket fence sweep (Slate #22 QA): after every E2E turn above, no fence in
# any NON-USER transcript entry (text or content). User entries are faithful
# append-only input history — a user-typed fence stays recorded verbatim, and
# any later model re-derivation of it re-enters the approval gate.
RUNTIME_DATA="${RUNTIME_DATA}" node <<'NODE'
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = `${process.env.RUNTIME_DATA}/transcripts`;
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".jsonl")) continue;
  const lines = readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.role === "user") continue;
    if (line.includes("mindstone-calendar-proposal") || line.includes("mindstone-memory-proposal")) {
      console.error(`proposal fence leaked into non-user transcript entry (role=${entry.role}) in ${file}`);
      process.exit(1);
    }
  }
}
NODE

# --- 4. Status visibility; secrets never leak ---
STATUS_JSON="$(${MS} status --json)"
grep -q '"connectorId": "calendar"' <<<"${STATUS_JSON}"
for secret in "stub-gcal-refresh-token" "stub-gcal-client-secret"; do
  for surface in "${STATUS_JSON}" "$(cat "${RUNTIME_DATA}/approvals/actions.json")" "$(cat "${RUNTIME_DATA}/connectors/calendar/queue.json")"; do
    if grep -q "${secret}" <<<"${surface}"; then
      echo "secret '${secret}' leaked into a status/approvals/queue surface" >&2
      exit 1
    fi
  done
  if grep -rq "${secret}" "${RUNTIME_DATA}/transcripts/"; then
    echo "secret '${secret}' leaked into transcripts" >&2
    exit 1
  fi
done

echo "Calendar connector smoke test passed."
