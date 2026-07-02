import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { MockMindStoneProvider } from "./mock-provider.js";
import { PiMindStoneProvider } from "./pi-provider.js";
import { PiSessionMindStoneProvider } from "./pi-session-provider.js";
import { PiSessionAgentRunner } from "./pi-session-runner.js";
import { GatewayRunManager } from "./run-manager.js";
import { WEBCHAT_UI_HTML } from "./webchat-ui.js";

export { MockMindStoneProvider } from "./mock-provider.js";
export { PiMindStoneProvider } from "./pi-provider.js";
export {
  buildMindStonePiExtensionFactories,
  createMindStoneCompactionSafeguardExtension,
  createMindStoneContextPruningExtension,
  type MindStonePiContext,
  type MindStonePiContextEvent,
  type MindStonePiContextHandler,
  type MindStonePiContextMessage,
  type MindStonePiContextResult,
  type MindStonePiCompactionPreparation,
  type MindStonePiCompactionSafeguardResult,
  type MindStonePiExtensionApi,
  type MindStonePiExtensionFactory,
  type MindStonePiExtensionFactoryOptions,
  type MindStonePiFileOperations,
  type MindStonePiSessionBeforeCompactContext,
  type MindStonePiSessionBeforeCompactEvent,
  type MindStonePiSessionBeforeCompactHandler,
} from "./pi-context-pruning-extension.js";
export {
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  PI_SESSION_EVENT_CALLBACK_METADATA_KEY,
  applyPiSessionCompactionSettings,
  buildPiSessionResourceLoaderOptions,
  PiSessionExecutor,
  repairPiSessionFileTailIfNeeded,
  withPiSessionFileLock,
  type PiSessionEventCallback,
  type PiSessionEventCallbackPayload,
  type PiSessionEventSummary,
  type PiSessionExecutorOptions,
  type PiSessionFileLockOptions,
  type PiSessionFileRepairResult,
  type PiSessionResourceLoaderOptions,
} from "./pi-session-executor.js";
export {
  capPiSessionManagerOnLoad,
  resolvePiSessionResumeCapOptions,
  type PiSessionResumeCapOptions,
  type PiSessionResumeCapStats,
} from "./pi-session-resume-cap.js";
export { PiSessionMindStoneProvider, buildPiSessionPromptParts, createPiSessionEventCapture, piSessionFileForKey, summarizePiSessionEvent } from "./pi-session-provider.js";
export { PiSessionAgentRunner } from "./pi-session-runner.js";
export { GatewayRunManager } from "./run-manager.js";
export { LOOPBACK_CONNECTOR } from "./connectors/loopback.js";
export { TELEGRAM_CONNECTOR, telegramUpdateToInbound } from "./connectors/telegram.js";
export { SLACK_CONNECTOR, slackEventToInbound } from "./connectors/slack.js";
import "./connectors/loopback.js";
import "./connectors/telegram.js";
import "./connectors/slack.js";
import {
  loadRoutePersonaContextById,
  resolveRoutePersonaContext,
  runMindStoneWorkflow,
  appendTranscriptEntry,
  buildPromptWindow,
  createLocalMemoryRecallProvider,
  createSqliteMemoryRecallProvider,
  decideGatewayAuth,
  discoverFileMemoryDocuments,
  discoverKnowledgebaseRecallDocuments,
  recallScopeForMemoryScope,
  scopeFromRequest,
  scopedSessionKey,
  ConnectorDeliveryQueue,
  configuredConnectorIds,
  connectorAccessPolicyFromChannelConfig,
  connectorCredentialRefFromChannelConfig,
  connectorSessionKey,
  connectorTranscriptSource,
  connectorTriggerPolicyFromChannelConfig,
  evaluateConnectorAccess,
  getConnector,
  readConnectorRuntimeStatus,
  resolveConnectorCredential,
  shouldTriggerConnectorReply,
  writeConnectorRuntimeStatus,
  type ConnectorContext,
  type ConnectorInboundHandle,
  type ConnectorInboundMessage,
  getMindStoneSystemStatus,
  listTranscriptSessions,
  loadMindStoneConfig,
  loadMindStoneIdentity,
  readTranscriptEntries,
  resolveConfigPath,
  resolveConfiguredSessionKey,
  resolveGatewayAuthRequirement,
  runtimePathsFromEnv,
  planPostCompactMaintenance,
  createProviderRouteAgentRunner,
  providerDiagnosticsFromChatResult,
  readCurrentHandoff,
  requestGatewaySubstrateCompaction,
  sanitizeRunnerStreamSubstrateEventPayload,
  writeAutoCompactHandoff,
  type MindStoneConfig,
  type AgentRunResult,
  type AgentRunStreamEvent,
  type AgentRunner,
  type MindStoneModelInfo,
  type MindStoneModelProvider,
  type TranscriptEntry,
  type TranscriptRole,
  type PromptWindowAutoCompactEvent,
} from "@mindstone-agent/core";

export type GatewayOptions = {
  host?: string;
  port?: number;
};

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function loadGatewayConfig(): ReturnType<typeof loadMindStoneConfig> {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath(process.env, paths);
  return loadMindStoneConfig(configPath);
}

function openAiError(message: string, type: string, code: string): { error: { message: string; type: string; code: string } } {
  return { error: { message, type, code } };
}

function isChatCompletionsEnabled(config: MindStoneConfig | undefined): boolean {
  return config?.gateway?.http?.chatCompletions?.enabled === true;
}

function isOpenResponsesEnabled(config: MindStoneConfig | undefined): boolean {
  return config?.gateway?.http?.responses?.enabled === true;
}

function isOpenAiModelListEnabled(config: MindStoneConfig | undefined): boolean {
  return isChatCompletionsEnabled(config) || isOpenResponsesEnabled(config);
}

function numberFromMetadata(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveContextWindowTokens(config: MindStoneConfig | undefined, agentId: string, metadata?: Record<string, unknown>): number {
  return numberFromMetadata(metadata, "contextWindowTokens") ?? config?.agents?.[agentId]?.contextWindowTokens ?? 128_000;
}

function resolveReservedPromptTokens(metadata?: Record<string, unknown>): number {
  return numberFromMetadata(metadata, "reservedTokens") ?? 0;
}

const RUNNER_STREAM_EVENT_TYPES: AgentRunStreamEvent["type"][] = [
  "run_started",
  "route_planned",
  "text_delta",
  "substrate_event",
  "run_completed",
  "run_failed",
];

type RunnerStreamOptions = {
  persistTranscriptEvents: boolean;
  eventTypes: AgentRunStreamEvent["type"][];
  maxEvents: number;
};

function normalizeRunnerStreamEventTypes(values: readonly string[] | undefined): AgentRunStreamEvent["type"][] {
  if (!values?.length) return ["substrate_event"];
  const known = new Set<string>(RUNNER_STREAM_EVENT_TYPES);
  const normalized = values.filter((value): value is AgentRunStreamEvent["type"] => known.has(value));
  return normalized.length ? normalized : ["substrate_event"];
}

function resolveRunnerStreamOptions(config: MindStoneConfig | undefined): RunnerStreamOptions {
  const configured = config?.observability?.runnerStream;
  return {
    persistTranscriptEvents: configured?.persistTranscriptEvents === true,
    eventTypes: normalizeRunnerStreamEventTypes(configured?.eventTypes),
    maxEvents: Math.max(0, Math.floor(configured?.maxEvents ?? 50)),
  };
}

async function runGatewayRunner(input: {
  runner: AgentRunner;
  runInput: Parameters<AgentRunner["run"]>[0];
  streamOptions: RunnerStreamOptions;
}): Promise<{ route: AgentRunResult; streamEvents: AgentRunStreamEvent[] }> {
  if (!input.streamOptions.persistTranscriptEvents) {
    return { route: await input.runner.run(input.runInput), streamEvents: [] };
  }
  const streamEvents: AgentRunStreamEvent[] = [];
  let route: AgentRunResult | undefined;
  for await (const event of input.runner.stream(input.runInput)) {
    streamEvents.push(event);
    if (event.type === "run_completed") route = event.result;
  }
  if (!route) throw new Error("AgentRunner stream completed without run_completed event");
  return { route, streamEvents };
}

function runnerStreamEventText(event: AgentRunStreamEvent): string {
  if (event.type === "substrate_event") return `Runner ${event.runnerId} emitted ${event.substrate} substrate event.`;
  if (event.type === "text_delta") return `Runner ${event.runnerId} emitted streamed text delta (${event.text.length} chars).`;
  if (event.type === "run_started") return `Runner ${event.runnerId} started.`;
  if (event.type === "run_completed") return `Runner ${event.runnerId} completed.`;
  if (event.type === "run_failed") return `Runner ${event.runnerId} failed: ${event.error.message}`;
  return `Runner ${event.runnerId} planned route.`;
}

function runnerStreamEventMetadata(event: AgentRunStreamEvent): Record<string, unknown> {
  const base = {
    event: "runner_stream_event",
    streamType: event.type,
    sequence: event.sequence,
    runnerId: event.runnerId,
    sourceTimestamp: event.timestamp,
    surface: event.surface,
    streamMetadata: event.metadata,
  };
  if (event.type === "substrate_event") return { ...base, substrate: event.substrate, payload: sanitizeRunnerStreamSubstrateEventPayload(event.event) };
  if (event.type === "text_delta") return { ...base, textChars: event.text.length };
  if (event.type === "run_failed") return { ...base, error: event.error };
  if (event.type === "run_started") return { ...base, input: event.input };
  if (event.type === "route_planned") {
    return {
      ...base,
      plan: {
        agentId: event.plan.agentId,
        sessionKey: event.plan.sessionKey,
        model: event.plan.model,
        promptEntries: event.plan.promptWindow.promptEntries.length,
        prunedEntries: event.plan.promptWindow.prunedEntries.length,
      },
    };
  }
  return base;
}

function appendRunnerStreamTranscriptEvents(input: {
  sessionKey: string;
  agentId: string;
  runId: string;
  source?: TranscriptEntry["source"];
  streamEvents: AgentRunStreamEvent[];
  streamOptions: RunnerStreamOptions;
}): TranscriptEntry[] {
  if (!input.streamOptions.persistTranscriptEvents || input.streamOptions.maxEvents <= 0) return [];
  const selectedTypes = new Set(input.streamOptions.eventTypes);
  return input.streamEvents
    .filter((event) => selectedTypes.has(event.type))
    .slice(0, input.streamOptions.maxEvents)
    .map((event) => appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "event",
      text: runnerStreamEventText(event),
      content: event.type === "substrate_event" ? sanitizeRunnerStreamSubstrateEventPayload(event.event) : undefined,
      runId: input.runId,
      source: input.source,
      metadata: runnerStreamEventMetadata(event),
    }));
}

