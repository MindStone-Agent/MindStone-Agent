# Pi Session Runner Parity Review

**Date:** 2026-06-18  
**Status:** Active MVP parity checklist  
**Reference implementation:** `/Users/clint/Projects/MindStone/src/agents/pi-embedded-runner/run/attempt.ts`, `/Users/clint/Projects/MindStone/src/agents/pi-embedded-subscribe.ts`

## Purpose

MindStone-Agent's real Pi-backed route should preserve Pi harness behavior through `AgentSession` / `SessionManager`, not collapse Pi into a raw provider completion API. This document tracks parity against current MindStone's embedded Pi runner so gaps stay explicit.

## Current MindStone-Agent shape

```text
MindStone route/context assembly
→ AgentRunner
→ PiSessionAgentRunner
→ PiSessionExecutor
→ Pi SessionManager.open(...)
→ createAgentSession(...)
→ AgentSession.prompt(...)
→ AgentRunner.stream(...) events
→ MindStone transcript/source metadata
```

Implemented now:

- deterministic MindStone session-key → Pi session-file mapping
- isolated Pi auth/model registry loading from project runtime, not global Pi state
- `DefaultResourceLoader.appendSystemPrompt` for MindStone system context
- config-backed Pi `DefaultResourceLoader` resource options: additional extension/skill/prompt/theme paths plus disable flags
- smallest MindStone-owned inline extension-factory parity: a Pi `context` hook derived from MindStone `sliding_window` policy that prunes only live Pi LLM context while preserving MindStone transcript authority
- session-local Pi native compaction settings derived from `routing.pi.compaction`, with a 20k reserve-token floor, applied before prompt/compact without relying on global Pi state
- process-local per-session-file serialization around pi-session prompt and compaction operations
- `AgentSession.prompt(...)` path when isolated auth/model config is available
- bounded sanitized Pi session diagnostics
- explicit runner `route_planned` stream events before provider/substrate execution
- live Pi diagnostic callback streaming as runner `substrate_event`
- live Pi assistant `text_delta` forwarding
- completed-response text replay suppression after live text capture
- abort signal propagation to `session.abort?.()`
- optional `AgentRunner.compact(...)` boundary
- runner-routed `pi-session` auto-compact after emergency handoff
- gated live probe:
  ```bash
  npm run smoke:pi-session-live
  MINDSTONE_PI_SESSION_LIVE=1 npm run smoke:pi-session-live
  MINDSTONE_PI_SESSION_LIVE=1 MINDSTONE_PI_SESSION_LIVE_COMPACT=1 npm run smoke:pi-session-live
  ```

## Reference behavior in current MindStone

Current MindStone embedded runner includes production-grade behavior that should be selectively rebuilt, not copied wholesale:

- workspace/sandbox resolution
- session write lock and session-file repair
- session resume capping before live context build
- guarded `SessionManager` with tool-result provenance rules
- `prepareSessionManagerForRun(...)` lifecycle setup
- config-driven Pi compaction settings
- embedded extension factories for context pruning/compaction safeguards
- MindStone coding tools and client tool adapters
- channel-aware message/reaction/tool hints
- skill prompt/environment overrides
- rich system prompt construction and reporting
- explicit system-prompt override application
- stream function selection/wrapping for provider quirks
- thinking-block and provider transcript sanitization
- tool-result context guard
- before-prompt and llm-input hooks
- image injection for vision-capable models
- rich subscription handling for assistant chunks, reasoning, tools, usage, compaction retry, messaging-tool duplicate suppression, partial/block replies, and final text reconciliation
- active-run queue/abort handles
- timeout and compaction-timeout handling

## MVP parity tiers

### Tier 0 — already implemented

- session-backed Pi execution path
- isolated runtime/auth boundary
- system-context injection via Pi resource loader
- sanitized event diagnostics
- live runner event/text stream plumbing
- abort propagation
- optional runner compaction API
- gated live validation probe

### Tier 1 — MVP-critical next gaps

1. **Live authenticated validation**
   - Run `smoke:pi-session-live` with intentionally configured isolated auth/model.
   - Confirm `AgentSession.prompt(...)` succeeds through `PiSessionAgentRunner`.
   - Confirm `runnerStream.eventCount` / `persistedEventCount` prove `AgentRunner.stream(...)` path.
   - Confirm no global Pi auth is used.

2. **Durable transcript/source metadata parity**
   - Current stream event persistence can store runner events, but durable metadata policy needs review.
   - Decide which Pi events are durable transcript facts versus ephemeral UI diagnostics.
   - Keep raw tool args/secrets out; preserve names/ids/arg keys/counts only.

3. **Resource loader / extension parity**
   - Config-backed Pi resource loader path/disable options now pass through CLI, TUI, Gateway, `PiSessionMindStoneProvider`, and real `PiSessionAgentRunner` construction.
   - A smallest compatible context-pruning inline factory now exists for `contextManagement.mode = "sliding_window"` and is suppressed when Pi extensions are disabled.
   - Native Pi compaction settings now get session-local overrides and a reserve-token floor from `routing.pi.compaction`.
   - Remaining extension-factory gap: full staged compaction-safeguard summary parity, if needed, should still be ported incrementally rather than by copying the whole runner.

4. **Tool behavior boundary**
   - Decide MVP tool set for MindStone-Agent pi-session execution.
   - Current MindStone has rich coding/channel tools; MindStone-Agent currently relies on Pi defaults plus MindStone transcript/routing.
   - Avoid importing channel-specific tools until channel surfaces are in scope.

5. **Compaction validation**
   - `AgentRunner.compact(...)` is wired, but successful `AgentSession.compact(...)` requires isolated auth/model.
   - `smoke:pi-session-live` has a second opt-in compaction branch guarded by `MINDSTONE_PI_SESSION_LIVE_COMPACT=1`.
   - Validate only after live prompt/stream validation succeeds.

### Tier 2 — important but not absolute MVP blockers

- cross-process/session-file repair locking beyond the current process-local pi-session file lock
- resume cap / session-store indirection
- provider-specific stream function wrappers
- thinking-block sanitization policies
- hook runner parity
- image injection
- rich usage accounting
- active-run queue/steer behavior
- timeout/compaction-timeout attribution
- sandbox and skill environment parity

## Decisions preserved

- Do not use global Pi state for MindStone-Agent validation.
- Do not claim live Pi model success until `smoke:pi-session-live` succeeds with isolated auth/model.
- Keep `PiSessionMindStoneProvider` as compatibility wrapper; real behavior belongs in `PiSessionAgentRunner` / `PiSessionExecutor`.
- Keep transcript JSONL authoritative and append-only.
- Keep Pi diagnostics sanitized.
- Port parity incrementally by MVP need, not by bulk-copying current MindStone's mature embedded runner.

## Recommended next implementation order

1. Run gated live prompt/stream validation when Clint intentionally provides isolated auth/model.
2. Add durable event metadata policy/tests for Pi stream events.
3. Decide whether full staged compaction-safeguard summary parity is needed before MVP; minimal native compaction setting parity is already implemented.
4. Validate `AgentSession.compact(...)` under isolated auth/model with `MINDSTONE_PI_SESSION_LIVE=1 MINDSTONE_PI_SESSION_LIVE_COMPACT=1 npm run smoke:pi-session-live`.
5. Revisit session lock/repair/resume-cap once live basic execution is proven.
