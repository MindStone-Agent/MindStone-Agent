# Implementation Plan: MindStone Core Rebuild on Current Pi

**Project:** MindStone
**Date:** 2026-06-16
**Status:** Draft for review
**Related PRD:** `PRD.md`
**Related design:** `DESIGN.md`
**Related architecture:** `ARCHITECTURE.md`
**Related pack planning:** `AGENT_PACKS.md`
**Related sensitive-routing design:** `SENSITIVE_CONTEXT_ROUTING.md`
**Related app-engine/runtime modes design:** `APP_ENGINE_RUNTIME_MODES.md`
**Related MVP exit checklist:** `MVP_EXIT_CHECKLIST.md`
**Related execution runbook:** `FABLE_5_MARATHON_RUNBOOK.md`
**Related Fable product wishlist:** `FABLE_5_PRODUCT_WISHLIST.md`
**Related Cairn/Fable handover:** `CAIRN_FABLE_HANDOVER.md`

## 1. Implementation Strategy

Implement the rebuild incrementally. Do not attempt a single large forward-port. The goal is to extract stable MindStone semantics into Core, keep the Gateway as the always-on runtime, and add current-Pi support as a clean adapter.

The preferred order is:

1. Approve architecture and contracts.
2. Extract Core contracts.
3. Build Pi adapter MVP and session-backed Pi runner.
4. Stabilize Gateway API surfaces.
5. Restore memory/SCRI/dream-cycle behavior.
6. Port channels incrementally.
7. Validate OpenWebUI and package release flows.
8. Add Agent Packs as a post-MVP productized packaging layer: Dockerized role agents with pack manifests, WebChat/Gateway defaults, persistence, update paths, and optional commercial entitlement controls.

## 2. Phase 0 — Review and Cut Line

### Tasks

- [ ] Review `docs/planning/prds/PRD.md` with Clint.
- [ ] Review `docs/design/DESIGN.md` with Clint.
- [ ] Review `docs/design/ARCHITECTURE.md` with Cairn when available.
- [ ] Get Hearth review on daemon/service/secrets implications.
- [ ] Decide whether Core starts as `src/core/*` or `packages/core/*`.
- [x] Decide whether Gateway continues to own agent execution for MVP or delegates through an `AgentRunner` interface immediately.
  - Decision: Gateway/native CLI should route model turns through a MindStone `AgentRunner` abstraction; the real Pi-backed runner must use Pi `AgentSession` / `SessionManager`, not only provider-level completions.

### Exit criteria

- [ ] Core + Gateway + adapter architecture accepted or explicitly revised.
- [ ] MVP scope accepted.
- [ ] First implementation PR boundaries defined.

## 3. Phase 1 — Core Contracts Skeleton

### Tasks

- [ ] Create Core module boundary.
- [ ] Move or copy channel plugin type contracts into Core.
- [ ] Define `MindStonePrompter` interface.
- [ ] Define transcript/session interfaces.
- [ ] Define memory source/vector/SCRI interfaces.
  - [x] First-pass memory document/chunk/recall provider interfaces exist.
- [x] Define context-management policy config for selectable `auto_compact` vs `sliding_window` modes.
- [x] Define runtime context-window pruning contracts and tests.
- [ ] Define config service interface and migration boundary.
- [ ] Define first-pass sensitive context routing contracts: source labels, route clearance, taint metadata, declassification artifact shape, and fail-closed policy decisions. See `SENSITIVE_CONTEXT_ROUTING.md`.
- [x] Add dependency direction smoke check: `npm run smoke:core-boundary` builds `packages/mindstone-core` alone and fails if Core imports Gateway/CLI/Pi adapter or Pi-specific packages directly.
- [ ] Add unit tests for pure Core helpers.

### Candidate files to inspect/extract

- `src/channels/plugins/types.plugin.ts`
- `src/channels/plugins/types*.ts`
- `src/plugin-sdk/index.ts`
- `src/wizard/prompts.ts`
- `src/config/*`
- `src/config/sessions/*`
- `src/memory/*`

### Exit criteria

- [x] Core compiles independently of Pi adapter via `npm run smoke:core-boundary`.
- [ ] Core contracts are documented.
- [ ] Existing code can still run through compatibility exports.

## 4. Phase 2 — Wizard / Onboarding Adapter

### Tasks

