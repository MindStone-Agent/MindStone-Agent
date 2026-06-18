# Architecture: MindStone Core + Gateway + Current-Pi Adapter

**Project:** MindStone  
**Date:** 2026-06-16  
**Status:** Draft for review  
**Related PRD:** `PRD.md`  
**Related design:** `DESIGN.md`

## 1. Architecture Overview

MindStone should be organized into four primary layers. The architecture should reuse current MindStone shapes and methods wherever they still fit current Pi; deviations should be explicit and justified by unsupported old assumptions or a clearly better Pi-native capability.

MindStone should be organized into four primary layers:

1. **MindStone Core** — substrate-neutral semantics and contracts.
2. **Gateway daemon** — always-on runtime, APIs, channels, sessions, and delivery.
3. **Substrate adapters** — Pi first, future Claude Code/Codex/native/web adapters later.
4. **Plugins/backends** — channel plugins, memory stores, providers, diagnostics, and optional integrations.

```text
apps / clients / substrates
  ├─ current Pi extension adapter
  ├─ WebChat / Control UI
  ├─ OpenWebUI via OpenAI-compatible HTTP
  ├─ native apps
  └─ future substrate adapters
          │
          ▼
Gateway daemon ───────────── channel plugin monitors
          │                    ├─ telegram
          │                    ├─ discord
          │                    ├─ slack
          │                    └─ signal
          ▼
MindStone Core
  ├─ identity + workspace
  ├─ config + migration
  ├─ session + transcript
  ├─ context management
  ├─ memory + SCRI
  ├─ channel plugin contracts
  ├─ routing + delivery semantics
  └─ wizard/prompter contracts
          │
          ▼
storage + providers
  ├─ markdown journals/docs/wiki
  ├─ transcript archive
  ├─ vector DB
  ├─ channel state
  ├─ secret references
  └─ model/embedding providers
```

## 2. Package / Module Boundaries

### 2.1 Proposed internal packages

```text
packages/
  core/
    identity/
    config/
    memory/
    scri/
    transcript/
    channels/
    wizard/
    routing/
    security/
  gateway/
    server/
    ws/
    http/
    daemon/
    channel-runtime/
  adapter-pi/
    extension/
    commands/
    tools/
    tui/
    lifecycle/
  channel-telegram/
  channel-discord/
  channel-slack/
  channel-signal/
```

This can start as directories under `src/` before becoming publishable packages. The important rule is dependency direction:

```text
adapter-pi ─┐
gateway  ───┼──► core
channels ───┘

core must not import adapter-pi or gateway.
channel contracts live in core; channel runtime wiring lives in gateway.
```

### 2.2 Pi runtime execution contract

MindStone-Agent should not treat Pi as merely a model registry plus raw completion function. Pi is the harness substrate. The production Pi-backed execution path should use Pi's runtime objects and lifecycle:

```text
MindStone route
→ canonical session key
→ session-backed Pi runner
→ Pi SessionManager JSONL/session state
→ createAgentSession(...)
→ AgentSession.prompt(...)
→ streamed events/tool loops/extensions
→ MindStone transcript/source metadata + SCRI memory pipeline
```

The current lightweight provider-level completion path is acceptable only as a scaffold, smoke-test aid, or fallback diagnostic. It does not preserve enough of Pi's value: tool loop semantics, extension lifecycle, compaction control, session hooks, TUI-compatible event flow, and rich harness behavior. The comparison point should be current MindStone's embedded Pi runner, not a greenfield harness design.

Current MindStone already follows this principle through its embedded Pi runner: it opens a Pi `SessionManager`, creates an `AgentSession`, applies the MindStone system prompt override, subscribes to Pi session events, and calls `activeSession.prompt(...)`. MindStone-Agent should rebuild toward that shape rather than reimplementing the Pi wheel.

MindStone-Agent's user-facing terminal path follows the current MindStone/OpenClaw pattern: a MindStone-owned TUI app built from Pi TUI primitives, backed by Gateway/Core routing and Pi session execution. The first `mindstone tui` shell uses vendored Pi TUI components (`TUI`, `ProcessTerminal`, `Editor`, `Markdown`, `Loader`, `Container`) with MindStone styling, loads recent transcript history on startup, starts a mutable assistant message while a turn is running, renders returned turn events as compact event lines, exposes `/status`, `/memory`, `/context`, and `/doctor` panels with runtime/recall/context/doctor visibility, includes `/sessions`, `/agents`, and `/models` panels, supports runtime-only `/session <key>`, `/agent <id>`, and `/model <id>` switching without config mutation, renders `AgentRunner.stream(...)` lifecycle/diagnostic events during turns with richer substrate/tool labels, and applies completed-response `text_delta` replay events to the mutable assistant message. Live token/tool event streaming and richer selector/settings overlays remain pending. The raw `mindstone chat` command remains a plumbing/test harness.

