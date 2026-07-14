# Pack Registry and Marketplace — Design

**Ticket:** #28 — Pack registry and marketplace design
**Status:** **Phase 1 (local content-pack lifecycle) IMPLEMENTED + smoke-tested.** Phases 2–5 (registry client, agent packs, entitlements, marketplace site) remain design-only. See §16 for the current per-subject claim table. Design baseline: `4e6502cb`.

> **Phase 1 as-built (the AC2 path):** `packages/mindstone-core/src/packs/` (manifest validator, ed25519 signing, in-memory ustar+gzip with the extraction guard, dependency-free SemVer, staged install/update/remove/verify with receipts, build tool) + `mindstone packs` CLI noun + `packs` config section + `packs.{catalog,integrity,trust,compat}` doctor checks + `pack_installed`/`pack_updated`/`pack_removed` transcript events. Proven by `smoke:packs` (10 legs: signed roundtrip, user-modify→update→conflict→remove-retains-user-file, tampered-sig refusal, unsigned two-act hatch, zip-slip refusal, collision refusal + --force backup, promptSurfaces-mismatch refusal, verify drift detection, doctor surfacing). No network path exists yet by construction.
**Provenance:** the judged deliverable of a pre-registered two-candidate design A/B (see the 2026-07-03 addendum in `docs/case-studies/lca-orchestration-vs-model-capability.md`); synthesized from the winning candidate plus the reviewers' recommended imports and fixes from the runner-up.
**Relation to prior work:** Refines and supersedes the registry/packaging portions (§5–§10) of the planning draft `docs/refactor/AGENT_PACKS.md`. Product naming, commercial framing, and Docker-stack material from that draft are adopted where still accurate and sharpened where this design makes a concrete call.

---

## 1. Summary

MindStone needs a way to package, distribute, install, update, and remove **Agent Packs** (ready-to-run Dockerized role agents) and **Persona Packs** (reusable role/domain overlays and their supporting skills, workflows, and knowledgebases). This document specifies:

- a single versioned **pack manifest** schema with two pack classes,
- **versioning** and compatibility rules,
- a **signing and checksum** chain from publisher key to installed file,
- a **dependency** model,
- the **registry protocol** for free, paid, and private distribution,
- the **CLI surface** (`mindstone packs …`) including a fully local, registry-free install/update path,
- **safety review metadata** and the trust model for what is fundamentally a *prompt-surface supply chain*,
- free vs paid boundaries, entitlements, implementation phases, and honest public-claim rules.

The governing insight from recon: **MindStone already has four artifact subsystems with a common shape** — personas (`<dataDir>/personas/<id>/`), skills (`<dataDir>/skills/<id>/`, with a `drafts/ → install` named approval boundary), knowledgebases (`<dataDir>/knowledgebases/<id>/`, with an operator-authored `kb.json` trust boundary), and workflows (`<dataDir>/workflows/`). A pack is not a new runtime concept. **A pack is a signed, versioned bundle of artifacts that installs into the stores the runtime already loads.** The registry design's job is distribution, integrity, provenance, and lifecycle — not a new loading path.

### Ticket coverage map

| # | Ticket design element | Where |
|---|---|---|
| 1 | Pack manifest | §4 |
| 2 | Versioning | §5 (+ lockfile §8) |
| 3 | Signing/checksum | D4, §4, §6 |
| 4 | Dependency declaration | D5, §4, §7.1 step 7 |
| 5 | Free starter packs | §13 |
| 6 | Optional paid/professional packs | §13, D7 |
| 7 | Entitlement / private registry path | §6.2, D7 |
| 8 | Install/update/remove commands | §7, §7.1, §7.2, §10 |
| 9 | Safety review metadata | §11 (+ manifest `safety` block §4) |
| AC1 | Registry design doc exists | this document (§15) |
| AC2 | Local pack install/update path defined or scaffolded | §7.1, §8, §10, §14 Phase 1 |
| AC3 | Public claims distinguish design from implemented | §16 + status header |

## 2. What exists today (constraints this design must fit)

