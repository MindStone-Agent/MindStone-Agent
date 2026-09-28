/**
 * Enterprise model endpoints (#126): Azure OpenAI / AI Foundry, Amazon
 * Bedrock, Google Vertex AI, and an OpenAI-compatible enterprise gateway.
 *
 * Each kind is one custom provider in Pi's isolated models.json, plus a Pi
 * auth.json entry for that provider: `{ type: "api_key", key, env }`. Pi reads
 * a provider's `env` before the gateway's own environment
 * (ai/src/utils/provider-env.ts), and Azure, Bedrock and Vertex take their
 * endpoint, region, project and credentials from it, so every setting stays
 * with its provider and a change applies on the next message without a
 * restart. Pi still falls back to the environment for anything left unset;
 * the gateway refuses the registrations where that would change whose
 * credentials are used.
 *
 * This module only parses and shapes a registration. The gateway resolves
 * secret names to values (with its credential guards), writes the files and
 * runs the live test.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { literalConfigValueText, MODEL_ID_PATTERN, readIsolatedModelsConfig } from "./local-models.js";

export type EnterpriseKind = "azure-openai" | "bedrock" | "vertex" | "enterprise-openai";

export type EnterpriseKindInfo = {
  kind: EnterpriseKind;
  providerId: string;
  name: string;
  api: string;
  /** The fields the Console shows, in order. */
  fields: EnterpriseField[];
  /** Whether the models can be listed from the endpoint (otherwise the admin enters them). */
  listsModels: boolean;
};

export type EnterpriseField = {
  name: string;
  label: string;
  /** "secret": the name of a stored secret (the value is stored first, never sent here). */
  type: "url" | "text" | "secret" | "list" | "headers";
  required: boolean | "one-of";
  /** For "one-of" fields: the group, one of whose fields is required. */
  group?: string;
  hint?: string;
  /** A secret pasted as several lines (a service account key file). */
  multiline?: boolean;
};

export const ENTERPRISE_KINDS: Record<EnterpriseKind, EnterpriseKindInfo> = {
  "azure-openai": {
    kind: "azure-openai",
    providerId: "enterprise-azure",
    name: "Azure OpenAI / AI Foundry",
    api: "azure-openai-responses",
    listsModels: false,
    fields: [
      { name: "endpoint", label: "Endpoint", type: "url", required: true, hint: "https://<resource>.openai.azure.com, or an Azure AI Foundry or API Management address ending in /openai/v1" },
      { name: "models", label: "Deployment names", type: "list", required: true, hint: "The names of your model deployments" },
      { name: "apiVersion", label: "API version", type: "text", required: false, hint: "Leave empty for the v1 API" },
      { name: "secret", label: "API key", type: "secret", required: true },
    ],
  },
  bedrock: {
    kind: "bedrock",
    providerId: "enterprise-bedrock",
    name: "Amazon Bedrock",
    api: "bedrock-converse-stream",
    listsModels: false,
    // A Bedrock API key only: Pi 0.87 sends the stored key as Bedrock's bearer token
    // (bedrock-converse-stream.ts), so access keys can't be signed with (#126 review).
    fields: [
      { name: "region", label: "Region", type: "text", required: true, hint: "for example us-east-1" },
      { name: "models", label: "Model ids", type: "list", required: true, hint: "for example anthropic.claude-sonnet-4-5-20250929-v1:0" },
      { name: "bearerTokenSecret", label: "Bedrock API key", type: "secret", required: true },
    ],
  },
  vertex: {
    kind: "vertex",
    providerId: "enterprise-vertex",
    name: "Google Vertex AI",
    api: "google-vertex",
    listsModels: false,
    fields: [
      { name: "models", label: "Model ids", type: "list", required: true, hint: "for example gemini-2.5-flash" },
      { name: "secret", label: "API key (express mode)", type: "secret", required: "one-of", group: "key" },
      { name: "serviceAccountSecret", label: "Service account key (JSON)", type: "secret", required: "one-of", group: "adc", multiline: true },
      { name: "project", label: "Project id", type: "text", required: "one-of", group: "adc" },
      { name: "location", label: "Location", type: "text", required: "one-of", group: "adc", hint: "for example us-central1" },
    ],
  },
  "enterprise-openai": {
    kind: "enterprise-openai",
    providerId: "enterprise-openai",
    name: "OpenAI-compatible enterprise gateway",
    api: "openai-completions",
    listsModels: true,
    fields: [
      { name: "baseUrl", label: "Base URL", type: "url", required: true, hint: "https://…/v1" },
      { name: "secret", label: "API key", type: "secret", required: true },
      { name: "headers", label: "Extra headers", type: "headers", required: false, hint: "A value can be plain text, or a stored secret" },
      { name: "models", label: "Model ids", type: "list", required: false, hint: "Leave empty to list them from the endpoint" },
    ],
  },
};

