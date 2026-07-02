import { buildPromptWindow, estimatePromptTokens, type PromptWindowBuildResult } from "../context/index.js";
import type { ContextManagementPolicy } from "../context/index.js";
import { recallMindStoneMemory, type MemoryRecallConfig, type MemoryRecallProvider, type MemoryRecallResult } from "../memory/index.js";
import type { MindStoneIdentity } from "../identity/index.js";
import type { MindStoneChatMessage, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider } from "../provider/index.js";
import type { MindStoneRoutePersonaContext, MindStoneRoutePersonaContextSummary } from "../persona/types.js";
import type { TranscriptEntry } from "../transcript/index.js";

export type MindStoneHandoffReplay = {
  path: string;
  sha256: string;
  updatedAt?: string;
  text: string;
  tokenEstimate: number;
};

export type MindStoneIdentityFormationPrompt = {
  enabled: boolean;
  promptText: string;
  mode?: string;
};

export type MindStoneRouteIdentityContext = Pick<MindStoneIdentity, "name" | "identityMarkdown" | "userMarkdown"> & {
  identityPath?: string;
  userPath?: string;
};

export type MindStoneRouteIdentityContextSummary = {
  injected: boolean;
  name?: string;
  identityPath?: string;
  userPath?: string;
  tokenEstimate: number;
};

