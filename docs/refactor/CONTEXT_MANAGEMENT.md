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
5. SCRI/vector recall can reintroduce relevant older material without keeping the full transcript in prompt context.

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

## Implementation notes

- Percentages are always relative to the current model's configured maximum context window.
- `floorPercent` is the target utilization after pruning, not a transcript-retention setting.
- `minRecentMessages` is the hard recent-message floor for the active prompt window.
- `preserveTranscript` should remain true for normal MindStone behavior.
- Runtime routing must choose exactly one policy mode per agent/session unless an explicit migration flow changes it.
