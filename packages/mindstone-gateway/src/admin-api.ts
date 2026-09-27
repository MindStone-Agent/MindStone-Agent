/**
 * Gateway admin API for the MindStone Console (#38, P2).
 *
 * Server to server only. The Console server holds a separate admin credential
 * (gateway.admin.tokenEnv or tokenFile) and sends it as
 * `x-mindstone-admin-token`, on top of the normal gateway credential. The
 * ordinary service token, which webchat and API callers hold, is not enough.
 * With no admin credential configured, or gateway auth "none", the admin API
 * does not exist (404).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  getMindStoneSystemStatus,
  resolveGatewayAuthRequirement,
  type MindStoneConfig,
} from "@mindstone-agent/core";

export type AdminGateDecision = { allowed: true } | { allowed: false; status: number; error: string };

function headerValue(headers: IncomingMessage["headers"], name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/** The admin credential from gateway.admin.tokenEnv, else tokenFile (relative to the config file). */
export function resolveAdminToken(config: MindStoneConfig | undefined, configPath: string): string | undefined {
  const admin = (config?.gateway as { admin?: { tokenEnv?: unknown; tokenFile?: unknown } } | undefined)?.admin;
  if (typeof admin?.tokenEnv === "string" && admin.tokenEnv.trim()) {
    const value = process.env[admin.tokenEnv.trim()]?.trim();
    if (value) return value;
  }
  if (typeof admin?.tokenFile === "string" && admin.tokenFile.trim()) {
    const path = isAbsolute(admin.tokenFile) ? admin.tokenFile : resolve(dirname(configPath), admin.tokenFile);
    try {
      if (existsSync(path)) return readFileSync(path, "utf-8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/**
 * Whether an already-authenticated request may use the admin API: gateway
 * auth must be token or password, an admin credential must be configured and
 * presented, and the forwarded role must be "admin".
 */
export function decideAdminAccess(input: {
  config: MindStoneConfig | undefined;
  configPath: string;
  headers: IncomingMessage["headers"];
}): AdminGateDecision {
  const notEnabled: AdminGateDecision = { allowed: false, status: 404, error: "the admin API is not enabled on this gateway" };
  const requirement = resolveGatewayAuthRequirement({ config: input.config?.gateway?.auth, configPath: input.configPath });
  if (!requirement.enabled || requirement.mode === "misconfigured") return notEnabled;
  const adminToken = resolveAdminToken(input.config, input.configPath);
  if (!adminToken) return notEnabled;
  const presented = headerValue(input.headers, "x-mindstone-admin-token");
  if (!presented || !sameSecret(presented, adminToken)) {
    return { allowed: false, status: 401, error: "the admin API needs the admin credential" };
  }
  if (headerValue(input.headers, "x-mindstone-user-role")?.toLowerCase() !== "admin") {
    return { allowed: false, status: 403, error: "the admin API needs the admin role" };
  }
  return { allowed: true };
}

/**
 * Keys whose values are secrets, matched on the key's ending with case and
 * separators ignored, so camelCase, snake_case and plural names count
 * (botToken, client_secret, secretKey, apiKeys, AWS_SECRET_ACCESS_KEY). A key
 * naming where a secret lives (tokenEnv, tokenFile, keyPath, secretName) is
 * not a secret. Budget fields such as contextWindowTokens and maxPromptTokens
 * are not secrets, so the plain plural "tokens" is left out.
 */
const SECRET_SUFFIXES = [
  "key", "keys", "token", "apitokens", "accesstokens", "authtokens", "refreshtokens", "password", "passwords", "passwd", "secret", "secrets", "credential", "credentials",
  "pass", "passphrase", "auth", "authorization", "bearer", "cookie", "cookies", "dsn", "connectionstring", "signature", "pat",
];
const REFERENCE_SUFFIXES = ["env", "envs", "file", "files", "path", "paths", "ref", "refs", "name", "names", "id", "ids", "url", "mode"];
/**
 * Secret keys whose object values are opened rather than masked whole: an
 * `auth` block (gateway.auth) mostly holds references and a mode, and its
 * secrets are caught by their own keys.
 */
const OPEN_WHEN_OBJECT = new Set(["auth"]);
/** Maps whose every value is a secret: header and environment maps. */
const SECRET_MAPS = new Set(["headers", "env", "environment", "extraheaders", "defaultheaders"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretKey(key: string): boolean {
  const lower = normalizeKey(key);
  if (!lower) return false;
  if (REFERENCE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  return SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function masksWhole(key: string, value: unknown): boolean {
  if (!key || !isSecretKey(key)) return false;
  return !(OPEN_WHEN_OBJECT.has(normalizeKey(key)) && value !== null && typeof value === "object" && !Array.isArray(value));
}

function isSecretMap(key: string): boolean {
  return SECRET_MAPS.has(normalizeKey(key));
}

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@?#]+@/gi;
const URL_SECRET_PARAM = /([?&;][^=&#\s]*(?:key|token|secret|password|passwd|signature|sig|auth|credential)[^=&#\s]*=)[^&#\s]+/gi;

/** A string with credentials inside URLs masked: userinfo and secret-looking query parameters. */
export function maskUrlCredentials(value: string): string {
  return value.replace(URL_USERINFO, "$1***@").replace(URL_SECRET_PARAM, "$1***");
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * A copy of the config safe to show in a browser. The value under a secret
 * key, whatever its type, becomes `{ "set": true|false }`; so does every value
 * in a header or environment map; credentials inside URL strings are masked.
 * Secret references (tokenEnv, tokenFile, …) are kept.
 */
export function maskConfig(value: unknown, key = "", parentIsSecretMap = false): unknown {
  if (masksWhole(key, value) || (parentIsSecretMap && key)) return { set: isSet(value) };
  if (typeof value === "string") return maskUrlCredentials(value);
  if (Array.isArray(value)) return value.map((item) => maskConfig(item));
  if (value && typeof value === "object") {
    const secretMap = Boolean(key) && isSecretMap(key);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskConfig(v, k, secretMap)]));
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

const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SECRETS_FILE = /^secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isBool = (value: unknown) => value === undefined || typeof value === "boolean";
const isNumber = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value));
const isShortText = (value: unknown) => value === undefined || (typeof value === "string" && value.length <= 200 && !/[\r\n]/.test(value));
const isNote = (value: unknown) => value === undefined || (typeof value === "string" && value.length <= 4000);
const isId = (value: unknown) => value === undefined || (typeof value === "string" && PLAIN_ID.test(value));
const oneOf = (...allowed: string[]) => (value: unknown) => value === undefined || (typeof value === "string" && allowed.includes(value));
/** A list of plain ids with no "*" wildcard. `absentOk` says whether removing the list is also safe (fail closed when absent). */
const isNarrowList = (absentOk: boolean) => (value: unknown) =>
  value === undefined
    ? absentOk
    : Array.isArray(value) && value.length > 0 && value.length <= 200
      && value.every((item) => typeof item === "string" && item.trim() !== "" && item.trim() !== "*" && item.length <= 320);

/**
 * The settings the browser may change without the advanced-settings
 * permission (default deny, #38 review round 1): each dotted pattern ("*" is
 * one segment) with a check on the new value. Everything else needs the
 * permission, including anything that names an environment variable, a URL,
 * a file or a directory, sends memory to a new provider, or widens who may
 * talk to the agent or who counts as its owner.
 */
const SAFE_SETTINGS: Array<{ pattern: string; value: (value: unknown) => boolean }> = [
  { pattern: "routing.mode", value: oneOf("placeholder", "mock", "pi", "pi-session") },
  { pattern: "routing.defaultModel", value: isShortText },
  { pattern: "routing.defaultAgentId", value: isId },
  { pattern: "routing.mock.responsePrefix", value: isShortText },
  { pattern: "agents.*.id", value: isId },
  { pattern: "agents.*.defaultModel", value: isShortText },
  { pattern: "agents.*.contextWindowTokens", value: isNumber },
  { pattern: "agents.*.profileId", value: isId },
  { pattern: "memory.autoRecall", value: isBool },
  { pattern: "memory.vectorStore", value: oneOf("lancedb", "sqlite-vec", "memory") },
  { pattern: "memory.recall.maxResults", value: isNumber },
  { pattern: "memory.recall.maxPromptTokens", value: isNumber },
  { pattern: "memory.recall.minScore", value: isNumber },
  { pattern: "memory.recall.dedupAgainstActiveContext", value: isBool },
  { pattern: "memory.recall.maxActiveEntriesForDedup", value: isNumber },
  { pattern: "memory.index.enabled", value: isBool },
  { pattern: "memory.index.maxPromptTokens", value: isNumber },
  { pattern: "memory.invariants.enabled", value: isBool },
  { pattern: "memory.invariants.maxPromptTokens", value: isNumber },
  { pattern: "channels.*.enabled", value: isBool },
  // Missing allowedSenders lets nobody in; missing allowedChats or allowedGuilds lets every chat in.
  { pattern: "channels.*.allowedSenders", value: isNarrowList(true) },
  { pattern: "channels.*.allowedChats", value: isNarrowList(false) },
  { pattern: "channels.*.allowedGuilds", value: isNarrowList(false) },
  { pattern: "channels.*.triggerPrefix", value: isShortText },
  { pattern: "channels.*.respondWithoutMention", value: isBool },
  { pattern: "channels.*.pollMs", value: isNumber },
  { pattern: "channels.*.pollIntervalMs", value: isNumber },
  { pattern: "channels.*.reconnectMs", value: isNumber },
  { pattern: "channels.*.maxBodyChars", value: isNumber },
  // A secret stored through POST /admin/secrets, referenced by its path relative to the config.
  { pattern: "channels.*.tokenFile", value: (v) => v === undefined || (typeof v === "string" && SECRETS_FILE.test(v)) },
  { pattern: "session.mode", value: oneOf("single", "per_surface") },
  { pattern: "contextManagement.mode", value: oneOf("auto_compact", "sliding_window") },
  { pattern: "contextManagement.*", value: (v) => typeof v === "number" ? Number.isFinite(v) : isBool(v) },
  { pattern: "gateway.http.chatCompletions.enabled", value: isBool },
  { pattern: "gateway.http.responses.enabled", value: isBool },
  { pattern: "personas.active", value: isId },
  { pattern: "workflows.active", value: isId },
  { pattern: "knowledgebases.recall.enabled", value: isBool },
  { pattern: "onboarding.preferences.*", value: isNote },
  { pattern: "onboarding.identity.*", value: isNote },
];

function matchesPattern(pattern: string, path: string): boolean {
  const p = pattern.split(".");
  const q = path.split(".");
  return p.length === q.length && p.every((part, i) => part === "*" || part === q[i]);
}

function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Whether changing `path` (a dotted path from the config root) to its value
 * in `nextConfig` needs the advanced-settings permission. Default deny: only
 * a SAFE_SETTINGS path whose new value passes its check is free. The first
 * matching pattern decides.
 */
export function isAdvancedChange(path: string, nextConfig: unknown): boolean {
  const rule = SAFE_SETTINGS.find((candidate) => matchesPattern(candidate.pattern, path));
  if (!rule) return true;
  return !rule.value(valueAt(nextConfig, path));
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

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_PATCH_DEPTH = 32;

/**
 * JSON merge patch (RFC 7396) of `patch` onto `target`, except that a masked
 * secret sent back unchanged (`{ set: … }` where GET /admin/config masked a
 * value) keeps the stored value, so the Console can round-trip what it read
 * without wiping keys. Prototype keys and patches nested deeper than
 * MAX_PATCH_DEPTH throw.
 */
export function mergeConfigPatch(target: unknown, patch: unknown, key = "", parentIsSecretMap = false, depth = 0): unknown {
  if (depth > MAX_PATCH_DEPTH) throw new AdminPatchError("the patch is nested too deeply");
  const secretSlot = masksWhole(key, target) || (parentIsSecretMap && key);
  if (secretSlot && isMaskedSecret(patch)) return target;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  const secretMap = Boolean(key) && isSecretMap(key);
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) throw new AdminPatchError(`the key "${k}" is not allowed`);
    if (v === null) delete base[k];
    else base[k] = mergeConfigPatch(base[k], v, k, secretMap, depth + 1);
  }
  return base;
}

/** A patch the admin API refuses as a bad request (400). */
export class AdminPatchError extends Error {}

/** Nesting depth of a parsed JSON value (a scalar is 0), counted no further than `limit` + 1. */
export function jsonDepth(value: unknown, limit = MAX_PATCH_DEPTH): number {
  if (!value || typeof value !== "object") return 0;
  if (limit <= 0) return 1;
  let max = 0;
  for (const child of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, 1 + jsonDepth(child, limit - 1));
    if (max > limit) return max;
  }
  return max;
}

/** ETag of the config file's bytes, for optimistic concurrency on PATCH (If-Match). */
export function configEtag(content: string): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 32)}"`;
}

export type AdminPermissions = { advancedSettings: boolean; grantedBy?: string; grantedAt?: string };

/** Where the admin permission lives: runtime state, not config, so a config patch can't grant it. */
export function adminPermissionsPath(dataDir: string): string {
  return `${dataDir}/admin/permissions.json`;
}
