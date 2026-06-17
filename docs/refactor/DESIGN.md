# Design: MindStone Core Rebuild on Current Pi

**Project:** MindStone  
**Date:** 2026-06-16  
**Status:** Draft for review  
**Related PRD:** `PRD.md`  
**Related architecture:** `ARCHITECTURE.md`

## 1. Design Thesis

MindStone should be rebuilt as a portable persistent-identity platform, not as a Pi-only extension and not as a direct forward-port of the older OpenClaw-derived app shell.

The design center is:

```text
MindStone Core + Gateway daemon + substrate adapters
```

A load-bearing design rule: reuse current Pi capabilities and current MindStone methods/shapes by default. Deviate only when current Pi does not support the existing MindStone shape, or when a newer Pi-native approach is clearly better for the same goal. This rebuild should cleanly modernize MindStone; it should not reinvent Pi's harness features or discard proven MindStone continuity shapes without cause.

Current Pi becomes the first clean substrate adapter. The Gateway remains the always-on process that owns channel listeners, WebChat, OpenAI/OpenResponses-compatible HTTP, and service lifecycle. MindStone Core owns the substrate-neutral concepts: identity, memory, SCRI, transcript, config, channel plugin contracts, and routing semantics.

This gives MindStone a clean path forward while preserving the features users actually depend on. Before inventing a new mechanism, check how current MindStone does it, whether current Pi supports that shape directly, and whether any proposed deviation is necessary rather than accidental wheel-rebuilding.

## 2. Product Shape

```text
┌─────────────────────────────────────────────────────────────┐
│                         Users / Surfaces                     │
│  Pi TUI  WebChat  OpenWebUI  Telegram  Signal  Discord Slack │
└───────────────┬───────────────┬───────────────┬─────────────┘
                │               │               │
                ▼               ▼               ▼
┌──────────────────────┐ ┌──────────────────┐ ┌────────────────┐
│ Substrate Adapters   │ │ Gateway APIs      │ │ Channel Plugins│
│ - Pi adapter         │ │ - WS chat         │ │ - Telegram     │
│ - future CC/Codex    │ │ - HTTP /v1/*      │ │ - Signal       │
│ - native/web clients │ │ - auth/status     │ │ - Discord      │
└──────────┬───────────┘ └─────────┬────────┘ │ - Slack        │
           │                       │          └────────┬───────┘
           └──────────────┬────────┴───────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      MindStone Core                          │
│ identity | config | transcript | routing | SCRI | memory      │
│ channel contract | wizard contract | provider abstraction      │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         Storage                              │
│ workspace files | journals/docs/wiki | vectors | sessions      │
│ channel state | secrets by env/token file/keychain where used   │
└─────────────────────────────────────────────────────────────┘
```

## 3. Major Components

### 3.1 MindStone Core

Core is a TypeScript package or internal module set that contains no Pi TUI assumptions and no daemon-specific socket loops.

Core responsibilities:

- identity model and workspace layout
- config schema and migration primitives
- memory source abstractions
- vector recall interfaces
- SCRI context selection/injection
- transcript model and session key semantics
- channel plugin contract
- wizard/prompter contract
- shared security policy logic
- route resolution and delivery context semantics

Core should be boring, typed, and heavily tested. It is where MindStone semantics live.

### 3.2 Gateway Daemon

The Gateway is the always-on runtime process. It should consume Core and own long-running work.

Gateway responsibilities:

- WebSocket RPC server for WebChat/control clients
- OpenAI-compatible `/v1/chat/completions`
- OpenResponses-compatible `/v1/responses`
- auth, rate limiting, and trusted proxy handling
- channel monitors for Telegram, Signal, Discord, Slack, etc.
- session/transcript persistence
- inbound message routing to agents/substrates
- outbound delivery through channel plugins
- daemon install/status/restart behavior

The Gateway should be able to run while Pi is closed. Pi should be a client/control surface, not the only runtime.

### 3.3 Current-Pi Adapter and Runtime Runner

The Pi adapter integrates MindStone into current Pi through extensions, commands, tools, context injection, TUI UI APIs, and — for real model execution — Pi's `AgentSession` / `SessionManager` runtime.

This is load-bearing. MindStone-Agent uses Pi for a reason: to leverage Pi's rich harness behavior instead of rebuilding a coding-agent harness from scratch. A raw model completion path may exist as a scaffold or fallback diagnostic, but it is not the target runtime for MVP chat.

Pi adapter/runtime responsibilities:

