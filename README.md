# MindStone-Agent

MindStone-Agent is the rebuild track for MindStone proper on the current Pi base.

This repository vendors upstream Pi under `vendor/pi` and layers MindStone Core, Gateway, adapters, memory/SCRI, and channel integrations around it.

## Documentation

- [Refactor PRD](docs/refactor/PRD.md)
- [Refactor Design](docs/refactor/DESIGN.md)
- [Refactor Architecture](docs/refactor/ARCHITECTURE.md)
- [Context Management](docs/refactor/CONTEXT_MANAGEMENT.md)
- [Implementation Plan](docs/refactor/IMPLEMENTATION_PLAN.md)
- [Upstream Pi Strategy](docs/upstream/PI_BASE_STRATEGY.md)
- [Runtime Isolation Model](docs/operations/ISOLATION.md)

## Runtime Isolation

Do not run bare `pi` for this project. Use:

```bash
./scripts/pi-agent
```

MindStone-Agent uses project-local runtime state under `.runtime/` and does not share `~/.pi/agent` with Slate/MS4PI or the user's global Pi install.

Check isolation paths with:

```bash
./scripts/show-isolation.sh
```

## Upstream Pi Base

Upstream Pi is tracked under:

```text
vendor/pi
```

Preferred update method is git subtree, documented in `docs/upstream/PI_BASE_STRATEGY.md`.

## Native Setup

```bash
./scripts/install-native.sh
npm run init:runtime
```

This builds the vendored Pi base and initializes isolated project-local config/session/data directories without overwriting existing runtime files.

## Docker Setup

Build and validate the isolated Pi runtime:

```bash
docker compose build
docker compose run --rm mindstone-agent-pi --version
```

Run the Gateway inside the container:

```bash
docker compose run --rm --entrypoint ./scripts/start-gateway.sh mindstone-agent-pi
```

Docker uses MindStone-Agent-specific named volumes. It must not mount host `~/.pi/agent`.

## MindStone Overlay Packages

MindStone-owned packages live outside the vendored Pi tree:

```text
packages/mindstone-core
packages/mindstone-gateway
packages/mindstone-pi-adapter
```

Build them with:

```bash
npm run build:mindstone
```

Run the minimal Gateway server with:

```bash
npm run start:gateway
curl http://127.0.0.1:19789/health
curl http://127.0.0.1:19789/status
```

The Gateway exposes the old MindStone/WebChat method-name bridge over both HTTP and WebSocket:

```text
POST /rpc
WS   /rpc
WS   /ws
```

Current RPC methods:

```text
chat.sessions
chat.history
chat.inject
chat.send
chat.abort
```

The default MindStone-Agent Gateway port is `19789` to avoid colliding with existing MindStone/Pi services that may use `18789`.

Gateway authentication is configured in the isolated MindStone config file. `/health` remains unauthenticated for liveness checks. Other endpoints enforce the configured auth mode:

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

Supported initial modes are `none`, `token`, and `password`. Tokens are accepted via `Authorization: Bearer <token>` or `X-MindStone-Token`. Password mode accepts HTTP Basic auth or `X-MindStone-Password`.

MindStone-Agent context management is configured independently from Gateway auth/API flags. MindStone proper defaults to sliding-window pruning, while Pi/Claude-style auto-compaction remains available as a selectable policy:

```json
{
  "contextManagement": {
    "mode": "sliding_window",
    "ceilingPercent": 92,
    "floorPercent": 70,
    "minRecentMessages": 24,
    "preserveTranscript": true
  }
}
```

Alternative auto-compact mode:

```json
{
  "contextManagement": {
    "mode": "auto_compact",
    "checkpointWarningPercent": 85,
    "compactTargetPercent": 92,
    "keepRecentTokens": 20000,
    "emergencyAutoHandoff": false
  }
}
```

The Gateway also has an initial OpenAI-compatible skeleton gated by config:

```json
{
  "gateway": {
    "http": {
      "chatCompletions": {
        "enabled": true
      }
    }
  }
}
```

Currently verified:

- `GET /v1/models` returns configured MindStone model metadata.
- `POST /v1/chat/completions` persists compatible input messages to the transcript store, records a routing-not-implemented event, and returns a structured `501 not_implemented` error until real MindStone routing is connected.

## Status

Initial foundation in progress. Not production-ready.

Verified so far:

- Runtime initializer creates missing isolated config/identity/user placeholders without overwriting existing files.
- Gateway auth enforcement supports verified `none`, `token`, and `password` modes.
- OpenAI-compatible Gateway skeleton exposes verified `/v1/models` and explicit-not-implemented `/v1/chat/completions` behavior.
- File-backed JSONL transcript storage under the isolated transcript directory supports append/read/list and reports aggregate counts in `/status`.
- Core context-management policy types support selectable `auto_compact` and `sliding_window` modes; runtime pruning/compaction execution is not wired yet.
- Gateway-native chat primitives are verified:
  - `GET /chat/sessions`
  - `GET /chat/history?sessionKey=...`
  - `POST /chat/inject`
  - `POST /chat/send` persists the user message and returns explicit `501 not_implemented` until routing exists
  - `POST /chat/abort` records an abort event through the Gateway run-manager abstraction and reports no active run until routing starts real runs
  - `POST /rpc` supports old-style Gateway method names: `chat.sessions`, `chat.history`, `chat.inject`, `chat.send`, and `chat.abort`
  - WebSocket RPC on `/rpc` and `/ws` uses the same method executor as HTTP `POST /rpc`
- Native isolated Pi wrapper starts and reports `0.79.4`.
- Native MindStone overlay packages build.
- Native Gateway `/health` responds on `19789`.
- Docker image builds vendored Pi and MindStone overlay packages.
- Docker isolated Pi wrapper starts and reports `0.79.4`.
- Docker Gateway `/health` and `/status` respond inside the container.
- Native and Docker Pi package registration discover `/mindstone-agent-status` through RPC `get_commands`.
