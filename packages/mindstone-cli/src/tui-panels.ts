import { existsSync, statSync } from "node:fs";
import {
  getCurrentHandoffStatus,
  getMindStoneDoctorReport,
  getSqliteMemoryIndexStats,
  listTranscriptSessions,
  loadMindStoneConfig,
  loadMindStoneIdentity,
  planMindStonePromptWindow,
  runtimePathsFromEnv,
  transcriptPathForSession,
  type MindStoneModelInfo,
  type TranscriptEntry,
} from "@mindstone-agent/core";
import { piSessionFileForKey } from "@mindstone-agent/gateway";

export type TuiCommandContext = {
  agentId: string;
  sessionKey: string;
  model: MindStoneModelInfo;
  routingMode: "mock" | "pi" | "pi-session";
};

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function transcriptEntryText(entry: TranscriptEntry): string {
  return (entry.text ?? textFromContent(entry.content) ?? "").trim();
}

function eventEntryLabel(entry: TranscriptEntry): string | undefined {
  const metadataEvent = typeof entry.metadata?.event === "string" ? entry.metadata.event : undefined;
  const text = transcriptEntryText(entry);
  if (text) return text;
  if (metadataEvent) return metadataEvent.replaceAll("_", " ");
  return undefined;
}

function substrateEventDetail(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
  const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;
  const parts = [type, toolName ? `tool ${toolName}` : undefined, toolCallId ? `call ${toolCallId}` : undefined, message].filter(Boolean);
  return parts.length ? parts.join(" • ") : undefined;
}


export function buildTuiStatusPanel(params: {
  ctx: TuiCommandContext;
  configPath: string;
  historyLimit: number;
  renderedHistoryCount: number;
  transcriptDir: string;
  piSessionDir: string;
}): string {
  return [
    `- agent: \`${params.ctx.agentId}\``,
    `- session: \`${params.ctx.sessionKey}\``,
    `- route: \`${params.ctx.routingMode}\``,
    `- model: \`${params.ctx.model.id}\``,
    `- provider: \`${params.ctx.model.provider}\``,
    `- transcript dir: \`${params.transcriptDir}\``,
    `- pi session dir: \`${params.piSessionDir}\``,
    `- config: \`${params.configPath}\``,
    `- loaded history: \`${params.renderedHistoryCount}/${params.historyLimit}\``,
  ].join("\n");
}

