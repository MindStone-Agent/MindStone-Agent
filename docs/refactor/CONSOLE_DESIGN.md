# MindStone Console: web UI on a LibreChat fork

**Status:** Design draft, 2026-09-17. Bookmarked, not scheduled. No integration code has been written.
**Decides:** #38 (candidate UI), and gives #15 (MindStone Console) its shape. Touches #24 (approvals) and #25 (observability).
**Owner:** Product decision by Clint, 2026-09-17. Engineering design by Cairn.

## 1. Decision

MindStone-Agent gets a full browser UI for chat, configuration, and onboarding, so that beta testers do not depend on the TUI. The UI is a fork of LibreChat (`danny-avila/LibreChat`), branded as MindStone Console, maintained as a MindStone-Agent repository with LibreChat kept as an upstream remote. The TUI stays a supported surface and is the recovery path when the Console is down or misconfigured.

Why LibreChat and not Open WebUI: LibreChat is MIT with no branding or user-count clause (verified 2026-09-15, tag v0.8.8-rc3). Open WebUI carries a clause that forbids rebranding above fifty users in any thirty-day window unless licensed; a clean fork would have to start at v0.6.5 from April 2025. Details on #38.

Why fork and not sever: MIT puts no time pressure on a cutover. We keep upstream as a remote and rebase on tagged releases while our patch set stays bounded. We sever the day rebases cost more than they return.

## 2. Shape

Three parts, thin seam:

```
Browser
   |
   v
MindStone Console (LibreChat fork)          owns: login, users, chat UI, history display,
   client (React)  +  api (Node, MongoDB)         file upload, theme, MindStone panels
   |
   |  server to server only, gateway service token, user id and role forwarded
   v
MindStone Gateway                            owns: personas, memory, recall, routing,
   /v1/models, /v1/chat/completions                approvals, connectors, config
   /admin/* (new)
   |
   v
MindStone core, Pi adapter, transcripts, memory store
```

Rule that keeps the fork alive: logic goes in the gateway, the fork stays thin. The MindStone additions to LibreChat live in one directory with one route prefix and talk only to the gateway admin API. Every line added to LibreChat core is a line paid for on every rebase.

## 3. Users and auth

LibreChat's user system is used as is. Verified from current source:

- Email and password login with registration on by default (`ALLOW_EMAIL_LOGIN`, `ALLOW_REGISTRATION`). JWT sessions, 15 minute access and 7 day refresh by default (`SESSION_EXPIRY`, `REFRESH_TOKEN_EXPIRY`). Password reset and email verification optional.
- Two system roles, admin and user. The first registered account becomes admin (`isFirstRegisteredUser` in `api/server/services/AuthService.js`).
- Optional providers: Google, GitHub, Discord, Apple, Facebook, generic OpenID Connect (Entra ID through OpenID, with group to role sync), SAML, LDAP.

**Auth design:**

- The Console owns login. The gateway is never exposed to the browser.
- The Console's Node API holds the gateway service token (gateway auth mode `token`, unchanged) and makes every gateway call server to server.
- Each call forwards the logged-in user's id and role. The gateway uses the user id as sender and as the `userId` scope dimension where the scope design says it applies, and the role gates the admin API.
- Admin role: config, onboarding, approvals, all panels. User role: chat and own history.
- Beta: registration on, first tester is admin. Nexus path later: turn on OpenID against Entra; no code.

Rejected: the gateway validating LibreChat's JWT itself. It couples the harness to the fork's session format and buys nothing at this stage.

## 4. Seam contracts

### 4.1 Exists today (gateway)

- `GET /v1/models` and `POST /v1/chat/completions`, gated by `gateway.http.chatCompletions.enabled`, routed through the MindStone runner when `routing.mode` is set, `501` otherwise. Non-streaming only. `model` defaults to `mindstone/default`; `agentId` is read from request metadata; the OpenAI `user` field becomes the sender id. See `docs/gateway/OPENWEBUI.md` and `packages/mindstone-gateway/src/index.ts`.
- Gateway auth modes `none`, `token`, `password`.

### 4.2 Needed for chat (P1)

- **Streaming.** Server-sent events on `/v1/chat/completions` when `stream: true`. LibreChat custom endpoints are believed to stream unconditionally; this is the load-bearing assumption and the first thing the P0 spike confirms or refutes.
- **Personas as models.** `/v1/models` lists one model per persona or agent (`mindstone/<agentId>`), so LibreChat's model picker is the persona selector with no UI code. The chat completions handler resolves `agentId` from the model id.
- **Client system messages.** Decide at the gateway whether a client-supplied system message is ignored, appended after the persona, or rejected. A persona must not be silently overridden from the browser. Default proposal: ignored for `user` role, appended for `admin`, always logged.

LibreChat side, `librechat.yaml` `endpoints.custom` entry: `name`, `apiKey` (the gateway token), `baseURL` (`http://gateway:19789/v1`), `models.fetch: true`, `titleConvo` off until title generation is routed somewhere cheap, `modelDisplayLabel: MindStone`.

### 4.3 Needed for config and onboarding (P2, harness work)

A gateway admin API, server to server, admin role only:

