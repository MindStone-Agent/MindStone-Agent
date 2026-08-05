# MindStone-Agent MVP Exit Checklist

**Status:** Working checklist  
**Date:** 2026-06-30  
**Purpose:** Define the minimum proof needed to call MindStone-Agent MVP rather than only MVP-shaped.

## MVP principle

MindStone-Agent MVP is not complete because the architecture exists. It is complete when a fresh user path proves:

```text
install/onboard
→ configure isolated model/auth
→ chat through canonical session
→ preserve transcript continuity
→ use identity + memory/recall
→ route through live Pi AgentSession
→ validate compaction boundary or explicitly defer it
→ expose Gateway/API surfaces honestly
```

The key claim boundary:

```text
MVP-shaped = scaffold exists and non-live smoke tests pass.
MVP-proven = live isolated Pi prompt/stream path passes and public docs/status reflect the actual state.
```

## Current MVP stance

Implemented and smoke-tested non-live:

- isolated runtime layout;
- package-bin `mindstone` CLI;
- onboarding/config/auth scaffolds;
- native `mindstone chat`;
- styled `mindstone tui` with transcript history and status panels;
- Gateway management via `mindstone gateway ...`;
- REST/RPC/WebSocket/OpenAI/OpenResponses-compatible route surfaces;
- canonical session key `agent:default:main`;
- append-only transcript store;
- file/SQLite memory substrate and recall/maintenance commands;
- `pi-session` runner scaffold using Pi `AgentSession` / `SessionManager`;
- reset/onboarding/TUI identity-formation UX smokes;
- non-live smoke suite.

Remaining MVP proof gates are below.

---

## Gate 0 — Scope freeze

### Required

- [x] Park sensitive context routing as post-MVP design unless it directly blocks MVP safety.
- [x] Do not add Agent Packs, channels, entitlement, or advanced sensitive-routing implementation to MVP scope.
- [x] Treat Synapse/Aegis/Lux operational drift as out of scope for MindStone-Agent MVP; Cairn/Hearth own that track.

### Current parked artifact

```text
docs/refactor/SENSITIVE_CONTEXT_ROUTING.md
```

This may be committed as design/backlog, but implementation should not block MVP.

---

## Gate 1 — Repository hygiene and baseline build

### Commands

```bash
cd /Users/clint/Projects/MindStone-Agent
git status --short
npm install
npm run build:mindstone
```

### Pass criteria

- [x] Build succeeds.
- [x] Dirty working tree is understood and intentionally scoped.
- [x] No generated/runtime/private state is staged.
- [x] Sensitive-routing docs, if present, are either committed as design or left explicitly uncommitted.

### Notes

Current known local design changes:

```text
docs/refactor/SENSITIVE_CONTEXT_ROUTING.md
docs/refactor/DESIGN.md
docs/refactor/IMPLEMENTATION_PLAN.md
```

---

## Gate 2 — Non-live MVP smoke suite

### Required onboarding/reset/identity UX smokes

```bash
npm run smoke:reset
npm run smoke:onboard
npm run smoke:onboard-custom-ux
npm run smoke:identity-activation
npm run smoke:identity-context
npm run smoke:identity-formation
```

### Pass criteria addendum

- [x] `mindstone reset` requires typed destructive confirmation and can preserve isolated Pi auth/models.
- [x] Fresh onboarding can start from reset runtime.
- [x] First real chat turn begins identity formation and asks about the human, not only the agent/name/task.
- [x] Default TUI view does not show low-level runner/Pi event spam; diagnostic events remain available under `/events`.


### Required core/native smokes

```bash
npm run smoke:core-boundary
npm run smoke:mvp-native
npm run smoke:cli-bin
npm run smoke:install-script
npm run smoke:doctor
npm run smoke:gateway-cli
npm run smoke:unified-session
npm run smoke:transcripts
npm run smoke:context-window
npm run smoke:sliding-window
npm run smoke:auto-recall
npm run smoke:cli-chat
npm run smoke:cli-chat-recall
npm run smoke:tui
```

### Required Gateway/API smokes

```bash
npm run smoke:gateway-http-surfaces
npm run smoke:openai
npm run smoke:rpc
npm run smoke:ws-rpc
npm run smoke:webchat-ui
npm run smoke:router-mock
npm run smoke:gateway-runner-stream
```

### Required memory smokes

```bash
npm run smoke:file-memory
npm run smoke:memory-backfill
npm run smoke:memory-maintenance
npm run smoke:embedding-memory
npm run smoke:scri-recall
```

### Required Pi-adapter/pi-session non-live smokes