export function buildTuiMemoryPanel(config: ReturnType<typeof loadMindStoneConfig>["config"], paths: ReturnType<typeof runtimePathsFromEnv>): string {
  const stats = getSqliteMemoryIndexStats(paths);
  return [
    `- autoRecall: \`${config?.memory?.autoRecall === true ? "enabled" : "disabled"}\``,
    `- vector store: \`${config?.memory?.vectorStore ?? "memory"}\``,
    `- embedding provider: \`${config?.memory?.embeddingProvider ?? "not configured"}\``,
    `- index present: \`${stats.present}\``,
    `- sources: \`${stats.sources}\``,
    `- chunks: \`${stats.chunks}\``,
    `- embedded chunks: \`${stats.embeddedChunks}\``,
    `- vector backend: \`${stats.vectorBackend}\``,
    `- sqlite-vec available: \`${stats.sqliteVec.available}\``,
    stats.sqliteVec.version ? `- sqlite-vec version: \`${stats.sqliteVec.version}\`` : undefined,
    stats.sqliteVec.error ? `- sqlite-vec note: \`${stats.sqliteVec.error}\`` : undefined,
    stats.updatedAt ? `- updated: \`${stats.updatedAt}\`` : undefined,
    stats.error ? `- error: \`${stats.error}\`` : undefined,
    `- database: \`${stats.databasePath}\``,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function fileStatus(path: string): { exists: boolean; bytes: number; updatedAt?: string } {
  if (!existsSync(path)) return { exists: false, bytes: 0 };
  const stats = statSync(path);
  return { exists: true, bytes: stats.size, updatedAt: stats.mtime.toISOString() };
}

export function buildTuiPiPanel(params: {
  config: ReturnType<typeof loadMindStoneConfig>["config"];
  ctx: TuiCommandContext;
  paths: ReturnType<typeof runtimePathsFromEnv>;
}): string {
  const agentDir = params.config?.routing?.pi?.agentDir ?? params.paths.piAgentDir;
  const sessionFile = piSessionFileForKey(params.paths.piSessionDir, params.ctx.sessionKey);
  const status = fileStatus(sessionFile);
  return [
    `- routing mode: \`${params.ctx.routingMode}\``,
    `- pi-session runner selected: \`${params.ctx.routingMode === "pi-session"}\``,
    `- project root: \`${params.paths.root}\``,
    `- isolated Pi agent dir: \`${agentDir}\``,
    `- isolated Pi session dir: \`${params.paths.piSessionDir}\``,
    `- cwd: \`${params.config?.workspace?.root ?? process.cwd()}\``,
    `- default model: \`${params.config?.routing?.defaultModel ?? params.ctx.model.id}\``,
    `- active MindStone session: \`${params.ctx.sessionKey}\``,
    `- deterministic Pi session file: \`${sessionFile}\``,
    `- Pi session file exists: \`${status.exists}\``,
    `- Pi session file bytes: \`${status.bytes}\``,
    status.updatedAt ? `- Pi session file updated: \`${status.updatedAt}\`` : undefined,
    "",
    "This panel is diagnostic only. It does not open, compact, or mutate the Pi session.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildTuiTranscriptPanel(params: {
  ctx: TuiCommandContext;
  entries: TranscriptEntry[];
  paths: ReturnType<typeof runtimePathsFromEnv>;
  summaries?: ReturnType<typeof listTranscriptSessions>;
}): string {
  const summaries = params.summaries ?? listTranscriptSessions({ paths: params.paths });
  const summary = summaries.find((item) => item.sessionKey === params.ctx.sessionKey);
  const events = params.entries.filter((entry) => entry.role === "event").length;
  const roles = params.entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.role] = (counts[entry.role] ?? 0) + 1;
    return counts;
  }, {});
  const roleCounts = Object.entries(roles).map(([role, count]) => `${role}:${count}`).join(" ") || "none";
  return [
    `- session: \`${params.ctx.sessionKey}\``,
    `- path: \`${summary?.path ?? transcriptPathForSession(params.ctx.sessionKey, { paths: params.paths })}\``,
    `- exists: \`${Boolean(summary)}\``,
    `- entries on disk: \`${summary?.entries ?? 0}\``,
    `- entries read: \`${params.entries.length}\``,
    `- role counts read: \`${roleCounts}\``,
    `- event entries read: \`${events}\``,
    `- bytes: \`${summary?.bytes ?? 0}\``,
    summary?.updatedAt ? `- updated: \`${summary.updatedAt}\`` : undefined,
    "",
    "Transcript history is append-only. This panel does not prune, compact, or rewrite it.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildTuiGatewayPanel(config: ReturnType<typeof loadMindStoneConfig>["config"]): string {
  const host = config?.gateway?.host ?? "127.0.0.1";
  const port = config?.gateway?.port ?? 19789;
  const auth = config?.gateway?.auth ?? { mode: "none" as const };
  const authSource = auth.mode === "none"
    ? "none required"
    : auth.mode === "token"
      ? [auth.tokenEnv ? `env ${auth.tokenEnv}` : undefined, auth.tokenFile ? `file ${auth.tokenFile}` : undefined].filter(Boolean).join("; ") || "token source not specified"
      : auth.passwordEnv ? `env ${auth.passwordEnv}` : "password source not specified";
  return [
    `- endpoint: \`http://${host}:${port}\``,
    `- health: \`http://${host}:${port}/health\``,
    `- status: \`http://${host}:${port}/status\``,
    `- WebChat shell: \`http://${host}:${port}/webchat\``,
    `- auth mode: \`${auth.mode}\``,
    `- auth source: \`${authSource}\``,
    `- chat completions enabled: \`${config?.gateway?.http?.chatCompletions?.enabled === true}\``,
    `- responses enabled: \`${config?.gateway?.http?.responses?.enabled === true}\``,
    `- REST chat surfaces: \`/chat/sessions /chat/history /chat/send /chat/abort\``,
    `- RPC surfaces: \`/rpc /ws\``,
    `- OpenAI surfaces: \`/v1/models /v1/chat/completions\``,
    `- live probe: \`not run\``,
    "",
    "Secret values are intentionally not displayed. This panel does not start, stop, or probe the Gateway.",
  ].join("\n");
}

