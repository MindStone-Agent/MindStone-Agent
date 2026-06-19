# MindStone-Agent Task Status

**Last Updated:** 2026-06-18
**Status:** Rebuilding foundation around upstream Pi base

## Quick Status

| Area | Status | Notes |
|------|--------|-------|
| Repo foundation | In progress | Upstream Pi base installed under `vendor/pi` |
| Isolation | Verified initial | Native and Docker paths isolate Pi config/sessions/data from host/global Pi |
| Docs | Drafted | Refactor and operations docs present |
| Core/Gateway | Scaffolded | Core contracts, config/identity loaders, config/onboarding wizard with profile selection and provider-first isolated Pi model selection, native CLI chat, context-management policy + sliding-window selector, router/provider abstraction, transcript store, file + SQLite memory index/backfill/status, REST/RPC/WebSocket chat endpoints, run-manager abstraction, runtime initializer, Gateway auth, health/status endpoints, canonical unified session key, OpenAI chat completions, and non-streaming OpenResponses compatibility build successfully |
| Native install | Scaffolded | Builds vendored Pi base; daemon install not added yet |
| Docker install | Verified initial | Docker image builds Pi + overlay packages and uses project-specific volumes |

## Current Sprint

### In Progress

- [x] Validate vendored Pi build.
- [x] Validate isolated wrapper startup.
- [x] Establish MindStone overlay package structure.
- [x] Add first real Pi adapter integration test.
- [x] Expand Gateway beyond `/health` with `/status`.
- [x] Start MindStone Core implementation around identity/config loading beyond metadata.
- [x] Add Gateway auth modes.
- [x] Start OpenAI-compatible Gateway endpoint skeleton.
- [x] Begin transcript/session storage implementation.
- [x] Add transcript-backed WebChat history endpoints.
- [x] Add transcript-backed WebChat send/abort placeholders.
- [x] Add old-style Gateway method-name RPC bridge for WebChat lineage.
- [x] Add WebSocket transport for old-style Gateway RPC method names.
- [x] Add selectable context-management policy config for `auto_compact` vs `sliding_window`.
- [x] Implement Core sliding-window prompt selector and Gateway pruning event path.
- [x] Add router/provider abstraction with placeholder, mock, and lightweight Pi provider scaffold.
- [x] Add Core `AgentRunner` boundary and default `ProviderRouteAgentRunner`; native chat and Gateway routes now call the runner boundary rather than `runMindStoneRoute(...)` directly.
- [x] Pass run context through `AgentRunner` and preserve runner diagnostics in API responses plus assistant transcript metadata.
- [x] Add Gateway-side `PiSessionAgentRunner`; CLI/Gateway select it for `routing.mode = "pi-session"`, while the legacy `PiSessionMindStoneProvider` remains a compatibility wrapper.
- [x] Extract shared `PiSessionExecutor` so the runner and compatibility provider use one Pi AgentSession implementation.
- [x] Add `pi-session` routing mode scaffold that maps canonical MindStone session keys to deterministic Pi session files and uses Pi `SessionManager` / `createAgentSession` for real turns when isolated auth is available.
- [x] Add first bounded Pi `AgentSession.subscribe(...)` event diagnostics capture for the `pi-session` runner; smoke validates event counts, bounded event summaries, tool metadata summaries, and final assistant-text extraction without live auth.
- [x] Move `pi-session` MindStone system messages (identity/SCRI/handoff) into Pi `DefaultResourceLoader.appendSystemPrompt` and send only the latest user turn through `AgentSession.prompt(...)`.
- [x] Preserve sanitized provider diagnostics from `pi-session` raw results into assistant transcript metadata for native chat and Gateway routes when available.
- [x] Add `AgentRunner.stream(...)` contract scaffold and lifecycle event smoke validation for provider-route and pi-session runners.
- [x] Replay bounded `pi-session` diagnostics as `substrate_event` stream events after runner execution; later runner stream callback plumbing added live TUI text/substrate updates, while authenticated provider behavior remains unverified.
- [x] Add explicit `route_planned` events plus live `pi-session` diagnostic and assistant text-delta callback plumbing through `AgentRunner.stream(...)`; authenticated provider behavior remains unverified.
- [x] Add gated transcript persistence for selected `AgentRunner.stream(...)` events in native chat and Gateway route paths, with an explicit durable Pi-session metadata policy and sanitizer smoke coverage for raw Pi message/tool args/results.
- [x] Add gated `smoke:pi-session-live` probe for isolated-auth live `AgentSession.prompt(...)`, runner-stream validation, and optional `AgentSession.compact(...)` validation via `MINDSTONE_PI_SESSION_LIVE_COMPACT=1`.
- [x] Add config-backed Pi `DefaultResourceLoader` option pass-through for additional extension/skill/prompt/theme paths and resource disable flags.
- [x] Add smallest MindStone-owned Pi inline extension-factory parity: context-pruning derived from `contextManagement.mode = "sliding_window"`, affecting live Pi LLM context only and preserving append-only transcript authority.
- [x] Add session-local Pi native compaction setting parity with `routing.pi.compaction` and a 20k reserve-token floor, applied before pi-session prompt/compact.
- [x] Add optional fallback-only Pi compaction safeguard factory via `routing.pi.compaction.safeguardFallback`, preserving safe tool-failure/file-operation context only when authenticated Pi compaction summary generation is unavailable.
- [x] Surface pi-session safety posture in Core status and doctor: isolated agent dir, resume-cap settings, compaction reserve floor, and optional safeguard fallback.
- [x] Add native config-wizard support for advanced pi-session safety settings: resume cap, drop-error-turn filtering, compaction reserve floor, and fallback-only safeguard.
- [x] Use real `PiSessionAgentRunner` construction for CLI/TUI pi-session routes instead of injected-provider runners.
- [x] Add pi-session file serialization around `AgentSession.prompt(...)` and `AgentSession.compact(...)`, including in-process ordering, cross-process lockfile/stale-lock safety, and pre-open malformed-tail JSONL repair with backup preservation.
- [x] Add in-memory Pi SessionManager resume cap after open, derived from `routing.pi.resumeCap`, preserving append-only session files while bounding live resume context and dropping assistant error turns.
- [x] Add `docs/refactor/PI_SESSION_PARITY.md` tracking MindStone embedded-runner parity tiers and next gaps.
- [x] Add `mindstone memory maintain` and `mindstone memory backfill --maintain` for memory substrate maintenance: stale-source cleanup, opt-in exact-text dedupe, orphan-source cleanup, SQLite optimize/reindex/VACUUM, WAL checkpointing, bloat/duplicate diagnostics, doctor/status/TUI visibility, JSON automation output, and embedding preservation across unchanged backfilled chunks.
- [x] Add Pi adapter setup/status/context/gateway/channels/transcript/recall commands with smoke coverage: `/mindstone-setup`, `/mindstone-config`, `/mindstone-status`, `/mindstone-agent-status`, `/mindstone-context`, `/mindstone-gateway-status`, `/mindstone-channels`, `/mindstone-transcript-status`, `/mindstone-recall-status`, and `/mindstone-recall-search <query> [--limit N]`.
- [x] Add read-only Pi adapter memory/transcript tools for session-backed Pi use: `mindstone_memory_status`, `mindstone_memory_search`, `mindstone_memory_read`, and `mindstone_transcript_status`; memory read is restricted to discovered MindStone memory docs and smoke coverage verifies search/read/status behavior.
- [x] Add conservative Pi adapter lifecycle marker hooks for `session_shutdown`, `session_compact`, and `session_tree`; they append sanitized lifecycle events to the configured MindStone transcript without persisting raw summaries/details/messages. This is not full raw Pi transcript archive parity yet.
- [x] Add first-pass Pi adapter `before_agent_start` prompt-context injection for configured `IDENTITY.md`/`USER.md` and ephemeral Core memory recall when `memory.autoRecall` is enabled; verified without live model calls.
- [x] Add conservative first-activation identity synthesis via `mindstone identity activate`: derives a working identity from onboarding profile/preferences/identity seed, supports dry-run/JSON, backs up pending scaffolds, and refuses to overwrite non-pending identity without `--force`.
- [x] Add `npm run smoke:core-boundary` to verify `mindstone-core` compiles independently and does not import Gateway/CLI/Pi adapter or Pi-specific packages directly.
- [ ] Complete full live authenticated event/stream validation, live-observed durable metadata allowlist refinements if needed, and any necessary full staged compaction-safeguard summary parity for the session-backed Pi runner.
- [x] Add native `mindstone config` / `mindstone onboard` CLI surface.
- [x] Replace placeholder-only onboarding with risk notice, full config flow, and identity/user scaffold creation.
- [x] Add provider-first isolated Pi provider/model discovery to native config/onboarding routing setup.
- [x] Add default onboarding profile selection with Custom / Write-in support.
- [x] Align single-session default with MindStone canonical session key shape: `agent:default:main`, while preserving `mindstone` as a compatibility alias.
- [x] Add unified session/transcript invariant smoke proving REST, HTTP RPC, WebSocket RPC, OpenAI chat completions, and non-streaming OpenResponses default traffic append to one canonical transcript with distinct source metadata.
- [x] Add native `mindstone chat` terminal/REPL surface over the canonical session and routed identity/SCRI prompt path.
- [x] Validate autoRecall/SCRI injection through native `mindstone chat` with `npm run smoke:cli-chat-recall`.
- [x] Add first styled `mindstone tui` shell using vendored Pi TUI primitives, MindStone gold/diamond theme, chat log, editor, footer/status, slash commands, and routed chat path.
- [x] Load recent transcript history into `mindstone tui` startup; smoke validates rendering prior user/assistant transcript entries.
- [x] Add first TUI in-place assistant response update path and event-line rendering for returned turn events.
- [x] Add first TUI status panel via `/status`, showing agent/session/route/model/provider/config/transcript/runtime details.
- [x] Add non-mutating TUI `/config` panel for sanitized active runtime config.
- [x] Add non-mutating TUI `/gateway` panel for configured Gateway surfaces/auth without live probing.
- [x] Add non-mutating TUI `/pi` panel for isolated Pi runtime/session mapping.
- [x] Add non-mutating TUI `/transcript` panel for active transcript file status.
- [x] Add first non-mutating TUI selector panels via `/sessions`, `/agents`, and `/models`.
- [x] Surface `AgentRunner.stream(...)` lifecycle/diagnostic events into the TUI turn path as compact event lines.
- [x] Emit completed-response `text_delta` replay events from runners and apply them to the mutable TUI assistant message.
- [x] Add runtime-only TUI switching commands: `/session <key>`, `/agent <id>`, and `/model <id>`.
- [x] Render richer TUI runner substrate/tool event labels from stream payload metadata.
- [x] Add non-mutating TUI `/memory` and `/context` panels for recall index and prompt-window status.
- [x] Add non-mutating TUI `/doctor` panel backed by Core doctor report summary.
- [x] Add non-mutating TUI `/handoff` panel for current compaction handoff status.
- [x] Add non-mutating TUI `/identity` panel for active agent identity/user context status.
- [x] Add non-mutating TUI `/events` panel for recent transcript/runner events.
- [x] Add non-mutating TUI `/runs` panel for recent transcript run summaries.

