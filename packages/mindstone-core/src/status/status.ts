import { loadConfiguredIdentities } from "../identity/index.js";
import { loadMindStoneConfig, resolveConfigPath, type LoadedMindStoneConfig } from "../config/index.js";
import { resolveContextManagementPolicy, type ResolvedContextManagementPolicy } from "../context/index.js";
import type { MindStoneRoutingConfig } from "../config/index.js";
import { getCurrentHandoffStatus, type CurrentHandoffStatus } from "../lifecycle/index.js";
import { getSqliteMemoryIndexStats, type SqliteMemoryIndexStats } from "../memory/index.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import { listTranscriptSessions } from "../transcript/index.js";
import { getMindStoneGatewayStatus, type MindStoneGatewayStatus } from "./gateway.js";
import { getPiSessionSafetyStatus, type PiSessionSafetyStatus } from "./pi-session-safety.js";
import { getMindStoneWebChatStatus, type MindStoneWebChatStatus } from "./webchat.js";

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
  transcripts: {
    dir: string;
    sessionCount: number;
    entryCount: number;
  };
  handoff: CurrentHandoffStatus;
  gateway: MindStoneGatewayStatus;
  webchat: MindStoneWebChatStatus;
  memory: {
    sqlite: SqliteMemoryIndexStats;
  };
  contextManagement: ResolvedContextManagementPolicy;
  routing: {
    mode: Required<MindStoneRoutingConfig>["mode"];
    defaultAgentId?: string;
    defaultModel?: string;
  };
  piSessionSafety: PiSessionSafetyStatus;
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
  const transcriptSessions = listTranscriptSessions({ paths });
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
    transcripts: {
      dir: paths.transcriptDir,
      sessionCount: transcriptSessions.length,
      entryCount: transcriptSessions.reduce((total, session) => total + session.entries, 0),
    },
    handoff: getCurrentHandoffStatus(paths),
    gateway: getMindStoneGatewayStatus(loadedConfig.config),
    webchat: getMindStoneWebChatStatus(loadedConfig.config),
    memory: {
      sqlite: getSqliteMemoryIndexStats(paths),
    },
    contextManagement: resolveContextManagementPolicy(loadedConfig.config?.contextManagement),
    routing: {
      mode: loadedConfig.config?.routing?.mode ?? "placeholder",
      defaultAgentId: loadedConfig.config?.routing?.defaultAgentId,
      defaultModel: loadedConfig.config?.routing?.defaultModel,
    },
    piSessionSafety: getPiSessionSafetyStatus({
      config: loadedConfig.config,
      piAgentDir: paths.piAgentDir,
      piSessionDir: paths.piSessionDir,
    }),
  };
}
