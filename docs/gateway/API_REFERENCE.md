# MindStone-Agent Gateway API Reference

**Status:** MVP reference for the current Gateway surface  
**Scope:** Non-streaming HTTP/RPC/WebSocket APIs currently implemented in MindStone-Agent

This document describes the Gateway surface as implemented today. It is intentionally conservative: it documents scaffold, mock-routed, and Pi-routed behavior separately, and does not claim live Pi model success, OpenResponses streaming, or full OpenAI/OpenResponses API parity.

## Runtime and base URL

Manage the isolated Gateway through the public MindStone CLI:

```bash
mindstone gateway status
mindstone gateway start
mindstone gateway restart
mindstone gateway stop
mindstone gateway logs
```

For foreground/debug operation:

```bash
mindstone gateway run
```

On macOS, user-service management is available through launchd:

```bash
mindstone gateway install
mindstone gateway uninstall
```

The legacy development path remains `npm run start:gateway`, but product/MVP workflows should use `mindstone gateway ...`.

Default base URL:

```text
http://127.0.0.1:19789
```

The Gateway uses project-local runtime state under `.runtime/`. Do not run bare global `pi` for MindStone-Agent validation.

## Authentication

`GET /health` and `GET /webchat` are unauthenticated so liveness checks and the static browser shell can load directly.

All other HTTP endpoints and WebSocket upgrades enforce configured Gateway auth:

```json
{
  "gateway": {
    "auth": {
      "mode": "token",
      "tokenEnv": "MINDSTONE_AGENT_GATEWAY_TOKEN"
    }
  }
}
```

Supported modes:

| Mode | Accepted credentials |
| --- | --- |
| `none` | No credentials required. |
| `token` | `Authorization: Bearer <token>` or `X-MindStone-Token: <token>`. |
| `password` | HTTP Basic auth or `X-MindStone-Password: <password>`. |

Status/doctor/CLI surfaces report the auth mode and credential source without exposing secret values.

## HTTP surface enablement

OpenAI-compatible HTTP surfaces are gated independently:

```json
{
  "gateway": {
    "http": {
      "chatCompletions": { "enabled": true },
      "responses": { "enabled": true }
    }
  }
}
```

Behavior:

- `/v1/chat/completions` returns `404 disabled` unless `gateway.http.chatCompletions.enabled === true`.
- `/v1/responses` returns `404 disabled` unless `gateway.http.responses.enabled === true`.
- `/v1/models` is enabled when either compatible HTTP surface is enabled.

These gates are covered by `npm run smoke:gateway-http-surfaces`.

## Session and transcript behavior

Gateway traffic appends to the canonical MindStone transcript. With the default single-session policy, omitted session keys resolve to:

```text
agent:default:main
```

Surfaces preserve distinct source metadata:

| Surface | Source metadata |
| --- | --- |
| REST chat | `substrate: gateway-rest`, `channel: webchat`, `chatType: internal` |
| HTTP/WS RPC | `substrate: gateway-rpc`, `channel: webchat`, `chatType: internal` |
| OpenAI chat completions | `substrate: openai`, `channel: openai-chat-completions`, `chatType: internal` |
| OpenResponses | `substrate: openai`, `channel: openai-responses`, `chatType: internal` |

`npm run smoke:unified-session` verifies REST, HTTP RPC, WebSocket RPC, OpenAI chat completions, and OpenResponses omitted-session traffic append to one canonical transcript while preserving source metadata.

## Routing behavior

Gateway model routes go through the Core `AgentRunner` boundary.

Current modes:

| `routing.mode` | Behavior |
| --- | --- |
| `placeholder` or unset | Persists transcript input and returns explicit scaffold/not-implemented responses where a model response would be required. |
| `mock` | Uses deterministic local mock responses for smoke validation. |
| `pi` | Uses the isolated Pi provider-level scaffold/fallback path. This is not the real MVP Pi execution path. |
| `pi-session` | Uses the session-backed `PiSessionAgentRunner` / `PiSessionExecutor` path with Pi `SessionManager` and `AgentSession`. Live authenticated model behavior is still gated by explicit isolated auth/model config. |

## Core endpoints

### `GET /health`

Unauthenticated liveness endpoint.

Example:

```bash
curl http://127.0.0.1:19789/health
```

Returns `200` with service/version and runtime path information.

### `GET /status`

Authenticated status endpoint backed by Core system status.

Example:

```bash
curl -H "Authorization: Bearer $MINDSTONE_AGENT_GATEWAY_TOKEN" \
  http://127.0.0.1:19789/status
```

Returns `200` when status is OK, otherwise `503`. Includes sanitized Gateway setup visibility: base URL, auth mode/source, compatible HTTP enablement, and route names. It does not perform live Gateway/network probing and does not expose secret values.

### `GET /webchat`

Unauthenticated static browser shell.

```text
GET /webchat
GET /webchat/
```

The shell is a built-in MindStone WebChat surface over Gateway REST endpoints. Auth still applies to the API calls made by the page.

## REST chat endpoints

### `GET /chat/sessions`

Returns known transcript sessions.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:19789/chat/sessions
```

### `GET /chat/history`

Reads transcript history for a session.

Query parameters:

| Parameter | Notes |
| --- | --- |
| `sessionKey` | Optional explicit session key. Defaults through configured session policy. |
| `agentId` | Optional, default `default`. |
| `senderId` | Optional source metadata and per-surface session derivation input. |
| `threadId` | Optional source metadata and per-surface session derivation input. |
| `limit` | Optional maximum number of entries returned. |

Example:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:19789/chat/history?limit=20"
```

### `POST /chat/inject`

Appends a transcript entry without starting a model run.

Required body fields:

| Field | Notes |
| --- | --- |
| `role` | One of `user`, `assistant`, `tool`, `system`, `event`. |

Optional body fields include `text`, `content`, `sessionKey`, `agentId`, `senderId`, `threadId`, and `metadata`.

Example:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:19789/chat/inject \
  -d '{"role":"assistant","text":"Seeded assistant note."}'
```

Returns `201` with the appended entry.

### `POST /chat/send`

Appends a user message and attempts a routed assistant run.

Required body fields:

| Field | Notes |
| --- | --- |
| `text` | Non-empty user text. |

Optional body fields include `sessionKey`, `agentId`, `senderId`, `threadId`, and `metadata`.

Behavior:

- Always appends the user message when valid.
- In configured routed modes, returns routed assistant output and appends assistant metadata.
- Without a configured provider, records a `routing_not_implemented` event and returns `501` with `persisted: true`.

Example:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:19789/chat/send \
  -d '{"text":"Hello from REST chat."}'
```

### `POST /chat/abort`

Requests cancellation for active Gateway runs in a session, optionally by `runId`.

Optional body fields include `sessionKey`, `agentId`, `runId`, `senderId`, and `threadId`.

Returns `202` and appends an `abort_requested` event whether or not a matching active run was found.

## RPC bridge

The old MindStone/WebChat method-name bridge is available over HTTP and WebSocket.

```text
POST /rpc
WS   /rpc
WS   /ws
```

Request shape:

```json
{
  "id": "request-1",
  "method": "chat.history",
  "params": {
    "limit": 20
  }
}
```

Success shape:

```json
{
  "id": "request-1",
  "ok": true,
  "result": {}
}
```

Error shape:

```json
{
  "id": "request-1",
  "ok": false,
  "error": {
    "code": "method_not_found",
    "message": "Unknown Gateway RPC method: ..."
  }
}
```

Implemented methods:

| Method | Equivalent behavior |
| --- | --- |
| `chat.sessions` | Lists transcript sessions. |
| `chat.history` | Reads transcript history. Params mirror REST history. |
| `chat.inject` | Appends an assistant entry. Requires `message` or `text`. |
| `chat.send` | Appends a user message and attempts routing. Requires `message` or `text`. |
| `chat.abort` | Requests run cancellation and appends an abort event. |

WebSocket upgrades require the same auth headers as authenticated HTTP endpoints.

## OpenAI-compatible endpoints

These endpoints provide compatibility for clients expecting OpenAI-style HTTP APIs. They are transcript-aware and route through `AgentRunner` when configured, but are not full API-parity implementations.

### `GET /v1/models`

Enabled when either `/v1/chat/completions` or `/v1/responses` is enabled.

Returns an OpenAI-style model list derived from configured agents/default model, or `mindstone/default` when no agents are configured.

