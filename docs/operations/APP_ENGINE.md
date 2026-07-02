# App Engine Mode and Agent Mesh (v1 scaffold)

Issue #14 scaffold of the runtime modes designed in
[`docs/refactor/APP_ENGINE_RUNTIME_MODES.md`](../refactor/APP_ENGINE_RUNTIME_MODES.md):
MindStone as an embedded backend runtime (**App Engine Mode**) and multiple
logically isolated agents in one runtime (**Agent Mesh Mode**), alongside the
existing local **Companion Mode**.

## In-process runtime API

```ts
import { runMindStone } from "@mindstone-agent/core";

const result = await runMindStone(
  {
    appId: "acme-app",          // optional scope dimensions…
    tenantId: "t1",
    userId: "u1",
    agentId: "analyst",         // …agentId is required
    sessionKey: undefined,       // derived when omitted (see below)
    personaId: "ot-analyst",    // optional: deterministically forced
    workflowId: "sec-triage",   // optional: deterministically forced
    input: "summarize today's alerts",
    memoryScope: "agent",       // app | tenant | user | agent (default) | none
  },
  { config, provider, model }    // caller supplies provider/model (core is provider-agnostic)
);
```

- No Gateway daemon, TUI, or channel listeners required — the API is a thin
  adapter over the canonical chat-turn path, so App Engine runs get the same
  transcript authority, identity/persona precedence, workflow gating, and
  scope-enforced recall as every other surface.
- Returns `{ runId, sessionKey, scope, memoryScope, response, personaContext,
  workflow, memoryRecall (hit ids/titles/scores + rejectedCount), diagnostics }`.
- **Deterministic routing authority:** request > workflow decision > config
  rules/active. A request-forced persona/workflow resolves with reason
  `forced:request`; the workflow still evaluates (gates and events fire) but a
  request-forced persona beats its decision.

### Session keys

Omitted `sessionKey` derives canonically from scope, collapsing unused
dimensions — an unscoped request degrades exactly to the companion shape:

```text
app:acme:tenant:t1:user:u1:agent:analyst:main
tenant:t1:agent:analyst:main
agent:default:main            ← companion mode, unchanged
```

## Scope model (prevents cross-tenant/cross-agent recall)

Scope dimensions: `appId`, `tenantId`, `userId`, `agentId`. The run's scope is
stamped on user and assistant transcript entries (`metadata.scope`) and
enforced on memory recall.

**Matching rule (document-subset-of-filter):** a memory/KB document tagged with
`metadata.scope` is recalled only when every dimension the document defines is
present in the run's recall filter with the same value.

- Unscoped documents are global (companion-compatible) — always eligible.
- A tenant-A document never surfaces in tenant-B's recall (values differ).
- An agent-private document never surfaces in another agent's run, in a
  broader `memoryScope` run, or in an unscoped run (its dimension is missing
  from the filter).
- Broader documents remain visible to narrower requests: an agent-level
  document is recalled by that agent's user-specific runs.

`memoryScope` picks the filter breadth: `app` ⊇ `tenant` ⊇ `user` ⊇ `agent`
(default, narrowest = full scope); `none` disables recall for the run.
Scope-rejected hits are counted in recall diagnostics (`scope_mismatch`), never
silently dropped.

## Shared Gateway, agent-scoped routes (Agent Mesh)

One Gateway daemon serves many logically isolated agents — no per-agent
daemon:

```text
POST /agents/:agentId/runs
{ "input": "...", "appId"?, "tenantId"?, "userId"?, "sessionKey"?,
  "personaId"?, "workflowId"?, "memoryScope"?, "metadata"? }
```

Responses echo `scope`, `memoryScope`, and the derived `sessionKey` alongside
the standard run body. Invalid input/memoryScope returns 400; an unroutable
provider configuration returns 501 with the message persisted.

## Isolation tiers (optional by design)

Logical namespace isolation (scope metadata + scoped session keys) is the
default and is what this scaffold implements. Heavier tiers remain available
by deployment choice and are **never required** by the runtime:

1. Logical namespaces — default; shared process, shared storage.
2. Database/schema isolation — stronger tenant separation.
3. Process/container isolation — regulated, high-risk, or commercial Agent
   Pack deployments (one runtime per agent/tenant still works; nothing in the
   scaffold assumes shared process).
4. Network/secret isolation — when tool/API permissions differ per agent.

## v1 boundaries

- The scope filter enforces on the local/file recall provider path (including
  KB recall documents). Scope-aware sqlite-vec storage/queries are future
  scope, as is per-dimension storage partitioning.
- Core stays provider-agnostic: callers of `runMindStone` supply
  provider/model (the Gateway route resolves them from config, as always).
- `memoryScope` governs recall only; transcripts always record at the run's
  full scope.

## Claim status

Implemented + smoke-tested (`npm run smoke:app-engine`, 2026-07-02): session-key
derivation incl. companion degradation, subset-matching rule units,
cross-tenant/cross-agent/broader-scope/unscoped recall isolation on real
mock-routed runs, memoryScope levels incl. `none`, request-forced
persona/workflow authority order, transcript scope stamping (chat and gateway
paths), and the shared-gateway agent-scoped route with validation failures as
400s. No live-provider claims.