- load identity/user/core memory context into Pi prompts
- provide slash commands for setup, status, recall, checkpoint/handoff, and Gateway/channel control
- expose tools for memory read/search and optional Gateway/channel operations
- run onboarding/settings wizard via Pi `ctx.ui`
- execute real chat/model turns through Pi `AgentSession` and `SessionManager`, not only through provider-level `completeSimple` calls
- preserve Pi tool loops, custom tools, extension lifecycle, streaming/event semantics, prompt hooks, and compaction/control capabilities wherever compatible with MindStone continuity
- handle Pi lifecycle events such as session start, compaction, and shutdown where useful
- archive current Pi transcript into MindStone memory pipeline

Pi adapter should not own production channel listeners. It may include dev/test utilities for local channel calls, but the Gateway owns continuous operation. The Gateway may host a headless/session-backed Pi runner, analogous to current MindStone's embedded Pi runner, so non-Pi surfaces can still benefit from Pi's harness features.

### 3.4 Channel Plugins

Existing channel plugins are close to the right conceptual model. They should be preserved as contracts, but the dependency direction should be cleaned up.

A channel plugin should provide:

- `id`, label, docs metadata, capabilities
- config schema and account resolution
- onboarding adapter
- pairing/allowlist security behavior
- status/probe/audit behavior
- outbound send functions
- Gateway start/stop monitor hooks
- threading/mention/group policy behavior
- directory resolution where supported
- message actions where supported

The plugin should depend on Core contracts and runtime services, not on a monolithic `mindstone/plugin-sdk` that re-exports unrelated internals.

### 3.5 Memory and SCRI

Memory design must preserve MindStone's distinction from ordinary RAG.

Memory sources:

- identity and user files
- structured MS4-style memory files with `memory/MEMORY.md` index
- narrative journals
- `LOG.md` checkpoint/session ledger
- docs/wiki/project memory
- raw and compacted transcripts
- explicit checkpoints
- channel transcripts where configured

See `MEMORY_STRATEGY.md` for the detailed strategy: standing context stays thin, auto-recall is ephemeral per turn, and on-demand recall reads full sources when needed.

Memory services:

- source discovery
- chunking and metadata
- embedding and vector write
- semantic search
- salience/resonance scoring
- deduplication
- context budget allocation
- injection formatting

Context management must support two selectable modes:

- `auto_compact` — Pi/Claude-style checkpoint/handoff before native compaction, then post-compaction handoff replay and deferred indexing.
- `sliding_window` — MindStone proper behavior: when active prompt utilization reaches a ceiling percentage of the current model context window, older messages are pruned from the active prompt window down toward a floor percentage while preserving the full transcript.

Sliding-window pruning must never delete transcript entries. It only changes what is sent to the model. SCRI/vector recall can reintroduce relevant older material without keeping the entire transcript in context.

Dream-cycle behavior should run at compaction/session/pruning boundaries and should be callable manually for backfill and recovery.

## 4. Onboarding and Settings UX

The current MindStone wizard already uses a `WizardPrompter` concept. The rebuild should formalize that as a Core interface and implement adapters for Pi and any future CLI/web UI.

### 4.1 Wizard interface

Core-level wizard code should only depend on operations like:

- `intro(title)`
- `outro(message)`
- `note(message, title?)`
- `confirm({ message, initialValue })`
- `select({ message, options, initialValue })`
- `text({ message, placeholder, initialValue, validate })`
- `progress(label)`

Pi can implement these with `ctx.ui` primitives. Richer settings screens can use `ctx.ui.custom()` and `@earendil-works/pi-tui` components when a form/selector benefits from keyboard navigation.

### 4.2 Setup sections

The wizard should remain sectioned:

- workspace
- provider/model
- gateway/auth
- channels
- memory/SCRI
- identity
- behavior/style
- skills
- daemon/service install

Each section should be re-runnable independently.

### 4.3 Secret handling

Secrets should prefer token files, environment variables, OS keychain/secret store where available, or local config files excluded from git. The wizard should avoid displaying secrets after entry and should mark sensitive fields in any schema UI hints.

## 5. Channel Design

The Gateway loads active channel plugins and starts enabled accounts. Channels should be independently configured and independently restartable.

### 5.1 Telegram first

Telegram is the best first channel because it has a comparatively simple Bot API setup and clear token-based onboarding.

Preserve:

- bot token setup or env token
- polling/webhook mode
- DM pairing/allowlist
- group policy and mention gating
- thread IDs
- media/polls where already supported
- status/probe and duplicate-token detection

### 5.2 Discord and Slack next

Discord and Slack both validate the plugin contract under richer workspace behaviors: guild/channel allowlists, threads, mentions, reactions, slash commands/components, and live directory resolution.

