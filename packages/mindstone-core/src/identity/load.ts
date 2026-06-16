import { existsSync, readFileSync } from "node:fs";
import type { MindStoneAgentConfig, LoadedMindStoneConfig } from "../config/index.js";
import { resolvePathRelativeToConfig } from "../config/load.js";
import type { MindStoneIdentity } from "./types.js";

export type LoadedMindStoneIdentity = {
  agentId: string;
  identityPath?: string;
  userPath?: string;
  identityExists: boolean;
  userExists: boolean;
  identity?: MindStoneIdentity;
  error?: string;
};

function extractMarkdownTitle(markdown: string): string | undefined {
  const title = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));
  return title?.replace(/^#\s+/, "").trim() || undefined;
}

export function loadMindStoneIdentity(
  agentId: string,
  agentConfig: MindStoneAgentConfig,
  configPath: string,
): LoadedMindStoneIdentity {
  const identityPath = agentConfig.identityPath
    ? resolvePathRelativeToConfig(agentConfig.identityPath, configPath)
    : undefined;
  const userPath = agentConfig.userPath ? resolvePathRelativeToConfig(agentConfig.userPath, configPath) : undefined;
  const identityExists = identityPath ? existsSync(identityPath) : false;
  const userExists = userPath ? existsSync(userPath) : false;

  if (!identityPath || !identityExists) {
    return { agentId, identityPath, userPath, identityExists, userExists };
  }

  try {
    const identityMarkdown = readFileSync(identityPath, "utf-8");
    const userMarkdown = userPath && userExists ? readFileSync(userPath, "utf-8") : undefined;
    return {
      agentId,
      identityPath,
      userPath,
      identityExists,
      userExists,
      identity: {
        agentId,
        name: extractMarkdownTitle(identityMarkdown) ?? agentConfig.id,
        identityMarkdown,
        userMarkdown,
      },
    };
  } catch (error) {
    return {
      agentId,
      identityPath,
      userPath,
      identityExists,
      userExists,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadConfiguredIdentities(loadedConfig: LoadedMindStoneConfig): LoadedMindStoneIdentity[] {
  const agents = loadedConfig.config?.agents ?? {};
  return Object.entries(agents).map(([agentId, agentConfig]) =>
    loadMindStoneIdentity(agentId, agentConfig, loadedConfig.path),
  );
}
