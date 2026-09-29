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

## A persona the agent proposes, with its components (#125)

The agent's `mindstone-persona-proposal` can carry `components`:
- `skills`, `workflows`, `knowledgebases`: existing ones, by id. Approving the
  persona checks they exist (`422 unknown_component` otherwise) and writes
  them as its lists.
- `new.skills` (up to 3), `new.workflows` (up to 3), `new.privateKnowledgebases`
  (up to 2, each up to 5 markdown text sources): each becomes **its own
  approval card**, linked to the persona's card.
  - A component card can be approved only after its persona's
    (`409 persona_pending`); rejecting the persona rejects its components
    that are still waiting.
  - An approved component joins its persona's list, except that a new skill
    for a persona that lists no skills adds nothing: that persona already uses
    every installed skill, the new one included. A new skill goes through the
    install gate (advanced settings), and one already installed, or with a
    built-in skill's id, is refused, force or not. Approving it installs it
    like any skill: it is also in the prompt with no persona active, and for
    every persona that lists no skills. A new workflow is checked strictly, can't hand the
    turn to or gate on a persona, its skills must be installed by then, and an
    id the config runs or a persona lists is refused. A new private KB is
    written and ingested.
  - If the persona's folder is gone when a component is approved, it is
    refused (`409 invalid_persona`) before anything is installed or written.
    A card left waiting under a rejected persona is rejected when someone
    tries to approve it (`409 persona_rejected`); one whose persona card no
    longer exists is refused (`409 persona_missing`) and can only be rejected.
  - Some components can only be checked at approval: a new workflow whose
    step names a skill that isn't installed by then, or whose id is already
    taken, is refused then (`422 invalid_workflow`, `409 workflow_exists`),
    and its card can be rejected. The persona itself is unaffected.
  - `mindstone approvals show` prints everything a card holds: a persona's
    listed skills, shared KBs and workflows (with their steps) and its linked
    cards; a workflow card's `workflow.json`; a KB card's source text. The
    approve prompt shows the same.
- A persona proposal that doesn't hold up (its own fields, its JSON, or its
  components) is dropped whole, and the reply says why. So is one that would
  put a kind it brings over its pending cap (6 component cards of a kind per
  agent whose persona isn't rejected; a plain skill proposal doesn't count).
  Only one persona proposal per reply is put up for approval; the reply says
  how many other persona blocks were dropped. A separate skill proposal with
  the id of a skill the persona brings isn't saved. A skill's label is one
  line. A persona's new components may not hold characters that can't be
  seen. A plain skill proposal may not hold escape sequences, C1 or other
  control characters (line breaks and tabs aside, and not those in its label
  or description, which are one line), bidi overrides, separators or tag
  characters; it may hold zero-width joiners and variation selectors, which
  real writing needs. A memory write's path and a calendar mutation's
  resource are one line with none of those either; a proposal that breaks
  this is dropped.
  The CLI shows invisible characters as `\u{..}` in `approvals show` and the
  approve prompt, for drafts, memory writes and mutations too (stacked
  combining marks are shown as they are). Every drop on an owner's turn,
  persona or skill, is said in the reply and is a transcript event.
  Approving a proposed KB ingests its text sources only; if a URL
  source was added to it in between, ingest it from the persona editor. A
  component approved into a persona that no longer loads is added to its
  list but reported as not in use (`listed: false`); a skill for one that
  lists no skills adds nothing. A list file of the wrong shape is never
  rewritten: the component is reported as not added, to fix it by hand.
  Components are refused for: invisible characters or stacked combining marks
  in any of their text, a skill or workflow id both listed and brought as new
  (a shared KB and a private KB may share an id: they are separate), or a new
  skill with a built-in skill's id. Approving never activates, and a non-owner's
  proposal is dropped.
- The links live in the approval store (`parentApprovalId`), so a persona's
  lists only ever hold components that exist.

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

- A resolved-but-unloadable persona (missing `PERSONA.md`, bad `metadata.json`,
  a list file that isn't a list) never blocks the turn: the turn runs without
  the overlay and a `persona_load_failed` event is appended to the transcript.
  It runs with **no skills and no knowledge bases** (#142 review), not with
  every skill and every collection, and its `personaComponents` say
  `loadFailed: true`.
- `skills.json`, `workflows.json` and `knowledgebases.json` are `["id", …]` or
  `{"<name>": ["id", …]}` with only that key; ids are non-empty strings. Any
  other shape (`{}`, `null`, a misspelt key, `[1]`, `[""]`) makes the persona
  fail to load, since reading it as "no list" would mean everything.
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
