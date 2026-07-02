# Cairn / Fable 5 Handover — MindStone-Agent Marathon Run

**Status:** Fresh-agent handover  
**Date:** 2026-07-01  
**Audience:** Cairn running on Fable 5  
**Repository:** `/Users/clint/Projects/MindStone-Agent`  
**GitHub:** `MindStone-Agent/MindStone-Agent`  

## Read this first

Cairn: this is the new **MindStone-Agent** project, not the old MindStone proper repo and not MS4CC.

You built the original MindStone from OpenClaw lineage. This repo is the clean rebuild of MindStone proper on a current Pi base. It is intended to preserve the useful MindStone semantics — identity, memory, channels, Gateway, transcripts, continuity, recall, checkpointing, personas, skills, workflows — while removing older OpenClaw-era coupling and using current Pi as a first-class substrate.

Slate has been driving this rebuild in Pi. You are coming in fresh, so treat this document as the short map. The detailed sources are listed below.

## Current honest status

```text
MindStone-Agent is MVP-shaped, not MVP-proven.
```

Do not call it MVP-complete until the proof gates pass.

The key remaining proof is live isolated Pi `AgentSession` execution:

```text
live isolated Pi-session prompt/stream validation
then, if successful, live Pi-session compaction validation
```

## Repository shape

```text
/Users/clint/Projects/MindStone-Agent
├── package.json
├── packages/
│   ├── mindstone-core/
│   ├── mindstone-cli/
│   ├── mindstone-gateway/
│   └── mindstone-pi-adapter/
├── scripts/
├── docs/
│   ├── gateway/
│   ├── operations/
│   └── refactor/
└── vendor/pi/
```

MindStone-Agent vendors current Pi under:

```text
vendor/pi
```

The public/user-facing command is:

```bash
mindstone
```

The dev helper is:

```bash
./scripts/mindstone
```

## Runtime isolation rule

This repo must not use global Pi auth/state.

Do **not** use:

```text
~/.pi/agent/auth.json
~/.pi/agent/sessions
```

Use project-local isolated state only:

```text
/Users/clint/Projects/MindStone-Agent/.runtime/pi-agent
/Users/clint/Projects/MindStone-Agent/.runtime/pi-sessions
/Users/clint/Projects/MindStone-Agent/.runtime/mindstone
```

Reset safely with:

```bash
mindstone reset --keep-pi-auth
```

or from source:

```bash
./scripts/mindstone reset --keep-pi-auth
```

Never commit runtime/auth/session/vector files.

## Core architecture thesis

MindStone-Agent should be:

```text
MindStone Core + Gateway + substrate adapters + runtime modes
```

Current Pi is the first major substrate adapter and the target MVP model-execution path. The real Pi-backed path should use Pi `AgentSession` / `SessionManager`, not merely raw provider completions.

Important runtime modes now captured:

1. **Companion Mode** — local persistent agent, TUI/CLI/Gateway/Agent Pack.
2. **App Engine Mode** — embedded/backend runtime for AI-native apps, no daemon required.
3. **Agent Mesh Mode** — multiple logically isolated MindStone agents in one app/runtime.

See:

```text
docs/refactor/APP_ENGINE_RUNTIME_MODES.md
```

## Main planning and status docs

Start here:

```text
docs/refactor/FABLE_5_MARATHON_RUNBOOK.md
docs/refactor/FABLE_5_PRODUCT_WISHLIST.md
docs/refactor/MVP_EXIT_CHECKLIST.md
TASK_STATUS.md
```

Then read:

```text
docs/refactor/PRD.md
docs/refactor/DESIGN.md
docs/refactor/IMPLEMENTATION_PLAN.md
docs/refactor/ARCHITECTURE.md
docs/refactor/CONTEXT_MANAGEMENT.md
docs/refactor/MEMORY_STRATEGY.md
docs/refactor/PI_SESSION_PARITY.md
docs/refactor/AGENT_PACKS.md
docs/refactor/SENSITIVE_CONTEXT_ROUTING.md
docs/refactor/APP_ENGINE_RUNTIME_MODES.md
docs/refactor/FABLE_5_PRODUCT_WISHLIST.md
docs/gateway/API_REFERENCE.md
docs/gateway/OPENWEBUI.md
docs/operations/ISOLATION.md
```

## What Slate implemented and committed recently

Recent committed local work includes:

- `mindstone reset` with typed confirmation and `--keep-pi-auth`;
- page-style onboarding UX;
- Custom / Write-in options on main onboarding choices;
- placeholder identity/user files no longer block onboarding;
- first identity activation offered in onboarding flow;
- first real chat turn injects human-centered identity-formation prompt;
- provider-identity drift hardening;
- TUI default chat hides low-level runner/Pi noise;
- `/events` remains diagnostics;
- TUI `/quit` / `/exit` hard-exit path;
- MVP exit checklist expanded for local/Ollama Cloud/vectorization/recall/sliding-window/live validation;
- Sensitive Context Routing design doc;
- App Engine / multi-agent runtime modes design doc;
- Fable 5 marathon runbook;
- Fable 5 product wishlist.

Historical dirty tree around the original handoff time, before Slate committed the first two Fable-prep commits:

```text
 D .runtime/README.md
 M docs/refactor/AGENT_PACKS.md
 M docs/refactor/DESIGN.md
 M docs/refactor/IMPLEMENTATION_PLAN.md
 M docs/refactor/PRD.md
 M package.json
 M packages/mindstone-cli/src/index.ts
 M packages/mindstone-cli/src/tui.ts
 M packages/mindstone-core/src/chat/run.ts
 M packages/mindstone-core/src/config/types.ts
 M packages/mindstone-core/src/identity/activation.ts
 M packages/mindstone-core/src/routing/run.ts
 M packages/mindstone-core/src/wizard/config.ts
 M scripts/smoke-onboard.sh
?? docs/refactor/APP_ENGINE_RUNTIME_MODES.md
?? docs/refactor/CAIRN_FABLE_HANDOVER.md
?? docs/refactor/FABLE_5_MARATHON_RUNBOOK.md
?? docs/refactor/MVP_EXIT_CHECKLIST.md
?? docs/refactor/SENSITIVE_CONTEXT_ROUTING.md
?? scripts/smoke-identity-formation.sh
?? scripts/smoke-onboard-custom-ux.sh
?? scripts/smoke-reset.sh
```

Re-run `git status --short` before acting; do not assume this list is current.

## Recently passed validation

Passed during latest Slate MVP UX pass:

```bash
npm run build:mindstone
npm run smoke:reset
npm run smoke:onboard
npm run smoke:onboard-custom-ux
npm run smoke:identity-activation
npm run smoke:identity-context
npm run smoke:identity-formation
npm run smoke:tui
npm run smoke:mvp-native
```

Previously passed in same arc:

```bash
npm run smoke:pi-session-runner
npm run smoke:agent-runner-stream
npm run smoke:gateway-runner-stream
npm run smoke:unified-session
```

Do not rely on stale validation after edits. Rerun before claims.

## MVP proof gates

### 1. Baseline

```bash
git status --short
npm install
npm run build:mindstone
```

### 2. Local/Ollama Cloud model coverage

MVP needs explicit paths for:

```text
cloud/subscription provider
local model endpoint, e.g. Ollama or LM Studio
Ollama Cloud explicit setup path
```

This is not fully proven yet.

### 3. Full non-live smoke suite

Use `docs/refactor/FABLE_5_MARATHON_RUNBOOK.md` and `MVP_EXIT_CHECKLIST.md` for the complete command list.

### 4. Continuity proof suite

```bash
npm run smoke:file-memory
npm run smoke:memory-backfill
npm run smoke:memory-maintenance
npm run smoke:embedding-memory
npm run smoke:auto-recall
npm run smoke:cli-chat-recall
npm run smoke:scri-recall
npm run smoke:sliding-window
npm run smoke:context-window
```

### 5. Fresh install/onboard/TUI E2E

```bash
npm run build:mindstone
npm run link:cli
mindstone reset --keep-pi-auth
mindstone onboard
mindstone tui
```

Verify actual terminal `/quit` behavior manually; smoke alone is not enough for that claim.

### 6. Live isolated Pi-session prompt/stream

Only after isolated auth/model state is intentionally ready:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

### 7. Live compaction validation

Only after prompt/stream succeeds:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_COMPACT=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

### 8. Claim pass

Update:

```text
README.md
TASK_STATUS.md
docs/refactor/MVP_EXIT_CHECKLIST.md
docs/refactor/IMPLEMENTATION_PLAN.md
```

Use claim categories:

```text
implemented
smoke-tested
live-validated
pending
post-MVP
```

## Product decisions already made

- Transcript is authoritative; pruning/compaction affect live context only.
- Canonical shared session key is:
  ```text
  agent:default:main
  ```
- Alias `mindstone` canonicalizes to it.
- TUI/CLI chat is MVP; WebChat/Telegram are phase-one/post-MVP surfaces.
- Gateway management is MVP via:
  ```bash
  mindstone gateway ...
  ```