- [x] Extract wizard logic to use Core `MindStonePrompter` only.
- [ ] Implement Pi prompter adapter using current Pi `ctx.ui` APIs.
- [x] Add native CLI command for setup/onboarding.
- [x] Add native CLI command for section reconfiguration.
- [x] Add command for setup/onboarding in Pi adapter: `/mindstone-setup` runs the shared config wizard.
- [x] Add command for section reconfiguration in Pi adapter: `/mindstone-config` runs the shared config wizard.
- [x] Add default onboarding profiles with write-in option.
- [x] Add `Integration Builder` as an initial onboarding profile.
- [x] Add reusable `Integration Builder` skill behavior.
  - Core exposes a deterministic Integration Builder brief/workflow generator for APIs, webhooks, channels, tools, and automations.
  - CLI surface: `mindstone skill list` and `mindstone skill integration-builder [--name NAME] [--kind KIND] [--goal TEXT] [--json|--emit-skill-md]`.
  - `--emit-skill-md` emits an Agent-Skills-compatible `SKILL.md` body for future Pi skill packaging/loading.
  - Smoke validation: `npm run smoke:integration-builder-skill`.
- [x] Add initial “getting to know the user” onboarding phase for preferences, boundaries, style, memory/checkpoint style, and project/domain context.
- [ ] Expand preference onboarding with richer collaboration-pattern and clarifying-question tuning.
- [x] Add initial naming/identity emergence phase without forcing human-assigned names.
- [x] Expand identity emergence into a real first-activation synthesis step.
  - `mindstone identity activate [--agent ID] [--dry-run] [--force] [--yes] [--json]` derives a first-activation working identity from onboarding profile/preferences/identity seed.
  - It backs up pending scaffolds and refuses to overwrite a non-pending identity unless `--force` is used.
  - Smoke validation: `npm run smoke:identity-activation`.
- [ ] Preserve channel onboarding adapters for Telegram, Signal, Discord, Slack.
- [x] Add fake prompter smoke tests for wizard sections.
- [x] Ensure sensitive provider API-key entry avoids echo/logging.

### Candidate files

- `src/wizard/onboarding.ts`
- `src/commands/configure.memory.ts`
- `src/commands/onboard-channels.ts`
- `src/channels/plugins/onboarding/*`

### Exit criteria

- [x] Wizard runs through at least identity + memory + gateway sections in Pi adapter automation.
  - `/mindstone-config gateway --dry-run`, `/mindstone-config memory --dry-run`, `/mindstone-config identity --dry-run`, and `/mindstone-config channels --dry-run` are smoke-validated through the Pi adapter UI shim.
  - `/mindstone-setup --sections gateway,memory,identity,channels --dry-run` is also smoke-validated.
  - Config remains byte-identical under dry-run.
  - Smoke validation: `npm run smoke:pi-config-sections`.
  - Manual/live Pi UI validation remains a separate pending validation item.
- [x] Native CLI onboarding/config can run core setup and section reconfiguration.
- [x] Onboarding can select a profile/write-in purpose, gather interaction preferences, and create identity/user scaffolds from that seed.
  - [x] Profile/write-in selection seeds config and identity/user scaffolds.
  - [x] Interaction preference gathering seeds config and identity/user scaffolds.
- [x] Channel setup section lists available plugins.
  - Core now exposes a shared channel/surface catalog for local surfaces, Gateway APIs, external clients, and planned external channel plugins.
  - Config wizard has a non-mutating `channels` section that lists the catalog and honest implementation/validation state.
  - CLI surface: `mindstone channels [--json]`.
  - Pi adapter `/mindstone-channels` uses the same Core catalog.
  - Smoke validation: `npm run smoke:channel-catalog` and `npm run smoke:pi-adapter`.
- [x] Reconfiguration can run by section.
  - CLI supports `mindstone config --section NAME`, repeated `--section`, and comma-separated `--sections a,b`.
  - Pi adapter `/mindstone-config` and `/mindstone-setup` also accept `<section>`, `--section`, `--sections`, and `--dry-run` arguments.
  - `--dry-run` runs a section without writing, useful for diagnostic sections such as `channels`.
  - Invalid section names fail clearly.
  - Smoke validation: `npm run smoke:config-sections` and `npm run smoke:pi-adapter`.

## 5. Phase 3 — Current-Pi Adapter and Session-Backed Runner MVP

### Tasks

- [x] Create current-Pi adapter extension/module.
- [x] Register MindStone commands for setup/status/context/gateway/channels/transcript/recall.
- [x] Register read-only memory read/search/status tools:
  - `mindstone_memory_status`
  - `mindstone_memory_search`
  - `mindstone_memory_read`
  - `mindstone_transcript_status`
  - `mindstone_memory_read` only returns discovered MindStone memory documents, not arbitrary filesystem paths.
  - Smoke validation: `npm run smoke:pi-adapter`
- [x] Register read-only Pi adapter recall commands for memory status/search:
  - `/mindstone-recall-status`
  - `/mindstone-recall-search <query> [--limit N]`
  - Smoke validation: `npm run smoke:pi-adapter`
