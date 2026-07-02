# Email connector — design + operations (#21)

Gmail-first email connector on the #16 framework, with the **strict approval
defaults** the ticket demands: read is scoped, drafting is free, **sending is
never automatic**. This doc is both the design record (decisions + rationale)
and the operations guide.

Companions: `CONNECTORS.md` (framework), `TEAMS_CONNECTOR_DESIGN.md` (the
Entra story the M365 second pass will reuse), `LIVE_UAT_RUNBOOK.md` (live
legs), `../refactor/SENSITIVE_CONTEXT_ROUTING.md` (design spike this connector
forward-references).

---

## 0. What makes email different from every prior connector

1. **Consequence asymmetry.** A wrong Telegram reply embarrasses the agent in
   a chat it was invited to. A wrong *email send* leaves the operator's
   identity, lands in external archives, and can't be unsent. So the reply
   pipeline that is fire-and-forget for chat connectors becomes
   **propose-and-approve** for email.
2. **Untrusted input by default.** Anyone can email you. Email bodies are the
   canonical prompt-injection vector: text the model reads that an adversary
   authored. The design treats *every model output derived from email* as
   untrusted — which is exactly why drafts and memory proposals go through a
   human approval gate rather than executing directly (§4, §8).
3. **It's a productivity surface, not a chat.** The ticket asks for thread
   summarization, commitment/follow-up detection, and memory proposals — model
   *work products*, not just transport. The connector stays pure transport
   (per #16); the work products come from the routed model turn and a
   documented triage-workflow contract (§6).

## 1. Decision: provider path → provider-agnostic interface, Gmail first

Per Clint (2026-07-02): **both providers eventually, one at a time — Gmail
first**, M365 as a documented second pass.

The connector owns a small internal `MailProvider` interface (list new
messages scoped by query, fetch message/thread, send reply); `GmailProvider`
is the first implementation. The interface is what keeps the M365 pass a
transport-swap instead of a rewrite:

- **Gmail (this pass):** Gmail REST API. Auth = OAuth2 with a long-lived
  refresh token: `clientIdEnv` / `clientSecretEnv` / `refreshTokenEnv` (or
  `*File` variants) — refs only, per #16 credential rules. The connector
  exchanges refresh→access at the token endpoint and retries once on 401.
  Both `apiBaseUrl` (`https://gmail.googleapis.com`) and `tokenUrl`
  (`https://oauth2.googleapis.com/token`) are config-swappable so the smoke
  stub drives the exact live code path.
  One-time consent (getting the refresh token) is operator-side and
  documented in the live-UAT leg; the connector never runs an OAuth browser
  flow itself.
- **M365 (second pass, documented only):** Graph `Mail.Read`/`Mail.Send` with
  a single-tenant Entra app — the same registration story as the Teams design
  §2, which is deliberate: one Entra app can serve both when we get there.
  Not implemented, not claimed.

## 2. Decision: scoped mailbox read/search

Read scope = the configured Gmail **query** (default `is:unread newer_than:7d`,
config `channels.email.query`) plus `maxBodyChars` truncation (default 8000)
before anything reaches the model. The connector polls `messages.list` with
that query (`pollIntervalMs`, default 60s), fetches bodies via `messages.get`,
and tracks seen ids in `<dataDir>/connectors/email/state.json` so restarts
don't re-process. Thread context for summarization comes from `threads.get`
on the inbound message's thread (§6). No search CLI in MVP — the scoped poll
query *is* the read boundary; widening it is an explicit config act.

## 3. Decision: contact/domain trust rules → framework extension, fail-closed

Inbound trust is evaluated **centrally** (so denials stay counted in
runtime-status) by extending the #16 access policy:

- `allowedSenders` — exact email addresses (existing mechanism).
- `allowedSenderDomains` — **new, generic policy field**: a sender whose
  address ends in `@<domain>` is allowed. Empty/missing = no domain grants.
- Everything else fails closed exactly as before: no policy ⇒ nobody.

Outbound trust is structural: **reply-only**. The MVP cannot compose to
arbitrary recipients — every outbound is a reply on an inbound thread, to the
thread's participants. First-contact/compose is a #24-era capability once
approvals have a UI.

## 4. Decision: send approval → durable ProposedAction store (#24-absorbable)

Per Clint (2026-07-02): **minimal local gate now, designed so #24 absorbs it.**

New core module `channels/approval.ts`:

```ts
type ProposedActionKind = "connector_send" | "memory_write";  // #24 adds more
type ProposedAction = {
  id; kind; connectorId; sessionKey; agentId;
  createdAt; summary;                  // human-readable one-liner for list views
  payload;                             // connector_send: ConnectorOutboundMessage
                                       // memory_write: { path, content }
  status: "pending" | "approved" | "rejected";
  decidedAt?; decidedBy?; decisionNote?;
};
```

`ApprovalStore` persists to `<dataDir>/approvals/actions.json` with the same
atomic-write pattern as the delivery queue. Records are never deleted by
decisions — approved/rejected entries retain full payload + decision metadata,
which (with the transcript events below) is the auditability the ticket
requires.

**The gate:** connectors now declare `defaultSendPolicy` on the #16 contract
(`"auto"` for chat connectors — absent means auto; `"approval_required"` for
email). Config may override per channel (`channels.<id>.sendPolicy`), but:

- email's **default is `approval_required`** — a fresh email config cannot
  auto-send (acceptance criterion 1);
- setting `sendPolicy: "auto"` on email is the "explicit policy" escape hatch
  the ticket's safety block names ("never auto-send externally **without
  policy**") and is surfaced loudly by status/doctor as a warning.

In the Gateway reply pipeline, `approval_required` diverts the routed reply:
instead of `queue.enqueue(...)`, the reply becomes a `connector_send`
ProposedAction + an `approval_proposed` transcript event. **Approve = enqueue**
onto the connector's existing delivery queue (the standard drain
timer/retry/dead-letter machinery delivers it — no parallel send path exists);
reject archives with the note. Both decisions append `approval_decided`
transcript events. If the Gateway is down at approve time, the queued entry
delivers on next start — same semantics as every queued connector message.

