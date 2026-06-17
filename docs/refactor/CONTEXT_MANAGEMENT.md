# Context management: auto-compact vs sliding window

MindStone-Agent supports two context-management modes. They are related but not equivalent.

MindStone’s continuity premise is a single shared, append-only JSONL session/transcript across channels. `sliding_window` is the primary live-context policy. `auto_compact` is secondary/fallback behavior for substrates that require summarization under context pressure. In both modes, pruning and compaction affect only the live prompt/session context; they must never delete transcript entries, split continuity by channel, or promote a compaction summary/handoff into durable memory by itself.

MindStone-Agent uses the canonical single-session key shape `agent:<agentId>:<mainKey>`. The default is `agent:default:main`. The legacy early-rebuild alias `mindstone` canonicalizes to `agent:default:main` for compatibility.

## `auto_compact`

`auto_compact` matches the Pi/Claude-style flow used by MS4PI:

1. Watch context utilization.
2. Before the compaction danger zone, prompt/write a checkpoint and rich handoff according to policy.
3. Native substrate compaction summarizes older context.
4. The next turn replays the handoff and resumes continuity.
5. Transcript archive/indexing preserves full texture outside the prompt window.

This mode is appropriate for substrates that do not expose or do not want live prompt-window pruning. It is not MindStone-Agent's first-choice continuity model.

Config shape:

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

For native Pi compaction, `compactTargetPercent` maps to `reserveTokens` using:

```text
reserveTokens = contextWindow * (1 - compactTargetPercent / 100)
```

Current first-pass runtime behavior:

- When utilization reaches `checkpointWarningPercent`, Gateway records an `auto_compact_warning` transcript event.
- When utilization reaches `compactTargetPercent`, Gateway records an `auto_compact_required` transcript event.
- The event includes token counts, utilization, warning/target thresholds, `keepRecentTokens`, computed `reserveTokens`, and the recommended action.
- If `emergencyAutoHandoff` is enabled and the required threshold is reached, Gateway writes a local emergency handoff artifact and appends a compact checkpoint entry to runtime `LOG.md`.
- The current handoff is written to `transcripts/.handoff.md` and may be overwritten by the next compaction boundary; durable continuity belongs in LOG, transcripts, journals, and structured memory, not in archived handoff files.
- `/status`, `mindstone status`, and `mindstone doctor` report current handoff presence/path/size/hash where available.
- On a subsequent routed model call, Gateway replays the current handoff ephemerally into prompt context if that handoff hash has not already been replayed in the session, then records a `handoff_replayed` transcript event with `durable: false`.
- After `handoff_replayed`, Gateway records a `post_compact_maintenance` scaffold event with `archive`, `backfill`, and `dreamCycle` statuses; it does not automatically write durable memory or journals.
- Gateway records an explicit substrate compaction coordination result with `requested`, `available`, `substrate`, and `reason` fields.
- Pi exposes `AgentSession.compact(customInstructions?)`, but MindStone-Agent Gateway currently has no live in-process Pi `AgentSession` handle; the stateless Pi provider path therefore reports compaction as unavailable rather than pretending to request it.

## `sliding_window`

`sliding_window` is MindStone proper's preferred long-running behavior and first-choice continuity model.

The transcript is authoritative and append-only. Pruning removes older messages from the active prompt window only; it must not delete transcript entries or fork continuity by channel.

Sequence:

1. Track prompt context utilization against the current model's configured max context window.
2. When utilization reaches `ceilingPercent`, prune older prompt-window messages.
3. Prune down toward `floorPercent`, while retaining at least `minRecentMessages` recent messages.
4. Keep full transcript/session history on disk for recall, replay, audit, dream cycle, and WebChat history.
5. Record a `context_window_pruned` transcript event when pruning happens.
6. SCRI/vector recall can reintroduce relevant older material without keeping the full transcript in prompt context.

Config shape:

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

## Default for MindStone-Agent

MindStone-Agent defaults to `sliding_window` because it is rebuilding MindStone proper, not merely adapting Pi's compaction model. Compaction remains useful as a substrate fallback, but it is not the primary memory or continuity strategy.

MS4PI should keep the `auto_compact` checkpoint/handoff/compact behavior because it runs inside Pi and inherits Pi's episodic session constraints.

MindStone-Agent should also keep standing context thin. Large memory bodies, journals, and transcripts should usually enter the prompt through ephemeral per-turn auto-recall or deliberate on-demand reads, not permanent standing context. See `MEMORY_STRATEGY.md`.

## Current implementation status

Implemented:

- Core `buildPromptWindow()` selector.
- Prompt roles: `system`, `user`, `assistant`, and `tool` are eligible for prompt-window selection.
- Transcript `event` entries remain transcript-only by default.
- Sliding-window pruning by old prompt units/turn-ish groups.
- System entries and explicit protected entries stay pinned.
- At least `minRecentMessages` recent prompt entries are retained.
- Gateway `/chat/send`, HTTP RPC `chat.send`, WebSocket RPC `chat.send`, and `/v1/chat/completions` default to the canonical shared session `agent:default:main` when no explicit session key is supplied.
- Gateway `/chat/send`, RPC `chat.send`, WebSocket RPC `chat.send`, and `/v1/chat/completions` build a prompt-window summary after persisting inbound messages.
- When pruning occurs, Gateway appends a transcript event with `event: context_window_pruned` and pruned/kept entry IDs.
- In `auto_compact` mode, Gateway appends `auto_compact_warning` or `auto_compact_required` transcript events when configured thresholds are crossed.
- When `emergencyAutoHandoff` is enabled, `auto_compact_required` writes the current emergency handoff to `transcripts/.handoff.md`, then records that path in transcript metadata.
- Gateway replays the current handoff once per handoff hash/session as ephemeral prompt context and records `handoff_replayed`; it is not indexed or promoted to durable memory.
- Gateway records `post_compact_maintenance` after handoff replay with archive/backfill/dream-cycle policy diagnostics only.
- Smoke coverage:
  - `npm run smoke:context-window`
  - `npm run smoke:sliding-window`
  - `npm run smoke:unified-session`

Still pending:

- Auto-compact eventing, gated emergency handoff writing, status/doctor visibility, ephemeral handoff replay, post-compact maintenance scaffold eventing, and explicit compaction coordination-result reporting are implemented, but actual in-process Pi `AgentSession.compact()` invocation and post-compact archive/backfill/embed/dream-cycle execution policy are not yet wired. Any future compaction bridge must preserve the single authoritative transcript and remain secondary to sliding-window/SCRI continuity.
- Real model routing must consume `promptEntries` as the actual model input.
- Token estimation is currently conservative character-based estimation, not provider tokenizer-specific.
- Tool-call/tool-result semantics need richer grouping once real tool transcripts are flowing.
- SCRI recall integration should happen after pruning and before final prompt assembly.

## Implementation notes

- Percentages are always relative to the current model's configured maximum context window.
- `floorPercent` is the target utilization after pruning, not a transcript-retention setting.
- `minRecentMessages` is the hard recent-message floor for the active prompt window; if the recent floor alone exceeds the floor token target, the recent floor wins.
- `preserveTranscript` should remain true for normal MindStone behavior.
- Runtime routing must choose exactly one policy mode per agent/session unless an explicit migration flow changes it.
