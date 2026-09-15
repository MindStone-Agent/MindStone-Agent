# Running a MindStone-Agent Digital Employee inside a Microsoft 365 tenant: integration design

Status: **DESIGN / NOT IMPLEMENTED.** This document maps the harness onto Microsoft's agent
infrastructure as documented in August and September 2026, records the decisions, and lists the
work items with their claim ceilings. Nothing here changes an existing claim in the README.
Companion docs: `TEAMS_CONNECTOR_DESIGN.md` (#20, the transport this design builds on),
`CONNECTORS.md` (#16, the framework), `EMAIL_CONNECTOR.md` (Graph is the documented second
pass), `APP_ENGINE.md` (scope model and Agent Mesh), `../refactor/MEMORY_STRATEGY.md`.

---

## 0. The target

One MindStone-Agent gateway, running as a container inside an enterprise Microsoft 365 tenant,
is one Digital Employee: an Entra-governed identity, addressable in Teams, reading and sending
mail, with the LCA layers intact (append-only record, structured memory and index, auto recall,
live context, consolidation with a human on the approved tier) and every action attributable to
the identity that performed it. A second and third employee run either as more containers or as
logically isolated agents in one gateway (Agent Mesh).

Microsoft's stack, as of the pages dated in §7, provides the pieces around the harness:

| Need | Microsoft construct | Status (Microsoft) |
|---|---|---|
| Agent identity, credentials without secrets, sign-in and audit logs | Entra Agent ID: agent identity blueprint → agent identity (service principal, federated identity credentials) | Available to all Entra customers |
| A user-like identity with mailbox, calendar, Teams presence | Entra agent's user account, 1:1 child of an agent identity, `idtyp=user` tokens, no password, cannot be assigned privileged administrator roles; Microsoft 365 provisioning requires creation through Teams / Agent 365, not the Graph API alone | Frontier preview only (Agent 365 SDK doc, updated Aug 13 2026) |
| Registry, Conditional Access and Identity Protection for agents, observability, Purview/Defender coverage | Microsoft Agent 365 (extending Entra security features to agents requires it); Agent 365 SDK (identity, observability via OpenTelemetry, Work IQ MCP tool servers, notifications) | Agent 365 GA May 1 2026; the JavaScript SDK packages have a `1.0.0` release and `latest` is `1.1.0-preview.7` on npm as of Sep 15 2026; notifications require the agent's user account (Frontier) |
| Teams as a surface (whether Microsoft 365 Copilot also reaches a raw Activity bot, or needs the custom engine agent declaration in an app manifest of version 1.21 or later, is open; see §5) | Azure Bot Service + Activity protocol, or Foundry hosted agent with the automatic Activity bridge | Bot Service GA; the hosted-agents page states no GA or preview status for the feature itself |
| Models and embeddings inside the tenant | Azure OpenAI deployments in Foundry | GA |
| Durable storage | Blob Storage (append blobs, immutability policies), Azure Files, Azure AI Search or Cosmos DB vector search | GA |
| Native agent memory | Foundry Agent Service memory (preview), Copilot Studio memory (preview), Agent Framework context providers incl. Cosmos DB memory (preview, Python) | Preview. Copilot Studio memory is per-user; Foundry memory and the Agent Framework providers are scoped by a caller-set key (per-user when the Foundry tool's scope is `{{$userId}}`). None documents a source pointer from an item to its origin, a governed gate, or experience weighting |

The harness keeps the memory layers. Microsoft supplies identity, surfaces, storage, models, and
governance. Native memory features are not on the Digital Employee's path: even with an agent-level scope
they hold model-extracted items with no pointer to their origin, written without a governed
gate (Foundry memory and the Cosmos provider retrieve by similarity; Copilot Studio memory and
Agent Framework file memory let the model read its own files). They can coexist for other agents in the same tenant and can
consume the employee's approved memory through the adapters in W9.

---

## 1. Decisions

### D1. Host: a container on Azure Container Apps behind Azure Bot Service (pilot); Foundry hosted agent is the W10 spike after the pilot

Container Apps runs the gateway as one long-lived process with one record, which is what a
single employee is. The Teams path follows `TEAMS_CONNECTOR_DESIGN.md` §1–§5 (raw Activity protocol, JWT
validation, fail-closed allowlists), with the identity changes D2 records against §2 and §4; the public
HTTPS messaging endpoint the design calls out is the Container App's ingress.

Foundry hosted agents were evaluated and deferred on three grounds: the protocol libraries are
Python and C#, so a Node container would implement the Responses contract by hand; compute is
provisioned per session in VM-isolated sandboxes (session `$HOME` is deleted after 30 days of
inactivity), which suits many short conversations better than one long-lived process; and this
design keeps record authority in a store the harness owns under its own immutability and
retention policy (D3) rather than in the platform's conversation history and state store, which
are durable but carry no documented immutability policy or lock (the state store's expiry is configurable
but unlocked; the conversation history has no documented retention control), which is the gap
against D3. The attraction is
that the platform provisions the bot registration and the Activity bridge to Teams and
Microsoft 365 Copilot itself; that is worth a spike once the gateway's existing OpenResponses-compatible endpoint
can be tested against the platform's contract (W10).

### D2. Identity: one blueprint per employee class, one agent identity per employee, runtime auth by federated credential

The container's managed identity is the federated credential on the blueprint; at runtime the
gateway acquires a token for its agent identity and exchanges it for scoped tokens (Graph,
Storage, Search). This is the self-hosted path the Entra overview describes for third-party
agents ("the Microsoft Entra ID Auth SDK (sidecar) or workload identity federation"); W4 picks
sidecar or direct federation. No client secret is stored.

The Azure Bot is a separate question. A bot resource is bound to an application id, and no
cited page says a blueprint-created agent identity can be that application. The documented
secretless bot configuration is a **user-assigned** managed identity as the bot's identity
(`MicrosoftAppType: UserAssignedMSI`; the page's three identity types do not include a
system-assigned identity); the design therefore attaches a user-assigned managed identity to the Container App and binds the
Bot to it, and uses the agent identity for everything else. Against `TEAMS_CONNECTOR_DESIGN.md`:
§5's inbound JWT check is unchanged except that `aud` is the managed identity's client id; §4's
outbound token acquisition changes, because a managed identity gets its Bot Connector token from
the Container Apps managed-identity endpoint (`IDENTITY_ENDPOINT`) rather than a
client-credentials grant with a secret. The config shape becomes `channels.teams.identity:
"managed"` with `appIdEnv` holding the client id, `tenantIdEnv` kept (the bot page requires the
tenant id for `UserAssignedMSI`, and #20 §5's issuer check needs it), and no `appPasswordEnv`;
the existing secret-ref shape stays for the development tunnel case.
If a tenant spike shows the agent identity can be the bot identity, the two collapse into one.
This supersedes the "client secret (MVP)" note in `TEAMS_CONNECTOR_DESIGN.md` §2 for tenant
deployments.

One identity mode at runtime for the pilot: the employee's work runs as the agent identity
(application-only), and the sender's AAD object id is recorded as scope, not used as a
credential. On-behalf-of access is not in the pilot: a Teams activity carries no user token, and
Teams single sign-on needs a separate app registration with delegated scopes, an OAuth
connection on the Bot resource, `signin/tokenExchange` invoke handling, and user consent, which
#20 §5 rules out for the MVP ("No Graph scopes, no admin consent, no RSC permissions"). If a
role needs it later it is its own work item and its own #20 amendment. The
agent's user account, when the tenant has it (created through Teams / Agent 365 so Microsoft 365
capabilities are provisioned), is the child of the same agent identity and is used for mailbox,
calendar, and presence only.

### D3. Record and index storage: Blob append-only with immutability for L1; Azure Files + AI Search for L2; SQLite on Azure Files as the interim

The transcript store today writes JSONL to local disk (`transcript/store.ts`). In the tenant the
authoritative copy is an append blob per session under one container per employee, under a
container-level time-based retention policy, locked (Microsoft's two pages disagree on whether
an unlocked policy blocks deletes; an unlocked policy can itself be removed, so only a locked
one is a guarantee), created with `allowProtectedAppendWrites` enabled, one of the two settings under
which Append Block is permitted under a policy. Three consequences follow for the store: the effective retention of an append blob counts from its last
modification, not its creation, so session blobs must be closed (rotated daily or per session)
rather than appended to forever; once the policy is locked the protected-append setting cannot
be changed; and after expiry a blob can be deleted but never overwritten, so redaction is an
appended event plus re-derivation, never an in-place edit (§4).
Memory files stay files (Azure Files mount); the vector index moves from local SQLite to Azure AI
Search (vector + hybrid) behind the existing `MemoryRecallProvider` interface. Until W3b lands,
SQLite on an Azure Files mount is acceptable for one employee, with one caveat: its search scans
only the 5,000 most recently updated chunks before scoring, so older memory drops out of recall
as the index grows; it is not acceptable for Agent Mesh with several employees sharing one
gateway.

### D4. Scope: Entra tenant id and object id map onto the App Engine scope model

`APP_ENGINE.md` already stamps `appId`/`tenantId`/`userId`/`agentId` on transcript entries for
`/agents/:agentId/runs` runs, and `recall.ts` filters every provider's hits on
`hit.metadata.scope` after the fact; the SQLite index stores `metadata.scope` inside
`metadata_json` but is searched unscoped: `recall.ts` asks the provider for `limit*3` candidates
and filters afterwards, and `sqlite-memory.ts` scores only the 5,000 most recently updated
chunks, so a shared index can return zero in-scope hits. W3b pushes the filter into the query.
No channel connector stamps scope today; W1 and W7 add it. The Teams connector will fill
`tenantId` from `channelData.tenant.id` and `userId` from the sender's AAD object id; the Graph
mail path will fill `tenantId` from the token and `userId` from the mailbox owner's object id when that owner is a person
(a sender's SMTP address is a different key space and may be external, so it goes in
`source.senderId`, not scope). When the mailbox is the employee's own (its user account, or the shared mailbox that stands
in for it under application-only access), `userId` is left unset and the entry carries
`tenantId` and `agentId` only (connector turns run at memory scope `agent`, so the recall
filter carries the full run scope; at `user` or `tenant` scope the filter drops `agentId` and
the employee's own mail would not surface), because the scope filter (`app-engine/types.ts`,
`scopeMatchesRecallFilter`) requires an exact match on every dimension a document carries and a
human sender's turn would otherwise reject the employee's own mail; `userId` is stamped only
for a delegated mailbox owned by a person, and such an entry is then recalled only in that
person's turns, not in the employee's application-only runs, which is intended. The same rule
governs Teams: a connector turn sets `tenantId` and `agentId`, records the sender's AAD object
id in `source.senderId`, and leaves `scope.userId` unset, because a correction given in Teams
has to be recallable in the employee's own scheduled runs and in every other person's turns; a
`userId`-stamped Teams entry would be visible to its sender only. `userId` scope stays
reserved for delegated mailboxes and for per-person App Engine runs. The intent is that the
employee's channels are the employee's memory, not one person's. An `engagement`
dimension (client engagement id) is added as a first-class scope so client context is filtered
on every recall, not only by convention (W8).

### D5. The human on the approved tier is the existing approval store, surfaced in Teams

`channels/approval.ts` already turns fenced `mindstone-memory-proposal` blocks into
`memory_write` ProposedActions that apply only on `mindstone approvals approve` (#21/#22,
smoke-tested). The tenant deployment adds two things: the scheduled consolidation run that
produces proposals from the day's record (W5), and an Adaptive Card surface in a Teams channel
where the role owner approves or rejects (W6). Today the `approval_decided` event is emitted by
the CLI and `decidedBy` is the OS username; W6 moves emission into core and sets `decidedBy` to
the approver's AAD object id. The gate's decision semantics do not change; its reachability
does. Today apply-on-approve lives in the CLI, refuses non-interactive use without `--yes`, and
refuses to overwrite an existing memory file without `--force`; W6 moves apply into core with
the same overwrite refusal (a card cannot force), and puts it behind a network path guarded by
the Bot Connector JWT, a separate `approvers` allowlist (not the sender allowlist, which admits
anyone who may talk to the agent), and the approver identity. Adaptive Card `Action.Execute` actions (card schema 1.5) arrive as `adaptiveCard/action`
`invoke` activities, which #20 I1 does not map (it maps `message` only); W6 adds that mapping.

### D6. Governance signals go out through the Agent 365 SDK, not a bespoke exporter

Observability: OpenTelemetry spans for invocation, tool call, and inference, emitted through the
`@microsoft/agents-a365-observability` package so the employee appears in the Agent 365 activity
views. Tooling: Work IQ MCP servers (Mail, Calendar, Teams, SharePoint, Word) registered through
`@microsoft/agents-a365-tooling` under tenant admin control. The vendored Pi base has no MCP
support by design (its README: build CLI tools, or an extension that adds MCP), so W11 includes a
Pi extension that exposes registered MCP servers as tools; the SDK registers servers, the runtime
executes the calls. Notifications: Frontier-gated; not on
the pilot path. Purview's documented coverage of "custom engine agent prompts and responses in
Copilot Chat and Teams" is for agents declared as such; whether a raw Activity bot with #20's
manifest is covered is an open question (§5), so the record and the observability traces are
the audit trail the design relies on, with Purview as the check.

---

## 2. Work items

Claim taxonomy per the README: implemented / smoke-tested / live-validated / pending. Every item
below is **pending** today. "Ceiling" is the highest claim reachable without a real tenant.

| # | Item | What exists | What changes | Ceiling without a tenant | Depends on |
|---|---|---|---|---|---|
| W1 | Teams connector (#32) | Design #20; catalog entry `planned` | `connectors/teams.ts` per #20 I1–I3: `/api/messages` route on the gateway, JWT validation, `message` activity ⇄ inbound mapping (the `adaptiveCard/action` invoke mapping is W6's), serviceUrl replies, conversation-reference cache, scope set on the turn (`tenantId`, `agentId`; sender in `source.senderId`, `userId` unset, per D4), which stamps entries and feeds the recall filter; outbound token from either the secret-ref path (tunnel) or the managed-identity endpoint (tenant, D2); stub Bot Connector; Agents Playground leg | smoke-tested | none (the managed-identity path live-validates in the L1 leg, `TEAMS_CONNECTOR_DESIGN.md` §7 as extended in §3) |
| W2 | Azure OpenAI embedding route | Chat on Azure exists: the vendored Pi ships an `azure-openai-responses` provider (`AZURE_OPENAI_API_KEY`, base URL normalized to `.../openai/v1`, Responses API). Embedder in `memory/embedding.ts` (ids `ollama`, `openai`, `openai-compatible`, `http`) sends `Authorization: Bearer` only; Microsoft's REST sample uses an `api-key` header and Bearer for Entra tokens, and Bearer-with-key is implied only through the OpenAI SDK client | Embedder: confirm Bearer-with-key against an Azure embedding deployment, else add an `api-key` header option; add an Entra bearer option (token provider, audience `https://ai.azure.com/.default`) so the pilot's embeddings run without a key. Chat: Pi resolves the provider's key from `AZURE_OPENAI_API_KEY` (`env-api-keys.ts`) and its provider wrapper passes an API key only to the SDK client, which itself accepts an Entra token provider Pi does not expose, so an Entra token option for it is a second, small wrapper change; until it lands, chat inference in a tenant runs on a key and sits outside Conditional Access, which the deployment records | smoke-tested against a stub; live needs a deployment | none for the key path; W4 for the Entra path |
| W3a | Blob transcript store | Local JSONL transcript store (`transcript/store.ts`) | `BlobTranscriptStore`: append blob per session, daily rotation, append-only API with no rewrite path. The immutability policy itself (D3) is a tenant setting the store assumes; Azurite does not implement immutability policies, so the policy is exercised only in the live leg; Azurite's README is internally inconsistent on append-blob creation (its Put Blob note says unsupported, its own list says Create Append Blob and Append Block are supported, and the SDK's create call is a Put Blob with the append type), and it lists concurrent append as unsupported, so the smoke leg verifies `AppendBlobClient.create()` and single-writer appends against the Azurite version the smoke leg will pin in its compose file | smoke-tested against Azurite (store behavior only) | W4 |
| W3b | AI Search recall provider | SQLite memory index (`js-cosine`, `sqlite-vec` pending); scope lives in `metadata_json` and is filtered client-side after an unscoped top-k (D4) | `AzureAISearchRecallProvider` implementing `MemoryRecallProvider`; scope fields (app, tenant, user, agent, engagement from W8) become indexed fields and the provider filters on them in the query; embedding pipeline writes to Search; auth via W4's identity or a key ref. Local backends remain the default | smoke-tested against a Search stub | W2, W8; W4 for the identity path (key ref otherwise) |
| W4 | Entra runtime identity | Gateway token auth; connector credential refs | Token acquisition for the agent identity via federated credential (managed identity → blueprint → agent identity → scoped token), sidecar or direct federation per D2, cached per audience; used by W3a, W3b, W5, W7, W11, by W2's Entra path, and by W10 if the spike authenticates with Entra. Bot Connector tokens come from the Bot's managed identity (D2). Credentials never in config, logs, transcripts, or queue files (existing rule) | smoke-tested with a stub token endpoint; the live leg is the L1 leg (`TEAMS_CONNECTOR_DESIGN.md` §7, as extended in §3) | none |
| W5 | Scheduled consolidation run | Auto-compact handoff; `dreamCycle: "pending_policy"` (scaffold only) in `lifecycle/post-compact.ts`; no consolidate or checkpoint command in the CLI | A `mindstone consolidate` command that runs the cycle over the record since the last run: dedupe, source pointer on every candidate, fresh-context verification (contradiction check against existing memory, support check against the record), then emits `memory_write` proposals. Runs as a Container Apps scheduled job, which is a second container: it POSTs proposals to a new gateway endpoint (`POST /agents/:agentId/proposals`, authenticated with the W4 identity) rather than writing the gateway's local `approvals/actions.json` (temp-and-rename, no lock); the alternative is the data dir on a shared Azure Files mount with the gateway as the only writer. The published Layered Continuity Architecture paper's consolidation cycle supplies dedupe, the approval flow, and source-integrity verification; the fresh-context contradiction and support checks are designed in the paper's version 2 draft (dated September 14, 2026, held by the author, not yet published) and are unimplemented in this harness; they land here | smoke-tested with a mock provider; verification quality is a live claim | W3a (or the record on a shared Azure Files mount the job can read), W4 |
| W6 | Approval surface in Teams | `ApprovalStore` with `decidedBy` (today the OS username); apply-on-approve and the `approval_decided` event live in the CLI only (`mindstone approvals approve`, `--yes` for non-interactive, `--force` to overwrite) | Move apply-on-approve and event emission into core, keeping the overwrite refusal; Adaptive Card per pending proposal posted to a configured channel; card `invoke` actions call approve/reject with `decidedBy` = approver's AAD object id, guarded by the Bot Connector JWT and a new `approvers` allowlist (D5) | smoke-tested via the stub Bot Connector | W1 |
| W7 | Graph mail connector | Gmail connector (smoke-tested); Graph documented as second pass | `connectors/graph-mail.ts` on the #16 contract: delta query on the configured mailbox (scoped in Exchange through role-based access control for applications, which replaced application access policies; the Entra-level mail grant must not also be present or the union defeats the scope), send via Graph, `defaultSendPolicy: "approval_required"` as email already has, scope set on the turn (`tenantId`, `agentId`; `userId` only when the mailbox is a delegated mailbox owned by a person, per D4). Same identity as W4 | smoke-tested against a Graph stub | W4 |
| W8 | Engagement scope and redaction | `appId`/`tenantId`/`userId`/`agentId` scope, enforced on the file recall path | Add `engagementId` to the scope model and filter; persona route rules can set it; redaction entries (`record_redacted` event naming entry ids and reason) with re-derivation of memory files, index, and handoffs. Sequenced first because W1 stamps scope and W3b indexes it | smoke-tested | none |
| W9 | Memory as a service for other agents | No recall endpoint; recall is in-process in `memory/recall.ts`. Gateway routes are `/health`, `/webchat`, `/status`, `/rpc`, `/ws`, `/chat/*`, `/v1/*`, and `POST /agents/:agentId/runs` (the Agent Mesh route, which already accepts `appId`/`tenantId`/`userId` and is the natural home for the new endpoints) | Add a gateway recall endpoint (scope-filtered, approved memory only) and an observe endpoint (append an observation for the next consolidation run); an MCP server exposing them as `lca_recall` / `lca_observe`; an Agent Framework context provider (`before_run` → recall, `after_run` → observe) as a thin client. Neither bypasses the gate | smoke-tested | W3b, W5 |
| W10 | Foundry hosted-agent spike | OpenResponses-compatible `/v1/responses`, non-streaming, 404 unless `gateway.http.responses.enabled`, 501 unless routing is configured; the hosted-agent Responses protocol is a platform-managed event stream, so streaming is a known gap before the spike starts | Test the gateway container against the hosted-agent Responses contract; document the remaining gap | pending until run | none (W4 if Entra auth is used) |
| W11 | Agent 365 SDK onboarding | No OpenTelemetry and no MCP in the harness; Pi has no MCP by design | Observability exporter wired at the runner (`runner/provider-route-runner.ts` and the `AgentRunner` stream; spans: run, tool call, inference); a Pi extension that exposes MCP servers as tools, fed by the SDK's Work IQ registration; registry appearance | smoke-tested with an in-memory exporter and a stub MCP server; registry appearance is live only | W4 |

Sequencing for a tenant pilot: W8 first (the engagement dimension W3b indexes and W1 and W7
stamp alongside the tenant and user ids that exist today), then W2 and W4 (everything
authenticates and embeds), then W1, W3a, W3b (surface and storage), then W5 and W6 (the gate),
then W7 and W11. W9 and W10 follow the pilot. W5 depends on W3a because the scheduled job reads
the shared record (an Azure Files mount the job can read is the interim); W6 depends only on W1.

---

## 3. What does not change

- Transcript authority: the record is never rewritten. Redaction (W8) appends and re-derives; it
  does not edit. A locked Blob immutability policy enforces the same rule at the platform.
- Identity precedence: `IDENTITY.md`/`USER.md` first, persona overlay below, never overriding
  identity, user boundaries, or safety (`PERSONAS.md`).
- Auto recall runs inside the harness on every turn; the recall-usage log records, it does not weight.
- Approvals are fail-closed and auditable; `connector_mutation` has no auto path.
- No enterprise-support claims until the L1 live leg defined in `TEAMS_CONNECTOR_DESIGN.md` §7
  (to be added to `LIVE_UAT_RUNBOOK.md` at implementation) passes in a real tenant, and then the
  claim is exactly what the leg validated. This design extends that leg to cover D2's bot
  registration on a user-assigned managed identity and W4's agent-identity token acquisition
  against real Graph, Storage, Search, and Azure OpenAI (Foundry) audiences, the gateway's own
  audience (W5), and the Agent 365 registry (W11).

---

## 4. Governance design the tenant will ask for

Recorded here so the harness's behavior is specified before an enterprise review asks.

- **Retention classes:** record (longest applicable requirement; one policy per container, so an
  employee's container carries the longest requirement among its engagements, and a locked
  container-level policy can be extended at most five times, which caps how far that strategy
  stretches), approved memory
  (superseded, not deleted, except where a redaction removes a memory and its derivations),
  working artifacts (handoffs, recall-usage log; 90 days default). Configurable per employee.
- **Redaction:** `record_redacted` event with entry ids and reason; content removed from memory
  files, index, and handoffs; the original entry stays in its session blob under the policy until
  expiry, after which the whole blob can be deleted (individual entries never can, and no blob
  can be overwritten).
- **Client isolation:** engagement scope on recall (W8); or one employee per client.
- **Three audit trails:** Entra sign-in/audit logs (identity), Purview and Agent 365 observability
  (interactions and tools), the record (what the employee knew, recalled, proposed, had approved).
- **Injection tests in UAT:** one attempt through a Teams message, one through a document the
  employee reads; expected outcome: neither reaches approved memory.

---

## 5. Open questions

- Frontier availability of the agent's user account and SDK notifications for a given tenant;
  this decides bot-plus-shared-mailbox versus a user-like employee, and does not block the pilot.
- Whether the Azure OpenAI v1 endpoint accepts the embedder's Bearer-with-key header for
  embeddings (the embedder sends Bearer only; Microsoft's REST sample uses `api-key`) (W2).
- Whether a blueprint-created agent identity can serve as an Azure Bot's application identity
  (D2); until shown, the Bot runs on the Container App's managed identity.
- Whether Purview's coverage of custom engine agent interactions extends to a raw Activity bot
  with #20's bot-only manifest, and whether that bot needs the custom-engine-agent manifest
  declaration (app manifest 1.21 or later) to appear in Microsoft 365 Copilot; to be confirmed
  against the tenant's audit log, with the manifest work added if needed.
- Whether Exchange's role-based access control for applications accepts a blueprint-created
  agent identity as its service principal (W7); if not, the mailbox scope is granted to the
  bot's managed identity and the split is recorded.

---

## 6. Claim boundaries

Nothing in this document is implemented. The Teams connector remains `planned`; the Graph mail
path remains documented-only; consolidation in this harness remains an auto-compact handoff with
the dream cycle at `pending_policy`; the verification stage remains designed and unimplemented.
When the pilot items (W1 through W8 and W11) land they carry the claims their smoke legs earn, and the first real-tenant run earns
"live-validated single-tenant Digital Employee" and nothing broader.

## 7. References (pages read September 15, 2026)

- Entra Agent ID overview (Aug 13 2026): https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id
- Agent's user account (Aug 13 2026): https://learn.microsoft.com/en-us/entra/agent-id/agent-users
- Foundry agent identity concepts (Aug 25 2026): https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/agent-identity
- Agent 365 overview (Aug 20 2026): https://learn.microsoft.com/en-us/microsoft-agent-365/overview
- Agent 365 SDK overview (Aug 13 2026): https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-sdk
- Foundry memory concept (Jun 4 2026) and how-to (Aug 7 2026): https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory , https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/memory-usage
- Copilot Studio memory (Aug 3 2026): https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/memory-overview
- Agent Framework overview (Aug 25 2026) and context providers (Sep 11 2026): https://learn.microsoft.com/en-us/agent-framework/overview/ , https://learn.microsoft.com/en-us/agent-framework/concepts/agents/conversations/context-providers
- Cosmos DB memory for Agent Framework (Jul 24 2026): https://devblogs.microsoft.com/cosmosdb/native-agent-memory-for-microsoft-agent-framework-powered-by-azure-cosmos-db/
- Foundry hosted agents (Sep 14 2026): https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents
- Custom engine agents for Microsoft 365 (Aug 11 2026): https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview-custom-engine-agent
- Microsoft 365 Agents SDK (Aug 21 2026): https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/
- Immutable storage overview (Aug 25 2026) and container-level WORM policies (Mar 24 2026): https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview , https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-container-level-worm-policies
- Azure OpenAI v1 API (Jun 5 2026): https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
- Azure Bot Service authentication, bot identity types incl. user-assigned managed identity (Dec 16 2025; the page's Bot Framework SDK is archived, the identity types are Azure Bot resource settings): https://learn.microsoft.com/en-us/azure/bot-service/bot-builder-authentication
- Teams single sign-on for bots, why OBO is out of the pilot (Sep 1 2026): https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-overview
- Adaptive Card Universal Actions, the `adaptiveCard/action` invoke and schema 1.5 (Jul 27 2026): https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/work-with-universal-actions-for-adaptive-cards
- Managed identities in Azure Container Apps, the identity endpoint (Feb 13 2026): https://learn.microsoft.com/en-us/azure/container-apps/managed-identity
- Role Based Access Control for Applications in Exchange Online (Aug 21 2026): https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac
- Agent 365 SDK JavaScript packages on npm: https://www.npmjs.com/package/@microsoft/agents-a365-observability , https://www.npmjs.com/package/@microsoft/agents-a365-tooling
- Layered Continuity Architecture paper (published research draft, Jun 19 2026; the version 2 draft of Sep 14 2026 that designs the verification checks is held by the author and not yet published): https://mindstoneagent.ai/docs/research/layered-continuity/architecture/