### 5.3 Signal after external dependency handling

Signal depends on `signal-cli` or a local HTTP bridge. The product should support it, but the implementation plan should treat dependency detection, install guidance, and account linking as explicit work rather than assuming it is just another token channel.

## 6. WebChat and OpenWebUI Design

WebChat is an internal Gateway surface. It should stay separate from deliverable outbound channels.

Gateway WebSocket should support:

- `chat.history`
- `chat.send`
- `chat.abort`
- `chat.inject`
- status/health/presence events as needed

External HTTP clients should use:

- `POST /v1/chat/completions` for OpenAI-compatible clients such as OpenWebUI
- `POST /v1/responses` for newer item/tool-oriented clients

For OpenWebUI, the intended design is not a special bespoke integration at first. It should be configured as an OpenAI-compatible provider using the Gateway base URL and bearer token. If validation shows gaps, add compatibility shims at the Gateway HTTP layer rather than in Pi.

Gateway/OpenWebUI requests should still route into the same MindStone runtime semantics as native chat. The model turn should ultimately use the session-backed Pi runner when the selected agent/substrate is Pi-backed, so OpenWebUI/WebChat/Telegram do not silently lose Pi tools, extension behavior, or session lifecycle features.

## 7. Data and Storage Design

Recommended logical storage:

```text
~/.mindstone/
  config.toml or config.json5
  agents/
    <agent-id>/
      IDENTITY.md
      USER.md or PROFILE.md
      memory/
      journals/
      docs/
      transcripts/
      vectors/
  sessions/
  channels/
    telegram/
    signal/
    discord/
    slack/
  logs/
  tokens/ or token-file references
```

Exact paths can preserve current MindStone defaults where compatibility matters. Pi-specific state should be under Pi's own data root only when it is truly Pi-local. Shared MindStone identity/memory should not be trapped under Pi session paths.

## 8. Security Design

Security defaults:

- Gateway auth enabled by default.
- HTTP endpoints disabled unless explicitly enabled.
- DM policies default to pairing or allowlist.
- Group/channel policies are explicit and visible in status/audit output.
- Token values are not logged.
- Config migrations preserve secrets without printing them.
- Private memory, transcripts, vector DBs, and local config are ignored by git.

The system should fail closed: invalid auth, invalid config, or unsafe channel policy should block startup or emit a prominent warning depending on severity.

## 9. Migration Strategy

The safest path is extraction, not blind porting.

1. Identify stable concepts in existing MindStone.
2. Extract Core contracts and pure services.
3. Make existing Gateway depend on Core contracts.
4. Build current-Pi adapter and session-backed Pi runner against Core/Gateway.
5. Port channel plugins by replacing monolith imports with Core/runtime service imports.
6. Keep feature parity tests around memory, WebChat, and channels.
7. Remove or quarantine OpenClaw-era code only after replacement paths are proven.

## 10. Design Decisions

### Decision: Gateway remains always-on

Rationale: channel listeners, webhooks, WebChat, and OpenWebUI access need a stable process independent of Pi's interactive session lifecycle.

### Decision: Pi is an adapter, not the product boundary

Rationale: MindStone must support multiple substrates and clients. Pi is important, but not the only surface.

### Decision: Wizard logic is Core, presentation is adapter-specific

Rationale: setup semantics should be shared, but each substrate has different UI affordances.

### Decision: Preserve channel plugin shape but clean dependency direction

Rationale: the existing channel plugin model is valuable; the problem is coupling, not concept.

### Decision: OpenWebUI uses OpenAI-compatible HTTP first

Rationale: the existing Gateway endpoint is already aligned with how OpenWebUI usually integrates custom backends; bespoke work should wait for validation evidence.

## 11. Open Questions

1. Should Core be a separate package inside the repo or a clean internal module boundary first?
2. Should Gateway invoke Pi as an agent runtime, or should Pi primarily control/configure Gateway while Gateway owns its own runner?
3. How much session compatibility with old MindStone transcripts is required for first release?
4. Should LanceDB remain the primary vector backend, or should sqlite-vec/local alternatives be supported in Core from the start?
5. Which channel defines MVP after Telegram: Discord or Slack?
6. Should OpenResponses be positioned as primary and Chat Completions as legacy-compatible, or should both remain equal public surfaces?

## 12. Review Plan

- Clint reviews product scope and cut line.
- Cairn reviews substrate boundaries, MS4CC/MS4PI parity, memory lifecycle, and compaction behavior.
- Hearth reviews daemon/service install, token handling, logging, and operational safety.
- Channel-specific implementation can be reviewed after the Core contract is approved.