### `POST /v1/chat/completions`

Non-streaming OpenAI chat-completions-compatible endpoint.

Required body fields:

| Field | Notes |
| --- | --- |
| `messages` | Non-empty array of OpenAI-style messages. |

Optional fields:

| Field | Notes |
| --- | --- |
| `model` | Defaults to `mindstone/default`. `mindstone/<agentId>` names an agent and means that agent's model: its own `defaultModel`, else `routing.defaultModel`. Any other id is the model itself, but only for the owner; a non-owner (a Console user, a tenant) always gets the agent's model (#134). |
| `user` | Used as source sender ID when present. |
| `metadata.agentId` | Optional MindStone agent ID. Defaults to `default`. |
| `metadata.sessionKey` | Optional explicit MindStone session key. |

Only the new turn is stored: the trailing run of user messages (a message with no role counts as user). Clients such as the MindStone Console resend the whole conversation every turn; the gateway already has it, so earlier messages are not stored again, and a request that doesn't end with a user message is a `400 invalid_messages`. String content and text-like content array parts are extracted for transcript text.

Client `system` (and `developer`) messages follow the Console design (§4.2): with the forwarded role `user` they are ignored and logged once per session as a `client_system_prompt_ignored` event (length and hash, not the text); for an `admin` or a caller with no forwarded role they are stored once per session as a `system` entry.

A request with an `x-mindstone-conversation-id` header (the Console) gets its own session, `agent:console:console:<userId>:<conversationId>` (parts longer than 64 characters once URL-encoded are hashed), unless `metadata.sessionKey` names one. The key is per conversation, not per persona or config, so switching persona mid-conversation or changing `routing.defaultAgentId` keeps its history. The gateway replays the auto-compact handoff only into the session that wrote it (the CLI and TUI still replay the current handoff into any session). The memory backfill indexes every conversation into memory. Recall isn't scoped by agent or Console user yet, so the owner's recall can surface any Console user's conversation (#71).

**Who the turn answers (#103).** A forwarded role of `admin` is the owner: `USER.md`, the memory index, autoRecall, owner-only invariants and the handoff. Any other forwarded role (`user`), or a role header sent blank, gets the non-owner context a connector's non-owner gets: none of those. A caller with the service token that sends no role header is the owner, as before. A non-owner's `metadata.sessionKey` and `metadata.agentId` are ignored, and it is known only by the Console's forwarded user id (never the body's `user`). A non-owner turn without `x-mindstone-user-id` is refused (`400`). Its sessions are keyed apart from the owner's, including the same user's owner-audience sessions, and without a conversation id it still gets a session of its own, never the owner's main session. So it can't reach owner history. The owner's first Console conversation (a request with `x-mindstone-conversation-id`) after setup starts first-activation identity formation, once per agent (#102). The gateway claims `<dataDir>/identity-formation/<agentId>.json` before the turn runs, and gives it back if the turn fails, and the first turn's transcript gets an `identity_formation_prompted` event. It waits until setup has finished (`onboarding.identity` is set). It runs only for a configured agent whose IDENTITY.md is still the pending scaffold, the initializer placeholder, or missing, so an agent with a real identity isn't sent back to formation.

A role header that is present but blank counts as an unknown user, not a trusted caller.

Behavior:

- Persists the new turn (and any kept client system prompt) to the canonical transcript.
- In routed modes, returns a non-streaming `chat.completion` response and includes a `mindstone` metadata object.
- Without a configured provider, returns `501 not_implemented` with `mindstone.persisted: true` and transcript entries.
- With `stream: true`, the routed answer is sent as server-sent events: one content chunk, a stop chunk, then `[DONE]`.

Example:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:19789/v1/chat/completions \
  -d '{"model":"mindstone/mock","messages":[{"role":"user","content":"Hello"}]}'
```

### `POST /v1/responses`

Non-streaming OpenResponses-compatible endpoint.

Who the turn answers follows the same rules as `/v1/chat/completions`: a forwarded `x-mindstone-user-role` of `admin` is the owner; any other role, or a blank one, gets the non-owner context, can't choose `metadata.sessionKey` or `agentId`, and needs `x-mindstone-user-id` (`400` without it). With no role header, the service-token caller is the owner.

Required body fields:

| Field | Notes |
| --- | --- |
| `input` | Non-empty string or array. |

Supported input forms:

```json
{ "input": "plain user text" }
```

```json
{
  "input": [
    {
      "role": "user",
      "content": [{ "type": "input_text", "text": "Hello" }]
    }
  ]
}
```

Optional fields:

| Field | Notes |
| --- | --- |
| `model` | Defaults to `mindstone/default`. `mindstone/<agentId>` names an agent and means that agent's model: its own `defaultModel`, else `routing.defaultModel`. Any other id is the model itself, but only for the owner; a non-owner (a Console user, a tenant) always gets the agent's model (#134). |
| `user` | Used as source sender ID when present. |
| `metadata.agentId` | Optional MindStone agent ID. Defaults to `default`. |
| `metadata.sessionKey` | Optional explicit MindStone session key. |

Behavior:

- Persists supported string/array inputs to the canonical transcript.
- In routed modes, returns a non-streaming OpenResponses-style `response` object with `output` and `output_text`.
- Without a configured provider, returns `501 not_implemented` with `mindstone.persisted: true` and transcript entries.
- Streaming, tool-calling parity, and full OpenResponses API parity are not implemented yet.

Example:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:19789/v1/responses \
  -d '{"model":"mindstone/mock","input":"Hello from OpenResponses."}'
```

## Validation commands

Relevant smoke tests:

```bash
npm run smoke:chat
npm run smoke:rpc
npm run smoke:ws-rpc
npm run smoke:openai
npm run smoke:router-mock
npm run smoke:gateway-http-surfaces
npm run smoke:auth
npm run smoke:unified-session
npm run smoke:doctor
npm run smoke:core-boundary
```

Manual/live validation still pending:

- live authenticated Pi-backed prompt/stream validation with isolated auth/model
- live authenticated `AgentSession.compact(...)` validation
- OpenWebUI validation
- browser/manual WebChat UX validation

## Current non-goals and boundaries

- No global Pi auth/state should be touched.
- No secret values should be emitted in status/doctor/CLI output.
- Gateway setup visibility is configuration visibility, not live network probing.
- JSONL transcripts remain authoritative and append-only.
- Prompt pruning and compaction affect live context only, never transcript history.
- OpenResponses support is non-streaming compatibility, not full API parity.

## Admin API (MindStone Console, #38 P2)

Server to server: the MindStone Console server calls these with the gateway's service credential **and** a separate admin credential, and forwards the signed-in user's id and role (`x-mindstone-user-id`, `x-mindstone-user-role`). Rules:

- The admin API does not exist (`404`) unless gateway auth is `token` or `password` **and** an admin credential is configured. The recommended form is `gateway.admin.tokenSha256`: the SHA-256 of the credential as 64 hex characters (`printf %s "$TOKEN" | shasum -a 256`). The gateway then never holds the credential itself, so an agent that can read the gateway's config or environment doesn't learn it. `gateway.admin.tokenEnv` (an environment variable name) or `gateway.admin.tokenFile` (relative to the config file) also work; that credential must be at least 16 characters. Either way it must differ from the gateway's own credential. Only the Console server holds the credential.
- Gateway auth and the admin credential are set on the gateway host. The Console can't change them, or write the files they point at, even with the advanced-settings permission.
- The admin credential protects the admin API from callers who hold only the gateway token. With `tokenSha256`, even an agent with Pi's `read` tool can't recover it. But with `bash`, `write` or `edit` enabled, anyone who can chat with the agent can have it rewrite the config or the permission file directly, which is at least as much power as the admin API. Treat enabling those tools that way.
- Every call needs the gateway credential (`401`), the admin credential in `x-mindstone-admin-token` (`401`, compared in constant time), and the role `admin` (`403`). The ordinary gateway token, which webchat and API callers hold, is not enough.
- Every write needs `x-mindstone-user-id` (`400` otherwise). Every write, and every refused call from a caller holding the admin credential, is appended to `<dataDir>/admin/audit.jsonl` with the user id (caller-chosen strings capped at 200 characters). Secret values never reach the audit, a response or a log.

| Endpoint | What it does |
|---|---|
| `GET /admin/status` | Onboarding state (`onboarded`, and per step: provider, persona, memory, identity, connectors) plus system status. `onboarded` needs a provider, a persona, memory (a vector store and an embedding provider, including one set by `MINDSTONE_EMBEDDING_PROVIDER` or `EMBEDDING_PROVIDER` in the gateway's environment) and finished setup (`onboarding.identity`, written with the scaffold) (#102); connectors are optional. The Console shows onboarding while `onboarded` is false. Also `supervisor` (the declared one, or null), `supervisorConfirmed` and `supervisorDetail` (whether the evidence matches), `startedAt` (this process's start) and `recentStarts` (starts in the last 10 minutes) (#90). |
| `GET /admin/config` | The effective config and its `etag` (also the `ETag` header; keyed with a per-process secret, so it can't be used to check guesses at hidden values, and it changes when the gateway restarts). Secrets are replaced by `{ "set": true\|false }`: the value under any key that contains token, secret, password, credential, cookie, jwt, sessionId, signature, apiKey, privateKey, accessKey or authorization, or ends in key, pass, auth, pat, pin, otp, pem or dsn (case and separators ignored), whatever its type; and every value in a header or environment map or list (`headers`, `extraHeaders`, `env`, `envVars`, `environmentVariables`, …). Credentials inside URLs are masked (userinfo, secret-looking query and fragment parameters, and token-like path segments such as webhook and bot URLs), and so are secret values in command-line style lists (`["--api-key", "…"]`). Inline credentials in plain strings are masked too: `NAME=value` pairs with a secret-sounding name (`DB_PASSWORD=…`, `access_token=…`), JSON `"client_secret": "…"` inside a string, header lines (`Authorization: …`, `X-API-Key: …`), Bearer/Basic credentials, `-u user:pass`, URLs anywhere in the string, and `{ name, value }` header lists (the names stay). Free-text notes (keys ending in Notes, Context or Direction, such as the onboarding preferences) are the owner's prose and are shown as written. Booleans, token budgets such as `contextWindowTokens`, session keys, public keys and references to where a secret lives (`tokenEnv`, `tokenFile`, `tokenUrl`, …) are shown. |
| `PATCH /admin/config/<section>` | JSON merge patch (RFC 7396) of one section: `null` removes a key. Anything sent back exactly as GET returned it keeps the stored value: a masked secret, a URL with its credentials masked, a masked header list. A new plain value for a secret is a `400`: store it with `POST /admin/secrets/<name>` and reference it with `tokenFile`. Replacing a value that has hidden parts (a URL with a password, a header list) needs the advanced-settings permission (`403`), even when the new value turns out to be the same, so a patch can't confirm a guess. Keys that are empty or contain `.`, prototype keys, and patches nested more than 32 deep are a `400`. The config and the permission are read when the body has arrived, one write at a time. `If-Match` (strong or weak, one etag or a list) refuses the write with `412` if the config changed since it was read. The result is validated (`422`), checked against the advanced-settings permission (`403`) and written atomically, keeping the file's mode. The response lists `changed` paths, `restartRequired` (connectors and gateway host and port need a restart; everything else applies on the next message) and the new `etag`. |
| `POST /admin/secrets/<name>` | `{ "value": "…" }` is stored in `<dataDir>/secrets/<name>` (0600, directory 0700) and never echoed. Reference it from config as `tokenFile: "secrets/<name>"`. Replacing an existing secret, or writing any file a connector is configured to read (any `…File` setting on a channel, resolved as the connector resolves it, symlinks included), needs the advanced-settings permission (`403`). A new secret is created exclusively; if a protected file that didn't exist (a connector's token file, or one of the gateway's own credential files) exists afterwards, the new name reached it through the filesystem's own folding (APFS treats `ß` as `ss` and `ſ` as `s`) or a chain of links, so it is removed and refused. The files holding the gateway's own credentials can't be written under any name that reaches them, with or without the permission (`422`: file identity, names compared without case, symlinks followed, and the check above). A secret name that is a link (made on the host) is never replaced (`422`). A write that fails leaves no temporary copy of the value. |
| `GET /admin/secrets` | The stored secrets by name (#88): for each, `kind` (`file`, `link` or `other`; a link is never followed), `modifiedAt` for a file (no size: a secret's length says something about it, #92), the `tokenFile` reference, `usedBy` (the connectors whose `…File` setting reads it, by the store guard's rule) and `gatewayCredential`. Values are never read or returned. |
| `DELETE /admin/secrets/<name>` | Removes a stored secret (#88). Needs the advanced-settings permission (`403`), like replacing one. Refused (`503`) if the config can't be loaded at that moment, since the gateway's own credential files wouldn't be known (#92); storing a secret does the same. Refused (`422`) for the gateway's own credential files (under any name that reaches them), for a name that is a link made on the host (the link and its target are left alone) and for anything that isn't a file; `404` if there's no such secret. Audited. The answer lists `usedBy`, the connectors that lose their token. |
| `GET /admin/permissions` | The advanced-settings permission. `expiresAt` is the expiry that applies: at most one hour after `grantedAt`, whatever the stored file says. |
| `GET /admin/models` | What onboarding can offer: the provider `presets` (Ollama local and Cloud, LM Studio, an OpenAI-compatible server, each with `needsKey`), the providers already `registered` in Pi's isolated `models.json` (URL credentials masked; auth shown only as `none`, `env: NAME` or `stored key`), and Pi's own `providers` and `models`. |
| `POST /admin/providers/<preset>` | Registers a preset in the isolated `models.json`. Body: at most one of `secret` (the name of a secret stored with `POST /admin/secrets`, copied into `models.json` at 0600, escaped so Pi reads it as a literal: a `$` or a leading `!` is never expanded or run) or `env` (a variable whose name ends in `_API_KEY`, stored as a `$VAR` reference); optional `models` (ids; without them the gateway lists `<baseUrl>/models` with the key, reading at most 1 MiB and keeping only plain ids). Where a key can go: a hosted preset's address (Ollama Cloud) is fixed; a local preset's `baseUrl` may change, but only to loopback, a private network or `.local`, over http(s) with no credentials, query or fragment. A key is never accepted in the body and never echoed. Refused: the gateway's own credentials, by variable name (the defaults included) or by value (the service token or password, or the admin credential) (`422`); a connector's token file (`422`); a secret that is a symlink (`400`); re-registering a provider that has headers or overrides set on the host (`409`). Keyless local presets get their placeholder key. Needs the advanced-settings permission (`403`). Every refusal and every failed listing (the key was sent) is audited, with the key's source, never its value; listing errors say nothing from the server's reply. OAuth subscription providers are set up in the TUI (`mindstone onboard`). |
| `GET /admin/doctor` | `mindstone doctor` for the Console (#86): `{ report: { ok, checks: [{ id, severity, title, detail }], summary } }`. Pi discovery and the embedding probe get 8 s each (run together), so the answer arrives inside the Console proxy's timeout; a probe that runs out is reported as timed out. Titles and details are masked like config values in text. Paths are shown. |
| `GET /admin/logs?lines=N` | `mindstone gateway logs` for the Console (#86): the last N lines (1 to 500, default 80) of the managed gateway log (`<dataDir>/gateway/gateway.log`), each masked. At most the last 512 KiB is read, and a partial first line is dropped. `{ available: false }` when there's no managed log (the gateway wasn't started by `mindstone gateway start` or the launchd service). |
| `GET /admin/approvals` | Proposed actions held for a decision (#84): pending ones, or every one with `?all=1`, plus the counts. The list carries each action's id, status, kind, connector, summary and decision, never the draft text. |
| `GET /admin/approvals/<id>` | One proposed action with its draft (`send`), memory write (`memory`), mutation (`mutation`), proposed persona (`persona`, #105) or proposed skill (`skill`, #104: id, label, description, goal, whenToUse, outputs, safetyNotes, instructions). `<id>` is the full id or a unique prefix of at least 8 characters. |
| `POST /admin/approvals/<id>/approve` | Approves it with the same guards as `mindstone approvals approve`: decided first (an action decided meanwhile is refused), queued at most once, a second approve refused while the first is still running, the decision undone if the queue is locked. A memory write over an existing file needs `{ "force": true }`. Approving a `skill_install` (a skill the agent proposed in chat, #104) installs it directly (an admin's draft of the same id is left alone), and needs the advanced-settings permission (`403`, `code: "advanced"`); replacing an installed skill of the same id needs `force`. If the files can't be written, the answer is a `500` (`install_failed`) and the action goes back to pending. Refusals are `409` or `422` with a `code` (`already_decided`, `approve_running`, `changed`, `queue_busy`, `memory_exists`, `skill_exists`, `invalid_skill`, `unsafe_path`, `no_payload`) and audited. `decidedBy` is `console:<user id>`. Other kinds need no advanced-settings permission. |
| `POST /admin/approvals/<id>/reject` | Rejects it, with an optional `note` (up to 2000 characters). Refused (`409`, `already_queued`) when a send for it is already queued, since rejecting it wouldn't stop it. |
| `GET /admin/skills` | The Skill Builder (#104): every skill the gateway knows, each with `id`, `label`, `description`, `version` and `source` (`installed`, `draft` or `builtin`). An installed skill is in the owner's prompt from the next message, with every field and its SKILL.md; the prompt holds 24,000 characters of skills, and an installed skill past that is listed by id, label and description only. Installed skills carry `inPrompt`, false for those. A skill that doesn't load has an `error`, with paths relative to the skills directory. |
| `GET /admin/skills/<id>` | One skill with its fields (`goal`, `whenToUse`, `outputs`, `safetyNotes` among them) and `skillMarkdown`. `?source=installed`, `draft` or `builtin` picks one; without it, the one that applies (installed, then draft, then built-in). Any other `source` is a `400`; no such skill is a `404`. |
| `POST /admin/skills/drafts` | Builds a draft, which does nothing until it is installed. From a built-in: `{ "fromBuiltin": "integration-builder" }`, optionally with `id`, `label`, `description` and `goal` to override it. From scratch: `id` (lowercase letters, digits and hyphens, up to 64), `label`, `description`, and optionally `goal`, `whenToUse`, `outputs` and `safetyNotes` (lists of up to 12) and `instructions` (markdown, up to 16,000 characters; without it the draft gets an outline from the fields). Bad input is a `400`. A draft or installed skill of that id is a `409` unless `{ "force": true }`. No advanced-settings permission needed. Audited. |
| `DELETE /admin/skills/drafts/<id>` | Discards a draft; `404` if there's none. An installed skill is never touched here. Audited. |
| `POST /admin/skills/<id>/install` | Installs the draft `<id>`, making it active. Needs the advanced-settings permission (`403`): an installed skill changes what the agent is told on every owner turn. An installed skill of the same id is a `409` (`code: "skill_exists"`) unless `{ "force": true }`; no such draft is a `404` (`not_found`); a draft that doesn't load is a `422` (`invalid_skill`). Audited. |
| `POST /admin/permissions/advanced` | `{ "enabled": true, "confirm": "enable advanced settings" }` grants it for one hour (the phrase is compared after trimming, collapsing whitespace and lowercasing, so capitals and stray spaces are fine; the words must match exactly) (it runs from `grantedAt` for at most an hour, and a `grantedAt` in the future isn't honoured); `{ "enabled": false }` revokes it early. It lives in `<dataDir>/admin/permissions.json`, not in config, so a config patch can't grant it. |
| `POST /admin/onboarding/complete` | Finishes the Console's setup the way `mindstone onboard` does (#102): writes the `onboarding` record (the persona's profile, `identity.mode` `defer` unless already set) and the default agent's `IDENTITY.md`/`USER.md` first-activation scaffold. The user's own words (purpose, project context, context) go in `USER.md` only, since non-owner turns also get `IDENTITY.md`. Body: optional `purpose` (up to 2000 characters), `userContext` (4000) and `projectContext` (2000), the user's own words. An initializer placeholder file is replaced and kept as `.pre-onboarding-placeholder.bak`; any other existing file is kept. Returns `identity` and `user` as `created` or `kept`, never a path. The files are written before the config, so a scaffold that can't be written is refused (`409`) and setup doesn't count as finished. Needs the advanced-settings permission (`403`) and a provider and a persona first (`409`). Audited. |
| `POST /admin/memory/check` | A live embed with a candidate embedding provider before it is saved (#102): `{ "embeddingProvider": "ollama:<model>" }` (or `openai:` / `openai-compatible:`, which use the key and address set on the gateway host). `200` with `{ ok: true, providerId, model, dimensions }`, or `{ ok: false, error, missingModel }` where `missingModel` says an Ollama model needs downloading. 20 s limit. Needs the advanced-settings permission. Audited. |
| `POST /admin/memory/pull` | Downloads an Ollama model (`{ "model": "<name>[:tag]" }` or `namespace/name[:tag]`, from Ollama's default registry only: no host, no `..`) through Ollama's `/api/pull` at the embedding address, so a missing embedding model doesn't need a terminal (#102). Only the model the last `memory/check` reported missing can be pulled (`409` otherwise). `200` with `{ ok: true }` or `{ ok: false, error }`; one download at a time (`409`); 15-minute limit; a client that disconnects stops the download. Needs the advanced-settings permission. Audited. |
| `GET /admin/personas` | The personas and the active one (#105): `{ active, personas: [{ id, name, description, version }] }` (a persona that can't be loaded says so, without its path). Approving a `persona_create` approval writes `personas/<id>/` and adds it to this list without making it active (`409` `persona_exists` if the id or anything at that path exists; `409` `persona_referenced` if the config already uses the id as `personas.active`, in a persona route rule or in a workflow step, since it would then answer with no switch; either way the approval stays pending; `422` `no_personas_dir`). Switching to it is a separate `PATCH /admin/config/personas { active }`; a persona route rule that matches a chat still wins over the active persona. |
| `POST /admin/restart` | Restarts the gateway (#90) when a supervisor is declared (`MINDSTONE_AGENT_SUPERVISOR`: `launchd`, `managed`, `systemd` or `docker`) and confirmed by evidence: `202`, then a capped graceful shutdown and exit 75 (or, for `managed`, a helper that starts it again). `409` with the host command when none is declared or the evidence doesn't match, `409` while one is under way, `429` after 5 in 10 minutes. Audited. See `docs/operations/GATEWAY_RESTART.md`. |

**Advanced settings (default deny).** Without the advanced-settings permission, a patch may make only these changes, and only with values that pass their check:

- `routing`: `mode` (placeholder, mock, pi, pi-session), `defaultModel`, `defaultAgentId`, `mock.responsePrefix`;
- `agents.<id>`: `id`, `defaultModel`, `contextWindowTokens` (1,024 to 10 million), `profileId`;
- `memory`: `vectorStore`, the `recall` tuning numbers (bounded), `index` (`enabled`, `maxPromptTokens`), `invariants.maxPromptTokens`, and turning `invariants` on;
- `channels.<id>`, narrowing only: turning a channel off; removing senders from `allowedSenders` (removing the list lets nobody in); removing chats or guilds from `allowedChats` and `allowedGuilds` (the list can't be emptied or removed, since a missing list lets every chat in); turning `respondWithoutMention` off; the poll and reconnect intervals and `maxBodyChars` (bounded);
- `session.mode`, `contextManagement` (mode, bounded percentages and token counts, `minRecentMessages`, and its switches), the `gateway.http` endpoint switches, `personas.active` and `workflows.active` (plain ids), `knowledgebases.recall.enabled`, and the `onboarding` preferences and identity (enum fields only take their listed values; notes are free text).

Everything else needs the permission. That includes turning `memory.autoRecall` back on after it was turned off, and removing the key, since recall is on when the key is absent (#106). Turning it off is free. Recall reaches the owner's memory files, which a tenant run can still see until the recall-scope decision (#71); the owner's chat transcripts are kept from tenant runs. environment-variable references (`*Env`), URLs, paths and directories, the embedding provider, `memory.transcripts.includeNonOwner`, turning the always-on rules (`invariants`) off, Pi's built-in tools and switches, `workspace`, `packs`, `skills` and the rest of `gateway`. It also includes anything that lets someone new reach the agent: creating a channel (unless it is created with `enabled: false`), enabling one, adding a sender, chat or guild, a channel `tokenFile`, answering without a mention, changing the trigger prefix, and `ownerSenders`. Such a patch is a `403` listing each field.

The permission lasts one hour from when it is granted. Editable sections: agents, channels, contextManagement, gateway, knowledgebases, memory, observability, onboarding, packs, personas, routing, session, skills, workflows and workspace.
