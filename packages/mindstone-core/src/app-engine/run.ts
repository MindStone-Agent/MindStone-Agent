import type { MindStoneConfig } from "../config/types.js";
import type { MindStoneModelInfo, MindStoneModelProvider } from "../provider/index.js";
import type { AgentRunner } from "../runner/index.js";
import type { TranscriptSource } from "../transcript/index.js";
import { runMindStoneChatTurn } from "../chat/run.js";
import {
  recallScopeForMemoryScope,
  scopeFromRequest,
  scopedSessionKey,
  type MindStoneMemoryScope,
  type MindStoneRunRequest,
  type MindStoneRunResult,
} from "./types.js";

/**
 * App Engine Mode entry point (issue #14): invoke MindStone as an embedded
 * backend runtime — no Gateway daemon, no TUI, no channel listeners.
 *
 * This is a thin, deterministic adapter over the canonical chat-turn path, so
 * App Engine runs get the same transcript authority, identity/persona
 * precedence, workflow gating, and scope-enforced recall as every other
 * surface. The caller supplies the provider/model/runner (core stays
 * provider-agnostic); the Gateway package offers a batteries-included wrapper
 * that resolves them from config.
 */
export type MindStoneRunOptions = {
  config?: MindStoneConfig;
  configPath?: string;
  provider: MindStoneModelProvider;
  model: MindStoneModelInfo;
  runner?: AgentRunner;
  source?: TranscriptSource;
  signal?: AbortSignal;
};

export async function runMindStone(request: MindStoneRunRequest, options: MindStoneRunOptions): Promise<MindStoneRunResult> {
  if (!request.agentId?.trim()) throw new Error("agentId is required");
  if (!request.input?.trim()) throw new Error("input is required");

  const scope = scopeFromRequest(request);
  const sessionKey = request.sessionKey?.trim() || scopedSessionKey(scope);
  const memoryScope: MindStoneMemoryScope = request.memoryScope ?? "agent";
  const recallScope = recallScopeForMemoryScope(scope, memoryScope);

  const config = memoryScope === "none" && options.config?.memory?.autoRecall
    ? { ...options.config, memory: { ...options.config.memory, autoRecall: false } }
    : options.config;

  const turn = await runMindStoneChatTurn({
    agentId: request.agentId,
    sessionKey,
    message: request.input,
    config,
    configPath: options.configPath,
    provider: options.provider,
    model: options.model,
    runner: options.runner,
    source: options.source ?? { substrate: "mindstone-app-engine", channel: "api", chatType: "internal" },
    metadata: { ...(request.metadata ?? {}), appEngine: true, memoryScope },
    scope: scope as Record<string, string>,
    recallScope: recallScope as Record<string, string> | undefined,
    route: request.personaId || request.workflowId ? { personaId: request.personaId, workflowId: request.workflowId } : undefined,
    signal: options.signal,
  });

  return {
    runId: turn.runId,
    sessionKey,
    scope,
    memoryScope,
    response: {
      text: turn.assistantEntry.text ?? "",
      model: turn.model,
      provider: turn.provider,
    },
    personaContext: turn.personaContext ? { personaId: turn.personaContext.personaId, reason: turn.personaContext.reason } : undefined,
    workflow: turn.workflow,
    memoryRecall: turn.memoryRecall,
    diagnostics: {
      promptWindow: turn.promptWindow,
      runner: turn.runner,
    },
  };
}
