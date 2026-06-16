import { loadConfiguredIdentities } from "../identity/index.js";
import { loadMindStoneConfig, resolveConfigPath, type LoadedMindStoneConfig } from "../config/index.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";

export type MindStoneAgentStatus = {
  agentId: string;
  configuredId?: string;
  identityPath?: string;
  userPath?: string;
  identityExists: boolean;
  userExists: boolean;
  name?: string;
  error?: string;
};

export type MindStoneSystemStatus = {
  ok: boolean;
  paths: MindStoneRuntimePaths;
  config: {
    path: string;
    exists: boolean;
    error?: string;
    agentCount: number;
  };
  agents: MindStoneAgentStatus[];
};

function summarizeAgents(loadedConfig: LoadedMindStoneConfig): MindStoneAgentStatus[] {
  const agents = loadedConfig.config?.agents ?? {};
  return loadConfiguredIdentities(loadedConfig).map((loaded) => ({
    agentId: loaded.agentId,
    configuredId: agents[loaded.agentId]?.id,
    identityPath: loaded.identityPath,
    userPath: loaded.userPath,
    identityExists: loaded.identityExists,
    userExists: loaded.userExists,
    name: loaded.identity?.name,
    error: loaded.error,
  }));
}

export function getMindStoneSystemStatus(env: NodeJS.ProcessEnv = process.env): MindStoneSystemStatus {
  const paths = runtimePathsFromEnv(env);
  const loadedConfig = loadMindStoneConfig(resolveConfigPath(env, paths));
  const agents = loadedConfig.config ? summarizeAgents(loadedConfig) : [];
  return {
    ok: !loadedConfig.error && agents.every((agent) => !agent.error),
    paths,
    config: {
      path: loadedConfig.path,
      exists: loadedConfig.exists,
      error: loadedConfig.error,
      agentCount: loadedConfig.config?.agents ? Object.keys(loadedConfig.config.agents).length : 0,
    },
    agents,
  };
}
