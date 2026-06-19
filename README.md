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
- [Gateway API Reference](docs/gateway/API_REFERENCE.md)
- [OpenWebUI Setup Prep](docs/gateway/OPENWEBUI.md)

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

### Curl installer

For a normal user install from the public repository:

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install.sh | bash
mindstone onboard
```

Custom install directory:

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install.sh | \
  bash -s -- --dir "$HOME/Projects/MindStone-Agent"
```

By default the installer clones/updates the repo under `~/.mindstone-agent/MindStone-Agent`, runs `npm install`, builds the vendored Pi base, initializes isolated runtime directories, and runs `npm link` so `mindstone` is on PATH. Use `--no-link` to skip global linking and run `./node_modules/.bin/mindstone` from the checkout instead.

### Clone-from-source install

```bash
git clone https://github.com/MindStone-Agent/MindStone-Agent.git
cd MindStone-Agent
npm install
npm run install:native
npm run link:cli
mindstone onboard
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
packages/mindstone-cli
```

Build them with:

```bash
npm run build:mindstone
```

Configure, onboard, or connect model accounts through the `mindstone` CLI:

```bash
mindstone status
mindstone config
mindstone onboard
mindstone auth login openai-codex
```

For source checkouts, link the CLI intentionally after install/build:

```bash
npm run link:cli
```

Without global linking, the workspace package exposes the same bin under `node_modules/.bin` after `npm install`:

```bash
./node_modules/.bin/mindstone status
```

`config` edits selected runtime config sections. `onboard` is the first-run flow: risk acknowledgement, runtime isolation display, QuickStart vs Manual setup, optional model/account connection, and non-overwriting identity/user scaffold creation. QuickStart applies safe local defaults while still offering model setup. Manual walks every core config section. When a real model is selected, the CLI discovers isolated Pi providers, shows provider auth status/method, connects subscription/OAuth accounts through MindStone's embedded auth flow, then presents models only for the selected provider as arrow-key choices.

The package bin bootstraps the same project-local isolation environment as the old script wrappers. Override the config path for safe testing with `MINDSTONE_AGENT_CONFIG=/path/to/config.test.json`.

Manage the local Gateway through the public CLI:

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

Then check health/status:

```bash
curl http://127.0.0.1:19789/health
curl http://127.0.0.1:19789/status
```

The legacy development path still exists as `npm run start:gateway`, but MVP/product workflows should use `mindstone gateway ...`.

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

The Gateway also serves a thin built-in MindStone WebChat shell:

```text
GET /webchat
```

The page is a native MindStone surface over the Gateway WebChat REST endpoints, not OpenWebUI. Leave the session key blank in the UI to use the canonical shared default:

```text
agent:default:main
```

When routing is configured, WebChat sends through the same provider path as other Gateway surfaces and appends assistant responses to the canonical transcript. Routed calls now inject the configured agent `IDENTITY.md` and `USER.md` as standing system context before transcript/SCRI context. `npm run smoke:webchat-ui` validates the built-in shell plus a mock-routed assistant response with identity context and `gateway-rest` / `webchat` / `internal` source metadata.

The static UI shell is served without auth so a browser can load it directly; configured Gateway auth still applies to transcript/status/chat API calls from the page. `mindstone status` reports the WebChat URL, default session key, and source metadata, and `mindstone doctor` checks WebChat shell/session readiness.

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

Routing is selectable. The safe default is `placeholder`, which persists transcript entries and returns explicit not-implemented responses. `mock` enables deterministic local routing for tests. `pi` uses the isolated vendored Pi model registry/provider stack when isolated auth/model config is present. The native CLI can discover isolated Pi provider/model metadata, guide provider-first selection, and write the selected model into `routing.defaultModel`.

```json
{
  "routing": {
    "mode": "placeholder",
    "defaultAgentId": "default",
    "defaultModel": "mindstone/default"
  }
}
```

Mock router smoke config:

```json
{
  "routing": {
    "mode": "mock",
    "defaultModel": "mindstone/mock",
    "mock": {
      "responsePrefix": "router-smoke"
    }
  }
}
```

Pi-backed router config should point at isolated Pi state, not global `~/.pi/agent`:

```json
{
  "routing": {
    "mode": "pi",
    "defaultModel": "openai-codex/gpt-5.5",
    "pi": {
      "agentDir": ".runtime/pi-agent"
    }
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
- Core context-management supports selectable `auto_compact` and `sliding_window` modes.
- Sliding-window prompt selection is implemented and smoke-tested; Gateway send/completions paths record `context_window_pruned` transcript events when pruning occurs.
- Router/provider abstraction is implemented with safe `placeholder`, test `mock`, and isolated Pi-backed provider modes. Mock routing is smoke-tested end-to-end; Pi provider config discovery is smoke-tested without live credential use.
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
