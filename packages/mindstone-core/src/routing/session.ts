export * from "./run.js";

import type { MindStoneConfig } from "../config/index.js";

export const DEFAULT_MAIN_SESSION_KEY = "main";
export const LEGACY_MINDSTONE_SESSION_ALIAS = "mindstone";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

export function normalizeSessionAgentId(agentId: string | undefined | null): string {
  const trimmed = (agentId ?? "").trim();
  if (!trimmed) return "default";
  if (VALID_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || "default"
  );
}

export function buildAgentMainSessionKey(agentId: string | undefined | null, mainKey = DEFAULT_MAIN_SESSION_KEY): string {
  const normalizedMainKey = mainKey.trim().toLowerCase() || DEFAULT_MAIN_SESSION_KEY;
  return `agent:${normalizeSessionAgentId(agentId)}:${encodeURIComponent(normalizedMainKey)}`;
}

export function canonicalizeSessionKey(sessionKey: string | undefined | null, agentId: string | undefined | null): string | undefined {
  const raw = (sessionKey ?? "").trim();
  if (!raw) return undefined;
  const lowered = raw.toLowerCase();
  if (lowered === LEGACY_MINDSTONE_SESSION_ALIAS || lowered === DEFAULT_MAIN_SESSION_KEY) {
    return buildAgentMainSessionKey(agentId);
  }
  return raw;
}

export type SessionRouteInput = {
  agentId: string;
  substrate?: string;
  channel?: string;
  chatType?: string;
  senderId?: string;
  threadId?: string;
  explicitSessionKey?: string;
};

export function resolveSessionKey(input: SessionRouteInput): string {
  const explicit = canonicalizeSessionKey(input.explicitSessionKey, input.agentId);
  if (explicit) return explicit;
  const surface = input.channel ?? input.substrate ?? "internal";
  const chatType = input.chatType ?? "direct";
  const peer = input.threadId ?? input.senderId ?? DEFAULT_MAIN_SESSION_KEY;
  return ["agent", normalizeSessionAgentId(input.agentId), surface, chatType, peer]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export function resolveDefaultSessionKey(config: MindStoneConfig | undefined, agentId = config?.routing?.defaultAgentId ?? "default"): string {
  return canonicalizeSessionKey(config?.session?.defaultSessionKey, agentId) ?? buildAgentMainSessionKey(agentId);
}

export function resolveConfiguredSessionKey(
  config: MindStoneConfig | undefined,
  input: SessionRouteInput,
): string {
  const explicit = canonicalizeSessionKey(input.explicitSessionKey, input.agentId);
  if (explicit) return explicit;
  if ((config?.session?.mode ?? "single") === "single") return resolveDefaultSessionKey(config, input.agentId);
  return resolveSessionKey(input);
}
