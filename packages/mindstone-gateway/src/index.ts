import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, openSync, closeSync, fsyncSync, readSync, fstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { MockMindStoneProvider } from "./mock-provider.js";
import {
  maskUrlCredentials,
  resolveAdminDigest,
  AdminPatchError,
  adminPermissionsPath,
  adminStatus,
  changedPaths,
  configEtag,
  decideAdminAccess,
  EDITABLE_SECTIONS,
  onboardingSteps,
  ADVANCED_GRANT_MS,
  effectivePermissions,
  ifMatchSatisfied,
  isAdvancedChange,
  jsonDepth,
  MAX_PATCH_DEPTH,
  maskConfig,
  maskInlineSecrets,
  mergeConfigPatch,
  type AdminPermissions,
} from "./admin-api.js";
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
  assertNoUnexpectedPiBuiltinTools,
  piSessionEnabledBuiltinTools,
  piSessionExcludedBuiltinTools,
  PI_BUILTIN_TOOL_NAMES,
  PI_ENABLEABLE_BUILTIN_TOOL_NAMES,
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
export { DISCORD_CONNECTOR, DISCORD_LEAST_PRIVILEGE_INTENTS, discordMessageToInbound } from "./connectors/discord.js";
export {
  EMAIL_CONNECTOR,
  GmailProvider,
  buildReplyMime,
  gmailMessageBody,
  gmailMessageToInbound,
  parseEmailAddress,
  threadDigestFromMessages,
} from "./connectors/email.js";
export {
  CALENDAR_CONNECTOR,
  GoogleCalendarProvider,
  calendarProviderFromContext,
  formatUpcomingEvents,
  mutationFromOutbound,
  validateCalendarMutation,
} from "./connectors/calendar.js";
import "./connectors/loopback.js";
import "./connectors/telegram.js";
import "./connectors/slack.js";
import "./connectors/discord.js";
import "./connectors/email.js";
import "./connectors/calendar.js";
import {
  loadRoutePersonaContextById,
  personasDirFromConfig,
  referencedPersonaIds,
  PERSONA_PROPOSAL_INSTRUCTIONS,
  discoverMindStonePersonas,
  resolveRoutePersonaContext,
  runMindStoneWorkflow,
  appendTranscriptEntry,
  buildPromptWindow,
  createLocalMemoryRecallProvider,
  createSqliteMemoryRecallProvider,
  indexSqliteMemoryTurn,
  transcriptPathForSession,
  decideGatewayAuth,
  discoverFileMemoryDocuments,
  discoverKnowledgebaseRecallDocuments,
  recallScopeForMemoryScope,
  scopeFromRequest,
  scopedSessionKey,
  invalidScopeFields,
  scopeSessionKeyAllowed,
  ApprovalStore,
  ApprovalActionError,
  approveProposedAction,
  checkApprovable,
  rejectProposedAction,
  resolveDefaultSessionKey,
  type ProposedAction,
  ConnectorDeliveryQueue,
  getMindStoneDoctorReport,
  probeMemoryEmbeddingProvider,
  resolveMemoryEmbeddingProviderConfig,
  buildIdentityFormationPrompt,
  isPendingMindStoneIdentity,
  writeOnboardingIdentityScaffold,
  getBuiltInMindStoneProfile,
  type MindStoneIdentityFormationPrompt,
  applyActionProposalDiscipline,
  configuredConnectorIds,
  connectorAccessPolicyFromChannelConfig,
  resolveConnectorSendPolicy,
  connectorCredentialRefFromChannelConfig,
  connectorSessionKey,
  connectorTranscriptSource,
  connectorTriggerPolicyFromChannelConfig,
  evaluateConnectorAccess,
  getConnector,
  readConnectorRuntimeStatus,
  resolveConnectorCredential,
  shouldTriggerConnectorReply,
  isConnectorOwnerMessage,
  writeConnectorRuntimeStatus,
  type ConnectorContext,
  type ConnectorInboundHandle,
  type ConnectorOutboundMessage,
  type ConnectorInboundMessage,
  getMindStoneSystemStatus,
  listTranscriptSessions,
  loadMindStoneConfig,
  validateMindStoneConfig,
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
  resolveConnectorSecretPath,
  type MindStoneRuntimePaths,
  LOCAL_PROVIDER_PRESETS,
  type LocalProviderPresetId,
  literalConfigValue,
  probeOpenAiCompatibleModels,
  readIsolatedModelsConfig,
  upsertIsolatedProvider,
  buildMindStoneSkillDraft,
  builtinMindStoneSkills,
  discoverMindStoneSkills,
  installMindStoneSkill,
  loadMindStoneSkill,
  loadMindStoneSkillArtifact,
  parseSkillProposal,
  buildMindStoneSkillsPrompt,
  skillDraftsDir,
  skillsDirFromConfig,
  validateSkillId,
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

/** Write one OpenAI-style streamed chat completion: a content chunk, a stop chunk, then [DONE]. */
export function openAiStreamFrames(input: { id: string; model: string; content: string }): string[] {
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({ id: input.id, object: "chat.completion.chunk", created, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return [chunk({ role: "assistant", content: input.content }, null), chunk({}, "stop"), "data: [DONE]\n\n"];
}

function sendOpenAiStream(res: ServerResponse, input: { id: string; model: string; content: string }): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  for (const frame of openAiStreamFrames(input)) res.write(frame);
  res.end();
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
  /** The run's App Engine scope, stamped on each event so backfill labels it with its own run (#62). */
  scope?: Record<string, string>;
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
      metadata: { ...runnerStreamEventMetadata(event), ...(input.scope ? { scope: input.scope } : {}) },
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
      builtinTools: config?.routing?.pi?.builtinTools,
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

/**
 * Who a route answers (#61, #70). "owner": the owner's own surfaces and
 * verified direct messages. "non_owner": group/channel turns, other senders,
 * unverified senders. "tenant": an App Engine run scoped to an app, tenant or
 * user; it gets the non-owner treatment for the owner's context (no USER.md,
 * memory index, private invariants or handoff) but keeps its scoped recall.
 */
type RouteAudience = "owner" | "non_owner" | "tenant";

/**
 * PiSessionAgentRunner options for one turn. A non-owner turn gets none of
 * the owner's Pi resources (#61): no installed or extra extensions (the
 * MindStone adapter injects USER.md, recall and memory tools), skills, prompt
 * templates (a `/name` message would expand the owner's), context files or
 * built-in tools. MindStone's own pruning/compaction extensions still
 * run.
 */
export function piSessionRunnerOptions(
  config: MindStoneConfig | undefined,
  audience: RouteAudience,
): ConstructorParameters<typeof PiSessionAgentRunner>[0] {
  const paths = runtimePathsFromEnv();
  const options: ConstructorParameters<typeof PiSessionAgentRunner>[0] = {
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
    builtinTools: config?.routing?.pi?.builtinTools,
  };
  if (audience === "owner") return options;
  return {
    ...options,
    noDiscoveredExtensions: true,
    additionalExtensionPaths: [],
    additionalSkillPaths: [],
    additionalPromptTemplatePaths: [],
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    builtinTools: [],
  };
}

function resolveRunner(
  config: MindStoneConfig | undefined,
  provider: MindStoneModelProvider,
  audience: RouteAudience = "owner",
): AgentRunner {
  if (resolveRoutingMode(config) === "pi-session") return new PiSessionAgentRunner(piSessionRunnerOptions(config, audience));
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

/** Personas as models: one entry per configured agent, `mindstone/<agentId>`, so an OpenAI-compatible
 *  client's model picker is the persona selector. An agent's `defaultModel` and `routing.defaultModel`
 *  are listed too when they differ, for clients that were configured against them. */
function openAiModels(config: MindStoneConfig | undefined): unknown {
  const agents = config?.agents ?? {};
  const ids: string[] = [];
  const push = (id: string | undefined): void => { if (id && !ids.includes(id)) ids.push(id); };
  for (const [agentId, agent] of Object.entries(agents)) { push(`mindstone/${agentId}`); push(agent.defaultModel); }
  push(config?.routing?.defaultModel);
  if (ids.length === 0) ids.push("mindstone/default");
  return { object: "list", data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "mindstone-agent" })) };
}

/** `mindstone/<agentId>` names a configured agent; anything else falls back to the metadata or the default. */
export function agentIdFromModel(config: MindStoneConfig | undefined, model: string, metadataAgentId: unknown): string {
  if (typeof metadataAgentId === "string" && metadataAgentId) return metadataAgentId;
  const m = /^mindstone\/([A-Za-z0-9_.-]+)$/.exec(model);
  if (m && config?.agents && Object.prototype.hasOwnProperty.call(config.agents, m[1])) return m[1];
  return "default";
}

/**
 * The recall index follows the conversation (#106): after each reply, the
 * turn's transcript is indexed (and embedded) in the background, one update
 * at a time, so a new chat can recall what an earlier one said without a
 * manual backfill. A failed update is logged and retried with the next turn,
 * since unembedded chunks are picked up then.
 */
let recallIndexTail: Promise<void> = Promise.resolve();

function queueRecallIndex(config: MindStoneConfig | undefined, sessionKey: string): void {
  if (config?.memory?.vectorStore !== "sqlite-vec") return;
  const transcriptFile = transcriptPathForSession(sessionKey);
  recallIndexTail = recallIndexTail
    .then(async () => {
      await indexSqliteMemoryTurn({ transcriptFile, config });
    })
    .catch((error: unknown) => {
      console.warn(`[mindstone] recall index update failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** Wait for queued recall index updates, at most `ms`: recall never hangs on a slow embedder. */
async function awaitRecallIndex(ms = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    recallIndexTail,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Identity a front end forwards on behalf of its logged-in user (LibreChat can set these from
 *  {{LIBRECHAT_USER_ID}} / {{LIBRECHAT_USER_ROLE}} / {{LIBRECHAT_BODY_CONVERSATIONID}} placeholders). */
function forwardedUser(req: IncomingMessage): { userId?: string; userRole?: string; conversationId?: string } {
  const h = (name: string): string | undefined => { const v = req.headers[name]; const s = Array.isArray(v) ? v[0] : v; return s && s.trim() ? s.trim() : undefined; };
  return { userId: h("x-mindstone-user-id"), userRole: h("x-mindstone-user-role"), conversationId: h("x-mindstone-conversation-id") };
}

/**
 * Who a Console-facing turn answers, and in which session (#103). Chat
 * completions and /v1/responses both use it, so a Console user can't reach
 * the owner through either (#112 review).
 * - A Console admin is the owner; any other Console user, or a role header
 *   left blank, gets the non-owner context, as a connector's non-owner does.
 *   A direct caller with the service token and no role header is the owner.
 * - A non-owner can't choose its session or agent (metadata.sessionKey or
 *   agentId), is known only by the forwarded user id (never the body's
 *   `user`, which could name the owner), is keyed apart from the same user's
 *   owner sessions, and without a conversation id gets its own session
 *   rather than the owner's main one.
 */
function consoleTurnCaller(req: IncomingMessage, input: Record<string, unknown>, config: MindStoneConfig | undefined, channel: string):
  | { error: string }
  | {
      forwarded: ReturnType<typeof forwardedUser>;
      roleHeaderSent: boolean;
      audience: RouteAudience;
      metadata: Record<string, unknown>;
      model: string;
      agentId: string;
      senderId: string;
      sessionKey: string;
    } {
  const forwarded = forwardedUser(req);
  const roleHeaderSent = req.headers["x-mindstone-user-role"] !== undefined;
  const audience: RouteAudience = forwarded.userRole
    ? (forwarded.userRole.toLowerCase() === "admin" ? "owner" : "non_owner")
    : roleHeaderSent ? "non_owner" : "owner";
  const requestMetadata = typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : {};
  const metadata0 = audience === "owner"
    ? requestMetadata
    : Object.fromEntries(Object.entries(requestMetadata).filter(([key]) => key !== "sessionKey" && key !== "agentId"));
  const metadata: Record<string, unknown> = { ...metadata0, ...(forwarded.userRole ? { userRole: forwarded.userRole } : {}), ...(forwarded.conversationId ? { conversationId: forwarded.conversationId } : {}) };
  const model = typeof input.model === "string" ? input.model : "mindstone/default";
  const agentId = agentIdFromModel(config, model, metadata.agentId);
  if (audience !== "owner" && !forwarded.userId) return { error: "a Console user's turn needs x-mindstone-user-id" };
  const senderId = audience === "owner"
    ? forwarded.userId ?? (typeof input.user === "string" ? input.user : model)
    : `non-owner:${forwarded.userId}`;
  // Each Console conversation is its own session (#38), so separate chats don't
  // share a context window. They are all the same agent's transcripts, so the
  // memory backfill indexes every one into that agent's memory.
  const sessionKey = gatewaySessionKey({
    config,
    explicitSessionKey: metadata.sessionKey ?? (forwarded.conversationId
      ? consoleConversationSessionKey(senderId, forwarded.conversationId)
      : audience === "owner" ? undefined : consoleConversationSessionKey(senderId, "no-conversation")),
    agentId,
    substrate: "openai",
    channel,
    chatType: "internal",
    senderId,
  });
  return { forwarded, roleHeaderSent, audience, metadata, model, agentId, senderId, sessionKey };
}

/**
 * A transcript entry as a response returns it: a non-owner doesn't see which
 * persona answered or why (its route or workflow step); the transcript on
 * disk keeps it (#105 review).
 */
function entryForAudience(entry: TranscriptEntry | undefined, audience: RouteAudience): TranscriptEntry | undefined {
  if (!entry || audience === "owner" || !entry.metadata || !("personaContext" in entry.metadata)) return entry;
  const { personaContext: _hidden, ...metadata } = entry.metadata;
  return { ...entry, metadata };
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

/** Session key for one MindStone Console conversation (#38). */
/**
 * Session key for one MindStone Console conversation (#38). Keyed by user and
 * conversation, not by persona or config: switching persona (model) or
 * changing routing.defaultAgentId keeps the conversation's history. The key
 * uses a fixed "console" namespace in the agent:<id>:… form; the persona
 * answering each turn is still recorded on every transcript entry. Parts
 * whose encoded form is over 64 characters are hashed, so the transcript
 * filename stays within filesystem limits.
 */
export function consoleConversationSessionKey(userId: string, conversationId: string): string {
  const part = (value: string) => {
    const encoded = encodeURIComponent(value);
    return encoded.length > 64 ? `h-${createHash("sha256").update(value).digest("hex").slice(0, 32)}` : encoded;
  };
  return ["agent", "console", "console", part(userId), part(conversationId)].join(":");
}

/** The session a handoff was written from (its "- Session: …" line), if any. */
export function handoffSessionKey(text: string): string | undefined {
  return /^- Session: (.+)$/m.exec(text)?.[1]?.trim();
}

/**
 * Index of the first message of the new turn in an OpenAI-style messages
 * array: the trailing run of user messages (#38). Everything before it is
 * history the gateway already has, apart from client system prompts, which
 * are handled separately. Returns messages.length when the array doesn't end
 * in a user message.
 */
export function newChatCompletionsTurnStart(messages: unknown[]): number {
  let start = messages.length;
  while (start > 0) {
    const record = messages[start - 1];
    const role = typeof record === "object" && record !== null ? (record as Record<string, unknown>).role : undefined;
    // A message with no role is a user message, as openAiRoleToTranscriptRole treats it.
    if (role !== "user" && role !== undefined) break;
    start -= 1;
  }
  return start;
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

/** A non-owner turn keeps the agent's IDENTITY.md but not the owner's USER.md (#61). */
function withoutOwnerProfile(
  context: ReturnType<typeof loadRouteIdentityContext>,
  audience: RouteAudience,
): ReturnType<typeof loadRouteIdentityContext> {
  if (!context || audience === "owner") return context;
  return { ...context, userMarkdown: undefined, userPath: undefined };
}

/** Where the gateway records that an agent's identity formation has started (#102). */
function identityFormationMarker(agentId: string): string {
  return join(runtimePathsFromEnv().dataDir, "identity-formation", `${encodeURIComponent(agentId)}.json`);
}

/**
 * The identity-formation prompt for this turn (#102), when: setup has
 * finished (onboarding.identity is set), the agent is a configured one, its
 * IDENTITY.md is still the pending scaffold (or the initializer placeholder,
 * or missing), this is the session's first turn, and the agent's formation
 * hasn't started. The caller claims the marker before the turn runs.
 */
function pendingIdentityFormation(config: MindStoneConfig | undefined, configPath: string | undefined, agentId: string, sessionKey: string): MindStoneIdentityFormationPrompt | undefined {
  if (!config?.onboarding?.identity) return undefined;
  if (!config.agents || !Object.hasOwn(config.agents, agentId)) return undefined;
  if (existsSync(identityFormationMarker(agentId))) return undefined;
  // An agent that already has a real identity isn't sent back to formation
  // (an install onboarded before this gateway recorded the marker).
  // Read the file where the scaffold writer puts it (the default path when
  // identityPath is unset), not through the identity loader, which needs both
  // files configured.
  const identityPath = config.agents[agentId]?.identityPath ?? `agents/${agentId}/IDENTITY.md`;
  const resolvedIdentity = isAbsolute(identityPath) ? identityPath : resolvePath(dirname(configPath ?? join(runtimePathsFromEnv().dataDir, "config.json")), identityPath);
  let identity: string | undefined;
  try {
    identity = readFileSync(resolvedIdentity, "utf-8");
  } catch {
    // Missing or unreadable: treated as pending.
  }
  if (identity?.trim() && !isPendingMindStoneIdentity(identity)) return undefined;
  return buildIdentityFormationPrompt({ agentId, entries: readTranscriptEntries(sessionKey), config });
}

/**
 * Claim the agent's formation turn before it runs, exclusively, so two first
 * conversations at once don't both start it. False when already claimed.
 */
function claimIdentityFormation(agentId: string, sessionKey: string): boolean {
  const marker = identityFormationMarker(agentId);
  try {
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${JSON.stringify({ agentId, sessionKey, promptedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** A formation turn that didn't complete gives the claim back, so the next conversation starts it. */
function releaseIdentityFormation(agentId: string): void {
  try {
    unlinkSync(identityFormationMarker(agentId));
  } catch {
    // Already gone.
  }
}

async function runConfiguredRoute(input: {
  sessionKey: string;
  agentId: string;
  /**
   * Who the turn answers (#61, #70). "owner": the owner's own surfaces
   * (webchat, REST, OpenAI endpoints, agent-only App Engine runs) and verified
   * direct messages. "non_owner": other connector turns; no autoRecall, USER.md,
   * memory index, owner-only invariants or handoff. "tenant": an app-, tenant-
   * or user-scoped App Engine run; like non_owner but keeps its scoped recall.
   * Required so no caller can leave it to a default.
   */
  audience: RouteAudience;
  config: MindStoneConfig | undefined;
  configPath?: string;
  metadata?: Record<string, unknown>;
  /** App Engine / Agent Mesh scope — enforced on memory recall for this run. */
  scope?: Record<string, string>;
  /** Recall filter override when the memory scope is broader than the run scope. */
  recallScope?: Record<string, string>;
  /** Deterministic request-level routing: forced persona wins over workflow decisions; forced workflow bypasses selection. */
  route?: { personaId?: string; workflowId?: string };
  /** The first-activation identity-formation prompt, for an owner's first turn (#102). */
  identityFormation?: MindStoneIdentityFormationPrompt;
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
  // The handoff is the verbatim tail of an owner session: never replayed into
  // a non-owner turn (#61) or a scoped App Engine / tenant run (#62).
  // A handoff is replayed only into the session that wrote it (#38): with a
  // session per Console conversation, a runtime-wide replay would hand one
  // conversation's tail to every new one.
  const handoffReplay = input.audience === "owner" && !input.scope && currentHandoff
    && handoffSessionKey(currentHandoff.text) === input.sessionKey
    && !hasReplayedHandoff(entries, currentHandoff.sha256)
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
    // A turn indexed a moment ago is findable now: recall waits (briefly) for
    // the index updates already queued (#106).
    if ((input.audience === "owner" || input.audience === "tenant") && input.config?.memory?.autoRecall === true) {
      await awaitRecallIndex();
    }
    // Walked once and shared: the recall provider and the invariant tier both
    // read the same files, and the tier must not depend on the vector store.
    const fileMemoryDocuments = discoverFileMemoryDocuments({ config: input.config });
    const runner = resolveRunner(input.config, provider, input.audience);
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
        identityContext: withoutOwnerProfile(
          loadRouteIdentityContext({ agentId: input.agentId, config: input.config, configPath: input.configPath }),
          input.audience,
        ),
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
        identityFormation: input.audience === "owner" ? input.identityFormation : undefined,
        ownerInstructions: input.audience === "owner" && !input.scope ? PERSONA_PROPOSAL_INSTRUCTIONS : undefined,
        memoryRecall: {
          enabled: (input.audience === "owner" || input.audience === "tenant") && input.config?.memory?.autoRecall === true,
          provider: input.config?.memory?.vectorStore === "sqlite-vec"
            ? createSqliteMemoryRecallProvider({ config: input.config }) ?? createLocalMemoryRecallProvider([
                ...(input.config?.memory?.localDocuments ?? []),
                ...fileMemoryDocuments,
                ...discoverKnowledgebaseRecallDocuments({ config: input.config }),
              ])
            : createLocalMemoryRecallProvider([
                ...(input.config?.memory?.localDocuments ?? []),
                ...fileMemoryDocuments,
                ...discoverKnowledgebaseRecallDocuments({ config: input.config }),
              ]),
          config: input.config?.memory?.recall,
          scope: input.recallScope ?? input.scope,
        },
        invariants: {
          enabled: input.config?.memory?.invariants?.enabled !== false,
          // Owner-authored rules reach a non-owner turn only when marked
          // `invariant_audience: all` (#61).
          documents: [...(input.config?.memory?.localDocuments ?? []), ...fileMemoryDocuments].filter(
            (document) => input.audience === "owner" || document.metadata?.invariantAudience === "all",
          ),
          maxPromptTokens: input.config?.memory?.invariants?.maxPromptTokens,
        },
        memoryIndex: {
          enabled: input.audience === "owner" && input.config?.memory?.index?.enabled !== false,
          documents: fileMemoryDocuments,
          maxPromptTokens: input.config?.memory?.index?.maxPromptTokens,
        },
        // Installed skills, and how to propose one (#104): the owner's turns only.
        skills: { enabled: input.audience === "owner", skillsDir: skillsDirFromConfig(input.config) },
        signal: run.abortController.signal,
        metadata: input.metadata,
        runContext: {
          runId: run.id,
          surface: source?.substrate ?? "gateway",
          metadata: input.metadata,
        },
      },
    });

    if (route.identityFormation?.enabled) {
      appendTranscriptEntry({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        role: "event",
        text: "Injected first-activation identity formation prompt into context.",
        runId: run.id,
        source,
        metadata: { event: "identity_formation_prompted", mode: route.identityFormation.mode, durable: false },
      });
    }
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
        // A non-owner session never writes the shared handoff file (#61).
        event: input.audience === "owner"
          ? route.promptWindow.autoCompactEvent
          : { ...route.promptWindow.autoCompactEvent, emergencyAutoHandoff: false },
        entries: route.promptWindow.entries,
        runId: run.id,
        source,
        config: input.config,
        runner,
        model,
        signal: run.abortController.signal,
      });
    }

    if (route.invariants && route.invariants.total > 0) {
      const { full, degraded, omitted, total } = route.invariants;
      appendTranscriptEntry({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        role: "event",
        text: `Injected ${full} of ${total} always-in-force rule(s) in full${degraded ? `, ${degraded} shortened` : ""}${omitted ? `, ${omitted} omitted` : ""}.`,
        runId: run.id,
        source,
        metadata: {
          event: "memory_invariants_injected",
          full,
          degraded,
          omitted,
          total,
          promptTokens: route.invariants.tokens,
          admissions: route.invariants.admissions,
        },
      });
    }

    if (route.memoryIndex && route.memoryIndex.total > 0) {
      const { full, degraded, omitted, total } = route.memoryIndex;
      appendTranscriptEntry({
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        role: "event",
        text: `Injected the memory index: ${full} of ${total} entries in full${degraded ? `, ${degraded} shortened` : ""}${omitted ? `, ${omitted} omitted` : ""}.`,
        runId: run.id,
        source,
        metadata: {
          event: "memory_index_injected",
          full,
          degraded,
          omitted,
          total,
          promptTokens: route.memoryIndex.tokens,
        },
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
      scope: input.scope,
    });

    // Action-proposal discipline (issues #21/#22) — same shared step as the
    // core chat turn: proposal blocks become pending ProposedActions + audit
    // events; the assistant entry gets the stripped text.
    const proposalDiscipline = applyActionProposalDiscipline({
      replyText: route.result.text,
      content: route.result.content,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      origin: source?.substrate ?? "gateway",
      source,
      runId: run.id,
      // Only the owner's turns may propose a persona (#105).
      allowPersona: input.audience === "owner" && !input.scope,
      allowSkill: input.audience === "owner",
    });

    const assistantEntry = appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "assistant",
      text: proposalDiscipline.text,
      content: proposalDiscipline.content,
      source,
      runId: run.id,
      metadata: {
        event: "assistant_response",
        provider: provider.id,
        model: model.id,
        usage: route.result.usage,
        runner: route.runner,
        // Which persona answered (#105): the Console's transcripts say so per turn.
        ...(route.personaContext ? { personaContext: route.personaContext } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        providerDiagnostics: providerDiagnosticsFromChatResult(route.result),
      },
    });
    runManager.complete(run.id);
    queueRecallIndex(input.config, input.sessionKey);

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
      metadata: { event: "routing_failed", provider: provider.id, model: model.id, ...(input.scope ? { scope: input.scope } : {}) },
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
    const routed = await runConfiguredRoute({ sessionKey, agentId, audience: "owner", config: loadedConfig.config, configPath: loadedConfig.path });
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

/** The Console's admin API (#38, P2): status, masked config, section patches, secrets, the advanced permission. */
async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath(process.env, paths);
  const gateConfig = loadMindStoneConfig(configPath);
  const gate = decideAdminAccess({ config: gateConfig.config, configPath, headers: req.headers });
  const userId = forwardedUser(req).userId;
  if (!gate.allowed) {
    // Only callers past the admin credential are audited: a 404 means there is
    // no admin API, and auditing 401s would let any service-token holder grow
    // the log (#38 review).
    if (gate.status === 403) appendAdminAudit(paths.dataDir, { userId: userId ?? null, action: "refused", status: gate.status, method: req.method, path: url.pathname });
    sendJson(res, gate.status, { ok: false, error: gate.error });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/status") {
    // supervisor and startedAt (#90): whether the Console can restart this
    // gateway, and a way to see that a restart happened.
    const supervisor = declaredSupervisor();
    const evidence = supervisor ? supervisorEvidence(supervisor, paths) : undefined;
    sendJson(res, 200, {
      ...adminStatus(gateConfig.config),
      supervisor: supervisor ?? null,
      ...(evidence ? { supervisorConfirmed: evidence.ok, supervisorDetail: evidence.detail } : {}),
      startedAt: GATEWAY_STARTED_AT,
      recentStarts: recentGatewayStarts(paths).length,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/config") {
    if (gateConfig.error) {
      sendJson(res, 503, { ok: false, error: CONFIG_UNREADABLE });
      return;
    }
    const etag = configEtag(readConfigText(configPath));
    res.setHeader("ETag", etag);
    sendJson(res, 200, { ok: true, etag, config: maskConfig(gateConfig.config ?? {}) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/permissions") {
    sendJson(res, 200, { ok: true, permissions: readAdminPermissions(paths.dataDir) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/models") {
    // What the onboarding flow offers: the presets a provider can be
    // registered from, the providers already in the isolated models.json
    // (auth summarised, never a key), and Pi's providers and models (#38, P2).
    const agentDir = gateConfig.config?.routing?.pi?.agentDir ?? paths.piAgentDir;
    const registered = registeredProviders(agentDir);
    let models: Array<{ id: string; provider: string; name?: string; contextWindowTokens?: number }> = [];
    let providers: Array<{ id: string; name: string; configured: boolean; modelCount: number; availableModelCount: number }> = [];
    let listError: string | undefined;
    try {
      const pi = new PiMindStoneProvider({ agentDir });
      const [piModels, piProviders] = await Promise.all([pi.listModels(), pi.listProviders()]);
      models = piModels.map((model) => ({ id: model.id, provider: model.provider, name: model.name, contextWindowTokens: model.contextWindowTokens }));
      providers = piProviders.map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: provider.authStatus?.configured === true,
        modelCount: provider.modelCount,
        availableModelCount: provider.availableModelCount,
      }));
    } catch {
      listError = "could not list Pi's models";
    }
    sendJson(res, 200, {
      ok: true,
      presets: Object.values(LOCAL_PROVIDER_PRESETS).map((preset) => ({
        presetId: preset.presetId,
        providerId: preset.providerId,
        name: preset.name,
        baseUrl: preset.baseUrl,
        needsKey: !preset.placeholderApiKey,
      })),
      registered: registered.providers,
      ...(registered.unreadable ? { registeredError: "the isolated models.json can't be read" } : {}),
      providers,
      models,
      ...(listError ? { error: listError } : {}),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/doctor") {
    // `mindstone doctor` for the Console (#86): the same checks, with Pi
    // discovery and the embedding probe capped so the answer arrives inside
    // the Console proxy's 15 s timeout. Titles and details are masked.
    const agentDir = gateConfig.config?.routing?.pi?.agentDir ?? paths.piAgentDir;
    const timedOut = `timed out after ${DOCTOR_PROBE_MS / 1000} s`;
    const [providerDiscovery, embeddingProbe] = await Promise.all([
      withTimeout(
        (async () => {
          try {
            const pi = new PiMindStoneProvider({ agentDir });
            const [models, providers] = await Promise.all([pi.listModels(), pi.listProviders()]);
            return { providerCount: providers.length, modelCount: models.length };
          } catch (error) {
            return { providerCount: 0, modelCount: 0, error: error instanceof Error ? error.message : String(error) };
          }
        })(),
        DOCTOR_PROBE_MS,
        { providerCount: 0, modelCount: 0, error: timedOut },
      ),
      gateConfig.config?.memory?.embeddingProvider
        ? withTimeout(probeMemoryEmbeddingProvider(gateConfig.config), DOCTOR_PROBE_MS, { providerId: String(gateConfig.config.memory.embeddingProvider), model: "", baseUrl: "", error: timedOut })
        : Promise.resolve(undefined),
    ]);
    const report = getMindStoneDoctorReport({ providerDiscovery, embeddingProbe });
    sendJson(res, 200, {
      ok: true,
      report: {
        ...report,
        checks: report.checks.map((entry) => ({
          ...entry,
          title: maskInlineSecrets(entry.title),
          ...(entry.detail !== undefined ? { detail: maskInlineSecrets(entry.detail) } : {}),
        })),
      },
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/logs") {
    // `mindstone gateway logs` for the Console (#86): the tail of the managed
    // gateway log, each line masked. Only the end of the file is read.
    const raw = url.searchParams.get("lines");
    const lines = raw === null ? 80 : /^[0-9]{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(lines) || lines < 1 || lines > 500) {
      sendJson(res, 400, { ok: false, error: "lines must be a whole number from 1 to 500" });
      return;
    }
    const logPath = join(paths.dataDir, "gateway", "gateway.log");
    const tail = readLogTail(logPath, lines);
    if (!tail) {
      sendJson(res, 200, { ok: true, available: false, path: logPath, lines: [], note: "there is no managed gateway log; it is kept when the gateway runs under `mindstone gateway start` or the launchd service" });
      return;
    }
    sendJson(res, 200, { ok: true, available: true, path: logPath, lines: tail.map(maskInlineSecrets) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/approvals") {
    // Proposed actions (#84): pending by default, every one with ?all=1. The
    // list carries no draft text; GET /admin/approvals/<id> does.
    const store = new ApprovalStore();
    const actions = url.searchParams.get("all") === "1" ? store.list() : store.pending();
    sendJson(res, 200, { ok: true, status: store.status(), actions: actions.map(approvalSummary) });
    return;
  }
  const approvalMatch = APPROVAL_PATH.exec(url.pathname);
  if (req.method === "GET" && approvalMatch && !approvalMatch[2]) {
    const action = new ApprovalStore().get(approvalMatch[1]!);
    if (!action) {
      sendJson(res, 404, { ok: false, error: `no proposed action matches id "${approvalMatch[1]}"` });
      return;
    }
    sendJson(res, 200, { ok: true, action: { ...approvalSummary(action), send: action.send, memory: action.memory, mutation: action.mutation, persona: action.persona, skill: action.skill } });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/skills") {
    // The Skill Builder (#104): built-in, installed and draft skills. Errors
    // name paths relative to the skills directory, never the host's.
    const skillsDir = skillsDirFromConfig(gateConfig.config, paths);
    // Which installed skills the owner's prompt holds in full; the rest are over the budget.
    const inPrompt = new Set(buildMindStoneSkillsPrompt(skillsDir).inPrompt);
    const skills = discoverMindStoneSkills(skillsDir).map((skill) => ({
      id: skill.id,
      label: skill.label,
      description: skill.description,
      version: skill.version,
      source: skill.source,
      ...(skill.source === "installed" && !skill.error ? { inPrompt: inPrompt.has(skill.id) } : {}),
      ...(skill.error ? { error: publicSkillText(skill.error, skillsDir) } : {}),
    }));
    sendJson(res, 200, { ok: true, skills });
    return;
  }
  const skillReadMatch = /^\/admin\/skills\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
  if (req.method === "GET" && skillReadMatch && skillReadMatch[1] !== "drafts") {
    // One skill with its SKILL.md: ?source=installed|draft|builtin, or the one that applies.
    const skillsDir = skillsDirFromConfig(gateConfig.config, paths);
    const id = skillReadMatch[1]!;
    const source = url.searchParams.get("source");
    let loaded: ReturnType<typeof loadMindStoneSkill>;
    if (source === "installed") loaded = loadMindStoneSkillArtifact(skillsDir, id, "installed");
    else if (source === "draft") loaded = loadMindStoneSkillArtifact(skillDraftsDir(skillsDir), id, "draft");
    else if (source === "builtin") {
      const builtin = builtinMindStoneSkills().find((skill) => skill.artifact.id === id);
      loaded = builtin ? { ok: true, skill: builtin } : { ok: false, skillId: id, error: `no built-in skill "${id}"` };
    } else if (source === null) loaded = loadMindStoneSkill(skillsDir, id);
    else {
      sendJson(res, 400, { ok: false, error: "source must be installed, draft or builtin" });
      return;
    }
    if (!loaded.ok) {
      sendJson(res, 404, { ok: false, error: publicSkillText(loaded.error, skillsDir) });
      return;
    }
    sendJson(res, 200, { ok: true, skill: { ...loaded.skill.artifact, source: loaded.skill.source, skillMarkdown: loaded.skill.skillMarkdown ?? "" } });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/personas") {
    // The personas and the active one, for the Console's Personas page (#105).
    // Switching is PATCH /admin/config/personas { active }.
    const personasDir = personasDirFromConfig(gateConfig.config, paths);
    const personas = discoverMindStonePersonas(personasDir).map(({ id, name, description, version, error }) => ({ id, name, description, version, ...(error ? { error: "this persona can't be loaded" } : {}) }));
    sendJson(res, 200, { ok: true, active: gateConfig.config?.personas?.active ?? null, personas });
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/secrets") {
    // The stored secrets by name (#88): never a value. A link is listed as a
    // link and never followed.
    const secretsDir = `${paths.dataDir}/secrets`;
    const config = gateConfig.config;
    const hostCredentials = hostCredentialFiles(config, configPath);
    let names: string[] = [];
    try {
      names = readdirSync(secretsDir).sort();
    } catch {
      // No secrets directory yet: none stored.
    }
    const secrets = names.map((name) => {
      const target = resolvePath(secretsDir, name);
      let kind: "file" | "link" | "other" = "other";
      let modifiedAt: string | undefined;
      try {
        const entry = lstatSync(target);
        kind = entry.isSymbolicLink() ? "link" : entry.isFile() ? "file" : "other";
        // No size: a secret's length says something about it (#92).
        if (kind === "file") modifiedAt = entry.mtime.toISOString();
      } catch {
        // Removed meanwhile: listed without details.
      }
      return {
        name,
        kind,
        ...(modifiedAt !== undefined ? { modifiedAt } : {}),
        tokenFile: `secrets/${name}`,
        usedBy: connectorsReading(config, configPath, paths, target),
        gatewayCredential: hostCredentials.some((file) => pointsAtSameFile(file, target)),
      };
    });
    sendJson(res, 200, { ok: true, secrets });
    return;
  }
  if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "DELETE") {
    sendJson(res, 404, { ok: false, error: "unknown admin endpoint" });
    return;
  }
  // Every write names the deciding user, for the audit.
  if (!userId) {
    sendJson(res, 400, { ok: false, error: "admin writes need x-mindstone-user-id" });
    return;
  }
  const refuse = (status: number, body: Record<string, unknown>, audit: Record<string, unknown>) => {
    appendAdminAudit(paths.dataDir, { userId, action: "refused", status, ...audit });
    sendJson(res, status, { ok: false, ...body });
  };

  if (req.method === "POST" && url.pathname === "/admin/permissions/advanced") {
    const body = await readAdminBody(req, res);
    if (!body) return;
    const enabled = body.enabled === true;
    if (enabled && normalizeConfirmation(body.confirm) !== ADVANCED_CONFIRMATION) {
      sendJson(res, 400, { ok: false, error: `to grant advanced settings, send confirm: "${ADVANCED_CONFIRMATION}"` });
      return;
    }
    await withAdminWriteLock(() => {
      const now = Date.now();
      const permissions: AdminPermissions = enabled
        ? { advancedSettings: true, grantedBy: userId, grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + ADVANCED_GRANT_MS).toISOString() }
        : { advancedSettings: false };
      writeFileAtomic(adminPermissionsPath(paths.dataDir), `${JSON.stringify(permissions, null, 2)}\n`, 0o600);
      appendAdminAudit(paths.dataDir, { userId, action: enabled ? "advanced_settings_granted" : "advanced_settings_revoked" });
      sendJson(res, 200, { ok: true, permissions });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/restart") {
    // Restart (#90). Only a declared supervisor brings the gateway back, so
    // without one nothing exits and the answer says what to run on the host.
    const supervisor = declaredSupervisor();
    if (!supervisor) {
      refuse(409, { supervisor: null, error: "no supervisor is declared for this gateway, so it can't restart itself; restart it on the gateway host (mindstone gateway restart, or the box's own service command)" }, { reason: "no_supervisor" });
      return;
    }
    // The declaration is checked against evidence, so a stale or copied one
    // can't turn a restart into a shutdown (#90 review).
    const evidence = supervisorEvidence(supervisor, paths);
    if (!evidence.ok) {
      refuse(409, { supervisor, error: `this gateway is declared ${supervisor}, but ${evidence.detail}; restart it on the gateway host` }, { reason: "supervisor_mismatch", supervisor });
      return;
    }
    if (restartRequested) {
      refuse(409, { supervisor, error: "a restart is already under way" }, { reason: "restart_pending", supervisor });
      return;
    }
    // At most RESTART_LIMIT restarts in RESTART_WINDOW_MS, so a restart loop
    // from a bad config can't be driven from the browser.
    const recent = recentRestarts(paths);
    if (recent.length >= RESTART_LIMIT) {
      refuse(429, { supervisor, error: `the gateway was restarted ${recent.length} times in the last 10 minutes; wait, or restart it on the gateway host` }, { reason: "rate_limited", supervisor });
      return;
    }
    recordRestart(paths, recent);
    restartRequested = true;
    appendAdminAudit(paths.dataDir, { userId, action: "restart_requested", supervisor });
    sendJson(res, 202, { ok: true, restarting: true, supervisor, startedAt: GATEWAY_STARTED_AT });
    res.once("finish", () => {
      if (supervisor === "managed") spawnRestartHelper(managedRestartPlan(paths) as ManagedRestartPlan, paths);
      // The gateway's own shutdown (main.ts): stop listening, stop the
      // connectors and let in-flight work finish (capped), then exit with
      // RESTART_EXIT_CODE; the supervisor, or the helper for "managed",
      // starts it again.
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 100).unref();
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/skills/drafts") {
    // Build a skill draft (#104): from a built-in, or from scratch with an id,
    // label, description and goal. A draft does nothing until it is installed.
    const body = await readAdminBody(req, res);
    if (!body) return;
    const skillsDir = skillsDirFromConfig(gateConfig.config, paths);
    const fromBuiltin = typeof body.fromBuiltin === "string" && body.fromBuiltin ? body.fromBuiltin : undefined;
    if (body.force !== undefined && typeof body.force !== "boolean") {
      sendJson(res, 400, { ok: false, error: "force must be true or false" });
      return;
    }
    let draftInput: Parameters<typeof buildMindStoneSkillDraft>[0];
    if (fromBuiltin) {
      if (!builtinMindStoneSkills().some((skill) => skill.artifact.id === fromBuiltin)) {
        sendJson(res, 400, { ok: false, error: `no built-in skill "${fromBuiltin}"` });
        return;
      }
      // Fields given with a built-in override it; they are checked like a proposal's.
      const overrides = parseSkillProposal({
        id: body.id ?? fromBuiltin,
        label: body.label ?? "x",
        description: body.description ?? "x",
        goal: body.goal,
      });
      if (!overrides) {
        sendJson(res, 400, { ok: false, error: "id must be lowercase letters, digits and hyphens; label, description and goal at most 2000 characters" });
        return;
      }
      draftInput = {
        skillsDir,
        fromBuiltin,
        id: overrides.id,
        label: typeof body.label === "string" ? overrides.label : undefined,
        description: typeof body.description === "string" ? overrides.description : undefined,
        goal: overrides.goal,
        force: body.force === true,
        now: new Date().toISOString(),
      };
    } else {
      const skill = parseSkillProposal(body);
      if (!skill) {
        sendJson(res, 400, {
          ok: false,
          error: "a skill needs an id (lowercase letters, digits, hyphens), a label and a description; goal, whenToUse, outputs, safetyNotes and instructions are optional and bounded",
        });
        return;
      }
      draftInput = {
        skillsDir,
        id: skill.id,
        label: skill.label,
        description: skill.description,
        goal: skill.goal,
        whenToUse: skill.whenToUse,
        outputs: skill.outputs,
        safetyNotes: skill.safetyNotes,
        skillMarkdown: skill.instructions,
        force: body.force === true,
        now: new Date().toISOString(),
      };
    }
    await withAdminWriteLock(() => {
      const result = buildMindStoneSkillDraft(draftInput);
      if (!result.ok) {
        refuse(409, { error: publicSkillText(result.error, skillsDir) }, { reason: "skill_draft", skill: draftInput.id ?? fromBuiltin });
        return;
      }
      appendAdminAudit(paths.dataDir, { userId, action: "skill_drafted", skill: result.skillId, origin: result.artifact.origin });
      sendJson(res, 200, { ok: true, skill: { ...result.artifact, source: "draft" } });
    });
    return;
  }
  const skillDraftMatch = /^\/admin\/skills\/drafts\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
  if (req.method === "DELETE" && skillDraftMatch) {
    // Discard a draft (#104). Installed skills aren't touched here.
    const skillsDir = skillsDirFromConfig(gateConfig.config, paths);
    const id = skillDraftMatch[1]!;
    await withAdminWriteLock(() => {
      const dir = join(skillDraftsDir(skillsDir), id);
      if (validateSkillId(id) || !existsSync(join(dir, "skill.json"))) {
        sendJson(res, 404, { ok: false, error: `no draft named "${id}"` });
        return;
      }
      rmSync(dir, { recursive: true, force: true });
      appendAdminAudit(paths.dataDir, { userId, action: "skill_draft_discarded", skill: id });
      sendJson(res, 200, { ok: true });
    });
    return;
  }
  const skillInstallMatch = /^\/admin\/skills\/([a-z0-9][a-z0-9-]{0,63})\/install$/.exec(url.pathname);
  if (req.method === "POST" && skillInstallMatch) {
    // Install a draft (#104): it changes what the agent is told on every
    // turn, so it needs the advanced-settings permission.
    const body = await readAdminBody(req, res);
    if (!body) return;
    if (body.force !== undefined && typeof body.force !== "boolean") {
      sendJson(res, 400, { ok: false, error: "force must be true or false" });
      return;
    }
    const skillsDir = skillsDirFromConfig(gateConfig.config, paths);
    const id = skillInstallMatch[1]!;
    if (!readAdminPermissions(paths.dataDir).advancedSettings) {
      refuse(403, { error: "installing a skill needs the advanced-settings permission" }, { reason: "advanced", skill: id });
      return;
    }
    await withAdminWriteLock(() => {
      const result = installMindStoneSkill(skillsDir, id, { force: body.force === true });
      if (!result.ok) {
        // Already installed: 409. No draft: 404. A draft that doesn't load (bad JSON, no SKILL.md): 422.
        const exists = /already installed/.test(result.error);
        const missing = !existsSync(join(skillDraftsDir(skillsDir), id, "skill.json"));
        const [status, code] = exists ? [409, "skill_exists"] : missing ? [404, "not_found"] : [422, "invalid_skill"];
        refuse(status, { error: publicSkillText(result.error, skillsDir), code }, { reason: code, skill: id });
        return;
      }
      appendAdminAudit(paths.dataDir, { userId, action: "skill_installed", skill: id });
      sendJson(res, 200, { ok: true, skill: { id, source: "installed" } });
    });
    return;
  }

  if (req.method === "POST" && approvalMatch && approvalMatch[2]) {
    // Approve or reject a proposed action (#84), with the same guards as
    // `mindstone approvals` (core's approval actions). No advanced-settings
    // gate: approving is the normal path for an approval_required connector.
    const decision = approvalMatch[2] as "approve" | "reject";
    const body = await readAdminBody(req, res);
    if (!body) return;
    if (decision === "approve" && body.force !== undefined && typeof body.force !== "boolean") {
      sendJson(res, 400, { ok: false, error: "force must be true or false" });
      return;
    }
    if (decision === "reject" && body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000)) {
      sendJson(res, 400, { ok: false, error: "note must be a string of at most 2000 characters" });
      return;
    }
    const store = new ApprovalStore();
    const onDecision = (action: ProposedAction, decided: "approved" | "rejected", detail: string) => {
      appendTranscriptEntry({
        sessionKey: action.sessionKey ?? resolveDefaultSessionKey(gateConfig.config, action.agentId ?? "default"),
        agentId: action.agentId ?? "default",
        role: "event",
        text: `approval ${decided}: ${action.kind} ${action.id} — ${detail} (from the Console)`,
        metadata: { event: "approval_decided", approvalId: action.id, kind: action.kind, decision: decided, connector: action.connectorId },
      });
      appendAdminAudit(paths.dataDir, { userId, action: `approval_${decided}`, approvalId: action.id, kind: action.kind, connector: action.connectorId });
    };
    // Installing a skill changes what the agent is told on every turn, so it
    // needs the advanced-settings permission, as installing from the Skills page does (#104).
    if (decision === "approve" && store.get(approvalMatch[1]!)?.kind === "skill_install" && !readAdminPermissions(paths.dataDir).advancedSettings) {
      refuse(403, { error: "installing a skill needs the advanced-settings permission", code: "advanced" }, { reason: "advanced", approvalId: approvalMatch[1], decision });
      return;
    }
    try {
      if (decision === "approve") {
        // Under the admin write lock, like every config-adjacent write.
        await withAdminWriteLock(() => {
          const current = loadMindStoneConfig(configPath).config;
          const result = approveProposedAction(store, checkApprovable(store, approvalMatch[1]!), {
            decidedBy: `console:${userId}`,
            memoryDir: paths.memoryDir,
            skillsDir: skillsDirFromConfig(current, paths),
            force: body.force === true,
            onDecision,
            personasDir: personasDirFromConfig(current, paths),
            referencedPersonaIds: referencedPersonaIds(current, paths),
          });
          sendJson(res, 200, { ok: true, result: result.kind === "memory_write" ? { outcome: result.outcome, kind: result.kind } : result });
        });
      } else {
        const rejected = rejectProposedAction(store, approvalMatch[1]!, {
          decidedBy: `console:${userId}`,
          note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined,
          onDecision,
        });
        sendJson(res, 200, { ok: true, action: approvalSummary(rejected) });
      }
    } catch (error) {
      if (!(error instanceof ApprovalActionError)) throw error;
      refuse(error.status, { error: error.publicMessage, code: error.code }, { reason: error.code, approvalId: approvalMatch[1], decision });
    }
    return;
  }

  const providerMatch = /^\/admin\/providers\/([a-z-]{1,40})$/.exec(url.pathname);
  if (req.method === "POST" && providerMatch) {
    const presetId = providerMatch[1]!;
    const preset = Object.hasOwn(LOCAL_PROVIDER_PRESETS, presetId) ? LOCAL_PROVIDER_PRESETS[presetId as LocalProviderPresetId] : undefined;
    if (!preset) {
      refuse(404, { error: `unknown provider preset: ${presetId}` }, { reason: "unknown_preset", provider: presetId });
      return;
    }
    const body = await readAdminBody(req, res);
    if (!body) return;
    const parsed = parseProviderRegistration(body, preset.baseUrl, !preset.placeholderApiKey);
    if ("error" in parsed) {
      refuse(400, { error: parsed.error }, { reason: "invalid", provider: presetId });
      return;
    }
    const loaded = loadMindStoneConfig(configPath);
    if (loaded.error) {
      sendJson(res, 503, { ok: false, error: CONFIG_UNREADABLE });
      return;
    }
    // Registering a provider adds a URL and a credential the agent sends to
    // it, so it needs the advanced-settings permission.
    if (!readAdminPermissions(paths.dataDir).advancedSettings) {
      refuse(403, { error: "registering a model provider needs the advanced-settings permission" }, { reason: "advanced", provider: presetId });
      return;
    }
    // The key comes from a stored secret or an environment variable, never
    // from this body. The gateway's own credentials are host-only: they must
    // never be sent to a provider URL (#38, P2).
    let apiKey: string | undefined;
    let probeKey: string | undefined;
    let keySource: string;
    const refuseHostCredential = () =>
      refuse(422, { error: "that is a gateway credential and can't be used as a provider key" }, { reason: "host_only", provider: presetId });
    if (parsed.secret) {
      const secretPath = resolvePath(`${paths.dataDir}/secrets`, parsed.secret);
      if (hostCredentialFiles(loaded.config, configPath).some((file) => sameFile(file, secretPath))) {
        refuseHostCredential();
        return;
      }
      // A connector's token belongs to that connector, not to a model provider.
      if (connectorTokenFiles(loaded.config, configPath, paths).all.some((file) => pointsAtSameFile(file, secretPath))) {
        refuse(422, { error: "that secret is a connector's token and can't be used as a provider key" }, { reason: "connector_secret", provider: presetId });
        return;
      }
      let value = "";
      try {
        if (lstatSync(secretPath).isFile()) value = readFileSync(secretPath, "utf-8").trim();
      } catch {
        // Missing: handled below.
      }
      if (!value) {
        refuse(400, { error: `no stored secret named ${parsed.secret}; store it with POST /admin/secrets/${parsed.secret} first` }, { reason: "no_secret", provider: presetId });
        return;
      }
      if (isGatewayCredentialValue(value, loaded.config, configPath)) {
        refuseHostCredential();
        return;
      }
      // Pi reads apiKey as a template ("!cmd" runs a command, "$VAR" reads the
      // environment), so the stored value is escaped to stay a literal key.
      apiKey = literalConfigValue(value);
      probeKey = value;
      keySource = `secret:${parsed.secret}`;
    } else if (parsed.env) {
      const envValue = process.env[parsed.env];
      if (gatewayCredentialEnvNames(loaded.config).includes(parsed.env) || (envValue !== undefined && isGatewayCredentialValue(envValue, loaded.config, configPath))) {
        refuseHostCredential();
        return;
      }
      apiKey = `$${parsed.env}`;
      probeKey = process.env[parsed.env];
      keySource = `env:${parsed.env}`;
    } else if (preset.placeholderApiKey) {
      apiKey = preset.placeholderApiKey;
      keySource = "placeholder";
    } else {
      refuse(400, { error: `${preset.name} needs a key: send { "secret": "<stored secret name>" } or { "env": "<VARIABLE>" }` }, { reason: "no_key", provider: presetId });
      return;
    }
    // Headers or overrides set on the host stay with a provider on
    // re-registration; they must not follow it to a URL chosen here.
    const agentDirForCheck = loaded.config?.routing?.pi?.agentDir ?? paths.piAgentDir;
    const existing = readIsolatedModelsConfig(agentDirForCheck).config.providers[preset.providerId];
    if (existing && (existing.headers || existing.authHeader !== undefined || existing.modelOverrides)) {
      refuse(409, { error: `${preset.name} has settings made on the gateway host (headers or overrides); change it there` }, { reason: "host_settings", provider: presetId });
      return;
    }
    let models = parsed.models;
    if (!models) {
      const probe = await probeOpenAiCompatibleModels({ baseUrl: parsed.baseUrl, apiKey: probeKey, timeoutMs: 5_000 });
      if (!probe.ok) {
        // The key was sent to the URL, so the attempt is audited too.
        refuse(422, { error: `couldn't list models: ${probe.error}. Send "models": ["<id>", …] to register without listing.` }, { reason: "probe_failed", provider: presetId, baseUrl: maskUrlCredentials(parsed.baseUrl), keySource });
        return;
      }
      models = probe.models.slice(0, 500).map((model) => model.id);
    }
    const registeredModels = models;
    await withAdminWriteLock(() => {
      // The permission is read again at write time: it may have been revoked while the probe ran.
      if (!readAdminPermissions(paths.dataDir).advancedSettings) {
        refuse(403, { error: "registering a model provider needs the advanced-settings permission" }, { reason: "advanced", provider: presetId });
        return;
      }
      const agentDir = loaded.config?.routing?.pi?.agentDir ?? paths.piAgentDir;
      const result = upsertIsolatedProvider(agentDir, preset.providerId, {
        name: preset.name,
        baseUrl: parsed.baseUrl,
        api: preset.api,
        apiKey,
        models: registeredModels.map((id) => ({ id })),
      });
      if (result.error) {
        refuse(409, { error: "the isolated models.json can't be read; fix or remove it on the gateway host" }, { reason: "models_json_unreadable", provider: presetId });
        return;
      }
      appendAdminAudit(paths.dataDir, { userId, action: "provider_registered", provider: preset.providerId, baseUrl: parsed.baseUrl, keySource, models: registeredModels.length });
      // The key is never echoed.
      sendJson(res, 200, { ok: true, providerId: preset.providerId, modelCount: result.modelCount, models: registeredModels.map((id) => `${preset.providerId}/${id}`) });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/onboarding/complete") {
    // The Console's setup finishes what `mindstone onboard` does (#102): the
    // onboarding record and the IDENTITY.md/USER.md scaffold, so the owner's
    // first chat starts identity formation. The answers are the user's own
    // words; nothing here names a file or a command.
    const body = await readAdminBody(req, res);
    if (!body) return;
    const limits: Record<string, number> = { purpose: 2000, userContext: 4000, projectContext: 2000 };
    const answers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(body)) {
      const max = Object.hasOwn(limits, key) ? limits[key] : undefined;
      if (max === undefined || (value !== undefined && typeof value !== "string") || (typeof value === "string" && value.length > max)) {
        refuse(400, { error: "send { purpose?, userContext?, projectContext? } as short text" }, { reason: "invalid", key });
        return;
      }
      answers[key] = typeof value === "string" && value.trim() ? value.trim() : undefined;
    }
    await withAdminWriteLock(() => {
      const loaded = loadMindStoneConfig(configPath);
      if (loaded.error) {
        sendJson(res, 503, { ok: false, error: CONFIG_UNREADABLE });
        return;
      }
      if (!readAdminPermissions(paths.dataDir).advancedSettings) {
        refuse(403, { error: "finishing setup needs the advanced-settings permission" }, { reason: "advanced" });
        return;
      }
      const config = (loaded.config ?? {}) as MindStoneConfig;
      const steps = onboardingSteps(config).steps;
      if (!steps.provider.done || !steps.persona.done) {
        refuse(409, { error: "choose a model provider and a persona first" }, { reason: "not_ready" });
        return;
      }
      const now = new Date().toISOString();
      const agentId = config.routing?.defaultAgentId ?? "default";
      const builtIn = getBuiltInMindStoneProfile(config.agents?.[agentId]?.profileId);
      const next: MindStoneConfig = {
        ...config,
        onboarding: {
          ...config.onboarding,
          profile: config.onboarding?.profile ?? (builtIn ? { id: builtIn.id, label: builtIn.label, description: builtIn.description, selectedAt: now } : undefined),
          preferences: { ...config.onboarding?.preferences, ...(answers.projectContext ? { projectContext: answers.projectContext } : {}) },
          identity: { mode: "defer", selectedAt: now, ...config.onboarding?.identity },
        },
      };
      const issues = validateMindStoneConfig(next);
      if (issues.length > 0) {
        refuse(422, { error: "the change doesn't validate", errors: issues.map((issue) => ({ error: issue })) }, { reason: "invalid" });
        return;
      }
      // The scaffold first: setup counts as finished only once its files exist.
      let scaffold: ReturnType<typeof writeOnboardingIdentityScaffold>;
      try {
        scaffold = writeOnboardingIdentityScaffold({
          config: next,
          configPath,
          purpose: answers.purpose,
          userContext: answers.userContext,
          createdBy: "the MindStone Console's setup",
        });
      } catch {
        refuse(409, { error: "the identity files couldn't be written; check the agent's identityPath and userPath on the gateway host" }, { reason: "scaffold_failed" });
        return;
      }
      const configTarget = realConfigPath(configPath);
      writeFileAtomic(configTarget, `${JSON.stringify(next, null, 2)}\n`, fileMode(configTarget, 0o600));
      appendAdminAudit(paths.dataDir, { userId, action: "onboarding_completed", identityCreated: scaffold.identityCreated, userCreated: scaffold.userCreated });
      sendJson(res, 200, { ok: true, identity: scaffold.identityCreated ? "created" : "kept", user: scaffold.userCreated ? "created" : "kept" });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/memory/check") {
    // A live embed with the embedding provider setup is about to save (#102):
    // the same probe as doctor, on the candidate instead of the saved config.
    const body = await readAdminBody(req, res);
    if (!body) return;
    const spec = body.embeddingProvider;
    if (Object.keys(body).some((key) => key !== "embeddingProvider") || typeof spec !== "string" || !EMBEDDING_SPEC.test(spec)) {
      refuse(400, { error: 'send { "embeddingProvider": "ollama:<model>" } (or openai: / openai-compatible:)' }, { reason: "invalid" });
      return;
    }
    if (!readAdminPermissions(paths.dataDir).advancedSettings) {
      refuse(403, { error: "checking an embedding provider needs the advanced-settings permission" }, { reason: "advanced" });
      return;
    }
    const loaded = loadMindStoneConfig(configPath);
    if (loaded.error) {
      sendJson(res, 503, { ok: false, error: CONFIG_UNREADABLE });
      return;
    }
    const candidate: MindStoneConfig = { ...loaded.config, memory: { ...loaded.config?.memory, embeddingProvider: spec } };
    const probe = await withTimeout(probeMemoryEmbeddingProvider(candidate), MEMORY_CHECK_MS, undefined);
    const ok = Boolean(probe && !probe.error && probe.dimensions);
    const error = !probe ? `no answer within ${MEMORY_CHECK_MS / 1000} s` : probe.error ?? (probe.dimensions ? undefined : "the provider returned no embedding");
    const missingModel = !ok && spec.startsWith("ollama:") && /not found|pull/i.test(error ?? "");
    lastMissingOllamaModel = missingModel ? spec.slice("ollama:".length) : undefined;
    appendAdminAudit(paths.dataDir, { userId, action: "memory_checked", embeddingProvider: spec, ok });
    sendJson(res, 200, ok
      ? { ok: true, providerId: probe!.providerId, model: probe!.model, dimensions: probe!.dimensions }
      : { ok: false, error, missingModel });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/memory/pull") {
    // Download an Ollama embedding model, so a missing one doesn't need a
    // terminal on the gateway host (#102). One download at a time.
    const body = await readAdminBody(req, res);
    if (!body) return;
    const model = body.model;
    if (Object.keys(body).some((key) => key !== "model") || typeof model !== "string" || !OLLAMA_MODEL_NAME.test(model)) {
      refuse(400, { error: 'send { "model": "<ollama model name>" }' }, { reason: "invalid" });
      return;
    }
    if (!readAdminPermissions(paths.dataDir).advancedSettings) {
      refuse(403, { error: "downloading a model needs the advanced-settings permission" }, { reason: "advanced" });
      return;
    }
    if (ollamaPullRunning) {
      refuse(409, { error: "a model download is already running; wait for it to finish" }, { reason: "busy" });
      return;
    }
    // Only the embedding model the last check found missing: not any model
    // from the registry, which could be any size.
    if (model !== lastMissingOllamaModel) {
      refuse(409, { error: "download the model the memory check reported missing: run the check first" }, { reason: "not_checked" });
      return;
    }
    const resolved = resolveMemoryEmbeddingProviderConfig({ memory: { embeddingProvider: `ollama:${model}` } });
    const root = (resolved?.baseUrl ?? "http://127.0.0.1:11434/v1").replace(/\/v1$/, "");
    ollamaPullRunning = true;
    // A client that gives up frees the slot: the download is stopped.
    const clientGone = new AbortController();
    res.on("close", () => clientGone.abort());
    let result: { ok: true } | { ok: false; error: string };
    try {
      const response = await fetch(`${root}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: false }),
        signal: AbortSignal.any([AbortSignal.timeout(OLLAMA_PULL_MS), clientGone.signal]),
      });
      const text = await response.text();
      let parsed: { status?: unknown; error?: unknown } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        // Not JSON: reported below.
      }
      result = response.ok && parsed.status === "success"
        ? { ok: true }
        : { ok: false, error: typeof parsed.error === "string" ? parsed.error : `Ollama answered ${response.status}` };
    } catch (error) {
      result = {
        ok: false,
        error: clientGone.signal.aborted
          ? "the download was stopped because the request was closed"
          : error instanceof Error && error.name === "TimeoutError" ? "the download took too long" : "Ollama can't be reached from the gateway",
      };
    } finally {
      ollamaPullRunning = false;
    }
    if (result.ok) lastMissingOllamaModel = undefined;
    appendAdminAudit(paths.dataDir, { userId, action: "memory_model_pulled", model, ok: result.ok });
    sendJson(res, 200, result);
    return;
  }

  const sectionMatch = /^\/admin\/config\/([A-Za-z]+)$/.exec(url.pathname);
  if (req.method === "PATCH" && sectionMatch) {
    const section = sectionMatch[1]!;
    if (!(EDITABLE_SECTIONS as readonly string[]).includes(section)) {
      sendJson(res, 404, { ok: false, error: `unknown or read-only config section: ${section}` });
      return;
    }
    const patch = await readAdminBody(req, res);
    if (!patch) return;
    if (jsonDepth(patch) > MAX_PATCH_DEPTH) {
      sendJson(res, 400, { ok: false, error: "the patch is nested too deeply" });
      return;
    }
    const ifMatch = typeof req.headers["if-match"] === "string" ? req.headers["if-match"].trim() : undefined;
    // Read the config and the permission only now, after the body, under the
    // write lock: a slow body can't write back a stale copy (#38 review).
    await withAdminWriteLock(() => {
      const loadedConfig = loadMindStoneConfig(configPath);
      if (loadedConfig.error) {
        sendJson(res, 503, { ok: false, error: CONFIG_UNREADABLE });
        return;
      }
      const currentText = readConfigText(configPath);
      if (ifMatch && !ifMatchSatisfied(ifMatch, configEtag(currentText))) {
        refuse(412, { error: "the config changed since you read it; reload and try again" }, { section, reason: "etag" });
        return;
      }
      const current = (loadedConfig.config ?? {}) as Record<string, unknown>;
      let merged: unknown;
      const touched = { secrets: false };
      try {
        merged = mergeConfigPatch(current[section], patch, section, false, 0, touched);
      } catch (error) {
        refuse(400, { error: error instanceof AdminPatchError ? error.message : "the patch could not be applied" }, { section, reason: "bad_patch" });
        return;
      }
      const changed = changedPaths(current[section], merged, section);
      // Replacing a value with hidden parts needs the permission whether or not
      // it changes anything, so a matching guess and a wrong one look the same.
      if (touched.secrets && !readAdminPermissions(paths.dataDir).advancedSettings) {
        refuse(403, { error: "replacing a value with hidden parts needs the advanced-settings permission" }, { section, reason: "advanced_masked" });
        return;
      }
      if (changed.length === 0) {
        sendJson(res, 200, { ok: true, changed: [], restartRequired: false, etag: configEtag(currentText) });
        return;
      }
      const next = { ...current, [section]: merged } as MindStoneConfig;
      // Gateway auth and the admin credential are set on the gateway host,
      // never from the Console, even with the permission: a change there can
      // open the gateway or lock everyone out (#38 review).
      const hostOnly = changed.filter((path) => /^gateway\.(auth|admin)(\.|$)/.test(path));
      const nextAuth = resolveGatewayAuthRequirement({ config: next.gateway?.auth, configPath });
      if (hostOnly.length > 0 || !nextAuth.enabled || nextAuth.mode === "misconfigured") {
        refuse(422, {
          error: "gateway auth and the admin credential can only be changed on the gateway host",
          errors: hostOnly.map((path) => ({ path, error: "set on the gateway host" })),
        }, { section, reason: "host_only", paths: hostOnly });
        return;
      }
      let issues: string[];
      try {
        issues = validateMindStoneConfig(next);
      } catch {
        issues = ["the new config has a value of the wrong type"];
      }
      if (issues.length > 0) {
        refuse(422, { error: "the change doesn't validate", errors: issues.map((issue) => ({ error: issue })) }, { section, reason: "invalid" });
        return;
      }
      const advanced = changed.filter((path) => isAdvancedChange(path, next, current));
      if (advanced.length > 0 && !readAdminPermissions(paths.dataDir).advancedSettings) {
        refuse(403, {
          error: "these settings need the advanced-settings permission",
          errors: advanced.map((path) => ({ path, error: "needs the advanced-settings permission" })),
        }, { section, reason: "advanced", advanced });
        return;
      }
      const nextText = `${JSON.stringify(next, null, 2)}\n`;
      // Write through a symlinked config to its target, so host edits to the
      // real file keep applying (#75 review).
      const configTarget = realConfigPath(configPath);
      writeFileAtomic(configTarget, nextText, fileMode(configTarget, 0o600));
      appendAdminAudit(paths.dataDir, { userId, action: "config_patched", section, changed, advanced });
      const restartRequired = changed.some((path) => path.startsWith("channels.") || path === "channels" || /^gateway\.(host|port|auth|admin)/.test(path));
      sendJson(res, 200, { ok: true, changed, restartRequired, etag: configEtag(nextText) });
    });
    return;
  }

  const secretMatch = /^\/admin\/secrets\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && secretMatch) {
    // Remove a stored secret (#88), under the same guards as replacing one:
    // the advanced-settings permission, never the gateway's own credentials,
    // never a link made on the host, and never through a link.
    let name: string;
    try {
      name = decodeURIComponent(secretMatch[1]!);
    } catch {
      sendJson(res, 400, { ok: false, error: "the secret name is not valid URL encoding" });
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes("..")) {
      sendJson(res, 400, { ok: false, error: "secret names are letters, digits, dot, dash and underscore (max 64)" });
      return;
    }
    await withAdminWriteLock(() => {
      const secretsDir = `${paths.dataDir}/secrets`;
      const target = resolvePath(secretsDir, name);
      // Fail closed: without the config, the gateway's own credential files
      // aren't known, so nothing is deleted (#92).
      const loadedConfig = loadMindStoneConfig(configPath);
      if (loadedConfig.error || !loadedConfig.config) {
        refuse(503, { error: CONFIG_UNREADABLE }, { reason: "config_unreadable", secret: name });
        return;
      }
      const config = loadedConfig.config;
      if (hostCredentialFiles(config, configPath).some((file) => pointsAtSameFile(file, target))) {
        refuse(422, { error: "this secret is a gateway credential and can only be changed on the gateway host" }, { reason: "host_only", secret: name });
        return;
      }
      if (!readAdminPermissions(paths.dataDir).advancedSettings) {
        refuse(403, { error: "deleting a secret needs the advanced-settings permission" }, { reason: "advanced", secret: name });
        return;
      }
      let entry: ReturnType<typeof lstatSync>;
      try {
        entry = lstatSync(target);
      } catch {
        refuse(404, { error: `no stored secret named ${name}` }, { reason: "not_found", secret: name });
        return;
      }
      if (entry.isSymbolicLink()) {
        refuse(422, { error: "this secret name is a link made on the gateway host; change it there" }, { reason: "host_link", secret: name });
        return;
      }
      if (!entry.isFile()) {
        refuse(422, { error: "this secret name isn't a file; change it on the gateway host" }, { reason: "not_a_file", secret: name });
        return;
      }
      const usedBy = connectorsReading(config, configPath, paths, target);
      unlinkSync(target);
      appendAdminAudit(paths.dataDir, { userId, action: "secret_deleted", secret: name, usedBy });
      sendJson(res, 200, { ok: true, name, usedBy });
    });
    return;
  }
  if (req.method === "POST" && secretMatch) {
    let name: string;
    try {
      name = decodeURIComponent(secretMatch[1]!);
    } catch {
      sendJson(res, 400, { ok: false, error: "the secret name is not valid URL encoding" });
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes("..")) {
      sendJson(res, 400, { ok: false, error: "secret names are letters, digits, dot, dash and underscore (max 64)" });
      return;
    }
    const body = await readAdminBody(req, res);
    if (!body) return;
    if (typeof body.value !== "string" || body.value.length === 0 || body.value.length > 16_384) {
      sendJson(res, 400, { ok: false, error: "value must be a non-empty string of at most 16384 characters" });
      return;
    }
    const value = body.value;
    await withAdminWriteLock(() => {
      const secretsDir = `${paths.dataDir}/secrets`;
      const target = resolvePath(secretsDir, name);
      // The gateway's own credentials are set on the host, never from the Console.
      // Fail closed: without the config, the gateway's own credential files
      // and the connectors' token files aren't known, so nothing is written (#92).
      const loadedSecrets = loadMindStoneConfig(configPath);
      if (loadedSecrets.error || !loadedSecrets.config) {
        refuse(503, { error: CONFIG_UNREADABLE }, { reason: "config_unreadable", secret: name });
        return;
      }
      const loadedSecretsConfig = loadedSecrets.config;
      const hostCredentials = hostCredentialFiles(loadedSecretsConfig, configPath);
      if (hostCredentials.some((file) => pointsAtSameFile(file, target))) {
        refuse(422, { error: "this secret is a gateway credential and can only be changed on the gateway host" }, { reason: "host_only", secret: name });
        return;
      }
      // Replacing a secret, or writing one a connector is configured to read
      // (its token file), needs the permission: either one changes who the
      // agent talks to (#75 review).
      const connectorFiles = connectorTokenFiles(loadedSecretsConfig, configPath, paths);
      const permitted = readAdminPermissions(paths.dataDir).advancedSettings;
      const targetExists = pathEntryExists(target);
      if ((targetExists || connectorFiles.all.some((file) => pointsAtSameFile(file, target))) && !permitted) {
        refuse(403, { error: "replacing a secret or setting a connector's token needs the advanced-settings permission" }, { reason: "advanced", secret: name });
        return;
      }
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      chmodSync(secretsDir, 0o700);
      if (targetExists) {
        // A secret stored from the Console is never a link. A link under this
        // name was made on the host, and replacing it could turn a link chain
        // into a live credential (#79 review), so it's changed there.
        if (lstatSync(target).isSymbolicLink()) {
          refuse(422, { error: "this secret name is a link made on the gateway host; change it there" }, { reason: "host_link", secret: name });
          return;
        }
        writeFileAtomic(target, value, 0o600);
      } else {
        // A new name can still reach a protected file that doesn't exist yet
        // through the filesystem's own folding (APFS treats "ß" as "ss" and
        // "ſ" as "s") or a chain of dangling links, which no name comparison
        // covers (#78 review). So the file is created exclusively, and if a
        // protected file that was missing now exists, this name reached it:
        // it's removed and refused, whatever the folding or link chain.
        const missing = [...hostCredentials, ...connectorFiles.read].filter((file) => !existsSync(file));
        if (!createFileExclusive(target, value, 0o600)) {
          sendJson(res, 409, { ok: false, error: "a secret with this name was created meanwhile; try again" });
          return;
        }
        const reached = missing.filter((file) => existsSync(file));
        const reachedHost = reached.some((file) => hostCredentials.includes(file));
        if (reachedHost || (reached.length > 0 && !permitted)) {
          if (!removeOrEmpty(target)) {
            // It couldn't be removed or emptied: fail closed, loudly.
            appendAdminAudit(paths.dataDir, { userId, action: "failed", status: 500, reason: "plant_not_removed", secret: name });
            sendJson(res, 500, { ok: false, error: "the admin API hit an internal error" });
            return;
          }
          if (reachedHost) {
            refuse(422, { error: "this secret is a gateway credential and can only be changed on the gateway host" }, { reason: "host_only", secret: name });
          } else {
            refuse(403, { error: "replacing a secret or setting a connector's token needs the advanced-settings permission" }, { reason: "advanced", secret: name });
          }
          return;
        }
      }
      appendAdminAudit(paths.dataDir, { userId, action: "secret_stored", secret: name });
      // The value is never echoed. Reference it from config as tokenFile: "secrets/<name>".
      sendJson(res, 200, { ok: true, name, tokenFile: `secrets/${name}` });
    });
    return;
  }
  sendJson(res, 404, { ok: false, error: "unknown admin endpoint" });
}

const ADVANCED_CONFIRMATION = "enable advanced settings";
/**
 * The confirmation guards against accidents, not attackers (console #18):
 * case, surrounding whitespace and repeated spaces don't matter, but the
 * words must match exactly. The Console normalizes the same way.
 */
function normalizeConfirmation(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : undefined;
}
const CONFIG_UNREADABLE = "the config file doesn't load; run mindstone doctor on the gateway host";

/** Admin writes run one at a time, so each reads the config and permission it writes against. */
let adminWriteChain: Promise<void> = Promise.resolve();
function withAdminWriteLock(work: () => void): Promise<void> {
  const run = adminWriteChain.then(work);
  adminWriteChain = run.catch(() => undefined);
  return run;
}

function realConfigPath(configPath: string): string {
  try {
    return realpathSync(configPath);
  } catch {
    return configPath;
  }
}

function readConfigText(configPath: string): string {
  try {
    return readFileSync(configPath, "utf-8");
  } catch {
    return "";
  }
}

/** The permission bits of an existing file, else the fallback. */
function fileMode(path: string, fallback: number): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return fallback;
  }
}

/** The permission in force: an expired grant reads as not granted. */
function readAdminPermissions(dataDir: string): AdminPermissions {
  try {
    return effectivePermissions(JSON.parse(readFileSync(adminPermissionsPath(dataDir), "utf-8")) as AdminPermissions);
  } catch {
    return { advancedSettings: false };
  }
}

/**
 * Whether two paths name the same file: the same inode when both exist, else
 * the same real path compared without case (macOS volumes are usually
 * case-insensitive), so an alias can't get past the host-credential guard.
 */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
  } catch {
    // One of them doesn't exist yet: compare names.
  }
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      try {
        return resolvePath(realpathSync(dirname(path)), basename(path));
      } catch {
        return resolvePath(path);
      }
    }
  };
  return real(a).toLowerCase() === real(b).toLowerCase();
}

/**
 * Absolute paths of every file a connector is configured to read (any key
 * ending in "File" on a channel), resolved the way the connectors resolve
 * them (resolveConnectorSecretPath: under the data dir, trimmed) and, for
 * safety, also relative to the config file (#75 review). `read` holds only
 * the paths the connectors actually read.
 */
function connectorTokenFiles(
  config: MindStoneConfig | undefined,
  configPath: string,
  paths: MindStoneRuntimePaths,
): { all: string[]; read: string[] } {
  const all: string[] = [];
  const read: string[] = [];
  for (const section of Object.values((config?.channels ?? {}) as Record<string, unknown>)) {
    if (!section || typeof section !== "object") continue;
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      if (/file$/i.test(key) && typeof value === "string" && value.trim()) {
        const resolved = resolveConnectorSecretPath(value, paths);
        read.push(resolved);
        all.push(resolved);
        if (!isAbsolute(value.trim())) all.push(resolvePath(dirname(configPath), value.trim()));
      }
    }
  }
  return { all, read };
}

/** The configured connectors (channel ids) with a …File setting that reads this path, by the store guard's rule. */
function connectorsReading(
  config: MindStoneConfig | undefined,
  configPath: string,
  paths: MindStoneRuntimePaths,
  target: string,
): string[] {
  const ids: string[] = [];
  for (const [id, section] of Object.entries((config?.channels ?? {}) as Record<string, unknown>)) {
    if (connectorTokenFiles({ channels: { [id]: section } } as MindStoneConfig, configPath, paths).all.some((file) => pointsAtSameFile(file, target))) ids.push(id);
  }
  return ids;
}

/** A path and, when it is a symlink (even a dangling one), where it points. */
function withLinkTarget(path: string): string[] {
  try {
    if (lstatSync(path).isSymbolicLink()) return [path, resolvePath(dirname(path), readlinkSync(path))];
  } catch {
    // Doesn't exist: just the path.
  }
  return [path];
}

/** sameFile, also following symlinks on either side, dangling ones included. */
function pointsAtSameFile(a: string, b: string): boolean {
  return withLinkTarget(a).some((x) => withLinkTarget(b).some((y) => sameFile(x, y)));
}

/**
 * Names of the environment variables holding the gateway's own credentials,
 * the defaults included (gateway-auth.ts reads MINDSTONE_AGENT_GATEWAY_TOKEN
 * and _PASSWORD when none is configured).
 */
function gatewayCredentialEnvNames(config: MindStoneConfig | undefined): string[] {
  const gateway = config?.gateway as { auth?: { tokenEnv?: unknown; passwordEnv?: unknown }; admin?: { tokenEnv?: unknown } } | undefined;
  return [gateway?.auth?.tokenEnv, gateway?.auth?.passwordEnv, gateway?.admin?.tokenEnv, "MINDSTONE_AGENT_GATEWAY_TOKEN", "MINDSTONE_AGENT_GATEWAY_PASSWORD"]
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim());
}

/**
 * Whether a value is one of the gateway's own credentials: the service token
 * or password as the gateway resolves them, or the admin credential (by its
 * digest). Catches a credential copied into a secret or another variable.
 */
function isGatewayCredentialValue(value: string, config: MindStoneConfig | undefined, configPath: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  const auth = resolveGatewayAuthRequirement({ config: config?.gateway?.auth as Parameters<typeof resolveGatewayAuthRequirement>[0]["config"], configPath });
  const resolved = auth as { token?: string; password?: string };
  if ((resolved.token && resolved.token.trim() === candidate) || (resolved.password && resolved.password.trim() === candidate)) return true;
  const adminDigest = resolveAdminDigest(config, configPath);
  return Boolean(adminDigest && createHash("sha256").update(candidate).digest().equals(adminDigest));
}

/** Providers in the isolated models.json for the Console: URL credentials masked, and the key only named, never shown. */
function registeredProviders(agentDir: string): {
  unreadable: boolean;
  providers: Array<{ providerId: string; name?: string; baseUrl?: string; api?: string; modelCount: number; auth: string }>;
} {
  const read = readIsolatedModelsConfig(agentDir);
  return {
    unreadable: Boolean(read.error),
    providers: Object.entries(read.config.providers).map(([providerId, provider]) => {
      const envRef = typeof provider.apiKey === "string" ? /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(provider.apiKey) : null;
      return {
        providerId,
        name: provider.name,
        baseUrl: typeof provider.baseUrl === "string" ? maskUrlCredentials(provider.baseUrl) : undefined,
        api: provider.api,
        modelCount: provider.models?.length ?? 0,
        auth: !provider.apiKey ? "none" : envRef ? `env: ${envRef[1]}` : "stored key",
      };
    }),
  };
}

/** Loopback, private-network (RFC 1918, IPv6 ULA and link-local) or .local host names. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "host.docker.internal") return true;
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The body of POST /admin/providers/<preset>: at most one of `secret` (a
 * stored secret's name) or `env` (a variable name), an optional http(s)
 * `baseUrl` without credentials, and an optional list of model ids.
 */
function parseProviderRegistration(
  body: Record<string, unknown>,
  defaultBaseUrl: string,
  remote: boolean,
): { error: string } | { secret?: string; env?: string; baseUrl: string; models?: string[] } {
  const allowed = new Set(["secret", "env", "baseUrl", "models"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `unknown field: ${unknown[0]} (a key is given as "secret" or "env", never as a value)` };
  if (body.secret !== undefined && body.env !== undefined) return { error: "send either secret or env, not both" };
  if (body.secret !== undefined && (typeof body.secret !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.secret) || body.secret.includes(".."))) {
    return { error: "secret must be the name of a stored secret" };
  }
  // Only variables named for an API key: a provider key must not be any
  // variable of the gateway process (HOME, a connector's token, …).
  if (body.env !== undefined && (typeof body.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,119}_API_KEY$/.test(body.env))) {
    return { error: "env must be the name of a variable ending in _API_KEY" };
  }
  let baseUrl = defaultBaseUrl;
  // A hosted provider's key only ever goes to that provider.
  if (remote && body.baseUrl !== undefined && body.baseUrl !== defaultBaseUrl) {
    return { error: `this provider's address is fixed (${defaultBaseUrl})` };
  }
  if (!remote && body.baseUrl !== undefined) {
    let url: URL;
    try {
      if (typeof body.baseUrl !== "string") throw new Error("not a string");
      url = new URL(body.baseUrl);
    } catch {
      return { error: "baseUrl must be an http(s) URL" };
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      return { error: "baseUrl must be an http(s) URL with no credentials, query or fragment" };
    }
    // A local server stays local: loopback, a private network or .local.
    if (!isLocalHost(url.hostname)) {
      return { error: "a local server's address must be on this machine or a private network" };
    }
    baseUrl = url.toString().replace(/\/+$/, "");
  }
  let models: string[] | undefined;
  if (body.models !== undefined) {
    if (
      !Array.isArray(body.models) || body.models.length === 0 || body.models.length > 500 ||
      !body.models.every((id) => typeof id === "string" && /^[^\s\u0000-\u001f]{1,200}$/.test(id))
    ) {
      return { error: "models must be a list of 1 to 500 model ids" };
    }
    models = [...new Set(body.models as string[])];
  }
  return {
    ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
    ...(typeof body.env === "string" ? { env: body.env } : {}),
    baseUrl,
    ...(models ? { models } : {}),
  };
}

/** Absolute paths of the files holding the gateway's own credentials (auth and admin token files). */
function hostCredentialFiles(config: MindStoneConfig | undefined, configPath: string): string[] {
  const gateway = config?.gateway as { auth?: { tokenFile?: unknown }; admin?: { tokenFile?: unknown } } | undefined;
  return [gateway?.auth?.tokenFile, gateway?.admin?.tokenFile]
    .filter((file): file is string => typeof file === "string" && file.trim() !== "")
    .map((file) => (isAbsolute(file) ? resolvePath(file) : resolvePath(dirname(configPath), file)));
}

/** A JSON object body, or an error response (then undefined). */
/** When this gateway process started, so the Console can see a restart happen (#90). */
const GATEWAY_STARTED_AT = new Date().toISOString();

const SUPERVISORS = ["launchd", "managed", "systemd", "docker"] as const;
type Supervisor = (typeof SUPERVISORS)[number];

/** The supervisor whoever started this gateway declared (#90). It is never guessed. */
function declaredSupervisor(): Supervisor | undefined {
  const value = process.env.MINDSTONE_AGENT_SUPERVISOR?.trim();
  return SUPERVISORS.find((candidate) => candidate === value);
}

/**
 * The exit code for a restart (EX_TEMPFAIL): non-zero, so a systemd unit with
 * Restart=on-failure or a Docker policy of on-failure restarts it too (#90).
 */
export const RESTART_EXIT_CODE = 75;
let restartRequested = false;
/** The code the gateway process should exit with: RESTART_EXIT_CODE after POST /admin/restart, else 0. */
export function gatewayExitCode(): number {
  return restartRequested ? RESTART_EXIT_CODE : 0;
}

/** How long shutdown may take to let in-flight work finish before the process exits anyway (#90). */
export const SHUTDOWN_CAP_MS = 10_000;

/**
 * The gateway process's SIGINT/SIGTERM handling, shared by main.ts and
 * `mindstone gateway run` (#94 review): close the gateway, capped at
 * SHUTDOWN_CAP_MS, then exit with gatewayExitCode(), so a restart from the
 * Console exits 75 however the gateway was started.
 */
export function exitGatewayOnSignals(gateway: { close(): Promise<void> }): void {
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    await Promise.race([gateway.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_CAP_MS).unref())]);
    process.exit(gatewayExitCode());
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const RESTART_LIMIT = 5;
const RESTART_WINDOW_MS = 10 * 60_000;

function readTimes(path: string): number[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === "number") : [];
  } catch {
    return [];
  }
}

/** Restarts requested from the admin API in the last RESTART_WINDOW_MS. */
function recentRestarts(paths: MindStoneRuntimePaths): number[] {
  return readTimes(`${paths.dataDir}/gateway/restarts.json`).filter((at) => at > Date.now() - RESTART_WINDOW_MS);
}

function recordRestart(paths: MindStoneRuntimePaths, recent: number[]): void {
  writeFileAtomic(`${paths.dataDir}/gateway/restarts.json`, JSON.stringify([...recent, Date.now()]), 0o600);
}

/** Gateway starts in the last RESTART_WINDOW_MS: several in a row with no restart asked for is a crash loop. */
function recentGatewayStarts(paths: MindStoneRuntimePaths): number[] {
  return readTimes(`${paths.dataDir}/gateway/starts.json`).filter((at) => at > Date.now() - RESTART_WINDOW_MS);
}

/** Record this start (the last 20 are kept), for recentStarts in GET /admin/status. */
function recordGatewayStart(paths: MindStoneRuntimePaths): void {
  try {
    const kept = readTimes(`${paths.dataDir}/gateway/starts.json`).slice(-19);
    writeFileAtomic(`${paths.dataDir}/gateway/starts.json`, JSON.stringify([...kept, Date.now()]), 0o600);
  } catch {
    // Best effort: a start is never refused for this.
  }
}

/**
 * Whether the declared supervisor is actually the one running this gateway
 * (#90 review): launchd sets XPC_SERVICE_NAME and is the parent (pid 1);
 * systemd sets INVOCATION_ID, JOURNAL_STREAM or NOTIFY_SOCKET; Docker has
 * /.dockerenv; "managed" means the CLI's PID file names this process.
 */
function supervisorEvidence(supervisor: Supervisor, paths: MindStoneRuntimePaths): { ok: boolean; detail: string } {
  const env = process.env;
  switch (supervisor) {
    case "launchd": {
      const service = env.XPC_SERVICE_NAME?.trim();
      const ok = Boolean(service && service !== "0") && process.ppid === 1;
      return { ok, detail: ok ? `launchd service ${service}` : "it isn't running as a launchd service (no XPC_SERVICE_NAME, or its parent isn't launchd)" };
    }
    case "systemd": {
      const ok = Boolean(env.INVOCATION_ID || env.JOURNAL_STREAM || env.NOTIFY_SOCKET);
      return { ok, detail: ok ? "systemd unit" : "it isn't running under systemd (no INVOCATION_ID, JOURNAL_STREAM or NOTIFY_SOCKET)" };
    }
    case "docker": {
      const ok = existsSync("/.dockerenv");
      return { ok, detail: ok ? "Docker container" : "it isn't running in a Docker container (no /.dockerenv)" };
    }
    case "managed": {
      const plan = managedRestartPlan(paths);
      return "error" in plan ? { ok: false, detail: "the managed PID file doesn't name it" } : { ok: true, detail: "mindstone gateway start" };
    }
  }
}

type ManagedRestartPlan = { script: string; logPath: string; pidPath: string; cwd: string };

/**
 * For a "managed" gateway (`mindstone gateway start`): the files the CLI
 * uses, checked against this process, so a restart starts the same thing
 * again. The PID file must name this process.
 */
function managedRestartPlan(paths: MindStoneRuntimePaths): ManagedRestartPlan | { error: string } {
  const dir = `${paths.dataDir}/gateway`;
  const pidPath = `${dir}/gateway.pid`;
  let recorded = "";
  try {
    recorded = readFileSync(pidPath, "utf-8").trim();
  } catch {
    // Missing: refused below.
  }
  if (recorded !== String(process.pid)) {
    return { error: "this gateway is declared managed, but the managed PID file doesn't name it; restart it on the gateway host" };
  }
  const script = process.argv[1];
  if (!script) return { error: "this gateway's own script path is unknown; restart it on the gateway host" };
  return { script, logPath: `${dir}/gateway.log`, pidPath, cwd: process.cwd() };
}

/**
 * Start a detached helper (its own session, so it outlives this process) that
 * waits for this process to exit, starts the gateway script again with the
 * same environment and log file, and records its PID, as `mindstone gateway
 * restart` does. If the new process doesn't stay up (the port not released
 * yet, say), it tries again a few times. Its progress is in
 * <dataDir>/gateway/restart.json, which `mindstone gateway status` shows.
 */
function spawnRestartHelper(plan: ManagedRestartPlan, paths: MindStoneRuntimePaths): void {
  const helper = `
const { spawn } = require("node:child_process");
const { openSync, writeFileSync } = require("node:fs");
const e = process.env;
const oldPid = Number(e.MSA_RESTART_OLD_PID);
const status = (state, extra) => { try { writeFileSync(e.MSA_RESTART_STATUS, JSON.stringify({ state, oldPid, at: new Date().toISOString(), ...extra }), { mode: 0o600 }); } catch {} };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const env = { ...e };
for (const key of Object.keys(env)) if (key.startsWith("MSA_RESTART_")) delete env[key];
const deadline = Date.now() + 60000;
let attempt = 0;
const start = () => {
  attempt += 1;
  const log = openSync(e.MSA_RESTART_LOG, "a", 0o600);
  const child = spawn(process.execPath, [e.MSA_RESTART_SCRIPT], { cwd: e.MSA_RESTART_CWD, detached: true, env, stdio: ["ignore", log, log] });
  child.unref();
  writeFileSync(e.MSA_RESTART_PIDFILE, child.pid + "\\n", { mode: 0o600 });
  status("started", { newPid: child.pid, attempt });
  setTimeout(() => {
    if (alive(child.pid)) return status("running", { newPid: child.pid, attempt });
    if (attempt < 5) return setTimeout(start, 1000);
    status("failed", { newPid: child.pid, attempt, error: "the new gateway exited right after starting; see the gateway log" });
  }, 3000);
};
const wait = () => {
  if (!alive(oldPid)) return start();
  if (Date.now() > deadline) return status("failed", { error: "the old gateway didn't exit within 60 s" });
  setTimeout(wait, 200);
};
status("waiting");
wait();`;
  const child = spawn(process.execPath, ["-e", helper], {
    cwd: plan.cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MSA_RESTART_OLD_PID: String(process.pid),
      MSA_RESTART_SCRIPT: plan.script,
      MSA_RESTART_LOG: plan.logPath,
      MSA_RESTART_PIDFILE: plan.pidPath,
      MSA_RESTART_CWD: plan.cwd,
      MSA_RESTART_STATUS: `${paths.dataDir}/gateway/restart.json`,
    },
  });
  // If the helper can't start, say so where `mindstone gateway status` looks,
  // rather than throw while the gateway is shutting down (#94 review).
  child.on("error", (error) => {
    try {
      writeFileAtomic(`${paths.dataDir}/gateway/restart.json`, JSON.stringify({ state: "failed", oldPid: process.pid, at: new Date().toISOString(), error: `the restart helper didn't start: ${error.message}` }), 0o600);
    } catch {
      // Nothing more to do while exiting.
    }
  });
  child.unref();
}

/** How long doctor's network probes may take, so GET /admin/doctor answers inside the Console proxy's 15 s timeout (#86). */
const DOCTOR_PROBE_MS = 8_000;
/** The most of a log file GET /admin/logs reads from its end. */
const LOG_TAIL_BYTES = 512 * 1024;

/** A promise's value, or `fallback` once `ms` have passed. */
/** An embedding provider spec the Console may check: provider:model (#102). */
const EMBEDDING_SPEC = /^(ollama|openai|openai-compatible):[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
/**
 * An Ollama model from the default registry: `name[:tag]`, or a
 * `namespace/name[:tag]` there. No host (a dot in the first segment), no
 * `..`, so nothing is pulled from another registry.
 */
const OLLAMA_MODEL_NAME = /^(?:[a-z0-9][a-z0-9_-]{0,63}\/)?[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,63})?$/;
const MEMORY_CHECK_MS = 20_000;
const OLLAMA_PULL_MS = 15 * 60_000;
let ollamaPullRunning = false;
/** The Ollama model the last memory check reported missing: the only one a pull may fetch (#111 review). */
let lastMissingOllamaModel: string | undefined;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The last `count` lines of a file, reading at most LOG_TAIL_BYTES from its
 * end (a partial first line is dropped). Undefined if there is no such file.
 */
function readLogTail(path: string, count: number): string[] | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString("utf-8");
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    const all = text.split(/\r?\n/);
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.slice(-count);
  } finally {
    closeSync(fd);
  }
}