### Completed

- [x] Renamed project target to `MindStone-Agent`.
- [x] Preserved Slate scratch scaffold in sibling backup folder.
- [x] Copied PRD/design/architecture/implementation docs into `docs/refactor/`.
- [x] Imported upstream Pi base under `vendor/pi`.
- [x] Documented upstream Pi update strategy.
- [x] Added native isolation wrapper scripts.
- [x] Added Dockerfile and Compose scaffold.
- [x] Added MindStone Core/Gateway/Pi adapter package scaffold.
- [x] Verified `npm run build:mindstone`.
- [x] Verified Gateway `/health` on isolated port `19789`.
- [x] Verified Docker build.
- [x] Verified Docker Pi wrapper reports `0.79.4`.
- [x] Verified Docker Gateway `/health` inside the container.
- [x] Added Gateway `/status` endpoint backed by Core runtime/config/identity metadata.
- [x] Verified native Gateway `/status`.
- [x] Added `/status` to native and Docker smoke tests.
- [x] Added non-destructive runtime initializer for config and placeholder identity/user files.
- [x] Verified `/status` reports initialized default agent metadata.
- [x] Added Gateway auth enforcement for non-health endpoints.
- [x] Verified Gateway auth modes `none`, `token`, and `password`; OpenResponses endpoint now has auth smoke coverage for token/password modes.
- [x] Added OpenAI-compatible `/v1/models` skeleton.
- [x] Added explicit `501 not_implemented` `/v1/chat/completions` skeleton.
- [x] Made `/v1/chat/completions` transcript-aware: compatible input messages are persisted before the not-implemented response.
- [x] Added non-streaming OpenResponses-compatible `/v1/responses`: persists string/array input to the canonical transcript, returns clear scaffold errors without a provider, and routes through `AgentRunner` when mock/Pi routing is configured.
- [x] Added Gateway HTTP surface enablement smoke for `/v1/models`, `/v1/chat/completions`, and `/v1/responses` disabled/chat-only/responses-only combinations.
- [x] Verified OpenAI/OpenResponses-compatible skeleton, routed mock paths, endpoint enablement gates, and auth coverage with `npm run smoke:openai`, `npm run smoke:router-mock`, `npm run smoke:gateway-http-surfaces`, and `npm run smoke:auth`.
- [x] Added file-backed JSONL transcript store.
- [x] Verified append/read/list transcript behavior with `npm run smoke:transcripts`.
- [x] Added transcript aggregate counts to `/status`.
- [x] Added Gateway-native `/chat/sessions`, `/chat/history`, and `/chat/inject` endpoints.
- [x] Added `/chat/send` placeholder that persists user messages and records routing-not-implemented events.
- [x] Added `/chat/abort` placeholder that records abort-requested events.
- [x] Verified chat history/send/abort endpoints with `npm run smoke:chat`.
- [x] Added `POST /rpc` bridge for `chat.sessions`, `chat.history`, `chat.inject`, `chat.send`, and `chat.abort`.
- [x] Verified HTTP RPC bridge with `npm run smoke:rpc`.
- [x] Added WebSocket RPC transport on `/rpc` and `/ws` using the same method executor.
- [x] Verified WebSocket RPC bridge with `npm run smoke:ws-rpc`; coverage includes `/rpc`, `/ws`, `chat.inject`, `chat.send`, `chat.abort`, `chat.sessions`, `chat.history`, and unknown-method handling.
- [x] Added Gateway run-manager abstraction and wired `/chat/abort` / RPC `chat.abort` through it.
- [x] Added Core `buildPromptWindow()` sliding-window selector.
- [x] Added Gateway prompt-window build/prune event path for `/chat/send`, RPC/WS `chat.send`, and `/v1/chat/completions`.
- [x] Verified Core context-window behavior with `npm run smoke:context-window`.
- [x] Verified Gateway sliding-window pruning/transcript preservation with `npm run smoke:sliding-window`.
- [x] Added mock router and verified `/chat/send`, RPC `chat.send`, and `/v1/chat/completions` with `npm run smoke:router-mock`.
- [x] Added isolated Pi provider config adapter and verified model metadata discovery with `npm run smoke:pi-provider-config`.
- [x] Verified native Pi adapter package registration via RPC `get_commands`.
- [x] Verified Docker Pi adapter package registration via RPC `get_commands`.

