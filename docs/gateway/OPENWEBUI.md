# OpenWebUI Setup Prep for MindStone-Agent Gateway

**Status:** Setup and validation prep, not validated against a live OpenWebUI instance yet  
**Scope:** MindStone-Agent's current OpenAI-compatible Gateway surface

MindStone-Agent exposes a small OpenAI-compatible HTTP surface that should be suitable for OpenWebUI-style clients once the Gateway is configured and validated:

```text
GET  /v1/models
POST /v1/chat/completions
```

The current implementation is transcript-aware and can route through the MindStone `AgentRunner` boundary, but it is not full OpenAI API parity. Treat this document as a setup checklist and validation plan until a real OpenWebUI instance has been tested.

## Current support boundary

Implemented today:

- `/v1/models`
- non-streaming `/v1/chat/completions`
- Gateway auth modes: `none`, `token`, `password`
- transcript persistence for compatible request messages
- routed responses when `routing.mode` is configured for `mock`, `pi`, or `pi-session`
- explicit `501 not_implemented` scaffold when no provider is configured
- canonical default session continuity through `agent:default:main`

Not validated or not implemented yet:

- live OpenWebUI end-to-end validation
- streaming/SSE chat completions
- full OpenAI API parity
- live authenticated Pi-backed model behavior through OpenWebUI
- OpenResponses use from OpenWebUI

If OpenWebUI requires streaming for a specific feature, expect that path to need follow-up implementation. Prefer non-streaming request settings where OpenWebUI allows them.

## Start from isolated runtime

Run everything from the MindStone-Agent repo:

```bash
cd /Users/clint/Projects/MindStone-Agent
```

MindStone-Agent must use the project-local runtime under `.runtime/`. Do not use global Pi state or global `~/.pi/agent` for this validation.

Check isolation paths:

```bash
./scripts/show-isolation.sh
```

Start the Gateway through the product CLI:

```bash
mindstone gateway start
```

Default URL:

```text
http://127.0.0.1:19789
```

OpenWebUI should normally be configured with the OpenAI-compatible base URL:

```text
http://127.0.0.1:19789/v1
```

## Gateway config requirements

OpenAI-compatible chat completions must be enabled:

```json
{
  "gateway": {
    "http": {
      "chatCompletions": { "enabled": true }
    }
  }
}
```

`/v1/models` is enabled when either chat completions or responses are enabled. For OpenWebUI prep, `chatCompletions.enabled` is the important flag.

Auth can be configured as `none`, `token`, or `password`. For a local OpenWebUI test, token mode is a good security/compatibility baseline:

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

Then start or restart the Gateway with:

```bash
export MINDSTONE_AGENT_GATEWAY_TOKEN='replace-with-a-local-test-token'
mindstone gateway restart
```

In OpenWebUI, use that token as the API key if it asks for one.

## Routing modes for validation

### Scaffold-only check

With `routing.mode` unset or `placeholder`, `/v1/chat/completions` persists input and returns an explicit scaffold `501 not_implemented`. This is useful to prove auth, URL, and transcript persistence, but it will not produce a usable assistant answer in OpenWebUI.

### Mock-routed check

For first OpenWebUI validation, use mock routing. It avoids live model/auth variables and should produce deterministic assistant text.

Example config fragment:

```json
{
  "routing": {
    "mode": "mock",
    "defaultModel": "mindstone/mock",
    "mock": {
      "responsePrefix": "openwebui-smoke"
    }
  },
  "gateway": {
    "http": {
      "chatCompletions": { "enabled": true }
    }
  }
}
```

OpenWebUI model selection should use a model returned by `/v1/models`. If no configured agents provide a default model, the Gateway returns:

```text
mindstone/default
```

If `routing.defaultModel` is set to `mindstone/mock`, prefer selecting or entering that model where OpenWebUI allows manual model IDs.

### Pi-session check

Only attempt `routing.mode = "pi-session"` after isolated Pi auth/model is intentionally configured and the live Pi smoke has passed:

```bash
MINDSTONE_PI_SESSION_LIVE=1 npm run smoke:pi-session-live
```

Do not use OpenWebUI as the first proof of live Pi-backed execution. Prove the session-backed runner directly first.

## Manual preflight curls

With the Gateway running and auth token set:

```bash
export BASE_URL='http://127.0.0.1:19789'
export TOKEN='replace-with-a-local-test-token'
```

Health does not require auth:

```bash
curl -sS "$BASE_URL/health"
```

Models requires auth and compatible HTTP enablement:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/v1/models"
```

Chat completions requires auth and `gateway.http.chatCompletions.enabled === true`:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  "$BASE_URL/v1/chat/completions" \
  -d '{
    "model": "mindstone/mock",
    "messages": [
      { "role": "user", "content": "Say hello from OpenWebUI prep." }
    ]
  }'
```

Expected outcomes:

| Routing mode | Expected response |
| --- | --- |
| placeholder/unset | `501 not_implemented`, with `mindstone.persisted: true` |
| mock | `200 chat.completion`, deterministic mock assistant text |
| pi-session without live auth/model | expected failure/scaffold behavior; do not treat as validation |
| pi-session with isolated live auth/model proven separately | candidate for later OpenWebUI validation |

## OpenWebUI connection fields

Use these values as the starting point when configuring an OpenAI-compatible provider in OpenWebUI:

| OpenWebUI field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:19789/v1` |
| API key | Gateway token when `gateway.auth.mode = "token"`; otherwise match configured auth mode if OpenWebUI supports it. |
| Model | `mindstone/mock`, `mindstone/default`, or another model returned by `/v1/models`. |
| Streaming | Disable if OpenWebUI exposes a streaming toggle. Streaming is not implemented yet. |

If OpenWebUI only supports Bearer-token style API keys, use Gateway token auth rather than password mode for the first validation.

## Transcript checks after a test

OpenWebUI traffic should append to the canonical transcript. After a request, inspect history through the Gateway:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/chat/history?limit=20"
```

For omitted-session OpenAI-compatible traffic, the default session should resolve to:

```text
agent:default:main
```

Source metadata should identify the compatible HTTP surface:

```text
substrate: openai
channel: openai-chat-completions
chatType: internal
```

## Validation checklist

Before calling OpenWebUI validated, capture these results:

- [ ] `GET /health` succeeds.
- [ ] `GET /v1/models` succeeds with configured auth.
- [ ] `POST /v1/chat/completions` succeeds with mock routing by curl.
- [ ] OpenWebUI can list or manually use the MindStone model ID.
- [ ] OpenWebUI can send one non-streaming message and receive a mock-routed answer.
- [ ] Gateway transcript history shows the OpenWebUI request under the canonical session.
- [ ] Status/doctor remain secret-safe and do not expose token values.

Do not mark live Pi-backed OpenWebUI as validated until both are true:

1. the direct isolated live Pi session smoke passes, and
2. OpenWebUI succeeds through the same `pi-session` route.

## Related docs

- [Gateway API Reference](API_REFERENCE.md)
- [Runtime Isolation Model](../operations/ISOLATION.md)
- [Pi Session Parity](../refactor/PI_SESSION_PARITY.md)
