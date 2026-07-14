# Authoring a Persona Pack — a guide for agents

This is the practical how-to for authoring a **content pack** (the Phase 1 pack
class) — most often a **Persona Pack**: a signed, versioned bundle that installs
a role/domain overlay plus its supporting skills, knowledgebases, and workflows
into a MindStone agent. It is written for an *agent* doing the authoring.

- **Full design + rationale:** `docs/refactor/PACK_REGISTRY_DESIGN.md` (read that for the *why*; this is the *how*).
- **Runtime behaviour of an installed persona:** `docs/operations/PERSONAS.md`.
- **What ships today:** Phase 1 — the local content-pack lifecycle (`mindstone packs …`). No registry, no network, no Docker/agent packs yet.

> **The one-sentence mental model:** a pack is not a new runtime concept — it is
> a bundle of the artifacts the runtime *already* loads (personas, skills,
> knowledgebases, workflows), signed and given a lifecycle. So authoring a pack
> is authoring those artifacts, plus a manifest that declares and secures them.

---

## 1. When to author a pack (and which class)

- **Content pack (`class: "content"`) — this guide.** A role overlay + its
  skills/KBs/workflows + optional memory seeds. Installs into an *existing*
  agent's data directory. **A Persona Pack is a content pack.** Zero Docker.
- **Agent pack (`class: "agent"`) — NOT YET.** A ready-to-run Dockerized agent.
  Refused at install today (Phase 3). Don't author one.

If you are packaging "a role an agent can adopt" — CTI analyst, SOC responder,
code reviewer — you want a content pack. Continue.

---

## 2. Anatomy of a content pack (the source directory)

You author a **source directory**; the build tool turns it into a signed
`.mspack` archive. Source layout == archive layout == install layout:

```
my-pack/
  pack.json                              # the manifest (§5) — REQUIRED, at root
  personas/
    <persona-id>/
      PERSONA.md                         # REQUIRED, non-empty — the overlay text
      metadata.json                      # name / version / description
      safety.md                          # the persona's hard boundaries (see §3)
      skills.json                        # ["skill-id", …] this persona uses
      knowledgebases.json                # ["kb-id", …]
      workflows.json                     # ["workflow-id", …]
  skills/
    <skill-id>/
      skill.json                         # REQUIRED
      SKILL.md                           # REQUIRED — the loadable skill prompt
  knowledgebases/
    <kb-id>/
      kb.json                            # REQUIRED — catalog metadata
      sources/
        <name>.md                        # source documents (markdown; nested OK)
      # NO index.json — see §7. It is built AFTER install.
  workflows/
    <workflow-id>/
      workflow.json                      # the workflow definition
  memory/                                # OPTIONAL first-install-only seeds
    <name>.md
```