function resolveRoutingMode(config: MindStoneConfig | undefined): "placeholder" | "mock" | "pi" | "pi-session" {
  return config?.routing?.mode ?? "placeholder";
}

function resolveRouteModel(config: MindStoneConfig | undefined, agentId: string, metadata?: Record<string, unknown>): MindStoneModelInfo {
  const metadataModel = typeof metadata?.model === "string" ? metadata.model : undefined;
  const configuredAgent = config?.agents?.[agentId];
  return {
    id: metadataModel ?? config?.routing?.defaultModel ?? configuredAgent?.defaultModel ?? `mindstone/${agentId}`,
    provider: resolveRoutingMode(config),
    contextWindowTokens: resolveContextWindowTokens(config, agentId, metadata),
  };
}

function resolveProvider(config: MindStoneConfig | undefined): MindStoneModelProvider | undefined {
  const mode = resolveRoutingMode(config);
  if (mode === "mock") return new MockMindStoneProvider(config?.routing?.mock);
  if (mode === "pi-session") {
    const paths = runtimePathsFromEnv();
    return new PiSessionMindStoneProvider({
      projectRoot: paths.root,
      agentDir: config?.routing?.pi?.agentDir ?? paths.piAgentDir,
      sessionDir: paths.piSessionDir,
      cwd: config?.workspace?.root,
      defaultModel: config?.routing?.defaultModel,
      contextManagement: config?.contextManagement,
      compaction: config?.routing?.pi?.compaction,
      resumeCap: config?.routing?.pi?.resumeCap,
      additionalExtensionPaths: config?.routing?.pi?.additionalExtensionPaths,
      additionalSkillPaths: config?.routing?.pi?.additionalSkillPaths,
      additionalPromptTemplatePaths: config?.routing?.pi?.additionalPromptTemplatePaths,
      additionalThemePaths: config?.routing?.pi?.additionalThemePaths,
      noExtensions: config?.routing?.pi?.noExtensions,
      noSkills: config?.routing?.pi?.noSkills,
      noPromptTemplates: config?.routing?.pi?.noPromptTemplates,
      noThemes: config?.routing?.pi?.noThemes,
      noContextFiles: config?.routing?.pi?.noContextFiles,
    });
  }
  if (mode === "pi") {
    return new PiMindStoneProvider({
      agentDir: config?.routing?.pi?.agentDir,
      defaultModel: config?.routing?.defaultModel,
    });
  }
  return undefined;
}

function resolveRunner(config: MindStoneConfig | undefined, provider: MindStoneModelProvider): AgentRunner {
  const mode = resolveRoutingMode(config);
  if (mode === "pi-session") {
    const paths = runtimePathsFromEnv();
    return new PiSessionAgentRunner({
      projectRoot: paths.root,
      agentDir: config?.routing?.pi?.agentDir ?? paths.piAgentDir,
      sessionDir: paths.piSessionDir,
      cwd: config?.workspace?.root,
      defaultModel: config?.routing?.defaultModel,
      contextManagement: config?.contextManagement,
      compaction: config?.routing?.pi?.compaction,
      resumeCap: config?.routing?.pi?.resumeCap,
      additionalExtensionPaths: config?.routing?.pi?.additionalExtensionPaths,
      additionalSkillPaths: config?.routing?.pi?.additionalSkillPaths,
      additionalPromptTemplatePaths: config?.routing?.pi?.additionalPromptTemplatePaths,
      additionalThemePaths: config?.routing?.pi?.additionalThemePaths,
      noExtensions: config?.routing?.pi?.noExtensions,
      noSkills: config?.routing?.pi?.noSkills,
      noPromptTemplates: config?.routing?.pi?.noPromptTemplates,
      noThemes: config?.routing?.pi?.noThemes,
      noContextFiles: config?.routing?.pi?.noContextFiles,
    });
  }
  void provider;
  return createProviderRouteAgentRunner();
}

async function appendAutoCompactTranscriptEvent(input: {
  sessionKey: string;
  agentId: string;
  event: PromptWindowAutoCompactEvent;
  entries: TranscriptEntry[];
  source?: TranscriptEntry["source"];
  runId?: string;
  config?: MindStoneConfig;
  runner?: AgentRunner;
  model?: MindStoneModelInfo;
  signal?: AbortSignal;
}): Promise<TranscriptEntry> {
  const metadata: Record<string, unknown> = { ...input.event };
  let text = input.event.event === "auto_compact_required"
    ? `Auto-compact threshold reached at ${input.event.utilizationPercent.toFixed(1)}% utilization. Checkpoint/handoff/compact should run.`
    : `Auto-compact warning threshold reached at ${input.event.utilizationPercent.toFixed(1)}% utilization. Prepare checkpoint/handoff.`;

  if (input.event.event === "auto_compact_required") {
    if (input.event.emergencyAutoHandoff) {
      const handoff = writeAutoCompactHandoff({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        event: input.event,
        entries: input.entries,
        source: input.source,
        runId: input.runId,
      });
      const compaction = resolveRoutingMode(input.config) === "pi-session" && input.runner?.compact && input.model
        ? await input.runner.compact({
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            model: input.model,
            customInstructions: `MindStone auto-compact after emergency handoff: ${handoff.latestPath}`,
            signal: input.signal,
            runContext: {
              runId: input.runId,
              surface: input.source?.substrate ?? "gateway",
            },
          })
        : requestGatewaySubstrateCompaction({
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            event: input.event,
            handoff,
            config: input.config,
            runId: input.runId,
          });
      metadata.handoff = handoff;
      metadata.compaction = compaction;
      text = compaction.requested
        ? `${text} Emergency auto-handoff written to ${handoff.latestPath}. Substrate compaction requested: ${compaction.reason}.`
        : `${text} Emergency auto-handoff written to ${handoff.latestPath}. Substrate compaction not requested: ${compaction.reason}.`;
    } else {
      metadata.handoff = { written: false, reason: "emergency_auto_handoff_disabled" };
      metadata.compaction = { requested: false, reason: "manual_checkpoint_handoff_required" };
    }
  }

  return appendTranscriptEntry({
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    role: "event",
    text,
    runId: input.runId,
    source: input.source,
    metadata,
  });
}

