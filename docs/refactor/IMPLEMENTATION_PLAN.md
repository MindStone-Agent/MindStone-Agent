# Implementation Plan: MindStone Core Rebuild on Current Pi

**Project:** MindStone  
**Date:** 2026-06-16  
**Status:** Draft for review  
**Related PRD:** `PRD.md`  
**Related design:** `DESIGN.md`  
**Related architecture:** `ARCHITECTURE.md`

## 1. Implementation Strategy

Implement the rebuild incrementally. Do not attempt a single large forward-port. The goal is to extract stable MindStone semantics into Core, keep the Gateway as the always-on runtime, and add current-Pi support as a clean adapter.

The preferred order is:

1. Approve architecture and contracts.
2. Extract Core contracts.
3. Build Pi adapter MVP.
4. Stabilize Gateway API surfaces.
5. Restore memory/SCRI/dream-cycle behavior.
6. Port channels incrementally.
7. Validate OpenWebUI and package release flows.

## 2. Phase 0 — Review and Cut Line

### Tasks

- [ ] Review `docs/planning/prds/PRD.md` with Clint.
- [ ] Review `docs/design/DESIGN.md` with Clint.
- [ ] Review `docs/design/ARCHITECTURE.md` with Cairn when available.
- [ ] Get Hearth review on daemon/service/secrets implications.
- [ ] Decide whether Core starts as `src/core/*` or `packages/core/*`.
- [ ] Decide whether Gateway continues to own agent execution for MVP or delegates through an `AgentRunner` interface immediately.

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
- [ ] Add dependency direction checks or lint guidance: Core must not import Gateway/Pi.
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

- [ ] Core compiles independently of Pi adapter.
- [ ] Core contracts are documented.
- [ ] Existing code can still run through compatibility exports.

## 4. Phase 2 — Wizard / Onboarding Adapter

### Tasks

- [x] Extract wizard logic to use Core `MindStonePrompter` only.
- [ ] Implement Pi prompter adapter using current Pi `ctx.ui` APIs.
- [x] Add native CLI command for setup/onboarding.
- [x] Add native CLI command for section reconfiguration.
- [ ] Add command for setup/onboarding in Pi adapter.
- [ ] Add command for section reconfiguration in Pi adapter.
- [x] Add default onboarding profiles with write-in option.
- [x] Add `Integration Builder` as an initial onboarding profile.
- [ ] Add reusable `Integration Builder` skill behavior.
- [x] Add initial “getting to know the user” onboarding phase for preferences, boundaries, style, memory/checkpoint style, and project/domain context.
- [ ] Expand preference onboarding with richer collaboration-pattern and clarifying-question tuning.
- [x] Add initial naming/identity emergence phase without forcing human-assigned names.
- [ ] Expand identity emergence into a real first-activation synthesis step.
- [ ] Preserve channel onboarding adapters for Telegram, Signal, Discord, Slack.
- [x] Add fake prompter smoke tests for wizard sections.
- [x] Ensure sensitive provider API-key entry avoids echo/logging.

### Candidate files

- `src/wizard/onboarding.ts`
- `src/commands/configure.memory.ts`
- `src/commands/onboard-channels.ts`
- `src/channels/plugins/onboarding/*`

### Exit criteria

- [ ] Wizard runs through at least identity + memory + gateway sections in Pi.
- [x] Native CLI onboarding/config can run core setup and section reconfiguration.
- [x] Onboarding can select a profile/write-in purpose, gather interaction preferences, and create identity/user scaffolds from that seed.
  - [x] Profile/write-in selection seeds config and identity/user scaffolds.
  - [x] Interaction preference gathering seeds config and identity/user scaffolds.
- [ ] Channel setup section lists available plugins.
- [ ] Reconfiguration can run by section.

## 5. Phase 3 — Current-Pi Adapter MVP

### Tasks

- [ ] Create current-Pi adapter extension/module.
- [ ] Register MindStone commands.
- [ ] Register memory read/search/status tools.
- [ ] Add identity/context injection at prompt start.
- [ ] Add Pi transcript archive hook.
- [ ] Add compaction/session lifecycle handling where Pi supports it.
- [ ] Add Gateway status/check commands.
- [ ] Add smoke validation instructions.

### Candidate commands