- [x] Add first-pass identity/user and SCRI/recall context injection at prompt start: Pi adapter `before_agent_start` appends configured `IDENTITY.md`/`USER.md` as standing orientation and, when `memory.autoRecall` is enabled, injects Core-ranked ephemeral recall into the Pi system prompt. Live model behavior remains unverified.
- [x] Add conservative Pi transcript lifecycle marker hooks: on `session_shutdown`, `session_compact`, and `session_tree`, the Pi adapter appends sanitized lifecycle events to the configured MindStone transcript without raw summaries/details/messages. Full raw Pi transcript/message archive parity remains pending.
- [x] Add first-pass compaction/session lifecycle handling where Pi supports it via sanitized lifecycle markers. Actual compaction control/customization remains owned by the session-backed runner path and live validation.
- [x] Add read-only Gateway status command: `/mindstone-gateway-status` reports configured endpoint/auth/surfaces without live probing.
- [x] Add smoke validation path: `npm run smoke:pi-adapter` verifies command/tool registration, read-only memory and transcript tools, prompt-context injection, and sanitized lifecycle markers without live model/auth.
- [x] Add a Core/Gateway `AgentRunner` boundary so CLI, Gateway, WebChat, OpenAI-compatible, and future channel surfaces do not call route/provider execution directly.
  - Current default: `ProviderRouteAgentRunner`, a behavior-preserving wrapper around the existing routed provider path.
  - Native chat and Gateway route execution now call the runner boundary, preparing for future live Pi session handles, streaming, abort, and compaction control.
  - Run context and runner diagnostics are preserved in API responses and assistant transcript metadata.
  - `AgentRunner.stream(...)` now exists with lifecycle events (`run_started`, `run_completed`, `run_failed`) and can replay bounded `pi-session` post-run diagnostics as `substrate_event`s.
  - Selected stream events can be persisted as transcript `event` entries behind `observability.runnerStream.persistTranscriptEvents`; runner stream callbacks can now drive live TUI text/substrate updates, while durable persistence remains gated and sanitized.
  - `routing.mode = "pi-session"` now selects a Gateway-side `PiSessionAgentRunner` in native CLI and Gateway paths; `PiSessionMindStoneProvider` remains available as a compatibility wrapper.
  - Shared `PiSessionExecutor` owns the actual Pi `AgentSession` implementation so runner/provider compatibility paths no longer duplicate execution logic.
- [x] Add first `pi-session` routing scaffold with deterministic canonical session-key → Pi session-file mapping and Pi `SessionManager` / `createAgentSession` use.
- [x] Add Gateway-side `PiSessionAgentRunner` and select it from CLI/Gateway for `routing.mode = "pi-session"`.
- [x] Extract `PiSessionExecutor` as the shared Pi AgentSession execution layer used by the runner and compatibility provider.
- [x] Add `AgentRunner.stream(...)` contract scaffold and smoke validation for provider-route and pi-session runners, including bounded `pi-session` diagnostic replay as stream `substrate_event`s.
- [x] Add gated transcript persistence for selected stream events in shared native chat and Gateway route paths.
- [x] Add first OpenClaw-style `mindstone tui` shell using vendored Pi TUI primitives, styled chat log/editor/footer, and the existing routed chat path.
- [x] Load recent transcript history into `mindstone tui` startup, with `--history-limit` and smoke validation.
- [x] Add first TUI in-place assistant update path and event-line rendering for returned turn events.
- [x] Wire native TUI turns to `onRunnerStreamEvent` for live runner text-delta and substrate/route event updates, with `mindstone tui --smoke-stream` coverage.
- [x] Add first `/status` panel with agent/session/route/model/provider/config/transcript/runtime details.
- [x] Add non-mutating `/config` panel for sanitized active runtime config.
- [x] Add non-mutating `/gateway` panel for configured Gateway surfaces/auth without live probing.
- [x] Add non-mutating `/pi` panel for isolated Pi runtime/session mapping.
- [x] Add non-mutating `/transcript` panel for active transcript file status.
- [x] Add first non-mutating `/sessions`, `/agents`, and `/models` panels.
- [x] Surface `AgentRunner.stream(...)` lifecycle/diagnostic events into the TUI turn path as compact event lines.
- [x] Emit completed-response `text_delta` replay events from runners and apply them to mutable TUI assistant messages.
- [x] Add runtime-only `/session <key>`, `/agent <id>`, and `/model <id>` TUI switching commands without config mutation.
- [x] Render richer TUI runner substrate/tool event labels from stream payload metadata.
- [x] Add non-mutating `/memory` and `/context` TUI panels for recall index and prompt-window status.
- [x] Add non-mutating `/doctor` TUI panel backed by Core doctor report summary.
- [x] Add non-mutating `/handoff` TUI panel for current compaction handoff status.
- [x] Add non-mutating `/identity` TUI panel for active agent identity/user context status.
- [x] Add non-mutating `/events` TUI panel for recent transcript/runner events.
- [x] Add non-mutating `/runs` TUI panel for recent transcript run summaries.
- [ ] Complete a session-backed Pi runner modeled on current MindStone's embedded Pi runner:
  - [x] isolated Pi `agentDir` and session directory
  - [x] canonical MindStone session key → Pi session file mapping
  - [x] `SessionManager.open(...)`
  - [x] `createAgentSession(...)`
  - [x] first MindStone identity/SCRI prompt injection via Pi `DefaultResourceLoader.appendSystemPrompt`, with latest user turn sent through `AgentSession.prompt(...)` instead of crude all-message prompt concatenation
  - [x] first read-only Pi custom tools for MindStone memory status/search/read are registered in the Pi adapter and smoke-tested
  - [ ] broader Pi tools/custom tools/resource loader/extension lifecycle preserved where available
  - [x] `AgentSession.prompt(...)` for real turns when isolated auth/model config is available
  - [x] first bounded `AgentSession.subscribe(...)` event diagnostics capture in `pi-session` raw results, including event counts, bounded event summaries, tool metadata summaries, and final assistant-text extraction
  - [x] sanitized `pi-session` provider diagnostics are copied into assistant transcript metadata for native chat and Gateway routes when available
  - [x] lifecycle-only `AgentRunner.stream(...)` scaffold exists
  - [x] bounded `pi-session` diagnostics can be replayed as stream `substrate_event`s after runner execution
  - [x] selected stream events can be persisted into transcript `event` entries behind an explicit observability gate
  - [ ] full live streaming/event capture into MindStone transcript/source metadata
  - [ ] eventual `AgentSession.compact(...)` coordination for secondary auto-compact mode