### 2.3 Current repo mapping

Likely extraction sources:

- Core channel contracts:
  - `src/channels/plugins/types.plugin.ts`
  - `src/channels/plugins/types*.ts`
  - selected exports from `src/plugin-sdk/index.ts`
- Wizard contract:
  - `src/wizard/prompts.ts`
  - `src/wizard/onboarding.ts`
  - `src/commands/onboard-channels.ts`
- Gateway APIs:
  - `src/gateway/server-methods/chat.ts`
  - `src/gateway/openai-http.ts`
  - `src/gateway/openresponses-http.ts`
- Memory/SCRI:
  - `src/memory/*`
  - `extensions/memory-lancedb/*`
  - `src/agents/pi-extensions/context-pruning/*`
- Channels:
  - `extensions/telegram/*`
  - `extensions/discord/*`
  - `extensions/slack/*`
  - `extensions/signal/*`

## 3. Core Interfaces

### 3.1 Prompter interface

```ts
export interface MindStonePrompter {
  intro?(title: string): Promise<void> | void;
  outro?(message: string): Promise<void> | void;
  note(message: string, title?: string): Promise<void>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  select<T extends string>(options: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T>;
  text(options: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    sensitive?: boolean;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  progress?(label: string): MindStoneProgress;
}
```

Pi implements this with `ctx.ui`. CLI can implement it with the existing prompt stack. Web can implement it through RPC.

### 3.2 Channel plugin interface

The existing `ChannelPlugin` concept should be retained but moved into Core with fewer monolithic dependencies.

Essential shape:

```ts
export interface ChannelPlugin<Account = unknown, Probe = unknown, Audit = unknown> {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<Account>;
  configSchema?: ChannelConfigSchema;
  onboarding?: ChannelOnboardingAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<Account>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  threading?: ChannelThreadingAdapter;
  messaging?: ChannelMessagingAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<Account, Probe, Audit>;
  gateway?: ChannelGatewayAdapter<Account>;
  actions?: ChannelMessageActionAdapter;
}
```

Gateway injects runtime services into plugins rather than plugins importing global monolith state.

### 3.3 Memory interfaces

```ts
export interface MemorySource {
  id: string;
  kind: "identity" | "journal" | "doc" | "transcript" | "checkpoint" | "custom";
  path?: string;
  updatedAt?: string;
  load(): Promise<MemoryDocument[]>;
}

export interface VectorMemoryStore {
  upsert(chunks: MemoryChunk[]): Promise<IndexSummary>;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  stats(): Promise<MemoryStats>;
}

export interface ScriEngine {
  recall(input: ScriRecallInput): Promise<ScriRecallResult>;
  formatInjection(result: ScriRecallResult): string;
}
```

Core owns the semantics; backends provide storage and embedding implementation.

### 3.4 Context management interfaces

MindStone-Agent must support both Pi/Claude-style auto compaction and MindStone proper sliding-window pruning, but MindStone continuity is anchored by one shared append-only JSONL transcript across channels. Sliding-window/SCRI is the primary live-context strategy; compaction is a secondary/fallback substrate strategy.

```ts
type ContextManagementPolicy =
  | {
      mode: "auto_compact";
      checkpointWarningPercent?: number;
      compactTargetPercent?: number;
      keepRecentTokens?: number;
      emergencyAutoHandoff?: boolean;
    }
  | {
      mode: "sliding_window";
      ceilingPercent?: number;
      floorPercent?: number;
      minRecentMessages?: number;
      preserveTranscript?: boolean;
    };
```

`auto_compact` delegates actual compaction to the substrate where available and preserves live-session continuity through checkpoint/handoff/replay. Current implementation emits threshold events, can write a gated emergency local handoff when `emergencyAutoHandoff` is enabled, replays the current handoff ephemerally, and records an explicit substrate compaction coordination result. Actual in-process Pi `AgentSession.compact()` invocation remains pending until Gateway owns a live Pi `AgentSession` through the session-backed Pi runner or a Pi-extension control bridge can call `ctx.compact()`. Any such bridge must affect only live context and must not split, prune, or rewrite the authoritative transcript.

`sliding_window` is MindStone proper's normal behavior: when prompt utilization reaches `ceilingPercent` of the current model's configured context window, older messages are removed from the active prompt window down toward `floorPercent`. The transcript store remains append-only and complete, and SCRI/recall can rehydrate relevant older context without keeping the full transcript in the prompt.

