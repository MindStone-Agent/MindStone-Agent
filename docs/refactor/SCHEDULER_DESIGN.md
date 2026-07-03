# Scheduler and recurring jobs — design (#29)

**Status:** Design only. Nothing in this document is implemented, smoke-tested, or live-validated. Per the repo's claim taxonomy, every mechanism described here is **pending** until code lands and the proposed smoke suite runs green.

**Provenance:** the judged deliverable of the 2026-07-03 four-candidate design comparison (Experiment F — see `docs/case-studies/lca-orchestration-vs-model-capability.md` and its detailed companion). Base = the top-ranked candidate; imports applied per both judges' converging recommendations: occurrence-key idempotence, the config-hash audit event, `maxRunsPerDay`, run-manager registration, explicit DST test language, and the `deliverOrPropose` helper extraction (from the co-first candidate); the two-driver framing and change inventory (from candidate B); the decision record and dry-run-first destructive-maintenance default (from candidate A); plus the two reviewer wording fixes on the base itself.

**Ticket:** Scheduler / recurring jobs — recurring workflows, digest generation, follow-up checks, memory maintenance, channel delivery retries, reminder/task sync, explicit user-visible schedule config. Acceptance criteria: (1) scheduler configuration is visible and auditable; (2) jobs emit transcript/audit events where appropriate; (3) mutating jobs obey approval policy.