- [x] Demote the current provider-level `completeSimple` Pi path to scaffold/fallback status until or unless it can be proven to preserve Pi harness semantics.

### Candidate commands

- [x] `/mindstone-setup`
- [x] `/mindstone-status` and `/mindstone-agent-status`
- [x] `/mindstone-context`
- [x] `/mindstone-recall-status`
- [x] `/mindstone-recall-search <query>`
- [x] `/mindstone-gateway-status`
- [x] `/mindstone-channels` diagnostic command; reports configured channel keys and honest surface/plugin status without starting listeners or probing networks.
- [x] `/mindstone-transcript-status` diagnostic command; reports configured/default transcript status without pruning, compacting, or rewriting history.

### Exit criteria

- [x] Automated Pi adapter smoke proves the extension can register onboarding/config commands and load configured identity/user context through the Pi prompt hook.
- [x] Automated Pi adapter smoke proves memory recall can run through Core and be injected ephemerally when `memory.autoRecall` is enabled.
- [x] Automated Pi adapter smoke proves Gateway status can be queried/config-rendered without live probing.
- [ ] Manual/live Pi UI validation of those commands/hooks remains pending.

## 6. Phase 4 — Gateway API Stabilization

### Tasks

- [x] Preserve or refactor WebSocket `chat.history`.
- [x] Preserve or refactor WebSocket `chat.send`.
- [x] Preserve or refactor WebSocket `chat.abort`.
- [x] Preserve or refactor WebSocket `chat.inject`.
  - `npm run smoke:ws-rpc` covers `/rpc` WebSocket `chat.inject`, `chat.send`, `chat.abort`, `chat.sessions`, `chat.history`, unknown-method handling, and `/ws` alias history.
- [x] Preserve OpenAI-compatible `/v1/chat/completions` for configured mock/Pi routing modes, with placeholder fallback when no provider is configured.
- [x] Preserve non-streaming OpenResponses `/v1/responses` for configured mock/Pi routing modes, with transcript-aware placeholder fallback when no provider is configured.
- [x] Add health/status endpoint.
- [x] Add sanitized Gateway setup visibility to Core status/doctor/CLI status: endpoint, auth mode/source without secret values, compatible HTTP enablement, and route names.
- [x] Verify auth behavior and endpoint enable flags for current Gateway HTTP surfaces.
  - `npm run smoke:auth` covers token/password auth for status and OpenResponses.
  - `npm run smoke:gateway-http-surfaces` covers `/v1/models`, `/v1/chat/completions`, and `/v1/responses` enablement gates across disabled/chat-only/responses-only combinations.
