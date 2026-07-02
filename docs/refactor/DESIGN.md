# Design: MindStone Core Rebuild on Current Pi

**Project:** MindStone
**Date:** 2026-06-16
**Status:** Draft for review
**Related PRD:** `PRD.md`
**Related architecture:** `ARCHITECTURE.md`
**Related sensitive-routing design:** `SENSITIVE_CONTEXT_ROUTING.md`

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
│ knowledgebases | skills | workflows | personas                │
│ channel contract | wizard contract | provider abstraction      │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         Storage                              │
│ workspace files | journals/docs/wiki | knowledgebases | vectors│
│ sessions | personas | channel state | secrets by env/token refs │
└─────────────────────────────────────────────────────────────┘
```

## 3. Major Components

### 3.1 MindStone Core

Core is a TypeScript package or internal module set that contains no Pi TUI assumptions and no daemon-specific socket loops.

Core responsibilities:

- identity model and workspace layout
- config schema and migration primitives
- memory source abstractions
- knowledgebase source/catalog/index abstractions
- vector recall interfaces
- SCRI context selection/injection
- transcript model and session key semantics
- channel plugin contract
- skill definitions, skill-builder contracts, and skill loading metadata
- workflow definitions, workflow-builder contracts, and workflow execution metadata
- persona definitions, persona-builder contracts, and persona activation metadata
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

### 3.6 Knowledgebases

Knowledgebases should be a separate continuity/reference layer from memories and journals.

A **structured memory** is something the agent should remember as durable operational knowledge, preference, lesson, design decision, correction, or project fact.

A **journal** is narrative experiential continuity: what unfolded, what mattered, and what texture should be preserved.

A **knowledgebase** is supplemental reference material provided by the user or a pack: documents, URLs, manuals, policies, standards, code docs, case libraries, threat reports, product docs, or domain corpora. It is knowledge the agent can consult, not lived agent experience.

This distinction matters:

```text
memory shapes future judgment
journals preserve experience
knowledgebases provide reference material
```

Knowledgebase ingestion should preserve source metadata:

- KB id/name/version;
- source URI/path;
- document title/type;
- source timestamp and refresh policy;
- chunking/index status;
- sensitivity labels;
- owner/pack/persona reference;
- citation metadata;
- summaries at document and KB level.

There are several possible integration modes:

1. **Dedicated KB vector index** — KB chunks live in a separate index; the agent searches KBs manually or through tools when needed.
2. **Summary/index vectorization** — KB summaries and an index-of-indexes are available to Auto Recall, while full KB chunks stay in a dedicated KB store.
3. **Unified recall substrate** — KB chunks participate in Auto Recall alongside memory/transcripts, useful for tightly scoped SME agents.
4. **Configurable hybrid** — users/personas choose per-KB behavior.

Recommended default:

```text
Use KB summaries/pointers in Auto Recall.
Keep full KB chunks in a dedicated KB index.
Let the agent deliberately search KBs when the summary/pointer indicates relevance.
```

Reasoning:

- prevents large reference corpora from drowning out lived memory and transcript recall;
- keeps source semantics clear;
- supports large document collections;
- allows SME agents/personas to opt into stronger KB integration;
- keeps user choice open.

Skills and workflows can declare KB dependencies:

```text
workflow incident-response-triage requires KBs: nist-800-61, org-ir-runbook
skill ot-threat-analysis uses KBs: cisa-ics-advisories, dragos-threat-groups
```

Open design space remains around whether KB summary records should be indexed into the same SQLite memory store as memories/transcripts or into a separate catalog table. The design invariant is more important than the first storage choice:

```text
A knowledgebase hit must be labeled as reference material, not memory.
```

### 3.7 Skills and Workflow Builders

MindStone-Agent should treat skills and workflows as durable, inspectable agent capability artifacts.

A **skill** is a reusable capability package: instructions, triggers, constraints, examples, validation steps, and optional tool/workflow references. Skills are useful when the agent repeatedly performs a recognizable task and should stop re-deriving the same procedure every time.

A **workflow** is a reusable multi-step process: ordered or conditional steps, inputs, outputs, tools, routes, approval gates, loops/retries, failure handling, and validation criteria. Workflows are useful when the agent needs to execute a recurring process rather than only remember how to do a task.

The relationship:

```text
skills teach the agent how to do a class of work
workflows organize repeated multi-step execution
skills can call workflows
workflows can call skills
```

MindStone should ship a default **Skill Builder** skill. The Skill Builder helps the agent create new skills when:

- the user explicitly asks for a skill;
- the agent notices repetitive work and proposes one;
- a workflow needs a reusable capability that does not yet exist.

MindStone should also ship or support a **Workflow Builder** capability. The Workflow Builder helps the agent create process artifacts when:

- the user describes a repeatable procedure;
- the agent notices repeated multi-step work;
- a recurring task needs approval gates, retries, loops, or validation;
- an integration, channel process, checkpoint ritual, incident-response procedure, or TestFlight-style workflow should become reusable.

Workflows are not new as a concept; loops are one popular expression of an older workflow/harness pattern. MindStone should avoid treating “loops” as magic. The product should expose workflows as durable, user-editable process definitions that may include loop/retry conditions where useful.

Skill/workflow creation should follow approval discipline:

```text
observe or receive request
→ draft skill/workflow artifact
→ explain trigger/scope/safety gates
→ ask approval unless policy explicitly allows auto-write
→ write/version artifact
→ index/discover/load where supported
→ record transcript/LOG event
```

Recommended artifact locations:

```text
skills/
  <skill-id>/SKILL.md
  <skill-id>/metadata.json