function maybeRecordPromptWindowEvent(input: {
  sessionKey: string;
  agentId: string;
  config: MindStoneConfig | undefined;
  metadata?: Record<string, unknown>;
  entries?: TranscriptEntry[];
  model?: MindStoneModelInfo;
}): ReturnType<typeof buildPromptWindow> {
  const entries = input.entries ?? readTranscriptEntries(input.sessionKey);
  const source = [...entries].reverse().find((entry) => entry.source)?.source;
  const result = buildPromptWindow({
    entries,
    contextWindowTokens: input.model?.contextWindowTokens ?? resolveContextWindowTokens(input.config, input.agentId, input.metadata),
    reservedTokens: resolveReservedPromptTokens(input.metadata),
    policy: input.config?.contextManagement,
  });

  if (result.pruneEvent) {
    appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "event",
      text: `Context window pruned from ${result.tokensBefore} to ${result.tokensAfter} estimated tokens. Transcript preserved.`,
      source,
      metadata: result.pruneEvent,
    });
  }
  if (result.autoCompactEvent) {
    void appendAutoCompactTranscriptEvent({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      event: result.autoCompactEvent,
      entries,
      source,
      config: input.config,
    }).catch(() => undefined);
  }

  return result;
}

function openAiModels(config: MindStoneConfig | undefined): unknown {
  const agents = config?.agents ?? {};
  const data = Object.entries(agents).map(([agentId, agent]) => ({
    id: agent.defaultModel ?? `mindstone/${agentId}`,
    object: "model",
    created: 0,
    owned_by: "mindstone-agent",
  }));
  return {
    object: "list",
    data: data.length > 0 ? data : [{ id: "mindstone/default", object: "model", created: 0, owned_by: "mindstone-agent" }],
  };
}

function isTranscriptRole(value: unknown): value is TranscriptRole {
  return ["user", "assistant", "tool", "system", "event"].includes(String(value));
}

function transcriptTextFromOpenAiContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part !== "object" || part === null) return undefined;
        const record = part as Record<string, unknown>;
        if ((record.type === "text" || record.type === "input_text" || record.type === "output_text") && typeof record.text === "string") return record.text;
        return undefined;
      })
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

function openAiRoleToTranscriptRole(role: unknown): TranscriptRole {
  if (role === "system" || role === "assistant" || role === "tool") return role;
  return "user";
}

type OpenResponsesTranscriptInput = {
  role: TranscriptRole;
  text?: string;
  content: unknown;
  metadata: Record<string, unknown>;
};

function openResponsesInputToTranscriptInputs(input: unknown): OpenResponsesTranscriptInput[] {
  if (typeof input === "string") {
    return [{ role: "user", text: input, content: input, metadata: { inputIndex: 0, originalType: "string" } }];
  }
  if (!Array.isArray(input)) return [];
  return input.map((item, index) => {
    if (typeof item === "string") {
      return { role: "user", text: item, content: item, metadata: { inputIndex: index, originalType: "string" } };
    }
    const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const content = record.content ?? record.input ?? record.text;
    return {
      role: openAiRoleToTranscriptRole(record.role),
      text: transcriptTextFromOpenAiContent(content) ?? (typeof record.text === "string" ? record.text : undefined),
      content,
      metadata: {
        inputIndex: index,
        originalType: record.type,
        originalRole: record.role,
      },
    };
  });
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.trim().length > 0 ? JSON.parse(text) : {};
}

function enforceGatewayAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath(process.env, paths);
  const loadedConfig = loadMindStoneConfig(configPath);
  const requirement = resolveGatewayAuthRequirement({
    config: loadedConfig.config?.gateway?.auth,
    configPath,
  });
  const decision = decideGatewayAuth(requirement, req.headers);
  if (decision.allowed) return true;

  sendJson(
    res,
    decision.status,
    { ok: false, error: decision.reason },
    decision.challenge ? { "www-authenticate": decision.challenge } : {},
  );
  return false;
}


type GatewayRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

function rpcSuccess(id: GatewayRpcRequest["id"], result: unknown): unknown {
  return { id: id ?? null, ok: true, result };
}

function rpcError(id: GatewayRpcRequest["id"], code: string, message: string): unknown {
  return { id: id ?? null, ok: false, error: { code, message } };
}

function labelMessage(label: unknown, message: string): string {
  return typeof label === "string" && label.trim() ? `[${label.trim()}]\n\n${message}` : message;
}

const runManager = new GatewayRunManager();

