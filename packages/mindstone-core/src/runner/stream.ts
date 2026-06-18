import type { AgentRunFailedEvent } from "./types.js";

const SAFE_SUBSTRATE_EVENT_KEYS = new Set([
  "type",
  "messageRole",
  "messageTextChars",
  "assistantTextChars",
  "assistantStreamEventType",
  "assistantStreamDeltaChars",
  "assistantStreamContentChars",
  "assistantStreamContentIndex",
  "stopReason",
  "errorMessage",
  "toolName",
  "toolCallId",
  "toolArgsKeys",
  "toolResultTextChars",
  "toolResultIsError",
  "compactionReason",
  "compactionWillRetry",
  "compactionAborted",
  "retryAttempt",
  "retryMaxAttempts",
  "retryDelayMs",
  "retrySuccess",
  "queueSteeringCount",
  "queueFollowUpCount",
  "sessionName",
  "thinkingLevel",
  "messagesCount",
  "willRetry",
]);

function primitive(value: unknown): value is string | number | boolean | null | undefined {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function sanitizeSafeValue(value: unknown): unknown {
  if (primitive(value)) return value;
  if (Array.isArray(value)) {
    const values = value.filter((item) => primitive(item));
    return values.length === value.length ? values : { valueType: "array", length: value.length };
  }
  if (value && typeof value === "object") {
    return { valueType: "object", keys: Object.keys(value as Record<string, unknown>).sort().slice(0, 50) };
  }
  return { valueType: typeof value };
}

/**
 * Convert substrate stream event payloads into transcript-safe metadata/content.
 *
 * Real Pi events should already be summarized before they reach AgentRunner.stream,
 * but transcript persistence is the durable boundary. Keep known sanitized summary
 * fields and preserve only unknown key names, never raw arg/result/message values.
 */
export function sanitizeRunnerStreamSubstrateEventPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (primitive(payload)) return payload;
    return { valueType: Array.isArray(payload) ? "array" : typeof payload, length: Array.isArray(payload) ? payload.length : undefined };
  }

  const input = payload as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  for (const key of Object.keys(input).sort()) {
    if (SAFE_SUBSTRATE_EVENT_KEYS.has(key)) {
      const value = sanitizeSafeValue(input[key]);
      if (value !== undefined) output[key] = value;
    } else {
      unknownKeys.push(key);
    }
  }
  if (unknownKeys.length > 0) {
    output.sanitized = true;
    output.unknownKeys = unknownKeys.slice(0, 50);
  }
  return output;
}

export function agentRunStreamErrorFromUnknown(error: unknown): AgentRunFailedEvent["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: typeof error === "string" ? error : "Unknown AgentRunner stream error",
  };
}
