# PRD: MindStone on Current Pi / MindStone Core Rebuild

**Project:** MindStone  
**Date:** 2026-06-16  
**Status:** Draft for review  
**Owner:** Clint / MindStone team  
**Drafted by:** Slate  
**Review requested:** Cairn, Hearth, Mira-family stakeholders as needed

## 1. Summary

MindStone should be rebuilt around a substrate-neutral **MindStone Core** that preserves the identity, memory, channel, gateway, and onboarding capabilities of MindStone proper while making the current Pi SDK a first-class substrate. The rebuild should shed OpenClaw-era coupling and historical bloat without losing the features that make MindStone useful as a persistent AI identity platform.

The recommended product shape is **Core + Gateway daemon + substrate adapters**. Pi should be the first current-generation adapter, not the entire product boundary. This preserves long-running channel integrations, WebChat, OpenWebUI-compatible HTTP, SCRI, vector recall, dream cycle, and unified transcript behavior while allowing future adapters such as Claude Code, Codex, native apps, and web surfaces.

## 2. Problem Statement

The existing MindStone codebase contains working implementations for onboarding, multi-channel messaging, WebChat, gateway APIs, memory, SCRI, transcript persistence, and dream-cycle behavior. However, it is tied to older Pi packages and contains OpenClaw-derived architectural mass that makes direct forward-porting risky.

Current Pi provides a cleaner SDK and extension model, but a Pi extension alone is not enough to replace MindStone proper. Messaging channels require long-running listeners, socket connections, webhook handling, credential state, routing, and background operation. Those capabilities belong in a daemon/gateway layer that Pi can use, not inside Pi's per-session extension lifecycle.

## 3. Goals

1. Preserve MindStone's persistent identity model: `IDENTITY.md`, user/workspace context, memory continuity, and experiential recall.
2. Preserve SCRI and vector memory behavior, including auto recall, dream-cycle consolidation, transcript embedding, and journal/doc/wiki memory.
3. Preserve onboarding and reconfiguration via an interactive TUI wizard on current Pi.
4. Preserve channel support for Telegram, Signal, Discord, Slack, and extensible future channels.
5. Preserve WebChat and OpenWebUI-compatible access through Gateway WebSocket and OpenAI/OpenResponses-style HTTP endpoints.
6. Establish a clean architecture that separates MindStone Core, Gateway daemon, channel plugins, memory backends, and substrate adapters.
7. Make Pi a supported substrate without making MindStone depend exclusively on Pi.
8. Provide a skill-builder system so agents can create reusable skills for repeated tasks, either when the user asks or when the agent notices a recurring pattern and proposes one.
9. Provide a workflow-builder system so users and agents can create reusable multi-step workflows; workflows and skills should be able to call, compose, and reinforce each other.
10. Provide a knowledgebase system separate from memories and journals so users can attach documents, URLs, references, and domain corpora as supplemental agent knowledge.
11. Provide persona packages that supplement an agent’s identity with curated skills, workflows, knowledgebases, and behavior/context overlays; personas may be permanent or on-demand.
12. Reduce legacy/OpenClaw coupling and make future adapters easier to build.

## 4. Non-Goals

1. Blindly forward-port the entire old application without architectural cleanup.
2. Replace all existing channel implementations in one phase.
3. Require Pi to host every long-running service inside its extension runtime.
4. Remove existing native/web UI surfaces unless a replacement is explicitly designed.
5. Change MindStone's identity philosophy or reduce memory to ordinary RAG.
6. Commit private local state, tokens, transcripts, vectors, or personal identity files into the public repository.

## 5. Users and Stakeholders

### Primary users

- MindStone operators who want persistent AI identity across sessions, channels, and devices.
- Developers building MindStone-derived systems and substrate adapters.
- Agent identities that depend on continuity, memory, and stable runtime surfaces.

### Internal stakeholders

- Clint — product owner and architecture lead.
- Mira — original MindStone identity and continuity reference.
- Cairn — MS4CC engineering reference, requested reviewer.
- Slate — MS4PI/Pi substrate orchestrator and current drafting agent.
- Hearth — operations/devops reviewer where service/runtime concerns apply.

