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
| `model` | Used for metadata and routed model selection. Defaults to `mindstone/default`. |
| `user` | Used as source sender ID when present. |
| `metadata.agentId` | Optional MindStone agent ID. Defaults to `default`. |
| `metadata.sessionKey` | Optional explicit MindStone session key. |

Only the new turn is stored: the trailing run of user messages (a message with no role counts as user). Clients such as the MindStone Console resend the whole conversation every turn; the gateway already has it, so earlier messages are not stored again, and a request that doesn't end with a user message is a `400 invalid_messages`. String content and text-like content array parts are extracted for transcript text.

Client `system` (and `developer`) messages follow the Console design (§4.2): with the forwarded role `user` they are ignored and logged once per session as a `client_system_prompt_ignored` event (length and hash, not the text); for an `admin` or a caller with no forwarded role they are stored once per session as a `system` entry.

A request with an `x-mindstone-conversation-id` header (the Console) gets its own session, `agent:console:console:<userId>:<conversationId>` (parts longer than 64 characters once URL-encoded are hashed), unless `metadata.sessionKey` names one. The key is per conversation, not per persona or config, so switching persona mid-conversation or changing `routing.defaultAgentId` keeps its history. The gateway replays the auto-compact handoff only into the session that wrote it (the CLI and TUI still replay the current handoff into any session). The memory backfill indexes every conversation into memory. Recall isn't scoped by agent or Console user yet, so on a multi-user install every user's conversations are recallable by all (#71).

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
| `model` | Used for metadata and routed model selection. Defaults to `mindstone/default`. |
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
| `GET /admin/status` | Onboarding state (`onboarded`, and per step: provider, persona, memory, connectors) plus system status. The Console shows onboarding while `onboarded` is false. |
| `GET /admin/config` | The effective config and its `etag` (also the `ETag` header; keyed with a per-process secret, so it can't be used to check guesses at hidden values, and it changes when the gateway restarts). Secrets are replaced by `{ "set": true\|false }`: the value under any key that contains token, secret, password, credential, cookie, jwt, sessionId, signature, apiKey, privateKey, accessKey or authorization, or ends in key, pass, auth, pat, pin, otp, pem or dsn (case and separators ignored), whatever its type; and every value in a header or environment map or list (`headers`, `extraHeaders`, `env`, `envVars`, `environmentVariables`, …). Credentials inside URLs are masked (userinfo, secret-looking query and fragment parameters, and token-like path segments such as webhook and bot URLs), and so are secret values in command-line style lists (`["--api-key", "…"]`). Inline credentials in plain strings are masked too: `NAME=value` pairs with a secret-sounding name (`DB_PASSWORD=…`, `access_token=…`), JSON `"client_secret": "…"` inside a string, header lines (`Authorization: …`, `X-API-Key: …`), Bearer/Basic credentials, `-u user:pass`, URLs anywhere in the string, and `{ name, value }` header lists (the names stay). Free-text notes (keys ending in Notes, Context or Direction, such as the onboarding preferences) are the owner's prose and are shown as written. Booleans, token budgets such as `contextWindowTokens`, session keys, public keys and references to where a secret lives (`tokenEnv`, `tokenFile`, `tokenUrl`, …) are shown. |
| `PATCH /admin/config/<section>` | JSON merge patch (RFC 7396) of one section: `null` removes a key. Anything sent back exactly as GET returned it keeps the stored value: a masked secret, a URL with its credentials masked, a masked header list. A new plain value for a secret is a `400`: store it with `POST /admin/secrets/<name>` and reference it with `tokenFile`. Replacing a value that has hidden parts (a URL with a password, a header list) needs the advanced-settings permission (`403`), even when the new value turns out to be the same, so a patch can't confirm a guess. Keys that are empty or contain `.`, prototype keys, and patches nested more than 32 deep are a `400`. The config and the permission are read when the body has arrived, one write at a time. `If-Match` (strong or weak, one etag or a list) refuses the write with `412` if the config changed since it was read. The result is validated (`422`), checked against the advanced-settings permission (`403`) and written atomically, keeping the file's mode. The response lists `changed` paths, `restartRequired` (connectors and gateway host and port need a restart; everything else applies on the next message) and the new `etag`. |
| `POST /admin/secrets/<name>` | `{ "value": "…" }` is stored in `<dataDir>/secrets/<name>` (0600, directory 0700) and never echoed. Reference it from config as `tokenFile: "secrets/<name>"`. Replacing an existing secret, or writing any file a connector is configured to read (any `…File` setting on a channel, resolved as the connector resolves it, symlinks included), needs the advanced-settings permission (`403`). A new secret is created exclusively; if a protected file that didn't exist (a connector's token file, or one of the gateway's own credential files) exists afterwards, the new name reached it through the filesystem's own folding (APFS treats `ß` as `ss` and `ſ` as `s`) or a chain of links, so it is removed and refused. The files holding the gateway's own credentials can't be written under any name that reaches them, with or without the permission (`422`: file identity, names compared without case, symlinks followed, and the check above). A secret name that is a link (made on the host) is never replaced (`422`). A write that fails leaves no temporary copy of the value. |
| `GET /admin/permissions` | The advanced-settings permission. `expiresAt` is the expiry that applies: at most one hour after `grantedAt`, whatever the stored file says. |
| `GET /admin/models` | What onboarding can offer: the provider `presets` (Ollama local and Cloud, LM Studio, an OpenAI-compatible server, each with `needsKey`), the providers already `registered` in Pi's isolated `models.json` (URL credentials masked; auth shown only as `none`, `env: NAME` or `stored key`), and Pi's own `providers` and `models`. |
| `POST /admin/providers/<preset>` | Registers a preset in the isolated `models.json`. Body: at most one of `secret` (the name of a secret stored with `POST /admin/secrets`, copied into `models.json` at 0600, escaped so Pi reads it as a literal: a `$` or a leading `!` is never expanded or run) or `env` (a variable whose name ends in `_API_KEY`, stored as a `$VAR` reference); optional `models` (ids; without them the gateway lists `<baseUrl>/models` with the key, reading at most 1 MiB and keeping only plain ids). Where a key can go: a hosted preset's address (Ollama Cloud) is fixed; a local preset's `baseUrl` may change, but only to loopback, a private network or `.local`, over http(s) with no credentials, query or fragment. A key is never accepted in the body and never echoed. Refused: the gateway's own credentials, by variable name (the defaults included) or by value (the service token or password, or the admin credential) (`422`); a connector's token file (`422`); a secret that is a symlink (`400`); re-registering a provider that has headers or overrides set on the host (`409`). Keyless local presets get their placeholder key. Needs the advanced-settings permission (`403`). Every refusal and every failed listing (the key was sent) is audited, with the key's source, never its value; listing errors say nothing from the server's reply. OAuth subscription providers are set up in the TUI (`mindstone onboard`). |
| `POST /admin/permissions/advanced` | `{ "enabled": true, "confirm": "enable advanced settings" }` grants it for one hour (it runs from `grantedAt` for at most an hour, and a `grantedAt` in the future isn't honoured); `{ "enabled": false }` revokes it early. It lives in `<dataDir>/admin/permissions.json`, not in config, so a config patch can't grant it. |

**Advanced settings (default deny).** Without the advanced-settings permission, a patch may make only these changes, and only with values that pass their check:

- `routing`: `mode` (placeholder, mock, pi, pi-session), `defaultModel`, `defaultAgentId`, `mock.responsePrefix`;
- `agents.<id>`: `id`, `defaultModel`, `contextWindowTokens` (1,024 to 10 million), `profileId`;
- `memory`: `vectorStore`, the `recall` tuning numbers (bounded), `index` (`enabled`, `maxPromptTokens`), `invariants.maxPromptTokens`, and turning `invariants` on;
- `channels.<id>`, narrowing only: turning a channel off; removing senders from `allowedSenders` (removing the list lets nobody in); removing chats or guilds from `allowedChats` and `allowedGuilds` (the list can't be emptied or removed, since a missing list lets every chat in); turning `respondWithoutMention` off; the poll and reconnect intervals and `maxBodyChars` (bounded);
- `session.mode`, `contextManagement` (mode, bounded percentages and token counts, `minRecentMessages`, and its switches), the `gateway.http` endpoint switches, `personas.active` and `workflows.active` (plain ids), `knowledgebases.recall.enabled`, and the `onboarding` preferences and identity (enum fields only take their listed values; notes are free text).

Everything else needs the permission. That includes turning `memory.autoRecall` on (until the recall-scope decision, #71; turning it off, or removing the key, is free), environment-variable references (`*Env`), URLs, paths and directories, the embedding provider, `memory.transcripts.includeNonOwner`, turning the always-on rules (`invariants`) off, Pi's built-in tools and switches, `workspace`, `packs`, `skills` and the rest of `gateway`. It also includes anything that lets someone new reach the agent: creating a channel (unless it is created with `enabled: false`), enabling one, adding a sender, chat or guild, a channel `tokenFile`, answering without a mention, changing the trigger prefix, and `ownerSenders`. Such a patch is a `403` listing each field.

The permission lasts one hour from when it is granted. Editable sections: agents, channels, contextManagement, gateway, knowledgebases, memory, observability, onboarding, packs, personas, routing, session, skills, workflows and workspace.
