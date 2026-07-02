# Fable 5 Product Wishlist — Make MindStone-Agent Really Good

**Status:** Wishlist / stretch backlog  
**Date:** 2026-07-01  
**Purpose:** Capture the full “if Fable 5 can do it, let’s aim higher” product backlog for turning MindStone-Agent from an MVP continuity substrate into a practical AI-native app/agent platform.

## Guiding principle

The MVP proves the continuity engine.

The Fable stretch wishlist should make MindStone-Agent feel like a real product platform:

```text
continuity engine
+ persona/workflow/skill/KB substrate
+ polished web UI
+ real channels/connectors
+ observability/evals
+ deployment/backup/marketplace polish
```

## Non-negotiable foundation

Do not skip the MVP proof gates. Stretch work should not blur the truth boundary.

Current honest status before final validation:

```text
MVP-shaped, not MVP-proven.
```

Claim categories must stay explicit:

```text
implemented
smoke-tested
live-validated
pending
post-MVP
```

## Product thesis

MindStone-Agent should not be “another agent wrapper.”

It should become a continuity-native agent platform:

```text
Layered Continuity Architecture gives agents memory and identity.
Personas package useful roles.
Skills package reusable capabilities.
Workflows package repeatable process.
Knowledgebases package reference expertise.
Channels and connectors put agents where work happens.
Observability makes agent judgment inspectable.
```

## Wishlist priority stack

### 1. Prove the MVP continuity engine

Do this first.

- Finish local/Ollama Cloud model setup.
- Run full non-live smoke suite.
- Prove memory/vector/recall/sliding-window continuity.
- Validate fresh install/onboard/TUI E2E.
- Live-validate isolated Pi-session prompt/stream.
- Validate compaction or explicitly defer.
- Reconcile README/TASK_STATUS/docs claims.

Tracked in issues:

```text
#1 through #10
```

### 2. Persona Packs

Persona Packs may be one of MindStone-Agent’s strongest differentiators.

A persona should not be only a prompt. It should be a role/domain overlay package:

```text
PERSONA.md
metadata.json
skills.json
workflows.json
knowledgebases.json
safety.md
examples/
evals/
```

Examples:

- Software Engineering Partner
- Executive Assistant / Chief of Staff
- OT Threat Intel Analyst
- Incident Commander
- Proposal Writer
- Research Analyst
- Customer Support Agent
- Content / YouTube Assistant
- Personal Life Admin Assistant

Minimum product behavior:

- deterministic activation;
- status/TUI/Web UI visibility;
- transcript events for activation/deactivation;
- skill/workflow/KB binding;
- safety/tool-permission binding.

Tracked in issue:

```text
#11
```

### 3. Deterministic Workflow Builder

Production apps cannot rely only on LLM self-routing.

MindStone needs deterministic workflow rules:

```text
if request.type == "safety_review" → persona: safety-reviewer
if customer.tier == "regulated" → workflow: regulated-response
if artifact.kind == "proposal" → skill: proposal-writer
if channel == "exec-summary" → persona: executive-briefing
if data.label == "sensitive" → route: sensitive-context-authorized
```

Minimum product behavior:

- workflow schema;
- steps/conditions/gates/retries/failure handling;
- persona/skill/KB references;
- transcript event model;
- smoke-proven deterministic route.

Tracked in issue:

```text
#12
```

### 4. Skill Builder and Knowledgebase v1

Skills and KBs make personas and workflows useful.

Skill Builder v1:

- artifact schema;
- draft/propose/install approval path;
- skill discovery/status;
- existing Integration Builder as built-in example;
- smoke for generating/loading one local skill.

Knowledgebase v1:

- KB catalog/schema;
- ingest/index status;
- source metadata/citations;
- dedicated KB search path;
- KB summaries/pointers eligible for Auto Recall;
- smoke for ingest/search/citation.

Tracked in issue:

```text
#13
```

### 5. App Engine Mode and Agent Mesh

MindStone should be usable as the backend engine for AI-native apps.