### Upcoming

- [x] Replace placeholder initializer with interactive onboarding flow.
- [x] Connect transcript-aware `/v1/chat/completions` to real MindStone routing for configured mock/Pi provider modes.
- [x] Add WebSocket transport over the method-name RPC bridge.
- [x] Add run manager abstraction for active/abortable Gateway runs.
- [x] Connect router flow to consume selected sliding-window `promptEntries` for mock and Pi provider modes.
- [x] Add native `mindstone chat` MVP interaction surface with mock-routed validation.
- [x] Add Core `AgentRunner` boundary and wire native chat/Gateway route execution through runners, including run context and runner diagnostics.
- [x] Add first session-backed Pi runner scaffold using Pi `AgentSession` / `SessionManager`; provider-level `completeSimple` remains scaffold/fallback, not the real Pi-backed MVP path.
- [x] Move `pi-session` route selection behind `PiSessionAgentRunner` for native CLI and Gateway paths, with the provider wrapper retained for compatibility.
- [x] Extract `PiSessionExecutor` as the shared AgentSession execution layer under the runner/provider wrapper.
- [x] Add lifecycle-only `AgentRunner.stream(...)` scaffold and post-run bounded `pi-session` diagnostic replay as stream `substrate_event`s.
- [x] Add `observability.runnerStream.persistTranscriptEvents` gate for selected stream event transcript persistence.
- [ ] Live-test Pi-backed model calls through the session-backed runner with isolated credentials/config using `MINDSTONE_PI_SESSION_LIVE=1 npm run smoke:pi-session-live`; after that succeeds, live-test compaction with `MINDSTONE_PI_SESSION_LIVE_COMPACT=1`.
- [ ] Decide whether full staged compaction-safeguard summary parity is required before MVP; context-pruning inline factory parity, native compaction setting parity, optional fallback-only safeguard parity, and in-memory resume-cap parity are now implemented.
- [ ] Finish auto-compact runtime policy for compatible substrates as a secondary/fallback path behind sliding-window/SCRI.
  - Primary continuity premise: one shared append-only JSONL session/transcript across channels; pruning/compaction affect only live prompt/session context.
  - Next decision: use a session-backed Pi runner/provider with SDK `AgentSession.compact()` or a Pi-extension control bridge with `ctx.compact()`, only if it preserves unified transcript authority.
  - If that path is too large or threatens session authority, defer actual compaction invocation and implement native sqlite-vec packaging/loading or channel/session validation next.