export function isEnterpriseKind(value: string): value is EnterpriseKind {
  return Object.hasOwn(ENTERPRISE_KINDS, value);
}

export function enterpriseKindForProvider(providerId: string): EnterpriseKind | undefined {
  return (Object.values(ENTERPRISE_KINDS).find((info) => info.providerId === providerId) ?? undefined)?.kind;
}

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AWS_REGION = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_LOCATION = /^(global|[a-z]+-[a-z]+\d{1,2})$/;
const API_VERSION = /^[0-9a-z][0-9a-z.-]{0,39}$/i;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** Headers the gateway or the provider sets itself, which must never be overridden. */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "authorization", "api-key", "cookie", "x-mindstone-admin-token"]);

/** A secret reference: the stored secret's name. */
export type SecretRef = { secret: string };

/** A header value: plain text, or a stored secret. */
export type HeaderValue = string | SecretRef;

export type EnterpriseRegistration = {
  kind: EnterpriseKind;
  providerId: string;
  name: string;
  api: string;
  /** The URL written as the provider's baseUrl (Pi requires one for a custom provider). */
  baseUrl: string;
  /** The host a key or token is sent to, for the audit and the Console. */
  host: string;
  /** Model ids, or undefined to list them from the endpoint (enterprise-openai only). */
  models?: string[];
  /** The provider's key: a stored secret, or a Pi placeholder when the kind doesn't use one. */
  key: SecretRef | { placeholder: string };
  /** The provider's auth.json env: literal values, or stored secrets. */
  env: Record<string, string | SecretRef | { secretFile: string }>;
  headers?: Record<string, HeaderValue>;
};

function secretName(value: unknown, field: string): { error: string } | string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !SECRET_NAME.test(value) || value.includes("..")) {
    return { error: `${field} must be the name of a stored secret` };
  }
  return value;
}

/**
 * A host an enterprise endpoint's key must never go to: this machine, a
 * private, shared or link-local network (the cloud metadata address is
 * link-local), a single-label intranet name, or a reserved name. A server on
 * the private network is registered with the local presets instead.
 */
export function isNonPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isNonPublicV4(v4.slice(1).map(Number));
  if (host.includes(":")) {
    // IPv6: loopback, unspecified, unique-local, link-local, multicast, and IPv4-mapped or -translated addresses.
    if (host === "::" || host === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host) || /^ff/.test(host)) return true;
    const mapped = /^(?:::ffff:|64:ff9b::)(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
    if (mapped) {
      const octets = mapped[1] !== undefined
        ? mapped.slice(1, 5).map(Number)
        : [parseInt(mapped[5]!, 16) >> 8, parseInt(mapped[5]!, 16) & 255, parseInt(mapped[6]!, 16) >> 8, parseInt(mapped[6]!, 16) & 255];
      return isNonPublicV4(octets);
    }
    return /^::/.test(host);
  }
  if (!host.includes(".")) return true;
  return /(^|\.)(localhost|local|internal|localdomain|home\.arpa|intranet|lan|corp|svc|consul|cluster|default)$/.test(host) || host === "host.docker.internal";
}

