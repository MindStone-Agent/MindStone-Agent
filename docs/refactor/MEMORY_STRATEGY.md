# MindStone-Agent memory strategy: thin context, ephemeral recall, durable files

**Status:** Draft implementation strategy with first-pass file and SQLite index implementation  
**Date:** 2026-06-17  
**Purpose:** Capture the memory strategy for MindStone-Agent and SCRI documentation, especially where it intentionally differs from older MindStone proper behavior.

## Thesis

Memory is not a feature. It is a layered continuity system.

No single layer has to pretend to be memory by itself. LOG is not memory. Vectors are not truth. Handoff is not identity. Memory docs are not the full experience. But together they make continuity much harder to break.

MindStone-Agent should combine the strongest parts of MS4* file memory with MindStone proper's journal/dream-cycle model.

The important distinction:

- **Structured memory files** preserve durable facts, decisions, preferences, cases, detections, references, and operating rules.
- **Narrative journals** preserve experiential continuity: what happened, how it unfolded, what it felt like, and what patterns emerged.
- **Raw transcripts** preserve the full record and texture for escalation.
- **Vectors** make all three searchable without keeping all of them in active context.

This matters especially for agents such as SOC, CTI, threat hunting, incident response, medical/health, business, and operations agents. They need structured factual records and experiential learning. Collapsing both into one giant memory document makes context huge and memory behavior less auditable.

## Design rule: keep standing context thin

Older MindStone behavior can allow context to become very large. MindStone-Agent should default to a thinner active context model.

Standing context should include only what must always be present:

- compact identity essentials
- compact user/collaboration essentials
- active session/task state
- memory/index pointers
- current safety/approval rules

Standing context should not include large memory bodies, long journals, or broad transcript summaries by default.

## Three operational memory layers

### 1. Standing context

Standing context is durable and always present, but deliberately small.

Examples:

```text
IDENTITY.md essentials
USER.md essentials
LOG.md recent tail / active task status
memory/MEMORY.md index pointers
current session brief
```

Standing context is not the place for every remembered fact.

### 2. Ephemeral auto-recall

Auto-recall is a fleeting thought, not a permanent mood.

On each routed turn:

1. Build a recall query from the current user prompt and routing/session context.
2. Search vectorized structured memory files, journals, and transcripts.
3. Select a small number of relevant hits within a strict token budget.
4. Deduplicate against active prompt/session content so the agent does not recall what is already in the live context.
5. Rank hits through SCRI salience: provider similarity, memory kind/source, critical/evergreen flags, hits/prevented counters, recency, and half-life.
6. Inject the selected hits into the current model call only.
7. Record a compact transcript event such as:

```json
{
  "event": "memory_recall_injected",
  "query": "...",
  "hitCount": 3,
  "diagnostics": {
    "rawHitCount": 12,
    "rankedHitCount": 5,
    "selectedHitCount": 3,
    "rejected": [{ "id": "...", "reason": "duplicate-active-context" }]
  },
  "hits": [
    { "id": "...", "title": "...", "score": 0.82, "providerScore": 0.73, "scri": { "reasons": ["critical", "evergreen"] } }
  ]
}
```

The recall block is not appended as standing context. The next turn recomputes recall from scratch.

This gives MindStone the benefit of memory resonance without letting prompt context grow unbounded.

#### Authority ranking parity (#36, cross-substrate spec: mindstone-for-claude-code#63)

Two invariants inside the SCRI ranking, shared with the MS4CC reference
implementation:

- **`hits` is an age-odometer, not a usefulness signal** — it accumulates with
  a memory's presence over time. It enters ranking only dampened
  (`log1p(hits)`) and capped low.
- **`prevented` is the human-confirmed authority signal** ("this memory stopped
  a real mistake"). It is weighted OUTSIDE the log (3:1, matching the
  reference), through a bounded saturation, so an old memory's odometer can
  never numerically swamp it and a runaway value can never dominate the score.
  Behavioral anchor: `prevented: 3` outranks `hits: 2400` at equal similarity;
  `prevented: 1` does not (both match the reference math).

The similarity gate (`minScore`) runs BEFORE ranking, so authority only
reorders already-relevant hits — it can never surface sub-threshold noise.

**Usage instrumentation (logging ≠ weighting):** every ranked candidate on the
auto path is appended, fail-open, to `<dataDir>/memory/recall-usage.jsonl`
using the shared cross-substrate schema (`ts, path, query, source_type,
source_path, chunk_id, similarity, rank, authority_factor, injected`). This
substrate has no manual memory-search surface today; if one lands it MUST log
`path: "manual"` with `authority_factor: null` and stay raw-ranked — manual /
on-demand recall is deliberately unweighted (2026-06-10 ruling).

### 3. On-demand recall

Auto-recall should often provide pointers, not exhaustive detail. When more detail is needed, the agent should deliberately read the source:

- structured memory file
- journal entry
- transcript segment
- case note
- detection record
- project document

This preserves a thin prompt while still allowing deep recovery.

## File layout

MindStone-Agent should use a private runtime memory layout like:

```text
.runtime/mindstone/
├── agents/default/
│   ├── IDENTITY.md
│   └── USER.md
├── LOG.md
├── memory/
│   ├── MEMORY.md
│   ├── project_*.md
│   ├── design_*.md
│   ├── feedback_*.md
│   ├── reference_*.md
│   ├── detection_*.md
│   ├── incident_*.md
│   └── case_*.md
├── journals/
│   └── YYYY-MM-DD.md
├── transcripts/
└── vectors/
    └── memory.sqlite
```

## Structured memory files

Structured memory files should follow MS4-style frontmatter so they can be ranked, audited, indexed, and migrated.

