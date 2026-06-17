import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimatePromptTokens, type PromptWindowAutoCompactEvent } from "../context/index.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type { TranscriptEntry, TranscriptSource } from "../transcript/index.js";

export type AutoCompactHandoffInput = {
  sessionKey: string;
  agentId: string;
  event: PromptWindowAutoCompactEvent;
  entries: TranscriptEntry[];
  source?: TranscriptSource;
  runId?: string;
  timestamp?: string;
};

export type AutoCompactHandoffResult = {
  written: true;
  path: string;
  latestPath: string;
  logPath: string;
  entryCount: number;
  recentEntryCount: number;
};

function entryText(entry: TranscriptEntry): string {
  if (typeof entry.text === "string") return entry.text;
  if (entry.content !== undefined) return typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
  return "";
}

function selectRecentEntries(entries: TranscriptEntry[], keepRecentTokens: number): TranscriptEntry[] {
  const selected: TranscriptEntry[] = [];
  let tokens = 0;
  const budget = Math.max(1, keepRecentTokens);

  for (const entry of [...entries].reverse()) {
    const estimate = estimatePromptTokens(entryText(entry)) + 8;
    if (selected.length > 0 && tokens + estimate > budget) break;
    selected.push(entry);
    tokens += estimate;
  }

  return selected.reverse();
}

function formatEntry(entry: TranscriptEntry): string {
  const text = entryText(entry).trim();
  const clipped = text.length > 4_000 ? `${text.slice(0, 4_000)}\n...[truncated]` : text;
  const metadata = entry.metadata ? `\nmetadata: ${JSON.stringify(entry.metadata)}` : "";
  const source = entry.source ? `\nsource: ${JSON.stringify(entry.source)}` : "";
  return `### ${entry.timestamp} — ${entry.role}\n\nentry_id: ${entry.id}\nagent_id: ${entry.agentId}${source}${metadata}\n\n${clipped || "_(no text)_"}`;
}

function renderHandoff(input: AutoCompactHandoffInput, recentEntries: TranscriptEntry[], timestamp: string): string {
  return `# MindStone-Agent Auto-Compact Handoff\n\nGenerated: ${timestamp}\n\n## Trigger\n\n- Event: ${input.event.event}\n- Action: ${input.event.action}\n- Session: ${input.sessionKey}\n- Agent: ${input.agentId}\n- Run: ${input.runId ?? "n/a"}\n- Source: ${input.source ? JSON.stringify(input.source) : "n/a"}\n\n## Prompt window\n\n- Tokens: ${input.event.tokens}\n- Context window tokens: ${input.event.contextWindowTokens}\n- Utilization: ${input.event.utilizationPercent.toFixed(1)}%\n- Warning threshold: ${input.event.checkpointWarningPercent}%\n- Compact target: ${input.event.compactTargetPercent}%\n- Keep recent tokens: ${input.event.keepRecentTokens}\n- Reserve tokens: ${input.event.reserveTokens}\n- Emergency auto handoff: ${input.event.emergencyAutoHandoff ? "true" : "false"}\n\n## Continuity instructions\n\n- Treat this as an emergency local handoff generated because auto-compact reached the required threshold.\n- Preserve the full transcript as the source of truth. This handoff is a compact survival artifact, not a replacement for transcript memory.\n- Resume from the recent transcript tail below, then use memory/vector recall for older context as needed.\n- Do not claim substrate compaction was performed merely because this file exists.\n\n## Recent transcript tail\n\n${recentEntries.map(formatEntry).join("\n\n---\n\n")}\n`;
}

export function writeAutoCompactHandoff(
  input: AutoCompactHandoffInput,
  options: { paths?: MindStoneRuntimePaths } = {},
): AutoCompactHandoffResult {
  const paths = options.paths ?? runtimePathsFromEnv();
  const timestamp = input.timestamp ?? new Date().toISOString();
  const recentEntries = selectRecentEntries(input.entries, input.event.keepRecentTokens);
  const latestPath = join(paths.transcriptDir, ".handoff.md");
  const body = renderHandoff(input, recentEntries, timestamp);

  mkdirSync(paths.transcriptDir, { recursive: true });
  writeFileSync(latestPath, body, "utf-8");

  mkdirSync(dirname(paths.logPath), { recursive: true });
  writeFileSync(
    paths.logPath,
    `\n## ${timestamp} — Auto-compact checkpoint\n\n- Session: ${input.sessionKey}\n- Agent: ${input.agentId}\n- Event: ${input.event.event}\n- Action: ${input.event.action}\n- Utilization: ${input.event.utilizationPercent.toFixed(1)}%\n- Handoff: ${latestPath}\n\n`,
    { flag: "a", encoding: "utf-8" },
  );

  return {
    written: true,
    path: latestPath,
    latestPath,
    logPath: paths.logPath,
    entryCount: input.entries.length,
    recentEntryCount: recentEntries.length,
  };
}
