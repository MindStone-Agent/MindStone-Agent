# Fable 5 Marathon Runbook

**Status:** Working execution runbook  
**Date:** 2026-07-01  
**Purpose:** Give a high-capability model a single command center for finishing MindStone-Agent MVP and optionally pulling selected post-MVP lanes into the run.

## Repository and issue state

Repository:

```text
/Users/clint/Projects/MindStone-Agent
origin: https://github.com/MindStone-Agent/MindStone-Agent.git
canonical GitHub repo: MindStone-Agent/MindStone-Agent
branch: main
```

GitHub Issues:

A focused Fable/Cairn marathon issue queue was seeded on 2026-07-01:

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

The GitHub issue queue is now the execution queue; the docs remain the deep source of truth.

Primary planning files:

```text
TASK_STATUS.md
docs/refactor/MVP_EXIT_CHECKLIST.md
docs/refactor/FABLE_5_PRODUCT_WISHLIST.md
docs/refactor/PRD.md
docs/refactor/DESIGN.md
docs/refactor/IMPLEMENTATION_PLAN.md
docs/refactor/AGENT_PACKS.md
docs/refactor/SENSITIVE_CONTEXT_ROUTING.md
docs/refactor/APP_ENGINE_RUNTIME_MODES.md
```

Supporting docs:

```text
docs/refactor/ARCHITECTURE.md
docs/refactor/CONTEXT_MANAGEMENT.md
docs/refactor/MEMORY_STRATEGY.md
docs/refactor/PI_SESSION_PARITY.md
docs/gateway/API_REFERENCE.md
docs/gateway/OPENWEBUI.md
docs/operations/ISOLATION.md
```

## Non-negotiable claim boundary

Do not say MindStone-Agent is MVP-complete until the proof gates pass.

Current honest status:

```text
MVP-shaped, not MVP-proven.
```

MVP-proven requires:

```text
install/onboard
→ configure isolated model/auth
→ chat through canonical session
→ preserve transcript continuity
→ use identity + memory/recall
→ route through live Pi AgentSession
→ validate compaction boundary or explicitly defer it
→ expose Gateway/API surfaces honestly
→ update README/TASK_STATUS/docs to match verified reality
```

## Current dirty working tree warning

Before any work, run:

```bash
cd /Users/clint/Projects/MindStone-Agent
git status --short
```

