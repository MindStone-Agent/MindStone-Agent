/**
 * Durable Pi-session metadata policy.
 *
 * Pi AgentSession events can contain raw messages, tool arguments, tool results,
 * provider payloads, and other high-sensitivity structures. MindStone-Agent may
 * persist selected Pi facts into transcript metadata only after they are reduced
 * to this explicit summary allowlist. Anything outside the allowlist is treated
 * as UI/diagnostic-only and, if encountered at the durable boundary, is reduced
 * to key names rather than values.
 */
export const PI_SESSION_DURABLE_EVENT_FIELDS = [
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
] as const;

export type PiSessionDurableEventField = typeof PI_SESSION_DURABLE_EVENT_FIELDS[number];

export const PI_SESSION_DURABLE_RESUME_CAP_FIELDS = [
  "action",
  "branchLengthBefore",
  "dropped",
  "kept",
  "messageEmittersKept",
  "compactionExpanded",
  "toolPairExpanded",
  "errorTurnsDropped",
] as const;

export type PiSessionDurableResumeCapField = typeof PI_SESSION_DURABLE_RESUME_CAP_FIELDS[number];

/** Raw Pi event fields that must not be persisted as values. */
export const PI_SESSION_RAW_EVENT_FIELDS_EXCLUDED_FROM_DURABLE_METADATA = [
  "message",
  "messages",
  "args",
  "result",
  "partialResult",
  "assistantMessageEvent",
  "steering",
  "followUp",
] as const;

const DURABLE_EVENT_FIELD_SET = new Set<string>(PI_SESSION_DURABLE_EVENT_FIELDS);
const DURABLE_RESUME_CAP_FIELD_SET = new Set<string>(PI_SESSION_DURABLE_RESUME_CAP_FIELDS);

export function isPiSessionDurableEventField(key: string): key is PiSessionDurableEventField {
  return DURABLE_EVENT_FIELD_SET.has(key);
}

export function isPiSessionDurableResumeCapField(key: string): key is PiSessionDurableResumeCapField {
  return DURABLE_RESUME_CAP_FIELD_SET.has(key);
}

export function isPrimitiveDurableMetadataValue(value: unknown): value is string | number | boolean | null | undefined {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function sanitizePiSessionDurableMetadataValue(value: unknown): unknown {
  if (isPrimitiveDurableMetadataValue(value)) return value;
  if (Array.isArray(value)) {
    const values = value.filter((item) => isPrimitiveDurableMetadataValue(item));
    return values.length === value.length ? values : { valueType: "array", length: value.length };
  }
  if (value && typeof value === "object") {
    return { valueType: "object", keys: Object.keys(value as Record<string, unknown>).sort().slice(0, 50) };
  }
  return { valueType: typeof value };
}
