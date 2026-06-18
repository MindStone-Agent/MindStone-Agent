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

json_dry_output="$(./scripts/mindstone memory maintain --dry-run --dedupe-text --json)"
printf '%s\n' "${json_dry_output}"
JSON_INPUT="${json_dry_output}" node <<'NODE'
const data = JSON.parse(process.env.JSON_INPUT);
if (data.dryRun !== true) process.exit(1);
if (data.staleSourcesFound !== 1) process.exit(1);
if (data.duplicateTextChunksFound !== 1) process.exit(1);
NODE
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

cat >"${MEMORY_DIR}/duplicate_c.md" <<'MD'
---
name: duplicate_c
description: Integrated duplicate maintenance smoke C.
type: project
---

# Integrated duplicate maintenance smoke

The integrated backfill maintenance pass should deduplicate exact repeated chunks before optional embedding work runs.
MD

cat >"${MEMORY_DIR}/duplicate_d.md" <<'MD'
---
name: duplicate_d
description: Integrated duplicate maintenance smoke D.
type: project
---

# Integrated duplicate maintenance smoke

The integrated backfill maintenance pass should deduplicate exact repeated chunks before optional embedding work runs.
MD

cat >"${MEMORY_DIR}/integrated_stale.md" <<'MD'
---
name: integrated_stale
description: Integrated stale maintenance smoke memory.
type: project
---

# Integrated stale maintenance smoke

This source should be removed by mindstone memory backfill --maintain after the file is deleted.
MD

./scripts/mindstone memory backfill
rm "${MEMORY_DIR}/integrated_stale.md"

integrated_output="$(./scripts/mindstone memory backfill --maintain --dedupe-text)"
printf '%s\n' "${integrated_output}"
grep -q "Maintenance stale sources removed: 1" <<<"${integrated_output}"

integrated_json_output="$(./scripts/mindstone memory backfill --maintain --dedupe-text --json)"
printf '%s\n' "${integrated_json_output}"
JSON_INPUT="${integrated_json_output}" node <<'NODE'
const data = JSON.parse(process.env.JSON_INPUT);
if (!data.backfill || !data.maintenance) process.exit(1);
if (typeof data.backfill.chunksIndexed !== 'number') process.exit(1);
if (typeof data.maintenance.duplicateTextChunksRemoved !== 'number') process.exit(1);
NODE
grep -q "Maintenance duplicate text chunks removed: 2" <<<"${integrated_output}"
grep -q "Maintenance empty sources removed: 2" <<<"${integrated_output}"
grep -q "Maintenance optimized: true" <<<"${integrated_output}"
grep -q "Maintenance vacuumed: true" <<<"${integrated_output}"

cat >"${MEMORY_DIR}/preserve_embedding.md" <<'MD'
---
name: preserve_embedding
description: Embedding preservation smoke memory.
type: project
---

# Embedding preservation smoke

The SQLite backfill should preserve existing chunk embeddings when the chunk text has not changed.
MD

./scripts/mindstone memory backfill
node <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const path = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/vectors/memory.sqlite`;
const db = new DatabaseSync(path);
db.prepare('UPDATE memory_chunks SET embedding_json = ? WHERE chunk_id = ?').run('[0.1,0.2,0.3]', 'memory:memory/preserve_embedding.md#0');
const row = db.prepare('SELECT count(*) AS count FROM memory_chunks WHERE chunk_id = ? AND embedding_json IS NOT NULL').get('memory:memory/preserve_embedding.md#0');
db.close();
if (row.count !== 1) process.exit(1);
NODE

preserve_output="$(./scripts/mindstone memory backfill)"
printf '%s\n' "${preserve_output}"
grep -q "Chunk embeddings preserved: 1" <<<"${preserve_output}"
node <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const path = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/vectors/memory.sqlite`;
const db = new DatabaseSync(path);
const row = db.prepare('SELECT embedding_json FROM memory_chunks WHERE chunk_id = ?').get('memory:memory/preserve_embedding.md#0');
db.close();
if (row.embedding_json !== '[0.1,0.2,0.3]') process.exit(1);
NODE

status_output="$(./scripts/mindstone memory status)"
printf '%s\n' "${status_output}"
grep -q "Duplicate text chunks:" <<<"${status_output}"

status_json_output="$(./scripts/mindstone memory status --json)"
printf '%s\n' "${status_json_output}"
JSON_INPUT="${status_json_output}" node <<'NODE'
const data = JSON.parse(process.env.JSON_INPUT);
if (data.present !== true) process.exit(1);
if (typeof data.chunks !== 'number') process.exit(1);
if (typeof data.duplicateTextChunks !== 'number') process.exit(1);
NODE
grep -q "DB bytes:" <<<"${status_output}"
grep -q "Estimated free bytes:" <<<"${status_output}"

echo "SQLite memory maintenance smoke test passed."