```bash
npm run smoke:pi-adapter
npm run smoke:pi-provider-config
npm run smoke:pi-session-runner
npm run smoke:agent-runner-stream
npm run smoke:pi-config-sections
```

### Pass criteria

- [x] All required non-live smokes pass.
- [x] Any skipped smoke is documented with reason and does not invalidate MVP claims.
- [x] No smoke mutates global Pi auth/config/session state.

---

## Gate 3 — Isolated provider/auth setup and model coverage

### Required

The live Pi-session probe must use isolated auth/config only. It must not use:

```text
~/.pi/agent/auth.json
```

Expected isolated auth target:

```text
/Users/clint/Projects/MindStone-Agent/.runtime/pi-agent/auth.json
```

Expected model registry/config target:

```text
/Users/clint/Projects/MindStone-Agent/.runtime/pi-agent/models.json
```

### Commands

If auth is not configured:

```bash
./scripts/mindstone auth login openai-codex
```

Then inspect status without exposing secrets:

```bash
./scripts/mindstone status
./scripts/mindstone doctor
```

### Model coverage required for MVP

MindStone-Agent must support and validate model onboarding for more than cloud subscription/API providers.

Required model lanes:

1. Cloud/subscription provider through isolated Pi auth, e.g. ChatGPT Plus/Pro Codex.
2. Local model endpoint, e.g. Ollama or LM Studio/OpenAI-compatible local server.
3. Ollama Cloud as an explicit selectable/setup path, not only as a hidden manual model-id entry.

### Pass criteria

- [ ] Isolated `auth.json` exists for auth-backed providers when applicable.
- [x] Isolated `models.json` exists or live probe reports the exact missing prerequisite.
- [x] `mindstone status`/`doctor` show sanitized auth/model status.
- [x] No global Pi auth path is used.
- [x] Onboarding exposes a clear local-model path.
- [x] Onboarding exposes a clear Ollama Cloud path.
- [x] At least one local or OpenAI-compatible model route is smoke-tested from fresh runtime, or a documented environmental prerequisite blocks it.
- [x] Ollama Cloud route is smoke-tested or explicitly marked pending with setup instructions before MVP can be called final.

---

## Gate 4 — Memory, vectorization, recall, and sliding-window validation

These are MVP requirements, not optional polish. MindStone-Agent must prove continuity mechanics, not merely chat routing.

### Commands

```bash
npm run smoke:file-memory
npm run smoke:memory-backfill
npm run smoke:memory-maintenance
npm run smoke:embedding-memory
npm run smoke:auto-recall
npm run smoke:cli-chat-recall
npm run smoke:scri-recall
npm run smoke:sliding-window
npm run smoke:context-window
```

### What this validates

- Structured memory files can be discovered and indexed.
- SQLite memory index can be backfilled and maintained.
- Embedding-backed vectorization works against an OpenAI-compatible embedding endpoint.
- Auto Recall injects relevant memory into prompt context.
- CLI chat recall reaches the chat path.
- SCRI/ranking/dedup behavior works at smoke level.
- Sliding-window context management prunes live prompt context while preserving append-only transcript history.

### Pass criteria

- [x] Vectorization smoke passes with embedded chunks > 0.
- [x] Recall smoke records `memory_recall_injected` and includes expected hit metadata.
- [x] CLI chat recall smoke proves recalled memory reaches a chat turn.
- [x] Sliding-window smoke records `context_window_pruned`.
- [x] Transcript still contains pruned source entries after sliding-window pruning.
- [x] README/TASK_STATUS distinguish vectorization/recall/sliding-window smoke-tested from any unvalidated production/local-model combinations.

---

## Gate 5 — Live Pi-session prompt/stream validation

This is the primary MVP proof gate.

### Command

Use the model Clint intentionally wants validated. Example:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

If the currently configured model differs, substitute it explicitly:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='<provider/model>' \
  npm run smoke:pi-session-live
