import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { MindStoneConfig } from "./types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";

export type LoadedMindStoneConfig = {
  path: string;
  exists: boolean;
  config?: MindStoneConfig;
  error?: string;
};

export function defaultConfigPath(paths: MindStoneRuntimePaths = runtimePathsFromEnv()): string {
  return resolve(paths.dataDir, "config.json");
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  paths: MindStoneRuntimePaths = runtimePathsFromEnv(env),
): string {
  return resolve(env.MINDSTONE_AGENT_CONFIG ?? defaultConfigPath(paths));
}

export function loadMindStoneConfig(
  configPath = resolveConfigPath(),
): LoadedMindStoneConfig {
  const resolvedPath = resolve(configPath);
  if (!existsSync(resolvedPath)) {
    return { path: resolvedPath, exists: false };
  }

  try {
    const raw = readFileSync(resolvedPath, "utf-8");
    const config = JSON.parse(raw) as MindStoneConfig;
    return { path: resolvedPath, exists: true, config };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolvePathRelativeToConfig(path: string, configPath: string): string {
  return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}