| Existing element | Location | Pattern this design reuses |
|---|---|---|
| Persona artifacts | `<dataDir>/personas/<id>/` (`PERSONA.md`, `metadata.json`, `safety.md`, `skills.json`, `workflows.json`, `knowledgebases.json`) | Install target; persona refs must resolve against catalogs |
| Skill artifacts | `<dataDir>/skills/<id>/` (`skill.json` + `SKILL.md`); drafts under `skills/drafts/<id>/`; `skill install` promotes | The **staging → verify → named-approval → commit** install shape; `--force` for overwrites; broken artifacts surface errors instead of vanishing |
| Knowledgebases | `<dataDir>/knowledgebases/<id>/` (`kb.json`, `sources/`, `index.json`) | Operator-authored config = trust boundary; **fetch at explicit command time only** (never background); `sensitivity` labels |
| Workflows | `<dataDir>/workflows/` | Install target |
| Approvals (#21/#22) | `packages/mindstone-core/src/channels/approval.ts` — `ProposedActionKind = connector_send \| memory_write \| connector_mutation`; durable store; immutable decisions; transcript audit events | Consequential actions are proposed, not executed; #24 extends the taxonomy — the future hook for *model-proposed* pack operations |
| Connector catalog | `packages/mindstone-core/src/channels/catalog.ts` — status enum `available \| diagnostic \| planned \| not_validated \| not_implemented`; "diagnostic only, does not start listeners or probe networks" | The honest-status vocabulary and the no-implicit-network doctrine, reused for the pack catalog |
| CLI dispatch | `packages/mindstone-cli/src/index.ts` — `argv[2]` = noun, `argv[3]` = subcommand; nouns include `persona`, `skill`, `kb`, `approvals`, `doctor` | `packs` becomes a new noun with the same shape, `--json` flags, EPIPE-safe output |
| Config | `MindStoneConfig` per-subsystem sections with `dir?` overrides (`personas`, `skills`, `knowledgebases`, …) | New `packs` section, same conventions |
| Runtime paths | `paths/runtime.ts` — everything under `dataDir` (default `.runtime/mindstone`) | `<dataDir>/packs/` for all pack state |
| Doctor | `doctor/types.ts` — checks with severity `pass \| warn \| fail \| info`; existing `skills.catalog`, `personas.catalog` checks | `packs.*` checks |
| Secrets discipline | Connectors take **REFs** (`tokenEnv` / `tokenFile`), never inline secrets; access fails closed | Registry auth and entitlement tokens use the identical REF pattern |
| Claim taxonomy | implemented / smoke-tested / live-validated / pending / post-MVP; docs end with a "Claim status" section | §16 public-claims rules; this doc's own status header |

Not found in recon (verified absent): any existing artifact signing/checksum utility, any `packs` CLI noun, any registry client. `createHash` usage exists only in memory/lifecycle content-hashing — nothing reusable for distribution trust. This subsystem is built new.

## 3. Core design decisions

Each decision lists the alternatives actually considered and why the call went the way it did.

### D1 — One manifest schema, two pack classes: `content` and `agent`

A **content pack** (`class: "content"`) bundles personas, skills, workflows, knowledgebases, and optional memory seeds. It installs into an *existing* agent's data directory. **Persona Packs are content packs.**

An **agent pack** (`class: "agent"`) is a ready-to-run deployment: a Docker Compose stack + signed image reference + an **embedded content pack** as its seed payload (identity seed, persona stack, memory scaffold, KB seeds, default skills/workflows, Gateway/WebChat config).

- *Alternative — separate manifest formats per pack type:* rejected. Two schemas means two validators, two catalog entry shapes, two signing paths, and a fuzzy boundary for packs that are "mostly content plus a compose file."
- *Alternative — agent packs as plain content packs plus a compose file:* rejected. The lifecycles genuinely differ (file copy vs container orchestration; remove vs compose-down; update vs image pull), and the manifest must express runtime requirements (`requires.docker`) that content packs must not carry.
- *Why embedding works:* an agent pack's update path decomposes into "update the runtime shell (image, compose)" + "update the seed payload," and the seed payload update reuses the content-pack update machinery (§10) unchanged.

### D2 — Content packs install INTO the existing artifact stores, with central receipts for provenance

`packs install` writes personas into `<dataDir>/personas/`, skills into `<dataDir>/skills/`, and so on — the same directories the loaders already read. The runtime needs **zero changes** to load pack-delivered content. Provenance (which pack owns which file, at which hash) lives in a central **receipt** per installed pack (§8), not in the artifact directories.

- *Alternative — parallel pack-scoped stores* (`<dataDir>/packs/<id>/personas/…`) *with multi-root loaders:* rejected. Every subsystem (persona load, skill catalog, KB ingest/status/recall, workflow selection, doctor checks, persona ref-resolution) would need multi-root awareness. That is a wide, drift-prone change for no user-visible benefit.
- *Alternative — symlink farms* (store under `packs/`, symlink into stores): rejected. Symlink behavior is a platform liability (Windows, Docker volume mounts) and loaders were not written with symlink traversal in mind.
- *Alternative — provenance dotfiles inside each artifact dir* (`.pack-origin.json`): rejected in favor of central receipts. Artifact loaders enumerate directory contents and surface broken files; foreign files in artifact dirs invite loader-compatibility questions that central receipts avoid entirely.
- *Accepted consequence:* at runtime, pack-installed artifacts are indistinguishable from user-authored ones — which is exactly the point. User-edit detection is done by hash comparison against the receipt (§10), never by file location.

### D3 — Registry v1 is a signed static index over HTTPS; images ride standard OCI registries; local paths are first-class registries

The v1 registry is a **static, signed JSON index** (`index.json` + detached signature) served over HTTPS, listing packs, versions, archive digests, and download URLs. Docker images for agent packs are **not** served by this index — the manifest pins them by OCI digest and they pull from standard container registries (public for free packs, authenticated for paid).

A **local directory or file path is a valid registry source** (`packs install ./pack.mspack`, `packs install --registry file:///…`). This is what makes AC2's local install path registry-independent, enables air-gapped/enterprise distribution, and is the entire distribution story for Phase 1.

- *Alternative — OCI artifacts for everything (ORAS):* seriously considered; one distribution channel, existing auth semantics, content-addressable by construction. Rejected for v1 because it forces OCI tooling onto content packs (a persona overlay should not require a container runtime to install), complicates static/simple hosting, and adds a dependency surface before there is a catalog to justify it. The index schema deliberately abstracts the download URL, so an OCI-backed storage backend can be adopted later without changing the client's trust chain.
- *Alternative — dynamic registry API service:* required eventually for entitlements (Phase 4 adds an authed variant), but the free path must not require MindStone to operate a service for v1. Static index + static archives = CDN-hostable, trivially mirrorable, and auditable.
- *Alternative — a git repository as the registry:* rejected. Tag mutability, no entitlement story, poor fit for large KB seed archives.
- *Network doctrine:* the registry is contacted **only on explicit commands** (`packs list --remote`, `search`, `inspect --remote`, `install`, `update`). No background polling, no phone-home. This mirrors the KB rule (URL sources fetch at ingest time only) and the catalog rule (status commands do not probe networks).

### D4 — Signing: ed25519 detached signatures over archive digests, pinned publisher keys; cosign for images; TUF-compatible but not TUF now

The trust chain, end to end:

```
harness-shipped trust store (pinned publisher keys)
  → verifies index.json.sig            (registry authenticity + freshness serial)
      index pins sha256 per pack archive
  → verifies <archive>.sig             (publisher authenticity of the pack itself)
      archive contains pack.json + MANIFEST.sha256 (per-file digests)
  → per-file digest verification at extract time (zip-slip-guarded)
  → receipts record installed-file digests (post-install integrity via doctor)
```

Concretely: a pack ships as `<id>-<version>.mspack` (tar.gz) plus a detached ed25519 signature over `sha256(archive)`. The registry index is signed the same way and carries a **monotonic `serial`** the client caches — a served index with a lower serial than last-seen is rejected (minimal rollback protection).

- *Alternative — checksums only, no signatures:* rejected. Integrity without authenticity: a compromised registry or a MITM (or a poisoned mirror) serves consistent hash+archive pairs and the client is none the wiser. Given what packs contain (§D6), authenticity is not optional — **including for free packs**; the trust chain does not vary by price.
- *Alternative — GPG:* rejected. Heavy dependency, notoriously poor key-management UX, and no benefit over a modern single-purpose signature for a first-party catalog.
- *Alternative — sigstore keyless (Fulcio/Rekor):* attractive later; **adopted now only where it is already the ecosystem norm — container images** (agent pack images SHOULD be cosign-signed and are always digest-pinned in the manifest regardless). For content archives, keyless verification implies online transparency-log checks, which conflicts with the local-first/air-gapped posture. Revisit when third-party publishers exist.
- *Alternative — full TUF:* the gold standard against rollback/freeze/key-compromise, and consciously **not** v1. Cost: four role keys, delegation metadata, expiry management — heavy for a first-party, single-publisher catalog. The design keeps the migration path open: the signed index with a monotonic serial is structurally a degenerate TUF snapshot+targets; if/when third-party publishing arrives (Phase 5+), TUF is the named upgrade.
- *Key management:* the trust store (`<dataDir>/packs/trust/publishers.json`, seeded from a copy shipped inside the harness package) supports multiple keys per publisher, key expiry, and key revocation delivered through harness updates. Honest statement of the root of trust: **the harness distribution channel is the root of trust.** A compromised harness install cannot be saved by pack signing, and the design does not pretend otherwise.
- *Escape hatches, fail closed:* unsigned installs require BOTH `packs.allowUnsigned: true` in config AND `--unsigned` on the command (two deliberate acts), exist for pack development, warn loudly, and are recorded in the receipt (`trusted: false`) where doctor surfaces them forever after.

### D5 — Dependencies: flat, declared, install-time-checked; no auto-resolution in v1

A pack declares dependencies on other packs by `id` + SemVer range, plus an `engines.mindstone` harness-compatibility range. At install time the resolver checks: every dependency is already installed at a satisfying version, the harness version satisfies `engines`, and every cross-artifact reference (a pack persona's `skills.json`/`knowledgebases.json` refs) resolves within {this pack ∪ its declared dependencies ∪ already-installed artifacts}. Any failure aborts with the exact list of unsatisfied requirements and the literal commands that would satisfy them.

- *Alternative — full dependency solver with auto-install (npm-style):* rejected for v1. The catalog will be tens of packs, not thousands; a solver's failure modes (surprise installs, version backtracking) cost more trust than they save typing. `--with-deps` convenience sugar can be added later without schema change.
- *Alternative — side-by-side multiple versions:* rejected. Artifact stores are keyed by artifact id; two versions of a persona cannot coexist under one id, and inventing namespaced ids would leak packaging concerns into every runtime surface. **Single version per pack per agent installation.** Conflicting range requirements from two packs = install refusal with both constraints printed.
- Persona-pack compatibility (an open question in the planning draft) is answered by this mechanism: compatibility with agents = `engines` + dependency ranges; compatibility with skills/workflows/KB schemas = reference resolution at install, mirroring what `mindstone skill status` already does for persona refs at runtime.

### D6 — The trust boundary: operator-initiated installs only; the threat model is prompt-surface supply chain

This is the decision the whole security posture hangs on, so it is stated bluntly: **packs install prompt surfaces.** A persona overlay, a skill's `SKILL.md`, a memory seed, an identity seed — these become *instructions to the agent*. A malicious or tampered pack is not "malware" in the binary sense; it is a **standing instruction-injection channel** (e.g., a skill that quietly instructs the agent to exfiltrate recalled memory into outbound messages). This is more dangerous than classic package-manager compromise in one specific way: the payload reads as prose and executes on a model, not a CPU, so no scanner of the traditional kind will flag it.

Consequences baked into the design:

1. **Only the operator installs packs, via CLI, with the safety metadata in front of them** (§11). This matches the `kb.json` precedent: operator-authored/operator-approved configuration is the trust boundary; no model-facing tool writes it.
2. **No model-initiated pack operations in v1.** If they ever arrive, they ride the approvals framework as a new `ProposedActionKind` (`"pack_install"`) — the #24 Approval Center's taxonomy extension point already anticipates new kinds. Post-MVP, noted for #24 alignment, deliberately out of scope here.
3. **Prompt surfaces are enumerable and enumerated.** The manifest's safety block lists every prompt-bearing file (`promptSurfaces`), auto-derived at pack build time and re-derived at install by the same versioned rule (§4); `packs inspect` prints them; the install confirmation shows counts and paths. An operator can read every word a pack will feed their agent before committing.
4. **The structural safety rail already exists and is the deepest mitigation.** Persona overlays sit *below* the core identity in the prompt: the standing `IDENTITY.md`/`USER.md` context always comes first, and the overlay explicitly never overrides core identity, user boundaries, or safety rules (`docs/operations/PERSONAS.md` — enforced by prompt ordering). Pack content is *data interpreted by existing loaders*, never code the harness auto-executes. A hostile PERSONA.md therefore cannot grant itself authority above the operator's own identity/safety context; the pack machinery adds distribution trust *on top of* that rail, it does not replace it.
5. **Signing (D4) covers authenticity; safety review metadata (§11) covers content review; receipts + doctor cover post-install drift.** Three distinct failure modes, three distinct mechanisms — and the structural rail bounds the blast radius of all three.

### D7 — Entitlements verify at install/update time only; no runtime phone-home; enforcement is honest

Paid packs require an **entitlement token** supplied by REF (`tokenEnv`/`tokenFile` on the registry config — the exact connector-credential pattern). The client presents it to the entitled registry endpoint; grants are checked when acquiring or updating a pack. **Installed packs never check entitlements at runtime.** No offline grace-period machinery is needed because there is no online requirement after install.

- *Why:* MindStone's product posture is local-first (localhost-bound defaults, no implicit network I/O, air-gap-friendly). A runtime license check contradicts that posture, adds an availability dependency to every agent turn, and — per the planning draft's own IP-honesty analysis — doesn't actually protect anything a determined user couldn't extract from a local install anyway.
- *What paid enforcement actually is:* controlled acquisition (authed registry + entitlement-gated download URLs + authed image pulls), controlled updates (the update stream is the recurring value), license terms, and account controls. The draft's phrasing stands: compiled launchers and private registries "raise friction; they do not contain the full value." Public copy must never claim absolute IP protection (§16).
- *Alternative — runtime entitlement checks with offline grace:* rejected as posture-inconsistent and value-negative, per above. Revisitable only if a future *hosted* pack service (server-side logic) becomes part of a pack's value, in which case the service boundary enforces itself naturally.

### D8 — Updates preserve user modifications: hash-based ownership, keep-user-on-conflict, pristine payload retained

At install, the receipt records `sha256` per installed file. At update, for each file the new version wants to write:

- **File unmodified** (current hash == receipt hash) → replace with the new version.
- **File user-modified** (hash differs) → **keep the user's file**, write the incoming version alongside as `<name>.pack-new`, and list the conflict in the update summary. The receipt records both hashes so doctor can keep surfacing the pending conflict.
- **File deleted by user** → respect the deletion; note it in the summary; do not resurrect.

The pristine pack payload is retained at `<dataDir>/packs/installed/<id>/payload/` (pack artifacts are small text; KB seed archives may opt out via a `payloadRetention: "manifest-only"` manifest hint for large packs). Retention enables `packs verify` (integrity re-check), `remove --restore-check`, and a future three-way merge.

- *Alternative — three-way merge at update time:* deferred, not rejected. The pristine payload retained now is exactly the base a future merge needs; v1 ships the predictable behavior (keep-user + `.pack-new`) rather than a merge engine.
- *Hard rule inherited from the draft's non-goals:* updates NEVER touch user memory, transcripts, or user-created artifacts. Memory seeds apply on first install only (recorded in the receipt as `seededAt`); updates never re-seed.

## 4. Pack manifest specification

`pack.json` at archive root. Versioned by integer `schemaVersion` (migrate-on-read; unknown *higher* schema versions refuse to install with a "harness too old" error keyed off `engines` anyway).

```jsonc
{
  "schemaVersion": 1,
  "id": "mindstone/cti-analyst",            // <publisher>/<name>; both segments [a-z0-9-]{1,64}
  "class": "content",                        // "content" | "agent"
  "name": "Cyber Threat Intelligence Analyst",
  "description": "Persona pack: CTI analyst overlay with triage skills and OT threat KB seeds.",
  "version": "0.3.1",                        // SemVer 2.0.0
  "license": "proprietary",                  // SPDX id or "proprietary"
  "publisher": { "id": "mindstone", "name": "MindStone", "url": "https://…" },
  "tier": "free",                            // "free" | "paid" | "enterprise"
  "engines": { "mindstone": ">=0.4.0 <2.0.0" },
  "dependencies": {                          // pack id → SemVer range (flat; see D5)
    "mindstone/base-analyst-skills": "^1.0.0"
  },

  "artifacts": {                             // what installs where (content class + agent seed payload)
    "personas": ["cti-analyst"],             // → <dataDir>/personas/<id>/
    "skills": ["source-triage", "ioc-extraction"],   // → <dataDir>/skills/<id>/
    "workflows": ["daily-intel-pull"],       // → <dataDir>/workflows/<id>/
    "knowledgebases": ["ot-threat-references"],      // → <dataDir>/knowledgebases/<id>/
    "memorySeeds": "memory/",                // first-install-only import into memoryDir
    "identitySeed": "identity.md"            // agent class only: role identity seed
  },

  "runtime": {                               // agent class only; content packs MUST omit
    "requires": { "docker": ">=24.0.0" },
    "image": { "ref": "ghcr.io/mindstone/packs/cti@sha256:…", "cosignSigned": true },
    "compose": "deploy/docker-compose.yml",
    "webChat": true,
    "gateway": true,
    "synapse": "optional"
  },

  "security": {
    "defaultToolPolicy": "read-mostly",      // default posture the pack configures
    "networkPolicy": "local-only",
    "requiresEntitlement": false
  },

  "safety": {                                // §11 — the ticket's safety review metadata
    "reviewStatus": "reviewed",              // "reviewed" | "unreviewed" | "revoked"
    "reviewedBy": "mindstone-curation",
    "reviewedAt": "2026-07-01T00:00:00Z",
    "reviewId": "SR-2026-0142",
    "promptSurfacesRule": 1,                 // versioned derivation rule (see invariants below)
    "promptSurfaces": [                      // every prompt-bearing file; build-time derived
      "personas/cti-analyst/PERSONA.md",
      "personas/cti-analyst/safety.md",
      "skills/source-triage/SKILL.md",
      "skills/ioc-extraction/SKILL.md",
      "identity.md"
    ],
    "riskNotes": ["KB seeds reference external threat feeds; ingest is extractive-only."],
    "boundaries": ["never auto-block or auto-report without approval"]
  },

  "updates": { "channel": "stable" },        // "stable" | "beta"
  "files": "MANIFEST.sha256",                // per-file digest list (path → sha256), archive-relative
  "createdAt": "2026-07-01T00:00:00Z"
}
```

Validation invariants (enforced at install and by `packs verify`):

- `class: "content"` MUST NOT contain `runtime` or `identitySeed`; `class: "agent"` MUST contain `runtime.image` pinned **by digest** (tag-only refs are rejected).
- Every artifact id listed MUST exist as a well-formed artifact directory in the archive (personas need `PERSONA.md`, skills need `skill.json` + `SKILL.md`, KBs need `kb.json` + `sources/` — the existing loaders' own validity rules, applied pre-install).
- Every file in the archive MUST appear in `MANIFEST.sha256` and match; every path must be relative, `..`-free, symlink-free (extraction rejects otherwise — the zip-slip guard, same discipline as `sanitizeMemoryProposalPath`).
- **`promptSurfaces` derivation is a fixed, versioned rule** (`promptSurfacesRule`), implemented identically by the pack build tool and the installer so build-time and install-time derivations cannot drift into false integrity failures. Rule 1: the derived set is every archive-relative path matching `personas/*/PERSONA.md`, `personas/*/safety.md`, `skills/*/SKILL.md`, the declared `identitySeed` file, and every `*.md` under the declared `memorySeeds` path — as a byte-wise-sorted list of POSIX-style relative paths, compared by **exact list equality** (a path-set comparison; no content canonicalization is involved, so there is nothing to canonicalize wrongly). A manifest whose `promptSurfaces` differs from the derived set is an integrity FAILURE, not a warning — an undeclared prompt surface is exactly what an attacker would want. An installer that does not know the manifest's `promptSurfacesRule` version refuses to install (fail-closed, same posture as unknown `schemaVersion`). Prompt text embedded in JSON artifacts (workflow step prompts, `skill.json` fields) is covered by the per-file digests and by review of the artifact as a whole; `promptSurfaces` enumerates the *markdown prompt documents*.
- Packs MUST NOT contain: provider API keys, tokens, entitlement secrets, absolute host paths, or executable content outside `deploy/` (agent class). A denylist scan runs at build and at install.

## 5. Versioning

- **Pack versions:** SemVer 2.0.0. Breaking changes to a pack's own artifact contracts (e.g., a persona renames its referenced skills) bump major. Pre-release tags (`0.4.0-beta.1`) are only served on the `beta` channel.
- **Manifest schema:** integer `schemaVersion`, migrate-on-read within the supported window; the harness refuses schemas newer than it knows.
- **Harness compatibility:** `engines.mindstone` SemVer range, checked at install/update. After a harness upgrade, `doctor` re-checks installed packs' `engines` and warns on now-unsatisfied ranges (`packs.compat` check) — it does not disable anything (the artifacts are inert text; worst case is degraded behavior, and silent disabling would be scarier than a warning).
- **Channels:** `stable` (default) and `beta` per pack; the client's per-registry channel selection lives in config. No auto-updates ever — `packs update` is always explicit (network doctrine, D3).
- **Anti-rollback:** registry index `serial` is monotonic per registry and cached; `packs update` refuses to move an installed pack to a lower version unless `--allow-downgrade` (which is recorded in the receipt).

## 6. Registry protocol

### 6.1 Index (v1, static)

```
GET https://packs.mindstone.example/v1/index.json
GET https://packs.mindstone.example/v1/index.json.sig
```

```jsonc
{
  "schemaVersion": 1,
  "registryId": "mindstone-official",
  "generatedAt": "2026-07-01T00:00:00Z",
  "serial": 42,                              // monotonic; client caches last-seen
  "publisherKeys": ["ed25519:BASE64…"],      // informational; trust is the LOCAL store
  "packs": [
    {
      "id": "mindstone/cti-analyst",
      "class": "content",
      "tier": "free",
      "requiresEntitlement": false,
      "safety": { "reviewStatus": "reviewed" },   // index-level mirror for catalog display + revocation
      "latest": { "stable": "0.3.1", "beta": "0.4.0-beta.1" },
      "versions": [
        {
          "version": "0.3.1",
          "digest": "sha256:…",              // of the .mspack archive
          "size": 184320,
          "url": "https://…/cti-analyst-0.3.1.mspack",
          "sig": "https://…/cti-analyst-0.3.1.mspack.sig",
          "engines": { "mindstone": ">=0.4.0 <2.0.0" },
          "yanked": false
        }
      ]
    }
  ]
}
```

- The client verifies `index.json.sig` against the pinned publisher key(s), checks `serial` monotonicity, then treats the index as the catalog of record for that registry.
- `yanked` versions install only with an explicit version pin + warning (npm/cargo semantics); `safety.reviewStatus: "revoked"` at the index level refuses install outright (§11).
- Multiple registries are configured client-side (§9); ids are namespaced by publisher, and **a pack id is bound to the registry it was first installed from** — a different registry offering the same id is a hard error (dependency-confusion defense).

### 6.2 Entitled/private registries (Phase 4)

Same index shape, two additions:

- Requests carry `Authorization: Bearer <token>` where the token comes from the registry config's REF (`tokenEnv`/`tokenFile`) — never stored in config or receipts.
- `GET /v1/entitlements` returns the account's grants (`{ packId, expiresAt }[]`), cached locally with expiry (metadata only — no tokens on disk). Download URLs for entitled archives are short-lived signed URLs issued per request.
- Enterprise/air-gapped path: `file://` and local-directory registries accept the same index format, so an enterprise can mirror the index + archives internally and re-sign with their own key added to the local trust store.

Docker images for agent packs pull through normal OCI channels (public registry for free; authenticated registry using standard `docker login` credentials for paid). The manifest's digest pin is the integrity anchor; cosign verification of images is enforced when `runtime.image.cosignSigned` is true.

## 7. CLI specification

New noun `packs` following the `argv[2]`/`argv[3]` dispatch convention. All subcommands support `--json`. Registry contact happens ONLY where marked ⇅.

| Command | Behavior |
|---|---|
| `packs list [--remote ⇅] [--registry <id>]` | Default: installed packs (id, class, version, tier, reviewStatus, drift/conflict flags). `--remote`: registry catalog with status column |
| `packs search <term> ⇅` | Search remote catalog(s) by id/name/description |
| `packs inspect <id\|path> [--remote ⇅]` | Full manifest + safety block + prompt-surface list + file list; works on local archives, installed packs, or (with `--remote`) catalog entries |
| `packs install <path\|id[@version]> [--registry <id>] [--force] [--unsigned] [--accept-unreviewed] ⇅(id form only)` | §7.1 algorithm. Path form is fully offline |
| `packs update [id] [--check] [--allow-downgrade] ⇅` | All packs or one; `--check` reports available versions + revocations without applying |
| `packs remove <id> [--purge]` | §7.2. Never touches user data |
| `packs verify [id]` | Offline integrity re-check: receipts vs disk, payload vs MANIFEST.sha256; reports user-modified files distinctly from corruption |
| `packs status [--json]` | Counts by class/tier, pending `.pack-new` conflicts, unsigned installs, entitlement cache state |
| `packs start/stop/open/logs <id>` | Agent-pack lifecycle (Phase 3) — listed here for shape; **planned, not part of the content-pack MVP** |

Exit codes: `0` success, `1` operational failure (verification, dependency, collision), `2` usage error — matching existing CLI behavior.

**Transcript audit events.** `pack_installed` / `pack_updated` / `pack_removed` are appended via the same mechanism the persona and approvals subsystems already use — `appendTranscriptEntry` (`transcript/index.ts`) with `role: "event"` against the CLI's canonical session key, exactly as `persona activate` appends `persona_activated` and the approval discipline appends `approval_proposed`/`approval_decided`. Metadata shape: `{ event, packId, version, digest, trusted, decidedBy: "operator-cli" }`. This is new-but-patterned work: the event *mechanism* exists; the pack event kinds and their metadata schema are defined here.

### 7.1 Install algorithm — the local path (AC2)

`mindstone packs install ./cti-analyst-0.3.1.mspack` — no registry, no network, fully definable and testable offline:

```
1. Read archive; compute sha256.
2. Verify detached signature (<archive>.sig or --sig <path>) against the local trust
   store. Missing/failed → REFUSE, unless config packs.allowUnsigned=true AND
   --unsigned given (both required; loud warning; receipt marked trusted:false).
3. Extract to <dataDir>/packs/staging/<id>/ with the extraction guard:
   relative paths only, no "..", no symlinks/hardlinks, no absolute paths.
4. Validate pack.json: schemaVersion known; class invariants (§4); SemVer parses;
   engines.mindstone satisfied by the running harness version.
5. Verify every file against MANIFEST.sha256 (fail on any mismatch OR any file
   present-but-unlisted / listed-but-absent).
6. Re-derive prompt surfaces from the archive using the manifest's declared
   promptSurfacesRule (§4); compare to safety.promptSurfaces by exact sorted-list
   equality — mismatch = integrity FAILURE (undeclared prompt surface), refuse.
   Unknown rule version → refuse.
7. Dependency + reference check (D5): engines, declared pack deps installed at
   satisfying versions, persona artifact refs resolvable. Failure prints the
   unsatisfied list and exact remediation commands.
8. Collision check per artifact id:
   - owned by another pack (receipt exists elsewhere) → REFUSE (no --force override;
     packs may not silently claim each other's artifacts)
   - exists but user-authored (no receipt)          → REFUSE unless --force,
     in which case the user file is preserved to <file>.user-backup and noted
   - same pack, reinstall/upgrade                   → route to update semantics (§10)
9. Safety gate (§11): print the safety summary (below).
   - reviewed   → proceed
   - unreviewed → interactive confirm; non-interactive requires --accept-unreviewed
   - revoked    → REFUSE via registry, no override. For a LOCAL archive known to be
     revoked (cached index), the override is a dedicated unsafe path: config
     packs.allowUnsigned=true AND --accept-revoked AND interactively re-typing the
     pack id — three deliberate acts; generic --force does NOT apply. Receipt marked
     revokedOverride:true; doctor packs.trust FAILS (not warns) while it is installed.
10. COMMIT (only now touches live stores): copy artifacts into their stores;
    apply memory seeds iff first install (record seededAt); write
    installed/<id>/{pack.json, MANIFEST.sha256, receipt.json, payload/};
    update packs.lock.json; clear staging.
11. Append pack_installed transcript event; print summary (artifacts by store,
    seeds applied, warnings).
```

Steps 1–9 are pure staging — a failure at any point leaves the live stores untouched (the skills `drafts/ → install` promotion discipline, generalized). Step 10 is the single named approval boundary.

The step-9 safety summary is the consent artifact, rendered like:

```
Installing  mindstone/cti-analyst @ 0.3.1   (free · content · signature VERIFIED · reviewed)
Publisher   MindStone (key mindstone-2026a, trusted)
Review      reviewed by mindstone-curation, 2026-07-01 (SR-2026-0142)
Prompt surfaces (5)
  personas/cti-analyst/PERSONA.md      personas/cti-analyst/safety.md
  skills/source-triage/SKILL.md        skills/ioc-extraction/SKILL.md
  identity.md
Risk notes  KB seeds reference external threat feeds; ingest is extractive-only.
Boundaries  never auto-block or auto-report without approval
Installs into
  personas/cti-analyst   skills/source-triage   skills/ioc-extraction
  knowledgebases/ot-threat-references   workflows/daily-intel-pull
Dependencies
  mindstone/base-analyst-skills ^1.0.0 (installed: 1.2.0 ✓)
Proceed? [y/N]
```

`install <id[@version]>` (registry form) prepends: resolve id in configured registries (bound-registry rule, §6.1) → fetch index (verify sig + serial) → pick version (channel/pin) → download archive to `cache/downloads/` → verify digest against index → continue at step 2.

### 7.2 Remove

```
mindstone packs remove <id> [--purge]
```

- Default: remove pack-owned files whose hashes still match the receipt; **leave user-modified files in place** (listed in the summary as retained); remove empty artifact dirs; delete receipt + lock entry; keep `installed/<id>/payload/` as a tombstone until `--purge`.
- `--purge`: also remove modified files and the tombstone — destructive, requires interactive confirm or explicit `--yes`.
- Never removed by any flag: user memory, transcripts, journals, user-authored artifacts without pack receipts. Memory seeds are NOT unwound (they may have been built upon; the receipt records they came from the pack, which is audit enough).
- Removing a pack that others depend on → refuse with the dependent list (`--force` overrides, marking dependents' receipts `depsBroken: true`, surfaced by doctor).

## 8. On-disk layout and state

```
<dataDir>/packs/
  packs.lock.json                  # installed packs: id, version, digest, registryId,
                                   #   installedAt, trusted, channel
  trust/publishers.json            # pinned publisher keys (seeded from harness package;
                                   #   operator-extendable for enterprise keys)
  cache/
    downloads/<id>-<ver>.mspack    # verified archives (content-addressed, prunable)
    index/<registryId>.json        # last verified index + last-seen serial
  staging/<id>/                    # in-flight installs (crash-safe: stale staging is
                                   #   inert and cleaned on next command)
  installed/<id>/
    pack.json                      # manifest as installed
    MANIFEST.sha256
    receipt.json                   # per-file: store path, sha256-at-install,
                                   #   currentStatus (owned|user-modified|user-deleted|conflict),
                                   #   seededAt, trusted, revokedOverride, depsBroken
    payload/                       # pristine copy (unless manifest opts to manifest-only)
  entitlements/grants.json         # cached grant METADATA only — never tokens
```

State-file writes use the atomic temp-file + rename pattern (as `ApprovalStore.#write` does). Corrupt state files surface as doctor failures rather than being silently replaced — pack state is a security record, unlike the approvals store's replaceable queue.

## 9. Configuration, doctor, and status surfaces

**Config** (new `MindStoneConfig` section, conventions matching `skills`/`knowledgebases`):

```jsonc
"packs": {
  "dir": ".runtime/mindstone/packs",         // override, defaults under dataDir
  "registries": [
    { "id": "mindstone-official", "url": "https://packs.mindstone.example/v1",
      "channel": "stable" },
    { "id": "mindstone-pro", "url": "https://packs-pro.mindstone.example/v1",
      "tokenEnv": "MINDSTONE_PACKS_TOKEN", "channel": "stable" }   // REF pattern
  ],
  "allowUnsigned": false,                     // dev escape hatch, default OFF
  "confirmUnreviewed": true                   // require confirm/--accept-unreviewed
}
```

**Doctor checks** (severity vocabulary per `doctor/types.ts`):

| Check | Severity logic |
|---|---|
| `packs.catalog` | fail on unreadable receipts/lock; warn on stale staging dirs |
| `packs.integrity` | warn on user-modified pack files (legitimate but worth knowing); **fail** on files matching neither receipt hash nor a recorded user-modification (unexplained drift on a prompt surface is the one to catch); info on pending `.pack-new` conflicts |
| `packs.trust` | warn while any `trusted:false` (unsigned) pack is installed; **fail** while any `revokedOverride:true` pack is installed; warn on trust-store keys past expiry |
| `packs.compat` | warn on installed packs whose `engines` no longer match the harness after an upgrade |
| `packs.entitlement` | info/warn on expiring/expired cached grants (no network probe — cache only) |

Doctor never contacts a registry (status commands do not probe networks). Revocation and update discovery happen only on explicit ⇅ commands.

**Status:** `mindstone status` gains a one-line summary (`Packs: 3 installed (2 content, 1 agent; 1 update-conflict pending)`); `mindstone packs status` gives the full picture.

## 10. Update semantics (content packs and agent seed payloads)

Per D8: fetch/verify the new version exactly as an install (steps 1–7 of §7.1), then per-file against the receipt — replace unmodified, keep-user + `.pack-new` on modified, respect user deletions, apply no memory re-seeding. New artifacts in the new version install normally; artifacts dropped by the new version are removed only if unmodified (else retained + noted). The receipt and lock update atomically after the file pass completes.

Agent packs (Phase 3) decompose updates into: seed-payload update (above) + runtime update (pull new digest-pinned image, verify cosign, `compose up` recreate — volumes carrying transcripts/memory/KBs are never recreated). A failed runtime update rolls back to the previous image ref recorded in the lock; seed-payload changes follow the normal conflict rules.

## 11. Safety review metadata (design element 9)

The manifest `safety` block (§4) is the unit of review. Semantics:

- **`reviewStatus`:**
  - `reviewed` — a named reviewer (`reviewedBy`, `reviewedAt`, `reviewId`) has read the pack's prompt surfaces and tool/network posture against a review checklist. v1 reviewers are first-party (MindStone curation); the fields deliberately don't encode "first-party" so third-party review programs can reuse the schema.
  - `unreviewed` — installable, but the operator must actively accept (interactive confirm or `--accept-unreviewed`). The default catalog page and `packs list --remote` visibly de-emphasize unreviewed packs.
  - `revoked` — the emergency brake. Set at the index level (§6.1) so it propagates without a pack re-release; refuses new installs **with no override via the registry path**; surfaced against *installed* packs on any ⇅ command (`packs update --check` is the "am I affected" query). Doctor reports it from the cached index copy. The only way to install a known-revoked local archive is the three-act unsafe path in §7.1 step 9 — deliberately heavier than the generic `--force`, because revocation exists for emergencies and must not be casually defeatable.
- **`promptSurfaces`** is the review's scope declaration and an integrity constraint (§4, §7.1 step 6). Reviewers sign off on exactly those files; the installer guarantees no prompt-bearing file exists outside the declared list.
- **`riskNotes` / `boundaries`** carry through to the operator at install time verbatim — the same philosophy as skills' `safetyNotes`, elevated to the pack level.
- **What review does NOT claim:** review is a point-in-time human read of prompt content, not a guarantee of model behavior. Public copy must not call reviewed packs "safe"; it says "reviewed" and links the review checklist (§16).

## 12. Threat model

| Threat | Mitigation | Phase |
|---|---|---|
| Malicious pack content — instruction injection via persona/skill/identity/memory-seed prose (the signature threat for this product) | The structural rail first: overlays sit below core identity and cannot override it (D6.4); pack content is data, never auto-run code. Then: operator-only installs; safety review + `promptSurfaces` enumeration + install-time display; first-party-curated v1 catalog; unreviewed-confirm gate; transcript audit events | 1–2 |
| Tampered archive (MITM, mirror, disk) | ed25519 detached sig over archive digest; per-file MANIFEST.sha256; digest-pinned downloads | 1 |
| Registry compromise | Signed index verified against LOCAL pinned keys (registry can't mint trust); `serial` monotonicity; digest pinning end-to-end | 2 |
| Rollback / freeze attacks | Index serial cache; `--allow-downgrade` explicit + receipted; (full TUF = named future upgrade) | 2 |
| Dependency confusion / typosquatting | Publisher-namespaced ids (`mindstone/…`); pack-id-to-registry binding on first install; single first-party registry in v1 | 1–2 |
| Zip-slip / path traversal in archives | Extraction guard: relative, `..`-free, symlink-free, absolute-path-free; staging isolation until the commit step | 1 |
| Pack claims another pack's artifacts | Receipt-based ownership; cross-pack collision = unconditional refusal | 1 |
| Silent post-install tampering of installed prompt surfaces | Receipts record hashes; `packs verify` + `doctor packs.integrity` distinguish user edits from unexplained drift | 1 |
| Casual defeat of a revocation | Registry path: no override at all. Local path: three deliberate acts (config + dedicated flag + typed confirm), receipted, doctor FAILS while installed | 2 |
| Entitlement token theft | REF pattern (env/file, never in config/receipts/logs); short-lived signed download URLs; grants cache holds metadata only | 4 |
| Secrets embedded in packs | Build + install denylist scan; validation gate before publishing (draft §11 gates adopted) | 1 |
| Compromised agent-pack image | OCI digest pinning in manifest (tag-only refs rejected); cosign verification; non-privileged, localhost-bound compose defaults (draft §7 security defaults adopted) | 3 |
| Compromised harness distribution | Out of scope and stated honestly: the harness is the root of trust (D4) | — |

## 13. Free and paid packs

**Free tier** (`tier: "free"`, anonymous public registry): the proof-of-value entry points, per the planning draft — Research Agent, Software Engineer Lite, General Knowledge Work Agent, CTI Lite (read-only defaults). Free packs are reviewed (first-party) and signed exactly like paid ones; the trust chain does not vary by price.

**Paid/professional** (`tier: "paid"`, entitlement + private registry) and **enterprise** (`tier: "enterprise"`, additionally supporting private mirrors/air-gap per §6.2): CTI Pro, OT Threat Intelligence Pro, Penetration Tester Pro, industry analyst packs, premium Persona Packs. Paid value = curation, maintained role/persona quality, workflow depth, maintained KB seeds + refresh cadence, update stream, support, and hardening — not hidden prompts (D7's honesty stance).

The **first free proof pack** should be a `content`-class Persona Pack (not an agent pack): it exercises the entire manifest/signing/install/update/receipt machinery with zero Docker surface, matching the phase order below. Recommendation: **CTI Analyst (Lite)** — it showcases persona + skills + KB seeding together, it is the domain where curation value is most legible, and its Pro sibling gives the paid tier an obvious first offering.

## 14. Implementation phases and validation

Sharpened from the draft's A–G to put the local trust+lifecycle core first (each phase lists its smoke, following the repo's stub-first smoke discipline — no live network in smokes):

- **Phase 1 — Local content-pack lifecycle** (the AC2 path): manifest schema + validator; archive build tool (`packs build` dev command producing `.mspack` + MANIFEST.sha256); trust store + ed25519 verify; staged install/update/remove/verify with receipts; `packs` CLI noun; config section; doctor checks; transcript events. *Smoke `smoke:packs`:* fixture pack roundtrip (install → modify a file → update → conflict surfaced → remove retains user file), tampered-archive refusal, unsigned refusal + two-act escape hatch, zip-slip fixture refusal, collision refusal, promptSurfaces-mismatch refusal, `verify` drift detection.
- **Phase 2 — Registry client + free packs:** signed static index, serial cache, id-to-registry binding, `list --remote`/`search`/`inspect --remote`/registry installs, yank/revoke handling; publish the first free pack. *Smoke `smoke:packs-registry`:* local stub HTTP registry (the stub-Bot-API pattern), serial-rollback refusal, revoked-pack refusal, digest-mismatch refusal.
- **Phase 3 — Agent packs:** compose orchestration, image digest+cosign verification, `start/stop/open/logs`, volume-preserving updates, draft §11 validation gates as the release checklist. *Smoke:* compose lifecycle against a local dummy image.
- **Phase 4 — Entitlements + private registry:** bearer-auth index, grants endpoint + metadata cache, short-lived download URLs, paid pack packaging (compiled launcher where appropriate, per draft §8 with its honesty caveats).
- **Phase 5 — Marketplace/catalog site:** public catalog page fed by the same signed index; status vocabulary per §16; per-pack pages render manifest + safety metadata. (Third-party publishing, if ever, re-opens D4 toward sigstore/TUF — explicitly out of scope now.)

Phase 1 is the only prerequisite for AC2 and is independently shippable with zero infrastructure.

## 15. Acceptance-criteria walk

- **AC1 — "Registry design doc exists":** this document. Element-by-element traceability: the coverage map in §1.
- **AC2 — "Local pack install/update path is defined or scaffolded":** **defined** in full — archive format (§4), local trust verification and the 11-step staged install algorithm (§7.1), update semantics (§10), remove (§7.2), on-disk state (§8), and the Phase 1 smoke that proves it (§14). Phase 1 of §14 is the immediate scaffold-and-implement step now that the design is accepted.
- **AC3 — "Public claims distinguish design from implemented marketplace":** §16, plus this document's own status header.

## 16. Public claims (AC3)

Claim-status table as of baseline `4e6502cb`, using the project claim taxonomy (implemented / smoke-tested / live-validated / pending / post-MVP):

| Subject | Honest status |
|---|---|
| Local content-pack lifecycle: `mindstone packs` (install/update/remove/verify/status/inspect/build/keygen/trust-add), manifest schema + validator, ed25519 signing, staged install with the extraction guard, receipts, doctor checks, transcript events | **implemented + smoke-tested** (`smoke:packs`, 10 legs). No live-registry, no live-LLM claims. |
| Registry client, static signed index, free-pack distribution | **pending — design only** (Phase 2). No network path exists in code. |
| Agent Packs (Docker stack + image verification) | **pending — design only** (Phase 3); `class:"agent"` install is refused with a "Phase 3" error today |
| Entitlements / private registry / marketplace site | **pending — design only** (Phases 4–5) |
| Agent Packs / Persona Packs as products | **pending** — no published pack exists yet |
| Personas, skills, KBs, workflows (the stores packs install into) | implemented + smoke-tested per their own docs; no live-LLM claims |
| Approvals framework packs would extend for model-proposed ops | implemented + smoke-tested (#21/#22); the `pack_install` kind is **post-MVP** |

Rules for public copy (website, README, catalog):

- Say "designed," "planned," or "in design" for everything in this doc until each phase's smoke exists (then "implemented + smoke-tested"), and reserve "available" for packs that have passed the §14/draft-§11 validation gates. The catalog page reuses the connector-catalog status vocabulary (`available | planned | not_validated | not_implemented`) so the two product surfaces speak one honesty dialect.
- CLI examples in public copy remain marked illustrative until the commands exist (draft §4 rule, retained).
- Never claim absolute IP protection for paid packs (D7; draft §8 approved phrasing retained). Never call reviewed packs "safe" — say "reviewed" and link the checklist (§11).
- Cross-platform claims stay at "runs anywhere Docker runs" phrasing until per-OS validation gates pass (draft §4 rule, retained).

## 17. Non-goals (v1) and open questions

**Non-goals** (inherits the draft's §13 and adds registry-specific ones): no full marketplace web store at v1; no third-party publisher onboarding (and therefore no TUF/sigstore-keyless yet — D4); no model-initiated pack operations (D6); no dependency auto-install/solver (D5); no runtime entitlement checks (D7); no side-by-side pack versions (D5); no pack updates ever touching user memory/transcripts (D8); no privileged containers or non-localhost binds by default (draft §7).

**Open questions resolved by this design:** persona-pack compatibility declaration (D5 — engines + deps + install-time ref resolution); entitlement check timing (D7 — install/update only, no runtime, no grace machinery needed); pack-update vs user-modification merge (D8 — hash ownership, keep-user, `.pack-new`, pristine payload retained); Persona Packs' distribution channel (D1/D3 — same registry, `content` class, no lighter parallel system); first free proof pack (§13 recommendation: CTI Analyst Lite as a content pack).

**Still open (business, not architecture):** the account/licensing backend behind the entitlement API (§6.2 defines the client contract only); which Pro pack ships first; how much of the harness stays source-available in paid distributions; the support boundary for third-party Docker/OS issues. These do not block Phases 1–3.

---

*Design deliverable for #28. Design only — see §16 for what may be publicly claimed. Baseline: `4e6502cb`.*