function abortGatewayRuns(sessionKey: string, runId: unknown): { aborted: boolean; reason: string; runs: unknown[] } {
  const results = typeof runId === "string" && runId.trim()
    ? [runManager.abort(runId.trim())]
    : runManager.abortSession(sessionKey);
  const aborted = results.some((result) => result.aborted);
  const firstMiss = results.find((result) => !result.aborted);
  return {
    aborted,
    reason: aborted ? "aborted" : firstMiss && !firstMiss.aborted ? firstMiss.reason : "not_found",
    runs: results.map((result) => result.run).filter(Boolean),
  };
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function gatewayTranscriptSource(input: {
  substrate: string;
  channel?: string;
  chatType?: "direct" | "group" | "channel" | "thread" | "internal";
  senderId?: unknown;
  threadId?: unknown;
}) {
  return {
    substrate: input.substrate,
    channel: input.channel,
    chatType: input.chatType,
    senderId: stringParam(input.senderId),
  };
}

function gatewaySessionKey(input: {
  config: MindStoneConfig | undefined;
  explicitSessionKey?: unknown;
  agentId: string;
  substrate: string;
  channel?: string;
  chatType?: string;
  senderId?: unknown;
  threadId?: unknown;
}): string {
  return resolveConfiguredSessionKey(input.config, {
    agentId: input.agentId,
    substrate: input.substrate,
    channel: input.channel,
    chatType: input.chatType,
    senderId: stringParam(input.senderId),
    threadId: stringParam(input.threadId),
    explicitSessionKey: stringParam(input.explicitSessionKey),
  });
}

function hasReplayedHandoff(entries: TranscriptEntry[], sha256: string): boolean {
  return entries.some((entry) => {
    if (entry.metadata?.event !== "handoff_replayed") return false;
    const handoff = entry.metadata.handoff;
    return typeof handoff === "object" && handoff !== null && (handoff as Record<string, unknown>).sha256 === sha256;
  });
}

function loadRouteIdentityContext(input: {
  agentId: string;
  config: MindStoneConfig | undefined;
  configPath?: string;
}) {
  const agentConfig = input.config?.agents?.[input.agentId];
  if (!agentConfig || !input.configPath) return undefined;
  const loadedIdentity = loadMindStoneIdentity(input.agentId, agentConfig, input.configPath);
  if (!loadedIdentity.identity) return undefined;
  return {
    name: loadedIdentity.identity.name,
    identityMarkdown: loadedIdentity.identity.identityMarkdown,
    userMarkdown: loadedIdentity.identity.userMarkdown,
    identityPath: loadedIdentity.identityPath,
    userPath: loadedIdentity.userPath,
  };
}

async function runConfiguredRoute(input: {
  sessionKey: string;
  agentId: string;
  config: MindStoneConfig | undefined;
  configPath?: string;
  metadata?: Record<string, unknown>;
  /** App Engine / Agent Mesh scope — enforced on memory recall for this run. */
  scope?: Record<string, string>;
  /** Recall filter override when the memory scope is broader than the run scope. */
  recallScope?: Record<string, string>;
  /** Deterministic request-level routing: forced persona wins over workflow decisions; forced workflow bypasses selection. */
  route?: { personaId?: string; workflowId?: string };
}): Promise<{
  routed: boolean;
  status: number;
  body: unknown;
}> {
  const provider = resolveProvider(input.config);
  if (!provider) return { routed: false, status: 501, body: undefined };

  const model = resolveRouteModel(input.config, input.agentId, input.metadata);
  const entries = readTranscriptEntries(input.sessionKey);
  const currentHandoff = readCurrentHandoff();
  const handoffReplay = currentHandoff && !hasReplayedHandoff(entries, currentHandoff.sha256)
    ? {
        path: currentHandoff.path,
        sha256: currentHandoff.sha256,
        updatedAt: currentHandoff.updatedAt,
        text: currentHandoff.text,
        tokenEstimate: currentHandoff.tokenEstimate,
      }
    : undefined;
  const source = [...entries].reverse().find((entry) => entry.source)?.source;
  const run = runManager.start({
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    metadata: { provider: provider.id, model: model.id },
  });

  const workflowOutcome = runMindStoneWorkflow({
    config: input.config,
    workflowId: input.route?.workflowId,
    turn: {
      sessionKey: input.sessionKey,
      sourceChannel: source?.channel,
      sourceSubstrate: source?.substrate,
      messageText: [...entries].reverse().find((entry) => entry.role === "user")?.text,
    },
  });
  for (const workflowEvent of workflowOutcome?.events ?? []) {
    appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "event",
      text: workflowEvent.text,
      source,
      metadata: workflowEvent.metadata,
    });
  }

  try {
    const runner = resolveRunner(input.config, provider);
    const streamOptions = resolveRunnerStreamOptions(input.config);
    const { route, streamEvents } = await runGatewayRunner({
      runner,
      streamOptions,
      runInput: {
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        entries,
        model,
        provider,
        identityContext: loadRouteIdentityContext({ agentId: input.agentId, config: input.config, configPath: input.configPath }),
        personaContext: (input.route?.personaId
          ? loadRoutePersonaContextById({
              config: input.config,
              personaId: input.route.personaId,
              reason: "forced:request",
            })
          : workflowOutcome?.decision?.personaId
          ? loadRoutePersonaContextById({
              config: input.config,
              personaId: workflowOutcome.decision.personaId,
              reason: `workflow:${workflowOutcome.workflowId}/step:${workflowOutcome.decision.stepId}`,
            })
          : resolveRoutePersonaContext({
              config: input.config,
              sessionKey: input.sessionKey,
              sourceChannel: source?.channel,
              sourceSubstrate: source?.substrate,
            })).context,
        contextManagement: input.config?.contextManagement,
        reservedTokens: resolveReservedPromptTokens(input.metadata),
        handoffReplay,
        memoryRecall: {
          enabled: input.config?.memory?.autoRecall === true,
          provider: input.config?.memory?.vectorStore === "sqlite-vec"
            ? createSqliteMemoryRecallProvider({ config: input.config }) ?? createLocalMemoryRecallProvider([
                ...(input.config?.memory?.localDocuments ?? []),
                ...discoverFileMemoryDocuments({ config: input.config }),
                ...discoverKnowledgebaseRecallDocuments({ config: input.config }),
              ])
            : createLocalMemoryRecallProvider([
                ...(input.config?.memory?.localDocuments ?? []),
                ...discoverFileMemoryDocuments({ config: input.config }),
                ...discoverKnowledgebaseRecallDocuments({ config: input.config }),
              ]),
          config: input.config?.memory?.recall,
          scope: input.recallScope ?? input.scope,
        },
        signal: run.abortController.signal,
        metadata: input.metadata,
        runContext: {
          runId: run.id,
          surface: source?.substrate ?? "gateway",
          metadata: input.metadata,
        },
      },
    });

    if (route.handoffReplay) {
      appendTranscriptEntry({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        role: "event",
        text: `Replayed current handoff into prompt context from ${route.handoffReplay.path}.`,
        runId: run.id,
        source,
        metadata: {
          event: "handoff_replayed",
          handoff: {
            path: route.handoffReplay.path,
            sha256: route.handoffReplay.sha256,
            updatedAt: route.handoffReplay.updatedAt,
            tokenEstimate: route.handoffReplay.tokenEstimate,
          },
          durable: false,
        },
      });
      const maintenance = planPostCompactMaintenance({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        handoffReplay: route.handoffReplay,
        config: input.config,
        runId: run.id,
      });
      appendTranscriptEntry({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        role: "event",
        text: "Post-compact maintenance scaffold recorded after handoff replay; no durable memory was written automatically.",
        runId: run.id,
        source,
        metadata: maintenance,
      });
    }

    if (route.promptWindow.pruneEvent) {
      appendTranscriptEntry({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        role: "event",
        text: `Context window pruned from ${route.promptWindow.tokensBefore} to ${route.promptWindow.tokensAfter} estimated tokens. Transcript preserved.`,
        runId: run.id,
        source,
        metadata: route.promptWindow.pruneEvent,
      });
    }
    if (route.promptWindow.autoCompactEvent) {
      await appendAutoCompactTranscriptEvent({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        event: route.promptWindow.autoCompactEvent,
        entries: route.promptWindow.entries,
        runId: run.id,
        source,
        config: input.config,
        runner,
        model,
        signal: run.abortController.signal,
      });
    }

    if (route.memoryRecall?.hits.length) {
      appendTranscriptEntry({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        role: "event",
        text: `Injected ${route.memoryRecall.hits.length} recalled memory chunk(s) into prompt context.`,
        runId: run.id,
        source,
        metadata: {
          event: "memory_recall_injected",
          query: route.memoryRecall.query,
          hitCount: route.memoryRecall.hits.length,
          promptTokens: route.memoryRecall.promptTokens,
          diagnostics: route.memoryRecall.diagnostics,
          hits: route.memoryRecall.hits.map((hit) => ({
            id: hit.id,
            chunkId: hit.chunkId,
            title: hit.title,
            score: hit.score,
            providerScore: typeof hit.metadata?.providerScore === "number" ? hit.metadata.providerScore : undefined,
            recallMode: typeof hit.metadata?.recallMode === "string" ? hit.metadata.recallMode : undefined,
            scri: hit.metadata?.scri,
          })),
        },
      });
    }

    const runnerStreamTranscriptEvents = appendRunnerStreamTranscriptEvents({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      runId: run.id,
      source,
      streamEvents,
      streamOptions,
    });

    const assistantEntry = appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "assistant",
      text: route.result.text,
      content: route.result.content,
      source,
      runId: run.id,
      metadata: {
        event: "assistant_response",
        provider: provider.id,
        model: model.id,
        usage: route.result.usage,
        runner: route.runner,
        ...(input.scope ? { scope: input.scope } : {}),
        providerDiagnostics: providerDiagnosticsFromChatResult(route.result),
      },
    });
    runManager.complete(run.id);

    return {
      routed: true,
      status: 200,
      body: {
        ok: true,
        runId: run.id,
        provider: provider.id,
        model: model.id,
        runner: route.runner,
        identityContext: route.identityContext,
        personaContext: route.personaContext,
        workflow: workflowOutcome
          ? { workflowId: workflowOutcome.workflowId, reason: workflowOutcome.reason, failed: workflowOutcome.failed, decision: workflowOutcome.decision }
          : undefined,
        promptWindow: {
          mode: route.promptWindow.policy.mode,
          pruned: route.promptWindow.pruned,
          tokensBefore: route.promptWindow.tokensBefore,
          tokensAfter: route.promptWindow.tokensAfter,
          promptEntries: route.promptWindow.promptEntries.length,
          prunedEntries: route.promptWindow.prunedEntries.length,
          autoCompact: route.promptWindow.autoCompactEvent,
        },
        handoffReplay: route.handoffReplay
          ? {
              path: route.handoffReplay.path,
              sha256: route.handoffReplay.sha256,
              updatedAt: route.handoffReplay.updatedAt,
              tokenEstimate: route.handoffReplay.tokenEstimate,
            }
          : undefined,
        memoryRecall: route.memoryRecall
          ? {
              query: route.memoryRecall.query,
              hitCount: route.memoryRecall.hits.length,
              promptTokens: route.memoryRecall.promptTokens,
            }
          : undefined,
        runnerStream: streamOptions.persistTranscriptEvents
          ? {
              eventCount: streamEvents.length,
              persistedEventCount: runnerStreamTranscriptEvents.length,
            }
          : undefined,
        entry: assistantEntry,
      },
    };
  } catch (error) {
    runManager.fail(run.id);
    const entry = appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "event",
      text: error instanceof Error ? error.message : String(error),
      source,
      runId: run.id,
      metadata: { event: "routing_failed", provider: provider.id, model: model.id },
    });
    return { routed: true, status: 500, body: { ok: false, runId: run.id, error: entry.text, entry } };
  }
}

