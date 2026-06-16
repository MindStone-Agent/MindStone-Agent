# MindStone-Agent

MindStone-Agent is the rebuild track for MindStone proper on the current Pi base.

This repository vendors upstream Pi under `vendor/pi` and layers MindStone Core, Gateway, adapters, memory/SCRI, and channel integrations around it.

## Documentation

- [Refactor PRD](docs/refactor/PRD.md)
- [Refactor Design](docs/refactor/DESIGN.md)
- [Refactor Architecture](docs/refactor/ARCHITECTURE.md)
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
```

This builds the vendored Pi base and runs it with isolated project-local config/session directories.

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

Run the minimal Gateway health server with:

```bash
npm run start:gateway
curl http://127.0.0.1:19789/health
```

The default MindStone-Agent Gateway port is `19789` to avoid colliding with existing MindStone/Pi services that may use `18789`.

## Status

Initial foundation in progress. Not production-ready.

Verified so far:

- Native isolated Pi wrapper starts and reports `0.79.4`.
- Native MindStone overlay packages build.
- Native Gateway `/health` responds on `19789`.
- Docker image builds vendored Pi and MindStone overlay packages.
- Docker isolated Pi wrapper starts and reports `0.79.4`.
- Docker Gateway `/health` responds inside the container.
- Native and Docker Pi package registration discover `/mindstone-agent-status` through RPC `get_commands`.
