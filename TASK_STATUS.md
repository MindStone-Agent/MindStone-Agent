# MindStone-Agent Task Status

**Last Updated:** 2026-06-17  
**Status:** Rebuilding foundation around upstream Pi base

## Quick Status

| Area | Status | Notes |
|------|--------|-------|
| Repo foundation | In progress | Upstream Pi base installed under `vendor/pi` |
| Isolation | Verified initial | Native and Docker paths isolate Pi config/sessions/data from host/global Pi |
| Docs | Drafted | Refactor and operations docs present |
| Core/Gateway | Scaffolded | Core contracts, config/identity loaders, config/onboarding wizard with profile selection and provider-first isolated Pi model selection, native CLI, context-management policy + sliding-window selector, router/provider abstraction, transcript store, file + SQLite memory index/backfill/status, REST/RPC/WebSocket chat endpoints, run-manager abstraction, runtime initializer, Gateway auth, health/status endpoints, and OpenAI skeleton build successfully |
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
- [x] Add router/provider abstraction with placeholder, mock, and Pi-backed provider modes.
- [x] Add native `mindstone config` / `mindstone onboard` CLI surface.
- [x] Replace placeholder-only onboarding with risk notice, full config flow, and identity/user scaffold creation.
- [x] Add provider-first isolated Pi provider/model discovery to native config/onboarding routing setup.
- [x] Add default onboarding profile selection with Custom / Write-in support.

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
- [x] Verified Gateway auth modes `none`, `token`, and `password`.
- [x] Added OpenAI-compatible `/v1/models` skeleton.
- [x] Added explicit `501 not_implemented` `/v1/chat/completions` skeleton.
- [x] Made `/v1/chat/completions` transcript-aware: compatible input messages are persisted before the not-implemented response.
- [x] Verified OpenAI-compatible skeleton with `npm run smoke:openai`.
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
- [x] Verified WebSocket RPC bridge with `npm run smoke:ws-rpc`.
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
- [ ] Connect transcript-aware `/v1/chat/completions` to real MindStone routing.
- [x] Add WebSocket transport over the method-name RPC bridge.
- [x] Add run manager abstraction for active/abortable Gateway runs.
- [x] Connect router flow to consume selected sliding-window `promptEntries` for mock and Pi provider modes.
- [ ] Live-test Pi-backed model calls with isolated credentials/config.
- [ ] Implement auto-compact runtime policy for compatible substrates.
- [ ] Ask Cairn for review when available.

## Core MVP Remaining

This is the current functional backlog for making MindStone-Agent feel like MindStone proper rather than only a Gateway/router scaffold.

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
- [ ] Expand identity emergence into a real first-activation synthesis step.
- [ ] Build the initial `Integration Builder` skill surface.
  - [x] Add Integration Builder as an onboarding profile.
  - [ ] Add reusable Integration Builder skill behavior for creating/configuring integrations/channels/tools.

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
  - [x] Add SQLite-index-backed recall provider for configured `sqlite-vec` mode, currently using lexical scoring over indexed chunks.
  - [ ] Add actual sqlite-vec nearest-neighbor search and embedding-backed recall.
  - [ ] Add dedup against active prompt/session content.
- [ ] Implement embedding/provider configuration.
  - embedding provider selection
  - API key/env/reference handling
  - local/Ollama defaults
  - model choice
  - vector backend compatibility
- [x] Support choosing `sliding_window` vs `auto_compact` context mode.
- [ ] Finish auto-compact runtime policy.
  - checkpoint/handoff trigger
  - compact target/reserve-token mapping
  - post-compact archive/embed/dream-cycle hook
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
        "defaultSessionKey": "mindstone"
      }
    }
    ```
- [ ] Ensure Telegram, WebChat, OpenWebUI, Pi adapter, and future channels can route into the same session/transcript by default.
  - [x] Gateway REST chat, RPC chat, and OpenAI chat completions use the configured shared default when `sessionKey` is omitted.
  - [ ] Telegram/WebChat UI/OpenWebUI/Pi adapter final validation still pending.
- [ ] Preserve channel/source metadata inside the unified transcript without splitting memory continuity.

### Channels and surfaces

- [ ] Add Telegram channel setup/config.
  - bot token
  - DM pairing/allowlist
  - group/mention policy
  - polling/webhook choice
  - status/probe
- [ ] Add WebChat setup/config UX.
  - Gateway enablement
  - auth mode
  - session policy
  - WebSocket/REST status
  - user-facing connection instructions
- [ ] Preserve WebChat as an internal Gateway surface, not a deliverable outbound channel, while still making it first-class in setup.

### Provider/routing validation

- [ ] Live-test Pi-backed model calls with isolated credentials/config.
- [x] Add first-pass `mindstone doctor` checks for runtime/config/session/identity/memory/routing/provider discovery.
- [ ] Extend `mindstone doctor` with live provider auth/model-call validation.
- [ ] Ensure provider setup follows provider → auth method → model, never a flat global model list.