- [ ] Ask Cairn for review when available.

## Core MVP Remaining

This is the current functional backlog for making MindStone-Agent feel like MindStone proper rather than only a Gateway/router scaffold.

### TUI / user-facing shell

- [x] Add first standalone MindStone-Agent TUI command modeled on current MindStone/OpenClaw's TUI shape.
  - Uses vendored Pi TUI primitives (`TUI`, `ProcessTerminal`, `Editor`, `Markdown`, `Loader`, `Container`).
  - Provides styled header, chat log, footer/status, editor, command hints, `/help`, `/clear`, `/status`, and `/exit`.
  - Routes submitted turns through existing MindStone-Agent chat pipeline and canonical session selection.
  - Smoke validation: `npm run smoke:tui`.
- [x] Load recent transcript history into the TUI on startup.
  - Supports `--history-limit` and renders user, assistant, tool, and labeled event entries.
  - Smoke validation seeds a transcript via `mindstone chat --once` and verifies `mindstone tui --smoke-history`.
- [x] Add first in-place assistant update path for TUI turns.
  - TUI now starts a mutable assistant message as “thinking…” and updates it with the final response.
  - Returned turn event entries render as compact event lines.
  - Later runner-stream wiring upgraded this from final-only replacement to live callback updates.
- [x] Render `AgentRunner.stream(...)` lifecycle/diagnostic events during TUI turns.
- [x] Apply completed-response `text_delta` replay events to the mutable assistant message.
- [x] Stream/update assistant text and tool/substrate events live from runner events in the native TUI; interactive TUI consumes `onRunnerStreamEvent` for live text deltas and substrate/route events, with non-interactive `tui --smoke-stream` coverage.
- [x] Add first `/status` panel with agent/session/route/model/provider/config/transcript/runtime details.
- [x] Add non-mutating `/config` panel for sanitized active runtime config.
- [x] Add non-mutating `/gateway` panel for configured Gateway surfaces/auth without live probing.
- [x] Add non-mutating `/pi` panel for isolated Pi runtime/session mapping.
- [x] Add non-mutating `/transcript` panel for active transcript file status.
- [x] Add first non-mutating `/sessions`, `/agents`, and `/models` panels.
- [x] Add runtime-only `/session <key>`, `/agent <id>`, and `/model <id>` switching commands without config mutation.
- [x] Add first TUI rendering path for `AgentRunner.stream(...)` lifecycle/diagnostic events.
- [x] Add completed-response `text_delta` replay path for mutable assistant updates.
- [x] Render richer runner substrate/tool event labels from stream payload metadata.
- [x] Add non-mutating `/memory` and `/context` panels for recall index and prompt-window status.
- [x] Add non-mutating `/doctor` panel backed by Core doctor report summary.
- [x] Add non-mutating `/handoff` panel for current compaction handoff status.
- [x] Add non-mutating `/identity` panel for active agent identity/user context status.
- [x] Add non-mutating `/events` panel for recent transcript/runner events.
- [x] Add non-mutating `/runs` panel for recent transcript run summaries.
- [ ] Add richer interactive selector overlays and status/settings overlays.
- [ ] Adapt richer current MindStone TUI components and event handlers from `/Users/clint/Projects/MindStone/src/tui/`.