export function buildTuiConfigPanel(params: {
  config: ReturnType<typeof loadMindStoneConfig>["config"];
  configPath: string;
  paths: ReturnType<typeof runtimePathsFromEnv>;
}): string {
  const config = params.config;
  const authMode = config?.gateway?.auth?.mode ?? "none";
  const authConfigured = authMode === "none"
    ? "not required"
    : authMode === "token"
      ? "token source configured; value hidden"
      : "password source configured; value hidden";
  const contextMode = config?.contextManagement?.mode ?? "sliding_window";
  return [
    `- config path: \`${params.configPath}\``,
    `- workspace root: \`${config?.workspace?.root ?? "not configured"}\``,
    `- runtime root: \`${params.paths.root}\``,
    `- agents configured: \`${Object.keys(config?.agents ?? {}).length}\``,
    `- routing mode: \`${config?.routing?.mode ?? "placeholder"}\``,
    `- default agent: \`${config?.routing?.defaultAgentId ?? "default"}\``,
    `- default model: \`${config?.routing?.defaultModel ?? "not configured"}\``,
    `- session mode: \`${config?.session?.mode ?? "single"}\``,
    `- default session: \`${config?.session?.defaultSessionKey ?? "agent:default:main"}\``,
    `- context mode: \`${contextMode}\``,
    `- memory autoRecall: \`${config?.memory?.autoRecall === true}\``,
    `- memory vector store: \`${config?.memory?.vectorStore ?? "memory"}\``,
    `- embedding provider: \`${config?.memory?.embeddingProvider ?? "not configured"}\``,
    `- gateway: \`${config?.gateway?.host ?? "127.0.0.1"}:${config?.gateway?.port ?? 19789}\``,
    `- gateway auth mode: \`${authMode}\``,
    `- gateway auth status: \`${authConfigured}\``,
    `- OpenAI chat completions: \`${config?.gateway?.http?.chatCompletions?.enabled !== false}\``,
    `- OpenResponses: \`${config?.gateway?.http?.responses?.enabled === true}\``,
    `- runner stream persistence: \`${config?.observability?.runnerStream?.persistTranscriptEvents === true}\``,
    config?.observability?.runnerStream?.eventTypes?.length
      ? `- runner stream event types: \`${config.observability.runnerStream.eventTypes.join(", ")}\``
      : undefined,
    config?.observability?.runnerStream?.maxEvents !== undefined
      ? `- runner stream max events: \`${config.observability.runnerStream.maxEvents}\``
      : undefined,
    "",
    "Secret values are intentionally not displayed.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildTuiContextPanel(params: {
  config: ReturnType<typeof loadMindStoneConfig>["config"];
  ctx: TuiCommandContext;
  entries: TranscriptEntry[];
}): string {
  const planned = planMindStonePromptWindow({
    entries: params.entries,
    model: params.ctx.model,
    config: params.config,
  });
  const policy = planned.policy;
  const policyLines = policy.mode === "sliding_window"
    ? [
        `- policy: \`sliding_window\``,
        `- ceiling/floor: \`${policy.ceilingPercent}% / ${policy.floorPercent}%\``,
        `- min recent messages: \`${policy.minRecentMessages}\``,
        `- preserve transcript: \`${policy.preserveTranscript}\``,
      ]
    : [
        `- policy: \`auto_compact\``,
        `- checkpoint/compact: \`${policy.checkpointWarningPercent}% / ${policy.compactTargetPercent}%\``,
        `- keep recent tokens: \`${policy.keepRecentTokens}\``,
        `- emergency auto-handoff: \`${policy.emergencyAutoHandoff}\``,
      ];
  return [
    ...policyLines,
    `- context window: \`${params.ctx.model.contextWindowTokens ?? 128_000}\` tokens`,
    `- transcript entries read: \`${params.entries.length}\``,
    `- prompt entries selected: \`${planned.promptEntries.length}\``,
    `- pruned entries: \`${planned.prunedEntries.length}\``,
    `- tokens before/after: \`${planned.tokensBefore} / ${planned.tokensAfter}\``,
    `- utilization before/after: \`${planned.utilizationBeforePercent.toFixed(1)}% / ${planned.utilizationAfterPercent.toFixed(1)}%\``,
    `- pruned: \`${planned.pruned}\``,
    planned.autoCompactEvent ? `- auto-compact event: \`${planned.autoCompactEvent.event}\`` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function buildTuiDoctorPanel(): string {
  const report = getMindStoneDoctorReport();
  const notable = report.checks.filter((check) => check.severity !== "pass").slice(0, 12);
  const lines = [
    `- result: \`${report.ok ? "ok" : "needs attention"}\``,
    `- pass/warn/fail/info: \`${report.summary.pass} / ${report.summary.warn} / ${report.summary.fail} / ${report.summary.info}\``,
  ];
  if (notable.length === 0) {
    lines.push("", "No warnings, failures, or info checks to show.");
  } else {
    lines.push("", ...notable.map((check) => {
      const detail = check.detail ? ` — ${check.detail}` : "";
      return `- ${check.severity}: \`${check.id}\` — ${check.title}${detail}`;
    }));
  }
  return lines.join("\n");
}

export function buildTuiHandoffPanel(paths: ReturnType<typeof runtimePathsFromEnv>): string {
  const handoff = getCurrentHandoffStatus(paths);
  return [
    `- exists: \`${handoff.exists}\``,
    `- path: \`${handoff.path}\``,
    `- bytes: \`${handoff.bytes}\``,
    handoff.updatedAt ? `- updated: \`${handoff.updatedAt}\`` : undefined,
    handoff.tokenEstimate !== undefined ? `- token estimate: \`${handoff.tokenEstimate}\`` : undefined,
    handoff.sha256 ? `- sha256: \`${handoff.sha256.slice(0, 16)}…\`` : undefined,
    "",
    handoff.exists
      ? "This handoff can be replayed into prompt context once per transcript continuity span."
      : "No current handoff exists for this runtime.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildTuiIdentityPanel(params: {
  config: ReturnType<typeof loadMindStoneConfig>["config"];
  configPath: string;
  ctx: TuiCommandContext;
}): string {
  const agent = params.config?.agents?.[params.ctx.agentId];
  if (!agent) {
    return [
      `- agent: \`${params.ctx.agentId}\``,
      "- configured: `false`",
      "",
      "No configured agent identity is available for this TUI context.",
    ].join("\n");
  }
  const loaded = loadMindStoneIdentity(params.ctx.agentId, agent, params.configPath);
  const identityChars = loaded.identity?.identityMarkdown.length ?? 0;
  const userChars = loaded.identity?.userMarkdown?.length ?? 0;
  const tokenEstimate = Math.ceil((identityChars + userChars) / 4);
  return [
    `- agent: \`${params.ctx.agentId}\``,
    `- name: \`${loaded.identity?.name ?? agent.id}\``,
    agent.profileId ? `- profile: \`${agent.profileId}\`` : undefined,
    agent.defaultModel ? `- agent default model: \`${agent.defaultModel}\`` : undefined,
    `- identity exists: \`${loaded.identityExists}\``,
    `- user exists: \`${loaded.userExists}\``,
    loaded.identityPath ? `- identity path: \`${loaded.identityPath}\`` : undefined,
    loaded.userPath ? `- user path: \`${loaded.userPath}\`` : undefined,
    loaded.identity ? `- loaded into prompt context: \`true\`` : `- loaded into prompt context: \`false\``,
    loaded.identity ? `- identity/user token estimate: \`${tokenEstimate}\`` : undefined,
    loaded.error ? `- error: \`${loaded.error}\`` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function buildTuiEventsPanel(params: { ctx: TuiCommandContext; entries: TranscriptEntry[]; limit?: number }): string {
  const limit = Math.max(1, Math.floor(params.limit ?? 12));
  const events = params.entries.filter((entry) => entry.role === "event");
  const selected = events.slice(-limit).reverse();
  const lines = [
    `- session: \`${params.ctx.sessionKey}\``,
    `- event entries: \`${events.length}\``,
    `- showing: \`${selected.length}/${limit}\``,
    "",
  ];
  if (selected.length === 0) {
    lines.push("No transcript event entries found for this session.");
  } else {
    lines.push(...selected.map((entry) => {
      const eventName = typeof entry.metadata?.event === "string" ? entry.metadata.event : "event";
      const streamType = typeof entry.metadata?.streamType === "string" ? entry.metadata.streamType : undefined;
      const runnerId = typeof entry.metadata?.runnerId === "string" ? entry.metadata.runnerId : undefined;
      const substrate = typeof entry.metadata?.substrate === "string" ? entry.metadata.substrate : undefined;
      const payloadDetail = substrateEventDetail(entry.metadata?.payload ?? entry.content);
      const label = eventEntryLabel(entry);
      const parts = [
        entry.timestamp,
        `\`${streamType ? `${eventName}/${streamType}` : eventName}\``,
        runnerId ? `runner \`${runnerId}\`` : undefined,
        substrate ? `substrate \`${substrate}\`` : undefined,
        entry.runId ? `run \`${entry.runId}\`` : undefined,
        label,
        payloadDetail,
      ].filter(Boolean);
      return `- ${parts.join(" — ")}`;
    }));
  }
  return lines.join("\n");
}

export function buildTuiRunsPanel(params: { ctx: TuiCommandContext; entries: TranscriptEntry[]; limit?: number }): string {
  const limit = Math.max(1, Math.floor(params.limit ?? 10));
  const byRun = new Map<string, {
    runId: string;
    firstTimestamp: string;
    lastTimestamp: string;
    entries: number;
    roles: Record<string, number>;
    eventNames: Set<string>;
    runnerIds: Set<string>;
    models: Set<string>;
  }>();
  for (const entry of params.entries) {
    if (!entry.runId) continue;
    const summary = byRun.get(entry.runId) ?? {
      runId: entry.runId,
      firstTimestamp: entry.timestamp,
      lastTimestamp: entry.timestamp,
      entries: 0,
      roles: {},
      eventNames: new Set<string>(),
      runnerIds: new Set<string>(),
      models: new Set<string>(),
    };
    summary.entries += 1;
    summary.roles[entry.role] = (summary.roles[entry.role] ?? 0) + 1;
    if (entry.timestamp < summary.firstTimestamp) summary.firstTimestamp = entry.timestamp;
    if (entry.timestamp > summary.lastTimestamp) summary.lastTimestamp = entry.timestamp;
    const eventName = typeof entry.metadata?.event === "string" ? entry.metadata.event : undefined;
    if (eventName) summary.eventNames.add(eventName);
    const runnerId = typeof entry.metadata?.runnerId === "string"
      ? entry.metadata.runnerId
      : entry.metadata?.runner && typeof entry.metadata.runner === "object" && typeof (entry.metadata.runner as Record<string, unknown>).id === "string"
        ? (entry.metadata.runner as Record<string, string>).id
        : undefined;
    if (runnerId) summary.runnerIds.add(runnerId);
    const model = typeof entry.metadata?.model === "string" ? entry.metadata.model : undefined;
    if (model) summary.models.add(model);
    byRun.set(entry.runId, summary);
  }
  const runs = Array.from(byRun.values())
    .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp))
    .slice(0, limit);
  const lines = [
    `- session: \`${params.ctx.sessionKey}\``,
    `- runs found: \`${byRun.size}\``,
    `- showing: \`${runs.length}/${limit}\``,
    "",
  ];
  if (runs.length === 0) {
    lines.push("No run-linked transcript entries found for this session.");
  } else {
    lines.push(...runs.map((run) => {
      const roleCounts = Object.entries(run.roles).map(([role, count]) => `${role}:${count}`).join(" ");
      const eventPreview = Array.from(run.eventNames).slice(0, 4).join(", ");
      const parts = [
        `\`${run.runId}\``,
        `updated ${run.lastTimestamp}`,
        `entries \`${run.entries}\``,
        `roles \`${roleCounts}\``,
        run.runnerIds.size ? `runner \`${Array.from(run.runnerIds).join(", ")}\`` : undefined,
        run.models.size ? `model \`${Array.from(run.models).join(", ")}\`` : undefined,
        eventPreview ? `events ${eventPreview}` : undefined,
      ].filter(Boolean);
      return `- ${parts.join(" — ")}`;
    }));
  }
  return lines.join("\n");
}

type TuiPanelItem = {
  id: string;
  detail?: string;
  current?: boolean;
};

function buildTuiListPanel(params: { emptyText: string; items: TuiPanelItem[]; next?: string }): string {
  const lines = params.items.length === 0
    ? [`- ${params.emptyText}`]
    : params.items.map((item) => {
      const current = item.current ? " **current**" : "";
      const detail = item.detail ? ` — ${item.detail}` : "";
      return `- \`${item.id}\`${current}${detail}`;
    });
  if (params.next) lines.push("", params.next);
  return lines.join("\n");
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function configuredAgentIds(config: ReturnType<typeof loadMindStoneConfig>["config"], ctx: TuiCommandContext): string[] {
  return uniqueValues([
    ctx.agentId,
    config?.routing?.defaultAgentId,
    ...Object.keys(config?.agents ?? {}),
  ]).sort((a, b) => a.localeCompare(b));
}

export function buildTuiAgentsPanel(config: ReturnType<typeof loadMindStoneConfig>["config"], ctx: TuiCommandContext): string {
  const ids = configuredAgentIds(config, ctx);
  return buildTuiListPanel({
    emptyText: "No configured agents found.",
    items: ids.map((id) => {
      const agent = config?.agents?.[id];
      const detailParts = [
        id === config?.routing?.defaultAgentId ? "default" : undefined,
        agent?.profileId ? `profile ${agent.profileId}` : undefined,
        agent?.defaultModel ? `model ${agent.defaultModel}` : undefined,
      ].filter(Boolean);
      return {
        id,
        current: id === ctx.agentId,
        detail: detailParts.join("; ") || undefined,
      };
    }),
    next: "Use `/agent <id>` to switch this TUI session. Config mutation is not enabled here.",
  });
}

export function buildTuiModelsPanel(config: ReturnType<typeof loadMindStoneConfig>["config"], ctx: TuiCommandContext): string {
  const agent = config?.agents?.[ctx.agentId];
  const ids = uniqueValues([
    ctx.model.id,
    agent?.defaultModel,
    config?.routing?.defaultModel,
    ctx.routingMode === "mock" ? "mindstone/mock" : undefined,
  ]).sort((a, b) => a.localeCompare(b));
  return buildTuiListPanel({
    emptyText: "No configured models found.",
    items: ids.map((id) => ({
      id,
      current: id === ctx.model.id,
      detail: [
        id === config?.routing?.defaultModel ? "routing default" : undefined,
        id === agent?.defaultModel ? "agent default" : undefined,
      ].filter(Boolean).join("; ") || undefined,
    })),
    next: "Use `/model <id>` to switch this TUI session. Config mutation is not enabled here.",
  });
}

export function buildTuiSessionsPanel(params: {
  ctx: TuiCommandContext;
  config: ReturnType<typeof loadMindStoneConfig>["config"];
  sessions: Array<{ sessionKey: string; entries: number; updatedAt?: string }>;
}): string {
  const defaultSession = params.config?.session?.defaultSessionKey;
  const mode = params.config?.session?.mode ?? "single";
  const configured = uniqueValues([params.ctx.sessionKey, defaultSession]);
  const byKey = new Map<string, TuiPanelItem>();
  for (const key of configured) {
    byKey.set(key, {
      id: key,
      current: key === params.ctx.sessionKey,
      detail: key === defaultSession ? `configured default; mode ${mode}` : `mode ${mode}`,
    });
  }
  for (const session of params.sessions) {
    const existing = byKey.get(session.sessionKey);
    const detail = `${session.entries} entr${session.entries === 1 ? "y" : "ies"}${session.updatedAt ? `; updated ${session.updatedAt}` : ""}`;
    byKey.set(session.sessionKey, {
      id: session.sessionKey,
      current: session.sessionKey === params.ctx.sessionKey || Boolean(existing?.current),
      detail: existing?.detail ? `${existing.detail}; ${detail}` : detail,
    });
  }
  return buildTuiListPanel({
    emptyText: "No sessions found.",
    items: Array.from(byKey.values()).sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)) || a.id.localeCompare(b.id)),
    next: "Use `/session <key>` to switch this TUI session. Config mutation is not enabled here.",
  });
}