/** /admin/approvals/<id> and /admin/approvals/<id>/(approve|reject): ids are UUIDs, or a unique prefix of at least 8. */
const APPROVAL_PATH = /^\/admin\/approvals\/([0-9a-f-]{8,36})(?:\/(approve|reject))?$/;

/** What the approvals list shows: no draft text, memory content or mutation data. */
/** A skill error for the Console: paths relative to the skills directory, and no CLI flags (#104). */
function publicSkillText(text: string, skillsDir: string): string {
  return text
    .split(skillsDir)
    .join("skills")
    .replace(/ \(use --force to [^)]*\)/g, "; send force to replace it")
    .replace(/ \(--[a-z-]+( or --[a-z-]+)?\)/g, "");
}

function approvalSummary(action: ProposedAction) {
  return {
    id: action.id,
    status: action.status,
    kind: action.kind,
    connectorId: action.connectorId,
    summary: action.summary,
    createdAt: action.createdAt,
    decidedAt: action.decidedAt,
    decidedBy: action.decidedBy,
    decisionNote: action.decisionNote,
    queueState: action.queueState,
  };
}

async function readAdminBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await readJsonBody(req, 256 * 1024);
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
    sendJson(res, 400, { ok: false, error: "the body must be a JSON object" });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return undefined;
}

