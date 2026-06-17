import type { MindStoneChatResult } from "./types.js";

export type PiSessionEventDiagnostic = {
  type: string;
  messageRole?: string;
  assistantTextChars?: number;
  toolName?: string;
  toolCallId?: string;
  willRetry?: boolean;
};

export type ProviderDiagnostics = {
  piSession?: {
    sessionId?: string;
    sessionFile?: string;
    modelFallbackMessage?: string;
    prompt?: {
      appendSystemPromptCount?: number;
      promptTextChars?: number;
      latestUserMessageFound?: boolean;
      nonUserPromptMessagesSkipped?: number;
    };
    eventCounts?: Record<string, number>;
    events?: PiSessionEventDiagnostic[];
    assistantTextCount?: number;
    lastAssistantTextChars?: number;
  };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeEventCounts(value: unknown): Record<string, number> | undefined {
  const input = record(value);
  if (!input) return undefined;
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(input)) {
    if (!key.trim()) continue;
    const numeric = numberValue(count);
    if (numeric !== undefined) output[key] = numeric;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizePiSessionEvents(value: unknown): PiSessionEventDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: PiSessionEventDiagnostic[] = [];
  for (const item of value.slice(-200)) {
    const event = record(item);
    const type = stringValue(event?.type);
    if (!type) continue;
    events.push({
      type,
      messageRole: stringValue(event?.messageRole),
      assistantTextChars: numberValue(event?.assistantTextChars),
      toolName: stringValue(event?.toolName),
      toolCallId: stringValue(event?.toolCallId),
      willRetry: booleanValue(event?.willRetry),
    });
  }
  return events.length > 0 ? events : undefined;
}

function sanitizePromptDiagnostics(value: unknown): NonNullable<ProviderDiagnostics["piSession"]>["prompt"] {
  const input = record(value);
  if (!input) return undefined;
  const output = {
    appendSystemPromptCount: numberValue(input.appendSystemPromptCount),
    promptTextChars: numberValue(input.promptTextChars),
    latestUserMessageFound: booleanValue(input.latestUserMessageFound),
    nonUserPromptMessagesSkipped: numberValue(input.nonUserPromptMessagesSkipped),
  };
  return Object.values(output).some((item) => item !== undefined) ? output : undefined;
}

export function providerDiagnosticsFromChatResult(result: MindStoneChatResult): ProviderDiagnostics | undefined {
  const raw = record(result.raw);
  const piSession = record(raw?.piSession);
  if (!raw || !piSession) return undefined;

  const assistantTexts = Array.isArray(piSession.assistantTexts) ? piSession.assistantTexts.filter((item) => typeof item === "string") : [];
  const lastAssistantText = assistantTexts.at(-1);
  const diagnostics: ProviderDiagnostics = {
    piSession: {
      sessionId: stringValue(raw.sessionId),
      sessionFile: stringValue(raw.sessionFile),
      modelFallbackMessage: stringValue(raw.modelFallbackMessage),
      prompt: sanitizePromptDiagnostics(piSession.prompt),
      eventCounts: sanitizeEventCounts(piSession.eventCounts),
      events: sanitizePiSessionEvents(piSession.events),
      assistantTextCount: assistantTexts.length > 0 ? assistantTexts.length : undefined,
      lastAssistantTextChars: lastAssistantText ? lastAssistantText.length : undefined,
    },
  };

  return Object.values(diagnostics.piSession ?? {}).some((item) => item !== undefined) ? diagnostics : undefined;
}
