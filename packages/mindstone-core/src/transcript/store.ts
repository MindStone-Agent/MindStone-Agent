import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type { AgentId } from "../identity/index.js";
import type { TranscriptEntry, TranscriptRole, TranscriptSource } from "./types.js";

export type TranscriptStoreOptions = {
  paths?: MindStoneRuntimePaths;
};

export type AppendTranscriptEntryInput = {
  sessionKey: string;
  agentId: AgentId;
  role: TranscriptRole;
  text?: string;
  content?: unknown;
  source?: TranscriptSource;
  runId?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
};

export type TranscriptSessionSummary = {
  sessionKey: string;
  path: string;
  entries: number;
  bytes: number;
  updatedAt?: string;
};

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf-8").toString("base64url");
}

function decodeSessionKey(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

export function transcriptPathForSession(
  sessionKey: string,
  options: TranscriptStoreOptions = {},
): string {
  const paths = options.paths ?? runtimePathsFromEnv();
  return join(paths.transcriptDir, `${encodeSessionKey(sessionKey)}.jsonl`);
}

export function createTranscriptEntry(input: AppendTranscriptEntryInput): TranscriptEntry {
  return {
    id: randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    role: input.role,
    text: input.text,
    content: input.content,
    source: input.source,
    runId: input.runId,
    parentId: input.parentId,
    metadata: input.metadata,
  };
}

export function appendTranscriptEntry(
  input: AppendTranscriptEntryInput,
  options: TranscriptStoreOptions = {},
): TranscriptEntry {
  const entry = createTranscriptEntry(input);
  const path = transcriptPathForSession(input.sessionKey, options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a", encoding: "utf-8" });
  return entry;
}

export function readTranscriptEntries(
  sessionKey: string,
  options: TranscriptStoreOptions & { limit?: number } = {},
): TranscriptEntry[] {
  const path = transcriptPathForSession(sessionKey, options);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const selected = options.limit && options.limit > 0 ? lines.slice(-options.limit) : lines;
  return selected.map((line) => JSON.parse(line) as TranscriptEntry);
}

export function listTranscriptSessions(options: TranscriptStoreOptions = {}): TranscriptSessionSummary[] {
  const paths = options.paths ?? runtimePathsFromEnv();
  if (!existsSync(paths.transcriptDir)) return [];
  return readdirSync(paths.transcriptDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const path = join(paths.transcriptDir, name);
      const stats = statSync(path);
      const content = readFileSync(path, "utf-8");
      const entries = content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
      return {
        sessionKey: decodeSessionKey(name.slice(0, -".jsonl".length)),
        path,
        entries,
        bytes: stats.size,
        updatedAt: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
