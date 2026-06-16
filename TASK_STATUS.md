# MindStone-Agent Task Status

**Last Updated:** 2026-06-16  
**Status:** Rebuilding foundation around upstream Pi base

## Quick Status

| Area | Status | Notes |
|------|--------|-------|
| Repo foundation | In progress | Upstream Pi base being installed under `vendor/pi` |
| Docs | Drafted | Refactor docs copied to `docs/refactor/` |
| Core/Gateway | Pending | Will be layered after Pi base import |
| Native install | Pending | Native install should support dev and service modes |
| Docker install | Pending | Docker should build from this repo with vendored Pi base |

## Current Sprint

### In Progress

- [ ] Import upstream Pi base.
- [ ] Document update strategy.
- [ ] Establish MindStone overlay package structure.

### Completed

- [x] Renamed project target to `MindStone-Agent`.
- [x] Preserved Slate scratch scaffold in sibling backup folder.
- [x] Copied PRD/design/architecture/implementation docs into `docs/refactor/`.

### Upcoming

- [ ] Create native install path.
- [ ] Create Docker build path.
- [ ] Start MindStone Core package on top of Pi base.
- [ ] Ask Cairn for review when available.
