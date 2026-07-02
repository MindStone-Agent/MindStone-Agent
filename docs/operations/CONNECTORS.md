# Channel connector framework (v1)

Issue #16: the shared contract every production channel connector (Telegram,
Slack, Discord, email, …) implements, plus the **loopback** reference connector
— the first end-to-end implementation and the template for #17+.

## The contract (`MindStoneConnector`, core `channels/`)

| Ticket requirement | Framework surface |
|---|---|
| Setup wizard | `setup: ConnectorSetupAdapter` (configure/disable; collects REFS + policy, never raw secrets) |
| Credential storage | `tokenEnv` / `tokenFile` REFS in `config.channels.<id>`; `resolveConnectorCredential` (env wins, file fallback, 0600 warning); `maskCredential` for display — raw secrets never enter config or status |
| Allowlist/pairing | `allowedSenders` / `allowedChats` / `pairedSenders`; `evaluateConnectorAccess` **fails closed** (no policy ⇒ deny; no senderId ⇒ deny) |
| Inbound listener | `startInbound(ctx, onMessage) → handle.stop()`; normalized `ConnectorInboundMessage` |
| Outbound send | `sendOutbound(ctx, message)` — called by the delivery-queue worker; throw to retry |
| Thread/session mapping | `connectorSessionKey` → standard session discipline: `single` collapses to the canonical session, `per_surface` keys by connector/chat/chatType and prefers `threadId` |
| Source metadata | `connectorTranscriptSource` → `substrate: connector:<id>`, channel/chatType/sender on every transcript entry |
| Mention/trigger behavior | `shouldTriggerConnectorReply`: DMs always; group/channel needs mention or `triggerPrefix` (which strips) unless `respondWithoutMention` |
| Delivery queue | `ConnectorDeliveryQueue` — persistent per-connector JSON queue, retry to `maxAttempts` then dead-letter with the error kept; survives Gateway restarts |
| Send policy / approvals (#21) | `defaultSendPolicy: "approval_required"` on the contract diverts routed replies into the durable `ApprovalStore` (ProposedAction) instead of the queue; `mindstone approvals approve` enqueues, `reject` archives — both auditable via `approval_proposed`/`approval_decided` transcript events. Chat connectors stay `auto`; config `sendPolicy` overrides explicitly |
| Status/doctor/TUI visibility | per-connector `status.json` (state/lastError/inbound/denied counts) written by the Gateway runtime, read anywhere; `getConnectorVisibilityStatuses` consolidates credential-presence (masked) + runtime + queue depth into `mindstone status [--json]` and the `connectors.catalog` doctor check |
| Tests/smokes | `npm run smoke:connector` |

## Gateway connector runtime

The Gateway starts every configured+enabled connector at boot
(`config.channels.<id>` present, `enabled !== false`). Inbound pipeline:

```text
inbound message
→ allowlist/pairing (deny ⇒ counted, dropped — fail closed)
→ trigger policy (no-reply messages still land in the transcript)
→ session key + source metadata → user transcript entry
→ standard configured route (same path as chat/gateway surfaces)
→ reply enqueued on the connector's delivery queue → sendOutbound (retry/dead-letter)
```

**Failure isolation:** a connector with no registered implementation, an
unresolvable credential ref, a throwing `startInbound`, or a failing inbound
handler writes its error into `connectors/<id>/status.json` — the Gateway HTTP
surface stays up regardless (smoke-proven: `/health` 200 with broken
connectors configured; doctor reports `connectors.catalog` as a warn).

## Loopback reference connector

Transport is a local file spool — no network, no external service — so the
entire contract is exercisable deterministically:

```text
<dataDir>/connectors/loopback/inbox.jsonl   # append ConnectorInboundMessage JSON lines
<dataDir>/connectors/loopback/outbox.jsonl  # replies appear here via the delivery queue
```

```jsonc
// config.channels.loopback
{ "enabled": true, "allowedSenders": ["clint"], "triggerPrefix": "!ms", "pollMs": 100 }
```

Production connectors replace the spool with their native transport and keep
everything else.

## Claim status

Implemented + smoke-tested (`npm run smoke:connector`, 2026-07-02): contract
units (credential env/file/masking/0600-warning, fail-closed access matrix,
trigger matrix incl. prefix stripping, single/per-thread session mapping,
queue retry + dead-letter), the loopback connector end-to-end through a
running Gateway (inbound spool → allowlist denial counted → trigger gating →
connector source metadata in the transcript → mock-routed reply in the outbox
with `inReplyToMessageId` correlation), and failure visibility (no-impl and
credential-unresolved connectors error in status/doctor while `/health` stays
200). No live external-service claims — those are per-connector issues
(#17–#22) with live legs in `LIVE_UAT_RUNBOOK.md`.

## Designed, not implemented

- **Microsoft Teams (#20)** — design + MVP path in `TEAMS_CONNECTOR_DESIGN.md`
  (Activity-protocol route, single-tenant Entra story, stub-Bot-Connector +
  Agents Playground validation seams). Catalog status `planned`; implementation
  deliberately sequenced after #21/#22.
