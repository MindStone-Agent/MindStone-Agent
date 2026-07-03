# Calendar & task connectors — design + operations (#22)

Google Calendar MVP on the #16 framework + the detailed implementation plan
for the rest of the #22 target list. Companion docs: `EMAIL_CONNECTOR.md`
(the approval store and Google OAuth story this reuses), `CONNECTORS.md`
(framework), `LIVE_UAT_RUNBOOK.md` (live legs).

---

## 0. The interaction-model decision

A calendar is **not a chat**. Every prior connector is inbound-message →
routed reply; a calendar has no messages and no replies. The connector is
**pull + mutate**:

- **Pull:** `mindstone calendar upcoming [--days N] [--summarize] [--json]`
  reads the agenda (read-only). `--summarize` routes the agenda through the
  configured model for a commitments summary. Scheduled digests (a morning
  agenda pushed into the session) are explicitly **#29 scheduler territory** —
  this connector ships no timers.
- **Mutate:** the model proposes event mutations in a fenced block; a human
  approves; the connector applies. Nothing else. `startInbound` validates
  credentials then idles (a visible no-op listener); `sendOutbound` refuses
  anything that is not an approved mutation payload — so "mutations are
  always approval-gated" is structural, not policy.

## 1. Proposal discipline moved to the core turn (architecture change)

#21's proposal extraction lived in the Gateway's connector-reply pipeline.
Calendar proposals mostly originate in **chat turns** ("schedule lunch
Friday"), so #22 moved the discipline into a single shared step —
`applyActionProposalDiscipline` (core `channels/approval.ts`) — called by
BOTH assistant-reply finalization sites (`runMindStoneChatTurn` and the
Gateway's `runConfiguredRoute`). Every surface now gets the same behavior:

- fenced blocks (`mindstone-memory-proposal`, `mindstone-calendar-proposal`)
  become **pending ProposedActions** + `approval_proposed` audit events;
- the visible reply is stripped of the blocks;
- malformed blocks are dropped, never applied.

New ProposedAction kind: **`connector_mutation`**
(`{connectorId, operation: create|update, resource, data}`). On approve the
payload is enqueued onto the target connector's delivery queue as a typed
outbound message; the Gateway drain applies it via `sendOutbound`
(retry/dead-letter semantics apply to mutations too). On reject it archives
with the note. This is exactly the #24 Approval Center's "create
task/calendar event" action type, live early.

The proposal fence contract:

    ```mindstone-calendar-proposal
    { "operation": "create", "resource": "event",
      "data": { "summary": "...", "start": {"dateTime": "..."}, "end": {"dateTime": "..."} } }
    ```

    ```mindstone-calendar-proposal
    { "operation": "update", "data": { "eventId": "...", "summary": "..." } }
    ```

**Apply-time validation fails closed** (`validateCalendarMutation`): only
create/update on `resource: "event"`; create requires summary+start+end;
update requires `data.eventId`. The stored record keeps whatever the model
proposed; the constraint is enforced at apply.

## 2. Google Calendar provider

Same three-REF Google OAuth shape as Gmail (`tokenEnv` = refresh token,
`clientIdEnv`, `clientSecretEnv`; one Google Cloud project can serve both
connectors, with Calendar scope added at consent time). `apiBaseUrl` /
`tokenUrl` are config-swappable so the smoke drives the exact live path
against `scripts/stub-gcal-server.mjs`. Calls: events list
(timeMin/timeMax/singleEvents/orderBy), insert, patch — on
`channels.calendar.calendarId` (default `primary`).

## 3. Ticket capabilities → mechanism

| #22 capability | Mechanism |
|---|---|
| Summarize upcoming commitments | `calendar upcoming --summarize` (agenda → configured route) |
| Create/update tasks with approval | proposal fence → `connector_mutation` → approve → apply (§1) |
| Follow-up tracking | memory proposals from agenda/summary turns (existing `mindstone-memory-proposal` mechanism) + the triage-workflow contract below |
| Meeting prep / post-meeting summary | workflow contract: feed `calendar upcoming` output (prep) or meeting notes (post) through the route; durable outcomes ride proposal fences |
| Memory proposal from durable commitments | existing memory-proposal discipline, now on every surface (§1) |

Meeting prep/post-summary and follow-up tracking are **model work over the
pull surface**, not connector code — the connector stays pure transport.
Their quality is validated in Clint's live UAT, not smokes (no-live-LLM rule).

## 4. Remaining targets — the implementation plan (AC1's second fork)

Every follow-on target lands behind the same seams: a provider (auth +
read + mutate), proposal fences routed to `connector_mutation` with a new
`resource` vocabulary, apply-time validation, a stub + smoke. Per-target
notes, in rough order of value/effort:

1. **Microsoft 365 Calendar** — Graph `Calendars.ReadWrite`, single-tenant
   Entra app (the exact registration story in `TEAMS_CONNECTOR_DESIGN.md` §2;
   one Entra app can serve Teams + M365 Calendar + M365 Mail). Provider maps
   1:1 onto the `CalendarProvider` seam (`/me/calendarView`, `/me/events`).
   Effort: Slack-shaped.
2. **Todoist** — simplest of the set: static API token (one REF), REST v2
   (`/tasks` list/create/update). Introduces `resource: "task"` + validation.
   Effort: small.
3. **GitHub Issues** — `gh`-style PAT REF; list/create/update issues as
   tasks. Natural fit for the dev-agent audience. Linear/Jira follow the same
   shape (API key REFs; Jira needs site + project config).
4. **Notion** — integration token + database id config; tasks = database
   rows. Feasible; schema-mapping config is the main design cost.
5. **Apple Reminders** — **not feasible headless**: no public REST API;
   requires EventKit on a Mac with user-consent prompts (or CalDAV against
   iCloud with app-specific passwords — fragile). Documented as
   out-of-lane unless/until a Mac-native MindStone surface exists.

## 5. Validation + claim status

**Implemented + smoke-tested** (`npm run smoke:calendar`, 2026-07-02): unit
matrix (extraction incl. both-fences + malformed-drop, apply-time validation
fail-closed matrix, outbound roundtrip + plain-reply refusal, agenda
formatting, wizard refs) and the stub E2E: agenda pull (+`--json`,
`--summarize` via mock, timeMin/timeMax reaching the API), **chat-origin
proposal** → pending `connector_mutation` (visible reply stripped) → approve
→ Gateway drain applies exactly one insert → audit events; reject → archived,
nothing patched; injected failure → retried to delivery; bad refresh token →
visible error state while `/health` stays 200; secret-leak sweep.

**Not claimed:** live Google Calendar (runbook leg for Clint), any follow-on
target in §4 (plan only), scheduled digests (#29), recurring-event editing,
attendee invitations/notifications semantics, task resources (`resource:
"task"` validation intentionally rejects until a task provider ships).
