# Microsoft Teams connector — design and MVP path (#20)

Status: **DESIGN APPROVED-PENDING-REVIEW / NOT IMPLEMENTED.** This document settles the
design decisions on issue #20 and scopes an MVP path. No Teams connector code exists yet;
the channel catalog lists `teams` as `planned`. Claim level per the taxonomy: this whole
feature is **pending** (design only).

Companion docs: `CONNECTORS.md` (the #16 framework this design targets),
`LIVE_UAT_RUNBOOK.md` (where the live leg will go when implementation ships).

---

## 0. Why Teams is different from Telegram/Slack/Discord

Every connector shipped so far is **outbound-initiated**: Telegram long-polls the Bot API,
Slack opens a Socket Mode WebSocket, Discord opens a Gateway WebSocket. None of them needs
an inbound network path — the Gateway can sit behind NAT on a home LAN and everything works.

Teams does not offer an equivalent. There is **no long-poll and no socket mode** for Teams
bots. Inbound messages are delivered by the Azure Bot Service connector as **HTTPS POSTs to
a public messaging endpoint you host** (`POST /api/messages` by convention). This is the
single biggest deploy-shape change the Teams connector introduces, and most of the design
below is about containing it.

A second difference: the platform landscape moved under us in 2025. The **Bot Framework SDK
is archived/deprecated**; its successor is the **Microsoft 365 Agents SDK**, and TeamsFx /
Teams Toolkit became the **Microsoft 365 Agents Toolkit**. The wire protocol (the Activity
protocol, `serviceUrl` replies, Entra-issued JWTs) is unchanged — the deprecation is at the
SDK layer, not the protocol layer. See §1 for what we take a dependency on (spoiler: the
protocol, not the SDK).

---

## 1. Decision: Graph API vs Bot Framework route → **Activity-protocol route**

**Chosen: the bot route (Azure Bot Service + Activity protocol), implemented as raw
protocol handling in the connector — no Bot Framework / Agents SDK dependency.**

### Why not Microsoft Graph

The Graph route (read chat/channel messages via Graph, send via Graph) fails the MVP on
four independent grounds:

1. **Reading messages at scale is a protected/licensed API.** `getAllMessages`-style access
   is gated behind Microsoft approval and the model A/model B payment framework; calls
   against unlicensed users fail with `402 Payment Required`. That is an enterprise
   compliance surface, not a personal-agent surface.
2. **Change notifications require a public webhook anyway** — plus tenant-admin consent for
   the subscription scopes. We would inherit the public-endpoint requirement *and* an
   admin-consent story, and still not get a send path.
3. **Sending as an app via Graph is not a conversational surface.** `POST chatMessage` with
   application permissions is restricted to migration scenarios; interactive sends need
   delegated (user) tokens, which is the wrong identity model for an agent.
4. **Polling Graph for messages** as a webhook-avoidance hack is rate-limited, licensed as
   above, and explicitly not designed for bot-style latency.

The bot route is the path Microsoft designs, documents, and tests for conversational
agents: the bot is an app-registered identity, users @mention it, activities arrive at the
messaging endpoint, replies post back to the `serviceUrl`. RSC/Graph scopes are **not
required** for the basic conversational loop.

### Why raw Activity protocol instead of the Agents SDK

The #16 framework wants connectors to be **pure transport** (`connectors/<id>.ts` maps
platform events ⇄ `ConnectorInbound`/outbound sends; credentials/access/session/queue/
visibility come from the framework). The Agents SDK is a full app-hosting framework —
adapter, middleware pipeline, state management — that duplicates what the framework and the
Gateway already own. Taking it would invert the architecture.

What the connector actually needs from the protocol is small and stable:

- **Inbound:** accept `POST /api/messages`, validate the JWT (§5), map the `message`
  activity to `ConnectorInbound` (sender AAD object id, tenant id, conversation id,
  text with `<at>` mentions stripped, chat type from `conversation.conversationType`).
- **Outbound:** obtain a client-credentials token from Entra
  (`https://api.botframework.com/.default` scope for public cloud, tenant endpoint for
  single-tenant bots), `POST {serviceUrl}/v3/conversations/{conversationId}/activities`
  with the reply activity.

Both legs are plain HTTPS + JSON + one JWKS validation — the same order of complexity as
the Slack Socket Mode envelope handling we already ship. The deprecation churn (Bot
Framework SDK → Agents SDK) is exactly the churn we avoid by sitting on the wire protocol.

**Consequence for the Gateway:** the connector contributes an HTTP route to the Gateway's
existing HTTP server rather than opening an outbound socket. The framework contract
(`startInbound`) already permits this; the connector registers the route on start and
rejects traffic until identify/config validation completes (fail closed, §5).

---

## 2. Decision: tenant/app registration guidance → **single-tenant by default**

The auth/tenant story, start to finish:

1. **Microsoft Entra app registration** (the bot's identity). Recommended: **single-tenant**
   (`SingleTenant` app type). MindStone is a self-hosted personal/team agent; a
   single-tenant registration means tokens are issued and validated against *your* tenant's
   authority only, and the bot is not installable anywhere else. Multi-tenant is the
   enterprise/ISV shape and is explicitly out of MVP scope.
2. **Client credential**: client secret (MVP) or certificate (post-MVP hardening note).
   Stored **only as refs** per the #16 credential rules — `channels.teams.appIdEnv` /
   `appPasswordEnv` (or `*File` variants), `tenantIdEnv` optional-but-recommended for
   single-tenant. Raw values never appear in config, logs, transcripts, queue files, or
   status output.
3. **Azure Bot resource** (Azure Bot Service registration) pointing its messaging endpoint
   at the Gateway's public HTTPS URL for `POST /api/messages`, with the **Teams channel**
   enabled on the resource.
4. **Teams app package** (manifest + icons, generated once) uploaded to the tenant — via
   admin center or sideloading where permitted. The manifest binds the bot id to personal /
   team / group-chat scopes.
5. **Public HTTPS endpoint** for the messaging endpoint. Options, in MindStone deploy
   vocabulary: a reverse proxy (Caddy) on a public box in front of the Gateway; a dev
   tunnel for development; or hosting the Gateway itself on a public host. This is the
   deploy-shape cost of Teams and it is documented, not hidden: **no public endpoint, no
   live Teams** — but see §7 for why validation does not depend on it.

Setup wizard: the connector ships a `setup` flow like Telegram/Slack/Discord that asks for
the three refs + tenant id and prints the manifest/endpoint checklist. It must *never*
attempt Azure resource creation — guidance text only, fail-closed if refs are absent.

---

## 3. Decision: channel/chat mention handling → **platform-enforced, framework-aligned**

Teams enforces the posture we chose for Slack **at the platform level**: in channels and
group chats, a bot receives a `message` activity **only when @mentioned**. In personal
(1:1) chat, the bot receives all messages. There is no configuration in which the connector
sees un-mentioned channel traffic (that would be the Graph/RSC route we rejected).

Mapping onto the framework's trigger gating (`shouldTriggerConnectorReply`):

- `conversation.conversationType == "personal"` → DM semantics: always eligible.
- `"channel"` / `"groupChat"` → group semantics: mention required — trivially satisfied
  because Teams only delivers mentioned messages; the connector still runs the gate for
  defense-in-depth and for prefix-trigger parity.
- Inbound text arrives with `<at>BotName</at>` mention markup + a `mentions` entity array;
  the mapper strips the bot mention from the text (exact analogue of the Slack
  `app_mention` text cleanup) before handing to the framework.
- Replies in channels/group chats go to the same conversation (threaded under the root
  post in channel scope — Teams threads by conversation id natively; no explicit
  `message_reference`/`thread_ts` equivalent needed for MVP).

---

## 4. Decision: outbound send → **serviceUrl replies + queue; proactive is post-MVP**

- **Reply path (MVP):** every inbound activity carries `serviceUrl` + `conversation.id`.
  Reply = client-credentials token + `POST {serviceUrl}/v3/conversations/{id}/activities`.
  Outbound rides the #16 **delivery queue** (retry + dead-letter) exactly like
  Telegram/Slack/Discord — the queue payload stores the conversation reference, never
  tokens.
- **Conversation-reference cache:** the connector persists the latest conversation
  reference per session key (tenant id, conversation id, serviceUrl) so queued/delayed
  outbound after a Gateway restart can still deliver. This is framework session-map data,
  not new machinery.
- **Proactive messages (post-MVP, documented boundary):** messaging a user who has not
  written first requires an existing conversation reference (user must have installed the
  app / talked to the bot before) or admin-driven installation flows. The MVP claims
  **reply-only + resumable replies**; proactive-first-contact is explicitly out.
- **Formatting:** MVP sends plain text/basic markdown. Adaptive Cards are a documented
  post-MVP extension point (they change nothing structural — same activities endpoint).

---

## 5. Decision: approval/security posture → **fail closed on four axes**

1. **Inbound JWT validation (mandatory, not optional).** Every `POST /api/messages` must
   carry a Bot-Connector-issued JWT: validate signature against the Bot Framework JWKS,
   `aud` == our app id, issuer per single-tenant authority, standard clock checks. Requests
   that fail validation are 401'd and **counted in runtime-status** (visible probe signal,
   §6). This is the Teams analogue of "Slack signs requests" — except here it is the only
   thing standing between the public internet and the Gateway, so the smoke suite must
   cover reject paths explicitly.
2. **Tenant allowlist (fail closed).** Inbound activities carry
   `channelData.tenant.id`; the connector requires it to equal the configured tenant id
   (single-tenant makes this near-tautological, but the check is cheap defense against
   registration misconfiguration — and required if anyone flips to multi-tenant).
   Empty/missing tenant config = **nobody**, consistent with framework access rules.