/** Whether anything, even a dangling link, has this name. */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a file that must not exist yet (an exclusive open, which fails if
 * the name is taken, on every filesystem). False when it was taken.
 */
function createFileExclusive(path: string, content: string, mode: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    removeOrEmpty(path);
    throw error;
  }
  closeSync(fd);
  chmodSync(path, mode);
  return true;
}

/** Remove a file just written, or at least empty it. False if neither worked. */
function removeOrEmpty(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    try {
      writeFileSync(path, "");
      return true;
    } catch {
      return false;
    }
  }
}

function writeFileAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(temp, content, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    // Don't leave the content (a secret, for the secrets endpoint) behind (#78).
    try {
      unlinkSync(temp);
    } catch {
      // Never written, or already gone.
    }
    throw error;
  }
}

/** Append-only audit of admin writes and refusals, with the deciding user id. Never holds secret values. */
function appendAdminAudit(dataDir: string, event: Record<string, unknown>): void {
  mkdirSync(`${dataDir}/admin`, { recursive: true });
  // Caller-chosen strings (user id, path) are capped so one entry stays small.
  const cap = (value: unknown): unknown =>
    typeof value === "string" && value.length > 200
      ? `${value.slice(0, 200)}…`
      : Array.isArray(value)
        ? value.slice(0, 50).map(cap)
        : value;
  const capped = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, cap(value)]));
  appendFileSync(`${dataDir}/admin/audit.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), ...capped })}\n`, { mode: 0o600 });
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

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    try {
      await handleAdminRequest(req, res, url);
    } catch (error) {
      try {
        appendAdminAudit(runtimePathsFromEnv().dataDir, {
          userId: forwardedUser(req).userId ?? null,
          action: "failed",
          status: 500,
          method: req.method,
          path: url.pathname,
          error: String(error).slice(0, 200),
        });
      } catch {
        // The audit itself failed; the response still goes out.
      }
      // Never echo internal error text from the admin API.
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "the admin API hit an internal error" });
    }
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
    // A present but non-string or blank app/tenant/user id would be dropped and
    // the run would fall back to the owner (#70): refuse it.
    const badScopeFields = invalidScopeFields({ ...(input as Record<string, unknown>), agentId });
    if (badScopeFields.length) {
      sendJson(res, 400, { ok: false, error: `${badScopeFields.join(", ")} must be non-empty strings without ":" when given` });
      return;
    }
    const scope = scopeFromRequest({
      appId: stringParam(input.appId),
      tenantId: stringParam(input.tenantId),
      userId: stringParam(input.userId),
      agentId,
    });
    const sessionKey = stringParam(input.sessionKey)?.trim() || scopedSessionKey(scope);
    if (!scopeSessionKeyAllowed(scope, sessionKey)) {
      // A scoped run may not read or write the owner's or another tenant's session (#70).
      sendJson(res, 403, { ok: false, error: `sessionKey ${sessionKey} is outside this run's scope` });
      return;
    }
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
      // An app-, tenant- or user-scoped run isn't the owner (#70): no owner
      // profile, memory index, private invariants or handoff; scoped recall stays.
      audience: scope.appId || scope.tenantId || scope.userId ? "tenant" : "owner",
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
    const routed = await runConfiguredRoute({ sessionKey, agentId, audience: "owner", config: loadedConfig.config, configPath: loadedConfig.path, metadata });
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

    // The same audience and session rules as chat completions (#112 review).
    const caller = consoleTurnCaller(req, input, loadedConfig.config, "openai-responses");
    if ("error" in caller) {
      sendJson(res, 400, openAiError(caller.error, "invalid_request_error", "missing_user"));
      return;
    }
    const { audience, metadata, model, agentId, senderId, sessionKey } = caller;
    const source = gatewayTranscriptSource({ substrate: "openai", channel: "openai-responses", chatType: "internal", senderId });
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
        // Whose turn it was (#106), after the input's own metadata so it can't be set by the caller.
        ownerTurn: audience === "owner",
      },
    }));

    const routed = await runConfiguredRoute({ sessionKey, agentId, audience, config: loadedConfig.config, configPath: loadedConfig.path, metadata: { ...metadata, model } });
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
          entries: [...persistedEntries, entryForAudience(routedBody.entry, audience)].filter(Boolean),
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

    const caller = consoleTurnCaller(req, input, loadedConfig.config, "openai-chat-completions");
    if ("error" in caller) {
      sendJson(res, 400, openAiError(caller.error, "invalid_request_error", "missing_user"));
      return;
    }
    const { forwarded, roleHeaderSent, audience, metadata, model, agentId, senderId, sessionKey } = caller;

    const source = gatewayTranscriptSource({ substrate: "openai", channel: "openai-chat-completions", chatType: "internal", senderId });
    // The gateway already holds the conversation (#38): clients such as LibreChat
    // resend the whole history every turn, so only the new turn is stored: the
    // trailing user messages. Client system prompts follow CONSOLE_DESIGN §4.2:
    // ignored for a Console "user", kept for an admin or a direct API caller
    // (service token, no forwarded role), stored once per session, always logged.
    const newTurnStart = newChatCompletionsTurnStart(messages);
    const records = messages.map((message) => (typeof message === "object" && message !== null ? message as Record<string, unknown> : {}));
    const clientSystemTexts = records
      .filter((record) => record.role === "system" || record.role === "developer")
      .map((record) => transcriptTextFromOpenAiContent(record.content)?.trim())
      .filter((text): text is string => Boolean(text));
    // A role header that is present but blank (LibreChat blanks a placeholder it
    // can't fill) is an unknown user, not a trusted caller.
    const keepClientSystem = forwarded.userRole ? forwarded.userRole.toLowerCase() === "admin" : !roleHeaderSent;
    const keptSystemEntries: TranscriptEntry[] = [];
    const commonMetadata = {
      source: "openai-chat-completions",
      model,
      // Whose turn it was (#106): the recall index leaves out turns that weren't the owner's.
      ownerTurn: audience === "owner",
      ...(forwarded.userRole ? { userRole: forwarded.userRole } : {}),
      ...(forwarded.conversationId ? { conversationId: forwarded.conversationId } : {}),
    };
    if (newTurnStart < messages.length && clientSystemTexts.length > 0) {
      const existing = readTranscriptEntries(sessionKey);
      const stored = new Set(existing.filter((entry) => entry.role === "system").map((entry) => entry.text?.trim()));
      const ignored = new Set(
        existing.filter((entry) => entry.metadata?.event === "client_system_prompt_ignored").map((entry) => entry.metadata?.promptHash),
      );
      for (const text of clientSystemTexts) {
        if (keepClientSystem && stored.has(text)) continue;
        const promptHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
        if (!keepClientSystem && ignored.has(promptHash)) continue;
        if (keepClientSystem) {
          keptSystemEntries.push(appendTranscriptEntry({ sessionKey, agentId, role: "system", text, source, metadata: { ...commonMetadata, clientSystemPrompt: "kept" } }));
          stored.add(text);
        } else {
          appendTranscriptEntry({
            sessionKey,
            agentId,
            role: "event",
            text: `A client system prompt (${text.length} characters) was ignored: the ${forwarded.userRole} role can't set one.`,
            source,
            metadata: { ...commonMetadata, event: "client_system_prompt_ignored", length: text.length, promptHash },
          });
          ignored.add(promptHash);
        }
      }
    }
    const resentSkipped = records.slice(0, newTurnStart).filter((record) => record.role !== "system" && record.role !== "developer").length;
    const turnEntries = messages.slice(newTurnStart).map((message, offset) => {
      const index = newTurnStart + offset;
      const record = records[index]!;
      return appendTranscriptEntry({
        sessionKey,
        agentId,
        role: openAiRoleToTranscriptRole(record.role),
        text: transcriptTextFromOpenAiContent(record.content),
        content: record.content,
        source,
        metadata: {
          ...commonMetadata,
          messageIndex: index,
          originalRole: record.role,
          ...(offset === 0 && resentSkipped > 0 ? { resentMessagesSkipped: resentSkipped } : {}),
        },
      });
    });
    const persistedEntries = [...keptSystemEntries, ...turnEntries];
    if (turnEntries.length === 0) {
      sendJson(res, 400, openAiError("the last message must be a user message", "invalid_request_error", "invalid_messages"));
      return;
    }
    // The owner's first Console conversation after setup starts identity
    // formation, once per agent, not once per conversation (#102). Only a
    // Console conversation: a script calling with the service token doesn't
    // use it up.
    const pending = audience === "owner" && forwarded.conversationId
      ? pendingIdentityFormation(loadedConfig.config, loadedConfig.path, agentId, sessionKey)
      : undefined;
    const identityFormation = pending && claimIdentityFormation(agentId, sessionKey) ? pending : undefined;
    let routed: Awaited<ReturnType<typeof runConfiguredRoute>>;
    try {
      routed = await runConfiguredRoute({ sessionKey, agentId, audience, config: loadedConfig.config, configPath: loadedConfig.path, metadata: { ...metadata, model }, identityFormation });
    } catch (error) {
      if (identityFormation) releaseIdentityFormation(agentId);
      throw error;
    }
    if (identityFormation && !(routed.routed && routed.status === 200)) releaseIdentityFormation(agentId);
    if (routed.routed && routed.status === 200 && input.stream === true) {
      // OpenAI-compatible server-sent events. LibreChat (and the openai/langchain clients generally)
      // send `stream: true` unconditionally and cannot parse a plain chat.completion body, so a
      // streaming client gets the routed answer as one content chunk, a stop chunk, and [DONE].
      // Token-level deltas from the runner's stream are a follow-up; the wire format is final.
      const routedBody = routed.body as { entry?: TranscriptEntry; runId?: string };
      sendOpenAiStream(res, {
        id: `chatcmpl-${routedBody.runId ?? Date.now().toString(36)}`,
        model,
        content: routedBody.entry?.text ?? "",
      });
      return;
    }
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
          entries: [...persistedEntries, entryForAudience(routedBody.entry, audience)].filter(Boolean),
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

