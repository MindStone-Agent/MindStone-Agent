import type { MindStonePiResumeCapConfig } from "@mindstone-agent/core";

const DEFAULT_PI_SESSION_RESUME_CAP_MAX_ENTRIES = 800;
const MESSAGE_EMITTER_TYPES = new Set(["message", "custom_message", "branch_summary", "compaction"]);

export type PiSessionResumeCapOptions = {
  /** Max number of message-emitting entries to keep in Pi's in-memory branch. */
  maxEntries: number;
  /** Drop assistant turns with stopReason === "error" from Pi's in-memory branch. */
  dropErrorTurns: boolean;
};

export type PiSessionResumeCapStats = {
  action: "noop" | "capped" | "disabled" | "no-session-file" | "unsupported";
  branchLengthBefore: number;
  dropped: number;
  kept: number;
  messageEmittersKept: number;
  compactionExpanded: boolean;
  toolPairExpanded: boolean;
  errorTurnsDropped: number;
};

type PiSessionEntryLike = {
  type: string;
  id: string;
  parentId?: string | null;
  targetId?: string;
  label?: string;
  timestamp?: string;
  firstKeptEntryId?: string | null;
  message?: {
    role?: string;
    stopReason?: string;
    content?: unknown;
    toolCallId?: unknown;
  };
};

type PiSessionHeaderLike = { type: "session"; id?: string };
type PiSessionFileEntryLike = PiSessionHeaderLike | PiSessionEntryLike;

type PiSessionManagerLike = {
  getSessionFile?: () => string | undefined;
  getBranch?: () => PiSessionEntryLike[];
  fileEntries?: PiSessionFileEntryLike[];
  byId?: Map<string, PiSessionEntryLike>;
  labelsById?: Map<string, string>;
  labelTimestampsById?: Map<string, string>;
  leafId?: string | null;
};

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function resolvePiSessionResumeCapOptions(config?: MindStonePiResumeCapConfig): PiSessionResumeCapOptions | undefined {
  if (config?.enabled === false) return undefined;
  return {
    maxEntries: nonNegativeInt(config?.maxEntries) ?? DEFAULT_PI_SESSION_RESUME_CAP_MAX_ENTRIES,
    dropErrorTurns: config?.dropErrorTurns !== false,
  };
}

function disabledStats(action: PiSessionResumeCapStats["action"]): PiSessionResumeCapStats {
  return {
    action,
    branchLengthBefore: 0,
    dropped: 0,
    kept: 0,
    messageEmittersKept: 0,
    compactionExpanded: false,
    toolPairExpanded: false,
    errorTurnsDropped: 0,
  };
}

function isMessageEmitter(entry: PiSessionEntryLike): boolean {
  return MESSAGE_EMITTER_TYPES.has(entry.type);
}

function isAssistantErrorTurn(entry: PiSessionEntryLike): boolean {
  return entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason === "error";
}

function toolCallIdsOf(entry: PiSessionEntryLike): string[] {
  if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
  const ids: string[] = [];
  for (const block of entry.message.content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; id?: unknown };
    if (record.type === "toolCall" && typeof record.id === "string") ids.push(record.id);
  }
  return ids;
}

function toolResultCallId(entry: PiSessionEntryLike): string | null {
  if (entry.type !== "message" || entry.message?.role !== "toolResult") return null;
  return typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : null;
}

function findPriorToolCallIndex(branch: PiSessionEntryLike[], callId: string, beforeIdx: number): number {
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry && toolCallIdsOf(entry).includes(callId)) return i;
  }
  return -1;
}

function rebuildSessionManagerInternals(sessionManager: PiSessionManagerLike, keptEntries: PiSessionEntryLike[]): void {
  const header = sessionManager.fileEntries?.find((entry) => entry.type === "session");
  sessionManager.fileEntries = header ? [header, ...keptEntries] : keptEntries.slice();
  sessionManager.byId?.clear();
  sessionManager.labelsById?.clear();
  sessionManager.labelTimestampsById?.clear();
  sessionManager.leafId = null;

  for (const fileEntry of sessionManager.fileEntries) {
    if (fileEntry.type === "session" || typeof fileEntry.id !== "string") continue;
    const entry = fileEntry as PiSessionEntryLike;
    sessionManager.byId?.set(entry.id, entry);
    sessionManager.leafId = entry.id;
    if (entry.type === "label" && entry.targetId && sessionManager.byId?.has(entry.targetId)) {
      if (entry.label) {
        sessionManager.labelsById?.set(entry.targetId, entry.label);
        if (entry.timestamp) sessionManager.labelTimestampsById?.set(entry.targetId, entry.timestamp);
      } else {
        sessionManager.labelsById?.delete(entry.targetId);
        sessionManager.labelTimestampsById?.delete(entry.targetId);
      }
    }
  }
}

/**
 * Cap Pi SessionManager's in-memory branch after open without rewriting the JSONL session file.
 *
 * The canonical MindStone transcript and Pi session JSONL remain append-only. This mutates only
 * Pi's loaded SessionManager objects so long sessions do not fully replay into live context on
 * every resume.
 */
