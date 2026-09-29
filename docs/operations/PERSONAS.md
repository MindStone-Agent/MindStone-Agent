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

## Components at run time (#125)

While a persona is active, its components are the ones in play. The active
persona is the one that answers the turn: one named by an App Engine request,
then one a workflow step routes to, then the route rules and `personas.active`.

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
  with the same id stay apart. A `knowledgebases` folder that is a link is not
  searched. Manage them with `mindstone kb … --persona <id>`
  ([KNOWLEDGEBASES.md](KNOWLEDGEBASES.md)). "Private" is a recall rule, not a
  security boundary: anything a reply quotes lands in the transcript, and the
  agent's file tools (off by default) can read any file it can reach.
- **Workflows.** Every workflow in `workflows.json` is a candidate, in order;
  the first to reach a decision is used ([WORKFLOWS.md](WORKFLOWS.md)).
  `workflows.active` and workflow route rules still come first.
- **Workflow steps.** When a step routes to another persona, that persona's
  components apply. A step's `skills` and `knowledgebases` narrow the set:
  only the listed ids stay (a step's `knowledgebases` names global and
  private KB ids alike).
- Each assistant entry, and the gateway's native chat response, records
  `personaComponents`: the persona, its skill list (or `all`) and the skills
  in the prompt, any listed skill that is missing, and the global and private
  KBs searched.

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