- [ ] `/mindstone-setup`
- [ ] `/mindstone-status`
- [ ] `/mindstone-context`
- [ ] `/mindstone-recall-status`
- [ ] `/mindstone-recall-search <query>`
- [ ] `/mindstone-gateway-status`
- [ ] `/mindstone-channels`

### Exit criteria

- [ ] Current Pi can onboard/load a MindStone identity.
- [ ] Current Pi can perform memory recall through Core.
- [ ] Current Pi can query Gateway status.

## 6. Phase 4 — Gateway API Stabilization

### Tasks

- [ ] Preserve or refactor WebSocket `chat.history`.
- [ ] Preserve or refactor WebSocket `chat.send`.
- [ ] Preserve or refactor WebSocket `chat.abort`.
- [ ] Preserve or refactor WebSocket `chat.inject`.
- [x] Preserve OpenAI-compatible `/v1/chat/completions` for configured mock/Pi routing modes, with placeholder fallback when no provider is configured.
- [ ] Preserve OpenResponses `/v1/responses`.
- [ ] Add health/status endpoint.
- [ ] Verify auth behavior and endpoint enable flags.
- [ ] Add integration tests around HTTP and WebSocket methods.

### Candidate files

- `src/gateway/server-methods/chat.ts`
- `src/gateway/openai-http.ts`
- `src/gateway/openresponses-http.ts`
- `src/gateway/server.impl.ts`

### Exit criteria

- [ ] WebChat can send/history/inject/abort.
- [ ] OpenAI-compatible HTTP works with curl.
- [ ] OpenResponses HTTP works with curl.
- [ ] Auth failure cases are tested.

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
- [ ] Live-test selected prompt messages against Pi-backed provider with isolated credentials/config.
- [ ] Implement auto-compact runtime policy for compatible substrates.
  - [x] First-pass threshold eventing for `auto_compact_warning` and `auto_compact_required`.
  - [x] Compact target to reserve-token mapping.
  - [x] Gated emergency checkpoint/handoff writing when `emergencyAutoHandoff` is enabled.
  - [x] Current handoff status/doctor visibility and ephemeral replay into routed prompt context.
  - [ ] Actual substrate compact request remains pending.
- [ ] Add compact config UX and runtime mapping for checkpoint/handoff trigger, compact target, and post-compact archive/embed/dream-cycle.
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
  - [x] Gateway REST chat, RPC chat, and OpenAI chat completions default to the configured shared session when `sessionKey` is omitted.
  - [x] Gateway REST chat, RPC chat, OpenAI-compatible chat completions, routing events, and assistant responses preserve structured transcript source metadata.
  - [ ] OpenWebUI, Telegram, WebChat UI, and Pi adapter validation still pending.
- [ ] Enable Gateway OpenAI-compatible endpoint in local config.
- [ ] Start Gateway with auth.
- [ ] Configure OpenWebUI custom OpenAI provider with Gateway base URL.
- [ ] Validate non-streaming response.
- [ ] Validate streaming response.
- [ ] Validate stable session routing through `user` or configured session key.
- [ ] Document setup instructions.
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

## 11. Validation Matrix

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

## 12. PR Slicing Recommendation

1. **PR 1:** Docs and architecture decision record.
2. **PR 2:** Core contracts and compatibility exports.
3. **PR 3:** Wizard prompter interface and Pi prompter adapter.
4. **PR 4:** Pi adapter MVP commands/tools/context injection.
5. **PR 5:** Gateway API stabilization and tests.
6. **PR 6:** Memory/SCRI extraction and dream-cycle validation.
7. **PR 7:** Telegram channel port.
8. **PR 8:** Discord or Slack channel port.
9. **PR 9:** OpenWebUI docs/validation and release packaging.

## 13. Dependencies

- Current Pi SDK docs and extension APIs.
- Existing MindStone Gateway and channel code.
- Embedding/vector backend decision.
- Channel test credentials or mocked provider fixtures.
- Cairn review of substrate boundary.
- Hearth review of daemon/ops model.

## 14. Immediate Next Steps

- [ ] Clint reviews draft PRD/design for scope.
- [ ] Ask Cairn for architecture review when urgent task clears.
- [ ] Decide first PR scope.
- [ ] Create an ADR or update `ARCHITECTURE.md` after decision.
- [ ] Start Core contract extraction spike.