export function capPiSessionManagerOnLoad(sessionManager: unknown, options: PiSessionResumeCapOptions | undefined): PiSessionResumeCapStats {
  if (!options) return disabledStats("disabled");

  const sm = sessionManager as PiSessionManagerLike;
  if (typeof sm.getSessionFile !== "function" || typeof sm.getBranch !== "function" || !Array.isArray(sm.fileEntries) || !(sm.byId instanceof Map)) {
    return disabledStats("unsupported");
  }
  if (!sm.getSessionFile()) return disabledStats("no-session-file");

  const branch = sm.getBranch();
  const branchLengthBefore = branch.length;
  if (branchLengthBefore === 0) return { ...disabledStats("noop"), branchLengthBefore };

  let errorTurnsDropped = 0;
  let workBranch = branch;
  if (options.dropErrorTurns) {
    const droppedIds = new Set<string>();
    for (const entry of branch) {
      if (isAssistantErrorTurn(entry)) {
        droppedIds.add(entry.id);
        errorTurnsDropped += 1;
      }
    }
    if (droppedIds.size > 0) {
      for (const entry of branch) {
        if (entry.type === "label" && entry.targetId && droppedIds.has(entry.targetId)) droppedIds.add(entry.id);
      }
      const droppedIdToParent = new Map<string, string | null>();
      for (const entry of branch) {
        if (droppedIds.has(entry.id)) droppedIdToParent.set(entry.id, entry.parentId ?? null);
      }
      workBranch = branch.filter((entry) => !droppedIds.has(entry.id));
      const survivingIds = new Set(workBranch.map((entry) => entry.id));
      const resolveAncestor = (parentId: string | null): string | null => {
        let cursor: string | null = parentId;
        const visited = new Set<string>();
        while (cursor !== null && droppedIds.has(cursor)) {
          if (visited.has(cursor)) return null;
          visited.add(cursor);
          cursor = droppedIdToParent.get(cursor) ?? null;
        }
        return cursor !== null && survivingIds.has(cursor) ? cursor : null;
      };
      for (const entry of workBranch) {
        const original = entry.parentId ?? null;
        if (original !== null && droppedIds.has(original)) entry.parentId = resolveAncestor(original);
      }
    }
  }

  const messageEmittersTotal = workBranch.reduce((count, entry) => count + (isMessageEmitter(entry) ? 1 : 0), 0);
  if (options.maxEntries > 0 && messageEmittersTotal <= options.maxEntries && errorTurnsDropped === 0) {
    return {
      action: "noop",
      branchLengthBefore,
      dropped: 0,
      kept: branchLengthBefore,
      messageEmittersKept: messageEmittersTotal,
      compactionExpanded: false,
      toolPairExpanded: false,
      errorTurnsDropped: 0,
    };
  }

  let keepStartIdx: number;
  if (options.maxEntries === 0) {
    keepStartIdx = workBranch.length;
  } else if (messageEmittersTotal <= options.maxEntries) {
    keepStartIdx = 0;
  } else {
    keepStartIdx = workBranch.length;
    let emittersSeen = 0;
    for (let i = workBranch.length - 1; i >= 0; i--) {
      const entry = workBranch[i];
      if (entry && isMessageEmitter(entry)) {
        emittersSeen += 1;
        if (emittersSeen === options.maxEntries) {
          keepStartIdx = i;
          break;
        }
      }
    }
  }

  let compactionExpanded = false;
  let toolPairExpanded = false;
  let safety = workBranch.length;
  while (safety-- > 0) {
    let expanded = false;

    for (let i = keepStartIdx; i < workBranch.length; i++) {
      const entry = workBranch[i];
      if (!entry || entry.type !== "compaction") continue;
      const firstKeptId = entry.firstKeptEntryId;
      if (!firstKeptId) continue;
      const firstKeptIdx = workBranch.findIndex((candidate) => candidate.id === firstKeptId);
      if (firstKeptIdx === -1) {
        keepStartIdx = i + 1;
        compactionExpanded = true;
        expanded = true;
        break;
      }
      if (firstKeptIdx < keepStartIdx) {
        keepStartIdx = firstKeptIdx;
        compactionExpanded = true;
        expanded = true;
        break;
      }
    }

    if (!expanded && keepStartIdx < workBranch.length) {
      const leading = workBranch[keepStartIdx];
      const orphanCallId = leading ? toolResultCallId(leading) : null;
      if (orphanCallId !== null) {
        const callIdx = findPriorToolCallIndex(workBranch, orphanCallId, keepStartIdx);
        if (callIdx !== -1) {
          keepStartIdx = callIdx;
        } else {
          keepStartIdx += 1;
        }
        toolPairExpanded = true;
        expanded = true;
      }
    }

    if (!expanded) break;
  }

  const keptEntries = workBranch.slice(keepStartIdx);
  const dropped = branchLengthBefore - keptEntries.length;
  if (dropped === 0) {
    return {
      action: "noop",
      branchLengthBefore,
      dropped: 0,
      kept: keptEntries.length,
      messageEmittersKept: keptEntries.reduce((count, entry) => count + (isMessageEmitter(entry) ? 1 : 0), 0),
      compactionExpanded,
      toolPairExpanded,
      errorTurnsDropped: 0,
    };
  }

  if (keptEntries[0]) keptEntries[0].parentId = null;
  rebuildSessionManagerInternals(sm, keptEntries);

  return {
    action: "capped",
    branchLengthBefore,
    dropped,
    kept: keptEntries.length,
    messageEmittersKept: keptEntries.reduce((count, entry) => count + (isMessageEmitter(entry) ? 1 : 0), 0),
    compactionExpanded,
    toolPairExpanded,
    errorTurnsDropped,
  };
}