/**
 * Report a connector queue problem in the gateway's log (stderr) and in the
 * connector's runtime status. The same message is logged at most once a
 * minute, so a queue that stays unreadable doesn't flood the log.
 */
const lastQueueReport = new Map<string, { message: string; at: number }>();
function reportConnectorQueueError(
  connectorId: string,
  message: string,
  running?: RunningConnector,
  options: { repeating?: boolean; info?: boolean } = {},
): void {
  // Only a report that repeats on a timer (the drain timer) is de-duplicated;
  // each reply's own failures are always logged (#77 round 3).
  if (options.repeating) {
    const last = lastQueueReport.get(connectorId);
    const now = Date.now();
    if (last && last.message === message && now - last.at < 60_000) return;
    lastQueueReport.set(connectorId, { message, at: now });
  }
  process.stderr.write(`[mindstone-gateway] connector ${connectorId}: ${message}\n`);
  // Good news is logged only: it must not replace an error in the status.
  if (options.info) return;
  writeConnectorRuntimeStatus({
    connectorId,
    state: "running",
    lastError: message,
    ...(running ? { inboundCount: running.inboundCount, deniedCount: running.deniedCount } : {}),
    updatedAt: new Date().toISOString(),
  });
}

/** Replies waiting to be retried into the queue, so a gateway stop can report them as lost. */
const pendingReplyRetries = new Set<{
  connectorId: string;
  chatId?: string;
  running: RunningConnector;
  timer: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
}>();