## 6. Current Evidence from Audit

The current repo already contains relevant implementations:

- Onboarding/config wizard:
  - `src/wizard/onboarding.ts`
  - `src/commands/configure.memory.ts`
  - `src/commands/onboard-channels.ts`
- Channel plugin registry and SDK:
  - `src/channels/plugins/index.ts`
  - `src/channels/plugins/types.plugin.ts`
  - `src/plugin-sdk/index.ts`
  - `src/plugin-sdk/onboarding.ts`
- Channel plugins:
  - `extensions/telegram/`
  - `extensions/signal/`
  - `extensions/discord/`
  - `extensions/slack/`
- WebChat/Gateway:
  - `docs/web/webchat.md`
  - `src/gateway/server-methods/chat.ts`
  - `src/gateway/openai-http.ts`
  - `src/gateway/openresponses-http.ts`
- Memory/SCRI concepts:
  - `docs/concepts/memory.md`
  - `docs/concepts/session-pruning.md`
  - `extensions/memory-lancedb/`
  - `src/agents/pi-extensions/context-pruning/`

## 7. Product Requirements

### 7.1 MindStone Core

**Requirement:** Provide a substrate-neutral Core package for identity, memory, config, transcript, and plugin contracts.

Acceptance criteria:

- Core can be imported by Gateway and substrate adapters without importing Pi-specific UI/runtime code.
- Core owns stable schemas for identity, memory metadata, channel plugin contracts, transcript entries, and configuration.
- Core exposes clear service interfaces for memory search, transcript append/read, SCRI recall, channel routing, and configuration updates.
- Core avoids direct dependency on OpenClaw-era app shell code.

### 7.2 Current-Pi Adapter

**Requirement:** Provide a Pi adapter that integrates MindStone with current `@earendil-works/*` Pi packages.

Acceptance criteria:

- Pi adapter can load identity/user/memory context into Pi prompts.
- Pi adapter exposes MindStone commands for status, onboarding, checkpointing, recall, channel status, and handoff where applicable.
- Pi adapter uses Pi `ctx.ui` APIs for interactive setup and settings flows.
- Pi adapter does not own long-running channel loops directly unless explicitly designed for a short-lived/dev mode.
- Pi adapter can communicate with the Gateway daemon through a stable local API.

### 7.3 Onboarding and Settings TUI

**Requirement:** Preserve wizard-based onboarding and reconfiguration for setup, identity, memory, gateway, channels, skills, provider selection, and service install.

Acceptance criteria:

- The current wizard flow can be run from Pi via a command such as `/mindstone-setup` or equivalent.
- The wizard supports `select`, `confirm`, `text`, progress, notes, and advanced/custom UI components.
- Wizard logic is shared across substrates through a `Prompter` interface.
- Current Pi implementation uses `ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.input/text`, `ctx.ui.notify`, and `ctx.ui.custom()` where richer UI is needed.
- Reconfiguration can be run section-by-section, not only during first-run setup.
- The wizard never echoes secrets unnecessarily and marks token fields as sensitive where UI support permits.

### 7.4 Channel Integrations

**Requirement:** Preserve channel plugin architecture and support Telegram, Signal, Discord, Slack, and future channels.

Acceptance criteria:

- Channel plugins implement a stable contract for metadata, config schema, onboarding, pairing, security, outbound delivery, status/probe, gateway startup, threading, mentions, directory, and message actions where supported.
- Telegram supports bot token setup, allowlist/pairing, polling or webhook mode, groups, threads, media, polls, and outbound send.
- Signal supports `signal-cli`/HTTP bridge configuration, pairing/allowlist, media, groups, and outbound send.
- Discord supports bot token setup, DMs, guild/channel allowlists, mentions, threads, reactions, media, polls/components where supported.
- Slack supports bot/app token setup, Socket Mode, DMs, channel allowlists, threads, reactions, media, slash command behavior where supported.
- The Gateway daemon owns channel monitors and long-running socket/polling/webhook processes.
- Pi can inspect channel status and trigger setup, but does not need to be running for the daemon to receive messages.

