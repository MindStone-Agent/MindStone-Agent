# MindStone App Engine and Multi-Agent Runtime Modes

**Status:** Draft architecture note  
**Date:** 2026-07-01  
**Scope:** Capture how MindStone-Agent should serve not only as a single local companion agent, but also as a backend engine for AI-native applications, multi-agent systems, persona-driven apps, and deterministic workflow runtimes.

## Core question

MindStone-Agent started from the local persistent-agent harness path:

```text
one agent
one identity
one runtime
one transcript lineage
one memory substrate
one Gateway/TUI/API surface
```

But many production AI applications need something broader:

- MindStone as the continuity engine behind an AI-native app;
- multiple MindStone agents inside one app, e.g. orchestrator + specialist agents;
- persona packs that let one agent adopt role/domain overlays;
- deterministic routing to personas, skills, workflows, and knowledgebases;
- app-backend invocation without requiring one always-on Gateway daemon per agent.

The design answer should not force one deployment shape. MindStone should support multiple runtime modes.

## When MindStone is useful as an app engine

MindStone is overkill for narrow stateless LLM calls such as:

- one-shot extraction;
- simple classification;
- short summarization;
- simple question answering over a small prompt.

MindStone is useful as an app engine when the application needs any of these:

- durable user/org/project memory;
- long-term transcript continuity;
- role/persona continuity;
- source-aware recall;
- auditable agent history;
- checkpoint/handoff behavior;
- deterministic workflow plus agent judgment;
- domain/persona packs;
- customer-specific accumulated context;
- behavior that improves with repeated use.

LangChain, LangGraph, and similar frameworks are strong orchestration/tooling layers, but they often leave continuity, identity, memory, persona packaging, and checkpoint behavior as application-specific glue. MindStone's differentiator is to make those first-class.

## Runtime modes

MindStone should define at least three official runtime modes.

### 1. Companion Mode

Companion Mode is the current local/persistent-agent shape.

```text
mindstone onboard
mindstone tui
mindstone chat
mindstone gateway run/start
Agent Pack container
```

Use this when the product is a persistent local or organizational agent.

Characteristics:

- one primary agent identity;
- one canonical transcript lineage by default;
- local runtime state;
- TUI/CLI/Gateway surfaces;
- optional Agent Pack packaging;
- strong fit for personal agents, SOC agents, engineering agents, research agents, and long-lived role agents.

### 2. App Engine Mode

App Engine Mode is for AI-native applications that want MindStone as a backend runtime rather than as a user-facing daemon.

The app should be able to invoke MindStone as a library/service:

```ts
await mindstone.run({
  appId,
  tenantId,
  userId,
  agentId,
  persona,
  workflow,
  input,
  memoryScope,
  responseMode,
});
```

Request flow:

```text
app request
→ resolve tenant/user/session/agent scope
→ assemble identity + persona + memory + KB context
→ apply deterministic workflow/routing rules if configured
→ call provider/substrate runner
→ append transcript
→ update memory/recall metadata as policy allows
→ return response + citations/diagnostics
```

Characteristics:

- no always-on Gateway required;
- API/library invocation path;
- tenant/user/session scoped storage;
- explicit memory-scope control;
- suitable for SaaS backends and customer production apps;
- Gateway may still be used as an optional external API surface.

### 3. Agent Mesh Mode

Agent Mesh Mode is for apps with multiple logically isolated MindStone agents.

Example:

```text
agent:orchestrator
agent:planner
agent:researcher
agent:analyst
agent:writer
agent:operator
```

Each agent should have its own logical isolation boundary:

```text
identity
memory namespace
journal namespace
transcript/session namespace
default persona set
skills/workflows/KB bindings
tool permissions
policy/clearance
optional Gateway route
```

This does **not** mean each agent must have its own process or daemon.

Preferred default:

```text
shared runtime process
shared storage engine
separate agent namespaces
shared Gateway with agent-scoped routes
```

Heavier isolation remains available when needed:

```text
separate Gateway per agent
separate container per agent
separate vector DB / database / volume
separate secrets boundary
```

Use true multiple agents when memory, authority, tools, policy, lifecycle, or audit boundaries must be isolated.

## Personas versus multiple agents

MindStone should support both.

### Personas

A persona is a role/domain overlay on top of an agent's core identity.

Use personas when the same agent can safely wear a role:

```text
core identity
+ persona overlay
+ persona-specific skills
+ persona-specific workflows
+ persona-specific KB summaries/pointers
+ persona safety rules
```

Good uses:

- executive briefer;
- proposal writer;
- OT security analyst;
- curriculum designer;
- customer support specialist;
- code reviewer;
- incident commander.

Personas are cheaper and simpler than true multi-agent systems. They are likely the right default for many app features.

### Multiple agents

Use multiple agents when isolation is load-bearing:

- separate long-term memory should evolve differently;
- separate authority/tool access is required;
- regulated or sensitive routes must be isolated;
- parallel specialists need separate transcript lineage;
- the app needs agent-to-agent review or adversarial analysis;
- one role should not contaminate another role's identity or memory.

## Deterministic routing

LLM self-routing is not enough for production apps. MindStone must support deterministic selection of personas, skills, workflows, KBs, and agents.

Examples:

```text
if request.type == "safety_review" → persona: safety-reviewer
if customer.tier == "regulated" → workflow: regulated-response
if artifact.kind == "proposal" → skill: proposal-writer
if channel == "exec-summary" → persona: executive-briefing
if data.label == "sensitive" → agent/route: sensitive-context-authorized
```

The agent may suggest selection, but the app/router/workflow must be able to force it.

Required routing layers:

1. **Declarative routing rules** — deterministic conditions configured by app/tenant/agent.
2. **Workflow gates** — deterministic step routing and approval gates.
3. **Policy gates** — privacy/sensitivity/tool/tenant restrictions.
4. **Agent recommendation** — optional proposal by the model, never the only routing authority when determinism matters.

## Relationship to workflows, skills, KBs, and personas

Compact architecture phrase:

```text
LCA gives agents continuity.
Skills give agents reusable capabilities.
Workflows give agents repeatable process.
Knowledgebases give agents reference expertise.
Personas package capabilities into role/domain overlays.
```

Default relationship:

```text
Persona selects defaults.
Workflow controls process.
Skill performs reusable capability.
Knowledgebase supplies reference material.
Memory shapes future judgment.
Transcript remains authoritative history.
```

Example:

```text
persona: OT Incident Analyst
  skills:
    - incident-timeline-builder
    - pcap-triage-helper
  workflows:
    - ransomware-response-triage
    - executive-incident-briefing
  knowledgebases:
    - nist-800-61
    - cisa-ics-advisories
    - customer-ir-runbook
  safety:
    - no raw sensitive data to default route
    - require approval before outbound notifications
```

## Relationship to LangChain / LangGraph

MindStone should not need to replace every graph/orchestration framework.

Pragmatic positioning:

- LangGraph is good at deterministic graph orchestration.
- LangChain is good at integrations/chains/ecosystem connectors.
- MindStone is the continuity-native substrate: identity, memory, transcript, personas, source-aware recall, checkpointing, and app/agent continuity.

Possible integration shapes:

### MindStone replaces orchestration for continuity-first apps

```text
app → MindStone workflow/router → MindStone runner → response
```

Use when MindStone workflows, skills, and personas are enough.

### LangGraph orchestrates, MindStone provides agent state

```text
LangGraph node
→ MindStone agent/persona invocation
→ transcript/memory/recall handled by MindStone
→ node result returned to graph
```

Use when the app already has complex graph logic or external framework commitments.

### MindStone wraps LangChain tools

```text
MindStone skill/workflow step → LangChain integration/tool → result → MindStone transcript/memory
```

Use to leverage existing integration ecosystem without giving up continuity.

## Proposed API surfaces

### In-process runtime API

```ts
type MindStoneRunRequest = {
  appId?: string;
  tenantId?: string;
  userId?: string;
  agentId: string;
  sessionKey?: string;
  personaId?: string;
  workflowId?: string;
  input: string | AgentMessage[];
  memoryScope?: "agent" | "user" | "tenant" | "app" | "none";
  kbScope?: string[];
  deterministicRoute?: string;
  metadata?: Record<string, unknown>;
};
```

### Shared Gateway API mode

```text
POST /agents/:agentId/runs
POST /agents/:agentId/sessions/:sessionKey/messages
POST /tenants/:tenantId/agents/:agentId/runs
```

### API-only mode

API-only mode should avoid requiring a managed daemon per agent.

```text
MindStone Core + runner factory + storage service
no Gateway listener
no TUI
no background channel listeners
```

This is likely the correct mode for embedding MindStone into AI-native web apps.

## Storage and isolation model

Minimum namespace dimensions:

```text
appId
tenantId
userId
agentId
sessionKey
personaId
workflowRunId
source/channel
```

Recommended storage rule:

```text
Every transcript, memory, journal, KB, vector chunk, and workflow event must carry enough scope metadata to prevent accidental cross-tenant/cross-agent recall.
```

Isolation tiers:

1. **Logical namespace isolation** — default for app engine mode.
2. **Database/schema isolation** — stronger tenant/customer isolation.
3. **Process/container isolation** — regulated, high-risk, or commercial Agent Pack deployments.
4. **Network/secret isolation** — when tool/API permissions differ by agent/persona.

## Open design questions

- Should App Engine Mode live in `packages/mindstone-core`, a new `packages/mindstone-runtime`, or the Gateway package?
- What is the minimal stable `mindstone.run(...)` API for MVP+1?
- How should app-engine memory scopes map to current file-backed memory layout?
- Should multi-agent runtime use one vector DB with scoped metadata or separate DBs by agent/tenant?
- Which pieces belong in MindStone workflows versus external LangGraph orchestration?
- How should persona activation be represented in transcript events?
- How much deterministic routing should be declarative config versus code/API callbacks?

## Recommendation

Do not force all apps into full local-agent Companion Mode.

Adopt a three-mode product answer:

```text
Companion Mode — full local/persistent agent.
App Engine Mode — embedded/backend continuity runtime.
Agent Mesh Mode — multiple isolated MindStone agents for apps.
```

Then apply the routing principle:

```text
Use personas when one agent can safely wear a role.
Use multiple agents when memory, authority, tools, policy, or lifecycle must be isolated.
Use workflows when routing/process must be deterministic.
Use skills when repeated capability should become reusable.
Use KBs when the agent needs reference expertise rather than lived memory.
```