### Onboarding and identity

- [x] Add default onboarding profiles with a write-in option.
  - Profiles provide the base job description and inform the agent’s eventual name/identity choice.
  - Initial profiles: General Companion, Software Engineering Partner, Integration Builder, Research Analyst, Project Strategist, Cybersecurity Specialist, Business Advisor, Therapist / Reflective Support, Life Coach, Health Advisor, Custom / Write-in.
- [x] Add the initial “getting to know the user” phase.
  - interaction preferences
  - communication/recommendation style
  - work style
  - boundaries and approval rules
  - memory/checkpoint style
  - project/domain context
  - sensitive context/cautions
- [ ] Expand user-preference onboarding later with richer clarifying-question and collaboration-pattern tuning.
- [x] Add the initial naming/identity emergence phase.
  - Do not force the human to name the agent.
  - Use selected profile + user context as identity seed.
  - Preserve the MindStone model where the agent forms/chooses its identity collaboratively.
  - Supports defer, candidate seed, and custom identity direction modes.
- [x] Inject configured `IDENTITY.md` and `USER.md` into routed provider prompts as standing system context.
  - Core route assembly reserves token budget for identity/user context.
  - Gateway loads the routed agent identity/user files from config.
  - REST/RPC/OpenAI-compatible/WebChat routed calls report `identityContext` diagnostics.
  - Verified with `npm run smoke:identity-context`, `npm run smoke:router-mock`, and `npm run smoke:webchat-ui`.
