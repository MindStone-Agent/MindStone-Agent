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
- `skills`/`knowledgebases` on route steps are carried into the decision as
  references; they resolve against the skill catalog ([SKILLS.md](SKILLS.md))
  and KB catalog ([KNOWLEDGEBASES.md](KNOWLEDGEBASES.md)) shipped in #13.

## Which workflow runs (deterministic selection order)

1. First matching `workflows.routes` rule in config
   (`{ "workflowId", "sessionKeyPrefix"|"sourceChannel"|"sourceSubstrate"|"messagePrefix" }`).
2. `workflows.active` in config.
3. The active persona's packaged `workflows.json` (first reference) — personas
   bring their own process.

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
