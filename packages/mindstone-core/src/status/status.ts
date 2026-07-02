import { loadConfiguredIdentities } from "../identity/index.js";
import { loadMindStoneConfig, resolveConfigPath, type LoadedMindStoneConfig } from "../config/index.js";
import { resolveContextManagementPolicy, type ResolvedContextManagementPolicy } from "../context/index.js";
import type { MindStoneRoutingConfig } from "../config/index.js";
import { getCurrentHandoffStatus, type CurrentHandoffStatus } from "../lifecycle/index.js";
import { getSqliteMemoryIndexStats, type SqliteMemoryIndexStats } from "../memory/index.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import { listTranscriptSessions } from "../transcript/index.js";
import { discoverMindStonePersonas, personasDirFromConfig, resolveMindStonePersona } from "../persona/index.js";
import { discoverMindStoneSkills, skillsDirFromConfig } from "../skills/index.js";
import { discoverMindStoneKnowledgebases, knowledgebasesDirFromConfig } from "../knowledgebase/index.js";
import { getConnectorVisibilityStatuses, type ConnectorVisibilityStatus } from "../channels/index.js";
import { resolveConfiguredSessionKey } from "../routing/session.js";
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
  personas: {
    dir: string;
    count: number;
    brokenCount: number;
    configuredActive?: string;
    routeRules: number;
    resolvedForDefaultSession?: { personaId: string; reason: string };
  };
  skills: {
    dir: string;
    builtinCount: number;
    installedCount: number;
    draftCount: number;
    brokenCount: number;
  };
  knowledgebases: {
    dir: string;
    count: number;
    indexedCount: number;
    brokenCount: number;
    entryCount: number;
  };
  connectors: ConnectorVisibilityStatus[];
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
    personas: (() => {
      const personasDir = personasDirFromConfig(loadedConfig.config, paths);
      const personas = discoverMindStonePersonas(personasDir);
      return {
        dir: personasDir,
        count: personas.length,
        brokenCount: personas.filter((persona) => persona.error).length,
        configuredActive: loadedConfig.config?.personas?.active,
        routeRules: loadedConfig.config?.personas?.routes?.length ?? 0,
        resolvedForDefaultSession: resolveMindStonePersona({
          config: loadedConfig.config,
          sessionKey: resolveConfiguredSessionKey(loadedConfig.config, { agentId: loadedConfig.config?.routing?.defaultAgentId ?? "default" }),
        }),
      };
    })(),
    skills: (() => {
      const skillsDir = skillsDirFromConfig(loadedConfig.config, paths);
      const skills = discoverMindStoneSkills(skillsDir);
      return {
        dir: skillsDir,
        builtinCount: skills.filter((skill) => skill.source === "builtin" && !skill.error).length,
        installedCount: skills.filter((skill) => skill.source === "installed" && !skill.error).length,
        draftCount: skills.filter((skill) => skill.source === "draft" && !skill.error).length,
        brokenCount: skills.filter((skill) => skill.error).length,
      };
    })(),
    knowledgebases: (() => {
      const knowledgebasesDir = knowledgebasesDirFromConfig(loadedConfig.config, paths);
      const knowledgebases = discoverMindStoneKnowledgebases(knowledgebasesDir);
      return {
        dir: knowledgebasesDir,
        count: knowledgebases.length,
        indexedCount: knowledgebases.filter((kb) => kb.indexed).length,
        brokenCount: knowledgebases.filter((kb) => kb.error).length,
        entryCount: knowledgebases.reduce((total, kb) => total + kb.entryCount, 0),
      };
    })(),
    connectors: getConnectorVisibilityStatuses(loadedConfig.config, { env, paths }),
  };
}
