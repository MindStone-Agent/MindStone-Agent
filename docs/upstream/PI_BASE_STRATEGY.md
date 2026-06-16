# Upstream Pi Base Strategy

**Project:** MindStone-Agent  
**Date:** 2026-06-16  
**Status:** Initial strategy

## Decision

MindStone-Agent should track upstream Pi as a vendored base under `vendor/pi`, while keeping MindStone-specific code outside the upstream tree wherever possible.

Use **git subtree** rather than a submodule for the initial phase.

## Why subtree

- Clones are self-contained; no extra submodule initialization step.
- Docker builds can use the vendored source without network access to a nested repo.
- Upstream updates are explicit and reviewable.
- MindStone can carry local integration patches if absolutely necessary.
- If sustained Pi internals changes become necessary, we can move to a proper fork later.

## Upstream

```text
https://github.com/earendil-works/pi
```

Current local installed package evidence:

```text
@earendil-works/pi-coding-agent 0.76.0
repository: git+https://github.com/earendil-works/pi-mono.git
published package now points to earendil-works/pi
```

## Layout

```text
MindStone-Agent/
  vendor/pi/                # upstream Pi subtree
  packages/                 # MindStone-owned packages
  docs/refactor/            # PRD/design/architecture/implementation plan
  docker/                   # Docker assets
  scripts/                  # native install/dev scripts
```

## Update command

After the subtree is added, update from upstream with:

```bash
git subtree pull --prefix vendor/pi https://github.com/earendil-works/pi main --squash
```

Review the resulting diff before merging any MindStone overlay changes.

## Fork trigger

Create a MindStone-owned fork only if one of these becomes true:

1. We need recurring patches inside Pi internals.
2. Upstream update cadence threatens MindStone stability.
3. MindStone needs a modified Pi release artifact.
4. We need CI against a pinned Pi branch with backported fixes.

Until then, keep MindStone code outside `vendor/pi` and treat upstream Pi as a base dependency.