Runtime modes:

```text
Companion Mode — local persistent agent.
App Engine Mode — embedded/backend continuity runtime.
Agent Mesh Mode — multiple logically isolated MindStone agents.
```

Minimum target API:

```ts
mindstone.run({
  appId,
  tenantId,
  userId,
  agentId,
  sessionKey,
  personaId,
  workflowId,
  input,
});
```

Tracked in issue:

```text
#14
```

## Usability and channel wishlist

### 6. MindStone Console Web UI

The TUI proves the local terminal path. A polished web UI changes the product category.

Proposed product name:

```text
MindStone Console
```

Minimum console surfaces:

- chat interface;
- agent/persona selector;
- session/history browser;
- memory/recall visibility;
- Gateway status;
- model/provider status;
- file/KB upload;
- workflow/skill/persona management;
- settings/onboarding;
- approval center;
- dark/light MindStone theme.

Design distinction:

```text
Cortex = local AI stack command center.
MindStone Console = agent continuity/productivity command center.
```

### 7. Channel connector framework hardening

Before adding many channels, standardize connector expectations.

Each connector should provide:

```text
setup wizard
credential storage
allowlist/pairing
inbound listener
outbound send
thread/session mapping
source metadata
mention/trigger behavior
delivery queue
status/doctor visibility
tests/smokes
```

### 8. Telegram connector MVP

Telegram is likely the fastest useful external channel.

Minimum:

- bot token setup;
- allowlist/pairing;
- inbound polling or webhook mode;
- outbound send;
- group/thread handling where feasible;
- media awareness if easy;
- canonical transcript/session mapping;
- status/doctor/TUI/Web UI visibility.

### 9. Slack connector MVP

Slack is high-value for business/team adoption.

Minimum:

- app/bot token setup;
- Socket Mode or Events API plan;
- channel/DM allowlists;
- mentions;
- thread mapping;
- outbound reply;
- delivery queue;
- transcript/source metadata;
- status/doctor visibility.

### 10. Discord connector MVP

Discord is useful for community/dev agent presence.

Minimum:

- bot token setup;
- guild/channel allowlists;
- DM and mention handling;
- thread/reply mapping;
- outbound send;
- source metadata;
- status/doctor visibility.

### 11. Microsoft Teams connector MVP/design

Teams is enterprise-relevant but heavier.

Minimum design/MVP:

- Graph/Bot Framework auth model decision;
- tenant/app registration guidance;
- channel/chat mention handling;
- outbound send;
- approval/security posture;
- status/doctor visibility.

### 12. Email connector MVP

Email is one of the biggest productivity unlocks, but it requires strict safety.

Minimum:

- Gmail and/or Microsoft 365 design path;
- read/search scoped mailbox access;
- summarize threads;
- draft replies;
- detect commitments/tasks/follow-ups;
- send only with explicit approval by default;
- contact/domain trust rules;
- transcript/source metadata;
- memory write proposal discipline.

Safety default:

```text
read allowed by configured scope
draft allowed by default
send requires explicit approval
never auto-send externally without policy
sensitive-context routing applies
```

### 13. Calendar and task connectors

High productivity value.

Targets:

- Google Calendar;
- Microsoft 365 Calendar;
- Todoist;
- Apple Reminders if feasible;
- Linear/Jira/GitHub Issues;
- Notion tasks/databases if feasible.

Capabilities:

- summarize upcoming commitments;
- create/update tasks with approval;
- follow-up tracking;
- meeting prep and post-meeting summary;
- memory proposal from durable commitments/preferences.

### 14. Document/file/productivity connectors

Useful app and personal productivity substrate.

Targets:

- local folders;
- Obsidian vaults;
- Notion;
- Google Drive/Docs;
- Microsoft OneDrive/SharePoint;
- GitHub repos/issues;
- URLs/RSS feeds.

Capabilities:

- KB ingestion;
- citation-preserving search;
- update/refresh policy;
- permission/sensitivity labels;
- per-persona KB binding.