- [x] Expand identity emergence into a real first-activation synthesis step.
  - `mindstone identity activate [--agent ID] [--dry-run] [--force] [--yes] [--json]` synthesizes a first-activation working identity from onboarding profile/preferences/identity seed.
  - The command is auditable and conservative: it writes a backup for pending scaffolds and refuses to overwrite non-pending identities unless forced.
  - Smoke validation: `npm run smoke:identity-activation`.
- [x] Build the initial `Integration Builder` skill surface.
  - [x] Add Integration Builder as an onboarding profile.
  - [x] Add reusable Integration Builder skill behavior for creating/configuring integrations/channels/tools.
  - Core now exposes a deterministic Integration Builder brief/workflow generator and Agent-Skills-compatible markdown emitter.
  - CLI surface: `mindstone skill list` and `mindstone skill integration-builder [--name NAME] [--kind KIND] [--goal TEXT] [--json|--emit-skill-md]`.
  - Smoke validation: `npm run smoke:integration-builder-skill`.
- [x] Add shared channel/surface catalog and non-mutating channel setup visibility.
  - Core lists local surfaces, Gateway APIs, external clients, and planned external channel plugins with honest implementation/validation status.
  - Config wizard `channels` section lists available plugins/surfaces without mutating config, starting listeners, probing networks, or requesting secrets.
  - CLI surface: `mindstone channels [--json]`.
  - Pi adapter `/mindstone-channels` now reuses the Core catalog.
  - Smoke validation: `npm run smoke:channel-catalog` and `npm run smoke:pi-adapter`.
- [x] Expose section-scoped native config reconfiguration.
  - CLI supports `mindstone config --section NAME`, repeated `--section`, comma-separated `--sections a,b`, and `--dry-run`.
  - Pi adapter `/mindstone-config` and `/mindstone-setup` also accept `<section>`, `--section`, `--sections`, and `--dry-run` arguments.
  - Automated Pi adapter smoke now runs gateway, memory, identity, and channels wizard sections through the Pi UI shim without mutating config.
  - Invalid section names fail clearly.
  - Smoke validation: `npm run smoke:config-sections`, `npm run smoke:pi-adapter`, and `npm run smoke:pi-config-sections`.

