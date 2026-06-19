# Agent Packs: Dockerized Role Agents and Commercial Pack Delivery

**Project:** MindStone Agent Harness  
**Status:** Planning draft  
**Date:** 2026-06-19  
**Related docs:** `IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `PRD.md`

## 1. Summary

MindStone Agent Packs are planned ready-to-run Dockerized deployments of prebuilt MindStone agents for specific jobs.

Examples:

- Cyber Threat Intelligence Agent Pack
- OT Threat Intelligence Agent Pack
- Software Engineer Agent Pack
- Cyber Penetration Tester Agent Pack
- Research Agent Pack
- Marketing Agent Pack

The product goal is simple:

```text
install → open web chat → start working with a role-specific MindStone agent
```

The pack should hide substrate complexity from the user. A pack should include the harness runtime, role identity, safe defaults, memory scaffold, Gateway, WebChat, persistence, and guided setup so the user does not have to understand Pi, context management, transcripts, Docker networking, Gateway auth, or MindStone internals before seeing value.

## 2. Product naming

Preferred public name:

```text
MindStone Agent Packs
```

Short name:

```text
Agent Packs
```

Avoid using “modules” as the primary public term. “Modules” sounds like plugins/components. “Starter packs” is friendly but may sound toy-like. “Agent Packs” is clearer and productizable.

## 3. Product model

Agent Packs should be a catalog layered on top of the MindStone Agent Harness.

```text
MindStone Agent Harness — platform/runtime
MindStone Agent Packs — ready-to-run role deployments
MindStone for Claude Code / MindStone for Pi — continuity layers
Synapse — agent communication/review plane
Cortex — future component
```

Planned commercial model:

- Basic starter packs can be free entry points.
- Specialized, maintained, or professional packs may be paid.
- Paid value should come from role design, curation, specialized workflows, packaged tools, updates, support, and operational polish — not only from hidden prompts.

## 4. Target user experience

The ideal pack install flow:

1. User chooses a pack from a catalog.
2. Installer checks for Docker or Docker Desktop.
3. Installer obtains/validates pack entitlement if required.
4. Installer pulls signed images from the appropriate registry.
5. Installer creates a local runtime directory and persistent volumes.
6. Installer starts the stack.
7. Installer opens WebChat or prints a local URL.
8. User completes minimal guided provider/auth setup.
9. User starts working with the role-specific agent.

Illustrative future CLI shape:

```bash
mindstone packs list
mindstone packs install cti
mindstone packs start cti
mindstone packs open cti
mindstone packs status cti
mindstone packs update cti
mindstone packs export cti
mindstone packs stop cti
```

Installer examples in public copy must remain illustrative until implemented and validated.

Avoid claiming “works on any OS” until verified. Prefer:

```text
Runs anywhere Docker runs, including macOS, Linux, and Windows with Docker Desktop or a compatible Docker runtime.
```

## 5. Pack contents

Each Agent Pack should include:

- pack manifest
- role identity seed
- user-facing role description
- default memory scaffold
- default tools/policies
- Gateway configuration
- WebChat enabled by default
- transcript and memory persistence volumes
- update channel metadata
- doctor checks
- backup/export path
- optional Synapse configuration
- pack-specific onboarding prompts
- pack-specific safety boundaries

A pack should not include:

- embedded provider API keys
- embedded license secrets
- private user data
- unverifiable claims about live model/provider behavior
- unsafe tool permissions by default

## 6. Proposed pack manifest

Draft manifest shape:

```json
{
  "id": "cti",
  "name": "Cyber Threat Intelligence Agent Pack",
  "version": "0.1.0",
  "tier": "free|paid|enterprise",
  "image": "registry.example.com/mindstone/packs/cti:0.1.0",
  "runtime": {
    "requiresDocker": true,
    "webChat": true,
    "gateway": true,
    "synapse": "optional"
  },
  "agent": {
    "profile": "cyber-threat-intelligence",
    "identitySeed": "pack://cti/identity.md",
    "memorySeed": "pack://cti/memory/"
  },
  "security": {
    "defaultToolPolicy": "read-mostly",
    "networkPolicy": "pack-default",
    "requiresEntitlement": false
  },
  "updates": {
    "channel": "stable",
    "signed": true
  }
}
```

The real manifest format should be versioned and migration-aware.

## 7. Docker architecture

A pack deployment should be a small stack, not a one-off opaque container.

Candidate stack:

```text
mindstone-pack-<id>/
  docker-compose.yml
  .env
  volumes/
    runtime/
    transcripts/
    memory/
    gateway-state/