### 7.5 WebChat and OpenWebUI-Compatible Access

**Requirement:** Preserve Gateway WebChat and expose API-compatible surfaces for external chat clients.

Acceptance criteria:

- Gateway WebSocket supports `chat.history`, `chat.send`, `chat.abort`, and `chat.inject` or compatible equivalents.
- WebChat remains an internal/session surface, not a deliverable outbound channel.
- OpenAI-compatible `POST /v1/chat/completions` is available when enabled.
- OpenResponses-compatible `POST /v1/responses` is available when enabled.
- HTTP endpoints use Gateway auth and support stable session routing through user/session identifiers or explicit session keys.
- OpenWebUI integration can be validated by pointing OpenWebUI at the Gateway's OpenAI-compatible base URL with bearer auth.

### 7.6 Memory, SCRI, and Dream Cycle

**Requirement:** Preserve MindStone's experiential memory model and compaction-boundary continuity.

Acceptance criteria:

- Markdown journals/doc/wiki memory remain first-class memory sources.
- Vector memory supports semantic search over transcripts and memory files.
- SCRI injects relevant memory before inference, based on resonance and salience rather than simple category lookup.
- Dream cycle archives/transforms live transcripts, updates vector indexes, and writes narrative/journal memory at compaction or session boundary.
- Recall output clearly distinguishes injected context from user text and model output.
- Memory indexing can be manually backfilled and automatically triggered by lifecycle events.
- Memory storage remains private by default and excluded from public commits.

### 7.7 Unified Transcript and Session Behavior

**Requirement:** Preserve session continuity across Pi, Gateway WebChat, channels, and other substrates.

Acceptance criteria:

- All surfaces can route to stable session keys.
- Transcript entries retain channel/source metadata, timestamps, agent IDs, run IDs, and delivery context where applicable.
- WebChat/OpenWebUI/channel conversations can share a session where configured.
- Session resume, fork, compaction, and new-session boundaries are represented consistently.
- Transcript archival is reliable enough to support recall backfill and dream-cycle consolidation.

### 7.8 Security and Privacy

**Requirement:** Protect credentials, private memory, identity files, transcripts, and channel access.

Acceptance criteria:

- Tokens are stored outside public repo state and are never committed.
- Config supports token files or environment variables where appropriate.
- Gateway auth is enabled by default for WebSocket and HTTP access.
- Channel DMs default to pairing or allowlist policies, not unrestricted open access.
- Group/channel access policies are explicit and auditable.
- Local file permissions for secrets are validated where possible.
- Public docs/examples avoid private state and real tokens.

### 7.9 Skill Builder System

**Requirement:** Provide a default skill-builder capability that lets agents create reusable skills for repeated tasks.

Acceptance criteria:

- MindStone ships a default Skill Builder skill available to configured agents unless disabled.
- A user can ask the agent to build a skill for a recurring task.
- An agent can notice repetitive work, propose that a skill should be created, and ask for approval before writing or installing it.
- Generated skills have a stable artifact format, metadata, instructions, usage triggers, safety notes, and validation steps.
- Skills can be stored as local files, indexed for discovery, surfaced in status/TUI/doctor views, and loaded into the appropriate substrate where supported.
- Skills can call or reference workflows where policy allows.
- Skill creation should preserve approval discipline: a proposed skill is drafted first, then written/enabled only after user approval or configured policy.
- The existing Integration Builder skill is treated as an initial built-in skill example, not as the entire skill-builder system.

### 7.10 Workflow Builder System

**Requirement:** Provide a workflow-builder capability that lets users and agents create reusable multi-step workflows.

Acceptance criteria:

- A user can ask the agent to build a workflow from natural-language direction.
- An agent can propose a workflow when it observes repeated multi-step work.
- Workflows can represent loops, checklists, recurring jobs, gated procedures, handoff/checkpoint sequences, integrations, and harness-style process flows.
- Workflows have a durable artifact format with steps, inputs, outputs, tools/routes, approval gates, retry/loop conditions, failure handling, and validation criteria.
- Workflows can call skills, and skills can call workflows, while preserving clear boundaries and avoiding hidden side effects.
- Workflows are inspectable, editable, versionable, and auditable before activation.
- Workflow execution should record transcript events and status so the agent and user know what ran, what failed, and what requires approval.
- TestFlight-style workflows are a design reference; MindStone-Agent should make workflow creation user- and agent-accessible rather than assuming humans hand-author all process definitions.

### 7.11 Knowledgebase System

**Requirement:** Provide a knowledgebase system separate from memories and journals for user-supplied documents, URLs, reference material, and domain corpora.

Acceptance criteria:

- Users can create named knowledgebases from local documents, folders, URLs, pasted text, and future connectors.
- Knowledgebases are distinct from structured memory and narrative journals: they are supplemental reference sources, not the agent’s lived experience or durable behavioral memory.
- Knowledgebase ingestion records source metadata, provenance, refresh policy, chunking/index status, and sensitivity labels where configured.
- Knowledgebases can be vectorized into a dedicated KB index, summarized into an index-of-indexes, or integrated into the general recall substrate according to user/agent configuration.
- Agents can manually search knowledgebases when needed and can cite or reference source documents without pretending the content is remembered experience.
- Auto Recall can optionally use KB summaries/pointers rather than every KB chunk, especially for broad corpora.
- SME agents and persona packs can configure stronger KB integration when domain reference material should be central to the agent’s work.
- Skills and workflows can reference required or optional knowledgebases.
- Knowledgebase refresh/reindex status is visible in status/TUI/doctor surfaces.

### 7.12 Persona and Persona Pack System

**Requirement:** Provide personas as packaged, reusable identity supplements that can bundle or reference skills, workflows, knowledgebases, and behavior/context overlays.

Acceptance criteria:

- A persona is not a replacement for the agent’s core identity. It supplements identity for a role, domain, operating mode, or temporary stance.
- Personas can be permanent, session-scoped, task-scoped, or on-demand depending on configuration.
- A persona has a self-contained folder with a `PERSONA.md` descriptor and metadata.
- A persona can reference skills, workflows, knowledgebases, tools, safety rules, and route/model preferences.
- Persona Builder supports picking existing skills/workflows/KBs and invoking the respective builders just-in-time when an artifact does not exist.
- Persona activation/deactivation is visible and auditable in transcript/status surfaces.
- Persona Packs are a product/package layer for curated role/domain personas, and may be bundled with Agent Packs or distributed independently.
- Persona packages should be a major MindStone differentiator alongside Layered Continuity Architecture.

### 7.13 Installation and Operations

**Requirement:** Provide reliable install/update and daemon operation paths.

Acceptance criteria:

- Install flow works for local dev and packaged distribution.
- Gateway daemon can run under launchd on macOS and systemd user services on Linux.
- Health/status commands report Gateway, channel, memory, provider, skills, workflows, knowledgebases, personas, and configuration state.
- Update flow can migrate config safely and report legacy config warnings.
- Logs and diagnostics are accessible without exposing secrets.

## 8. Non-Functional Requirements

### Reliability

- Channel monitors should restart or report failure clearly.
- Memory indexing should be idempotent and recoverable.
- Gateway should fail closed on auth/config errors.

### Maintainability

- Core contracts must be documented and versioned.
- Substrate adapters should be thin compared to Core/Gateway.
- Channel plugins should not import substrate-specific UI code.

### Testability

- Core services should have unit tests independent of Pi.
- Gateway APIs should have integration/e2e tests.
- Channel plugin contracts should have contract tests with mocked provider APIs.
- Pi adapter commands should have at least smoke tests or manual validation scripts.

### Performance

- Memory recall must bound injected context.
- WebChat history must remain size-bounded.
- Channel sends should chunk according to provider limits.
- Vector search should support local-first operation and fallback modes.

