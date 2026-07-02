# Skill Builder (v1)

Skills are reusable capability surfaces: a stable JSON definition plus a
`SKILL.md` prompt document. Issue #13 adds on-disk skill artifacts with an
explicit draft → install approval path. The existing **Integration Builder**
(`mindstone skill integration-builder`) is the first built-in example and the
template the artifact schema generalizes.

## Artifact layout

```text
<dataDir>/skills/<id>/skill.json + SKILL.md          # installed (approved)
<dataDir>/skills/drafts/<id>/skill.json + SKILL.md   # drafts awaiting approval
```

`skill.json` (stable schema — the same shape as the built-in
`MindStoneSkillDefinition`, plus provenance):

```json
{
  "id": "threat-triage",
  "label": "Threat Triage",
  "description": "Deterministic triage checklist for inbound threat reports",
  "whenToUse": ["triaging a new threat report"],
  "outputs": ["triage checklist"],
  "safetyNotes": ["never auto-block without approval"],
  "version": "0.1.0",
  "origin": "custom",
  "createdAt": "2026-07-02T00:00:00.000Z"
}
```

`SKILL.md` is the loadable prompt surface (`mindstone skill load <id>` prints it).

## Draft → install approval path

- `mindstone skill build --id X --label ... --description ... [--when ...]
  [--output ...] [--safety ...]` writes a **draft**. Drafts are visible in
  discovery but are not approved surfaces.
- `mindstone skill build --from-builtin integration-builder [--id my-copy]`
  seeds a draft from the built-in example (`origin: "builtin:integration-builder"`).
- `mindstone skill install <id>` validates the draft loads cleanly, promotes it
  to the installed area, and removes the draft. This is the named approval
  boundary — the same principle the Integration Builder skill itself teaches.
- Overwrites (draft over draft, install over installed) require `--force`.

## Discovery / status

- `mindstone skill list [--json]` — built-ins + installed + drafts; broken
  artifacts surface their parse/validation error instead of vanishing.
- `mindstone skill status [--json]` — counts by source, broken artifacts, and
  the active persona's `skills.json` references resolved against the catalog
  (`installed` / `builtin` / `draft` / `missing`).
- `mindstone skill load <id> [--json]` — resolution order: installed → draft →
  built-in (an installed artifact shadows a draft of the same id).
- `mindstone doctor` includes a `skills.catalog` check; `mindstone status`
  reports skill counts.

Persona packages reference skills by id in `skills.json`
([PERSONAS.md](PERSONAS.md)); workflow route steps carry `skills` refs into
their decisions ([WORKFLOWS.md](WORKFLOWS.md)). Those references now resolve
against this catalog.

## Claim status

Implemented + smoke-tested (`npm run smoke:skill`, 2026-07-02): artifact schema
round-trip, draft/install approval path with refusal-without---force, built-in
seeding, discovery/status including broken-artifact surfacing, persona skill
ref resolution, and generate+load of a local skill via the CLI. No
live-provider claims.