function isNonPublicV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

export type EnterpriseHostPolicy = {
  /**
   * Set only from the gateway host's own environment
   * (MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1), never from the Console: private
   * network hosts are allowed, and plain http to this machine (a test stub).
   */
  allowPrivateHosts?: boolean;
};

/** Exactly this machine: localhost, [::1] or a full 127.x.x.x address (never a name that merely starts with 127. or ends in .localhost). */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** An https URL to a public host, with no credentials, query or fragment. */
export function parseEnterpriseUrl(value: unknown, field: string, policy: EnterpriseHostPolicy = {}): { error: string } | URL {
  let url: URL;
  try {
    if (typeof value !== "string" || value.length > 500) throw new Error("not a string");
    url = new URL(value);
  } catch {
    return { error: `${field} must be an https URL` };
  }
  const plainLoopback = policy.allowPrivateHosts === true && url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !plainLoopback) return { error: `${field} must use https` };
  if (url.username || url.password || url.search || url.hash) return { error: `${field} must have no credentials, query or fragment` };
  // An enterprise endpoint is a hosted service: a key for it never goes to this machine or the private network.
  if (!policy.allowPrivateHosts && isNonPublicHost(url.hostname)) return { error: `${field} must be a public host, not this machine or a private network` };
  return url;
}

function modelList(value: unknown, required: boolean): { error: string } | string[] | undefined {
  if (value === undefined || (Array.isArray(value) && value.length === 0 && !required)) {
    return required ? { error: "models must list 1 to 100 model ids" } : undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 || !value.every((id) => typeof id === "string" && MODEL_ID_PATTERN.test(id.trim()))) {
    return { error: "models must list 1 to 100 model ids" };
  }
  return [...new Set((value as string[]).map((id) => id.trim()))];
}

function parseHeaders(value: unknown): { error: string } | Record<string, HeaderValue> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "headers must be an object of name to value" };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return { error: "at most 20 headers" };
  const out: Record<string, HeaderValue> = {};
  for (const [name, raw] of entries) {
    if (!HEADER_NAME.test(name)) return { error: `header name "${name.slice(0, 40)}" isn't valid` };
    if (RESERVED_HEADERS.has(name.toLowerCase())) return { error: `the ${name} header is set by the gateway and can't be overridden` };
    if (typeof raw === "string") {
      if (raw.length > 2000 || /[\r\n\u0000]/.test(raw)) return { error: `header ${name} must be one line of at most 2000 characters` };
      out[name] = raw;
    } else if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 1 && "secret" in raw) {
      const secret = secretName((raw as { secret: unknown }).secret, `header ${name}`);
      if (secret === undefined || typeof secret !== "string") return secret ?? { error: `header ${name} needs a secret name` };
      out[name] = { secret };
    } else {
      return { error: `header ${name} must be text or { "secret": "<name>" }` };
    }
  }
  return out;
}

/**
 * Parses the body of POST /admin/providers/enterprise/<kind>. Keys are never
 * values here: every credential is the name of a secret stored first with
 * POST /admin/secrets/<name>.
 */