Known active/uncommitted changes around the time this runbook was created:

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
?? docs/refactor/FABLE_5_MARATHON_RUNBOOK.md
?? docs/refactor/MVP_EXIT_CHECKLIST.md
?? docs/refactor/SENSITIVE_CONTEXT_ROUTING.md
?? scripts/smoke-identity-formation.sh
?? scripts/smoke-onboard-custom-ux.sh
?? scripts/smoke-reset.sh
```

Do **not** stage private runtime/auth/session/vector files.

## Runtime isolation rule

MindStone-Agent must not use global Pi auth/state.

Do not use:

```text
~/.pi/agent/auth.json
~/.pi/agent/sessions
```

Use project-local isolated runtime:

```text
/Users/clint/Projects/MindStone-Agent/.runtime/pi-agent
/Users/clint/Projects/MindStone-Agent/.runtime/pi-sessions
/Users/clint/Projects/MindStone-Agent/.runtime/mindstone
```

For E2E reset, prefer:

```bash
mindstone reset --keep-pi-auth
```

or, from source:

```bash
./scripts/mindstone reset --keep-pi-auth
```

## What was just implemented before this runbook

Recent MVP UX hardening includes:

- `mindstone reset` with typed confirmation and `--keep-pi-auth`.
- Page-style onboarding prompts by default.
- Custom / Write-in choices on main onboarding screens.
- Placeholder identity/user files no longer block onboarding scaffold.
- Onboarding offers first identity activation in-flow.
- First real chat turn injects one-time human-centered identity formation.
- Identity prompt reduces provider-identity drift.
- TUI default chat hides low-level runner/Pi event spam.
- `/events` remains diagnostics.
- TUI `/quit` / `/exit` hard-exit path added.

Recently passed:

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

Previously passed in the same arc:

```bash
npm run smoke:pi-session-runner
npm run smoke:agent-runner-stream
npm run smoke:gateway-runner-stream
npm run smoke:unified-session
```

Do not assume these still pass after further edits; rerun before claims.

## MVP first: recommended execution order

### Gate 1 — Baseline hygiene and build

```bash
cd /Users/clint/Projects/MindStone-Agent
git status --short
npm install
npm run build:mindstone
```

Pass criteria:

- build succeeds;
- dirty tree is understood;
- no runtime/private/generated state staged;
- docs-only vs code changes are intentionally grouped.

### Gate 2 — Finish local/Ollama Cloud onboarding paths

MVP now requires more than cloud/subscription auth.

Required lanes:

1. Cloud/subscription provider through isolated Pi auth.
2. Local model endpoint, e.g. Ollama or LM Studio/OpenAI-compatible local server.
3. Ollama Cloud as explicit setup path.

Implementation goals:

- onboarding exposes clear local-model path;
- onboarding exposes clear Ollama Cloud path;
- config wizard supports these paths without manual hidden model-id entry;
- status/doctor report sanitized route/model/auth state;
- smoke coverage proves at least local/OpenAI-compatible route from fresh runtime or documents environmental prerequisite;
- Ollama Cloud is validated or explicitly marked pending with instructions.

Likely files:

```text
packages/mindstone-core/src/wizard/config.ts
packages/mindstone-core/src/config/types.ts
packages/mindstone-core/src/provider/diagnostics.ts
packages/mindstone-cli/src/index.ts
scripts/smoke-onboard-model-setup.sh
scripts/smoke-config-pi-models.sh
```

### Gate 3 — Full non-live smoke suite

Minimum final MVP non-live run:

```bash
npm run smoke:reset
npm run smoke:onboard
npm run smoke:onboard-custom-ux
npm run smoke:identity-activation
npm run smoke:identity-context
npm run smoke:identity-formation
npm run smoke:core-boundary
npm run smoke:mvp-native
npm run smoke:cli-bin
npm run smoke:install-script
npm run smoke:doctor
npm run smoke:gateway-cli
npm run smoke:unified-session
npm run smoke:transcripts
npm run smoke:context-window
npm run smoke:sliding-window
npm run smoke:auto-recall
npm run smoke:cli-chat
npm run smoke:cli-chat-recall
npm run smoke:tui
npm run smoke:gateway-http-surfaces
npm run smoke:openai
npm run smoke:rpc
npm run smoke:ws-rpc
npm run smoke:webchat-ui
npm run smoke:router-mock
npm run smoke:gateway-runner-stream
npm run smoke:file-memory
npm run smoke:memory-backfill
npm run smoke:memory-maintenance
npm run smoke:embedding-memory
npm run smoke:scri-recall
npm run smoke:pi-adapter
npm run smoke:pi-provider-config
npm run smoke:pi-session-runner
npm run smoke:agent-runner-stream
npm run smoke:pi-config-sections
```

If a smoke is skipped, document why and make sure public claims reflect it.

### Gate 4 — Continuity proof suite

These are MVP requirements, not polish:

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

Proof points:

- structured memory files indexed;
- SQLite backfill/maintenance works;
- embedding vectorization stores embedded chunks;
- Auto Recall injects relevant chunks;
- CLI chat recall reaches a real chat turn;
- SCRI ranking/dedup works at smoke level;
- sliding-window pruning preserves append-only transcript.

### Gate 5 — Fresh install/onboard/TUI E2E

Run from a clean/fresh-style path when feasible.

Minimum local source E2E:

```bash
npm run build:mindstone
npm run link:cli
mindstone reset --keep-pi-auth
mindstone onboard
mindstone tui
```

Pass criteria:

- onboarding feels coherent from scratch;
- page-style prompts work;
- custom/write-in paths work;
- first identity activation occurs in-flow;
- first real chat begins human-centered identity formation;
- default TUI chat is human-clean;
- `/quit` exits reliably in an actual terminal.

### Gate 6 — Live isolated Pi-session prompt/stream validation

Only use isolated auth/model state.

Expected files:

```text
.runtime/pi-agent/auth.json
.runtime/pi-agent/models.json
```

Live prompt/stream command:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

If this fails due to missing model/auth, document exact prerequisite instead of claiming failure of the architecture.

### Gate 7 — Live compaction validation

Only after Gate 6 succeeds:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_COMPACT=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

If compaction remains unvalidated, public docs must say so explicitly.

### Gate 8 — Claim pass and docs/status reconciliation

Update:

```text
README.md
TASK_STATUS.md
docs/refactor/MVP_EXIT_CHECKLIST.md
docs/refactor/IMPLEMENTATION_PLAN.md
```

Claim taxonomy:

```text
implemented
smoke-tested
live-validated
pending
post-MVP
```

Do not blur these categories.

## If Fable pulls post-MVP into MVP

Clint believes Fable 5 may be capable enough to implement much more than the current MVP list. If expanding scope, do it in this order because these features compound cleanly:

### A. App Engine Mode design scaffold

Use:

```text
docs/refactor/APP_ENGINE_RUNTIME_MODES.md
```

Implement only a minimal runtime service if time allows:

```ts
mindstone.run({ appId, tenantId, userId, agentId, sessionKey, personaId, workflowId, input })
```

Do not destabilize Companion Mode MVP.

### B. Persona package MVP

Implement persona artifacts and deterministic activation before full Agent Packs.

Suggested artifact:

```text
personas/<persona-id>/PERSONA.md
personas/<persona-id>/metadata.json
personas/<persona-id>/skills.json
personas/<persona-id>/workflows.json
personas/<persona-id>/knowledgebases.json
personas/<persona-id>/safety.md
```

Minimum behavior:

- load persona overlay;
- apply deterministic persona route when configured;
- record transcript event for persona activation;
- expose status/doctor/TUI visibility;
- smoke test activation/deactivation.

### C. Deterministic workflow router

Implement enough workflow structure to route personas/skills/KBs by conditions.

Minimum schema:

```text
workflow id/name/version
inputs
steps
conditions
gates
retry policy
persona/skill/kb references
transcript event emission
```

### D. Skill Builder v1

Build from existing Integration Builder skill foundation.

Minimum:

- skill artifact schema;
- proposed/draft skill path;
- approval/install path;
- skill discovery/status;
- smoke for generating and loading one local skill.

### E. Knowledgebase v1

Minimum:

- KB catalog;
- ingestion/index status;
- source metadata/citations;
- dedicated KB search path;
- KB summaries/pointers eligible for Auto Recall;
- smoke for ingest/search/citation.

### F. Multi-agent logical isolation

Do not begin with multiple daemons.

Start with:

```text
shared runtime process
agentId namespace
separate identity/memory/transcript/session scopes
shared Gateway routes with agent scope
```

Only add per-agent Gateway/container mode later.

## What not to do

- Do not use global Pi auth or sessions.
- Do not commit `.runtime` private data, auth, vectors, or transcripts.
- Do not claim native `sqlite-vec` ANN search works locally; current status has reported:
  ```text
  no such function: vec_version
  ```
- Do not claim OpenWebUI is validated until it is actually validated.
- Do not implement Telegram/Discord/Slack/Signal as if already complete; channel catalog is currently diagnostic/planned.
- Do not let Sensitive Context Routing block MVP unless a concrete safety bug demands it.
- Do not call full Agent Packs installable until package/runtime/install flow exists.
- Do not commit unrelated website promo/media files.

## Commit strategy

Recommended commit sequence:

1. MVP UX fixes:
   - reset command;
   - onboarding page mode/custom paths;
   - identity formation;
   - TUI quiet/quit fixes;
   - related smokes.
2. MVP docs/checklists:
   - `MVP_EXIT_CHECKLIST.md`;
   - `SENSITIVE_CONTEXT_ROUTING.md` if kept as design;
   - `APP_ENGINE_RUNTIME_MODES.md`;
   - `FABLE_5_MARATHON_RUNBOOK.md`.
3. Local/Ollama Cloud model setup path.
4. Continuity proof fixes if any smoke fails.
5. Live Pi-session validation fixes.
6. README/TASK_STATUS claim reconciliation.
7. Optional post-MVP expansion commits, each scoped by feature lane.

## Final release bar

Before declaring MVP good:

```bash
git status --short
npm run build:mindstone
# run required smoke suites
# run live pi-session prompt/stream validation
# run docs/status claim pass
```

Then update final status:

```text
MVP-proven
```

only if the evidence supports it.
