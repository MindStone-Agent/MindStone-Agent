import { randomUUID } from "node:crypto";
import { buildPromptWindow } from "../context/index.js";
import type { MindStoneConfig } from "../config/index.js";
import { loadMindStoneIdentity } from "../identity/index.js";
import {
  createLocalMemoryRecallProvider,
  createSqliteMemoryRecallProvider,
  discoverFileMemoryDocuments,
} from "../memory/index.js";
import { providerDiagnosticsFromChatResult, type MindStoneModelInfo, type MindStoneModelProvider } from "../provider/index.js";
import { readCurrentHandoff } from "../lifecycle/index.js";
import { runMindStoneRoute } from "../routing/run.js";
import { createProviderRouteAgentRunner, type AgentRunner } from "../runner/index.js";
import {
  appendTranscriptEntry,
  readTranscriptEntries,
  type TranscriptEntry,
  type TranscriptSource,
} from "../transcript/index.js";

export type MindStoneChatTurnInput = {
  agentId: string;
  sessionKey: string;
  message: string;
  config?: MindStoneConfig;
  configPath?: string;
  provider: MindStoneModelProvider;
  model: MindStoneModelInfo;
  runner?: AgentRunner;
  source?: TranscriptSource;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type MindStoneChatTurnResult = {
  ok: true;
  runId: string;
  sessionKey: string;
  agentId: string;
  provider: string;
  model: string;
  userEntry: TranscriptEntry;
  assistantEntry: TranscriptEntry;
  events: TranscriptEntry[];
  identityContext?: Awaited<ReturnType<typeof runMindStoneRoute>>["identityContext"];
  promptWindow: {
    mode: string;
    pruned: boolean;
    tokensBefore: number;
    tokensAfter: number;
    promptEntries: number;
    prunedEntries: number;
    autoCompact?: Awaited<ReturnType<typeof runMindStoneRoute>>["promptWindow"]["autoCompactEvent"];
  };
  handoffReplay?: {
    path: string;
    sha256: string;
    updatedAt?: string;
    tokenEstimate: number;
  };
  memoryRecall?: {
    query: string;
    hitCount: number;
    promptTokens: number;
  };
};

function numberFromMetadata(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveMindStoneChatModel(input: {
  config?: MindStoneConfig;
  agentId: string;
  routingMode: "placeholder" | "mock" | "pi" | "pi-session";
  metadata?: Record<string, unknown>;
}): MindStoneModelInfo {
  const metadataModel = typeof input.metadata?.model === "string" ? input.metadata.model : undefined;
  const agent = input.config?.agents?.[input.agentId];
  return {
    id: metadataModel ?? input.config?.routing?.defaultModel ?? agent?.defaultModel ?? `mindstone/${input.agentId}`,
    provider: input.routingMode,
    contextWindowTokens: numberFromMetadata(input.metadata, "contextWindowTokens") ?? agent?.contextWindowTokens ?? 128_000,
  };
}

function reservedPromptTokens(metadata?: Record<string, unknown>): number {
  return numberFromMetadata(metadata, "reservedTokens") ?? 0;
}

function hasReplayedHandoff(entries: TranscriptEntry[], sha256: string): boolean {
  return entries.some((entry) => {
    if (entry.metadata?.event !== "handoff_replayed") return false;
    const handoff = entry.metadata.handoff;
    return typeof handoff === "object" && handoff !== null && (handoff as Record<string, unknown>).sha256 === sha256;
  });
}

function loadRouteIdentityContext(input: { agentId: string; config?: MindStoneConfig; configPath?: string }) {
  const agentConfig = input.config?.agents?.[input.agentId];
  if (!agentConfig || !input.configPath) return undefined;
  const loaded = loadMindStoneIdentity(input.agentId, agentConfig, input.configPath);
  if (!loaded.identity) return undefined;
  return {
    name: loaded.identity.name,
    identityMarkdown: loaded.identity.identityMarkdown,
    userMarkdown: loaded.identity.userMarkdown,
    identityPath: loaded.identityPath,
    userPath: loaded.userPath,
  };
}

function appendPromptWindowEvents(input: {
  sessionKey: string;
  agentId: string;
  runId: string;
  source?: TranscriptSource;
  route: Awaited<ReturnType<typeof runMindStoneRoute>>;
}): TranscriptEntry[] {
  const events: TranscriptEntry[] = [];
  if (input.route.promptWindow.pruneEvent) {
    events.push(appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "event",
      text: `Context window pruned from ${input.route.promptWindow.tokensBefore} to ${input.route.promptWindow.tokensAfter} estimated tokens. Transcript preserved.`,
      runId: input.runId,
      source: input.source,
      metadata: input.route.promptWindow.pruneEvent,
    }));
  }
  if (input.route.promptWindow.autoCompactEvent) {
    const event = input.route.promptWindow.autoCompactEvent;
    events.push(appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "event",
      text: event.event === "auto_compact_required"
        ? `Auto-compact threshold reached at ${event.utilizationPercent.toFixed(1)}% utilization. Checkpoint/handoff/compact should run.`
        : `Auto-compact warning threshold reached at ${event.utilizationPercent.toFixed(1)}% utilization. Prepare checkpoint/handoff.`,
      runId: input.runId,
      source: input.source,
      metadata: event,
    }));
  }
  return events;
}