**Prior art in-repo:** `docs/refactor/FABLE_5_PRODUCT_WISHLIST.md` §20 (the ticket's origin), and two explicit deferrals into this ticket: `docs/operations/CALENDAR_CONNECTOR.md` §0 ("Scheduled digests … are explicitly **#29 scheduler territory** — this connector ships no timers") and `packages/mindstone-gateway/src/connectors/calendar.ts` (startInbound idles because "scheduled digests are #29 scheduler territory"). This design is written to pay those debts without inventing scope beyond them.

---

## 1. Summary

Add a **declarative, config-driven job scheduler** whose semantics live in `mindstone-core` and whose always-on runtime lives in the Gateway daemon — the only long-lived process in the system (`docs/refactor/ARCHITECTURE.md` §4.1). Jobs are declared in the existing config file under a new `scheduler` section (satisfying "explicit user-visible schedule config" by construction: one human-readable JSON file, already wizard-written, doctor-checked, and diffable), executed by a small tick loop in the Gateway, observable through `mindstone schedule …`, `mindstone status`, `mindstone doctor`, and the Gateway `/status` endpoint, and audited through the same append-only transcript event mechanism every existing subsystem uses (`workflow_*`, `approval_proposed`/`approval_decided`, `handoff_replayed`).

The scheduler **never mutates consequential, user, or external state directly** (its own bookkeeping files — runtime state, run history, locks — aside). Every consequential effect rides an existing, already-gated mechanism:

- scheduled model turns run through `runMindStoneChatTurn` (`packages/mindstone-core/src/chat/run.ts`), which already applies the shared proposal discipline (`applyActionProposalDiscipline`, `packages/mindstone-core/src/channels/approval.ts`) — memory writes and connector mutations proposed by a scheduled turn become **pending ProposedActions**, exactly as they do for chat and connector turns;
- scheduled outbound delivery rides the per-connector `ConnectorDeliveryQueue` (`packages/mindstone-core/src/channels/queue.ts`) subject to `resolveConnectorSendPolicy` — an `approval_required` connector turns a scheduled digest into a pending approval, never an automatic send;
- `connector_mutation` (calendar/task write-backs) remains **structurally** approval-gated: there is no auto path for it at all (`approval.ts` doc comment), and the scheduler does not add one.

That structural reuse is how AC3 ("mutating jobs obey approval policy") is met without new policy machinery: the scheduler is a *trigger* source, not a new *authority*.

### Ticket capability → design mechanism map

| Ticket capability | Mechanism (section) |
|---|---|
| Recurring workflows | `agent_turn` job kind; optional forced `workflowId`/`personaId` via the existing `route` parameter of the canonical turn (§7.1) |
| Digest generation | `agent_turn` with `collect` inputs (calendar agenda, memory log tail, transcript tail) + optional `deliver` step onto a connector queue (§7.2) |
| Follow-up checks | `system_check` mechanical sweep (stale approvals, dead letters, connector errors) + `agent_turn` follow-up review template (§7.3) |
| Memory maintenance | `memory_maintenance` job kind wrapping the existing `backfillSqliteMemoryIndex` / `maintainSqliteMemoryIndex` / `backfillSqliteMemoryEmbeddings` (§7.4) |
| Channel delivery retries | `queue_drain` job kind formalizing/backstopping the Gateway's in-process drain timer; dead-letter surfacing + gated requeue (§7.5) |
| Reminder/task sync | `connector_pull` job kind over the calendar connector's pull surface; write-backs stay proposal-gated (§7.6) |
| Explicit user-visible schedule config | `config.scheduler` section + `mindstone schedule` CLI + status/doctor integration (§5, §8) |

---

## 2. Where this fits the architecture as it exists

Grounding facts (all verified in the current tree):

- **Package layout and dependency direction.** `packages/mindstone-core` must not import `mindstone-gateway` or the Pi adapter; contracts live in core, runtime wiring in the Gateway (`docs/refactor/ARCHITECTURE.md` §2.1). The connector subsystem models this exactly: contracts + registry in `packages/mindstone-core/src/channels/connector.ts` (`registerConnector`/`getConnector`), runtime startup/drain loop in `packages/mindstone-gateway/src/index.ts` (`startConfiguredConnectors`, ~line 2002). The scheduler copies this split.
- **The Gateway is the only always-on process.** `startGateway` (`packages/mindstone-gateway/src/index.ts`, ~line 2094) starts the HTTP/WS server, then `startConfiguredConnectors()` with failures isolated into per-connector status files. `mindstone gateway start/stop/install` (managed background process + macOS launchd service) already exists in `packages/mindstone-cli/src/index.ts` (~lines 1219–1352). The scheduler runtime starts and stops with the Gateway.
- **Timers already exist but are invisible and hard-coded.** Each running connector gets a `setInterval` re-drain (default 5000 ms, `queueDrainMs`) at `packages/mindstone-gateway/src/index.ts` ~lines 2048–2054; connectors poll inbound on their own intervals (`pollIntervalMs` in `connectors/email.ts`, `connectors/telegram.ts`, `pollMs` in `connectors/loopback.ts`). Part of this ticket's value is making periodic behavior *declared and visible* instead of implicit.
- **Config is the single user-visible policy surface.** `MindStoneConfig` (`packages/mindstone-core/src/config/types.ts`) is loaded by `loadMindStoneConfig` (`config/load.ts`), validated by `validateMindStoneConfig` and written by `writeMindStoneConfig` (`packages/mindstone-core/src/wizard/config.ts`). Doctor (`packages/mindstone-core/src/doctor/doctor.ts`) and system status (`packages/mindstone-core/src/status/status.ts`, `getMindStoneSystemStatus`) both read it. The scheduler adds a section here rather than a new store.
- **Durable small-state pattern.** Approvals (`<dataDir>/approvals/actions.json`, `channels/approval.ts`), delivery queues (`<dataDir>/connectors/<id>/queue.json`, `channels/queue.ts`), and connector runtime status (`<dataDir>/connectors/<id>/status.json`, `channels/runtime-status.ts`) all use atomic tmp-file+rename JSON writes readable from any process. Scheduler state uses the identical pattern under `<dataDir>/scheduler/`.
- **Transcript is the audit spine.** `appendTranscriptEntry` (`packages/mindstone-core/src/transcript/store.ts`) appends `role: "event"` entries with `metadata.event` discriminators; precedents: `workflow_started/…/workflow_failed` (`docs/operations/WORKFLOWS.md`), `approval_proposed`/`approval_decided`, `handoff_replayed`, `user_message`. Scheduler events join this vocabulary.
- **The canonical turn is the only model-execution seam.** `runMindStoneChatTurn` (`packages/mindstone-core/src/chat/run.ts`) owns identity/persona precedence, deterministic workflow evaluation, scope-enforced auto-recall, sliding-window/auto-compact context management, proposal discipline, and transcript authority. App Engine Mode (`packages/mindstone-core/src/app-engine/run.ts`, `runMindStone`) is deliberately a thin adapter over it. Scheduled turns use the same seam so they inherit *everything* — including AC3 — instead of re-implementing any of it.
- **Run visibility.** The Gateway tracks in-flight agent runs in `GatewayRunManager` (`packages/mindstone-gateway/src/run-manager.ts`), which powers run listing and `chat.abort`. Scheduled turns register there too (§7.1), so an operator can see and abort a scheduled run exactly like an interactive one.

---

## 3. Design overview

```text
config.scheduler (declarative jobs; user-visible, doctor-checked; content-hashed for audit)
        │
        ▼
Gateway scheduler runtime (packages/mindstone-gateway/src/scheduler-runtime.ts — NEW)
  tick loop (default 30s, unref'd, config reloaded per tick; config-hash change → audit event)
        │ due? (core schedule evaluator → occurrence key)
        ▼
per-job lock (<dataDir>/scheduler/locks/<jobId>.lock) + occurrence-key dedup
        │
        ▼
executor registry (core contract; kind → executor)
  ├─ agent_turn          → runMindStoneChatTurn (provider/model/runner resolved as the
  │                        Gateway route path resolves them; registered with
  │                        GatewayRunManager) → reply → optional deliver step →
  │                        deliverOrPropose(...) → ConnectorDeliveryQueue or ApprovalStore
  ├─ connector_pull      → connector read surface (e.g. CalendarProvider.listUpcoming)
  ├─ queue_drain         → ConnectorDeliveryQueue.drain + dead-letter surfacing
  ├─ memory_maintenance  → backfill/maintain/embed (core memory functions; dryRun-first)
  └─ system_check        → stale-approval / dead-letter / connector-error sweep
        │
        ▼
outcomes:  transcript events (job_started/job_finished/job_failed/job_skipped/…)
           + <dataDir>/scheduler/state.json (per-job runtime state + occurrence keys)
           + <dataDir>/scheduler/history.jsonl (append-only run history, rotated)
           + proposals/queue entries for anything consequential (existing gates)
```

New modules:

```text
packages/mindstone-core/src/scheduler/
  index.ts        barrel
  types.ts        job/schedule/state/event types; executor contract
  schedule.ts     pure schedule evaluator (nextDueAt, isDue, occurrence keys) — injectable clock
  state.ts        SchedulerStateStore + history append/rotation (atomic JSON / JSONL)
  audit.ts        job event append helpers (appendTranscriptEntry wrappers)
  executors.ts    core-only executors: memory_maintenance, system_check
  registry.ts     registerJobExecutor/getJobExecutor (mirrors connector registry)

packages/mindstone-gateway/src/scheduler-runtime.ts
  startScheduler()/stopScheduler(); tick loop; lock acquisition; config-hash tracking;
  Gateway-side executors: agent_turn, connector_pull, queue_drain
  (these need provider/model/runner resolution and the connector registry)

packages/mindstone-gateway/src/index.ts  (refactor, small)
  extract deliverOrPropose(connectorId, outbound, policyCtx) from the connector-reply
  send-policy fork (~lines 1961–1999) so the scheduler and the connector path share
  ONE implementation of "queue it or propose it" (§7.2)

packages/mindstone-cli/src/  (extend index.ts)
  `mindstone schedule` command: list/show/status/history/run/enable/disable/requeue
```

Core defines *what a job is and when it is due*; the Gateway defines *how kinds that need providers/connectors execute*; executors that need only core (memory, system checks) live in core so `mindstone schedule run <id>` can execute them without the Gateway package loaded. This is the same shape as the connector contract/registry split and preserves the dependency rule.

---

## 4. Job model

### 4.1 Types (core `scheduler/types.ts`)

```ts
export type MindStoneJobKind =
  | "agent_turn"          // recurring workflows, digests, follow-up reviews
  | "connector_pull"      // reminder/task sync (read side)
  | "queue_drain"         // channel delivery retries
  | "memory_maintenance"  // index backfill/maintain/embed
  | "system_check";       // mechanical follow-up sweep

export type MindStoneJobSchedule =
  | { every: string }                          // duration: "5m" | "1h" | "7d" (m/h/d units)
  | { at: string; days?: MindStoneDayOfWeek[] }; // wall-clock "07:30" in scheduler timezone,
                                                 // optional day-of-week filter

export type MindStoneScheduledJobConfig = {
  id: string;                     // unique, kebab-case; used in locks/state/events
  kind: MindStoneJobKind;
  schedule: MindStoneJobSchedule;
  enabled?: boolean;              // default true (the section itself is opt-in, §5)
  description?: string;          // human-readable purpose, surfaced by list/show
  agentId?: string;               // default routing.defaultAgentId ?? "default"
  sessionKey?: string;            // default: see §9.1 session-key policy
  timeoutMs?: number;             // default 600_000 (10 min); enforced via AbortSignal
  catchUp?: "skip" | "once";     // missed-while-down policy; default "skip"
  overlap?: "skip";              // v1: a job never overlaps itself (only value)
  maxConsecutiveFailures?: number; // default 5 → auto-pause (§6.5)
  maxRunsPerDay?: number;         // hard cap per calendar day (scheduler tz); unattended-cost guard
  // kind-specific payloads (exactly one relevant per kind):
  turn?: MindStoneAgentTurnJobSpec;
  pull?: MindStoneConnectorPullJobSpec;
  drain?: MindStoneQueueDrainJobSpec;
  maintenance?: MindStoneMemoryMaintenanceJobSpec;
  check?: MindStoneSystemCheckJobSpec;
};

export type MindStoneSchedulerConfigSection = {
  enabled?: boolean;              // default FALSE — explicit opt-in (§5)
  timezone?: string;              // IANA name; default system local
  tickMs?: number;                // default 30_000
  maxConcurrentAgentTurns?: number; // default 1 (protect local models)
  auditSessionKey?: string;       // default "agent:<defaultAgentId>:scheduler" (§9.1)
  jobs?: MindStoneScheduledJobConfig[];
};
```

`MindStoneConfig` (`config/types.ts`) gains `scheduler?: MindStoneSchedulerConfigSection`.

### 4.2 Schedule spec — decision and alternatives

**Decision: v1 supports `every` (interval) and `at` (wall-clock time-of-day + optional day filter). No cron strings in v1.**

- These two forms cover every ticket capability: digests ("daily at 07:30"), maintenance ("every 7d"), retries ("every 5m"), sync ("every 1h"), follow-ups ("weekdays at 16:00").
- They are deterministic to evaluate and trivial to test with an injected clock — the evaluator is a pure function `nextDueAt(schedule, state, now, timezone)`.
- The repo is deliberately dependency-light (vendored Pi, hand-rolled stores); a five-field cron parser is either a new dependency or ~150 lines of correctness-sensitive code that the ticket does not require.

*Alternative considered — full cron syntax (via a `croner`-class dependency or built-in parser):* strictly more expressive ("last Friday of month"), familiar to operators. Rejected for v1: expressiveness the capabilities don't need, plus a dependency-or-maintenance cost and a larger validation matrix. The `schedule` field is a tagged union, so `{ cron: "…" }` can be added later without breaking config. Documented as a follow-on, not claimed.

*Alternative considered — OS cron/launchd per job:* rejected as the primary mechanism. It fragments the "visible and auditable" story across OS-specific stores (crontab, launchd plists), can't append transcript events without invoking the CLI anyway, and behaves differently per platform. However, the second driver (§8.2) deliberately makes every job runnable from external cron for operators who prefer OS scheduling — the config remains the single definition either way.

### 4.3 Semantics: `every`, `at`, occurrence keys, and DST

- `every`: due when `now >= lastRunAt + interval`, anchored to the start time of the last run (no drift accumulation from run duration). A never-run `every` job is due at the first tick after it becomes enabled — "runs now, then every interval" — which is the intuitive behavior for maintenance/retry jobs; operators who need phase alignment ("weekly, but on Sunday night") use `at` instead. `nextDueAt` is recomputed from state every tick, so config edits (interval changes) take effect without restart.
- `at`: due when the wall clock in the scheduler timezone has passed `HH:MM` for the current calendar date and the day passes the `days` filter. Timezone math uses `Intl.DateTimeFormat` with the configured zone (no dependency).
- **Occurrence keys (idempotence spine).** Every scheduled firing has a deterministic key: `"<jobId>@<occurrenceISO>"` for scheduled occurrences (the occurrence the run satisfies, not the moment it started), `"<jobId>@manual:<uuid>"` for manual runs. A job fires for occurrence O **only if O is due and O is not already recorded in state** — one rule that uniformly prevents double-fires across ticks, restarts, catch-up, the two drivers (§8.2), and the DST fall-back repeated hour. Simpler and stronger than a per-day date guard: it works for interval and wall-clock schedules alike, and a corrupt-then-replaced state file degrades to a visible duplicate-or-skipped run in the ledger rather than silent drift.
- **DST policy (explicit, unit-tested).** A nonexistent local time (spring-forward gap) resolves to the first valid instant after the gap; a repeated local time (fall-back) fires **once**, deduplicated by occurrence key. Both rules get dedicated fixture tests (§11 leg 1) — DST is specified behavior here, not a documented risk.
- **Missed runs (`catchUp`):** on Gateway start (or laptop wake), a job whose due time passed while down either fires once immediately (`"once"`) or skips to the next occurrence (`"skip"`, default) — in both cases emitting an auditable event (`job_started` with `catchUp: true`, or `job_skipped` with `reason: "missed_while_down"`). At most one catch-up run ever fires regardless of how many occurrences were missed — no backfill storms. The catch-up run's occurrence key is the missed occurrence it satisfies.
- **`maxRunsPerDay`:** counted against the scheduler timezone's calendar day from state; a due job past its cap is skipped visibly (`job_skipped`, `reason: "daily_cap"`). Manual runs count toward the cap unless forced (`schedule run <id> --force`, which is itself audited).

---

## 5. Configuration — visible, auditable, opt-in (AC1)

### 5.1 The config section is the schedule

Jobs are declared in the same `config.json` every other policy lives in — not in a database, not in hidden runtime state, not in per-job artifact directories. Example of a full section exercising every kind:

```json
{
  "scheduler": {
    "enabled": true,
    "timezone": "America/Chicago",
    "jobs": [
      {
        "id": "morning-digest",
        "kind": "agent_turn",
        "description": "Weekday morning digest: agenda + open follow-ups",
        "schedule": { "at": "07:30", "days": ["mon", "tue", "wed", "thu", "fri"] },
        "maxRunsPerDay": 2,
        "turn": {
          "input": "Produce my morning digest: summarize today's calendar, open commitments, and anything needing my attention. Keep it under 200 words.",
          "collect": [
            { "source": "calendar_agenda", "days": 1 },
            { "source": "memory_log", "lines": 40 }
          ],
          "route": { "workflowId": "morning-digest" },
          "deliver": { "connectorId": "telegram", "chatId": "123456789" }
        }
      },
      {
        "id": "followup-review",
        "kind": "agent_turn",
        "schedule": { "at": "16:00", "days": ["mon", "wed", "fri"] },
        "turn": {
          "input": "Review open commitments and follow-ups recorded in memory and recent transcripts. For anything resolved or newly due, propose memory updates.",
          "collect": [{ "source": "memory_log", "lines": 80 }]
        }
      },
      {
        "id": "followup-sweep",
        "kind": "system_check",
        "schedule": { "every": "6h" },
        "check": { "staleApprovalsAfterHours": 48, "notify": { "connectorId": "telegram", "chatId": "123456789" } }
      },
      {
        "id": "memory-weekly",
        "kind": "memory_maintenance",
        "schedule": { "every": "7d" },
        "maintenance": { "backfill": true, "dedupeText": true, "embed": false }
      },
      {
        "id": "delivery-retry",
        "kind": "queue_drain",
        "schedule": { "every": "5m" },
        "drain": { "connectorId": "*", "notifyDeadLetters": true }
      },
      {
        "id": "task-sync",
        "kind": "connector_pull",
        "schedule": { "every": "1h" },
        "pull": { "connectorId": "calendar", "mode": "agenda", "days": 2 }
      }
    ]
  }
}
```

### 5.2 Decision: disabled by default

`scheduler.enabled` defaults to **false**, and an absent section means no scheduler. Rationale: the wishlist's own guardrail ("Do not auto-send external messages without approval policies", `FABLE_5_PRODUCT_WISHLIST.md` "What to avoid") plus the local-first posture — unattended model execution and unattended outbound traffic must be an explicit operator act. Enabling is a config edit (or wizard step, §8.4), which is itself visible in the file and in `formatConfigChangeSummary` output when done through wizard/CLI paths.

*Alternative considered — enabled by default with zero jobs:* functionally identical until a job exists, but "the daemon runs a scheduler you never asked for" is the wrong posture for an agent runtime that markets auditability; rejected.

### 5.3 Decision: config section, not artifact directories

Workflows use `<dataDir>/workflows/<id>/workflow.json` artifacts; personas similarly. Jobs could have mirrored that.

- **For config:** the AC says *schedule config* must be user-visible/auditable; one section in one file is the strongest form of that — `mindstone config`, doctor, git diff, and the wizard all already operate on it. Jobs are small policy objects (no prompt bodies beyond a template string), unlike workflows/personas which bundle multi-file content.
- **Against artifacts:** discovery/merge semantics (config routes + artifact dirs + persona-packaged references) would triple the validation matrix for no capability gain.
- **Extension point preserved:** if Agent/Persona Packs later want to ship jobs (`docs/refactor/PACK_REGISTRY_DESIGN.md` territory), a `scheduler.jobDirs` discovery lane can be added; pack-shipped jobs should land **disabled** pending explicit operator enablement. Documented, not designed here.

### 5.4 Validation

`validateMindStoneConfig` (`wizard/config.ts`) gains scheduler rules; doctor (§8.3) re-checks them at runtime. Fail-closed at the runtime level: a job that fails validation is never executed — it is reported (`schedule status`, doctor) with its error, mirroring how workflow load errors surface in `MindStoneWorkflowSummary.error` (`workflow/types.ts`).

Checks: unique job ids; parseable schedule (`every` duration grammar, `at` HH:MM, valid `days`); known `kind` with the matching payload present; referenced `connectorId` registered/configured; referenced `workflowId`/`personaId` resolvable (warn, not fail — artifacts may be installed later); `timezone` resolvable by `Intl`; `embed: true` requires `memory.embeddingProvider`; `deliver`/`notify` targets name configured connectors; `maxRunsPerDay >= 1` when present.

### 5.5 Config-change audit trail

Config is a mutable file, but its *changes* leave an append-only trace: the runtime stamps a **`configHash`** (SHA-256 of the canonicalized `scheduler` section) into `state.json` on every tick, and when the hash changes it appends a **`scheduler_config_changed`** event — old hash → new hash, plus the job ids added/removed/modified — to the scheduler audit session and the run history. This covers *all* edit paths (hand edit, wizard, CLI); the CLI's own `enable`/`disable` verbs additionally append their attributed `schedule_changed` event (§8.1). Between them, AC1's "auditable" holds even though the schedule lives in a mutable file.

---

## 6. Scheduler runtime (Gateway)

### 6.1 Lifecycle

`startGateway` (`packages/mindstone-gateway/src/index.ts`) calls `startScheduler()` after `startConfiguredConnectors()`, with the same isolation contract: a scheduler failure writes status and never crashes the Gateway (`.catch(() => undefined)` at the call site, granular error capture inside). `close()` calls `stopScheduler()` (clears the tick timer, releases nothing mid-flight — running jobs finish or hit their timeout; locks carry PID so a killed process leaves stale locks that are reclaimed, §6.3).

### 6.2 Tick loop

A single `setInterval` (default 30 s, `scheduler.tickMs`, `.unref()`'d exactly like the connector drain timer). Each tick:

1. Reload config via `loadGatewayConfig()` — the Gateway already reloads config per inbound message (`handleConnectorInbound`), so per-tick reload matches existing practice and makes config edits take effect without restart (a visibility property: what the file says *is* what runs, within one tick). Compare the scheduler-section hash; on change, append `scheduler_config_changed` (§5.5).
2. Skip everything unless `scheduler.enabled === true`.
3. For each enabled, valid job: compute dueness + occurrence key from the state store + evaluator; honor `overlap: "skip"` (lock held ⇒ `job_skipped` event with `reason: "overlap"` only when it was actually due); honor `maxRunsPerDay` (§4.3); honor the `maxConcurrentAgentTurns` gate for `agent_turn` jobs (excess due jobs wait for a later tick — they stay due).
4. Execute due jobs asynchronously (the tick never blocks on job completion).

Tick granularity bounds schedule precision to ±tickMs; documented. Sub-tick precision is a non-goal — nothing in the capability list needs it (the existing 5 s connector drain covers low-latency delivery; §7.5).

### 6.3 Per-job locking and manual runs

Lock file `<dataDir>/scheduler/locks/<jobId>.lock` containing `{ pid, startedAt, trigger, occurrenceKey }`, created with `wx` (exclusive) semantics. Held for the duration of a run; removed on completion. A lock is **stale** — and reclaimable — when its PID is dead (`process.kill(pid, 0)` probe) or `startedAt` is older than `timeoutMs × 1.5`. This single mechanism serializes: (a) a job against itself across ticks, (b) the Gateway loop against `mindstone schedule run <id>` executed from another process, and (c) two accidentally-running Gateways against the same `dataDir` (not a supported topology, but the failure mode degrades to serialization rather than double-execution). Occurrence keys (§4.3) are the second, independent layer: even where lock semantics are weakest (Windows PID probes), a stolen lock cannot re-run an occurrence that state already records. Caveat recorded: PID-probe semantics on Windows are weaker; the timeout-staleness rule plus occurrence keys are the backstop.

### 6.4 Job execution context

```ts
export type JobExecutionContext = {
  job: MindStoneScheduledJobConfig;
  config: MindStoneConfig | undefined;
  configPath?: string;
  paths: MindStoneRuntimePaths;
  trigger: "schedule" | "manual" | "catch_up";
  occurrenceKey: string;      // the occurrence this run satisfies (§4.3)
  scheduledFor?: string;      // ISO instant of the occurrence
  now: () => Date;            // injectable clock (smokes drive time manually)
  signal: AbortSignal;        // fired at timeoutMs
};

export type JobExecutionResult = {
  ok: boolean;
  summary: string;                       // one-liner for events/history/status
  detail?: Record<string, unknown>;      // structured, kind-specific (history.jsonl)
  proposals?: string[];                  // ProposedAction ids raised by this run
};
```

Executors registered via `registerJobExecutor(kind, executor)` (core `scheduler/registry.ts`, mirroring `registerConnector`). The Gateway registers `agent_turn`, `connector_pull`, `queue_drain` at module load (as `gateway/src/index.ts` does for connectors via side-effect imports); core registers `memory_maintenance` and `system_check`.

### 6.5 Failure containment

- A throwing executor ⇒ `job_failed` event + history record + `consecutiveFailures += 1` in state. Never propagates to the loop.
- `consecutiveFailures >= maxConsecutiveFailures` (default 5) ⇒ the job auto-pauses: state gains `paused: { at, reason: "consecutive_failures", lastError }`, a `job_paused` event is appended, doctor warns. A paused job is skipped (visibly, in `schedule status`) until an operator runs `mindstone schedule run <id>` (success clears the pause) or toggles `disable`/`enable`. Mirrors the connector philosophy: a broken connector never crashes the Gateway; a broken job never spams retries forever.
- `timeoutMs` fires the context `AbortSignal`; `runMindStoneChatTurn` already accepts `signal` (`MindStoneChatTurnInput.signal`), so scheduled turns abort cleanly; mechanical executors check `signal.aborted` between phases. Timeout ⇒ `job_failed` with `reason: "timeout"`.

### 6.6 Runtime state and history

- `<dataDir>/scheduler/state.json` — per-job: `lastRunAt`, `lastFinishedAt`, `lastStatus` (`ok|failed|timeout`), `lastError`, `lastSummary`, recent occurrence keys, `runsToday` (per scheduler-tz day), `consecutiveFailures`, `paused`, plus scheduler-level `startedAt`/`lastTickAt`/`configHash`. Atomic tmp+rename writes (the `queue.ts`/`approval.ts` pattern). Readable from any process — this is how CLI/doctor/status report without talking to the Gateway, exactly like `readConnectorRuntimeStatus` (`channels/runtime-status.ts`).
- `<dataDir>/scheduler/history.jsonl` — append-only, one JSON record per run: `{ ts, jobId, kind, trigger, occurrenceKey, scheduledFor, ok, durationMs, summary, detail, proposals }`. This is the mechanical audit ledger (queue counts, maintenance stats — detail that would bloat transcript events). Bounded by a size-triggered rotation (`history.jsonl` → `history.1.jsonl`, keep 2 generations, thresholds config-tunable) — the repo has an open lesson about unbounded append files. Rotation never touches transcripts; transcripts remain the authoritative history, `history.jsonl` is operational detail.

---

## 7. Job kinds — the six capabilities

### 7.1 Recurring workflows — `agent_turn`

The executor runs one canonical turn:

1. Compose the message: the `turn.input` template, prefixed by rendered `collect` blocks (§7.2). The composed text is the turn's user message; the scheduled user entry carries `metadata: { event: "scheduled_prompt", jobId, occurrenceKey, trigger }` so it is never mistaken for a human message in transcript review or recall.
2. Resolve provider/model/runner from config the same way the Gateway's route path does (`resolveProvider` / `resolveRouteModel` / `resolveRunner` in `packages/mindstone-gateway/src/index.ts`) — i.e. the configured `routing.mode` (`mock`, `pi`, `pi-session`) drives scheduled turns exactly as it drives chat.
3. Register the run with **`GatewayRunManager`** (`packages/mindstone-gateway/src/run-manager.ts`) so run listing and `chat.abort` see scheduled turns exactly like interactive ones; the run's `AbortController` is the same object the job timeout fires.
4. Call `runMindStoneChatTurn` (`packages/mindstone-core/src/chat/run.ts`) with:
   - `sessionKey` per §9.1, `agentId` from the job;
   - `source: { substrate: "scheduler", channel: "<jobId>", chatType: "internal" }` — the transcript-source vocabulary used by every surface (`connectorTranscriptSource` precedent in `channels/connector.ts`);
   - `metadata: { scheduler: true, jobId, occurrenceKey, trigger, scheduledFor }`;
   - `route: turn.route` — the existing deterministic request-level forcing (`{ personaId?, workflowId? }`, reason `forced:request`), which is how "recurring workflows" literally means *recurring workflows*: a job pinned to `workflowId` re-evaluates that workflow's gates and route steps every run, with the standard `workflow_started/…` events appended by the turn itself (`docs/operations/WORKFLOWS.md`);
   - `signal` from the job context.

Everything downstream is inherited, not built: persona precedence, auto-recall, sliding-window pruning with transcript preservation, and — decisive for AC3 — `applyActionProposalDiscipline`, so a scheduled turn whose reply carries `mindstone-memory-proposal` or `mindstone-calendar-proposal` fences produces **pending approvals + `approval_proposed` events**, never direct writes.

*Alternative considered — replicate the connector-inbound pattern (append a user entry, then call the Gateway's `runConfiguredRoute`):* `runConfiguredRoute` (`gateway/src/index.ts` ~line 711) is a non-exported Gateway-internal that reads the *last user entry* from the transcript, and it exists to serve HTTP surfaces. Scheduled turns are not HTTP traffic; calling the core turn directly is the seam App Engine Mode already validated (`app-engine/run.ts` is precisely this adapter). Rejected mainly because the core seam is cleaner and already carries the whole discipline; behavior would be equivalent.

*Alternative considered — execute via `runMindStone` (App Engine entry) instead of `runMindStoneChatTurn`:* nearly equivalent (it wraps the same turn); it adds scope-derivation semantics designed for multi-tenant embedding that companion-mode jobs don't need, and requires the same provider/model resolution from the caller anyway. Either works; the design specifies the chat-turn seam directly, with `scope` left unset in companion mode. If Agent-Mesh-scoped scheduled jobs become a requirement, the job config grows an optional `scope` block and the executor switches to `runMindStone` — a contained change.

### 7.2 Digest generation — `agent_turn` + `collect` + `deliver`

**`collect` — deterministic context assembly before the turn.** Each collect source renders to a fenced, labeled block prepended to the input. v1 sources (all read-only, all existing surfaces):

| source | Mechanism |
|---|---|
| `calendar_agenda` | `calendarProviderFromContext(ctx).listUpcoming(…)` + `formatUpcomingEvents` (`packages/mindstone-gateway/src/connectors/calendar.ts`) — the same pull surface as `mindstone calendar upcoming` |
| `memory_log` | tail of `paths.logPath` (`LOG.md`) — last N lines |
| `transcript_tail` | `readTranscriptEntries(sessionKey, { limit: N })` (`transcript/store.ts`) rendered compactly |
| `queue_status` | `getConnectorVisibilityStatuses(config)` (`channels/runtime-status.ts`) — connector/queue health summary |
| `approvals_pending` | `new ApprovalStore().pending()` summaries (`channels/approval.ts`) |

A failing collect source degrades to an explicit `[collect:<source> unavailable: <error>]` block (the digest still runs and says so) rather than failing the job — a morning digest that reports "calendar unreachable" is more useful than no digest. Collect failures are recorded in the run's history `detail`.

**`deliver` — optional outbound step after the turn, through ONE shared helper.** If configured, the executor takes the turn's reply text (already proposal-stripped by the turn) and builds a `ConnectorOutboundMessage { text, chatId }` for `deliver.connectorId`. It then calls **`deliverOrPropose(connectorId, outbound, policyCtx)`** — a small helper **extracted from** the connector-reply pipeline's existing send-policy fork (`gateway/src/index.ts` ~lines 1961–1999) so that the scheduler and the connector path share one implementation and the two forks can never drift apart:

- `resolveConnectorSendPolicy({ connectorDefault, channelConfig })` returns `approval_required` ⇒ `ApprovalStore.propose({ kind: "connector_send", … })` + `approval_proposed` transcript event. The digest is **held as a draft**; a human `mindstone approvals approve` enqueues it. This is what happens if you point a digest at the email connector (its `defaultSendPolicy` is `approval_required`).
- `auto` (chat-connector norm: telegram/slack/discord/loopback) ⇒ `ConnectorDeliveryQueue.enqueue(...)`; delivery happens via the connector's drain (running Gateway: within seconds via the drain timer; stopped Gateway: on next start — the exact contract the approvals CLI already prints, `packages/mindstone-cli/src/index.ts` ~line 2007).
- Additionally, `deliver.requireApproval: true` forces the approval path even on an `auto` connector. **Policy invariant: job config can tighten send policy, never loosen it.** There is deliberately no `deliver.bypassApproval` — loosening remains exclusively the existing per-channel `sendPolicy` override that `getConnectorVisibilityStatuses` already flags with a loud warning. Delivery targets (`connectorId`/`chatId`) come **only from config, never from model output** — a scheduled turn cannot redirect its own digest (prompt-injection defense).

*Note on daily-digest-through-approval ergonomics:* an email-delivered daily digest generates one pending approval per day. That is the correct default for a consequence-bearing channel; operators who find it noisy deliver digests over a chat connector instead. Documented, not "solved" — solving it by loosening policy would violate the invariant above and the wishlist guardrail.

### 7.3 Follow-up checks — `system_check` (+ the agent-side template)

Two complementary halves, because "follow-up" is both mechanical and judgmental:

**Mechanical: `system_check`.** A no-model sweep over durable state, producing a compact report:

- **Stale approvals:** `ApprovalStore.pending()` entries older than `check.staleApprovalsAfterHours` (default 48) — pending drafts silently rotting is the exact failure mode an approval-gated system must guard against.
- **Dead letters:** per-connector `ConnectorDeliveryQueue.deadLetters()` counts (`channels/queue.ts`) — messages that exhausted retries and would otherwise be discovered never.
- **Connector errors:** `getConnectorVisibilityStatuses` rows with `runtime.state === "error"` or unresolved credentials.
- **Scheduler self-report:** paused jobs, jobs erroring.

Findings ⇒ `job_finished` event with a summary + full detail in history. When `check.notify` is configured and findings are non-empty, the report is delivered as an outbound message through `deliverOrPropose` (§7.2 — notification is outbound like any other). No findings ⇒ event only, no notification (quiet when healthy).

**Judgmental: an `agent_turn` job** (the `followup-review` example in §5.1): the model reviews open commitments (via `collect: memory_log` / `transcript_tail` / `approvals_pending`) and proposes updates through memory-proposal fences — which land as pending approvals per the standard discipline. This is the scheduled generalization of the email connector's triage-workflow contract (`docs/operations/EMAIL_CONNECTOR.md` §6: summarize / detect commitments / propose memory) — same contract, time-triggered instead of message-triggered.

### 7.4 Memory maintenance — `memory_maintenance`

Wraps the three existing core functions (`packages/mindstone-core/src/memory/sqlite-memory.ts`) with the spec `{ backfill?, dedupeText?, embed?, force?, dryRun? }`:

1. `backfill: true` ⇒ `backfillSqliteMemoryIndex({ config, paths })` — re-index file/transcript documents into the SQLite index (embeddings preserved).
2. always ⇒ `maintainSqliteMemoryIndex({ paths, deduplicateText, removeStaleSources: true, optimize: true, vacuum: true, dryRun })` — stale-source removal, dedupe, optimize, vacuum.
3. `embed: true` ⇒ `backfillSqliteMemoryEmbeddings({ config, paths, force })` — **default false**, and validation requires `memory.embeddingProvider` when set. Scheduled embedding runs a real embedding provider unattended; on a local-model install that is a deliberate resource decision the operator must opt into, and the smoke suite only ever exercises it against the mock-embed path (the repo's no-live-LLM smoke rule, per `CALENDAR_CONNECTOR.md` §3's validation note).

**Destructive operations default to `dryRun: true`.** A newly scheduled maintenance job *reports* what it would remove (stale sources, duplicate chunks) into history/events without deleting anything — the same affordance `mindstone memory maintain --dry-run` already offers interactively. Turning deletions on is an explicit per-job `dryRun: false`, and doctor **warns** on any scheduled job with destructive maintenance enabled ("unattended index rewrites configured"). Unattended destruction of derived state is recoverable in principle (the index is rebuildable) but expensive to discover late; report-first is the right scheduled default.

The result stats (sources indexed, chunks removed or would-remove, bytes reclaimed — the same fields `mindstone memory backfill`/`maintain` print, `packages/mindstone-cli/src/index.ts` ~lines 540–650) go into history `detail` and the event summary.

**AC3 note — why this "mutation" is not approval-gated:** the SQLite index is *derived, rebuildable* state over the authoritative transcript + memory files — the same operation the operator already runs ad hoc via `mindstone memory maintain`. It never touches memory *files*, journals, `LOG.md`, or transcripts (the things the approval discipline protects; cf. `memory_write` being a gated kind). The design makes this boundary explicit: **no scheduler job kind may write under `paths.memoryDir`, `paths.journalDir`, `paths.logPath`, or the transcript store, except through a ProposedAction** (transcript *event appends* excepted — they are append-only audit records, not content rewrites). The smoke suite asserts the boundary behaviorally (§11, leg 5).

### 7.5 Channel delivery retries — `queue_drain`

Current state: retries exist but only inside a running Gateway — a hard-coded 5 s `setInterval` per *started* connector (`gateway/src/index.ts` ~2048–2054), with `ConnectorDeliveryQueue.drain` giving `maxAttempts: 3` then dead-letter. Gaps: the interval is invisible (not in any status surface as policy), dead letters are visible only if someone looks (`queue.deadLetters()` has no caller in any surfaced path except the visibility status counts), and there is no retry pressure at all when a connector failed to start (its timer never exists) or between Gateway restarts.

**Decision: keep the fast in-process drain timer; add `queue_drain` as the declared, visible retry/backstop layer.**

The executor, for `drain.connectorId` (a specific id or `"*"` for all configured):

1. For each target connector with a non-empty `pending()` queue: resolve the connector + context exactly as `startConfiguredConnectors` does (registry + channel config + credential refs) and `queue.drain((entry) => connector.sendOutbound(ctx, entry.message))`. This retries queues even for connectors whose inbound listener failed to start — outbound-only recovery the current runtime cannot do. This executor is Gateway-side by necessity: draining requires connector implementations, credentials, and registry access that core does not have.
2. Report per-connector `{ pending, delivered, dead }` deltas into history + the event summary.
3. `notifyDeadLetters: true` ⇒ when dead-letter counts *increased* since the job's last run (state tracks the previous counts), raise the finding via the §7.3 notification path. Dead letters remain in the queue file (never silently dropped — `queue.ts`'s own contract).

**Dead-letter requeue is a mutating decision and is gated:** the notification includes the entry ids, and a new CLI verb `mindstone schedule requeue <connectorId> <entryId> [--yes]` flips a dead entry back to `pending` (attempts reset, `maxAttempts` re-honored) with a `queue_requeued` transcript event. Requeue is CLI-explicit (human), never automatic — an automatically-requeued dead letter is an infinite retry loop with extra steps.

*Alternative considered — migrate the 5 s drain into the scheduler entirely (one mechanism):* rejected. Tick granularity (30 s) would visibly slow interactive replies queued while chatting; shrinking tickMs to 5 s makes the scheduler a hot loop for everyone to serve one consumer. The two layers have different jobs: the in-process timer is a latency mechanism; `queue_drain` is a durability/visibility mechanism. The overlap is harmless (drain is idempotent over `pending` entries; file writes are atomic; worst case a double-read of an already-delivered file state). For AC1 completeness, `mindstone schedule status` lists the connector drain timers and poll intervals as read-only "runtime intervals" alongside declared jobs, so *all* periodic behavior is visible in one place.

### 7.6 Reminder/task sync — `connector_pull`

The read side of sync, scheduled; the write side stays where it already is (gated).

Spec: `{ connectorId, mode, days?, deliver? }`. v1 modes, calendar-first (matching the shipped provider surface):

- `mode: "agenda"` — pull upcoming events via `CalendarProvider.listUpcoming` (`connectors/calendar.ts`), format via `formatUpcomingEvents`, and append the result as a transcript **event** in the job's session (`job_finished` summary + an `agenda` payload in metadata) and/or `deliver` it as an outbound reminder message (via `deliverOrPropose`, §7.2 — send-policy fork applies). This is precisely the "morning agenda pushed into the session" the calendar doc deferred to #29.
- `mode: "summarize"` — reserved name for agenda-through-model; **not a separate mechanism**: configure an `agent_turn` job with `collect: calendar_agenda` instead. Validation rejects `summarize` in v1 with a pointer to the `agent_turn` shape (one way to do each thing).

Write-backs ("sync" in the create/update direction — new tasks, changed events) are **not** a scheduler capability and gain nothing from being one: mutations originate as model proposals (`mindstone-calendar-proposal` fences from any turn, scheduled turns included), become `connector_mutation` ProposedActions (always approval-gated — no auto path exists, `channels/approval.ts`), and on approval ride the connector queue where `sendOutbound` applies them with apply-time fail-closed validation (`validateCalendarMutation`). A scheduled `agent_turn` that reviews the agenda and proposes updates *is* task sync under this design — with a human between the model and the calendar, every time.

Task-resource providers (Todoist/GitHub/M365 per `CALENDAR_CONNECTOR.md` §4) plug in as connectors; `connector_pull` needs only a read function per provider. Not designed here beyond the seam.

---

## 8. Visibility and audit surfaces (AC1)

### 8.1 `mindstone schedule` CLI

New top-level command (registered in the dispatch list at `packages/mindstone-cli/src/index.ts` ~line 125, styled after `approvals`/`gateway`/`memory`):

```text
mindstone schedule list [--json]          # declared jobs: id, kind, schedule, enabled, next due
mindstone schedule show <id> [--json]     # full config + full runtime state for one job
mindstone schedule status [--json]        # scheduler state: enabled, tz, lastTick, configHash,
                                          #   per-job lastRun/lastStatus/nextDue/failures/paused,
                                          #   plus read-only "runtime intervals" (connector
                                          #   drain timers, poll intervals) for completeness
mindstone schedule history [--job <id>] [--lines N] [--json]   # history.jsonl tail
mindstone schedule run <id> [--yes] [--force]  # manual trigger, same executor path, trigger:"manual";
                                          #   agent_turn/deliver jobs prompt for confirmation
                                          #   unless --yes (non-interactive refuses without it,
                                          #   the approvals-CLI convention); --force bypasses
                                          #   maxRunsPerDay (audited in the event metadata)
mindstone schedule enable <id> | disable <id>   # flips jobs[].enabled via writeMindStoneConfig;
                                          #   appends schedule_changed transcript event
mindstone schedule requeue <connectorId> <entryId> [--yes]     # §7.5 dead-letter requeue
```

`list`/`show`/`status`/`history` are pure reads of config + state files — they work with the Gateway stopped (the `readConnectorRuntimeStatus` cross-process pattern). `run` executes in-process under the §6.3 lock. `enable`/`disable` are the only config-mutating verbs, they reuse `writeMindStoneConfig` + `formatConfigChangeSummary` (`wizard/config.ts`), and they audit themselves: `schedule_changed` event with `{ jobId, change, decidedBy: process.env.USER ?? "cli" }` — the `decidedBy` convention the approvals CLI already uses.

### 8.2 Two drivers, one definition

The scheduler supports two execution drivers over the same config, state, locks, and occurrence keys — safe together by construction, because dueness derives from durable state under lock and an occurrence can only ever be recorded once:

1. **In-daemon loop (default).** The §6.2 tick inside the Gateway — right for installs where the Gateway runs as a service (`mindstone gateway install`).
2. **External timer / manual.** `mindstone schedule run <id>` is a complete, locked, audited execution path that evaluates dueness and exits. OS cron, launchd `StartInterval`, a systemd timer, or a human can drive it. This matters on personal machines where the daemon is often *not* running — the config remains the single definition and the transcript the single audit trail either way. (An optional `mindstone schedule install` — launchd plumbing mirroring `gateway install` — is a documented follow-on, not v1.)

### 8.3 Doctor and status

- **Doctor** (`packages/mindstone-core/src/doctor/doctor.ts`): a `scheduler.*` check group — section parses; per-job validation results (§5.4); `enabled` jobs present while `scheduler.enabled` is false (warn: "declared but dormant"); state file readable; paused/erroring jobs (warn with `lastError`); destructive maintenance scheduled with `dryRun: false` (warn, §7.4); `at` jobs with no `timezone` configured on a machine whose local zone differs from prior state (info); dead letters present anywhere (warn — doctor becomes the place dead letters are always seen, independent of `queue_drain`).
- **System status** (`getMindStoneSystemStatus`, `packages/mindstone-core/src/status/status.ts`): a `scheduler` block (enabled, tz, job count, next due job, paused count, lastTickAt, configHash) assembled from config + state file. Because the Gateway `/status` endpoint (`gateway/src/index.ts` ~line 1361) and `mindstone status` both render this function's output, both surfaces inherit scheduler visibility from one change.
- **TUI:** the existing `/status` panel picks the block up for free; a dedicated `/schedule` panel is a follow-on, not v1.

---

## 9. Transcript and audit events (AC2)

### 9.1 Session-key policy — decision

- **`agent_turn` jobs** write into their **target session** — default `agent:<agentId>:main` (the canonical shared continuity key, `ARCHITECTURE.md` §3.4), overridable per job via `sessionKey`. Rationale: a digest or follow-up review is *agent work product*; it belongs in continuity, recallable and visible in chat history, marked by `source.substrate: "scheduler"` so nothing about its origin is hidden.
- **Mechanical jobs** (`queue_drain`, `memory_maintenance`, `system_check`, `connector_pull` without a turn) write their events to a dedicated **scheduler audit session** — default `agent:<agentId>:scheduler` (`scheduler.auditSessionKey` to override). Rationale: a 5-minute `queue_drain` heartbeat in `agent:default:main` would pollute the working set the sliding-window selector feeds the model; a separate session keeps the audit in the *same canonical transcript store* (append-only, listable via `listTranscriptSessions`, indexable by memory backfill) without contaminating live context. This mirrors the store's existing multi-session design (per-connector sessions already exist under `session.mode: "per_surface"`).
- Noise floor: routine no-op runs (`queue_drain` with nothing pending, `system_check` with no findings) append **no transcript event** — they record to `history.jsonl` only. "Where appropriate" (the AC's own wording) is defined as: state-changing, finding-bearing, failing, or policy-relevant runs get transcript events; heartbeats get history lines.

### 9.2 Event vocabulary

All via `appendTranscriptEntry` with `role: "event"`, `source: { substrate: "scheduler", channel: "<jobId>", chatType: "internal" }`, and `metadata.event` as the discriminator — extending the established set (`workflow_*`, `approval_*`, `handoff_replayed`):

| event | when | metadata (beyond `jobId`, `kind`) |
|---|---|---|
| `job_started` | a due/manual run begins (per §9.1 noise floor, always for `agent_turn`; for mechanical jobs, only when work exists) | `trigger`, `occurrenceKey`, `scheduledFor`, `catchUp?`, `forced?` |
| `job_finished` | run completes | `durationMs`, `summary`, `proposals?` (ids), kind-specific counts |
| `job_failed` | executor threw / timed out | `error`, `reason?: "timeout"`, `consecutiveFailures` |
| `job_skipped` | due but not run | `reason: "overlap" \| "missed_while_down" \| "paused" \| "concurrency" \| "daily_cap"` |
| `job_paused` | auto-pause threshold hit (§6.5) | `lastError`, `consecutiveFailures` |
| `schedule_changed` | CLI enable/disable (§8.1) | `change`, `decidedBy` |
| `scheduler_config_changed` | scheduler-section hash changed on tick (§5.5) | `oldHash`, `newHash`, `jobsAdded`, `jobsRemoved`, `jobsModified` |
| `queue_requeued` | dead-letter requeue (§7.5) | `connectorId`, `entryId`, `decidedBy` |

Events a scheduled run causes *indirectly* keep their existing names and mechanics untouched: the turn itself appends `workflow_started/…`, prune/auto-compact events, and `approval_proposed`; approval decisions append `approval_decided` from the approvals CLI. A reviewer can reconstruct any scheduled action end-to-end from the transcript alone: `job_started` → turn entries (source-tagged `scheduler`) → `approval_proposed` → `approval_decided` → queue delivery — with `metadata.jobId`, `occurrenceKey`, and `runId` as the join keys.

---

## 10. Approval policy compliance (AC3) — the complete mutation inventory

The design's rule: **the scheduler adds triggers, never authority.** Every effect class a job can cause, and its gate:

| Effect | Path | Gate |
|---|---|---|
| Memory file write | scheduled turn emits `mindstone-memory-proposal` fence | `applyActionProposalDiscipline` ⇒ pending `memory_write` ProposedAction; human `approvals approve` applies with path sanitization (`sanitizeMemoryProposalPath`) — identical to chat-origin proposals |
| Calendar/task mutation | fence ⇒ `connector_mutation` | **always** approval-gated (no auto path exists); apply-time fail-closed validation at the connector |
| Outbound message (digest, reminder, notification) | `deliverOrPropose` (§7.2) | `resolveConnectorSendPolicy` per connector; `approval_required` ⇒ pending `connector_send`; job config may only tighten (`requireApproval: true`), never loosen; targets from config only, never model output |
| Delivery retry | `queue_drain` | delivers only entries already past their gate (enqueue happens post-approval or on auto-policy connectors); retry adds no new consent question |
| Dead-letter requeue | CLI verb | explicit human act, `--yes`/interactive confirm, audited |
| Vector-index maintenance | `memory_maintenance` | ungated by design — derived/rebuildable state only; **dry-run by default**, destructive opt-in doctor-warned (§7.4); hard boundary: no job kind writes memory files/journals/LOG/transcripts except via ProposedAction, asserted by smoke |
| Schedule config change | `enable`/`disable`/file edit | human act by definition; CLI path audited via `schedule_changed`; every edit path audited via the config-hash event (§5.5) |
| Scheduler runtime state / history | state.json, history.jsonl, transcript **events** | bookkeeping and audit records, not agent mutations; transcript events are append-only additions, consistent with the "must not rewrite the transcript" invariant (`README` / `ARCHITECTURE.md` §3.4) |

Prompt-injection posture carries over unchanged: digest/collect inputs include untrusted content (calendar event titles, email-derived memory), so scheduled-turn output is attacker-influencible — which is exactly why every consequential output class above terminates in a human gate (the email connector's threat note, `EMAIL_CONNECTOR.md` §6, applied to time-triggered turns), and why delivery targets are config-fixed rather than model-suppliable.

---

## 11. Validation plan

Per the repo's smoke discipline (non-live, mock providers, stub servers; live legs go to the UAT runbook):

**`npm run smoke:scheduler` (`scripts/smoke-scheduler.sh`) — proposed legs:**

1. **Evaluator unit matrix** (pure, injected clock): `every` grammar + dueness; `at` + `days` across day boundaries; timezone evaluation; occurrence-key single-fire across ticks and simulated restart; catch-up `skip` vs `once` (exactly one catch-up run after a simulated down window, correct occurrence key); **DST-adjacent cases with fixed fixture zones — the spring-forward gap resolves to the first valid instant, the fall-back repeated hour fires exactly once (occurrence-key dedup asserted)**; `maxRunsPerDay` boundary at the timezone's midnight.
2. **Runtime loop** (short `tickMs`, mock clock where possible): due job fires once; `overlap: "skip"` under an artificially long run; `maxConcurrentAgentTurns` defers a second `agent_turn`; `maxRunsPerDay` skip with `daily_cap` reason + `--force` bypass audited; timeout aborts (signal observed); consecutive-failure auto-pause after N injected failures + `job_paused` event + recovery via manual run; lock contention between the loop and a concurrent `schedule run` (one winner, one overlap-skip); stale-lock reclaim; **config-hash change mid-run ⇒ exactly one `scheduler_config_changed` event with correct job diffs**.
3. **Digest E2E over loopback** (the reference connector, `connectors/loopback.ts`): `agent_turn` job with `collect: transcript_tail` + `deliver: loopback`, mock routing mode ⇒ `job_started`/`job_finished` in the target session, reply delivered to the loopback outbox via the queue; then the same job with `deliver.requireApproval: true` ⇒ pending `connector_send` + `approval_proposed`, outbox untouched; approve ⇒ delivered. Assert the run appears in (and aborts via) `GatewayRunManager`.
4. **Approval-default connector**: deliver to a stub connector declaring `defaultSendPolicy: "approval_required"` ⇒ proposal, never a send — including on repeat runs. Assert the connector-reply path and the scheduler path produce byte-equivalent decisions through the shared `deliverOrPropose` helper (anti-drift regression).
5. **Scheduled-turn proposal discipline**: mock provider returns a reply containing memory + calendar fences ⇒ pending `memory_write` + `connector_mutation`, stripped reply, nothing written/applied; the §7.4 boundary check — after a full multi-job run, assert no file under `memoryDir`/`journalDir`/`LOG.md` changed and transcripts only *grew*.
6. **`memory_maintenance`**: seeded index, `dryRun` default ⇒ candidates REPORTED, nothing deleted; `dryRun: false` ⇒ stats show actual removals; `embed` leg only against the mock-embed provider path (the `smoke:embedding-memory` harness).
7. **`queue_drain`**: stub connector failing twice then succeeding ⇒ retried to delivery; failing persistently ⇒ dead-letter + `notifyDeadLetters` finding raised once (not re-raised while counts are flat); `requeue` verb flips it back with `queue_requeued` event.
8. **`connector_pull` agenda** against `scripts/stub-gcal-server.mjs` (the existing calendar stub): agenda event/delivery produced; provider error ⇒ degraded block/finding, job does not crash the loop.
9. **`system_check`**: aged pending approval + dead letter + connector error fixture ⇒ one consolidated finding; healthy fixture ⇒ history-only, no event.
10. **CLI/visibility**: `schedule list/show/status/history` sane with Gateway stopped; `enable`/`disable` rewrite config + `schedule_changed`; doctor matrix (invalid schedule ⇒ fail; dormant jobs ⇒ warn; paused job ⇒ warn; destructive maintenance enabled ⇒ warn); `/status` and `mindstone status` include the scheduler block; secret-leak sweep over state.json/history.jsonl/events (credentials never serialize into scheduler artifacts — executors receive refs-resolved context transiently, mirroring the connector credential rule); Gateway `/health` stays 200 with a deliberately broken job configured.

**Live UAT legs (runbook additions, operator-run):** morning digest over a real chat connector; calendar agenda pull live; an email-delivered digest landing as a pending approval and sending on approve. Not smoke-claimable per the no-live-LLM rule.

---

## 12. Risks and open questions

| Risk / question | Position |
|---|---|
| Laptop-class hosts sleep; the Gateway isn't running at 07:30 | `catchUp: "once"` fires the digest on wake/start; `job_skipped(missed_while_down)` otherwise. The second driver (§8.2) covers daemon-off installs. Documented as inherent to local-first — launchd install (`gateway install`) is the mitigation, not a scheduler redesign. |
| Scheduled turns consume model/token budget unattended | Disabled-by-default section; `maxConcurrentAgentTurns: 1`; per-job timeout; per-job `maxRunsPerDay`; doctor visibility of every enabled `agent_turn`. |
| Digest content pollutes auto-recall (its own output re-recalled daily) | Accepted for v1: entries are source-tagged (`substrate: "scheduler"`) and legitimately part of history. Tracked follow-up: if it proves noisy in practice, a recall-side source-filter (recall config) is the right fix, not transcript suppression. |
| Two Gateways / CLI-vs-Gateway double-fire | §6.3 lock files (PID+staleness reclaim) + occurrence-key dedup as the independent second layer. Multi-writer `dataDir` remains unsupported topology; the mechanisms degrade it to serialization. |
| `at` semantics around DST | Specified (§4.3) and fixture-tested (§11 leg 1): gap → first valid instant; repeated hour → once via occurrence key. |
| Config drift between tick reloads and a long-running job | A job runs with the config snapshot taken at its start; the next occurrence sees the new config. Same model as connector inbound handling. Config changes themselves are audited (§5.5). |
| `history.jsonl` growth | Size-triggered rotation, 2 generations (§6.6). |
| Should the scheduler absorb connector poll intervals (`pollIntervalMs` etc.)? | Out of scope; they are transport concerns owned by connectors. `schedule status` *lists* them (read-only) so the visibility AC covers all periodic behavior. Revisit if a unified-intervals requirement emerges. |
| Windows lock semantics | PID probe weaker; timeout staleness + occurrence keys are the backstop; Gateway service management is currently macOS-launchd-only anyway (`gateway install`). |
| Per-job `scope` (Agent Mesh) | Deferred; seam identified (§7.1 alternative). Companion mode is the v1 target. |

---

## 13. Implementation plan (phased, each phase independently smoke-able)

1. **Core semantics** — `scheduler/` module: types, evaluator (occurrence keys, DST rules), state store + history (with rotation), audit helpers, executor registry, `memory_maintenance` (dry-run default) + `system_check` executors; config section + `validateMindStoneConfig` rules. Smoke legs 1, 6, 9 (evaluator/state parts).
2. **Gateway runtime** — `scheduler-runtime.ts`: tick loop (config-hash tracking), locks, timeout/failure containment, the **`deliverOrPropose` extraction** from the connector-reply path, `agent_turn` (+ `collect`/`deliver`, RunManager registration), `queue_drain` executors; `startGateway` wiring. Smoke legs 2–5, 7.
3. **CLI + visibility** — `mindstone schedule` command (incl. `requeue`, `--force`), doctor checks, `getMindStoneSystemStatus` block (⇒ `/status` + `mindstone status`). Smoke leg 10.
4. **`connector_pull`** — calendar agenda mode over the existing provider + stub. Smoke leg 8.
5. **Docs + onboarding** — `docs/operations/SCHEDULER.md` (this design's operational half: config reference, event vocabulary, ergonomics notes), README status-section entry, `LIVE_UAT_RUNBOOK.md` legs, optional wizard section for enabling + seeding a starter digest job.

Each phase ends with the claim it can actually make — *implemented* on merge, *smoke-tested* when its legs are green, *live-validated* only after the runbook legs run. Nothing in this document holds any of those claims today.

---

## 14. Decision record

- **SDR-001:** The scheduler runs **in-process in the Gateway daemon** (with an external-driver escape hatch), reusing the always-on lifecycle and the `unref()` timer precedent — not OS cron as the primary mechanism, not a separate daemon (§3, §8.2).
- **SDR-002:** Jobs are **declared in config** (`scheduler.jobs`), making the schedule visible and diffable by construction; config *changes* are audited via the section hash event (AC1; §5, §5.5).
- **SDR-003:** Mutating jobs **reuse the existing approval mechanisms** — proposal discipline for agent turns, send policy via the shared `deliverOrPropose` helper for delivery, `connector_mutation` proposals for write-backs — and add **no new approval taxonomy** (AC3; §7, §10).
- **SDR-004:** Core owns pure schemas + schedule math + occurrence keys + persistence + the executor contract; the Gateway owns the tick and the executors that need providers/connectors — preserving the `core must not import gateway` dependency rule (§3).
- **SDR-005:** `every` + `at` ship first; cron strings are a follow-on, avoiding a new dependency or a hand-rolled parser on the critical path (§4.2).
- **SDR-006:** The existing per-connector drain timer is **augmented, not replaced**; `queue_drain` is the declared durability/visibility layer (§7.5).
- **SDR-007:** Destructive memory maintenance defaults to **dry-run** and requires explicit, doctor-surfaced opt-in — no silent unattended index rewrites (§7.4).
- **SDR-008:** Every firing is idempotent by **occurrence key**, uniformly across ticks, restarts, catch-up, both drivers, and DST edges (§4.3).
- **SDR-009:** Scheduled agent runs register with **`GatewayRunManager`** — visible and abortable exactly like interactive runs (§7.1).
- **SDR-010:** Delivery targets come **from config only, never from model output** (§7.2, §10).

---

## 15. Concrete change inventory

**New files (core):**
- `packages/mindstone-core/src/scheduler/{index,types,schedule,state,audit,executors,registry}.ts`

**New files (gateway):**
- `packages/mindstone-gateway/src/scheduler-runtime.ts`

**Edited files (core):**
- `packages/mindstone-core/src/index.ts` — add `export * from "./scheduler/index.js";`
- `packages/mindstone-core/src/config/types.ts` — add `scheduler?: MindStoneSchedulerConfigSection` + types
- `packages/mindstone-core/src/wizard/config.ts` — scheduler validation rules (§5.4)
- `packages/mindstone-core/src/doctor/doctor.ts` — `scheduler.*` check group (§8.3)
- `packages/mindstone-core/src/status/status.ts` — scheduler block in `getMindStoneSystemStatus`

**Edited files (gateway):**
- `packages/mindstone-gateway/src/index.ts` — start/stop the scheduler in `startGateway`/`close`; **extract `deliverOrPropose` from the connector-reply send-policy fork** (~lines 1961–1999) and re-point that path at the helper (behavior-preserving refactor, regression-asserted in smoke leg 4)

**Edited files (CLI):**
- `packages/mindstone-cli/src/index.ts` — register `schedule` in dispatch (~line 125) + `runScheduleCommand`

**New data (runtime):**
- `<dataDir>/scheduler/{state.json, history.jsonl, locks/}` (machine-written; the schedule itself stays in config)

**Docs:**
- `docs/operations/SCHEDULER.md` — mirror the `WORKFLOWS.md` format (config reference, job kinds, schedule spec, transcript events, claim status)

**Package scripts:**
- `smoke:scheduler` added to root `package.json`, included in the aggregate smoke run.

---

*Design deliverable for #29. All mechanisms above are proposed; the cited files are real and current; the scheduler that binds them is unbuilt.*
