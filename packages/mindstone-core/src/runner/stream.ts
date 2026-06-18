import {
  isPiSessionDurableEventField,
  isPrimitiveDurableMetadataValue,
  sanitizePiSessionDurableMetadataValue,
} from "../provider/pi-session-metadata-policy.js";
import type { AgentRunFailedEvent } from "./types.js";

/**
 * Convert substrate stream event payloads into transcript-safe metadata/content.
 *
 * Real Pi events should already be summarized before they reach AgentRunner.stream,
 * but transcript persistence is the durable boundary. Keep known sanitized summary
 * fields and preserve only unknown key names, never raw arg/result/message values.
 */
export function sanitizeRunnerStreamSubstrateEventPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (isPrimitiveDurableMetadataValue(payload)) return payload;
    return { valueType: Array.isArray(payload) ? "array" : typeof payload, length: Array.isArray(payload) ? payload.length : undefined };
  }

  const input = payload as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  for (const key of Object.keys(input).sort()) {
    if (isPiSessionDurableEventField(key)) {
      const value = sanitizePiSessionDurableMetadataValue(input[key]);
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
