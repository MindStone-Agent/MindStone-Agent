# Context management: auto-compact vs sliding window

MindStone-Agent supports two context-management modes. They are related but not equivalent.

## `auto_compact`

`auto_compact` matches the Pi/Claude-style flow used by MS4PI:

1. Watch context utilization.
2. Before the compaction danger zone, prompt/write a checkpoint and rich handoff according to policy.
3. Native substrate compaction summarizes older context.
4. The next turn replays the handoff and resumes continuity.
5. Transcript archive/indexing preserves full texture outside the prompt window.

This mode is appropriate for substrates that do not expose or do not want live prompt-window pruning.

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

## `sliding_window`

`sliding_window` is MindStone proper's preferred long-running behavior.

The transcript is authoritative and append-only. Pruning removes older messages from the active prompt window only; it must not delete transcript entries.

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

MindStone-Agent defaults to `sliding_window` because it is rebuilding MindStone proper, not merely adapting Pi's compaction model.

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
- Gateway `/chat/send`, RPC `chat.send`, WebSocket RPC `chat.send`, and `/v1/chat/completions` build a prompt-window summary after persisting inbound messages.
- When pruning occurs, Gateway appends a transcript event with `event: context_window_pruned` and pruned/kept entry IDs.
- Smoke coverage:
  - `npm run smoke:context-window`
  - `npm run smoke:sliding-window`

Still pending:

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
