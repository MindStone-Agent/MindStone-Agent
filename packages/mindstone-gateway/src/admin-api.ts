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
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  getMindStoneSystemStatus,
  resolveGatewayAuthRequirement,
  type MindStoneConfig,
  BUILT_IN_MINDSTONE_PROFILES,
} from "@mindstone-agent/core";

export type AdminGateDecision = { allowed: true } | { allowed: false; status: number; error: string };

function headerValue(headers: IncomingMessage["headers"], name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/**
 * The admin credential's SHA-256 digest. `gateway.admin.tokenSha256` (the
 * recommended form) holds only the digest, so an agent that can read the
 * gateway's config or environment doesn't learn the credential. Otherwise the
 * plain credential comes from tokenEnv or tokenFile (relative to the config
 * file) and must be at least MIN_ADMIN_TOKEN_LENGTH characters.
 */
export function resolveAdminDigest(config: MindStoneConfig | undefined, configPath: string): Buffer | undefined {
  const admin = (config?.gateway as { admin?: { tokenSha256?: unknown; tokenEnv?: unknown; tokenFile?: unknown } } | undefined)?.admin;
  if (typeof admin?.tokenSha256 === "string") {
    const hex = admin.tokenSha256.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : undefined;
  }
  let plain: string | undefined;
  if (typeof admin?.tokenEnv === "string" && admin.tokenEnv.trim()) {
    plain = process.env[admin.tokenEnv.trim()]?.trim() || undefined;
  }
  if (!plain && typeof admin?.tokenFile === "string" && admin.tokenFile.trim()) {
    const path = isAbsolute(admin.tokenFile) ? admin.tokenFile : resolve(dirname(configPath), admin.tokenFile);
    try {
      if (existsSync(path)) plain = readFileSync(path, "utf-8").trim() || undefined;
    } catch {
      plain = undefined;
    }
  }
  if (!plain || plain.length < MIN_ADMIN_TOKEN_LENGTH) return undefined;
  return sha256(plain);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export const MIN_ADMIN_TOKEN_LENGTH = 16;

/** Whether a presented value matches a digest, in constant time. */
function matchesDigest(value: string, digest: Buffer): boolean {
  return timingSafeEqual(sha256(value), digest);
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
  const adminDigest = resolveAdminDigest(input.config, input.configPath);
  // Missing, too short, or the same as the service credential every webchat
  // and API caller holds: treat the admin API as not configured (#38 review).
  if (!adminDigest) return notEnabled;
  const serviceSecret = requirement.mode === "token" ? requirement.token : requirement.mode === "password" ? requirement.password : undefined;
  if (serviceSecret && matchesDigest(serviceSecret, adminDigest)) return notEnabled;
  const presented = headerValue(input.headers, "x-mindstone-admin-token");
  if (!presented || !matchesDigest(presented, adminDigest)) {
    return { allowed: false, status: 401, error: "the admin API needs the admin credential" };
  }
  if (headerValue(input.headers, "x-mindstone-user-role")?.toLowerCase() !== "admin") {
    return { allowed: false, status: 403, error: "the admin API needs the admin role" };
  }
  return { allowed: true };
}

/**
 * Keys whose values are secrets. A key is a secret when, with case and
 * separators ignored, it contains a secret word (botToken, client_secret,
 * privateKeyPem, apiKeyValue, authorizationHeader, credentialsJson, jwt,
 * sessionId, AWS_SECRET_ACCESS_KEY) or ends in a short one (encryption key,
 * dbPass, basicAuth, githubPat, sentryDsn), unless it ends in a word that
 * names where a secret lives (tokenEnv, tokenFile, keyPath, secretName,
 * tokenUrl).
 * Masking a harmless value by mistake costs little; missing a secret doesn't.
 */
const SECRET_WORDS = [
  "token", "secret", "password", "passwd", "credential", "bearer", "cookie", "jwt", "sessionid", "connectionstring",
  "signature", "apikey", "privatekey", "accesskey", "secretkey", "signingkey", "encryptionkey", "authorization",
];
/** Short words that count only at the end of a key, so `dispatch`, `mapping` or `author` aren't caught. */
const SECRET_SUFFIX_WORDS = ["key", "keys", "pass", "auth", "pat", "pin", "otp", "pem", "dsn"];
const REFERENCE_SUFFIXES = ["env", "envs", "file", "files", "path", "paths", "ref", "refs", "name", "names", "url", "urls", "mode", "dir"];
/** Words that make even a number a secret (a PIN is a number; a token budget is not a secret). */
const NUMERIC_SECRET_WORDS = ["password", "passwd", "secret", "pin", "otp", "pass"];
/**
 * Secret keys whose object values are opened rather than masked whole: an
 * `auth` block (gateway.auth) mostly holds references and a mode, and its
 * secrets are caught by their own keys.
 */
const OPEN_WHEN_OBJECT = new Set(["auth"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Keys that look like secrets but aren't: a session key is a routing id, a public key is public. */
const NOT_SECRET_SUFFIXES = ["sessionkey", "publickey"];

export function isSecretKey(key: string): boolean {
  const lower = normalizeKey(key);
  if (!lower) return false;
  if (REFERENCE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  if (NOT_SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix)) || lower.includes("tokenizer")) return false;
  return SECRET_WORDS.some((word) => lower.includes(word)) || SECRET_SUFFIX_WORDS.some((word) => lower.endsWith(word));
}

/** Whether the value under `key` is replaced by `{ set }` as a whole. */
function masksWhole(key: string, value: unknown): boolean {
  if (!key || !isSecretKey(key)) return false;
  if (typeof value === "boolean") return false;
  if (typeof value === "number") return NUMERIC_SECRET_WORDS.some((word) => normalizeKey(key).includes(word));
  return !(OPEN_WHEN_OBJECT.has(normalizeKey(key)) && value !== null && typeof value === "object" && !Array.isArray(value));
}

/** Header and environment maps (or lists): every value in them is a secret. */
function isSecretMap(key: string): boolean {
  const lower = normalizeKey(key);
  return lower.includes("header") || lower.startsWith("env") || lower.includes("environment") || lower.endsWith("vars") || lower.endsWith("variables");
}

const SECRET_PARAM_NAME = /(key|token|secret|password|passwd|signature|sig|auth|credential|code|jwt|session)/i;
/** A URL path segment that looks like a credential: very long, long and mixed, or a bot token (`bot<id>:<secret>`). */
function isSecretPathSegment(segment: string): boolean {
  if (segment.includes(":") || segment.length >= 24) return true;
  return segment.length >= 16 && /[A-Za-z]/.test(segment) && /\d/.test(segment);
}

// Names that end in a secret word, with any prefix: password, DB_PASSWORD, access_token,
// OPENAI_API_KEY, client_secret, private_key, refresh_token.
const SECRET_NAME = String.raw`[\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)`;
// `NAME=value` with no spaces around "=" (DSNs, env lines, connection strings), so prose
// such as "1 token = 4 characters" is left alone.
const INLINE_SECRET_EQ = new RegExp(String.raw`(?<![\w-])(${SECRET_NAME})=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&"']+)`, "gi");
// YAML-style `name: value` at the start of a line.
const INLINE_SECRET_YAML = new RegExp(String.raw`(^|\n)([ \t]*${SECRET_NAME}[ \t]*:[ \t]*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)`, "gi");
// `"name": "value"` (JSON inside a string), up to the closing quote.
const INLINE_SECRET_JSON = new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*")((?:[^"\\]|\\.)*)(")|('${SECRET_NAME}'\s*:\s*')((?:[^'\\]|\\.)*)(')`, "gi");
// Header lines: `Authorization: <scheme> <value>` and `X-…-Key/Token/Secret: <value>`.
const INLINE_HEADER = /(?<![\w-])(authorization|cookie|api-key|x-[\w-]*(?:key|token|secret))(\s*:\s*)((?:bearer|basic|token)\s+)?([^\s'"]+)/gi;
// `Bearer <credential>` / `Basic <credential>` elsewhere, when the value looks like one:
// 12+ characters with a digit, mixed case, or base64 padding ("basic question-and-answer" is prose).
const INLINE_BEARER = /\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{12,})/gi;
// curl -u user:pass
const INLINE_USER_FLAG = /((?:^|\s)(?:-u|--user|--password|--pass)(?:\s+|=))(\S+)/g;
// The lookbehinds stop a match restarting inside a long run of word characters,
// which made these patterns quadratic (#38 review: 256 KB took ~40 s).
const URL_IN_TEXT = /(?<![\w.+-])[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
/** Strings longer than this are masked whole rather than scanned. */
const MAX_SCANNED_STRING = 8192;

function looksLikeCredential(value: string): boolean {
  return /\d/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) || value.endsWith("=");
}

/**
 * A plain string with inline credentials masked: `NAME=value` pairs, JSON
 * `"name": "value"`, header lines, Bearer/Basic credentials, `-u user:pass`,
 * and credentials in URLs anywhere in the string.
 */
export function maskInlineSecrets(value: string): string {
  return value
    .replace(URL_IN_TEXT, (url) => maskUrlCredentials(url))
    .replace(INLINE_SECRET_EQ, (_match, name: string) => `${name}=***`)
    .replace(INLINE_SECRET_YAML, (_match, start: string, name: string) => `${start}${name}***`)
    .replace(INLINE_SECRET_JSON, (_match, dOpen?: string, _d?: string, dClose?: string, sOpen?: string, _s?: string, sClose?: string) =>
      dOpen !== undefined ? `${dOpen}***${dClose}` : `${sOpen}***${sClose}`)
    .replace(INLINE_HEADER, (_match, name: string, sep: string, scheme: string | undefined) => `${name}${sep}${scheme ?? ""}***`)
    .replace(INLINE_BEARER, (match, scheme: string, credential: string) => (looksLikeCredential(credential) ? `${scheme} ***` : match))
    .replace(INLINE_USER_FLAG, (_match, flag: string) => `${flag}***`);
}

/**
 * Free-text notes (onboarding preferences and identity notes, anything named
 * …Notes or …Context) are the owner's prose: they are shown as written, so a
 * phrase that reads like a credential doesn't lock the note behind the
 * advanced-settings permission.
 */
function isProseKey(key: string): boolean {
  const lower = normalizeKey(key);
  return lower.endsWith("notes") || lower.endsWith("context") || lower.endsWith("direction");
}

/** A query or fragment with secret-looking parameter values masked (split, not scanned: linear). */
function maskParams(params: string): string {
  if (!params) return params;
  const lead = params[0] === "?" || params[0] === "#" ? params[0] : "";
  return lead + params.slice(lead.length).split(/([&;])/).map((part) => {
    const eq = part.indexOf("=");
    if (eq <= 0) return part;
    const name = part.slice(0, eq);
    return SECRET_PARAM_NAME.test(name) && eq < part.length - 1 ? `${name}=***` : part;
  }).join("");
}

/**
 * A string with credentials inside a URL masked: userinfo, secret-looking
 * query and fragment parameters, and path segments that look like tokens
 * (webhook and bot URLs carry the secret in the path). Anything that isn't a
 * URL is returned as it is.
 */
export function maskUrlCredentials(value: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/is.exec(value.trim());
  if (!scheme) return maskInlineSecrets(value);
  if (/\s/.test(value.trim())) return maskInlineSecrets(value);
  let rest = scheme[2]!;
  // Userinfo: everything up to the last "@" before the path, even with "/" in a password.
  const at = rest.lastIndexOf("@");
  const firstQuery = rest.search(/[?#]/);
  if (at !== -1 && (firstQuery === -1 || at < firstQuery)) rest = `***@${rest.slice(at + 1)}`;
  const queryStart = rest.search(/[?#]/);
  const hostAndPath = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const tail = queryStart === -1 ? "" : rest.slice(queryStart);
  const slash = hostAndPath.indexOf("/");
  const host = slash === -1 ? hostAndPath : hostAndPath.slice(0, slash);
  const path = slash === -1 ? "" : hostAndPath.slice(slash);
  const maskedPath = path.split("/").map((segment) => (isSecretPathSegment(segment) ? "***" : segment)).join("/");
  const hash = tail.indexOf("#");
  const query = hash === -1 ? tail : tail.slice(0, hash);
  const fragment = hash === -1 ? "" : tail.slice(hash);
  const maskedFragment = fragment && !fragment.includes("=") && fragment.length > 17 ? "#***" : maskParams(fragment);
  return `${scheme[1]}${host}${maskedPath}${maskParams(query)}${maskedFragment}`;
}

const SECRET_FLAG = /^(--?[\w-]*(key|token|secret|password|passwd|auth|credential|header)[\w-]*|-[kHu])$/i;
const SECRET_FLAG_WITH_VALUE = /^(--?[\w-]*(?:key|token|secret|password|passwd|auth|credential)[\w-]*=).+$/i;

/** A command-line style list (`["--api-key", "…"]`, `["--token=…"]`) with the secret values masked. */
function maskArgs(items: unknown[]): unknown[] {
  return items.map((item, index) => {
    if (typeof item !== "string") return maskConfig(item);
    if (item.length > MAX_SCANNED_STRING) return { set: true };
    const previous = items[index - 1];
    if (typeof previous === "string" && SECRET_FLAG.test(previous)) return "***";
    const withValue = SECRET_FLAG_WITH_VALUE.exec(item);
    if (withValue) return `${withValue[1]}***`;
    return maskUrlCredentials(item);
  });
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * A copy of the config safe to show in a browser. The value under a secret
 * key becomes `{ "set": true|false }` whatever its type (booleans and token
 * budgets excepted); so does every value in a header or environment map, and
 * every string in a header or environment list. Credentials inside URLs and
 * command-line style lists are masked. Secret references (tokenEnv,
 * tokenFile, …) are kept.
 */
export function maskConfig(value: unknown, key = "", parentIsSecretMap = false): unknown {
  if (masksWhole(key, value) || (parentIsSecretMap && key)) return { set: isSet(value) };
  if (typeof value === "string") {
    if (isProseKey(key)) return value;
    return value.length > MAX_SCANNED_STRING ? { set: true } : maskUrlCredentials(value);
  }
  if (Array.isArray(value)) {
    if (key && isSecretMap(key)) {
      // A header list: strings ("Name: value") or objects ({ name, value }); only names stay visible.
      return value.map((item) => {
        if (typeof item === "string") return { set: item !== "" };
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([k, v]) => [k, normalizeKey(k) === "name" ? v : { set: isSet(v) }]));
        }
        return { set: isSet(item) };
      });
    }
    return maskArgs(value);
  }
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
  // The base personas onboarding offers (the same list as `mindstone onboard`).
  const profiles = BUILT_IN_MINDSTONE_PROFILES.map(({ id, label, description }) => ({ id, label, description }));
  return { ok: true, ...onboardingSteps(config), profiles, system };
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
type Check = (next: unknown, previous: unknown) => boolean;
const isBool: Check = (value) => value === undefined || typeof value === "boolean";
const inRange = (min: number, max: number): Check => (value) =>
  value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
const isShortText: Check = (value) => value === undefined || (typeof value === "string" && value.length <= 200 && !/[\r\n]/.test(value));
const isNote: Check = (value) => value === undefined || (typeof value === "string" && value.length <= 4000);
const isId: Check = (value) => value === undefined || (typeof value === "string" && PLAIN_ID.test(value));
const oneOf = (...allowed: string[]): Check => (value) => value === undefined || (typeof value === "string" && allowed.includes(value));
/** Only turning something off is free. */
const onlyOff: Check = (value) => value === false;
/**
 * For a setting that is off when absent (memory.autoRecall): turning it off
 * or removing it is free (#78). Not for channels.*.enabled, which is on when
 * absent.
 */
const offOrAbsent: Check = (value) => value === false || value === undefined;
/** Only turning something on is free (a safety switch). */
const onlyOn: Check = (value) => value === undefined || value === true;
const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
/**
 * Narrowing an access list is free, widening it is not: the new list must be
 * a subset of the old one, with no "*". `removable` says whether deleting the
 * list narrows it (a missing allowedSenders lets nobody in; a missing
 * allowedChats or allowedGuilds lets every chat in).
 */
const narrows = (removable: boolean): Check => (value, previous) => {
  if (value === undefined) return removable;
  const next = stringList(value);
  const before = stringList(previous) ?? [];
  if (!next || (!removable && next.length === 0)) return false;
  return next.every((item) => item.trim() !== "*" && before.includes(item));
};

/**
 * The settings the browser may change without the advanced-settings
 * permission (default deny, #38 review rounds 1 and 2): each dotted pattern
 * ("*" is one segment) with a check on the new value, given the old one.
 * Everything else needs the permission: anything that names an environment
 * variable, a URL, a file or a directory; sends memory to a new provider;
 * turns off a safety rule; or opens the agent to anyone new (a new or
 * re-enabled channel, a new sender, chat or guild, a token, answering
 * without a mention, a changed trigger prefix, or who counts as the owner).
 */
const SAFE_SETTINGS: Array<{ pattern: string; value: Check }> = [
  { pattern: "routing.mode", value: oneOf("placeholder", "mock", "pi", "pi-session") },
  { pattern: "routing.defaultModel", value: isShortText },
  { pattern: "routing.defaultAgentId", value: isId },
  { pattern: "routing.mock.responsePrefix", value: isShortText },
  { pattern: "agents.*.id", value: isId },
  { pattern: "agents.*.defaultModel", value: isShortText },
  { pattern: "agents.*.contextWindowTokens", value: inRange(1024, 10_000_000) },
  { pattern: "agents.*.profileId", value: isId },
  // Turning memory.autoRecall ON needs the permission: it exposes the open #71
  // (tenant recall can see the owner's unscoped memory). Turning it off is the
  // mitigation, so it stays free.
  { pattern: "memory.autoRecall", value: offOrAbsent },
  { pattern: "memory.vectorStore", value: oneOf("lancedb", "sqlite-vec", "memory") },
  { pattern: "memory.recall.maxResults", value: inRange(1, 100) },
  { pattern: "memory.recall.maxPromptTokens", value: inRange(1, 1_000_000) },
  { pattern: "memory.recall.minScore", value: inRange(0, 1) },
  { pattern: "memory.recall.dedupAgainstActiveContext", value: isBool },
  { pattern: "memory.recall.maxActiveEntriesForDedup", value: inRange(1, 100_000) },
  { pattern: "memory.index.enabled", value: isBool },
  { pattern: "memory.index.maxPromptTokens", value: inRange(1, 1_000_000) },
  { pattern: "memory.invariants.enabled", value: onlyOn },
  { pattern: "memory.invariants.maxPromptTokens", value: inRange(1, 1_000_000) },
  { pattern: "channels.*.enabled", value: onlyOff },
  { pattern: "channels.*.allowedSenders", value: narrows(true) },
  { pattern: "channels.*.allowedChats", value: narrows(false) },
  { pattern: "channels.*.allowedGuilds", value: narrows(false) },
  { pattern: "channels.*.respondWithoutMention", value: onlyOff },
  { pattern: "channels.*.pollMs", value: inRange(100, 3_600_000) },
  { pattern: "channels.*.pollIntervalMs", value: inRange(100, 3_600_000) },
  { pattern: "channels.*.reconnectMs", value: inRange(100, 3_600_000) },
  { pattern: "channels.*.maxBodyChars", value: inRange(100, 1_000_000) },
  { pattern: "session.mode", value: oneOf("single", "per_surface") },
  { pattern: "contextManagement.mode", value: oneOf("auto_compact", "sliding_window") },
  { pattern: "contextManagement.*Percent", value: inRange(1, 100) },
  { pattern: "contextManagement.*Tokens", value: inRange(0, 10_000_000) },
  { pattern: "contextManagement.minRecentMessages", value: inRange(0, 10_000) },
  { pattern: "contextManagement.emergencyAutoHandoff", value: isBool },
  { pattern: "contextManagement.preserveTranscript", value: isBool },
  { pattern: "gateway.http.chatCompletions.enabled", value: isBool },
  { pattern: "gateway.http.responses.enabled", value: isBool },
  { pattern: "personas.active", value: isId },
  { pattern: "workflows.active", value: isId },
  { pattern: "knowledgebases.recall.enabled", value: isBool },
  // Enum fields first (the first matching pattern decides): their values are
  // written into the identity markdown as labels.
  { pattern: "onboarding.preferences.interactionDetail", value: oneOf("concise", "balanced", "detailed") },
  { pattern: "onboarding.preferences.recommendationStyle", value: oneOf("direct", "options_tradeoffs", "ask_first") },
  { pattern: "onboarding.preferences.workStyle", value: oneOf("act_directly", "plan_first", "ask_first") },
  { pattern: "onboarding.preferences.approvalMode", value: oneOf("standard", "strict", "custom") },
  { pattern: "onboarding.preferences.memoryStyle", value: oneOf("propose_checkpoint_memories", "minimal", "ask_each_time") },
  { pattern: "onboarding.preferences.selectedAt", value: isShortText },
  { pattern: "onboarding.preferences.*Notes", value: isNote },
  { pattern: "onboarding.preferences.projectContext", value: isNote },
  { pattern: "onboarding.identity.mode", value: oneOf("defer", "seed", "custom") },
  { pattern: "onboarding.identity.candidateName", value: isShortText },
  { pattern: "onboarding.identity.identityDirection", value: isNote },
  { pattern: "onboarding.identity.namingNotes", value: isNote },
  { pattern: "onboarding.identity.selectedAt", value: isShortText },
];

/** A dotted pattern: "*" is a whole segment; "*Suffix" matches a segment ending in Suffix. */
function matchesPattern(pattern: string, path: string): boolean {
  const p = pattern.split(".");
  const q = path.split(".");
  return p.length === q.length && p.every((part, i) =>
    part === "*" || part === q[i] || (part.startsWith("*") && q[i]!.endsWith(part.slice(1)) && q[i]!.length > part.length - 1));
}

function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    // Own properties only, so a key like "toString" isn't found on the prototype.
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Whether changing `path` (a dotted path from the config root) from its value
 * in `previousConfig` to its value in `nextConfig` needs the advanced-settings
 * permission. Default deny: only a SAFE_SETTINGS path whose change passes its
 * check is free. The first matching pattern decides. Patch keys never contain
 * dots (mergeConfigPatch refuses them), so a path names exactly one setting.
 */
export function isAdvancedChange(path: string, nextConfig: unknown, previousConfig?: unknown): boolean {
  // Creating a channel is free only as a disabled one: a new section that is
  // on (or doesn't say) starts a connector on the next restart.
  const channel = /^channels\.([^.]+)(\.|$)/.exec(path);
  if (channel && valueAt(previousConfig, `channels.${channel[1]}`) === undefined
    && valueAt(nextConfig, `channels.${channel[1]}.enabled`) !== false) return true;
  const rule = SAFE_SETTINGS.find((candidate) => matchesPattern(candidate.pattern, path));
  if (!rule) return true;
  return !rule.value(valueAt(nextConfig, path), valueAt(previousConfig, path));
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
 * JSON merge patch (RFC 7396) of `patch` onto `target`, for the Console.
 * - What GET /admin/config returned, sent back unchanged, keeps the stored
 *   value: a masked secret `{ set: … }`, a URL with its credentials masked,
 *   a masked header list. So the Console can round-trip what it read.
 * - A new plain value for a secret is refused: secrets go through
 *   POST /admin/secrets and are referenced with tokenFile. (This also means a
 *   patch can't be used to guess a stored secret.)
 * - Keys must be non-empty and contain no ".", so every changed path names
 *   exactly one setting. Prototype keys and patches nested deeper than
 *   MAX_PATCH_DEPTH are refused.
 */
export function mergeConfigPatch(
  target: unknown,
  patch: unknown,
  key = "",
  parentIsSecretMap = false,
  depth = 0,
  touched: { secrets: boolean } = { secrets: false },
): unknown {
  if (depth > MAX_PATCH_DEPTH) throw new AdminPatchError("the patch is nested too deeply");
  const shown = target === undefined ? undefined : JSON.stringify(maskConfig(target, key, parentIsSecretMap));
  if (shown !== undefined && JSON.stringify(patch) === shown) return target;
  const secretSlot = masksWhole(key, patch) || masksWhole(key, target) || (parentIsSecretMap && key);
  if (secretSlot && isMaskedSecret(patch)) return target;
  if (secretSlot) {
    throw new AdminPatchError(`${key}: store secrets with POST /admin/secrets/<name> and reference them with tokenFile`);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    // Replacing a value that held masked content (a URL with a password, a
    // header list, a list of objects with tokens). The caller requires the
    // permission for that, even when nothing changes, so a patch can't be used
    // to confirm a guess at the hidden part (#38 review round 3).
    if (shown !== undefined && shown !== JSON.stringify(target)) touched.secrets = true;
    return patch;
  }
  const base: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  const secretMap = Boolean(key) && isSecretMap(key);
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) throw new AdminPatchError(`the key "${k}" is not allowed`);
    if (!k || k.includes(".")) throw new AdminPatchError(`the key "${k.slice(0, 64)}" is not allowed: keys can't be empty or contain "."`);
    if (v === null) delete base[k];
    else base[k] = mergeConfigPatch(base[k], v, k, secretMap, depth + 1, touched);
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
/**
 * Keyed with a per-process random secret, so the etag can't be used to check
 * guesses at the hidden parts of the config offline (#38 review round 3).
 * A restart changes every etag; a client holding an old one gets a 412 and
 * reloads.
 */
const ETAG_KEY = randomBytes(32);
export function configEtag(content: string): string {
  return `"${createHmac("sha256", ETAG_KEY).update(content).digest("hex").slice(0, 32)}"`;
}

export type AdminPermissions = { advancedSettings: boolean; grantedBy?: string; grantedAt?: string; expiresAt?: string };

/** How long a grant of the advanced-settings permission lasts. */
export const ADVANCED_GRANT_MS = 60 * 60 * 1000;

/** The permission as stored, with an expired grant read as not granted. */
export function effectivePermissions(stored: AdminPermissions, now = Date.now()): AdminPermissions {
  if (stored.advancedSettings !== true) return { advancedSettings: false };
  const granted = stored.grantedAt ? Date.parse(stored.grantedAt) : NaN;
  const stated = stored.expiresAt ? Date.parse(stored.expiresAt) : NaN;
  // The grant runs from grantedAt for at most one grant length, and grantedAt
  // can't be in the future (a minute's clock skew allowed), so no hand-edited
  // date makes it permanent (#75 review).
  if (!Number.isFinite(granted) || granted > now + 60_000) {
    return { advancedSettings: false };
  }
  const expires = Math.min(granted + ADVANCED_GRANT_MS, Number.isFinite(stated) ? stated : Infinity);
  if (expires <= now) {
    return { advancedSettings: false };
  }
  // The expiry that applies, not the stored one, which may be later (#78).
  return { ...stored, expiresAt: new Date(expires).toISOString() };
}

/** Whether an If-Match header (strong or weak, one etag or a list) matches the current etag. */
export function ifMatchSatisfied(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  return header.split(",").map((part) => part.trim().replace(/^W\//, "")).includes(etag);
}

/** Where the admin permission lives: runtime state, not config, so a config patch can't grant it. */
export function adminPermissionsPath(dataDir: string): string {
  return `${dataDir}/admin/permissions.json`;
}