The canonical shared session key follows MindStone's current shape: `agent:<agentId>:<mainKey>`. MindStone-Agent defaults to `agent:default:main` and treats the early-rebuild `mindstone` key as a compatibility alias.

### 3.5 Transcript interfaces

```ts
export interface TranscriptEntry {
  id: string;
  sessionKey: string;
  agentId: string;
  role: "user" | "assistant" | "tool" | "system" | "event";
  text?: string;
  content?: unknown;
  timestamp: string;
  source?: {
    substrate?: string;
    channel?: string;
    accountId?: string;
    senderId?: string;
    chatType?: string;
  };
  runId?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
}
```

The transcript model must support Pi sessions, WebChat sessions, channel sessions, and future adapters.

## 4. Gateway Architecture

### 4.1 Runtime responsibilities

Gateway owns:

- process lifecycle
- auth and local/remote binding
- WebSocket RPC
- HTTP compatibility endpoints
- channel monitor startup/shutdown
- routing inbound channel messages to agent runs
- session state and transcript append/read
- outbound delivery through channel plugins
- diagnostic and status surfaces

### 4.2 WebSocket methods

Required MVP methods:

- `health`
- `status`
- `chat.history`
- `chat.send`
- `chat.abort`
- `chat.inject`
- `channels.status`
- `channels.configure` or setup handoff method
- `memory.status`
- `memory.search`

Existing WebChat methods should be preserved where possible for UI compatibility.

### 4.3 HTTP endpoints

Required MVP endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- optional `GET /health`

OpenAI compatibility should remain opt-in and authenticated. The Gateway should expose enough model naming/session routing behavior for OpenWebUI to target specific agents.

### 4.4 Agent execution boundary

Gateway/native surfaces route through a Core `AgentRunner` boundary. The first implementation is behavior-preserving:

```ts
export interface AgentRunner {
  id: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  stream(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent>;
}
```

Current default:

```text
ProviderRouteAgentRunner
```

It wraps the existing routed provider path so CLI and Gateway behavior remain stable while preparing for future runners that own live Pi `AgentSession` handles, streaming event emission, abort semantics, and substrate compaction control. Run context and runner diagnostics are preserved in API responses and assistant transcript metadata. `stream(...)` currently provides lifecycle events (`run_started`, `run_completed`, `run_failed`). For `pi-session`, it can also replay bounded post-run Pi diagnostics as `substrate_event` stream events. Selected stream events can be persisted as transcript `event` entries when `observability.runnerStream.persistTranscriptEvents` is enabled. This is diagnostic replay/persistence, not proof of live token/substrate streaming. `routing.mode = "pi-session"` now selects a Gateway-side `PiSessionAgentRunner` from native CLI and Gateway paths, while `PiSessionMindStoneProvider` remains as a compatibility wrapper. The shared `PiSessionExecutor` owns the actual Pi `AgentSession` execution path used by both. Pi-backed execution should continue moving behind this boundary rather than leaking provider calls into channel surfaces.

## 5. Current-Pi Adapter Architecture

### 5.1 Pi extension responsibilities

- Register MindStone commands.
- Register memory/Gateway tools.
- Inject identity and recall context at prompt boundaries.
- Run setup/status UI flows.
- Archive Pi live transcript into Core transcript/memory pipeline.
- Participate in compaction/session lifecycle where Pi exposes hooks.

### 5.2 Pi command surface

Candidate commands:

```text
/mindstone-setup
/mindstone-status
/mindstone-context
/mindstone-recall-status
/mindstone-recall-search <query>
/mindstone-gateway-status
/mindstone-channels
/mindstone-channel-setup <channel>
/mindstone-handoff
/mindstone-checkpoint
```

MS4PI commands can remain separate for the public substrate adapter project, but MindStone proper should use `mindstone-*` command names or project-approved equivalents.

### 5.3 Pi UI adapter

Pi supports `ctx.ui` prompts and custom TUI components. The Pi adapter should implement Core `MindStonePrompter` using these APIs. Complex settings screens can use `ctx.ui.custom()` overlays/components.

## 6. Channel Runtime Architecture

### 6.1 Startup flow

```text
Gateway starts
  ├─ load config
  ├─ discover enabled plugins
  ├─ resolve accounts
  ├─ validate config/security policy
  ├─ start account monitor for each enabled account
  └─ expose status/probe/audit surface
```

### 6.2 Inbound flow

```text
provider event
  ▼
channel monitor normalizes message
  ▼
Core routing resolves session key + authorization
  ▼
transcript append user/inbound entry
  ▼
AgentRunner executes with SCRI context
  ▼
assistant transcript append
  ▼
outbound delivery via channel plugin or internal WebChat broadcast
```