```

### What the probe validates

- Uses isolated `PI_CODING_AGENT_DIR`.
- Refuses global `~/.pi/agent` auth.
- Creates a temporary MindStone runtime.
- Configures routing mode `pi-session`.
- Calls native `mindstone chat --once ... --json`.
- Verifies runner id is `pi-session`.
- Verifies assistant text is non-empty.
- Verifies runner stream events and persisted event count.

### Pass criteria

- [ ] Probe does not skip due to missing isolated auth/model files.
- [ ] Probe exits zero after actual live model call.
- [ ] JSON result includes `ok: true`.
- [ ] Runner id is `pi-session`.
- [ ] Assistant text is present.
- [ ] `runnerStream.eventCount >= 3`.
- [ ] `runnerStream.persistedEventCount >= 3`.
- [ ] No raw Pi message/tool args/results are persisted outside the sanitized allowlist.

### Claim discipline

Until this gate passes, public language remains:

```text
MindStone-Agent is MVP-shaped; live Pi-session execution remains pending validation.
```

After this gate passes, public language may say:

```text
MindStone-Agent has passed live isolated Pi-session prompt/stream validation.
```

---

## Gate 6 — Live Pi-session compaction validation

This is highly desirable for MVP. If it does not pass by MVP cut, the deferral must be explicit.

### Command

Run only after Gate 5 passes:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_COMPACT=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

### What the probe validates

- Reuses the temporary live session created by the probe.
- Calls `PiSessionAgentRunner.compact(...)`.
- Expects `available: true`.
- Expects `requested: true`.
- Expects reason `pi_agent_session_compact_completed`.

### Pass criteria

- [ ] Live compaction probe exits zero.
- [ ] Result reports `available: true`.
- [ ] Result reports `requested: true`.
- [ ] Result reason is `pi_agent_session_compact_completed`.

### If deferred

If compaction cannot pass before MVP, document clearly:

```text
Live prompt/stream path is MVP-proven. Live Pi compaction invocation remains post-MVP validation; sliding-window context management remains the primary MindStone-Agent continuity mode, and auto-compaction is a fallback path.
```

---

## Gate 7 — OpenWebUI / OpenAI-compatible surface validation

### Commands

Local Gateway smoke already exists:

```bash
npm run smoke:openai
npm run smoke:gateway-http-surfaces
```

Manual/live OpenWebUI validation should prove:

- OpenWebUI can target MindStone-Agent Gateway.
- Models endpoint is reachable under configured auth.
- Chat completions endpoint produces a response through the configured route.
- Transcript source metadata records the OpenAI-compatible surface.
- Canonical session behavior is understood.

### Pass criteria

- [ ] OpenWebUI can connect to Gateway.
- [ ] A test message returns through the configured route.
- [ ] Transcript records the turn with source metadata.
- [ ] Docs reflect any known limitations.

### If deferred

OpenWebUI can be post-MVP if CLI/TUI/Gateway REST/API surfaces are otherwise proven, but public docs must say OpenWebUI validation is pending.

---

## Gate 8 — Fresh install/onboarding path

### Commands

Use an isolated temporary location if possible:

```bash
npm install
npm run build:mindstone
npm run smoke:install-script
npm run smoke:cli-bin
npm run smoke:reset
npm run smoke:onboard
npm run smoke:onboard-custom-ux
npm run smoke:onboard-model-setup
npm run smoke:auth-login
npm run smoke:mvp-native
```

### Pass criteria

- [x] Install path succeeds.
- [x] CLI link/bin path works.
- [x] Onboarding creates identity/user scaffolds.
- [x] Onboarding activates a first working identity or explicitly guides the first-activation path.
- [x] First TUI/chat turn begins identity formation.
- [x] Routing setup avoids placeholder dead-end.
- [x] Auth login path uses isolated runtime auth.
- [x] `mindstone chat` and `mindstone tui` can start from fresh runtime path.

---

## Gate 9 — Public README/docs claim pass

### Files to review

```text
README.md
TASK_STATUS.md
docs/gateway/API_REFERENCE.md
docs/gateway/OPENWEBUI.md
docs/operations/ISOLATION.md
docs/refactor/PI_SESSION_PARITY.md
docs/refactor/IMPLEMENTATION_PLAN.md
```

### Required language updates after validation

If Gate 5 passes:

- [ ] Update README current status from live validation pending to live prompt/stream validated.
- [ ] Record command and model used.
- [ ] Keep compaction pending if Gate 6 does not pass.

If Gate 6 passes:

- [ ] Update README/PI_SESSION_PARITY to say live compaction validation passed.
- [ ] Record command and model used.

If OpenWebUI is not validated:

- [ ] Keep OpenWebUI docs as setup/validation-prep, not proven support.

### Pass criteria

- [x] No overclaims.
- [x] Public docs distinguish implemented, smoke-tested, live-validated, and pending.
- [x] MVP install/use path is clear.

---

## Gate 10 — Release readiness

### Required

- [x] `npm run build:mindstone` passes.
- [x] Required smoke suite passes or documented deferrals exist.
- [x] README is current.
- [x] TASK_STATUS is current.
- [x] No private runtime/auth/session/vector files staged.
- [x] Git status is clean except intentionally untracked local artifacts.
- [ ] Tag/commit decision made by Clint.

### Optional but useful

```bash
npm run smoke:docker
```

Docker can be post-MVP if native install/CLI/TUI/Gateway is the chosen MVP path, but Agent Packs later require Docker hardening.

---

## MVP cut recommendation

### Must pass before MVP label

1. Gate 1 — baseline build.
2. Gate 2 — non-live smoke suite, including reset/onboarding/identity UX.
3. Gate 3 — isolated auth/model setup plus local/Ollama Cloud coverage.
4. Gate 4 — vectorization, recall, and sliding-window validation.
5. Gate 5 — live Pi-session prompt/stream validation.
6. Gate 8 — fresh install/onboarding path.
7. Gate 9 — docs claim pass.
8. Gate 10 — release hygiene.

### Should pass if feasible

1. Gate 6 — live Pi-session compaction validation.
2. Gate 7 — OpenWebUI validation.
3. Docker smoke.

### Explicitly post-MVP

- Sensitive context routing implementation.
- Agent Packs packaging/entitlement.
- Telegram/Discord/Slack/Signal listeners.
- Full raw Pi transcript archive parity.
- Native sqlite-vec ANN packaging if local environment remains blocked.
- Richer TUI selector/settings overlays.
- Synapse/Aegis/Lux operational cleanup.

## Validation log

### 2026-06-30 — initial non-live MVP slice

Passed:

```bash
npm run build:mindstone
npm run smoke:mvp-native
npm run smoke:pi-session-runner
npm run smoke:agent-runner-stream
npm run smoke:gateway-runner-stream
npm run smoke:unified-session
```

Observed notes:

- `smoke:mvp-native` passed fresh isolated runtime → package-bin chat setup → mock response → TUI transcript continuity.
- `smoke:pi-session-runner` passed with the expected unavailable-model/auth result in isolated runtime; this is non-live and does not prove authenticated model execution.
- `smoke:agent-runner-stream` passed provider-route/pi-session stream contract checks.
- `smoke:gateway-runner-stream` passed mock Gateway runner stream transcript persistence.
- `smoke:unified-session` passed canonical transcript/session convergence, including expected placeholder/not-implemented events for unconfigured route surfaces.

### 2026-07-01 — Fable/Cairn marathon: full non-live suite + fresh E2E + model-lane coverage

Tree @ `ad90f76d` (local main). Evidence receipts on issues #2–#6 and #10; QA (Slate) confirmed #2/#3/#10.

**Gate status:** 0 ✅ · 1 ✅ · 2 ✅ (49/49 — every `smoke:*` except `smoke:docker` [needs Docker daemon] and `smoke:pi-session-live` [live-gated]) · 3 ✅ (local + Ollama Cloud lanes shipped, issue #3; **Ollama Cloud lane live-validated 2026-08-05** via a key in `models.json`, so the lane no longer depends on `auth.json`) · 4 ✅ (embedding proof uses mock embed model over the real provider-HTTP + SQLite path; vector backend js-cosine) · **5 ✅ 2026-08-05** (live prompt/stream, issue #7 — `smoke:pi-session-live` exit 0, 25 stream events / 24 persisted, against `ollama-cloud/deepseek-v4-pro:cloud`) · **6 ✅ 2026-08-05** (live compaction, issue #8 — real `AgentSession.compact()` summary, `tokensBefore: 2243`; 4-entry probe, so mechanism proven not summary quality at length) · 7 deferred (OpenWebUI stays setup-prep) · 8 ✅ (pty E2E: reset typed-confirmation, complete onboarding from scratch, in-flow identity activation proven on disk, TUI turn + `/quit` clean exit; human-keyboard spot-check residual) · 9 ✅ (this claim pass) · 10 ✅ except tag/commit decision (Clint).

**Standing claim:**

```text
MindStone-Agent is MVP-shaped and smoke-proven end-to-end (49/49 non-live suite,
pty-verified fresh E2E, live-validated local/OpenAI-compatible model route against
a live local endpoint). MVP-proven awaits live authenticated Pi-session
prompt/stream (+ compaction) validation — deferred to Clint with documented steps.
```

## Immediate next command sequence

Recommended next run:

```bash
cd /Users/clint/Projects/MindStone-Agent
npm run build:mindstone
npm run smoke:reset
npm run smoke:onboard
npm run smoke:onboard-custom-ux
npm run smoke:identity-formation
npm run smoke:mvp-native
npm run smoke:embedding-memory
npm run smoke:auto-recall
npm run smoke:cli-chat-recall
npm run smoke:sliding-window
npm run smoke:pi-session-runner
npm run smoke:agent-runner-stream
npm run smoke:gateway-runner-stream
npm run smoke:unified-session
```

Then complete model coverage:

```text
1. Fresh repo install/onboard from reset runtime.
2. Cloud/subscription model live Pi-session probe.
3. Local model route validation.
4. Ollama Cloud route validation.
```

Then, once isolated auth/model are confirmed:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```
