import { existsSync } from "node:fs";
import { resolveContextManagementPolicy } from "../context/index.js";
import { loadConfiguredIdentities } from "../identity/index.js";
import { getCurrentHandoffStatus } from "../lifecycle/index.js";
import { discoverFileMemoryDocuments, getSqliteMemoryIndexStats } from "../memory/index.js";
import { runtimePathsFromEnv } from "../paths/runtime.js";
import { resolveDefaultSessionKey } from "../routing/session.js";
import { getMindStoneWebChatStatus } from "../status/webchat.js";
import { loadMindStoneConfig, resolveConfigPath } from "../config/load.js";
import type { MindStoneConfig } from "../config/types.js";
import type { MindStoneDoctorCheck, MindStoneDoctorReport, MindStoneDoctorSeverity } from "./types.js";

export type MindStoneDoctorProviderDiscovery = {
  providerCount?: number;
  modelCount?: number;
  error?: string;
};

export type MindStoneDoctorEmbeddingProbe = {
  providerId: string;
  model: string;
  baseUrl: string;
  dimensions?: number;
  error?: string;
};

export type MindStoneDoctorOptions = {
  env?: NodeJS.ProcessEnv;
  providerDiscovery?: MindStoneDoctorProviderDiscovery;
  embeddingProbe?: MindStoneDoctorEmbeddingProbe;
};

function check(
  checks: MindStoneDoctorCheck[],
  severity: MindStoneDoctorSeverity,
  id: string,
  title: string,
  detail?: string,
): void {
  checks.push({ id, severity, title, detail });
}

function configuredAgentId(config: MindStoneConfig | undefined): string {
  return config?.routing?.defaultAgentId?.trim() || "default";
}

function summarize(checks: MindStoneDoctorCheck[]): MindStoneDoctorReport["summary"] {
  return {
    pass: checks.filter((entry) => entry.severity === "pass").length,
    warn: checks.filter((entry) => entry.severity === "warn").length,
    fail: checks.filter((entry) => entry.severity === "fail").length,
    info: checks.filter((entry) => entry.severity === "info").length,
  };
}

