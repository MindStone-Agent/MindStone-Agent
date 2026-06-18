#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-memory-maintenance-smoke.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"

cd "${PROJECT_ROOT}"

echo "== SQLite memory maintenance smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

MEMORY_DIR="${MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/memory"
mkdir -p "${MEMORY_DIR}"

cat >"${MEMORY_DIR}/duplicate_a.md" <<'MD'
---
name: duplicate_a
description: Duplicate maintenance smoke A.
type: project
---

# Duplicate maintenance smoke

The maintenance smoke should deduplicate exact repeated memory chunk text while preserving at least one canonical source.
MD

cat >"${MEMORY_DIR}/duplicate_b.md" <<'MD'
---
name: duplicate_b
description: Duplicate maintenance smoke B.
type: project
---

# Duplicate maintenance smoke

The maintenance smoke should deduplicate exact repeated memory chunk text while preserving at least one canonical source.
MD

cat >"${MEMORY_DIR}/stale.md" <<'MD'
---
name: stale_memory
description: Stale maintenance smoke memory.
type: project
---

# Stale maintenance smoke

This source should be removed from the SQLite memory index after the backing markdown file is deleted.
MD

./scripts/mindstone memory backfill
rm "${MEMORY_DIR}/stale.md"

dry_output="$(./scripts/mindstone memory maintain --dry-run --dedupe-text)"
printf '%s\n' "${dry_output}"
grep -q "Dry run: true" <<<"${dry_output}"
grep -q "Stale sources found: 1" <<<"${dry_output}"
grep -q "Stale sources removed: 0" <<<"${dry_output}"
grep -q "Duplicate text chunks found: 1" <<<"${dry_output}"
grep -q "Duplicate text chunks removed: 0" <<<"${dry_output}"

maintain_output="$(./scripts/mindstone memory maintain --dedupe-text)"
printf '%s\n' "${maintain_output}"
grep -q "Present: true" <<<"${maintain_output}"
grep -q "Dry run: false" <<<"${maintain_output}"
grep -q "Stale sources found: 1" <<<"${maintain_output}"
grep -q "Stale sources removed: 1" <<<"${maintain_output}"
grep -q "Duplicate text chunks found: 1" <<<"${maintain_output}"
grep -q "Duplicate text chunks removed: 1" <<<"${maintain_output}"
grep -q "Optimized: true" <<<"${maintain_output}"
grep -q "Vacuumed: true" <<<"${maintain_output}"

second_output="$(./scripts/mindstone memory maintain --dry-run --dedupe-text)"
printf '%s\n' "${second_output}"
grep -q "Stale sources found: 0" <<<"${second_output}"
grep -q "Duplicate text chunks found: 0" <<<"${second_output}"

status_output="$(./scripts/mindstone memory status)"
printf '%s\n' "${status_output}"
grep -q "DB bytes:" <<<"${status_output}"
grep -q "Estimated free bytes:" <<<"${status_output}"

echo "SQLite memory maintenance smoke test passed."