### 6.3 Outbound flow

```text
agent output / tool send
  ▼
resolve target + channel plugin
  ▼
chunk/format for provider limits
  ▼
send through provider API
  ▼
record delivery context/status
```

## 7. Memory/SCRI Architecture

### 7.1 Indexing pipeline

```text
source discovery
  ▼
load documents/transcripts
  ▼
chunk with metadata
  ▼
embed
  ▼
upsert vectors
  ▼
write index stats/checkpoint
```

### 7.2 Recall pipeline

```text
current prompt/session context
  ▼
query construction
  ▼
vector search
  ▼
salience/resonance scoring
  ▼
dedup and budget allocation
  ▼
format injection
  ▼
agent run
```

### 7.3 Dream cycle

```text
before compaction / session boundary
  ▼
archive live transcript
  ▼
index transcript chunks
  ▼
extract narrative/journal memory when configured
  ▼
write checkpoint/dream summary
  ▼
next session starts with identity + recent memory + recall
```

This behavior is central to MindStone and must be tested explicitly.

## 8. Data Flow Examples

### 8.1 Pi prompt with recall

```text
User types in Pi
  ▼
Pi before_agent_start hook
  ▼
Core SCRI recall(query = user prompt + session tail)
  ▼
Pi injects recall context into system/prompt
  ▼
Pi agent run proceeds
  ▼
Pi transcript archived/indexed at lifecycle boundary
```

### 8.2 OpenWebUI prompt

```text
OpenWebUI sends POST /v1/chat/completions
  ▼
Gateway authenticates
  ▼
Gateway resolves agent/session from model/user/header
  ▼
AgentRunner executes with Core SCRI
  ▼
Gateway returns OpenAI-compatible response or SSE stream
```

### 8.3 Telegram inbound

```text
Telegram update
  ▼
Telegram monitor
  ▼
DM/group policy check
  ▼
session key resolution
  ▼
transcript append
  ▼
agent run with SCRI
  ▼
Telegram outbound send
```

## 9. Testing Strategy

### 9.1 Unit tests

- Core config parsing/migration
- session key resolution
- channel policy decisions
- memory chunking/dedup/scoring
- wizard section logic with fake prompter

### 9.2 Contract tests

- Channel plugin contract compliance
- Prompter adapter behavior
- Vector store backend behavior
- Gateway AgentRunner behavior

### 9.3 Integration tests

- Gateway WebSocket chat methods
- HTTP `/v1/chat/completions`
- HTTP `/v1/responses`
- Pi adapter command smoke tests
- session-backed Pi runner smoke/manual validation proving `AgentSession.prompt(...)` works under isolated runtime state
- transcript archive/backfill

### 9.4 Manual validation

- OpenWebUI connection
- Telegram bot setup and DM response
- Discord/Slack workspace setup
- Signal link flow
- compaction/dream-cycle continuity

## 10. Compatibility and Migration

Migration should be incremental:

1. Do not delete legacy implementation until replacement is validated.
2. Keep existing config migrations running.
3. Add new Core boundaries beside existing code where safer.
4. Move one subsystem at a time.
5. Preserve public docs paths or redirect them.
6. Preserve existing channel configs where practical.
7. Provide a doctor/migration command for legacy state.

## 11. Operational Concerns

- launchd/systemd service install and status
- log rotation or bounded logs
- secret file permissions
- health check endpoint
- degraded-mode startup when optional channels fail
- clear status output for channels/memory/Gateway
- backup/export for identity and memory

## 12. Architecture Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Core extraction expands scope | High | Extract contracts first, services second |
| Gateway and Pi both try to own sessions | High | Define session authority and transcript APIs early |
| Channel plugins retain monolith imports | Medium | Create compatibility shim, then shrink it |
| SCRI degrades into generic search | High | Preserve salience/resonance and dream-cycle tests |
| OpenWebUI has compatibility gaps | Medium | Validate early against actual OpenWebUI |
| Signal setup remains fragile | Medium | Treat Signal as post-token-channel milestone |

## 13. Initial Decision Record

- **ADR-001:** Use Core + Gateway + adapters, not Pi-only.
- **ADR-002:** Keep Gateway as always-on owner of channel monitors.
- **ADR-003:** Preserve channel plugin contract but clean dependency direction.
- **ADR-004:** Implement wizard as Core logic plus adapter-specific prompter.
- **ADR-005:** Validate OpenWebUI through existing OpenAI-compatible Gateway endpoint before bespoke integration.