### Memory and context

- [x] Add MS4-style file-backed memory substrate alongside journals.
  - Runtime now initializes `LOG.md`, `memory/MEMORY.md`, `memory/`, and `journals/`.
  - Structured memory files and journals are distinct and discoverable.
  - File-backed memory can feed ephemeral autoRecall.
- [x] Document thin-context / ephemeral-recall / on-demand-recall strategy for SCRI and MindStone-Agent.
- [ ] Implement real auto-recall config, not only the `memory.autoRecall` toggle.
  - [x] Add first-pass recall query construction from latest user turn.
  - [x] Add deterministic local recall provider for development/smoke tests.
  - [x] Discover file-backed memory docs, journals, index, and LOG as local recall sources.
  - [x] Add lexical relevance scoring and min-score filtering.
  - [x] Add prompt-budget insertion into route assembly.
  - [x] Add `memory_recall_injected` transcript event.
  - [x] Add dependency-free SQLite memory index/backfill/status command.
  - [x] Add SQLite-index-backed recall provider for configured `sqlite-vec` mode.
  - [x] Add OpenAI-compatible embedding provider interface.
  - [x] Add Ollama-style local default: `ollama:nomic-embed-text` using `/v1/embeddings`.
  - [x] Add embedding backfill into SQLite chunks with `mindstone memory backfill --embed`.
  - [x] Add embedding-backed recall over embedded SQLite chunks, currently using JS cosine similarity over stored vectors.
  - [x] Add first-pass SCRI ranking layer with provider score, kind/source priority, critical/evergreen boosts, usage boosts, recency/half-life boosts, and score diagnostics.
  - [x] Add dedup against active prompt/session content.
  - [x] Validate end-to-end autoRecall injection through native `mindstone chat` with transcript `memory_recall_injected` events.
  - [x] Add candidate dedup to avoid repeated chunks/text consuming recall budget.
  - [x] Add sqlite-vec capability probe and explicit fallback diagnostics.
  - [x] Report current vector backend as `sqlite-vec`, `js-cosine`, or `lexical` in memory status/doctor.
  - [x] Add first maintenance command: `mindstone memory maintain` removes stale sources, optionally deduplicates exact repeated chunk text with `--dedupe-text`, removes empty sources, runs SQLite optimize/reindex/VACUUM/WAL checkpoint, and reports bloat/duplicate candidates; `mindstone memory backfill --maintain --dedupe-text` can run the same cleanup before optional embedding work; `memory status/backfill/maintain --json` supports hook automation; doctor/status/TUI surface maintenance, bloat, and exact-duplicate signals; unchanged chunk text preserves existing embeddings during backfill.
  - [ ] Add actual sqlite-vec extension nearest-neighbor search when the extension is available/packaged.
  - [ ] Tune full SCRI salience model against real agent traces.
- [ ] Implement embedding/provider configuration.
  - [x] embedding provider selection via `memory.embeddingProvider`
  - [x] API key/env/reference handling for OpenAI-compatible embedding endpoints
  - [x] local/Ollama defaults
  - [x] model choice via provider spec, e.g. `ollama:nomic-embed-text`
  - [x] provider-first config wizard UX for embeddings
  - [ ] sqlite-vec native vector backend compatibility
