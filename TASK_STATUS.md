# MindStone-Agent Task Status

**Last Updated:** 2026-06-16  
**Status:** Rebuilding foundation around upstream Pi base

## Quick Status

| Area | Status | Notes |
|------|--------|-------|
| Repo foundation | In progress | Upstream Pi base installed under `vendor/pi` |
| Isolation | In progress | Native wrapper isolates Pi config/sessions under `.runtime/` |
| Docs | Drafted | Refactor and operations docs present |
| Core/Gateway | Scaffolded | Core contracts and minimal Gateway health server build successfully |
| Native install | Scaffolded | Builds vendored Pi base; daemon install not added yet |
| Docker install | Scaffolded | Dockerfile/Compose use project-specific volumes |

## Current Sprint

### In Progress

- [x] Validate vendored Pi build.
- [x] Validate isolated wrapper startup.
- [x] Establish MindStone overlay package structure.
- [ ] Add first real Pi adapter integration test.
- [ ] Expand Gateway beyond `/health`.

### Completed

- [x] Renamed project target to `MindStone-Agent`.
- [x] Preserved Slate scratch scaffold in sibling backup folder.
- [x] Copied PRD/design/architecture/implementation docs into `docs/refactor/`.
- [x] Imported upstream Pi base under `vendor/pi`.
- [x] Documented upstream Pi update strategy.
- [x] Added native isolation wrapper scripts.
- [x] Added Dockerfile and Compose scaffold.
- [x] Added MindStone Core/Gateway/Pi adapter package scaffold.
- [x] Verified `npm run build:mindstone`.
- [x] Verified Gateway `/health` on isolated port `19789`.

### Upcoming

- [ ] Create native install path.
- [ ] Create Docker build path.
- [ ] Start MindStone Core package on top of Pi base.
- [ ] Ask Cairn for review when available.