export type MindStoneRouteInput = {
  agentId: string;
  sessionKey: string;
  entries: TranscriptEntry[];
  model: MindStoneModelInfo;
  provider: MindStoneModelProvider;
  identityContext?: MindStoneRouteIdentityContext;
  personaContext?: MindStoneRoutePersonaContext;
  contextManagement?: ContextManagementPolicy;
  reservedTokens?: number;
  protectedEntryIds?: string[];
  handoffReplay?: MindStoneHandoffReplay;
  identityFormation?: MindStoneIdentityFormationPrompt;
  memoryRecall?: {
    enabled?: boolean;
    provider?: MemoryRecallProvider;
    config?: MemoryRecallConfig;
  };
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type MindStoneRoutePlan = {
  agentId: string;
  sessionKey: string;
  model: MindStoneModelInfo;
  promptWindow: PromptWindowBuildResult;
  messages: MindStoneChatMessage[];
  identityContext?: MindStoneRouteIdentityContextSummary;
  personaContext?: MindStoneRoutePersonaContextSummary;
  identityFormation?: MindStoneIdentityFormationPrompt;
  memoryRecall?: MemoryRecallResult;
  handoffReplay?: MindStoneHandoffReplay;
};

export type MindStoneRouteResult = MindStoneRoutePlan & {
  result: MindStoneChatResult;
};

function transcriptEntryToChatMessage(entry: TranscriptEntry): MindStoneChatMessage | undefined {
  if (entry.role !== "system" && entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") return undefined;
  return {
    role: entry.role,
    text: entry.text,
    content: entry.content,
    sourceEntryId: entry.id,
  };
}

function identityContextPrompt(identityContext: MindStoneRouteIdentityContext | undefined): string | undefined {
  if (!identityContext?.identityMarkdown?.trim() && !identityContext?.userMarkdown?.trim()) return undefined;
  const sections = [
    [
      "MindStone standing identity context. Treat this as durable orientation for the agent and user, not as a conversation transcript.",
      "You are operating as the configured MindStone agent for this runtime. Do not identify as the underlying model/provider (for example ChatGPT, Claude, or Gemini) unless the user specifically asks about the substrate/model.",
      "If the identity file is pending or only a placeholder, be explicit that MindStone identity activation is pending; do not invent a completed identity or fall back to provider identity.",
    ].join("\n"),
  ];
  if (identityContext.identityMarkdown?.trim()) {
    sections.push(["## IDENTITY.md", identityContext.identityMarkdown.trim()].join("\n\n"));
  }
  if (identityContext.userMarkdown?.trim()) {
    sections.push(["## USER.md", identityContext.userMarkdown.trim()].join("\n\n"));
  }
  return sections.join("\n\n");
}

function summarizeIdentityContext(
  identityContext: MindStoneRouteIdentityContext | undefined,
  promptText: string | undefined,
): MindStoneRouteIdentityContextSummary | undefined {
  if (!promptText) return undefined;
  return {
    injected: true,
    name: identityContext?.name,
    identityPath: identityContext?.identityPath,
    userPath: identityContext?.userPath,
    tokenEstimate: estimatePromptTokens(promptText),
  };
}

export function buildMindStoneRoutePlan(input: Omit<MindStoneRouteInput, "provider" | "signal" | "memoryRecall"> & { memoryRecall?: MemoryRecallResult }): MindStoneRoutePlan {
  const identityPromptText = identityContextPrompt(input.identityContext);
  const identityContext = summarizeIdentityContext(input.identityContext, identityPromptText);
  const personaPromptText = input.personaContext?.promptText?.trim() ? input.personaContext.promptText.trim() : undefined;
  const personaContext: MindStoneRoutePersonaContextSummary | undefined = personaPromptText && input.personaContext
    ? {
        injected: true,
        personaId: input.personaContext.personaId,
        reason: input.personaContext.reason,
        tokenEstimate: estimatePromptTokens(personaPromptText),
      }
    : undefined;
  const promptWindow = buildPromptWindow({
    entries: input.entries,
    contextWindowTokens: input.model.contextWindowTokens ?? 128_000,
    policy: input.contextManagement,
    reservedTokens: (input.reservedTokens ?? 0) + (identityContext?.tokenEstimate ?? 0) + (personaContext?.tokenEstimate ?? 0) + (input.memoryRecall?.promptTokens ?? 0) + (input.handoffReplay?.tokenEstimate ?? 0) + (input.identityFormation?.enabled ? estimatePromptTokens(input.identityFormation.promptText) : 0),
    protectedEntryIds: input.protectedEntryIds,
  });
  const messages = promptWindow.promptEntries.map(transcriptEntryToChatMessage).filter((message): message is MindStoneChatMessage => Boolean(message));
  if (input.memoryRecall?.promptText) {
    messages.unshift({ role: "system", text: input.memoryRecall.promptText });
  }
  if (input.handoffReplay?.text) {
    messages.unshift({
      role: "system",
      text: [
        "Current MindStone handoff replay (ephemeral; do not promote to durable memory unless explicitly checkpointed):",
        input.handoffReplay.text,
      ].join("\n\n"),
    });
  }
  if (input.identityFormation?.enabled && input.identityFormation.promptText.trim()) {
    messages.unshift({ role: "system", text: input.identityFormation.promptText.trim() });
  }
  if (personaPromptText) {
    messages.unshift({ role: "system", text: personaPromptText });
  }
  if (identityPromptText) {
    messages.unshift({ role: "system", text: identityPromptText });
  }
  return {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    model: input.model,
    promptWindow,
    messages,
    identityContext,
    personaContext,
    identityFormation: input.identityFormation?.enabled ? input.identityFormation : undefined,
    memoryRecall: input.memoryRecall,
    handoffReplay: input.handoffReplay,
  };
}

export async function planMindStoneRoute(input: MindStoneRouteInput): Promise<MindStoneRoutePlan> {
  const memoryRecall = input.memoryRecall?.enabled
    ? await recallMindStoneMemory({
        agentId: input.agentId,
        entries: input.entries,
        provider: input.memoryRecall.provider,
        config: input.memoryRecall.config,
      })
    : undefined;
  return buildMindStoneRoutePlan({ ...input, memoryRecall });
}

export async function completeMindStoneRoutePlan(input: MindStoneRouteInput, plan: MindStoneRoutePlan): Promise<MindStoneRouteResult> {
  const result = await input.provider.completeChat({
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    model: input.model,
    messages: plan.messages,
    transcriptEntries: input.entries,
    signal: input.signal,
    metadata: input.metadata,
  });
  return { ...plan, result };
}

export async function runMindStoneRoute(input: MindStoneRouteInput): Promise<MindStoneRouteResult> {
  const plan = await planMindStoneRoute(input);
  return completeMindStoneRoutePlan(input, plan);
}