export function parseEnterpriseRegistration(
  kind: EnterpriseKind,
  body: Record<string, unknown>,
  policy: EnterpriseHostPolicy = {},
): { error: string } | EnterpriseRegistration {
  const info = ENTERPRISE_KINDS[kind];
  const allowed = new Set(info.fields.map((field) => field.name));
  if (kind === "bedrock" && ["accessKeyIdSecret", "secretAccessKeySecret", "sessionTokenSecret"].some((key) => Object.hasOwn(body, key))) {
    return { error: "Bedrock access keys aren't supported: Pi sends the stored key as a Bedrock API key. Register a Bedrock API key (bearerTokenSecret)" };
  }
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `unknown field: ${unknown[0]} (a key is given as the name of a stored secret, never as a value)` };
  const base = { kind, providerId: info.providerId, name: info.name, api: info.api };

  if (kind === "azure-openai") {
    const url = parseEnterpriseUrl(body.endpoint, "endpoint", policy);
    if ("error" in url) return url;
    const models = modelList(body.models, true);
    if (!models || "error" in models) return models ?? { error: "models must list 1 to 100 deployment names" };
    const secret = secretName(body.secret, "secret");
    if (!secret || typeof secret !== "string") return secret && typeof secret !== "string" ? secret : { error: "an API key is required: store it, then send its name as secret" };
    if (body.apiVersion !== undefined && body.apiVersion !== "" && (typeof body.apiVersion !== "string" || !API_VERSION.test(body.apiVersion))) {
      return { error: "apiVersion must be a version such as 2025-04-01-preview, or empty for v1" };
    }
    const endpoint = url.toString().replace(/\/+$/, "");
    return {
      ...base,
      baseUrl: endpoint,
      host: url.hostname,
      models,
      key: { secret },
      // The provider's own base URL and version: they win over any gateway-wide AZURE_OPENAI_* variable.
      env: {
        AZURE_OPENAI_BASE_URL: endpoint,
        ...(typeof body.apiVersion === "string" && body.apiVersion ? { AZURE_OPENAI_API_VERSION: body.apiVersion } : {}),
      },
    };
  }

  if (kind === "bedrock") {
    if (typeof body.region !== "string" || !AWS_REGION.test(body.region)) return { error: "region must be an AWS region such as us-east-1" };
    const models = modelList(body.models, true);
    if (!models || "error" in models) return models ?? { error: "models must list 1 to 100 model ids" };
    const bearer = secretName(body.bearerTokenSecret, "bearerTokenSecret");
    if (bearer && typeof bearer !== "string") return bearer;
    if (typeof bearer !== "string") return { error: "a Bedrock API key is required: store it, then send its name as bearerTokenSecret" };
    const host = `bedrock-runtime.${body.region}.amazonaws.com`;
    return {
      ...base,
      baseUrl: `https://${host}`,
      host,
      models,
      // Pi sends the stored key as Bedrock's bearer token, ahead of any AWS_BEARER_TOKEN_BEDROCK in the environment.
      key: { secret: bearer },
      env: { AWS_REGION: body.region },
    };
  }

  if (kind === "vertex") {
    const models = modelList(body.models, true);
    if (!models || "error" in models) return models ?? { error: "models must list 1 to 100 model ids" };
    const secret = secretName(body.secret, "secret");
    const serviceAccount = secretName(body.serviceAccountSecret, "serviceAccountSecret");
    for (const parsed of [secret, serviceAccount]) if (parsed && typeof parsed !== "string") return parsed;
    if (typeof secret === "string" && typeof serviceAccount === "string") return { error: "send either an API key or a service account key, not both" };
    if (typeof secret !== "string" && typeof serviceAccount !== "string") return { error: "credentials are required: an API key, or a service account key with a project and location" };
    const project = body.project === undefined || body.project === "" ? undefined : body.project;
    const location = body.location === undefined || body.location === "" ? undefined : body.location;
    if (project !== undefined && (typeof project !== "string" || !GCP_PROJECT.test(project))) return { error: "project must be a Google Cloud project id" };
    if (location !== undefined && (typeof location !== "string" || !GCP_LOCATION.test(location))) return { error: "location must be a region such as us-central1, or global" };
    if (typeof serviceAccount === "string" && (!project || !location)) return { error: "a service account key needs the project id and the location" };
    return {
      ...base,
      // "{location}" keeps Pi on Vertex's own regional address (google-vertex.ts ignores a baseUrl holding it).
      baseUrl: "https://{location}-aiplatform.googleapis.com",
      host: typeof serviceAccount === "string" && location !== "global" ? `${location}-aiplatform.googleapis.com` : "aiplatform.googleapis.com",
      models,
      // A placeholder key ("<…>") makes Pi use the service account (application default credentials).
      key: typeof secret === "string" ? { secret } : { placeholder: "<gcp-service-account>" },
      // An API key (express mode) needs neither project nor location, and Pi doesn't read them then.
      env: typeof serviceAccount === "string"
        ? {
            GOOGLE_APPLICATION_CREDENTIALS: { secretFile: serviceAccount },
            GOOGLE_CLOUD_PROJECT: project as string,
            GOOGLE_CLOUD_LOCATION: location as string,
          }
        : {},
    };
  }

  // enterprise-openai
  const url = parseEnterpriseUrl(body.baseUrl, "baseUrl", policy);
  if ("error" in url) return url;
  const secret = secretName(body.secret, "secret");
  if (!secret || typeof secret !== "string") return secret && typeof secret !== "string" ? secret : { error: "an API key is required: store it, then send its name as secret" };
  const headers = parseHeaders(body.headers);
  if (headers && "error" in headers) return headers as { error: string };
  const models = modelList(body.models, false);
  if (models && "error" in models) return models;
  return {
    ...base,
    baseUrl: url.toString().replace(/\/+$/, ""),
    host: url.hostname,
    ...(models ? { models } : {}),
    key: { secret },
    env: {},
    ...(headers && Object.keys(headers).length ? { headers: headers as Record<string, HeaderValue> } : {}),
  };
}