export async function runMindStoneChatTurn(input: MindStoneChatTurnInput): Promise<MindStoneChatTurnResult> {
  const message = input.message.trim();
  if (!message) throw new Error("chat message is required");

  const runId = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const userEntry = appendTranscriptEntry({
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    role: "user",
    text: message,
    source: input.source,
    runId,
    metadata: {
      event: "user_message",
      source: input.source?.substrate ?? "mindstone-chat",
      ...input.metadata,
    },
  });

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

  const runner = input.runner ?? createProviderRouteAgentRunner();
  const route = await runner.run({
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    entries,
    model: input.model,
    provider: input.provider,
    identityContext: loadRouteIdentityContext({ agentId: input.agentId, config: input.config, configPath: input.configPath }),
    contextManagement: input.config?.contextManagement,
    reservedTokens: reservedPromptTokens(input.metadata),
    handoffReplay,
    memoryRecall: {
      enabled: input.config?.memory?.autoRecall === true,
      provider: input.config?.memory?.vectorStore === "sqlite-vec"
        ? createSqliteMemoryRecallProvider({ config: input.config }) ?? createLocalMemoryRecallProvider([
            ...(input.config?.memory?.localDocuments ?? []),
            ...discoverFileMemoryDocuments({ config: input.config }),
          ])
        : createLocalMemoryRecallProvider([
            ...(input.config?.memory?.localDocuments ?? []),
            ...discoverFileMemoryDocuments({ config: input.config }),
          ]),
      config: input.config?.memory?.recall,
    },
    signal: input.signal,
    metadata: input.metadata,
  });

  const events: TranscriptEntry[] = [];
  if (route.handoffReplay) {
    events.push(appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "event",
      text: `Replayed current handoff into prompt context from ${route.handoffReplay.path}.`,
      runId,
      source: input.source,
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
    }));
  }

  events.push(...appendPromptWindowEvents({
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    runId,
    source: input.source,
    route,
  }));

  if (route.memoryRecall?.hits.length) {
    events.push(appendTranscriptEntry({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      role: "event",
      text: `Injected ${route.memoryRecall.hits.length} recalled memory chunk(s) into prompt context.`,
      runId,
      source: input.source,
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
    }));
  }

  const assistantEntry = appendTranscriptEntry({
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    role: "assistant",
    text: route.result.text,
    content: route.result.content,
    source: input.source,
    runId,
    metadata: {
      event: "assistant_response",
      provider: input.provider.id,
      model: input.model.id,
      usage: route.result.usage,
      providerDiagnostics: providerDiagnosticsFromChatResult(route.result),
    },
  });

  return {
    ok: true,
    runId,
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    provider: input.provider.id,
    model: input.model.id,
    userEntry,
    assistantEntry,
    events,
    identityContext: route.identityContext,
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
  };
}

export function planMindStonePromptWindow(input: {
  entries: TranscriptEntry[];
  model: MindStoneModelInfo;
  config?: MindStoneConfig;
  reservedTokens?: number;
}) {
  return buildPromptWindow({
    entries: input.entries,
    contextWindowTokens: input.model.contextWindowTokens ?? 128_000,
    policy: input.config?.contextManagement,
    reservedTokens: input.reservedTokens,
  });
}
