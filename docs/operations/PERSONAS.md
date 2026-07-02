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
  skills.json         optional — ["skill-id", ...] (referenced metadata for now)
  workflows.json      optional — ["workflow-id", ...]
  knowledgebases.json optional — ["kb-id", ...]
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
live provider (no live-LLM claims). Skills/workflows/knowledgebases references
now have runtime targets: workflows participate in selection (#12,
[WORKFLOWS.md](WORKFLOWS.md)); skill refs resolve against the skill catalog and
KB refs against the KB catalog (#13, [SKILLS.md](SKILLS.md) /
[KNOWLEDGEBASES.md](KNOWLEDGEBASES.md) — see `mindstone skill status`).