## Product differentiators

### 15. Approval Center / Productivity Inbox

A central inbox for agent-proposed actions:

```text
send email
post Slack reply
create task
write memory
install skill
activate persona
run workflow
modify config
```

This is a major safety and UX differentiator.

### 16. Observability and evaluation dashboard

Production AI needs inspection.

Minimum:

- run history;
- token/cost tracking;
- model/provider health;
- latency/errors;
- recall diagnostics;
- workflow traces;
- memory writes/audit log;
- failed delivery queue;
- evaluation harness;
- red-team/prompt injection checks.

Key user question to answer:

```text
Why did the agent remember/use this?
```

### 17. Backup / export / import

MindStone continuity is valuable state. Users need portability.

Minimum:

- export identity/user/memory/journals/transcripts/config minus secrets;
- import/restore bundle;
- backup status in doctor;
- encrypted backup option later;
- migration between machines/containers.

### 18. Deployment polish

Adoption needs boring deployment.

Minimum:

- Docker Compose one-command run;
- service install/uninstall;
- `mindstone doctor` completeness;
- env template;
- secret management docs;
- upgrade/migration path;
- health check and logs;
- backup/restore path.

### 19. Pack registry / marketplace design

Agent Packs and Persona Packs need distribution.

Design:

- pack manifest;
- versioning;
- signing/checksum;
- dependency declaration;
- free starter packs;
- optional paid/professional packs;
- entitlement/private registry path;
- install/update/remove commands;
- safety review metadata.

### 20. Scheduler / recurring jobs

Useful for productivity and operations.

Capabilities:

- recurring workflows;
- digest generation;
- follow-up checks;
- memory maintenance;
- channel delivery retries;
- reminder/task sync;
- explicit user-visible schedule config.

### 21. Voice / mobile / notification surfaces

Not first, but worth capturing.

Potential:

- mobile PWA or app client;
- push notifications;
- voice note ingestion;
- voice summary/dictation;
- notification approval actions.

## Recommended Fable expansion order

If Fable capacity is excellent, expand in this order:

```text
1. Finish MVP proof.
2. Persona Package MVP.
3. Deterministic Workflow Router.
4. Skill Builder + KB v1.
5. MindStone Console Web UI.
6. Telegram connector.
7. Slack connector.
8. Email connector design/MVP.
9. Calendar/tasks connectors.
10. Observability/evals.
11. Backup/export/import.
12. Deployment polish.
13. App Engine Mode runtime API.
14. Agent Mesh logical isolation.
15. Pack registry/marketplace.
```

Reasoning:

- Persona/workflow/skill/KB features improve both companion and app-engine modes.
- Console makes the platform usable.
- Telegram/Slack/email put MindStone where work happens.
- Observability/backup/deployment make it production-trustworthy.
- App Engine/Agent Mesh then turn it into a broader platform.

## What to avoid

- Do not build a pile of connectors before channel/session/source metadata is stable.
- Do not auto-send external messages without approval policies.
- Do not let KB retrieval drown out agent memory and transcript recall.
- Do not make one Gateway daemon per agent the default; prefer logical isolation first.
- Do not market full pack marketplace before install/update/signing/entitlement behavior exists.
- Do not claim enterprise Teams/M365 support without real auth and tenant testing.

## GitHub issue mapping

Existing Fable marathon issues:

```text
#1 through #14
```

Wishlist issues added after this doc:

```text
#15 MindStone Console Web UI
#16 Channel connector framework hardening
#17 Telegram connector MVP
#18 Slack connector MVP
#19 Discord connector MVP
#20 Microsoft Teams connector design/MVP
#21 Email connector MVP
#22 Calendar and task connectors
#23 Document/file/productivity connectors and KB ingestion
#24 Approval Center / Productivity Inbox
#25 Observability and evaluation dashboard
#26 Backup/export/import
#27 Deployment polish
#28 Pack registry / marketplace design
#29 Scheduler / recurring jobs
#30 Voice, mobile, and notification surfaces
```