workflows/
  <workflow-id>.workflow.json
  <workflow-id>.md
```

A skill artifact should include:

- id/name/version;
- description;
- when to use;
- when not to use;
- required inputs;
- procedure/instructions;
- safety/approval rules;
- validation checklist;
- related workflows/tools;
- examples.

A workflow artifact should include:

- id/name/version;
- description;
- trigger conditions;
- inputs/outputs;
- step graph or ordered steps;
- tool/route requirements;
- skill references;
- approval gates;
- loop/retry conditions;
- failure handling;
- validation and completion criteria;
- transcript/event reporting policy.

The existing Integration Builder is an initial built-in skill example. It should not be treated as the whole skill system.

### 3.8 Personas and Persona Packs

A persona is an identity supplement package. It should not overwrite the agent’s core identity. It temporarily or permanently layers role/domain behavior, skills, workflows, knowledgebases, tools, and safety rules onto an agent.

Personas are likely to be a major MindStone differentiator alongside Layered Continuity Architecture.

The conceptual model:

```text
core agent identity = who the agent is
persona = a scoped capability/role overlay
agent pack = deployable runtime + default agent/persona stack
persona pack = reusable persona package that can attach to compatible agents
```

A persona can be:

- **permanent** — always active for this agent;
- **profile-scoped** — active because the agent is a CTI agent, software engineer, coach, etc.;
- **session-scoped** — active for the current session;
- **task-scoped** — active for a specific workflow or request;
- **on-demand** — activated by user request or workflow need.

Recommended artifact layout:

```text
personas/
  <persona-id>/
    PERSONA.md
    metadata.json
    skills.json
    workflows.json
    knowledgebases.json
    safety.md
```

`PERSONA.md` should describe:

- purpose and scope;
- behavioral stance;
- expertise/domain boundaries;
- when to activate;
- when not to activate;
- relationship to core identity;
- safety and disclosure constraints;
- required skills/workflows/KBs;
- optional skills/workflows/KBs;
- route/model preferences if any.

Persona Builder should let a user or agent:

1. define persona purpose and scope;
2. pick existing skills;
3. pick existing workflows;
4. pick existing knowledgebases;
5. invoke Skill Builder / Workflow Builder / Knowledgebase ingestion just-in-time if needed;
6. define activation policy;
7. define safety boundaries;
8. preview the persona overlay;
9. approve and install.

Persona activation should be visible in transcript/status surfaces:

```text
persona_activated
persona_deactivated
persona_scope_changed
```

Core prompt assembly should treat persona context as an explicit layer with precedence rules. A persona may supplement the agent’s identity, but it should not silently contradict core identity, user safety rules, or active higher-priority policy.

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
- knowledgebases
- identity
- behavior/style
- skills
- workflows
- personas
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
      knowledgebases/
      skills/
      workflows/
      personas/
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
- Sensitive context routing should prevent raw sensitive sources from reaching routes without clearance, and should use a declassification bridge before derived sensitive output crosses back to lower-trust/default routes. See `SENSITIVE_CONTEXT_ROUTING.md`.

The system should fail closed: invalid auth, invalid config, unsafe channel policy, or unsafe sensitive-route policy should block startup or emit a prominent warning depending on severity.

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

### Decision: Skills and workflows are durable artifacts, not hidden prompt tricks

Rationale: users and agents need to inspect, approve, edit, version, and audit reusable capabilities. A skill or workflow should not silently become active just because the model improvised it once in conversation.

### Decision: Knowledgebases are reference sources, not memories

Rationale: documents, URLs, and domain corpora are supplemental knowledge. They should preserve source/citation semantics and should not be confused with the agent’s lived transcript, structured memories, journals, or checkpoints.

### Decision: Personas are identity supplements, not identity replacements

Rationale: personas can package powerful role/domain behavior, skills, workflows, and KBs, but the core persistent identity must remain coherent. Persona activation should be scoped, auditable, and reversible unless deliberately configured as permanent.

## 11. Open Questions

1. Should Core be a separate package inside the repo or a clean internal module boundary first?
2. Should Gateway invoke Pi as an agent runtime, or should Pi primarily control/configure Gateway while Gateway owns its own runner?
3. How much session compatibility with old MindStone transcripts is required for first release?
4. Should LanceDB remain the primary vector backend, or should sqlite-vec/local alternatives be supported in Core from the start?
5. Which channel defines MVP after Telegram: Discord or Slack?
6. Should OpenResponses be positioned as primary and Chat Completions as legacy-compatible, or should both remain equal public surfaces?
7. What artifact schema should Skill Builder use for local skills, Pi-compatible skills, and future Agent Packs?
8. What artifact schema should Workflow Builder use for loops, gated procedures, recurring jobs, and TestFlight-style workflows?
9. Which skills/workflows may be auto-enabled by policy, and which require explicit approval before activation?
10. Should KB chunks live in a dedicated vector DB, a shared vector DB with source-kind filtering, or a hybrid summary-pointer model by default?
11. How should KB refresh, citation, and source invalidation interact with Auto Recall?
12. What are the precedence rules among core identity, permanent persona, task persona, workflow instructions, user instruction, and safety policy?
13. How should Persona Packs be distributed independently from full Agent Packs?

## 12. Review Plan

- Clint reviews product scope and cut line.
- Cairn reviews substrate boundaries, MS4CC/MS4PI parity, memory lifecycle, and compaction behavior.
- Hearth reviews daemon/service install, token handling, logging, and operational safety.
- Channel-specific implementation can be reviewed after the Core contract is approved.
