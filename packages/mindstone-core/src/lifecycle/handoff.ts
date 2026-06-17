import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { estimatePromptTokens } from "../context/index.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";

export type CurrentHandoffStatus = {
  path: string;
  exists: boolean;
  bytes: number;
  updatedAt?: string;
  sha256?: string;
  tokenEstimate?: number;
};

export type CurrentHandoff = CurrentHandoffStatus & {
  exists: true;
  text: string;
  sha256: string;
  tokenEstimate: number;
};

export function currentHandoffPath(paths: MindStoneRuntimePaths = runtimePathsFromEnv()): string {
  return join(paths.transcriptDir, ".handoff.md");
}

export function getCurrentHandoffStatus(paths: MindStoneRuntimePaths = runtimePathsFromEnv()): CurrentHandoffStatus {
  const path = currentHandoffPath(paths);
  if (!existsSync(path)) return { path, exists: false, bytes: 0 };
  const stats = statSync(path);
  const text = readFileSync(path, "utf-8");
  return {
    path,
    exists: true,
    bytes: stats.size,
    updatedAt: stats.mtime.toISOString(),
    sha256: createHash("sha256").update(text).digest("hex"),
    tokenEstimate: estimatePromptTokens(text),
  };
}

export function readCurrentHandoff(paths: MindStoneRuntimePaths = runtimePathsFromEnv()): CurrentHandoff | undefined {
  const status = getCurrentHandoffStatus(paths);
  if (!status.exists || !status.sha256 || !status.tokenEstimate) return undefined;
  const text = readFileSync(status.path, "utf-8").trim();
  if (!text) return undefined;
  return {
    ...status,
    exists: true,
    text,
    sha256: status.sha256,
    tokenEstimate: status.tokenEstimate,
  };
}