- [x] Document current Gateway API reference for REST chat, RPC/WebSocket, OpenAI-compatible chat completions, non-streaming OpenResponses, auth, enablement gates, routing modes, session/source metadata, validation commands, and current non-goals.
  - `docs/gateway/API_REFERENCE.md`
- [x] Add smoke-level integration tests around current HTTP and WebSocket methods.
  - `npm run smoke:chat` covers `/health`, `/status`, REST chat inject/send/abort/sessions/history, invalid inject/send, and limited history.
  - `npm run smoke:rpc` covers HTTP RPC chat methods.
  - `npm run smoke:ws-rpc` covers WebSocket RPC methods and `/ws` alias.
  - `npm run smoke:openai`, `npm run smoke:router-mock`, and `npm run smoke:gateway-http-surfaces` cover compatible HTTP surfaces.

### Candidate files

- `src/gateway/server-methods/chat.ts`
- `src/gateway/openai-http.ts`
- `src/gateway/openresponses-http.ts`
- `src/gateway/server.impl.ts`

### Exit criteria

- [x] Gateway/WebChat REST APIs can send/history/inject/abort in smoke validation. Browser WebChat UI smoke covers shell loading and send/history, but not a full manual browser UX pass.
- [x] OpenAI-compatible HTTP smoke works for scaffold and mock-routed paths.
- [x] OpenResponses HTTP smoke works for scaffold and mock-routed non-streaming paths.
- [x] Current Gateway auth failure cases are smoke-tested for status and OpenResponses; deeper endpoint matrix can expand as surfaces mature.

## 7. Phase 5 — Memory, SCRI, and Dream Cycle

### Tasks

- [x] Define first-pass file-backed memory source discovery.
- [ ] Port full memory source discovery beyond runtime memory files/journals/LOG.
- [ ] Define/port transcript archive/index pipeline.
  - [x] First-pass `mindstone memory backfill` indexes existing JSONL transcript entries into SQLite chunks.
- [ ] Define/port vector backend abstraction.
  - [x] First-pass dependency-free SQLite memory index schema/provider exists at `.runtime/mindstone/vectors/memory.sqlite`.
- [x] Decide LanceDB vs sqlite-vec support order.
  - Default local direction is SQLite/sqlite-vec; LanceDB remains optional/compatibility-oriented.
- [ ] Port SCRI recall query/scoring/dedup/context-budget behavior.
  - [x] First-pass local autoRecall query/scoring/context-budget insertion is implemented for deterministic smoke tests.
  - [x] File-backed structured memory, journals, `memory/MEMORY.md`, and `LOG.md` can feed local autoRecall.
  - [x] SQLite-index-backed recall can feed autoRecall when `memory.vectorStore` is `sqlite-vec`.
  - [x] Embedding-backed SQLite recall works over stored embeddings using JS cosine similarity.
  - [x] First-pass SCRI ranking/dedup works with diagnostics.
  - [x] sqlite-vec capability/fallback diagnostics are implemented.
  - [ ] sqlite-vec native ANN search and SCRI weight tuning remain pending.
- [ ] Add dream-cycle hook for compaction/session/pruning boundary.
- [x] Implement sliding-window prompt pruning: trigger at `ceilingPercent`, prune toward `floorPercent`, retain `minRecentMessages`, preserve transcript.
- [x] Connect sliding-window prompt selection to router prompt messages for mock and Pi provider modes.
- [x] Implement first-pass auto-recall prompt insertion behind `memory.autoRecall` for local deterministic memory docs.
- [ ] Implement real vector-backed auto-recall prompt insertion behind `memory.autoRecall`.
  - [x] First-pass SQLite-index-backed recall insertion is implemented.
  - [x] Embedding-backed recall over SQLite-stored vectors is implemented.
  - [ ] sqlite-vec extension nearest-neighbor search remains pending.
- [ ] Implement embedding/provider configuration beyond the placeholder `embeddingProvider` field.
  - [x] OpenAI-compatible embedding provider interface.
  - [x] Ollama-style local default via `ollama:nomic-embed-text` and `EMBEDDER_BASE_URL`.
  - [x] `mindstone memory backfill --embed`.
  - [x] `mindstone doctor` sample embedding probe.
  - [x] Provider-first config wizard UX for embeddings.
- [ ] Live-test selected prompt messages through the session-backed Pi runner with isolated credentials/config.
  - Provider-level `completeSimple` calls are insufficient as the real target because they bypass Pi `AgentSession`, tools, extensions, session lifecycle, and compaction/control semantics.
