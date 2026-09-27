/**
 * Gateway admin API for the MindStone Console (#38, P2): read side.
 *
 * Server to server only: the Console calls it with the gateway's service token
 * and forwards the signed-in user's role. It does not exist when gateway auth
 * is "none" (a 404, not a 401), and it needs the admin role on every call.
 */
import type { IncomingMessage } from "node:http";
import {
  getMindStoneSystemStatus,
  resolveGatewayAuthRequirement,
  type MindStoneConfig,
} from "@mindstone-agent/core";

export type AdminGateDecision = { allowed: true } | { allowed: false; status: number; error: string };

/**
 * Whether an already-authenticated request may use the admin API: gateway
 * auth must be token or password (so the caller proved it holds the service
 * credential), and the forwarded role must be "admin".
 */
export function decideAdminAccess(input: {
  config: MindStoneConfig | undefined;
  configPath: string;
  headers: IncomingMessage["headers"];
}): AdminGateDecision {
  const requirement = resolveGatewayAuthRequirement({ config: input.config?.gateway?.auth, configPath: input.configPath });
  if (!requirement.enabled || requirement.mode === "misconfigured") {
    return { allowed: false, status: 404, error: "the admin API needs gateway auth (token or password)" };
  }
  const raw = input.headers["x-mindstone-user-role"];
  const role = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (role !== "admin") return { allowed: false, status: 403, error: "the admin API needs the admin role" };
  return { allowed: true };
}

/**
 * Keys whose values are secrets, matched on the lower-cased key's ending so
 * camelCase names count (botToken, clientSecret, openaiApiKey). References to
 * where a secret lives (tokenEnv, tokenFile, keyPath) are not secrets.
 */
const SECRET_SUFFIXES = ["apikey", "api_key", "token", "password", "secret", "credential", "credentials", "privatekey", "private_key", "passphrase"];
const REFERENCE_SUFFIXES = ["env", "file", "path", "ref"];

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (REFERENCE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  return SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * A copy of the config safe to show in a browser: every secret value becomes
 * `{ "set": true|false }`. Secret references (tokenEnv, tokenFile, …) are kept,
 * since they name where a secret lives, not the secret.
 */
export function maskConfig(value: unknown, key = ""): unknown {
  if (isSecretKey(key) && (typeof value !== "object" || value === null)) {
    return { set: value !== undefined && value !== null && String(value) !== "" };
  }
  if (Array.isArray(value)) return value.map((item) => maskConfig(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskConfig(v, k)]));
  }
  return value;
}

export type OnboardingStep = { done: boolean; detail: string };

/**
 * What the Console's onboarding flow still needs. Onboarded means a model
 * provider is chosen and at least one persona exists; memory and connectors
 * are reported but optional.
 */
export function onboardingSteps(config: MindStoneConfig | undefined): {
  onboarded: boolean;
  steps: Record<"provider" | "persona" | "memory" | "connectors", OnboardingStep>;
} {
  const mode = config?.routing?.mode ?? "placeholder";
  const provider: OnboardingStep = mode === "placeholder"
    ? { done: false, detail: "no model provider chosen (routing.mode is placeholder)" }
    : { done: true, detail: `routing.mode ${mode}${config?.routing?.defaultModel ? `, model ${config.routing.defaultModel}` : ""}` };
  const agentIds = Object.keys(config?.agents ?? {});
  const persona: OnboardingStep = agentIds.length
    ? { done: true, detail: `${agentIds.length} persona${agentIds.length === 1 ? "" : "s"}: ${agentIds.join(", ")}` }
    : { done: false, detail: "no persona configured (agents is empty)" };
  const memory: OnboardingStep = {
    done: Boolean(config?.memory),
    detail: config?.memory ? `vector store ${config.memory.vectorStore ?? "default"}, autoRecall ${config.memory.autoRecall === true ? "on" : "off"}` : "memory not configured",
  };
  const channelIds = Object.entries((config?.channels ?? {}) as Record<string, unknown>)
    .filter(([, section]) => !(section && typeof section === "object" && (section as Record<string, unknown>).enabled === false))
    .map(([id]) => id);
  const connectors: OnboardingStep = {
    done: channelIds.length > 0,
    detail: channelIds.length ? channelIds.join(", ") : "no connectors (optional)",
  };
  return { onboarded: provider.done && persona.done, steps: { provider, persona, memory, connectors } };
}

/** GET /admin/status body. */
export function adminStatus(config: MindStoneConfig | undefined): Record<string, unknown> {
  const system = getMindStoneSystemStatus();
  return { ok: true, ...onboardingSteps(config), system };
}
