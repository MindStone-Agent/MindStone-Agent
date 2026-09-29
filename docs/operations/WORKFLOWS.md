# Deterministic workflow router (MVP)

Workflows force persona/skill/KB routing from **conditions, not model judgment** —
the production-app requirement behind issue #12. A workflow evaluates per turn,
deterministically, before the model is called; its decision composes with the
persona system ([PERSONAS.md](PERSONAS.md)): a workflow-routed persona wins over
static/rule persona activation, with reason `workflow:<id>/step:<stepId>`.

Personas are role-themed packages — their `workflows.json` references participate
in workflow selection (see resolution order below), so a persona can carry its
own process.

## Artifact layout

```text
<dataDir>/workflows/<workflow-id>/workflow.json
```

```json
{
  "name": "Security triage",
  "version": "0.1.0",
  "steps": [
    { "id": "require-analyst", "kind": "gate",
      "gate": { "personaLoadable": "cyber-analyst" },
      "retry": { "maxAttempts": 2 }, "onFail": "stop" },
    { "id": "sec-route", "kind": "route",
      "when": { "messagePrefix": "sec:" },
      "personaId": "cyber-analyst",
      "skills": ["threat-intel"], "knowledgebases": ["ot-kb"] },
    { "id": "fallback-route", "kind": "route", "personaId": "general-helper" }
  ]
}
```

- **route** steps produce the decision when `when` matches (or unconditionally
  when absent); first match finishes the workflow.
- **gate** steps must pass before later steps are considered. Gate kinds:
  `personaLoadable` (persona artifacts load cleanly) and `condition` (same
  condition shape as `when`). `retry.maxAttempts` re-evaluates a failing gate;
  `onFail: "stop"` fails the workflow (turn proceeds without a decision, never
  blocked), `"continue"` skips it.
- Conditions: `sessionKeyPrefix`, `sourceChannel`, `sourceSubstrate`,
  `messagePrefix` (fields AND together).
- `skills`/`knowledgebases` on a route step narrow the answering persona's
  components for that turn (#125): only the listed skills stay in the prompt,
  and the listed KB ids narrow global collections and the persona's private
  KBs, each kind only if the step names one of its KBs. With no persona
  active they are only logged. See
  [PERSONAS.md](PERSONAS.md#components-at-run-time-125).
- `retry.maxAttempts` is capped at 5 (#125).

## Creating and editing workflows (#125)

`POST /admin/workflows` and `PATCH /admin/workflows/<id>` write
`workflow.json` after strict checks: unknown keys, an empty `when`, an empty
condition field or an empty gate (each of which the loader treats as "always")
are refused, `retry.maxAttempts` is 1 to 5, and a step may name only a persona
that exists under exactly that id and loads. Workflows written by hand stay
loadable as before. See [API_REFERENCE.md](../gateway/API_REFERENCE.md).

## Which workflow runs (deterministic selection order)

1. First matching `workflows.routes` rule in config
   (`{ "workflowId", "sessionKeyPrefix"|"sourceChannel"|"sourceSubstrate"|"messagePrefix" }`).
2. `workflows.active` in config.
3. The answering persona's `workflows.json` (one named by an App Engine
   request, or else the active one): every listed workflow, in order (#125).
   The first one that reaches a decision is used. One with no matching route
   step, or that doesn't load, passes to the next; a gate with
   `onFail: "stop"` ends the selection with no decision. The events of every
   workflow tried stay in the transcript, and the response's `workflow`
   lists them in `tried`.

A step whose `skills` or `knowledgebases` isn't a list of ids makes its
workflow fail to load (#142 review), so it is skipped as above: that turn
uses the persona's own lists, without the step's narrowing.

No match → no workflow; persona resolution proceeds as in PERSONAS.md.

## Transcript events

Each evaluated workflow appends `workflow_started`, `workflow_step` (matched or
skipped), `workflow_gate` (passed/failed, attempts), and `workflow_finished`
(with the decision) or `workflow_failed` events to the canonical transcript, in
both the native chat/TUI path and Gateway routes. Chat/Gateway responses carry a
`workflow` block (`workflowId`, `reason`, `failed`, `decision`).

## Claim status

Implemented + smoke-tested (`npm run smoke:workflow`, 2026-07-01): schema
round-trip (steps/conditions/gates/retries/failure/persona-skill-KB refs),
selection precedence including the persona-packaged fallback, gate retry and
stop-on-fail, transcript event sequence, and a real mock-routed chat turn where
the workflow forces the persona. No live-provider claims.