/** Waits between later attempts to queue a reply the queue refused (locked, EIO, EMFILE, unreadable): about 13 minutes in all. */
export const CONNECTOR_ENQUEUE_RETRY_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

/**
 * Queue a reply. If the queue refuses it, the failure is logged and the reply
 * is retried in the background (held in memory, so the inbound handler isn't
 * held up), then drained once queued, so a transient error doesn't drop it
 * silently (#77 review). A gateway restart during the retries, or running out
 * of retries, loses it; that is logged as a lost reply. Returns the queue
 * when the first attempt succeeded.
 */
function enqueueConnectorReply(
  connectorId: string,
  outbound: ConnectorOutboundMessage,
  running: RunningConnector,
  drain: (queue: ConnectorDeliveryQueue) => Promise<unknown>,
  retryMs: readonly number[] = CONNECTOR_ENQUEUE_RETRY_MS,
): ConnectorDeliveryQueue | undefined {
  const queue = new ConnectorDeliveryQueue(connectorId);
  const attempt = (n: number): boolean => {
    try {
      queue.enqueue(outbound, { now: new Date().toISOString() });
      if (n > 1) reportConnectorQueueError(connectorId, `a reply to chat ${outbound.chatId ?? "(unknown)"} was queued on attempt ${n}`, running, { info: true });
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (n > retryMs.length) {
        reportConnectorQueueError(
          connectorId,
          `a reply to chat ${outbound.chatId ?? "(unknown)"} was LOST: it could not be queued after ${n} attempts (${reason}); its text is in the session transcript`,
          running,
        );
      } else {
        reportConnectorQueueError(connectorId, `could not queue a reply (attempt ${n}): ${reason}; retrying in ${Math.round(retryMs[n - 1]! / 1000)}s`, running);
      }
      return false;
    }
  };
  if (attempt(1)) return queue;
  // Held in memory until queued; a gateway stop logs it as lost (#77 round 3).
  const pending = { connectorId, chatId: outbound.chatId, running, timer: undefined as ReturnType<typeof setTimeout> | undefined, stopped: false };
  pendingReplyRetries.add(pending);
  void (async () => {
    try {
      for (let n = 2; n <= retryMs.length + 1; n += 1) {
        await new Promise<void>((resolve) => {
          pending.timer = setTimeout(resolve, retryMs[n - 2]);
        });
        if (pending.stopped) return;
        if (attempt(n)) {
          await drain(queue);
          return;
        }
      }
    } finally {
      pendingReplyRetries.delete(pending);
    }
  })().catch((error) =>
    reportConnectorQueueError(connectorId, `delivery drain failed: ${error instanceof Error ? error.message : String(error)}`, running),
  );
  return undefined;
}

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
      // connector-native metadata first (e.g. email subject, sensitiveSource
      // marker) so pipeline fields below always win on collision
      ...(message.metadata ?? {}),
      event: "user_message",
      connector: connectorId,
      messageId: message.messageId,
      threadId: message.threadId,
      triggered: trigger.respond,
      triggerReason: trigger.reason,
      // Read by the memory backfill: non-owner turns stay out of the owner's recall (#62).
      ownerTurn: isConnectorOwnerMessage({ config: ctx.config, connectorId, message }),
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
    audience: isConnectorOwnerMessage({ config: ctx.config, connectorId, message }) ? "owner" : "non_owner",
    config: loadedConfig.config,
    configPath: loadedConfig.path,
    metadata: { connector: connectorId },
  });
  if (!routed.routed) return;
  if (routed.status !== 200) {
    // A failed run's text is an internal error, never a reply: it goes to the
    // runtime status (and the transcript already holds routing_failed), not
    // into the chat, which may be a shared group (#63).
    const error = (routed.body as { error?: unknown } | undefined)?.error;
    writeConnectorRuntimeStatus({
      connectorId,
      state: "running",
      lastError: `run failed for an inbound message (status ${routed.status}): ${typeof error === "string" ? error : "unknown error"}`,
      inboundCount: running.inboundCount,
      deniedCount: running.deniedCount,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const body = routed.body as { entry?: { text?: string } } | undefined;
  // Proposal blocks (memory writes, mutations) are already extracted into
  // pending ProposedActions by the core chat turn (issues #21/#22) — the
  // routed text arrives here pre-stripped.
  const replyText = body?.entry?.text;
  if (!replyText?.trim()) return; // no reply, or the reply was only proposal blocks

  const outbound = {
    text: replyText,
    chatId: message.chatId,
    threadId: message.threadId,
    inReplyToMessageId: message.messageId,
    metadata: message.chatType ? { chatType: message.chatType } : {},
  };
  const connector = getConnector(connectorId);

  // Send policy (issue #21): approval_required diverts the reply into the
  // durable ProposedAction store — an explicit human approve enqueues it onto
  // the normal delivery queue; nothing sends without a decision.
  const sendPolicy = resolveConnectorSendPolicy({ connectorDefault: connector?.defaultSendPolicy, channelConfig });
  if (sendPolicy === "approval_required") {
    const approvals = new ApprovalStore();
    const proposal = approvals.propose({
      kind: "connector_send",
      connectorId,
      sessionKey,
      agentId,
      createdAt: new Date().toISOString(),
      summary: `send via ${connectorId} to ${message.chatId ?? "(unknown chat)"}: ${replyText.slice(0, 80)}${replyText.length > 80 ? "…" : ""}`,
      send: outbound,
    });
    appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: `approval proposed: connector_send ${proposal.id} via ${connectorId} (draft held, not sent)`,
      source,
      metadata: { event: "approval_proposed", approvalId: proposal.id, kind: "connector_send", connector: connectorId },
    });
    return;
  }

  const drain = (queue: ConnectorDeliveryQueue) =>
    connector ? queue.drain((entry) => connector.sendOutbound(ctx, entry.message), { now: new Date().toISOString() }) : Promise.resolve();
  const queue = enqueueConnectorReply(connectorId, outbound, running, drain);
  if (!queue) return;
  await drain(queue);
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
        let pending: number;
        try {
          pending = queue.pending().length;
        } catch (error) {
          // An unreadable queue is reported, never read as empty (#77 review).
          reportConnectorQueueError(connectorId, `delivery queue: ${error instanceof Error ? error.message : String(error)}`, running, { repeating: true });
          return;
        }
        if (pending === 0) return;
        void queue
          .drain((entry) => connector.sendOutbound(ctx, entry.message), { now: new Date().toISOString() })
          .catch((error) => reportConnectorQueueError(connectorId, `delivery drain failed: ${error instanceof Error ? error.message : String(error)}`, running));
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
  // A reply still waiting to be queued is held only in memory: say it's lost.
  for (const pending of pendingReplyRetries) {
    pending.stopped = true;
    if (pending.timer) clearTimeout(pending.timer);
    reportConnectorQueueError(
      pending.connectorId,
      `a reply to chat ${pending.chatId ?? "(unknown)"} was LOST: the gateway stopped while it was waiting to be queued; its text is in the session transcript`,
      pending.running,
    );
  }
  pendingReplyRetries.clear();
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
  recordGatewayStart(runtimePathsFromEnv());
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