Every `artifacts.*` id you declare in `pack.json` must exist here as a
well-formed directory (the loaders' own validity rules, checked at install):
personas need `PERSONA.md`; skills need `skill.json` + `SKILL.md`; KBs need
`kb.json`. Declaring an id with no directory (or a directory with no declaration)
is a hard refusal.

---

## 3. The persona overlay (the heart of a Persona Pack)

### `personas/<id>/PERSONA.md`
The role/domain overlay. It is injected **below** the agent's core identity —
it shapes *how the agent works in this role*, and it **never overrides** who the
agent is, the user's boundaries, or core safety. Write it as instructions to an
agent adopting the role. Ground it in real practice; be specific about method,
not vibes. This is a **prompt surface** a reviewer will read (§6) — every word
here reaches the model.

### `personas/<id>/safety.md`
The role's hard boundaries, appended below the overlay. State what the role must
*never* do without approval (e.g. "never auto-block, auto-report, or contact a
third party without explicit human approval"). Also a prompt surface.

### `personas/<id>/metadata.json`
```json
{ "name": "CTI Analyst (Lite)", "version": "0.1.0", "description": "Cyber threat intelligence triage overlay." }
```
`name` falls back to the id if omitted.

### The capability reference files
`skills.json`, `knowledgebases.json`, `workflows.json` — each is either a bare
array or a `{ "<key>": [...] }` object. Both forms work:
```json
["source-triage", "ioc-extraction"]
```
```json
{ "skills": ["source-triage", "ioc-extraction"] }
```
**Every id referenced here must resolve** — it must be either in *this* pack or
already installed on the target. An unresolved reference is a hard refusal at
install (this is how persona↔skill/KB/workflow compatibility is checked).

---

## 4. Skills

### `skills/<id>/skill.json`
```json
{
  "id": "source-triage",
  "label": "Source Triage",
  "description": "Deterministic triage checklist for inbound threat reports.",
  "whenToUse": ["triaging a new threat report or feed item"],
  "outputs": ["a ranked triage checklist"],
  "safetyNotes": ["never auto-block or auto-report without human approval"],
  "version": "0.1.0",
  "origin": "custom"
}
```
`id` and `description` are the load-bearing fields; the rest sharpen behaviour.

### `skills/<id>/SKILL.md`
The loadable skill prompt — the actual method/checklist the agent follows when
the skill is engaged. A prompt surface (§6).

---

## 5. Knowledgebases (read §7 carefully — this is where packs get refused)

### `knowledgebases/<id>/kb.json`
```json
{
  "id": "ot-threat-references",
  "name": "OT Threat References",
  "description": "Reference material on OT/ICS threat actors and TTPs.",
  "sources": []
}
```
### `knowledgebases/<id>/sources/*.md`
The reviewed source documents. Markdown, nested dirs allowed. **This is the only
place a pack may put KB content.** These `.md` files are prompt surfaces (§6) —
their content is ingested into recall, so a reviewer reads them.

**A packed `kb.json` is validated as untrusted config** (a pack is third-party,
even when a trusted agent authors it):
- **No `externalSources`.** A packed KB must be self-contained (bundle your
  `sources/`). External folders/URLs are the *operator's* post-install decision.
- **`name`/`description` must be plain single-line labels** — ≤200 chars, no
  double-quote (`"`), no control characters. They are injected verbatim into
  recall (`Knowledgebase "<name>" …`), so a hostile label would be an injection.
- **Do NOT ship `index.json`** (in any casing). The index is *generated* after
  install by `mindstone kb ingest` from your reviewed `sources/`. Shipping one
  is refused.

---

## 6. Prompt surfaces — the security spine

A **prompt surface** is any file whose content reaches the model. The manifest's
`safety.promptSurfaces` must list **every** one, and the installer independently
re-derives the set and refuses the pack if the declared list doesn't match
**exactly**. This is the mechanism that guarantees a reviewer has seen every word
your pack will feed an agent — an undeclared surface is an integrity *failure*,
not a warning.

**Rule 1 (the current derivation):** the prompt-surface set is **every archive
path whose name ends in `.md` (case-insensitive)** plus the declared
`identitySeed`. That means: every `PERSONA.md`, `safety.md`, `SKILL.md`, KB
`sources/*.md`, and `memory/*.md` — all of them, automatically.

**You do not hand-maintain this list.** Build with `--derive-surfaces` and the
build tool computes it for you (and refuses to build if a `.md` file would be an
undeclared surface). Just make sure every `.md` in your pack is content you're
willing to have reviewed. (Prompt text embedded in JSON — `skill.json`,
`workflow.json`, `kb.json` — is covered by per-file digests + whole-artifact
review, not this list; but keep it clean anyway.)

---

## 7. The hardened rules — what will get your pack REFUSED

These are enforced at install (and most at build). They came out of five rounds
of adversarial security QA; respect them and your pack builds and installs
first try:

1. **Prompt-surface mismatch** — declared `promptSurfaces` ≠ the derived `.md`
   set. Fix: build with `--derive-surfaces`.
2. **KB non-whitelist file** — anything under `knowledgebases/<id>/` other than
   `kb.json` or `sources/**` (including a shipped `index.json` in *any* casing,
   or a stray file). Fix: ship only `kb.json` + `sources/`.
3. **KB `kb.json` unsafe** — `name`/`description` with a `"`/newline/control
   char or >200 chars, or any `externalSources`. Fix: plain labels; no external
   sources.
4. **File/dir path collision** — an entry that is both a file *and* a directory
   prefix of another (e.g. `personas/foo` and `personas/foo/PERSONA.md`). Don't
   create a bare file at a path that's also a directory.
5. **Secrets / executables / absolute host paths** — a denylist scan rejects
   private keys, provider/API tokens, `/Users/...` or `/home/...` paths, and
   executable/interpreter files (`.sh .py .js .rb .bat …`) outside `deploy/`.
   Packs are inert data; ship no runnable content.
6. **Content-class violations** — a `content` pack must NOT contain a `runtime`
   block or an `identitySeed` (those are agent-class only).
7. **Unresolved capability references** — a persona referencing a skill/KB/
   workflow that's neither in the pack nor already installed.
8. **Unsigned without the two-act hatch** — see §8.

---

## 8. Build → sign → install

Phase 1 is fully local. No network, no registry.

```bash
# 1. Generate a signing keypair. For a real PUBLISHER key, use --out: the private
#    key is written to a chmod-600 file (never printed), only the public key shows.
mindstone packs keygen --out ~/.mindstone/<publisher>.key
#   → public key printed (share/pin this); private key in the file (keep it OFFLINE)
#   (Bare `mindstone packs keygen` prints both — dev/throwaway keys only.)

# 2. Trust your public key so signed installs verify (publisher = first id segment).
#    NOTE: first-party `mindstone/...` packs are signed with the mindstone release
#    key, whose PUBLIC half is shipped in the harness trust seed — they verify out
#    of the box, no trust-add needed. Only add a key for your OWN publisher id.
mindstone packs trust-add <publisher> ed25519:<pub> --key-id my-key

# 3. Build a signed archive (derive prompt surfaces automatically)
mindstone packs build ./my-pack --out ./dist --key 'ed25519-priv:<priv>' --derive-surfaces
#   → ./dist/<publisher>__<name>-<version>.mspack  (+ .sig)

# 4. Inspect before installing — read the safety summary + prompt-surface list
mindstone packs inspect ./dist/<...>.mspack

# 5. Install (the .sig next to the archive is picked up automatically)
mindstone packs install ./dist/<...>.mspack
#   → shows the consent summary (surfaces, risk notes, what installs where); confirm

# 6. Verify integrity any time
mindstone packs verify <publisher>/<name>
mindstone packs list
mindstone doctor           # packs.{catalog,integrity,trust,compat} checks
```

**Unsigned dev builds** (no key): the archive is installable only via the
deliberate two-act hatch — `packs.allowUnsigned: true` in config **and**
`--unsigned` on the install. It's marked `trusted:false` and doctor warns while
it's installed. Use for local iteration only; ship signed.

**Update/remove:** `packs install` of a newer version routes to update semantics
(unmodified files replaced; user-modified files kept with the incoming version
staged as `.pack-new`; memory seeds never re-applied). `packs remove <id>`
never touches user data; `--purge` drops the payload tombstone too.

---

## 9. The manifest — `pack.json` (annotated)

```jsonc
{
  "schemaVersion": 1,
  "id": "mindstone/cti-analyst-lite",   // <publisher>/<name>; both [a-z0-9-]{1,64}
  "class": "content",
  "name": "CTI Analyst (Lite)",
  "description": "Cyber threat intelligence triage overlay with source-triage and IOC skills.",
  "version": "0.1.0",                    // SemVer 2.0.0
  "license": "proprietary",
  "publisher": { "id": "mindstone", "name": "MindStone" },
  "tier": "free",                        // "free" | "paid" | "enterprise"
  "engines": { "mindstone": ">=0.0.0" }, // harness compatibility range
  "dependencies": {},                    // { "<publisher>/<name>": "^1.0.0" } — flat, install-time-checked

  "artifacts": {
    "personas": ["cti-analyst"],
    "skills": ["source-triage", "ioc-extraction"],
    "knowledgebases": ["ot-threat-references"],
    "workflows": [],
    "memorySeeds": "memory/"             // OPTIONAL; first-install-only import into the agent's memory
  },

  "safety": {
    "reviewStatus": "reviewed",          // "reviewed" | "unreviewed" | "revoked"
    "reviewedBy": "aegis",
    "reviewedAt": "2026-07-14T00:00:00Z",
    "promptSurfacesRule": 1,             // MUST be 1 (unknown rule → refused)
    "promptSurfaces": [],                // leave [] and use --derive-surfaces; the build fills it
    "riskNotes": ["KB references external threat feeds by description only; ingest is extractive."],
    "boundaries": ["never auto-block, auto-report, or notify a third party without human approval"]
  },

  "updates": { "channel": "stable" },
  "files": "MANIFEST.sha256",            // generated by the build tool — do not hand-author
  "createdAt": "2026-07-14T00:00:00Z"
}
```

Validation invariants (enforced): `schemaVersion` and `promptSurfacesRule` must
be known (unknown → fail-closed refuse); `id` matches the pattern; `version`
parses as SemVer; every declared artifact is well-formed; `content` class omits
`runtime`/`identitySeed`.

---

## 10. Review + honest claims

- **`safety.reviewStatus`** is the review unit. `reviewed` means a named
  reviewer (`reviewedBy`/`reviewedAt`) has read the prompt surfaces and the
  tool/network posture. An `unreviewed` pack installs only with an explicit
  confirm (or `--accept-unreviewed`). `revoked` is the emergency brake.
- Reviewing a pack = reading every declared prompt surface + the `riskNotes`/
  `boundaries` + the skill/KB posture. The install consent summary shows exactly
  this to the operator.
- **Claim discipline:** a pack is "reviewed," not "safe." Never claim a reviewed
  pack cannot misbehave — review is a point-in-time human read of prompt content.

---

## 11. Author's checklist

- [ ] `pack.json` at root; `class: "content"`; `promptSurfacesRule: 1`.
- [ ] Every declared artifact id has a well-formed directory.
- [ ] `PERSONA.md` non-empty; `safety.md` states hard boundaries.
- [ ] Every persona `skills.json`/`knowledgebases.json`/`workflows.json` id
      resolves (in-pack or already installed).
- [ ] KB dirs contain ONLY `kb.json` + `sources/**`; no `index.json`; `kb.json`
      has plain labels and no `externalSources`.
- [ ] No secrets, no absolute host paths, no executable files.
- [ ] Built with `--derive-surfaces`; `packs inspect` shows the surfaces you
      expect; nothing surprising.
- [ ] Signed (or deliberately unsigned for local dev only).
- [ ] `packs install` succeeds; `packs verify` clean; `doctor` green.

---

*Companion to `docs/refactor/PACK_REGISTRY_DESIGN.md` (design) and
`docs/operations/PERSONAS.md` (runtime behaviour). Phase 1 — local content-pack
lifecycle. Registry, agent packs, entitlements, and the marketplace are
design-only.*