Recommended schema:

```yaml
---
name: project_example
description: One-line description.
type: feedback | project | reference | design | identity | user | log | index | roadmap | lineage | detection | incident | case | custom
tags: [auto-inferred, optional]
projects: [auto-inferred, optional]
hits: 0
prevented: 0
last_applied: null
created: YYYY-MM-DD
half_life_days: 30
critical: false
evergreen: false
---
```

Guidance:

- Put durable, reusable, auditable facts here.
- Keep individual files focused.
- Update `memory/MEMORY.md` as an index of memory files.
- Use frontmatter for salience and lifecycle metadata, not as decoration.
- Do not store secrets or raw credentials.

SOC/threat examples:

```text
memory/incident_acme_2026_06_auth_anomaly.md
memory/detection_suspicious_plc_write.md
memory/reference_adversary_ttp_ics_remote_access.md
memory/case_false_positive_shift_change_telemetry.md
```

## Journals

Journals are narrative, not just facts.

They should capture:

- what unfolded
- what was surprising
- how the agent reasoned
- what patterns emerged
- what mistakes or near misses happened
- what experiential texture would be lost in a bare summary

Journals are especially useful because embeddings over narrative preserve more associative texture than isolated bullet facts.

## LOG.md

`LOG.md` is not the memory store. It is the operational ledger.

Use it for:

- checkpoint/session entries
- decisions made
- work completed
- drift flagged
- memory docs proposed/written
- verification/lint status

This keeps auditability separate from structured fact memory and narrative journals.

## Vectorization

The vector index should include:

- structured memory files
- `memory/MEMORY.md` index
- journals
- LOG entries, when useful
- transcripts
- selected docs/wiki/project files

Default local store should be:

```text
SQLite + sqlite-vec
```

Rationale:

- SQLite is common, embedded, portable, and backup-friendly.
- sqlite-vec is a good local vector extension for single-user/self-hosted agents.
- pgvector can be added later for hosted/multi-user deployments.
- LanceDB should remain optional/compatibility-oriented, not the default.

## Prompt injection policy

Auto-recall injection must be ephemeral by default.

Recommended block shape:

```text
<ephemeral-recall>
Relevant memory for this turn. Use if helpful; ignore if not. Recall is probabilistic and may be stale.
...
</ephemeral-recall>
```

Implementation rules:

- inject only into the current model call
- keep strict token budgets
- deduplicate against standing context and active prompt entries
- log compact recall metadata in transcript events
- never promote recalled text into durable memory without checkpoint/approval flow

## Checkpoint/dream-cycle relationship

Checkpoint/dream-cycle should bridge active experience into durable files and vectors.

At checkpoint or dream-cycle boundary:

1. Decide whether durable structured memories are warranted.
2. Write/update approved structured memory files.
3. Update `memory/MEMORY.md` index.
4. Append `LOG.md` entry.
5. Write narrative journal when experiential texture matters.
6. Archive/vectorize transcript.
7. Verify vector chunks/search status.

This is stricter than older MindStone proper behavior and intentionally closer to MS4* discipline.

## Current implementation state

Implemented in MindStone-Agent first pass:

- runtime paths for `LOG.md`, `memory/`, `memory/MEMORY.md`, and `journals/`
- initializer creates `LOG.md`, memory index, and journal README
- config surface for file-backed memory discovery
- file-backed Markdown discovery for structured memory, journals, and LOG
- deterministic local recall provider can recall discovered files
- recall is injected ephemerally into current routed provider call
- transcript event records `memory_recall_injected`
- smoke test proves structured memory file recall reaches chat context
- dependency-free SQLite memory index at `.runtime/mindstone/vectors/memory.sqlite` using Node's built-in `node:sqlite`
- `mindstone memory backfill` indexes structured memory, journals, LOG, and existing JSONL transcript entries into SQLite chunks
- `mindstone memory status` reports SQLite memory index status
- Gateway autoRecall prefers the SQLite memory index when `memory.vectorStore` is `sqlite-vec`, with file/local fallback
- `mindstone doctor` reports SQLite memory index presence/chunk counts when `sqlite-vec` is configured
- OpenAI-compatible embedding provider interface
- Ollama-style local embedding config, e.g. `memory.embeddingProvider = "ollama:nomic-embed-text"`
- `EMBEDDER_BASE_URL`, `EMBEDDER_API_KEY`, `EMBEDDER_MODEL`, and related env hooks
- `mindstone memory backfill --embed` stores embeddings in SQLite chunk rows
- embedding-backed recall over embedded SQLite chunks using cosine similarity in JS
- `mindstone doctor` runs a sample embedding probe when an embedding provider is configured
- smoke test proves embedding recall can retrieve a chunk with no lexical overlap
- first-pass SCRI ranking layer with provider score, memory kind/source priority, critical/evergreen boosts, usage boosts, recency/half-life boosts, and score diagnostics
- active prompt/session dedup so recall does not re-inject content already present in the live context
- candidate dedup so repeated chunks/text do not consume recall budget
- smoke test proves active-context dedup and SCRI score diagnostics
- sqlite-vec capability probe with explicit fallback status
- `mindstone memory status` reports `sqlite-vec`, `js-cosine`, or `lexical` as the active vector backend
- `mindstone doctor` reports when sqlite-vec native search is unavailable and which fallback is in use

Still pending:

- package/install actual sqlite-vec extension-backed nearest-neighbor search
- deeper embedding setup UX for provider-specific endpoint/env validation
- tuning SCRI weights against real traces
- richer source-specific salience policies
- checkpoint/dream-cycle automation for journal writing and memory index updates