- [ ] Implement auto-compact runtime policy for compatible substrates.
  - [x] First-pass threshold eventing for `auto_compact_warning` and `auto_compact_required`.
  - [x] Compact target to reserve-token mapping.
  - [x] Gated emergency checkpoint/handoff writing when `emergencyAutoHandoff` is enabled.
  - [x] Current handoff status/doctor visibility and ephemeral replay into routed prompt context.
  - [x] Explicit substrate compaction coordination-result reporting.
  - [x] Post-compact maintenance scaffold event after handoff replay.
  - [ ] Actual in-process Pi `AgentSession.compact()` invocation remains pending until Gateway owns a live Pi session handle through the session-backed Pi runner or a Pi-extension control path can call `ctx.compact()`.
  - [ ] Any compaction integration must preserve the MindStone premise: one authoritative append-only session/transcript across channels; compaction may only affect live prompt/session context, never delete or split transcript history.
  - [ ] Next spike: implement the session-backed Pi runner first; keep a Pi-extension `ctx.compact()` bridge as a later option only if direct `AgentSession` control cannot preserve unified transcript authority.
- [ ] Add compact config UX and runtime mapping for checkpoint/handoff trigger, compact target, and post-compact archive/embed/dream-cycle execution policy.
- [x] Add manual backfill command.
  - `mindstone memory backfill`
- [x] Add first-pass memory status and diagnostics.
  - `mindstone memory status`
  - `mindstone doctor` reports SQLite DB presence/chunk counts for `sqlite-vec` config.
  - `mindstone doctor` probes configured embedding providers with a sample embedding request.
  - `mindstone doctor` reports sqlite-vec availability or explicit JS-cosine/lexical fallback.
- [x] Add tests for recall injection formatting.
- [x] Add smoke test for SCRI active-context dedup, candidate dedup, and score diagnostics.
- [x] Document thin standing context, ephemeral auto-recall, on-demand recall, structured memory, journals, LOG, and vectorization strategy in `docs/refactor/MEMORY_STRATEGY.md`.

### Candidate files

- `src/memory/*`
- `extensions/memory-lancedb/*`
- `src/agents/pi-extensions/context-pruning/*`
- `docs/concepts/memory.md`
- `docs/concepts/session-pruning.md`

### Exit criteria

- [ ] Markdown memory and transcript memory can be indexed.
- [ ] Recall returns relevant context with metadata.
- [ ] Dream-cycle archive/index runs manually and at lifecycle boundary.
- [ ] Forced compaction/session reset preserves continuity in test/manual validation.

## 8. Phase 6 — Channel Ports

### 6.1 Telegram

- [ ] Port Telegram plugin to Core channel contract.
- [ ] Replace monolith plugin-sdk imports with Core/runtime service imports.
- [ ] Validate bot token setup.
- [ ] Validate DM pairing/allowlist.
- [ ] Validate inbound DM response.
- [ ] Validate group mention behavior.
- [ ] Validate outbound send.
- [ ] Add status/probe tests.

### 6.2 Discord

- [ ] Port Discord plugin to Core channel contract.
- [ ] Validate token setup and bot probe.
- [ ] Validate DM policy.
- [ ] Validate guild/channel allowlist.
- [ ] Validate mention gating and threads.
- [ ] Validate outbound send/media where feasible.

### 6.3 Slack

- [ ] Port Slack plugin to Core channel contract.
- [ ] Validate bot/app token setup.
- [ ] Validate Socket Mode monitor.
- [ ] Validate DM and channel allowlists.
- [ ] Validate threads and slash command behavior where applicable.

### 6.4 Signal

- [ ] Port Signal plugin to Core channel contract.
- [ ] Validate `signal-cli` detection.
- [ ] Validate HTTP bridge option.
- [ ] Validate account/link guidance.
- [ ] Validate inbound/outbound messages.

### Exit criteria

- [ ] Telegram works end-to-end.
- [ ] At least one of Discord or Slack works end-to-end.
- [ ] Signal has a documented path and either works or is explicitly deferred with known blockers.

## 9. Phase 7 — OpenWebUI Validation

### Tasks

- [x] Add explicit session policy config for single shared MindStone session/transcript by default.
- [ ] Ensure Gateway WebChat, OpenWebUI, Pi adapter, Telegram, and future channels can route to the same default session key.
  - [x] Canonical single-session default is `agent:default:main`, matching MindStone's `agent:<agentId>:<mainKey>` shape.
  - [x] Legacy `mindstone` session key alias canonicalizes to `agent:default:main`.
  - [x] Gateway REST chat, HTTP RPC chat, WebSocket RPC chat, and OpenAI chat completions default to the configured shared session when `sessionKey` is omitted.
  - [x] Gateway REST chat, RPC chat, OpenAI-compatible chat completions, non-streaming OpenResponses, routing events, and assistant responses preserve structured transcript source metadata.
  - [x] Verified by `npm run smoke:unified-session`.
  - [ ] OpenWebUI, Telegram, WebChat UI, native CLI chat, and Pi adapter validation through the session-backed Pi runner still pending.
