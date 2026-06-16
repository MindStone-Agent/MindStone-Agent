# MindStone-Agent Task Status

**Last Updated:** 2026-06-16  
**Status:** Rebuilding foundation around upstream Pi base

## Quick Status

| Area | Status | Notes |
|------|--------|-------|
| Repo foundation | In progress | Upstream Pi base installed under `vendor/pi` |
| Isolation | Verified initial | Native and Docker paths isolate Pi config/sessions/data from host/global Pi |
| Docs | Drafted | Refactor and operations docs present |
| Core/Gateway | Scaffolded | Core contracts, config/identity loaders, config/onboarding wizard, native CLI, context-management policy + sliding-window selector, router/provider abstraction, transcript store, REST/RPC/WebSocket chat endpoints, run-manager abstraction, runtime initializer, Gateway auth, health/status endpoints, and OpenAI skeleton build successfully |
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
