# Persona overlays (MVP)

Personas are reusable role/domain overlays that sit **below** the core agent
identity: the standing `IDENTITY.md`/`USER.md` context always comes first in the
prompt, and the overlay explicitly states that it never overrides the core
identity, user boundaries, or safety rules. This is the persona-package MVP from
`docs/refactor/AGENT_PACKS.md` (Persona Packs), scoped to local artifacts.

## Artifact layout

```text
<dataDir>/personas/<persona-id>/
  PERSONA.md          required — the role/domain overlay text
  metadata.json       optional — { "name", "version", "description" }
  safety.md           optional — appended to the overlay prompt
  skills.json         optional — ["skill-id", ...] installed skills it uses
  workflows.json      optional — ["workflow-id", ...] its workflows, in order
  knowledgebases.json optional — ["kb-id", ...] global KB collections it uses
  knowledgebases/     optional — its own private knowledge bases
    <kb-id>/          the global KB format: kb.json, sources/*.md, index.json
```

Default personas dir: `.runtime/mindstone/personas/` (override with
`personas.dir` in config).

## Activation

**Static (CLI):**

```bash
mindstone persona list
mindstone persona activate <persona-id>   # writes personas.active + transcript event persona_activated
mindstone persona status
mindstone persona deactivate              # clears personas.active + transcript event persona_deactivated
```

**Deterministic route rules (config)** — first matching rule wins, falling back
to `personas.active`:

```json
{
  "personas": {
    "active": "general-helper",
    "routes": [
      { "personaId": "cyber-analyst", "sessionKeyPrefix": "agent:default:sec" },
      { "personaId": "support", "sourceChannel": "webchat" }
    ]
  }
}
```

Rule fields (`sessionKeyPrefix`, `sourceChannel`, `sourceSubstrate`) AND
together within a rule. Resolution runs per turn in both the native chat/TUI
path and all Gateway routes.

## Building a persona in the Console (#125)

The admin API creates and edits personas, workflows and private knowledge
bases ([API_REFERENCE.md](../gateway/API_REFERENCE.md), "Admin API"). The
rules:
- Saving never activates a persona; switching to it is a separate step.
- A new persona id is lowercase; an id already on disk in any case, or one
  the config uses, is refused, as for an approved proposal (#105).
- Every component a persona lists must exist: installed skills, workflows
  that load, global collections. A new skill goes through the Skill Builder
  and the advanced-settings install gate first.
- Private KBs take markdown text sources, and URL sources with the
  advanced-settings permission (the gateway host fetches them at ingest).
- Creates are staged in a dot folder and moved into place; nothing
  half-written is ever listed.

## Components at run time (#125)

While a persona is active, its components are the ones in play. The active
persona is the one that answers the turn: one named by an App Engine request,
then one a workflow step routes to, then the route rules and `personas.active`.
With no persona active, nothing changes.

- **Skills.** Only the skills in `skills.json` go into the owner's prompt.
  With no `skills.json` (or an empty list), every installed skill goes in, as
  before. A listed skill that isn't installed is skipped, and the turn records
  it. A persona pack's existing `skills.json` now restricts the prompt to
  those skills.
- **Global knowledge bases.** Only the collections in `knowledgebases.json`
  are searched. With none listed, every global collection is searched, whether
  or not the persona has private KBs.
- **Private knowledge bases.** A persona's own KBs, under
  `personas/<id>/knowledgebases/`, are searched only while that persona is
  active: on the owner's turns and on tenant App Engine runs under it, never
  under another persona. Non-owner chats get no recall at all. Their recall
  ids are `pkb:<persona-id>:<kb-id>:<source>`, so a private and a global KB
  with the same id stay apart. They are the persona's own files: a persona
  folder, `knowledgebases` folder, KB folder, `kb.json`, `index.json` or
  `sources` that is a symbolic link is not used, and ingesting one refuses
  linked source files and folder sources outside it. Manage them with `mindstone kb … --persona <id>`
  ([KNOWLEDGEBASES.md](KNOWLEDGEBASES.md)). "Private" is a recall rule, not a
  security boundary: anything a reply quotes lands in the transcript, the
  agent's file tools (off by default) can read any file it can reach, and
  anyone who can write the data folder can place content anywhere (hard
  links, or a global KB whose files point at a private one).
- **Workflows.** Every workflow in `workflows.json` is a candidate, in order;
  the first to reach a decision is used, and a gate with `onFail: "stop"`
  ends the selection ([WORKFLOWS.md](WORKFLOWS.md)). `workflows.active` and
  workflow route rules still come first. A persona named by an App Engine
  request uses its own `workflows.json`.
- **Workflow steps.** When a step routes to another persona, that persona's
  components apply. A step's `skills` narrow the skill set. Its
  `knowledgebases` narrow global collections and private KBs each on its own:
  a kind is narrowed only if the step names one of its KBs, so naming a
  private KB never turns global recall off. A step id that matches no KB
  narrows nothing, and the turn records it (`stepKnowledgebasesUnknown`). When a persona named by the
  request answers instead of the one a step routed to, that step doesn't
  narrow it. With no persona active, a step's lists are only logged, as
  before.
- Each assistant entry, and the gateway's native chat response, records
  `personaComponents`: the persona, its skill list (or `all`) and the skills
  in the prompt, any listed skill that is missing, its global KB list (or
  `all`), a step's KB list, and whether its own private KBs were searched.
  Like `personaContext`, it is left out of the entries a non-owner's response
  returns. The Console's Skills page marks a skill the persona set in
  `personas.active` leaves out as not in the prompt (route rules and
  workflows aren't reflected there).

## Behavior notes

- A resolved-but-unloadable persona (missing `PERSONA.md`, bad `metadata.json`)
  never blocks the turn: the turn runs without the overlay and a
  `persona_load_failed` event is appended to the transcript.
- Route/chat responses report the injected persona in `personaContext`
  (`personaId`, `reason`, `tokenEstimate`), mirroring `identityContext`.
- Visibility: `mindstone status` (Personas/Persona active lines),
  `mindstone doctor` (`personas.catalog`, `personas.active` checks — broken
  persona dirs are flagged), TUI `/persona` panel.

## Claim status

Implemented + smoke-tested (`npm run smoke:persona`, 2026-07-01): artifact
loading, identity-first precedence (asserted on the built prompt plan),
CLI activate/deactivate with transcript events, deterministic route rules
(rule beats static active), mock-routed chat turn carrying `personaContext`,
status/doctor visibility, and load-failure surfacing. Not yet validated with a
live provider (no live-LLM claims). Components take effect at run time (#125,
`scripts/smoke-persona-components.sh`): skills, global and private knowledge
bases, and workflows, as described above.