- [ ] Enable Gateway OpenAI-compatible endpoint in local config.
- [ ] Start Gateway with auth.
- [ ] Configure OpenWebUI custom OpenAI provider with Gateway base URL.
- [ ] Validate non-streaming response.
- [ ] Validate streaming response.
- [ ] Validate stable session routing through `user` or configured session key.
- [x] Document setup/validation-prep instructions without claiming live OpenWebUI validation.
  - `docs/gateway/OPENWEBUI.md`
- [ ] Add WebChat setup/config UX for Gateway enablement, auth, session policy, and connection instructions.
- [ ] Add compatibility shim only if validation shows a concrete gap.

### Exit criteria

- [ ] OpenWebUI can chat with MindStone through Gateway.
- [ ] Setup documented in `docs/web/` or `docs/gateway/`.

## 10. Phase 8 — Packaging, Ops, and Docs

### Tasks

- [ ] Update install flow.
- [ ] Update daemon install/status/restart flow.
- [ ] Add config migration/doctor checks.
  - [x] First-pass `mindstone doctor` checks runtime isolation, config parse, identity files, session policy, context policy, memory config, routing mode/model, and provider/model discovery.
  - [ ] Config migrations and live provider/model-call validation are still pending.
- [ ] Add `.gitignore` entries for private state if missing.
- [ ] Update README quick start after implementation is real.
- [ ] Add architecture docs and API docs as needed.
- [ ] Add release checklist.

### Exit criteria

- [ ] Fresh install works on macOS.
- [ ] Fresh install works or has documented path on Linux.
- [ ] Private state remains untracked.
- [ ] README matches verified behavior.

## 11. Phase 9 — Agent Packs and Dockerized Role Deployments

Agent Packs are a post-MVP productization layer for shipping ready-to-run, role-specific MindStone agents. See `AGENT_PACKS.md` for the detailed planning draft.

### Tasks

- [ ] Define versioned Agent Pack manifest schema.
- [ ] Add local pack catalog loader.
- [ ] Add CLI surfaces:
  - `mindstone packs list`
  - `mindstone packs inspect <pack>`
  - `mindstone packs install <pack>`
  - `mindstone packs start <pack>`
  - `mindstone packs open <pack>`
  - `mindstone packs status <pack>`
  - `mindstone packs stop <pack>`
  - `mindstone packs update <pack>`
  - `mindstone packs export <pack>`
- [ ] Build first free Dockerized proof pack, likely Research Agent or Software Engineer Lite.
- [ ] Enable Gateway and WebChat by default for packs.
- [ ] Persist transcripts, memory, and Gateway state through Docker volumes.
- [ ] Define role identity seed and memory scaffold import flow.
- [ ] Keep user/runtime memory separate from pack-provided seed content and pack updates.
- [ ] Add Docker/pack doctor checks for:
  - Docker availability
  - image provenance
  - required ports
  - persistence volumes
  - auth state
  - Gateway/WebChat health
  - missing provider configuration
- [ ] Add safe uninstall/cleanup and backup/export path.
- [ ] Define paid-pack entitlement model for commercial packs.
- [ ] Define private registry pull flow for paid packs.
- [ ] Evaluate Bun-compiled launcher/runtime packaging for installer/orchestration code.
- [ ] Add signed image/checksum verification where practical.
- [ ] Ensure paid-pack copy says compiled launchers/private registries/authenticated entitlements protect proprietary pack logic where appropriate, without claiming compilation is absolute IP protection.
- [ ] Validate no provider credentials, registry tokens, license secrets, or private user state are embedded in images or binaries.

### Exit criteria

- [ ] A free proof pack can be installed, started, opened, stopped, and removed through `mindstone packs ...` commands.
- [ ] WebChat works against the pack's Gateway route.
- [ ] Transcript persistence survives container restart.
- [ ] Memory persistence survives container restart.
- [ ] Pack identity loads predictably.
- [ ] Doctor reports pack runtime status clearly.
- [ ] Public documentation distinguishes available packs from planned packs.
- [ ] Commercial-pack protection model is documented as layered friction/auth/service-boundary protection, not absolute binary secrecy.

## 12. Validation Matrix