```

Services:

```text
mindstone-harness     # compiled/runtime harness or pack launcher
mindstone-gateway     # Gateway API and WebChat
optional-sidecars     # pack-specific services, fetchers, indexers, etc.
```

The default should be local-only unless explicitly configured otherwise.

Security defaults:

- bind WebChat/Gateway to localhost by default
- avoid privileged containers
- avoid mounting arbitrary host paths by default
- provide explicit configuration for tool access
- keep secrets in local runtime secret storage or Docker secrets where supported
- include doctor warnings for unsafe ports, missing auth, or broad mounts

## 8. Auth, entitlement, and IP protection

Claude Code appears to ship locally as a Bun-compiled native executable, but its strongest protection comes from service boundaries: authentication, server-side model access, account controls, billing, and policy. The local binary raises friction; it does not contain the full value of Claude.

MindStone paid Agent Packs should follow the same general principle.

Recommended layered model:

1. **Compiled launcher/runtime where appropriate**
   - Bun compile can package installer/launcher/orchestration code into native binaries.
   - This reduces casual source exposure and simplifies distribution.
   - It is not strong IP protection by itself.

2. **Authenticated entitlement checks**
   - Paid packs should require account/license validation.
   - Entitlements should control image pulls, updates, and optional online services.
   - The system should support offline grace periods only if the business model allows them.

3. **Private container registry**
   - Paid packs should be pulled from an authenticated registry.
   - Basic/free packs can use public images if desired.

4. **Signed images and checksums**
   - Images should be signed.
   - Installer should verify provenance where practical.

5. **No embedded secrets**
   - Do not bake API keys, registry credentials, or license secrets into images or binaries.

6. **Server-side sensitive logic where needed**
   - If a paid pack contains truly proprietary high-value logic, consider keeping the most sensitive logic behind a service boundary.
   - Fully offline, fully self-contained packs can always be inspected by a determined user.

7. **License terms and account controls**
   - Auth control should apply to the MindStone harness/pack system where commercial distribution warrants it.
   - Public copy should say “protect proprietary pack logic where appropriate,” not “Bun compile protects IP.”

Public-safe phrasing:

```text
Commercial packs may use private registries, signed Docker images, authenticated entitlements, and compiled launchers to simplify delivery and protect proprietary pack logic where appropriate.
```

Avoid:

```text
Compiled with Bun to protect paid IP.
```

That overstates what compilation can do and invites reverse-engineering arguments.

## 9. Free vs paid pack boundaries

Free packs should demonstrate the product without creating support or security traps.

Possible free packs:

- Research Agent
- Software Engineer Lite
- General Knowledge Work Agent
- CTI Lite with safe/read-only defaults

Possible paid/professional packs:

- Cyber Threat Intelligence Pro
- OT Threat Intelligence Pro
- Penetration Tester Pro
- Marketing/Content Ops Pro
- Industry-specific analysts
- Packs with maintained connectors, premium workflows, or advanced memory/knowledge assets

Paid pack value should include:

- maintained role prompts/identity
- workflow quality
- curated tools/connectors
- update cadence
- support
- compliance/security hardening
- premium knowledge scaffolds where licensed
- optional hosted services

## 10. Implementation phases

### Phase A — Pack schema and catalog

- Define pack manifest schema.
- Add pack catalog loader.
- Add `mindstone packs list` and `mindstone packs inspect`.
- Add catalog tests.

### Phase B — Local free pack prototype

- Build one free local pack, likely Research Agent or Software Engineer Lite.
- Use Docker Compose.
- Enable Gateway and WebChat.
- Persist transcripts/memory to mounted volumes.
- Add `mindstone packs install/start/open/status/stop` for local pack.
- Add doctor checks.

### Phase C — Role identity and memory seeding

- Define role identity seed format.
- Define memory scaffold import flow.
- Ensure seeded content is tracked as pack source metadata.
- Ensure user/runtime memory remains separate from pack updates.

### Phase D — Auth and entitlement design

- Define account/license model.
- Define local token storage.
- Define registry auth flow.
- Define entitlement API boundary if a hosted service is used.
- Define offline/grace-period policy.

### Phase E — Paid pack packaging

- Compile launcher/orchestration code where appropriate.
- Publish images to private registry.
- Sign images.
- Add entitlement checks to install/update.
- Validate no secrets are embedded.

### Phase F — Pack updates, backup, and export

- Add `mindstone packs update`.
- Add safe config migrations.
- Add backup/export/import flow.
- Preserve user transcripts and memories across pack updates.

### Phase G — Catalog and website integration

- Publish public pack catalog page.
- Clearly mark free, paid, coming soon, and validated status.
- Avoid claiming pack availability until images/install flows are tested.

## 11. Validation gates

Before claiming an Agent Pack is available:

- Fresh install validated on macOS with Docker Desktop.
- Fresh install validated on Linux with Docker Engine.
- Windows/Docker Desktop path either validated or explicitly documented as pending.
- WebChat opens and can send a turn.
- Gateway health/status passes.
- Transcript persistence verified across restart.
- Memory persistence verified across restart.
- Pack identity loads correctly.
- No secrets in image layers.
- Docker ports/binds are documented.
- Update path tested.
- Uninstall/cleanup documented.
- Auth/entitlement checks tested for paid packs.

## 12. Open questions

- What is the exact account/licensing backend for paid packs?
- Will paid packs require online entitlement checks every run, only install/update, or both?
- Which pack should be the first free proof pack?
- Which pack should be the first paid/pro pack?
- Should pack-specific proprietary logic run locally, server-side, or hybrid?
- How much of the base harness remains source-available versus compiled in paid distributions?
- How will pack updates merge with user-modified identity/memory scaffolds?
- What is the support boundary for third-party Docker/OS issues?

## 13. Non-goals for the first pass

- Do not implement a full marketplace immediately.
- Do not claim any paid-pack IP protection is absolute.
- Do not ship privileged containers by default.
- Do not make users edit Docker Compose manually as the primary setup path.
- Do not embed provider credentials or license secrets in images.
- Do not make pack updates overwrite user memory/transcripts.