- Onboarding must start identity formation, not just create runnable config.
- Page-style onboarding and custom/write-in options are MVP UX, not polish.
- TUI default chat should be quiet and human-facing.
- Vectorization, Auto Recall, CLI recall, SCRI recall, and sliding-window are MVP proof gates.
- Local/Ollama Cloud model coverage is an MVP gate.
- Sensitive Context Routing is important but post-MVP unless a concrete MVP safety issue appears.
- Skills, workflows, KBs, personas/persona packs are first-class product architecture; implementation can be pulled into the marathon if Fable has capacity.

## App engine / multi-agent design summary

MindStone should support:

```text
Companion Mode
App Engine Mode
Agent Mesh Mode
```

Key principle:

```text
Use personas when one agent can safely wear a role.
Use multiple agents when memory, authority, tools, policy, or lifecycle must be isolated.
Use workflows when routing/process must be deterministic.
Use skills when repeated capability should become reusable.
Use KBs when the agent needs reference expertise rather than lived memory.
```

Compact product architecture phrase:

```text
LCA gives agents continuity.
Skills give agents reusable capabilities.
Workflows give agents repeatable process.
Knowledgebases give agents reference expertise.
Personas package capabilities into role/domain overlays.
```

## GitHub issue execution order

Issues now exist in `MindStone-Agent/MindStone-Agent` and should be the execution queue for Fable/Cairn.

Recommended order:

```text
#1  [Epic] Fable 5 MindStone-Agent MVP marathon
#2  Land current MVP UX, reset, onboarding, identity-formation, and TUI fixes
#3  Implement explicit local model and Ollama Cloud setup paths
#4  Run and fix full non-live MVP smoke suite
#5  Prove memory, vectorization, recall, SCRI, and sliding-window continuity
#6  Validate fresh install/onboard/TUI E2E
#7  Live-validate isolated Pi-session prompt and stream path
#8  Live-validate Pi-session compaction or document explicit deferral
#9  README, TASK_STATUS, and docs claim reconciliation
#10 Commit Cairn/Fable handover, marathon runbook, app-engine design, and MVP checklist docs
#11 Persona Package and deterministic persona activation MVP
#12 Deterministic workflow router MVP
#13 Skill Builder and Knowledgebase v1 scaffolds
#14 App Engine Mode and Agent Mesh logical isolation scaffold
#15 MindStone Console polished Web UI
#16 Channel connector framework hardening
#17 Telegram connector MVP
#18 Slack connector MVP
#19 Discord connector MVP
#20 Microsoft Teams connector design and MVP path
#21 Email connector MVP with draft/send approval
#22 Calendar and task connectors
#23 Document/file/productivity connectors and KB ingestion
#24 Approval Center / Productivity Inbox
#25 Observability and evaluation dashboard
#26 Backup, export, and import
#27 Deployment polish and operations readiness
#28 Pack registry and marketplace design
#29 Scheduler and recurring jobs
#30 Voice, mobile, and notification surfaces
```

## Where Fable can safely be ambitious

If Fable can implement beyond the minimum MVP, prioritize in this sequence:

1. Persona package artifacts + activation/routing.
2. Deterministic workflow router.
3. Skill Builder v1 using existing Integration Builder as seed.
4. Knowledgebase catalog/search/citation v1.
5. MindStone Console Web UI.
6. Telegram connector.
7. Slack connector.
8. Email connector design/MVP.
9. Calendar/tasks connectors.
10. Observability/evals.
11. Backup/export/import.
12. Deployment polish.
13. App Engine Mode `mindstone.run(...)` service scaffold.
14. Agent Mesh logical isolation by `agentId`/tenant/session scope.
15. Pack registry/marketplace.

Do not start by creating multiple Gateway daemons per agent. Start with logical isolation in one runtime.

## Known gaps / non-claims

- Live authenticated `AgentSession.prompt(...)` not yet validated.
- Live authenticated `AgentSession.compact(...)` not yet validated.
- Native `sqlite-vec` ANN unavailable locally; JS cosine/vectorization path exists.
- OpenWebUI not live-validated.
- Telegram/Discord/Slack/Teams/email/calendar/task listeners/setup not implemented in this rebuild.
- Full raw Pi transcript/message archive parity not implemented.
- Local/Ollama Cloud setup/validation not yet proven.
- GitHub Issues were empty before seeding the marathon issues.

## Commit strategy

Suggested commits:

1. Current MVP UX/reset/onboarding/TUI fixes.
2. Current design/runbook docs.
3. Local/Ollama Cloud setup path.
4. Smoke/proof fixes.
5. Live Pi-session validation fixes.
6. Claim pass docs.
7. Optional persona/workflow/skill/KB/app-engine features as separate scoped commits.

## Final instruction

Be aggressive, but be truthful.

If something is implemented, say implemented.
If it is smoke-tested, say smoke-tested.
If it is live-validated, say live-validated.
If it is pending, say pending.

Do not collapse those categories.