**Why this absorbs into #24 instead of being replaced by it:** #24's Approval
Center is a UI + expanded action taxonomy over exactly this shape (durable,
inspectable, approve/reject/defer, audit events). The store, the record
schema, and the approve-executes-action contract are the #24 core; #21 ships
them with two action kinds and a CLI surface.

## 5. Decision: draft replies

The routed model turn's reply text **is** the draft. It lives in the
ProposedAction payload (and transcript) — we deliberately do *not* create a
Gmail-side draft: one artifact, one approval surface, no state to reconcile
across systems. `mindstone approvals show <id>` prints the full draft;
approving sends exactly that text (edited resubmission = reject + new turn in
MVP).

## 6. Decision: summarization + commitment detection → triage-workflow contract

The connector formats inbound mail as a structured **envelope** the model
turn receives as the user text:

```text
[email] from: <sender> | subject: <subject> | date: <date> | thread: <n> prior message(s)
<thread digest: last K messages, truncated to maxBodyChars total>
---
<new message body, truncated>
```

What the model *does* with the envelope is persona/workflow territory
(#11/#12 machinery), not connector code — the connector must stay pure
transport. The doc ships a reference **email-triage workflow contract**: the
routed turn should produce (a) a summary of the thread, (b) detected
commitments/tasks/follow-ups, (c) a draft reply — all as the reply text that
becomes the draft — and optionally (d) a fenced memory-proposal block:

    ```mindstone-memory-proposal
    { "path": "email/<slug>.md", "content": "<durable fact worth keeping>" }
    ```

The Gateway extracts block (d) from the reply into a **`memory_write`
ProposedAction** (it is stripped from the draft text). Approving writes the
file into the memory directory; rejecting archives it. This is the ticket's
"memory-write proposal discipline": email-derived memory is *always* proposed,
never written directly.

**Threat note (deliberate):** the email body is attacker-controlled, so the
model reply — and any proposal block in it — must be treated as attacker-
influencible (prompt injection). That is *why* both action kinds terminate in
the human approval gate, why outbound is reply-only, and why the smoke's
injection leg plants a proposal block inside an email body and asserts it
becomes nothing more than a **pending** proposal (§9).

## 7. Decision: transcript/source metadata + sensitive-context routing

Standard #16 source metadata (`substrate: connector:email`, channel/chatType/
sender) plus email-specific fields (messageId, threadId, subject) on every
entry. Additionally every email-sourced entry carries
`metadata.sensitiveSource: "email"` — the forward hook for
`SENSITIVE_CONTEXT_ROUTING.md` (a design spike; routing itself is **not**
implemented). Marking now means email transcript segments are classifiable
retroactively when that lands.

## 8. Safety defaults (ticket block → mechanism)

| Ticket default | Mechanism |
|---|---|
| read allowed by configured scope | poll query + maxBodyChars (§2) |
| draft allowed by default | routed reply → ProposedAction, no side effects (§5) |
| send requires explicit approval | `defaultSendPolicy: approval_required` + CLI decision (§4) |
| never auto-send externally without policy | auto only via explicit `sendPolicy: "auto"` config + doctor warning (§4) |
| sensitive-context routing applies | `sensitiveSource: "email"` metadata hook (§7) |

## 9. Validation plan + claim ceiling

Claim ceiling without live Gmail: **smoke-tested** (same as every connector).

- **Units:** mapping fns (Gmail payload → inbound envelope), domain-trust
  matrix (exact / domain / deny / no-policy), ApprovalStore transitions
  (propose → approve/reject; decisions immutable; audit fields).
- **Stub E2E** (`scripts/stub-gmail-server.mjs` + `scripts/smoke-email.sh`):
  stub serves token + messages.list/get + threads.get and captures send;
  connector runs the exact live path with `apiBaseUrl`/`tokenUrl` swapped.
  Legs: allowed-domain inbound → envelope in transcript → mock-routed reply →
  **pending ProposedAction and NO send** → CLI approve → queue → stub receives
  exactly one send → audit events present; reject leg → archived, still no
  send; denied-sender leg → counted, dropped; injection leg (proposal block in
  body) → pending memory proposal only; token-leak grep across config/status/
  queue/approvals/transcripts.
- **Live leg (Clint, runbook):** real Google OAuth consent → refresh token →
  scoped poll against a real mailbox → approve → real send → audit walk.

## 10. Claim status

**Implemented + smoke-tested** (`npm run smoke:email`, 2026-07-02): unit
matrix (mapping/envelope/reply-MIME, domain trust, ApprovalStore immutable
decisions, proposal extraction + path sanitizing, send-policy resolution,
wizard refs) and the stub E2E (allowed→pending-draft-and-NO-send →
approve→one correctly threaded reply → reject→archived → denied→counted →
injection→pending-memory-proposal-only, applied only on approve →
delivery-failure retry → bad-refresh-token visible while `/health` stays
200 → secret-leak sweep across status/approvals/queue/transcripts).

**Not claimed:** live Gmail (runbook leg for Clint — see
`LIVE_UAT_RUNBOOK.md`), M365/Graph (documented second pass only),
compose-to-arbitrary-recipients (no code path exists), approval UI (#24).