type GatewayRpcExecution = {
  status: number;
  body: unknown;
};

async function executeGatewayRpc(rpc: GatewayRpcRequest): Promise<GatewayRpcExecution> {
  const id = rpc.id;
  const method = rpc.method;
  const params = typeof rpc.params === "object" && rpc.params !== null ? rpc.params as Record<string, unknown> : {};
  if (!method) {
    return { status: 400, body: rpcError(id, "invalid_request", "method is required") };
  }

  if (method === "chat.sessions") {
    return { status: 200, body: rpcSuccess(id, { sessions: listTranscriptSessions() }) };
  }

  if (method === "chat.history") {
    const loadedConfig = loadGatewayConfig();
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "default";
    const sessionKey = gatewaySessionKey({
      config: loadedConfig.config,
      explicitSessionKey: params.sessionKey,
      agentId,
      substrate: "gateway-rpc",
      channel: "webchat",
      chatType: "internal",
      senderId: params.senderId,
      threadId: params.threadId,
    });
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    return {
      status: 200,
      body: rpcSuccess(id, { sessionKey, entries: readTranscriptEntries(sessionKey, limit ? { limit } : {}) }),
    };
  }

  if (method === "chat.inject") {
    const loadedConfig = loadGatewayConfig();
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "default";
    const source = gatewayTranscriptSource({ substrate: "gateway-rpc", channel: "webchat", chatType: "internal", senderId: params.senderId, threadId: params.threadId });
    const sessionKey = gatewaySessionKey({ config: loadedConfig.config, explicitSessionKey: params.sessionKey, agentId, substrate: "gateway-rpc", channel: "webchat", chatType: "internal", senderId: params.senderId, threadId: params.threadId });
    const message = typeof params.message === "string" ? params.message : typeof params.text === "string" ? params.text : "";
    if (!message.trim()) {
      return { status: 400, body: rpcError(id, "invalid_request", "message is required") };
    }
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "assistant",
      text: labelMessage(params.label, message),
      source,
      metadata: { source: "gateway-rpc", method: "chat.inject", threadId: stringParam(params.threadId) },
    });
    return { status: 200, body: rpcSuccess(id, { ok: true, entry }) };
  }

  if (method === "chat.send") {
    const loadedConfig = loadGatewayConfig();
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "default";
    const source = gatewayTranscriptSource({ substrate: "gateway-rpc", channel: "webchat", chatType: "internal", senderId: params.senderId, threadId: params.threadId });
    const sessionKey = gatewaySessionKey({ config: loadedConfig.config, explicitSessionKey: params.sessionKey, agentId, substrate: "gateway-rpc", channel: "webchat", chatType: "internal", senderId: params.senderId, threadId: params.threadId });
    const message = typeof params.message === "string" ? params.message : typeof params.text === "string" ? params.text : "";
    if (!message.trim()) {
      return { status: 400, body: rpcError(id, "invalid_request", "message is required") };
    }
    const userEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "user",
      text: message,
      source,
      metadata: { source: "gateway-rpc", method: "chat.send", threadId: stringParam(params.threadId) },
    });
    const routed = await runConfiguredRoute({ sessionKey, agentId, config: loadedConfig.config, configPath: loadedConfig.path });
    if (routed.routed) {
      return { status: routed.status, body: rpcSuccess(id, { persisted: true, userEntry, ...routed.body as Record<string, unknown> }) };
    }
    const promptWindow = maybeRecordPromptWindowEvent({ sessionKey, agentId, config: loadedConfig.config });
    const eventEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: "MindStone routing is not implemented yet; message persisted but no assistant run was started.",
      parentId: userEntry.id,
      source,
      metadata: { event: "routing_not_implemented", source: "gateway-rpc", method: "chat.send", threadId: stringParam(params.threadId) },
    });
    return {
      status: 200,
      body: rpcSuccess(id, {
        ok: false,
        code: "not_implemented",
        persisted: true,
        promptWindow: {
          mode: promptWindow.policy.mode,
          pruned: promptWindow.pruned,
          tokensBefore: promptWindow.tokensBefore,
          tokensAfter: promptWindow.tokensAfter,
          promptEntries: promptWindow.promptEntries.length,
          prunedEntries: promptWindow.prunedEntries.length,
          autoCompact: promptWindow.autoCompactEvent,
        },
        entries: [userEntry, eventEntry],
      }),
    };
  }

  if (method === "chat.abort") {
    const loadedConfig = loadGatewayConfig();
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "default";
    const source = gatewayTranscriptSource({ substrate: "gateway-rpc", channel: "webchat", chatType: "internal", senderId: params.senderId, threadId: params.threadId });
    const sessionKey = gatewaySessionKey({ config: loadedConfig.config, explicitSessionKey: params.sessionKey, agentId, substrate: "gateway-rpc", channel: "webchat", chatType: "internal", senderId: params.senderId, threadId: params.threadId });
    const abort = abortGatewayRuns(sessionKey, params.runId);
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: abort.aborted ? "Abort requested and active run aborted." : "Abort requested, but no active run was found.",
      source,
      metadata: {
        event: "abort_requested",
        source: "gateway-rpc",
        method: "chat.abort",
        runId: typeof params.runId === "string" ? params.runId : undefined,
        abortReason: abort.reason,
      },
    });
    return { status: 200, body: rpcSuccess(id, { ok: true, aborted: abort.aborted, reason: abort.reason, runs: abort.runs, entry }) };
  }

  return { status: 404, body: rpcError(id, "method_not_found", `Unknown Gateway RPC method: ${method}`) };
}

async function handleGatewayRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, rpcError(null, "invalid_json", error instanceof Error ? error.message : String(error)));
    return;
  }

  const result = await executeGatewayRpc(body as GatewayRpcRequest);
  sendJson(res, result.status, result.body);
}

function writeWebSocketFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    const length = BigInt(payload.length);
    header.push(
      127,
      Number((length >> 56n) & 0xffn),
      Number((length >> 48n) & 0xffn),
      Number((length >> 40n) & 0xffn),
      Number((length >> 32n) & 0xffn),
      Number((length >> 24n) & 0xffn),
      Number((length >> 16n) & 0xffn),
      Number((length >> 8n) & 0xffn),
      Number(length & 0xffn),
    );
  }
  socket.write(Buffer.concat([Buffer.from(header), payload]));
}

function writeWebSocketJson(socket: Socket, body: unknown): void {
  writeWebSocketFrame(socket, 0x1, Buffer.from(JSON.stringify(body), "utf-8"));
}

function closeWebSocket(socket: Socket, code = 1000, reason = ""): void {
  const reasonBuffer = Buffer.from(reason, "utf-8");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  writeWebSocketFrame(socket, 0x8, payload);
  socket.end();
}

function acceptWebSocket(req: IncomingMessage, socket: Socket): boolean {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !key.trim()) return false;
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  return true;
}

function rejectWebSocket(socket: Socket, status: number, message: string): void {
  const body = `${message}\n`;
  socket.write([
    `HTTP/1.1 ${status} ${message}`,
    "content-type: text/plain; charset=utf-8",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
    "",
    body,
  ].join("\r\n"));
  socket.end();
}

function authorizeGatewayUpgrade(req: IncomingMessage, socket: Socket): boolean {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath(process.env, paths);
  const loadedConfig = loadMindStoneConfig(configPath);
  const requirement = resolveGatewayAuthRequirement({
    config: loadedConfig.config?.gateway?.auth,
    configPath,
  });
  const decision = decideGatewayAuth(requirement, req.headers);
  if (decision.allowed) return true;
  rejectWebSocket(socket, decision.status, decision.reason);
  return false;
}

async function handleWebSocketText(socket: Socket, text: string): Promise<void> {
  let request: GatewayRpcRequest;
  try {
    request = JSON.parse(text) as GatewayRpcRequest;
  } catch (error) {
    writeWebSocketJson(socket, rpcError(null, "invalid_json", error instanceof Error ? error.message : String(error)));
    return;
  }

  const result = await executeGatewayRpc(request);
  writeWebSocketJson(socket, result.body);
}