| Area | Automated | Manual | Required for MVP |
|------|-----------|--------|------------------|
| Core contracts | Unit tests | code review | Yes |
| Wizard | fake prompter tests | Pi TUI run | Yes |
| Pi adapter | smoke tests | live Pi run | Yes |
| Gateway WS | integration tests | WebChat run | Yes |
| OpenAI HTTP | integration tests | curl/OpenWebUI | Yes |
| SCRI recall | unit/integration | continuity review | Yes |
| Dream cycle | integration | forced compaction | Yes |
| Telegram | mocked + probe | live bot | Yes |
| Discord/Slack | mocked + probe | live workspace | One required |
| Signal | limited | live link | Can defer if documented |

## 13. PR Slicing Recommendation

1. **PR 1:** Docs and architecture decision record.
2. **PR 2:** Core contracts and compatibility exports.
3. **PR 3:** Wizard prompter interface and Pi prompter adapter.
4. **PR 4:** Pi adapter MVP commands/tools/context injection plus session-backed Pi runner spike.
5. **PR 5:** Gateway API stabilization and tests.
6. **PR 6:** Memory/SCRI extraction and dream-cycle validation.
7. **PR 7:** Telegram channel port.
8. **PR 8:** Discord or Slack channel port.
9. **PR 9:** OpenWebUI docs/validation and release packaging.
10. **PR 10:** Agent Pack manifest/catalog, first free Dockerized proof pack, and pack CLI lifecycle commands.

## 14. Dependencies

- Current Pi SDK docs and extension APIs.
  - Public docs: `https://pi.dev/docs/latest`
  - Package registry: `https://pi.dev/packages`
  - Compaction reference: `https://pi.dev/docs/latest/compaction`
- Existing MindStone Gateway and channel code.
- Embedding/vector backend decision.
- Channel test credentials or mocked provider fixtures.
- Cairn review of substrate boundary.
- Hearth review of daemon/ops model.
- Docker Desktop / Docker Engine validation environments for Agent Packs.
- Future account/licensing/registry infrastructure decision for paid Agent Packs.

## 15. Immediate Next Steps

- [x] Re-center the next engineering slice on MindStone continuity fundamentals:
  - one shared session/transcript across Gateway, WebChat, OpenAI-compatible, Pi adapter, and future channels
  - JSONL transcript remains append-only and authoritative
  - sliding-window pruning affects only the active prompt window
  - SCRI/recall rehydrates relevant older context from transcript/memory layers
  - verified Gateway REST/RPC/WS/OpenAI default-session convergence with `npm run smoke:unified-session`
- [x] Add the session-backed Pi runner path behind `AgentRunner`:
  - `PiSessionAgentRunner` selected for `routing.mode = "pi-session"`
  - `PiSessionExecutor` owns shared Pi `AgentSession` execution logic
  - provider wrapper retained for compatibility only
  - no live auth/model success claimed yet
- [x] Add `AgentRunner.stream(...)` contract scaffold with bounded `pi-session` diagnostic replay as stream `substrate_event`s.
- [x] Add gated transcript persistence for selected stream events.
- [x] Add first styled `mindstone tui` shell over the routed chat path.
- [x] Load transcript history into the TUI on startup.
- [x] Add first in-place assistant update path and render returned event entries.
- [x] Add first TUI `/status` panel for route/session/runtime visibility.
- [x] Add non-mutating TUI `/sessions`, `/agents`, and `/models` selector panels.
- [x] Render runner lifecycle/diagnostic stream events in TUI turns.
- [x] Apply completed-response `text_delta` replay events to mutable TUI assistant messages.
- [x] Add runtime-only TUI switching commands for session/agent/model selection.
- [x] Add richer TUI labels for runner substrate/tool event payloads.
- [x] Add non-mutating TUI `/memory` and `/context` panels.
- [x] Add non-mutating TUI `/doctor` panel.
- [x] Add non-mutating TUI `/handoff` panel.
- [ ] Stream/update assistant/tool events live from runner/Gateway events.
- [ ] Implement full live Pi session event/stream capture into MindStone transcript/source metadata.
- [ ] Drive the remaining MVP proof gates from `docs/refactor/MVP_EXIT_CHECKLIST.md`, with live isolated Pi-session prompt/stream validation as the primary MVP-proven gate.
- [ ] Live-test Pi-backed model calls through `AgentSession.prompt(...)` only after isolated auth/model config is intentionally provided.
- [ ] Add actual substrate compact invocation behind the existing coordination interface only after the session-backed runner can preserve unified transcript authority.
- [ ] Keep Agent Packs post-MVP, but preserve product architecture space for Dockerized role agents, pack manifests, pack-scoped identity/memory seeds, WebChat/Gateway defaults, entitlement-controlled paid packs, and compiled launcher/orchestration code where appropriate.
