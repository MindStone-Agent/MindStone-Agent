export * from "./run.js";

import type { MindStoneConfig } from "../config/index.js";

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
  if (input.explicitSessionKey?.trim()) return input.explicitSessionKey.trim();
  const surface = input.channel ?? input.substrate ?? "internal";
  const chatType = input.chatType ?? "direct";
  const peer = input.threadId ?? input.senderId ?? "main";
  return ["agent", input.agentId, surface, chatType, peer]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export function resolveDefaultSessionKey(config: MindStoneConfig | undefined): string {
  return config?.session?.defaultSessionKey?.trim() || "mindstone";
}

export function resolveConfiguredSessionKey(
  config: MindStoneConfig | undefined,
  input: SessionRouteInput,
): string {
  if (input.explicitSessionKey?.trim()) return input.explicitSessionKey.trim();
  if ((config?.session?.mode ?? "single") === "single") return resolveDefaultSessionKey(config);
  return resolveSessionKey(input);
}
