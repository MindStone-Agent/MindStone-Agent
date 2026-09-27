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

export function isSecretKey(key: string): boolean {
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

// ---------------------------------------------------------------------------
// Write side (#38, P2): section patches, secrets, and the advanced permission.
// ---------------------------------------------------------------------------

/** Top-level config sections the Console may patch. */
export const EDITABLE_SECTIONS = [
  "agents",
  "channels",
  "contextManagement",
  "gateway",
  "knowledgebases",
  "memory",
  "observability",
  "onboarding",
  "packs",
  "personas",
  "routing",
  "session",
  "skills",
  "workflows",
  "workspace",
] as const;

/**
 * Settings that amount to running code or reading arbitrary files, which the
 * browser may change only while the admin has granted the advanced-settings
 * permission (Clint, 2026-09-27: allowed from the web, but by explicit
 * permission). Any key ending in path/paths/dir/file/root (the gateway would
 * read what it names), plus the listed sections and fields.
 */
const ADVANCED_KEY = /(path|paths|dir|file|root)$/i;
const ADVANCED_PATHS = [
  "workspace",
  "packs",
  "skills",
  "gateway.auth",
  "gateway.host",
  "gateway.port",
  "routing.pi.builtinTools",
  "routing.pi.noExtensions",
  "routing.pi.noSkills",
  "routing.pi.noContextFiles",
  "routing.pi.noPromptTemplates",
];

export function isAdvancedPath(path: string): boolean {
  const parts = path.split(".");
  if (parts.some((part) => ADVANCED_KEY.test(part))) return true;
  return ADVANCED_PATHS.some((advanced) => path === advanced || path.startsWith(`${advanced}.`));
}

/** Dotted paths whose values differ between two values (leaf level). */
export function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  if (isObject(before) || isObject(after)) {
    const keys = new Set([...Object.keys(isObject(before) ? before : {}), ...Object.keys(isObject(after) ? after : {})]);
    if (keys.size === 0) return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
    return [...keys].flatMap((key) =>
      changedPaths(isObject(before) ? before[key] : undefined, isObject(after) ? after[key] : undefined, prefix ? `${prefix}.${key}` : key),
    );
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

/** A masked secret as GET /admin/config returns it: `{ set: boolean }` and nothing else. */
function isMaskedSecret(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).length === 1 && typeof (value as { set?: unknown }).set === "boolean";
}

/**
 * JSON merge patch (RFC 7396) of `patch` onto `target`, except that a masked
 * secret sent back unchanged (`{ set: … }` under a secret key) keeps the
 * stored value: the Console can round-trip what it read without wiping keys.
 */
export function mergeConfigPatch(target: unknown, patch: unknown, key = ""): unknown {
  if (isSecretKey(key) && isMaskedSecret(patch)) return target;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete base[k];
    else base[k] = mergeConfigPatch(base[k], v, k);
  }
  return base;
}

export type AdminPermissions = { advancedSettings: boolean; grantedBy?: string; grantedAt?: string };

/** Where the admin permission lives: runtime state, not config, so a config patch can't grant it. */
export function adminPermissionsPath(dataDir: string): string {
  return `${dataDir}/admin/permissions.json`;
}