/** Every secret a registration reads, for the gateway's credential guards. */
export function enterpriseSecretNames(registration: EnterpriseRegistration): string[] {
  const names: string[] = [];
  if ("secret" in registration.key) names.push(registration.key.secret);
  for (const value of Object.values(registration.env)) {
    if (typeof value === "object" && "secret" in value) names.push(value.secret);
    if (typeof value === "object" && "secretFile" in value) names.push(value.secretFile);
  }
  for (const value of Object.values(registration.headers ?? {})) if (typeof value === "object") names.push(value.secret);
  return [...new Set(names)];
}

/** The enterprise providers memory can embed through: both speak the OpenAI embeddings API. */
export const ENTERPRISE_EMBEDDING_PROVIDERS = ["enterprise-azure", "enterprise-openai"] as const;
export type EnterpriseEmbeddingProviderId = (typeof ENTERPRISE_EMBEDDING_PROVIDERS)[number];

export function isEnterpriseEmbeddingProvider(value: string): value is EnterpriseEmbeddingProviderId {
  return (ENTERPRISE_EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

/** Pi's Azure base URL: an Azure OpenAI host without a path gets /openai/v1 (azure-openai-responses.ts). */
function azureV1BaseUrl(endpoint: string): string {
  const url = new URL(endpoint.trim().replace(/\/+$/, ""));
  const isAzureHost = url.hostname.endsWith(".openai.azure.com") || url.hostname.endsWith(".cognitiveservices.azure.com");
  const path = url.pathname.replace(/\/+$/, "");
  if (isAzureHost && (path === "" || path === "/openai")) url.pathname = "/openai/v1";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Where memory sends embedding requests for a registered enterprise
 * provider (#126): its own address and key, as registered from the Console,
 * read from Pi's isolated models.json and auth.json. Nothing comes from the
 * gateway's environment, so the key only goes where the provider's chat
 * requests go.
 */
export function enterpriseEmbeddingEndpoint(
  agentDir: string,
  providerId: EnterpriseEmbeddingProviderId,
): { baseUrl: string; headers: Record<string, string> } | { error: string } {
  const provider = readIsolatedModelsConfig(agentDir).config.providers[providerId];
  if (!provider?.baseUrl) return { error: `${providerId} isn't registered; add it under model providers first` };
  let credential: { type?: unknown; key?: unknown; env?: Record<string, unknown> } | undefined;
  try {
    const path = join(agentDir, "auth.json");
    const data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, typeof credential>) : {};
    credential = Object.hasOwn(data, providerId) ? data[providerId] : undefined;
  } catch {
    return { error: "the isolated auth.json can't be read" };
  }
  if (credential?.type !== "api_key" || typeof credential.key !== "string") {
    return { error: `${providerId} has no stored key; register it again` };
  }
  const key = literalConfigValueText(credential.key);
  if (providerId === "enterprise-azure") {
    const endpoint = typeof credential.env?.AZURE_OPENAI_BASE_URL === "string" ? credential.env.AZURE_OPENAI_BASE_URL : provider.baseUrl;
    try {
      return { baseUrl: azureV1BaseUrl(endpoint), headers: { "api-key": key } };
    } catch {
      return { error: "the registered Azure endpoint isn't a URL" };
    }
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(provider.headers ?? {})) headers[name] = literalConfigValueText(value);
  return { baseUrl: provider.baseUrl.replace(/\/+$/, ""), headers: { ...headers, authorization: `Bearer ${key}` } };
}

/**
 * A Vertex service account key as the gateway stores it (#126 review): only
 * the fields a service account needs, with Google's own token address, so
 * nothing in the file can point Google's client at another address or make
 * it run or fetch anything. Undefined for anything else.
 */
export function sanitizeServiceAccountKey(text: string): string | undefined {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    parsed = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const text_ = (name: string) => (typeof parsed[name] === "string" ? (parsed[name] as string) : undefined);
  if (parsed.type !== "service_account") return undefined;
  const privateKey = text_("private_key");
  const clientEmail = text_("client_email");
  if (!privateKey || !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey) || !clientEmail || !/^[^@\s]+@[^@\s]+$/.test(clientEmail)) return undefined;
  // A key that names another token or API address is refused, not rewritten: it isn't a plain Google service account.
  for (const [name, expected] of [["token_uri", "https://oauth2.googleapis.com/token"], ["universe_domain", "googleapis.com"]] as const) {
    if (parsed[name] !== undefined && parsed[name] !== expected) return undefined;
  }
  return `${JSON.stringify({
    type: "service_account",
    ...(text_("project_id") ? { project_id: text_("project_id") } : {}),
    ...(text_("private_key_id") ? { private_key_id: text_("private_key_id") } : {}),
    private_key: privateKey,
    client_email: clientEmail,
    ...(text_("client_id") ? { client_id: text_("client_id") } : {}),
    token_uri: "https://oauth2.googleapis.com/token",
  }, null, 2)}\n`;
}

/** Where the gateway keeps its validated copy of the Vertex service account key: in Pi's agent dir, never under secrets/. */
export function vertexServiceAccountPath(agentDir: string): string {
  return join(agentDir, "enterprise-vertex-service-account.json");
}

/** Pi treats these Vertex keys as "no key" and signs in with the machine's own Google login instead. */
export function isVertexPlaceholderKey(value: string): boolean {
  const key = value.trim();
  return key === "gcp-vertex-credentials" || /^<[^>]+>$/.test(key);
}

/**
 * The origins of the registered enterprise endpoints an admin chose (the
 * OpenAI-compatible gateway and Azure), for the gateway's redirect guard:
 * a request to one of them never follows a redirect elsewhere.
 */
export function enterpriseProviderOrigins(agentDir: string): Set<string> {
  const origins = new Set<string>();
  const providers = readIsolatedModelsConfig(agentDir).config.providers;
  for (const info of Object.values(ENTERPRISE_KINDS)) {
    const baseUrl = Object.hasOwn(providers, info.providerId) ? providers[info.providerId]?.baseUrl : undefined;
    if (typeof baseUrl !== "string" || baseUrl.includes("{")) continue;
    try {
      origins.add(new URL(baseUrl).origin);
    } catch {
      // not a URL: nothing to guard
    }
  }
  try {
    const path = join(agentDir, "auth.json");
    const data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, { env?: Record<string, unknown> }>) : {};
    const azure = Object.hasOwn(data, "enterprise-azure") ? data["enterprise-azure"]?.env?.AZURE_OPENAI_BASE_URL : undefined;
    if (typeof azure === "string") origins.add(new URL(azure).origin);
  } catch {
    // unreadable: the models.json origins still apply
  }
  return origins;
}
