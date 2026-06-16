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

```bash
docker compose up --build
```

Docker uses MindStone-Agent-specific named volumes. It must not mount host `~/.pi/agent`.

## Status

Initial foundation in progress. Not production-ready.