export function getMindStoneDoctorReport(options: MindStoneDoctorOptions = {}): MindStoneDoctorReport {
  const env = options.env ?? process.env;
  const paths = runtimePathsFromEnv(env);
  const configPath = resolveConfigPath(env, paths);
  const loadedConfig = loadMindStoneConfig(configPath);
  const checks: MindStoneDoctorCheck[] = [];

  check(checks, existsSync(paths.runtimeDir) ? "pass" : "fail", "runtime.dir", "Runtime directory exists", paths.runtimeDir);
  check(checks, existsSync(paths.piAgentDir) ? "pass" : "fail", "pi.agentDir", "Isolated Pi agent directory exists", paths.piAgentDir);
  check(checks, existsSync(paths.piSessionDir) ? "pass" : "fail", "pi.sessionDir", "Isolated Pi session directory exists", paths.piSessionDir);
  check(checks, existsSync(paths.dataDir) ? "pass" : "fail", "mindstone.dataDir", "MindStone data directory exists", paths.dataDir);
  check(checks, existsSync(paths.transcriptDir) ? "pass" : "fail", "transcripts.dir", "Transcript directory exists", paths.transcriptDir);
  check(checks, existsSync(paths.vectorDir) ? "pass" : "warn", "vectors.dir", "Vector directory exists", paths.vectorDir);

  if (!loadedConfig.exists) {
    check(checks, "fail", "config.exists", "Config file exists", configPath);
    const summary = summarize(checks);
    return { ok: summary.fail === 0, checks, summary };
  }

  check(checks, "pass", "config.exists", "Config file exists", loadedConfig.path);
  if (loadedConfig.error) {
    check(checks, "fail", "config.parse", "Config parses as JSON", loadedConfig.error);
    const summary = summarize(checks);
    return { ok: summary.fail === 0, checks, summary };
  }
  check(checks, "pass", "config.parse", "Config parses as JSON");

  const config = loadedConfig.config;
  const agentId = configuredAgentId(config);
  const agentConfig = config?.agents?.[agentId];
  if (!agentConfig) {
    check(checks, "fail", "agent.default", "Default agent is configured", `Missing agents.${agentId}`);
  } else {
    check(checks, "pass", "agent.default", "Default agent is configured", agentId);
  }

  for (const identity of loadConfiguredIdentities(loadedConfig)) {
    check(
      checks,
      identity.identityExists ? "pass" : "warn",
      `agent.${identity.agentId}.identity`,
      `Identity file exists for ${identity.agentId}`,
      identity.identityPath,
    );
    check(
      checks,
      identity.userExists ? "pass" : "warn",
      `agent.${identity.agentId}.user`,
      `User context file exists for ${identity.agentId}`,
      identity.userPath,
    );
    if (identity.error) {
      check(checks, "warn", `agent.${identity.agentId}.load`, `Identity loads for ${identity.agentId}`, identity.error);
    }
  }

  const sessionMode = config?.session?.mode ?? "single";
  const defaultSessionKey = resolveDefaultSessionKey(config);
  if (sessionMode !== "single" && sessionMode !== "per_surface") {
    check(checks, "fail", "session.mode", "Session mode is valid", String(sessionMode));
  } else {
    check(checks, "pass", "session.mode", "Session mode is valid", sessionMode);
  }
  check(
    checks,
    defaultSessionKey ? "pass" : "fail",
    "session.defaultKey",
    "Default session key is configured",
    defaultSessionKey,
  );
  if (sessionMode === "single" && !defaultSessionKey.startsWith("agent:")) {
    check(checks, "warn", "session.sharedDefault", "Single-session default is not canonical MindStone shape", defaultSessionKey);
  }

  const webchat = getMindStoneWebChatStatus(config);
  check(checks, "pass", "webchat.shell", "Built-in WebChat shell is available", webchat.url);
  check(
    checks,
    webchat.defaultSessionKey === defaultSessionKey ? "pass" : "warn",
    "webchat.session",
    "WebChat blank session uses configured default session key",
    webchat.defaultSessionKey,
  );
  check(
    checks,
    "info",
    "webchat.auth",
    "WebChat API calls use configured Gateway auth",
    `Static shell: ${webchat.path}; chat/status APIs remain protected when auth is enabled`,
  );

  const context = resolveContextManagementPolicy(config?.contextManagement);
  check(checks, "pass", "context.mode", "Context-management mode resolves", context.mode);
  if (context.mode === "sliding_window" && context.floorPercent >= context.ceilingPercent) {
    check(checks, "fail", "context.window", "Sliding-window floor is below ceiling", `${context.floorPercent} >= ${context.ceilingPercent}`);
  } else {
    check(checks, "pass", "context.window", "Context policy numbers are sane");
  }

  const memory = config?.memory;
  check(checks, memory?.vectorStore ? "pass" : "warn", "memory.vectorStore", "Memory vector store is configured", memory?.vectorStore ?? "unset");
  const sqliteMemoryStats = getSqliteMemoryIndexStats(paths);
  if (memory?.vectorStore === "sqlite-vec") {
    check(
      checks,
      sqliteMemoryStats.present ? "pass" : "warn",
      "memory.sqlite",
      "SQLite memory index exists",
      sqliteMemoryStats.databasePath,
    );
    if (sqliteMemoryStats.error) {
      check(checks, "warn", "memory.sqlite.stats", "SQLite memory index can be inspected", sqliteMemoryStats.error);
    } else if (sqliteMemoryStats.present) {
      check(
        checks,
        sqliteMemoryStats.chunks > 0 ? "pass" : "warn",
        "memory.sqlite.chunks",
        "SQLite memory index has chunks",
        `${sqliteMemoryStats.sources} sources, ${sqliteMemoryStats.chunks} chunks, ${sqliteMemoryStats.embeddedChunks} embedded`,
      );
      if (sqliteMemoryStats.sqliteVec.available) {
        check(
          checks,
          "pass",
          "memory.sqliteVec",
          "sqlite-vec native extension is available",
          sqliteMemoryStats.sqliteVec.version ?? "available",
        );
      } else {
        check(
          checks,
          "info",
          "memory.sqliteVec",
          "sqlite-vec native extension is unavailable; using fallback recall backend",
          `${sqliteMemoryStats.vectorBackend}${sqliteMemoryStats.sqliteVec.error ? `: ${sqliteMemoryStats.sqliteVec.error}` : ""}`,
        );
      }
    }
  } else if (sqliteMemoryStats.present) {
    check(
      checks,
      "info",
      "memory.sqlite",
      "SQLite memory index exists but is not the configured vector store",
      `${sqliteMemoryStats.databasePath} (${sqliteMemoryStats.chunks} chunks)`,
    );
  }
  check(checks, existsSync(paths.logPath) ? "pass" : "warn", "memory.log", "LOG.md exists", paths.logPath);
  const handoff = getCurrentHandoffStatus(paths);
  check(
    checks,
    handoff.exists ? "pass" : "info",
    "handoff.current",
    "Current handoff file status for ephemeral replay",
    handoff.exists ? `${handoff.path} (${handoff.bytes} bytes, ${handoff.tokenEstimate ?? 0} est. tokens)` : handoff.path,
  );
  check(checks, existsSync(paths.memoryIndexPath) ? "pass" : "warn", "memory.index", "Structured memory index exists", paths.memoryIndexPath);
  check(checks, existsSync(paths.journalDir) ? "pass" : "warn", "memory.journals", "Journal directory exists", paths.journalDir);
  const fileMemoryDocs = discoverFileMemoryDocuments({ config, paths });
  check(checks, fileMemoryDocs.length > 0 ? "pass" : "warn", "memory.files", "File-backed memory documents are discoverable", `${fileMemoryDocs.length} documents`);
  const deterministicMemorySources = (memory?.localDocuments?.length ?? 0) + fileMemoryDocs.length;
  if (memory?.autoRecall && !memory.embeddingProvider && deterministicMemorySources === 0) {
    check(checks, "warn", "memory.embedding", "Auto-recall has an embedding provider", "memory.autoRecall is true but memory.embeddingProvider is unset");
  } else if (memory?.embeddingProvider) {
    check(checks, "pass", "memory.embedding", "Embedding provider is configured", memory.embeddingProvider);
    if (options.embeddingProbe?.error) {
      check(checks, "warn", "memory.embedding.live", "Embedding provider responds to sample request", options.embeddingProbe.error);
    } else if (options.embeddingProbe) {
      check(
        checks,
        options.embeddingProbe.dimensions ? "pass" : "warn",
        "memory.embedding.live",
        "Embedding provider responds to sample request",
        `${options.embeddingProbe.providerId}:${options.embeddingProbe.model} ${options.embeddingProbe.dimensions ?? 0} dimensions @ ${options.embeddingProbe.baseUrl}`,
      );
    }
  } else if (memory?.autoRecall && deterministicMemorySources > 0) {
    check(checks, "pass", "memory.embedding", "Auto-recall has deterministic file/local memory sources", `${deterministicMemorySources} documents`);
  } else {
    check(checks, "info", "memory.embedding", "Embedding provider is unset", "fine until autoRecall is enabled");
  }

  const routingMode = config?.routing?.mode ?? "placeholder";
  if (!(["placeholder", "mock", "pi"] as string[]).includes(routingMode)) {
    check(checks, "fail", "routing.mode", "Routing mode is valid", routingMode);
  } else {
    check(checks, routingMode === "placeholder" ? "warn" : "pass", "routing.mode", "Routing mode is configured", routingMode);
  }
  if (routingMode === "pi" && !config?.routing?.defaultModel) {
    check(checks, "warn", "routing.model", "Pi routing default model is configured", "routing.defaultModel is unset");
  } else if (config?.routing?.defaultModel) {
    check(checks, "pass", "routing.model", "Default model is configured", config.routing.defaultModel);
  }

  const providerDiscovery = options.providerDiscovery;
  if (providerDiscovery?.error) {
    check(checks, "warn", "provider.discovery", "Provider/model discovery works", providerDiscovery.error);
  } else if (providerDiscovery) {
    check(
      checks,
      (providerDiscovery.providerCount ?? 0) > 0 || (providerDiscovery.modelCount ?? 0) > 0 ? "pass" : "warn",
      "provider.discovery",
      "Provider/model discovery works",
      `${providerDiscovery.providerCount ?? 0} providers, ${providerDiscovery.modelCount ?? 0} models`,
    );
  } else {
    check(checks, "info", "provider.discovery", "Provider/model discovery not run");
  }

  check(
    checks,
    "info",
    "gateway.status",
    "Gateway live status check not run",
    `Configured endpoint: http://${config?.gateway?.host ?? "127.0.0.1"}:${config?.gateway?.port ?? 19789}`,
  );

  const summary = summarize(checks);
  return { ok: summary.fail === 0, checks, summary };
}
