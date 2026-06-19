# MindStone-Agent Gateway API Reference

**Status:** MVP reference for the current Gateway surface  
**Scope:** Non-streaming HTTP/RPC/WebSocket APIs currently implemented in MindStone-Agent

This document describes the Gateway surface as implemented today. It is intentionally conservative: it documents scaffold, mock-routed, and Pi-routed behavior separately, and does not claim live Pi model success, OpenResponses streaming, or full OpenAI/OpenResponses API parity.

## Runtime and base URL

Start the isolated Gateway from the MindStone-Agent repo:

```bash
npm run start:gateway
```

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

Input message roles map to transcript roles. `system`, `assistant`, and `tool` are preserved; other roles default to `user`. String content and text-like content array parts are extracted for transcript text.

Behavior:

- Persists compatible input messages to the canonical transcript.
- In routed modes, returns a non-streaming `chat.completion` response and includes a `mindstone` metadata object.
- Without a configured provider, returns `501 not_implemented` with `mindstone.persisted: true` and transcript entries.
- Streaming is not implemented.

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