function attachGatewayRpcWebSocket(socket: Socket): void {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          closeWebSocket(socket, 1009, "frame too large");
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      offset += maskLength;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x8) {
        closeWebSocket(socket);
        return;
      }
      if (opcode === 0x9) {
        writeWebSocketFrame(socket, 0xA, payload);
        continue;
      }
      if (opcode !== 0x1) {
        closeWebSocket(socket, 1003, "unsupported frame");
        return;
      }

      void handleWebSocketText(socket, payload.toString("utf-8")).catch((error: unknown) => {
        writeWebSocketJson(socket, rpcError(null, "internal_error", error instanceof Error ? error.message : String(error)));
      });
    }
  });
}

function handleGatewayUpgrade(req: IncomingMessage, socket: Socket): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/rpc" && url.pathname !== "/ws") {
    rejectWebSocket(socket, 404, "not found");
    return;
  }
  if (!authorizeGatewayUpgrade(req, socket)) return;
  if (!acceptWebSocket(req, socket)) {
    rejectWebSocket(socket, 400, "bad websocket request");
    return;
  }
  attachGatewayRpcWebSocket(socket);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "mindstone-agent-gateway",
      version: "0.0.0",
      paths: runtimePathsFromEnv(),
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/webchat" || url.pathname === "/webchat/")) {
    sendHtml(res, 200, WEBCHAT_UI_HTML);
    return;
  }

  if (!enforceGatewayAuth(req, res)) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    const status = getMindStoneSystemStatus();
    sendJson(res, status.ok ? 200 : 503, {
      service: "mindstone-agent-gateway",
      version: "0.0.0",
      ...status,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/rpc") {
    await handleGatewayRpc(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat/sessions") {
    sendJson(res, 200, {
      ok: true,
      sessions: listTranscriptSessions(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat/history") {
    const loadedConfig = loadGatewayConfig();
    const agentId = url.searchParams.get("agentId")?.trim() || "default";
    const sessionKey = gatewaySessionKey({
      config: loadedConfig.config,
      explicitSessionKey: url.searchParams.get("sessionKey"),
      agentId,
      substrate: "gateway-rest",
      channel: "webchat",
      chatType: "internal",
      senderId: url.searchParams.get("senderId"),
      threadId: url.searchParams.get("threadId"),
    });
    const limitText = url.searchParams.get("limit");
    const limit = limitText ? Number(limitText) : undefined;
    sendJson(res, 200, {
      ok: true,
      sessionKey,
      entries: readTranscriptEntries(sessionKey, Number.isFinite(limit) ? { limit } : {}),
    });
    return;
  }

  // App Engine / Agent Mesh: agent-scoped run route on the SHARED gateway (issue #14) —
  // one daemon serves many logically isolated agents; no per-agent gateway required.
  const agentRunsMatch = req.method === "POST" ? /^\/agents\/([^/]+)\/runs$/.exec(url.pathname) : null;
  if (agentRunsMatch) {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const input = body as Record<string, unknown>;
    const agentId = decodeURIComponent(agentRunsMatch[1]);
    const text = typeof input.input === "string" ? input.input : typeof input.text === "string" ? input.text : "";
    if (!text.trim()) {
      sendJson(res, 400, { ok: false, error: "input is required" });
      return;
    }
    const memoryScopeRaw = typeof input.memoryScope === "string" ? input.memoryScope : "agent";
    if (!["app", "tenant", "user", "agent", "none"].includes(memoryScopeRaw)) {
      sendJson(res, 400, { ok: false, error: `Invalid memoryScope: ${memoryScopeRaw} (expected app | tenant | user | agent | none)` });
      return;
    }
    const memoryScope = memoryScopeRaw as "app" | "tenant" | "user" | "agent" | "none";
    const scope = scopeFromRequest({
      appId: stringParam(input.appId),
      tenantId: stringParam(input.tenantId),
      userId: stringParam(input.userId),
      agentId,
    });
    const sessionKey = stringParam(input.sessionKey)?.trim() || scopedSessionKey(scope);
    const recallScope = recallScopeForMemoryScope(scope, memoryScope);
    const loadedConfig = loadGatewayConfig();
    const config = memoryScope === "none" && loadedConfig.config?.memory?.autoRecall
      ? { ...loadedConfig.config, memory: { ...loadedConfig.config.memory, autoRecall: false } }
      : loadedConfig.config;
    const metadata = typeof input.metadata === "object" && input.metadata !== null ? (input.metadata as Record<string, unknown>) : undefined;
    const source = gatewayTranscriptSource({ substrate: "gateway-app-engine", channel: "api", chatType: "internal", senderId: input.senderId, threadId: input.threadId });
    const userEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "user",
      text,
      source,
      metadata: { ...(metadata ?? {}), event: "user_message", appEngine: true, memoryScope, scope },
    });
    const personaId = stringParam(input.personaId);
    const workflowId = stringParam(input.workflowId);
    const routed = await runConfiguredRoute({
      sessionKey,
      agentId,
      config,
      configPath: loadedConfig.path,
      metadata: { ...(metadata ?? {}), appEngine: true, memoryScope },
      scope: scope as Record<string, string>,
      recallScope: recallScope as Record<string, string> | undefined,
      route: personaId || workflowId ? { personaId, workflowId } : undefined,
    });
    if (routed.routed) {
      sendJson(res, routed.status, { persisted: true, scope, memoryScope, sessionKey, userEntry, ...(routed.body as Record<string, unknown>) });
      return;
    }
    sendJson(res, 501, {
      ok: false,
      error: "No routable provider configured for App Engine runs (routing.mode placeholder)",
      code: "not_implemented",
      persisted: true,
      scope,
      memoryScope,
      sessionKey,
      entries: [userEntry],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/send") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const input = body as Record<string, unknown>;
    const loadedConfig = loadGatewayConfig();
    const agentId = typeof input.agentId === "string" && input.agentId.trim() ? input.agentId.trim() : "default";
    const source = gatewayTranscriptSource({ substrate: "gateway-rest", channel: "webchat", chatType: "internal", senderId: input.senderId, threadId: input.threadId });
    const sessionKey = gatewaySessionKey({ config: loadedConfig.config, explicitSessionKey: input.sessionKey, agentId, substrate: "gateway-rest", channel: "webchat", chatType: "internal", senderId: input.senderId, threadId: input.threadId });
    const text = typeof input.text === "string" ? input.text : "";
    if (!text.trim()) {
      sendJson(res, 400, { ok: false, error: "text is required" });
      return;
    }
    const metadata = typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : undefined;
    const userEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "user",
      text,
      source,
      metadata: { ...(metadata ?? {}), threadId: stringParam(input.threadId) },
    });
    const routed = await runConfiguredRoute({ sessionKey, agentId, config: loadedConfig.config, configPath: loadedConfig.path, metadata });
    if (routed.routed) {
      sendJson(res, routed.status, { persisted: true, userEntry, ...(routed.body as Record<string, unknown>) });
      return;
    }
    const promptWindow = maybeRecordPromptWindowEvent({ sessionKey, agentId, config: loadedConfig.config, metadata });
    const eventEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: "MindStone routing is not implemented yet; message persisted but no assistant run was started.",
      parentId: userEntry.id,
      source,
      metadata: { event: "routing_not_implemented", source: "gateway-rest", threadId: stringParam(input.threadId) },
    });
    sendJson(res, 501, {
      ok: false,
      error: "MindStone routing is not implemented yet",
      code: "not_implemented",
      persisted: true,
      promptWindow: {
        mode: promptWindow.policy.mode,
        pruned: promptWindow.pruned,
        tokensBefore: promptWindow.tokensBefore,
        tokensAfter: promptWindow.tokensAfter,
        promptEntries: promptWindow.promptEntries.length,
        prunedEntries: promptWindow.prunedEntries.length,
        autoCompact: promptWindow.autoCompactEvent,
      },
      entries: [userEntry, eventEntry],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/abort") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const input = body as Record<string, unknown>;
    const loadedConfig = loadGatewayConfig();
    const agentId = typeof input.agentId === "string" && input.agentId.trim() ? input.agentId.trim() : "default";
    const source = gatewayTranscriptSource({ substrate: "gateway-rest", channel: "webchat", chatType: "internal", senderId: input.senderId, threadId: input.threadId });
    const sessionKey = gatewaySessionKey({ config: loadedConfig.config, explicitSessionKey: input.sessionKey, agentId, substrate: "gateway-rest", channel: "webchat", chatType: "internal", senderId: input.senderId, threadId: input.threadId });
    const abort = abortGatewayRuns(sessionKey, input.runId);
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: abort.aborted ? "Abort requested and active run aborted." : "Abort requested, but no active run was found.",
      source,
      metadata: {
        event: "abort_requested",
        source: "gateway-rest",
        threadId: stringParam(input.threadId),
        runId: typeof input.runId === "string" ? input.runId : undefined,
        abortReason: abort.reason,
      },
    });
    sendJson(res, 202, {
      ok: true,
      aborted: abort.aborted,
      reason: abort.reason,
      runs: abort.runs,
      entry,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/inject") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const input = body as Record<string, unknown>;
    const loadedConfig = loadGatewayConfig();
    const agentId = typeof input.agentId === "string" && input.agentId.trim() ? input.agentId.trim() : "default";
    const source = gatewayTranscriptSource({ substrate: "gateway-rest", channel: "webchat", chatType: "internal", senderId: input.senderId, threadId: input.threadId });
    const sessionKey = gatewaySessionKey({ config: loadedConfig.config, explicitSessionKey: input.sessionKey, agentId, substrate: "gateway-rest", channel: "webchat", chatType: "internal", senderId: input.senderId, threadId: input.threadId });
    const role = input.role;
    if (!isTranscriptRole(role)) {
      sendJson(res, 400, { ok: false, error: "valid role is required" });
      return;
    }
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role,
      text: typeof input.text === "string" ? input.text : undefined,
      content: input.content,
      source,
      metadata: { ...(typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : {}), threadId: stringParam(input.threadId) },
    });
    sendJson(res, 201, { ok: true, entry });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const loadedConfig = loadGatewayConfig();
    if (loadedConfig.error) {
      sendJson(res, 503, openAiError(loadedConfig.error, "config_error", "config_error"));
      return;
    }
    if (!isOpenAiModelListEnabled(loadedConfig.config)) {
      sendJson(res, 404, openAiError("OpenAI-compatible HTTP surfaces are disabled", "disabled", "disabled"));
      return;
    }
    sendJson(res, 200, openAiModels(loadedConfig.config));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    const loadedConfig = loadGatewayConfig();
    if (loadedConfig.error) {
      sendJson(res, 503, openAiError(loadedConfig.error, "config_error", "config_error"));
      return;
    }
    if (!isOpenResponsesEnabled(loadedConfig.config)) {
      sendJson(res, 404, openAiError("OpenResponses-compatible HTTP is disabled", "disabled", "disabled"));
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, openAiError(error instanceof Error ? error.message : String(error), "invalid_request_error", "invalid_json"));
      return;
    }

    const input = body as Record<string, unknown>;
    const responseInputs = openResponsesInputToTranscriptInputs(input.input);
    if (responseInputs.length === 0 || responseInputs.every((entry) => !entry.text?.trim())) {
      sendJson(res, 400, openAiError("input must be a non-empty string or array", "invalid_request_error", "invalid_input"));
      return;
    }

    const metadata = typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : {};
    const model = typeof input.model === "string" ? input.model : "mindstone/default";
    const agentId = typeof metadata.agentId === "string" ? metadata.agentId : "default";
    const sessionKey = gatewaySessionKey({
      config: loadedConfig.config,
      explicitSessionKey: metadata.sessionKey,
      agentId,
      substrate: "openai",
      channel: "openai-responses",
      chatType: "internal",
      senderId: typeof input.user === "string" ? input.user : model,
    });
    const source = gatewayTranscriptSource({ substrate: "openai", channel: "openai-responses", chatType: "internal", senderId: typeof input.user === "string" ? input.user : model });
    const persistedEntries = responseInputs.map((entry) => appendTranscriptEntry({
      sessionKey,
      agentId,
      role: entry.role,
      text: entry.text,
      content: entry.content,
      source,
      metadata: {
        source: "openai-responses",
        model,
        ...entry.metadata,
      },
    }));

    const routed = await runConfiguredRoute({ sessionKey, agentId, config: loadedConfig.config, configPath: loadedConfig.path, metadata: { ...metadata, model } });
    if (routed.routed && routed.status === 200) {
      const routedBody = routed.body as { entry?: TranscriptEntry; identityContext?: unknown; promptWindow?: unknown; runId?: string };
      const outputText = routedBody.entry?.text ?? "";
      sendJson(res, 200, {
        id: `resp_${routedBody.runId ?? Date.now().toString(36)}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model,
        output: [
          {
            id: `msg_${routedBody.entry?.id ?? Date.now().toString(36)}`,
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: outputText }],
          },
        ],
        output_text: outputText,
        mindstone: {
          persisted: true,
          sessionKey,
          identityContext: routedBody.identityContext,
          promptWindow: routedBody.promptWindow,
          entries: [...persistedEntries, routedBody.entry].filter(Boolean),
        },
      });
      return;
    }
    if (routed.routed) {
      sendJson(res, routed.status, openAiError("MindStone routing failed", "routing_error", "routing_error"));
      return;
    }

    const promptWindow = maybeRecordPromptWindowEvent({ sessionKey, agentId, config: loadedConfig.config, metadata });
    const eventEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: "OpenResponses-compatible responses are not connected to MindStone routing yet.",
      source,
      metadata: { event: "routing_not_implemented", source: "openai-responses", model },
    });

    sendJson(res, 501, {
      ...openAiError(
        "OpenResponses-compatible responses are scaffolded but not connected to MindStone routing yet",
        "not_implemented",
        "not_implemented",
      ),
      mindstone: {
        persisted: true,
        sessionKey,
        promptWindow: {
          mode: promptWindow.policy.mode,
          pruned: promptWindow.pruned,
          tokensBefore: promptWindow.tokensBefore,
          tokensAfter: promptWindow.tokensAfter,
          promptEntries: promptWindow.promptEntries.length,
          prunedEntries: promptWindow.prunedEntries.length,
          autoCompact: promptWindow.autoCompactEvent,
        },
        entries: [...persistedEntries, eventEntry],
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const loadedConfig = loadGatewayConfig();
    if (loadedConfig.error) {
      sendJson(res, 503, openAiError(loadedConfig.error, "config_error", "config_error"));
      return;
    }
    if (!isChatCompletionsEnabled(loadedConfig.config)) {
      sendJson(res, 404, openAiError("OpenAI-compatible chat completions are disabled", "disabled", "disabled"));
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, openAiError(error instanceof Error ? error.message : String(error), "invalid_request_error", "invalid_json"));
      return;
    }

    const input = body as Record<string, unknown>;
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (messages.length === 0) {
      sendJson(res, 400, openAiError("messages must be a non-empty array", "invalid_request_error", "invalid_messages"));
      return;
    }

    const metadata = typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : {};
    const model = typeof input.model === "string" ? input.model : "mindstone/default";
    const agentId = typeof metadata.agentId === "string" ? metadata.agentId : "default";
    const sessionKey = gatewaySessionKey({
      config: loadedConfig.config,
      explicitSessionKey: metadata.sessionKey,
      agentId,
      substrate: "openai",
      channel: "openai-chat-completions",
      chatType: "internal",
      senderId: typeof input.user === "string" ? input.user : model,
    });

    const source = gatewayTranscriptSource({ substrate: "openai", channel: "openai-chat-completions", chatType: "internal", senderId: typeof input.user === "string" ? input.user : model });
    const persistedEntries = messages.map((message, index) => {
      const record = typeof message === "object" && message !== null ? message as Record<string, unknown> : {};
      return appendTranscriptEntry({
        sessionKey,
        agentId,
        role: openAiRoleToTranscriptRole(record.role),
        text: transcriptTextFromOpenAiContent(record.content),
        content: record.content,
        source,
        metadata: {
          source: "openai-chat-completions",
          model,
          messageIndex: index,
          originalRole: record.role,
        },
      });
    });
    const routed = await runConfiguredRoute({ sessionKey, agentId, config: loadedConfig.config, configPath: loadedConfig.path, metadata: { ...metadata, model } });
    if (routed.routed && routed.status === 200) {
      const routedBody = routed.body as { entry?: TranscriptEntry; identityContext?: unknown; promptWindow?: unknown; runId?: string };
      sendJson(res, 200, {
        id: `chatcmpl-${routedBody.runId ?? Date.now().toString(36)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: routedBody.entry?.text ?? "" },
            finish_reason: "stop",
          },
        ],
        mindstone: {
          persisted: true,
          sessionKey,
          identityContext: routedBody.identityContext,
          promptWindow: routedBody.promptWindow,
          entries: [...persistedEntries, routedBody.entry].filter(Boolean),
        },
      });
      return;
    }
    if (routed.routed) {
      sendJson(res, routed.status, openAiError("MindStone routing failed", "routing_error", "routing_error"));
      return;
    }

    const promptWindow = maybeRecordPromptWindowEvent({ sessionKey, agentId, config: loadedConfig.config, metadata });
    const eventEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: "OpenAI-compatible chat completions are not connected to MindStone routing yet.",
      source,
      metadata: { event: "routing_not_implemented", source: "openai-chat-completions", model },
    });

    sendJson(res, 501, {
      ...openAiError(
        "OpenAI-compatible chat completions are scaffolded but not connected to MindStone routing yet",
        "not_implemented",
        "not_implemented",
      ),
      mindstone: {
        persisted: true,
        sessionKey,
        promptWindow: {
          mode: promptWindow.policy.mode,
          pruned: promptWindow.pruned,
          tokensBefore: promptWindow.tokensBefore,
          tokensAfter: promptWindow.tokensAfter,
          promptEntries: promptWindow.promptEntries.length,
          prunedEntries: promptWindow.prunedEntries.length,
          autoCompact: promptWindow.autoCompactEvent,
        },
        entries: [...persistedEntries, eventEntry],
      },
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

// ---------------------------------------------------------------------------
// Connector runtime (issue #16): starts configured connectors' inbound
// listeners, pipes allowed+triggered messages through the standard route path,
// and delivers replies via the persistent per-connector queue. Every failure
// is isolated into the connector's runtime status — a broken connector never
// crashes the Gateway.
// ---------------------------------------------------------------------------

type RunningConnector = {
  connectorId: string;
  handle: ConnectorInboundHandle;
  inboundCount: number;
  deniedCount: number;
  /** Periodic re-drain so queued deliveries retry without waiting for new inbound traffic. */
  drainTimer?: ReturnType<typeof setInterval>;
};

const runningConnectors = new Map<string, RunningConnector>();

async function handleConnectorInbound(params: {
  connectorId: string;
  ctx: ConnectorContext;
  message: ConnectorInboundMessage;
  running: RunningConnector;
}): Promise<void> {
  const { connectorId, ctx, message, running } = params;
  running.inboundCount += 1;
  const channelConfig = ctx.channelConfig;

  const access = evaluateConnectorAccess(connectorAccessPolicyFromChannelConfig(channelConfig), message);
  if (!access.allowed) {
    running.deniedCount += 1;
    writeConnectorRuntimeStatus({
      connectorId,
      state: "running",
      inboundCount: running.inboundCount,
      deniedCount: running.deniedCount,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const trigger = shouldTriggerConnectorReply(connectorTriggerPolicyFromChannelConfig(channelConfig), message);
  const agentId = ctx.config?.routing?.defaultAgentId ?? "default";
  const sessionKey = connectorSessionKey({ config: ctx.config, connectorId, agentId, message });
  const source = connectorTranscriptSource({ connectorId, message });

  appendTranscriptEntry({
    sessionKey,
    agentId,
    role: "user",
    text: trigger.text || message.text,
    source,
    metadata: {
      event: "user_message",
      connector: connectorId,
      messageId: message.messageId,
      threadId: message.threadId,
      triggered: trigger.respond,
      triggerReason: trigger.reason,
    },
  });
  writeConnectorRuntimeStatus({
    connectorId,
    state: "running",
    inboundCount: running.inboundCount,
    deniedCount: running.deniedCount,
    updatedAt: new Date().toISOString(),
  });
  if (!trigger.respond) return;

  const loadedConfig = loadGatewayConfig();
  const routed = await runConfiguredRoute({
    sessionKey,
    agentId,
    config: loadedConfig.config,
    configPath: loadedConfig.path,
    metadata: { connector: connectorId },
  });
  if (!routed.routed) return;
  const body = routed.body as { entry?: { text?: string } } | undefined;
  const replyText = body?.entry?.text;
  if (!replyText?.trim()) return;

  const queue = new ConnectorDeliveryQueue(connectorId);
  queue.enqueue(
    {
      text: replyText,
      chatId: message.chatId,
      threadId: message.threadId,
      inReplyToMessageId: message.messageId,
      metadata: { chatType: message.chatType ?? "direct" },
    },
    { now: new Date().toISOString() },
  );
  const connector = getConnector(connectorId);
  if (!connector) return;
  await queue.drain((entry) => connector.sendOutbound(ctx, entry.message), { now: new Date().toISOString() });
}

export async function startConfiguredConnectors(): Promise<void> {
  const loadedConfig = loadGatewayConfig();
  const channels = (loadedConfig.config?.channels ?? {}) as Record<string, Record<string, unknown>>;
  for (const connectorId of configuredConnectorIds(loadedConfig.config)) {
    const connector = getConnector(connectorId);
    if (!connector) {
      writeConnectorRuntimeStatus({
        connectorId,
        state: "error",
        lastError: `no registered connector implementation for "${connectorId}"`,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }
    try {
      const channelConfig = channels[connectorId] ?? {};
      const ref = connectorCredentialRefFromChannelConfig(channelConfig);
      let credential: string | undefined;
      if (ref) {
        const resolved = resolveConnectorCredential(ref);
        if (!resolved.present) {
          writeConnectorRuntimeStatus({
            connectorId,
            state: "error",
            lastError: `credential unresolved: ${resolved.error}`,
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        credential = resolved.value;
      }
      const ctx: ConnectorContext = { config: loadedConfig.config, channelConfig, credential };
      const running: RunningConnector = { connectorId, handle: { stop: () => undefined }, inboundCount: 0, deniedCount: 0 };
      running.handle = await connector.startInbound(ctx, (message) =>
        handleConnectorInbound({ connectorId, ctx, message, running }).catch((error) => {
          writeConnectorRuntimeStatus({
            connectorId,
            state: "running",
            lastError: `inbound handling failed: ${error instanceof Error ? error.message : String(error)}`,
            inboundCount: running.inboundCount,
            deniedCount: running.deniedCount,
            updatedAt: new Date().toISOString(),
          });
        }),
      );
      runningConnectors.set(connectorId, running);
      const drainMs = typeof channelConfig.queueDrainMs === "number" && channelConfig.queueDrainMs > 0 ? channelConfig.queueDrainMs : 5000;
      running.drainTimer = setInterval(() => {
        const queue = new ConnectorDeliveryQueue(connectorId);
        if (queue.pending().length === 0) return;
        void queue.drain((entry) => connector.sendOutbound(ctx, entry.message), { now: new Date().toISOString() }).catch(() => undefined);
      }, drainMs);
      running.drainTimer.unref?.();
      writeConnectorRuntimeStatus({
        connectorId,
        state: "running",
        startedAt: new Date().toISOString(),
        inboundCount: 0,
        deniedCount: 0,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      writeConnectorRuntimeStatus({
        connectorId,
        state: "error",
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

export async function stopConfiguredConnectors(): Promise<void> {
  for (const [connectorId, running] of runningConnectors) {
    try {
      if (running.drainTimer) clearInterval(running.drainTimer);
      await running.handle.stop();
      const previous = readConnectorRuntimeStatus(connectorId);
      writeConnectorRuntimeStatus({
        ...previous,
        connectorId,
        state: "stopped",
        stoppedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // stopping best-effort; status keeps the last known state
    }
  }
  runningConnectors.clear();
}

export async function startGateway(options: GatewayOptions = {}): Promise<{ close(): Promise<void>; url: string }> {
  const host = options.host ?? process.env.MINDSTONE_AGENT_GATEWAY_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.MINDSTONE_AGENT_GATEWAY_PORT ?? "19789");
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.on("upgrade", (req, socket) => {
    handleGatewayUpgrade(req, socket as Socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Connector failures are isolated into per-connector runtime status; the
  // HTTP surface is up regardless.
  await startConfiguredConnectors().catch(() => undefined);
  return {
    url: `http://${host}:${port}`,
    close: async () => {
      await stopConfiguredConnectors();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