## 9. Milestones

### M0 — Architecture decision and doc set

- Approve PRD, design, architecture, and implementation plan.
- Decide final product shape: Core + Gateway daemon + adapters.

### M1 — Core extraction skeleton

- Define Core package boundaries and contracts.
- Extract config, identity, transcript, memory interfaces, and channel plugin types.

### M2 — Pi adapter MVP

- Implement current-Pi onboarding/settings command using Core wizard adapter.
- Implement identity/context injection and memory status/recall commands.

### M3 — Gateway MVP

- Run daemon with auth, sessions, WebSocket chat, status, and transcript persistence.
- Expose OpenAI-compatible chat completions for OpenWebUI validation.

### M4 — Memory/SCRI MVP

- Implement/port vector backend, backfill, auto recall, dream-cycle hooks, and journal/doc memory.

### M4.5 — Skills, workflows, knowledgebases, and personas

- Provide default Skill Builder and Workflow Builder designs and artifact contracts.
- Provide Knowledgebase and Persona/Persona Pack designs and artifact contracts.
- Keep implementation post-MVP unless required for the initial user experience.
- Promote the existing Integration Builder skill as an initial built-in skill example.

### M5 — Channel MVPs

- Port Telegram first.
- Port Discord and Slack.
- Port Signal after external dependency handling is settled.

### M6 — Hardening and release packaging

- Add migration tools, docs, test matrix, service install, security review, and example configs.

## 10. Success Metrics

- A fresh current-Pi install can onboard a MindStone identity through the wizard.
- OpenWebUI can talk to MindStone via Gateway HTTP with stable session continuity.
- At least Telegram and one workspace channel, Discord or Slack, work through the Gateway daemon.
- SCRI recall injects relevant memories from both Markdown and transcript vectors.
- Dream-cycle/compaction behavior preserves continuity across a forced compaction or session reset.
- Users and agents can create or propose reusable skills/workflows for repeated work without hand-authoring every artifact from scratch.
- Users can attach and manage knowledgebases as supplemental reference sources distinct from memory and journals.
- Personas can package identity supplements with skills, workflows, and KBs for reusable roles/domains.
- No private identity files, transcripts, vectors, or tokens are committed.
- Cairn/Hearth review finds no major blocker in substrate boundaries or daemon operations.

## 11. Risks and Open Questions

1. **Direct forward-port temptation:** Updating dependencies may appear easier but could preserve architectural debt.
2. **Pi lifecycle mismatch:** Current Pi extensions are excellent for commands/UI but not necessarily for always-on channel monitors.
3. **Channel provider drift:** Discord/Slack/Signal APIs and local dependencies may require targeted revalidation.
4. **Memory fidelity:** Rewriting recall pipelines risks reducing SCRI to generic RAG unless explicitly protected.
5. **OpenWebUI compatibility:** Existing OpenAI-compatible endpoint is likely sufficient, but must be live-tested against OpenWebUI.
6. **Multi-agent fleet semantics:** Fleet identity isolation must be retained in Core schema and session routing.
7. **Skill/workflow overreach:** Agent-generated skills and workflows can create hidden automation risk unless approval, audit, versioning, and safety gates are explicit.
8. **Knowledgebase ambiguity:** If KBs are collapsed into memory or transcript vectors without clear source semantics, agents may confuse reference material with lived experience or durable user/project memory.
9. **Persona drift:** Personas can be powerful but may blur identity boundaries unless activation scope, precedence, and auditability are explicit.

## 12. Review Checklist

- [ ] Product scope matches MindStone proper, not just MS4PI.
- [ ] Core/Gateway/adapter split is accepted or revised.
- [ ] Required channel list and order are accepted.
- [ ] WebChat/OpenWebUI requirements are sufficient.
- [ ] SCRI/dream-cycle requirements preserve experiential continuity.
- [ ] Security and private-state constraints are explicit.
- [ ] Implementation plan is feasible for incremental PRs.