- `GET /admin/config` returns the effective config with secrets masked.
- `PUT /admin/config` and `PATCH /admin/config/<section>` validate against the config schema, write, and trigger a safe reload. Rejected writes return field-level errors.
- `POST /admin/secrets/<name>` accepts a secret value without echoing it back. Secrets are stored where the gateway stores them today, never in MongoDB.
- `GET /admin/status` reports gateway, provider, connector, and memory store health, plus an `onboarded: boolean` the Console uses to show the onboarding flow.
- The TUI's config editing moves onto the same API (in-process call or loopback), so the two surfaces cannot drift.

Onboarding flow in the Console, shown to the admin while `onboarded` is false: provider and key, first persona, memory location, optional connectors, then a test message. Each step is a config API write, so abandoning the flow mid-way leaves a valid partial config.

### 4.4 Needed for visibility and approvals (P3)

- `GET /admin/personas`, `GET /admin/sessions`, `GET /admin/memory/recent` (memory writes with provenance), `GET /admin/recall?q=` (the recall endpoint W9 from the Microsoft tenant design).
- `GET /admin/approvals`, `POST /admin/approvals/<id>/decide` with the deciding user id recorded (apply moves into core per D5 of the tenant design, so CLI and Console share it).

## 5. LibreChat features to disable

LibreChat duplicates parts of the gateway. For one brain, these are off in the fork's default config:

- **Agents** (LibreChat's own agent builder): personas are MindStone's.
- **Memories**: memory is MindStone's.
- **Presets** and per-user model parameters: parameters belong to the persona and the routing config.
- **RAG API and file indexing**: knowledge bases are MindStone's. File upload stays, forwarded to the gateway as knowledge base ingest in a later phase.
- **Title generation** unless routed to a cheap model through the gateway.
- Every built-in provider endpoint. The only endpoint is the MindStone custom endpoint.

## 6. Two stores, one truth

LibreChat keeps conversations in MongoDB. MindStone keeps transcripts. **MindStone transcripts are the source of truth. LibreChat's copy is display only.** Consequences: a conversation deleted in the Console does not delete the transcript (it is unlinked, not destroyed); memory, recall, and audit read transcripts, never MongoDB; a transcript export is the export.

## 7. Branding

Phase 1 uses LibreChat's own knobs and assets: `APP_TITLE`, `CUSTOM_FOOTER`, `HELP_AND_FAQ_URL`, logo and favicon assets, theme colours. Deeper rebrand (component names, package names, docs links) is patch work and is done once, in one commit, so it rebases as a unit.

## 8. Phases

| Phase | Deliverable | Where the work is | Gate to next |
|---|---|---|---|
| P0 | Spike from #38: LibreChat container against the gateway, streaming requirement confirmed, personas as models sketched. Findings on the ticket. | Gateway config, a compose file, a report | Findings posted |
| P1 | Branded Console with users: fork created, branding, SSE streaming, persona picker, overlapping features off | Fork repo, gateway streaming | A tester can chat with a persona through the browser |
| P2 | Config API and onboarding: admin API, schema validation, safe reload, secret handling, onboarding flow, TUI on the same API | Gateway (largest piece), Console panels | Fresh install configured entirely from the browser |
| P3 | Visibility and approvals: status, personas, sessions, memory writes, recall, approval decisions | Gateway admin API, Console panels | Approval answered from the browser |
| Beta | Open the beta | | P2 done plus the approvals part of P3 |

The beta gate includes approvals because a tester who cannot answer an approval prompt is stuck.

## 9. Risks and thoughts

- **MongoDB is the price.** It buys auth, users, and history. For a local single-user install it is real friction. Acceptable for beta with the compose file; revisit if the install story outranks the feature set.
- **Upstream cadence.** Three release candidates in the month before this draft. Pin tags, rebase on releases only, never on `main`.
- **Rebase burden grows with panels.** Keep the MindStone additions in one directory and one route prefix. Measure the patch set at each rebase; if it crosses into LibreChat core, that is the sever signal.
- **Double memory and double agents** if section 5 is skipped. Testers will not know which one answered.
- **Secrets in the browser.** The config API masks on read and never echoes on write. The Console never stores gateway secrets in MongoDB. Review this at P2 with an independent pass.
- **The fork changes what "MindStone" means.** Most users will meet the Console first and the harness becomes the engine behind it. README and mindstoneagent.ai should lead with the Console once P1 exists.
- **Multi-human threads are out of scope.** LibreChat conversations have one owner. Synapse remains the many-humans-and-agents surface (see #39).

## 10. Open questions

1. Repo name and org placement for the fork (proposal: `MindStone-Agent/mindstone-console`).
2. Whether the Console ships in the harness compose file by default or as an optional profile.
3. Title generation: off, or routed through the gateway to a small model.
4. File upload path: LibreChat's own storage for beta, knowledge base ingest later, or ingest from day one.
5. Whether `user` role may set a client system message at all (section 4.2 proposes no).

## 11. References

- #38 candidate evaluation and license cutover facts; #15 Console surfaces; #24 approvals; #25 observability; #39 LibreChat as a Synapse candidate (rejected for that role).
- `docs/gateway/OPENWEBUI.md` current OpenAI-compatible surface.
- `docs/operations/MICROSOFT_TENANT_INTEGRATION_DESIGN.md` D4 scope, D5 approval gate, W9 recall endpoint.
- LibreChat: `LICENSE` (MIT), `.env.example` (auth and branding knobs), `librechat.example.yaml` (`endpoints.custom`), `packages/data-schemas/src/schema/user.ts` (roles), `api/server/services/AuthService.js` (first user admin). All read 2026-09-15 to 2026-09-17.