3. **Sender allowlist (fail closed).** `allowedSenders` matched against AAD object id
   (stable) with UPN as a convenience alias — empty list = nobody, same as every other
   connector. Denials get the standard polite-denial + audit-log treatment via
   `evaluateConnectorAccess`.
4. **Credentials as refs + leak checks.** Per §2; the smoke suite includes the standard
   token-leak grep across config/status/queue/transcript surfaces.

No Graph scopes, no admin consent, no RSC permissions are requested at all in the MVP —
the approval surface is exactly: one Entra app in your own tenant + one Teams app upload.

---

## 6. Decision: status/doctor visibility → **catalog now, runtime-status at implementation**

- **Now (shipped with this design):** `teams` catalog entry, kind `external_channel`,
  status **`planned`** — the honest pre-implementation status (Signal stays the
  `not_implemented` exemplar; `planned` reflects "design approved, implementation
  sequenced"). Catalog remains diagnostic-only: no listeners, no probes, no secrets.
- **At implementation:** the standard framework integration —
  `getConnectorVisibilityStatuses` reports configured/credential-resolvable/running;
  Teams adds two connector-specific signals: (a) messaging-endpoint reachability is
  **reported as guidance, never probed from inside** (the Gateway cannot see its own
  public reachability; doctor prints the expected public URL and a curl one-liner for the
  operator), (b) JWT-rejection counters (§5.1) surface silent misconfiguration — a wrong
  app id shows up as a rising 401 count, not silence.

---

## 7. MVP path — scoped to what we can actually validate

**Claim ceiling without a real tenant: `smoke-tested`.** The Activity protocol is fully
exercisable locally; Entra/Azure Bot registration and Teams-client behavior are not. The
MVP path is staged so each stage's claim is honest:

| Stage | What | Validates | Claim |
|---|---|---|---|
| D0 (this doc) | Design + catalog entry | decisions ↔ ticket | pending |
| I1 | `connectors/teams.ts` on the #16 framework: `/api/messages` route, JWT validation, activity⇄inbound mapping, serviceUrl outbound, conversation-reference cache | build + unit (mapping fns exported, per pattern) | implemented |
| I2 | `scripts/stub-teams-server.mjs`: a mini Bot-Connector — issues real JWTs from a test JWKS, POSTs activities to the connector endpoint, receives serviceUrl replies. Exact live path with the authority/JWKS/serviceUrl URLs swapped | reply loop, fail-closed denial (sender + tenant + bad-JWT), trigger gating, retry→delivery, source metadata, bad-token visibility, token-leak check | smoke-tested |
| I3 | **Microsoft 365 Agents Playground** leg (`agentsplayground -e http://localhost:<port>/api/messages`) — Microsoft's own protocol client against our endpoint, still **no tenant, no tunnel, no registration** | protocol conformance against Microsoft-authored client | smoke-tested (stronger) |
| L1 | Live leg in `LIVE_UAT_RUNBOOK.md`: real Entra app + Azure Bot + tenant upload + public endpoint (Clint runs it) | the whole §2 story end-to-end | live-validated |

The stub-first pattern (I2) is the proven Telegram/Slack/Discord recipe; the Playground
(I3) is a Teams-specific bonus none of the other platforms offered — Microsoft ships a
local client that speaks the exact wire protocol, which meaningfully raises confidence
before anyone touches Azure.

**Sequencing call (the "if feasible, implement" answer):** implementation is feasible on
the framework at roughly Slack-shaped effort (I1+I2 ≈ one session; the new work is JWT
validation + hosting an inbound route). It is **deliberately deferred**: (a) the wishlist
order puts #21 email / #22 calendar ahead; (b) the public-endpoint deploy shape makes the
live leg heavier than any prior connector, so banking design review (Slate) before code is
cheap insurance; (c) nothing downstream blocks on Teams. When picked up, I1–I3 land as one
PR-shaped unit with the standard receipt.

## 8. Claim boundaries (acceptance criterion 3)

Explicitly: **no enterprise-support claims are made.** Not claimed: multi-tenant
operation, admin-center distribution, Graph/RSC data access, proactive first-contact
messaging, Adaptive Cards, message editing/reactions, compliance/export integration, or
any behavior of the real Teams service beyond what the Activity protocol documents —
until a real single-tenant deployment passes the L1 runbook leg, and then the claim is
exactly "live-validated single-tenant reply-bot," nothing broader.

## References

- [Bot Framework SDK → Microsoft 365 Agents SDK migration guidance](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/bf-migration-guidance) (deprecation + successor)
- [Debug/test locally with the Agents Playground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project) (no tenant / no tunnel / no registration)
- [Teams API payment models and licensing (model A/B)](https://learn.microsoft.com/en-us/graph/teams-licenses) (why not Graph, licensing leg)
- [Teams message change notifications](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage) (why not Graph, webhook+consent leg)
- [Send chatMessage — application-permission restrictions](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0) (why not Graph, send leg)