- [x] Support choosing `sliding_window` vs `auto_compact` context mode.
- [ ] Finish auto-compact runtime policy.
  - [x] checkpoint/handoff warning and compact-required threshold eventing
  - [x] compact target/reserve-token mapping
  - [x] Gateway transcript events for `auto_compact_warning` and `auto_compact_required`
  - [x] gated emergency checkpoint/handoff writing trigger when `emergencyAutoHandoff` is enabled
  - [x] current handoff visibility in status/doctor and ephemeral one-shot replay into routed prompt context
  - [x] substrate compaction coordination result reporting (`requested`, `available`, `substrate`, `reason`)
  - [ ] actual substrate compact invocation for a live in-process Pi `AgentSession` or Pi-extension `ctx.compact()` bridge, without splitting or mutating the authoritative JSONL transcript
  - [x] first `pi-session` runner scaffold added; current MindStone proves Pi `SessionManager` can coexist with canonical single-session/SCRI when MindStone owns the session-key → session-file mapping
  - [x] first bounded `AgentSession.subscribe(...)` event diagnostics capture in `pi-session` provider raw result
  - [x] first resource-loader-based MindStone context injection via `appendSystemPrompt`; crude all-message prompt concatenation removed
  - [x] sanitized `pi-session` diagnostics are preserved into assistant transcript metadata when provider raw diagnostics are available
  - [ ] complete live-auth validation and full event/stream transcript capture
  - [x] post-compact maintenance scaffold event after handoff replay
  - [ ] actual post-compact archive/backfill/embed/dream-cycle execution policy
- [x] Implement sliding-window prompt pruning and config.
- [ ] Polish sliding-window config UX and diagnostics.

### Sessions and transcripts

- [x] Add explicit session policy config.
  - default supports one shared MindStone session/transcript across Gateway surfaces.
  - implemented config:
    ```json
    {
      "session": {
        "mode": "single",
        "defaultSessionKey": "agent:default:main"
      }
    }
    ```
- [ ] Ensure Telegram, WebChat, OpenWebUI, Pi adapter, native CLI chat, and future channels can route into the same session/transcript by default.
  - [x] Native `mindstone chat` uses the configured canonical session by default and was validated with `npm run smoke:cli-chat`.
  - [x] Gateway REST chat, HTTP RPC chat, WebSocket RPC chat, OpenAI chat completions, and non-streaming OpenResponses use the configured shared default when `sessionKey` is omitted.
  - [x] `mindstone` legacy alias canonicalizes to `agent:default:main` for compatibility.
  - [x] Verified with `npm run smoke:unified-session`.
  - [x] Built-in WebChat shell validates omitted session key → `agent:default:main` and mock-routed assistant response via `npm run smoke:webchat-ui`.
  - [ ] Telegram/OpenWebUI/Pi adapter final validation still pending.
- [ ] Preserve channel/source metadata inside the unified transcript without splitting memory continuity.
  - [x] Native `mindstone chat` writes structured `mindstone-cli` / `terminal` source metadata for user and assistant entries.
  - [x] Gateway REST chat, RPC chat, OpenAI-compatible chat completions, non-streaming OpenResponses, routing events, and assistant responses now write structured `TranscriptEntry.source` metadata.
  - [x] Built-in WebChat shell source metadata validates as `gateway-rest` / `webchat` / `internal`.
  - [ ] Telegram/Pi adapter source metadata still pending final validation.

### Channels and surfaces

- [ ] Add Telegram channel setup/config.
  - bot token
  - DM pairing/allowlist
  - group/mention policy
  - polling/webhook choice
  - status/probe
- [x] Add first-pass built-in WebChat shell at `GET /webchat`.
  - thin native MindStone UI over Gateway WebChat REST endpoints
  - blank session key uses `agent:default:main`
  - API calls honor configured Gateway auth
  - mock-routed assistant response appends to canonical transcript
  - `mindstone status` reports WebChat URL/session/source
  - `mindstone doctor` checks WebChat shell/session readiness
  - verified with `npm run smoke:webchat-ui` and `npm run smoke:doctor`
- [ ] Add fuller WebChat setup/config UX.
  - Gateway enablement
  - auth mode
  - session policy
  - WebSocket/REST status
  - user-facing connection instructions
- [ ] Preserve WebChat as an internal Gateway surface, not a deliverable outbound channel, while still making it first-class in setup.

### Provider/routing validation

- [ ] Live-test Pi-backed model calls through a session-backed Pi runner with isolated credentials/config.
- [x] Add first-pass `mindstone doctor` checks for runtime/config/session/identity/memory/routing/provider discovery.
- [ ] Extend `mindstone doctor` with live provider auth/model-call validation.
- [ ] Ensure provider setup follows provider → auth method → model, never a flat global model list.
