import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatMindStoneChannelCatalog } from "../channels/index.js";
import { resolveContextManagementPolicy, type ContextManagementMode } from "../context/index.js";
import { runtimePathsFromEnv } from "../paths/runtime.js";
import { loadMindStoneConfig, resolveConfigPath, resolvePathRelativeToConfig } from "../config/load.js";
import type {
  GatewayAuthConfig,
  MindStoneApprovalMode,
  MindStoneConfig,
  MindStoneIdentityEmergenceMode,
  MindStoneInteractionDetail,
  MindStoneMemoryStyle,
  MindStoneOnboardingIdentity,
  MindStoneOnboardingPreferences,
  MindStoneRecommendationStyle,
  MindStoneRoutingConfig,
  MindStoneWorkStyle,
} from "../config/types.js";
import type { MindStoneModelInfo, MindStoneProviderInfo } from "../provider/index.js";
import {
  BUILT_IN_MINDSTONE_PROFILES,
  getBuiltInMindStoneProfile,
  isBuiltInMindStoneProfileId,
  type BuiltInMindStoneProfileId,
  type MindStoneSelectedProfile,
} from "../profile/index.js";
import type { MindStonePrompter, MindStoneSelectOption } from "./prompter.js";

export type MindStoneConfigWizardSection =
  | "all"
  | "workspace"
  | "gateway"
  | "routing"
  | "context"
  | "memory"
  | "identity"
  | "channels";

export type MindStoneOnboardingMode = "quickstart" | "manual";

export type MindStoneProviderAuthSetupRequest =
  | { providerId: string; mode: "env"; envVar: string }
  | { providerId: string; mode: "api_key"; apiKey: string }
  | { providerId: string; mode: "login" };

export type MindStoneConfigWizardOptions = {
  configPath?: string;
  sections?: MindStoneConfigWizardSection[];
  dryRun?: boolean;
  showHeader?: boolean;
  showIntro?: boolean;
  onboardingMode?: MindStoneOnboardingMode;
  availableModels?: MindStoneModelInfo[];
  availableProviders?: MindStoneProviderInfo[];
  modelDiscoveryError?: string;
  setupProviderAuth?: (request: MindStoneProviderAuthSetupRequest) => Promise<string | undefined> | string | undefined;
};

export type MindStoneConfigWizardResult = {
  path: string;
  wrote: boolean;
  config: MindStoneConfig;
  changedSections: string[];
};

export type MindStoneOnboardingResult = MindStoneConfigWizardResult & {
  identityPath?: string;
  userPath?: string;
  identityCreated: boolean;
  userCreated: boolean;
};

const TITLE = String.raw`
███╗   ███╗██╗███╗   ██╗██████╗ ███████╗████████╗ ██████╗ ███╗   ██╗███████╗
████╗ ████║██║████╗  ██║██╔══██╗██╔════╝╚══██╔══╝██╔═══██╗████╗  ██║██╔════╝
██╔████╔██║██║██╔██╗ ██║██║  ██║███████╗   ██║   ██║   ██║██╔██╗ ██║█████╗  
██║╚██╔╝██║██║██║╚██╗██║██║  ██║╚════██║   ██║   ██║   ██║██║╚██╗██║██╔══╝  
██║ ╚═╝ ██║██║██║ ╚████║██████╔╝███████║   ██║   ╚██████╔╝██║ ╚████║███████╗
╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═══╝╚══════╝
                         🔶 Agent Configuration
`;

const SECTION_OPTIONS: Array<MindStoneSelectOption<MindStoneConfigWizardSection>> = [
  { value: "all", label: "All core sections", hint: "workspace, gateway, routing, context, memory, identity, channels" },
  { value: "workspace", label: "Workspace", hint: "project root / working directory" },
  { value: "gateway", label: "Gateway", hint: "host, port, auth, HTTP surfaces" },
  { value: "routing", label: "Routing / provider", hint: "placeholder, mock, or session-backed Pi" },
  { value: "context", label: "Context management", hint: "sliding-window or auto-compact policy" },
  { value: "memory", label: "Memory", hint: "autoRecall, vector store, embedding provider" },
  { value: "identity", label: "Identity / user", hint: "default agent identity and user paths" },
  { value: "channels", label: "Channels / surfaces", hint: "list available plugins and setup status; diagnostic only for now" },
];

function asPositivePort(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

function asPercent(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 99);
}

function asPositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sectionList(selection: MindStoneConfigWizardSection): MindStoneConfigWizardSection[] {
  if (selection === "all") return ["workspace", "gateway", "routing", "context", "memory", "identity", "channels"];
  return [selection];
}

function stableJson(config: MindStoneConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function selectedProfileSummary(profile: MindStoneSelectedProfile | undefined): string {
  if (!profile) return "unset";
  return profile.id === "custom" ? `${profile.label} (custom)` : profile.label;
}

function preferenceLabel(value: string | undefined): string {
  return value?.replace(/_/g, " ") ?? "unset";
}

function selectedPreferencesSummary(preferences: MindStoneOnboardingPreferences | undefined): string {
  if (!preferences) return "unset";
  return [
    `detail=${preferenceLabel(preferences.interactionDetail)}`,
    `recommend=${preferenceLabel(preferences.recommendationStyle)}`,
    `work=${preferenceLabel(preferences.workStyle)}`,
    `approval=${preferenceLabel(preferences.approvalMode)}`,
    `memory=${preferenceLabel(preferences.memoryStyle)}`,
  ].join(" ");
}

function selectedIdentitySummary(identity: MindStoneOnboardingIdentity | undefined): string {
  if (!identity) return "unset";
  const name = identity.candidateName ? ` name=${identity.candidateName}` : "";
  return `${preferenceLabel(identity.mode)}${name}`;
}

export function formatMindStoneConfigHeader(): string {
  return TITLE;
}

export function formatConfigSummary(config: MindStoneConfig): string {
  const auth = config.gateway?.auth?.mode ?? "none";
  const routing = config.routing?.mode ?? "placeholder";
  const context = resolveContextManagementPolicy(config.contextManagement);
  const defaultAgent = config.routing?.defaultAgentId ?? "default";
  const piSafetyLines = routing === "pi-session"
    ? [
        `routing.pi.resumeCap: ${config.routing?.pi?.resumeCap?.enabled !== false} (${config.routing?.pi?.resumeCap?.maxEntries ?? 800} entries, dropErrorTurns=${config.routing?.pi?.resumeCap?.dropErrorTurns !== false})`,
        `routing.pi.compaction.reserveTokensFloor: ${config.routing?.pi?.compaction?.reserveTokensFloor ?? 20_000}`,
        `routing.pi.compaction.safeguardFallback: ${config.routing?.pi?.compaction?.safeguardFallback === true}`,
      ]
    : [];
  return [
    `workspace.root: ${config.workspace?.root ?? "."}`,
    `gateway: ${config.gateway?.host ?? "127.0.0.1"}:${config.gateway?.port ?? 19789} auth=${auth}`,
    `gateway.http.chatCompletions: ${config.gateway?.http?.chatCompletions?.enabled ?? false}`,
    `gateway.http.responses: ${config.gateway?.http?.responses?.enabled ?? false}`,
    `routing.mode: ${routing}`,
    `routing.defaultAgentId: ${defaultAgent}`,
    `routing.defaultModel: ${config.routing?.defaultModel ?? config.agents?.[defaultAgent]?.defaultModel ?? "unset"}`,
    ...piSafetyLines,
    `onboarding.profile: ${selectedProfileSummary(config.onboarding?.profile)}`,
    `onboarding.preferences: ${selectedPreferencesSummary(config.onboarding?.preferences)}`,
    `onboarding.identity: ${selectedIdentitySummary(config.onboarding?.identity)}`,
    `contextManagement.mode: ${context.mode}`,
    `memory.autoRecall: ${config.memory?.autoRecall ?? false}`,
    `memory.vectorStore: ${config.memory?.vectorStore ?? "sqlite-vec"}`,
    `memory.embeddingProvider: ${config.memory?.embeddingProvider ?? "unset"}`,
  ].join("\n");
}

export function formatConfigChangeSummary(before: MindStoneConfig, after: MindStoneConfig): string {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys].filter(
    (key) => JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify((after as Record<string, unknown>)[key]),
  );
  if (changed.length === 0) return "No changes.";
  return changed.map((key) => `~ ${key}`).join("\n");
}

export function validateMindStoneConfig(config: MindStoneConfig): string[] {
  const issues: string[] = [];
  const port = config.gateway?.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    issues.push("gateway.port must be an integer from 1 to 65535");
  }
  const host = config.gateway?.host;
  if (host !== undefined && host.trim() === "") issues.push("gateway.host cannot be blank");

  const auth = config.gateway?.auth;
  if (auth?.mode === "token" && !auth.tokenEnv && !auth.tokenFile) {
    issues.push("gateway.auth token mode should use tokenEnv or tokenFile");
  }
  if (auth?.mode === "password" && !auth.passwordEnv) {
    issues.push("gateway.auth password mode should use passwordEnv");
  }

  const routingMode = config.routing?.mode;
  if (routingMode && !["placeholder", "mock", "pi", "pi-session"].includes(routingMode)) {
    issues.push("routing.mode must be placeholder, mock, pi, or pi-session");
  }

  const context = resolveContextManagementPolicy(config.contextManagement);
  if (context.mode === "sliding_window" && context.floorPercent >= context.ceilingPercent) {
    issues.push("contextManagement.floorPercent must be lower than ceilingPercent");
  }
  return issues;
}

export function writeMindStoneConfig(configPath: string, config: MindStoneConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stableJson(config), "utf-8");
}

function withDefaultOnboardingConfig(config: MindStoneConfig): MindStoneConfig {
  const defaultAgentId = config.routing?.defaultAgentId ?? "default";
  return {
    ...config,
    workspace: { root: config.workspace?.root ?? ".", ...config.workspace },
    gateway: {
      host: "127.0.0.1",
      port: 19789,
      auth: { mode: "none" },
      http: {
        chatCompletions: { enabled: false },
        responses: { enabled: false },
        ...config.gateway?.http,
      },
      ...config.gateway,
    },
    routing: {
      mode: "placeholder",
      defaultAgentId,
      ...config.routing,
    },
    contextManagement: config.contextManagement ?? {
      mode: "sliding_window",
      ceilingPercent: 92,
      floorPercent: 70,
      minRecentMessages: 24,
      preserveTranscript: true,
    },
    session: {
      mode: "single",
      defaultSessionKey: "agent:default:main",
      ...config.session,
    },
    memory: {
      autoRecall: false,
      vectorStore: "sqlite-vec",
      ...config.memory,
      files: {
        enabled: true,
        memoryDir: "memory",
        journalsDir: "journals",
        logPath: "LOG.md",
        indexPath: "memory/MEMORY.md",
        includeMemoryFiles: true,
        includeJournals: true,
        includeLog: true,
        ...config.memory?.files,
      },
    },
    agents: {
      ...config.agents,
      [defaultAgentId]: {
        id: defaultAgentId,
        identityPath: `agents/${defaultAgentId}/IDENTITY.md`,
        userPath: `agents/${defaultAgentId}/USER.md`,
        profileId: config.onboarding?.profile?.id,
        ...config.agents?.[defaultAgentId],
      },
    },
  };
}

async function configureWorkspace(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  const currentRoot = config.workspace?.root ?? ".";
  const action = await prompter.select<"keep" | "custom">({
    message: "Workspace root",
    options: [
      { value: "keep", label: `Use ${currentRoot}`, hint: "recommended" },
      { value: "custom", label: "Enter a custom workspace path", hint: "advanced" },
    ],
    initialValue: "keep",
  });
  if (action === "keep") {
    return { ...config, workspace: { ...config.workspace, root: currentRoot } };
  }
  const root = await prompter.text({
    message: "Custom workspace root",
    placeholder: currentRoot,
    initialValue: currentRoot,
  });
  return { ...config, workspace: { ...config.workspace, root: root.trim() || currentRoot } };
}

async function chooseString(params: {
  prompter: MindStonePrompter;
  message: string;
  current: string;
  keepLabel?: string;
  customLabel?: string;
  customHint?: string;
}): Promise<string> {
  const action = await params.prompter.select<"keep" | "custom">({
    message: params.message,
    options: [
      { value: "keep", label: params.keepLabel ?? `Use ${params.current}`, hint: "recommended" },
      { value: "custom", label: params.customLabel ?? "Enter a custom value", hint: params.customHint ?? "advanced" },
    ],
    initialValue: "keep",
  });
  if (action === "keep") return params.current;
  const value = await params.prompter.text({
    message: params.customLabel ?? params.message,
    placeholder: params.current,
    initialValue: params.current,
  });
  return value.trim() || params.current;
}

async function chooseOptionalString(params: {
  prompter: MindStonePrompter;
  message: string;
  current?: string;
  suggested?: string;
  unsetLabel?: string;
  suggestedLabel?: string;
}): Promise<string | undefined> {
  type Choice = "unset" | "current" | "suggested" | "custom";
  const options: Array<MindStoneSelectOption<Choice>> = [
    { value: "unset", label: params.unsetLabel ?? "Leave unset", hint: "safe default" },
  ];
  if (params.current) options.push({ value: "current", label: `Use current: ${params.current}` });
  if (params.suggested) options.push({ value: "suggested", label: params.suggestedLabel ?? `Use ${params.suggested}` });
  options.push({ value: "custom", label: "Enter a custom value", hint: "manual" });
  const choice = await params.prompter.select<Choice>({
    message: params.message,
    options,
    initialValue: params.current ? "current" : "unset",
  });
  if (choice === "unset") return undefined;
  if (choice === "current") return params.current;
  if (choice === "suggested") return params.suggested;
  const value = await params.prompter.text({
    message: `Custom ${params.message}`,
    placeholder: params.suggested ?? params.current ?? "",
    initialValue: params.current ?? "",
  });
  return trimOrUndefined(value);
}

async function configureGateway(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  const gateway = config.gateway ?? {};
  let host = gateway.host ?? "127.0.0.1";
  let port = gateway.port ?? 19789;
  const network = await prompter.select<"local" | "custom">({
    message: "Gateway network",
    options: [
      { value: "local", label: `Use local Gateway ${host}:${port}`, hint: "recommended" },
      { value: "custom", label: "Customize host/port", hint: "advanced" },
    ],
    initialValue: "local",
  });
  if (network === "custom") {
    host = await chooseString({ prompter, message: "Gateway host", current: host });
    const portRaw = await chooseString({ prompter, message: "Gateway port", current: String(port) });
    port = asPositivePort(portRaw, port);
  }

  const authMode = await prompter.select<GatewayAuthConfig["mode"]>({
    message: "Gateway auth mode",
    options: [
      { value: "none", label: "None", hint: "local/dev only" },
      { value: "token", label: "Token", hint: "recommended for exposed Gateway" },
      { value: "password", label: "Password", hint: "read password from env" },
    ],
    initialValue: gateway.auth?.mode ?? "none",
  });

  let auth: GatewayAuthConfig = { mode: "none" };
  if (authMode === "token") {
    const tokenEnv = await chooseString({
      prompter,
      message: "Gateway token environment variable",
      current: gateway.auth?.mode === "token" ? gateway.auth.tokenEnv ?? "MINDSTONE_GATEWAY_TOKEN" : "MINDSTONE_GATEWAY_TOKEN",
    });
    auth = { mode: "token", tokenEnv };
  } else if (authMode === "password") {
    const passwordEnv = await chooseString({
      prompter,
      message: "Gateway password environment variable",
      current: gateway.auth?.mode === "password" ? gateway.auth.passwordEnv ?? "MINDSTONE_GATEWAY_PASSWORD" : "MINDSTONE_GATEWAY_PASSWORD",
    });
    auth = { mode: "password", passwordEnv };
  }

  const chatCompletions = await prompter.confirm({
    message: "Enable OpenAI-compatible /v1/chat/completions?",
    initialValue: gateway.http?.chatCompletions?.enabled ?? false,
  });
  const responses = await prompter.confirm({
    message: "Enable OpenAI-compatible /v1/responses?",
    initialValue: gateway.http?.responses?.enabled ?? false,
  });

  return {
    ...config,
    gateway: {
      ...gateway,
      host,
      port,
      auth,
      http: {
        ...gateway.http,
        chatCompletions: { ...gateway.http?.chatCompletions, enabled: chatCompletions },
        responses: { ...gateway.http?.responses, enabled: responses },
      },
    },
  };
}

function providerAuthMethod(providerId: string): string {
  if (["openai-codex", "github-copilot"].includes(providerId)) return "subscription/OAuth";
  if (providerId === "anthropic") return "Claude subscription OAuth or API key";
  return "API key/env/auth file";
}

function providerHint(provider: MindStoneProviderInfo): string {
  const auth = provider.authStatus?.configured
    ? provider.authStatus.label
      ? `configured via ${provider.authStatus.label}`
      : `configured${provider.authStatus.source ? ` via ${provider.authStatus.source}` : ""}`
    : `not configured; ${providerAuthMethod(provider.id)}`;
  return `${auth} · ${provider.availableModelCount}/${provider.modelCount} models available`;
}

function favoriteProviderScore(provider: MindStoneProviderInfo): number {
  const order = ["openai-codex", "anthropic", "github-copilot", "openai", "google", "openrouter", "mistral", "groq"];
  const index = order.indexOf(provider.id);
  return index === -1 ? 1000 : index;
}

function favoriteModelScore(model: MindStoneModelInfo): number {
  const id = model.id.toLowerCase();
  const preferred = ["gpt-5.5", "gpt-5.4", "gpt-5.2", "claude-sonnet-4-5", "claude-opus-4-5", "gemini-3", "gemini-2.5-pro"];
  const index = preferred.findIndex((needle) => id.includes(needle));
  return index === -1 ? 1000 : index;
}

function defaultProviderEnvVar(providerId: string): string {
  const map: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    mistral: "MISTRAL_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    nvidia: "NVIDIA_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    together: "TOGETHER_API_KEY",
    fireworks: "FIREWORKS_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
    "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
    "openai-codex": "OPENAI_API_KEY",
    "github-copilot": "GITHUB_TOKEN",
  };
  return map[providerId] ?? `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function supportsSubscriptionLogin(providerId: string): boolean {
  return ["openai-codex", "anthropic", "github-copilot"].includes(providerId);
}

async function maybeSetupProviderAuth(params: {
  prompter: MindStonePrompter;
  provider: MindStoneProviderInfo;
  setupProviderAuth?: MindStoneConfigWizardOptions["setupProviderAuth"];
}): Promise<void> {
  if (params.provider.authStatus?.configured || !params.setupProviderAuth) return;

  await params.prompter.note(
    [
      `${params.provider.name} is not connected in this isolated MindStone-Agent runtime yet.`,
      "Credentials will be stored under this project's .runtime directory, not in your global Pi account state.",
      supportsSubscriptionLogin(params.provider.id)
        ? "For subscription providers, MindStone starts the OAuth login flow here and stores credentials in this project's isolated runtime."
        : "For API-key providers, you can store an env-var reference or paste a key into the isolated auth file.",
    ].join("\n"),
    "Connect account",
  );

  type AuthChoice = "skip" | "login" | "env" | "api_key";
  const authOptions: Array<MindStoneSelectOption<AuthChoice>> = [
    { value: "skip", label: "Skip account connection for now", hint: "you can still choose a model; live calls will fail until auth exists" },
  ];
  if (supportsSubscriptionLogin(params.provider.id)) {
    authOptions.push({ value: "login", label: "Use subscription/OAuth login", hint: "ChatGPT Plus/Pro, Claude Pro/Max, or Copilot; MindStone connects it here" });
  }
  authOptions.push(
    { value: "env", label: "Use an environment variable", hint: `stores $${defaultProviderEnvVar(params.provider.id)} in isolated auth.json` },
    { value: "api_key", label: "Paste an API key now", hint: "stored in isolated auth.json with 0600-style permissions" },
  );

  const choice = await params.prompter.select<AuthChoice>({
    message: `How do you want to connect ${params.provider.name}?`,
    options: authOptions,
    initialValue: supportsSubscriptionLogin(params.provider.id) ? "login" : "env",
  });
  if (choice === "skip") return;

  if (choice === "login") {
    const message = await params.setupProviderAuth({ providerId: params.provider.id, mode: "login" });
    if (message) await params.prompter.note(message, "Subscription/OAuth login");
    return;
  }

  if (choice === "env") {
    const envVar = await chooseString({
      prompter: params.prompter,
      message: "API key environment variable",
      current: defaultProviderEnvVar(params.provider.id),
    });
    const message = await params.setupProviderAuth({ providerId: params.provider.id, mode: "env", envVar });
    if (message) await params.prompter.note(message, "Provider auth saved");
    return;
  }

  const apiKey = await params.prompter.text({
    message: `${params.provider.name} API key`,
    placeholder: "paste API key",
    sensitive: true,
  });
  if (!apiKey.trim()) return;
  const message = await params.setupProviderAuth({ providerId: params.provider.id, mode: "api_key", apiKey: apiKey.trim() });
  if (message) await params.prompter.note(message, "Provider auth saved");
}

async function choosePiModel(params: {
  prompter: MindStonePrompter;
  current?: string;
  availableModels?: MindStoneModelInfo[];
  availableProviders?: MindStoneProviderInfo[];
  discoveryError?: string;
  setupProviderAuth?: MindStoneConfigWizardOptions["setupProviderAuth"];
}): Promise<string | undefined> {
  const allModels = params.availableModels ?? [];
  const providersFromModels: MindStoneProviderInfo[] = [...new Set(allModels.map((model) => model.provider))].map((provider) => ({
    id: provider,
    name: provider,
    modelCount: allModels.filter((model) => model.provider === provider).length,
    availableModelCount: allModels.filter((model) => model.provider === provider).length,
  }));
  const providers = (params.availableProviders?.length ? params.availableProviders : providersFromModels)
    .filter((provider) => provider.modelCount > 0)
    .sort((a, b) => favoriteProviderScore(a) - favoriteProviderScore(b) || a.name.localeCompare(b.name));

  if (providers.length === 0) {
    await params.prompter.note(
      [
        "No isolated Pi providers/models were discovered for this runtime.",
        params.discoveryError ? `Discovery error: ${params.discoveryError}` : undefined,
        "Use `mindstone auth login openai-codex` or this model setup flow to connect an account, then rerun this wizard.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      "Pi provider discovery",
    );
    return undefined;
  }

  type ProviderChoice = "unset" | "current" | `provider:${string}`;
  const providerOptions: Array<MindStoneSelectOption<ProviderChoice>> = [{ value: "unset", label: "Leave unset", hint: "use Pi/provider default" }];
  if (params.current) providerOptions.push({ value: "current", label: `Keep current: ${params.current}` });
  for (const provider of providers) {
    providerOptions.push({ value: `provider:${provider.id}`, label: provider.name, hint: providerHint(provider) });
  }

  const currentProvider = params.current?.includes("/") ? params.current.split("/")[0] : undefined;
  const initialProvider: ProviderChoice = currentProvider && providers.some((provider) => provider.id === currentProvider) ? `provider:${currentProvider}` : params.current ? "current" : "unset";
  const providerChoice = await params.prompter.select<ProviderChoice>({
    message: "Choose model provider / account",
    options: providerOptions,
    initialValue: initialProvider,
  });
  if (providerChoice === "unset") return undefined;
  if (providerChoice === "current") return params.current;

  const providerId = providerChoice.replace(/^provider:/, "");
  const provider = providers.find((entry) => entry.id === providerId);
  if (provider?.authStatus && !provider.authStatus.configured) {
    await params.prompter.note(
      [
        `${provider.name} is not connected yet.`,
        `Supported setup: ${providerAuthMethod(provider.id)}.`,
      ].join("\n"),
      "Model account",
    );
    await maybeSetupProviderAuth({ prompter: params.prompter, provider, setupProviderAuth: params.setupProviderAuth });
  }

  const providerModels = allModels
    .filter((model) => model.provider === providerId)
    .sort((a, b) => favoriteModelScore(a) - favoriteModelScore(b) || a.id.localeCompare(b.id));
  if (providerModels.length === 0) return undefined;

  type ModelChoice = `model:${string}` | "current" | "custom" | "show_all";
  const toModelOption = (model: MindStoneModelInfo): MindStoneSelectOption<ModelChoice> => {
    const modelIdWithoutProvider = model.id.replace(`${providerId}/`, "");
    const meta = [
      model.contextWindowTokens ? `${model.contextWindowTokens.toLocaleString()} ctx` : undefined,
      model.maxOutputTokens ? `${model.maxOutputTokens.toLocaleString()} out` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    return { value: `model:${model.id}`, label: modelIdWithoutProvider, hint: meta || model.name };
  };

  const buildModelOptions = (models: MindStoneModelInfo[], all = false): Array<MindStoneSelectOption<ModelChoice>> => {
    const modelOptions: Array<MindStoneSelectOption<ModelChoice>> = [];
    if (params.current && !models.some((model) => model.id === params.current)) {
      modelOptions.push({ value: "current", label: `Keep current: ${params.current}` });
    }
    modelOptions.push(...models.map(toModelOption));
    if (!all && providerModels.length > models.length) {
      modelOptions.push({ value: "show_all", label: `Show all ${providerModels.length} ${provider?.name ?? providerId} models`, hint: "advanced" });
    }
    modelOptions.push({ value: "custom", label: "Enter model id manually", hint: "advanced" });
    return modelOptions;
  };

  const shortList = providerModels.length > 25 ? providerModels.slice(0, 20) : providerModels;
  let modelOptions = buildModelOptions(shortList, providerModels.length <= 25);
  let initialModel: ModelChoice = params.current && providerModels.some((model) => model.id === params.current) ? `model:${params.current}` : modelOptions[0].value;
  let modelChoice = await params.prompter.select<ModelChoice>({
    message: `Choose ${provider?.name ?? providerId} model`,
    options: modelOptions,
    initialValue: initialModel,
  });
  if (modelChoice === "show_all") {
    modelOptions = buildModelOptions(providerModels, true);
    initialModel = params.current && providerModels.some((model) => model.id === params.current) ? `model:${params.current}` : modelOptions[0].value;
    modelChoice = await params.prompter.select<ModelChoice>({
      message: `All ${provider?.name ?? providerId} models`,
      options: modelOptions,
      initialValue: initialModel,
    });
  }
  if (modelChoice === "current") return params.current;
  if (modelChoice === "custom") {
    const raw = await params.prompter.text({
      message: "Model id",
      placeholder: `${providerId}/model-id`,
      initialValue: params.current?.startsWith(`${providerId}/`) ? params.current : `${providerId}/`,
    });
    return trimOrUndefined(raw);
  }
  return modelChoice.replace(/^model:/, "");
}

async function configurePiSessionSafety(
  routing: MindStoneRoutingConfig,
  prompter: MindStonePrompter,
): Promise<MindStoneRoutingConfig> {
  const action = await prompter.select<"recommended" | "custom">({
    message: "Pi-session safety settings",
    options: [
      { value: "recommended", label: "Use recommended/current values", hint: "resume cap on; 20k reserve floor" },
      { value: "custom", label: "Customize safety settings", hint: "advanced" },
    ],
    initialValue: "recommended",
  });

  const currentResumeCap = routing.pi?.resumeCap;
  const currentCompaction = routing.pi?.compaction;
  if (action === "recommended") {
    return {
      ...routing,
      pi: {
        ...routing.pi,
        resumeCap: {
          enabled: currentResumeCap?.enabled ?? true,
          maxEntries: currentResumeCap?.maxEntries ?? 800,
          dropErrorTurns: currentResumeCap?.dropErrorTurns ?? true,
        },
        compaction: {
          ...currentCompaction,
          reserveTokensFloor: currentCompaction?.reserveTokensFloor ?? 20_000,
        },
      },
    };
  }

  const resumeCapEnabled = await prompter.select<"enabled" | "disabled">({
    message: "Pi-session resume cap",
    options: [
      { value: "enabled", label: "Enabled", hint: "recommended for long-running sessions" },
      { value: "disabled", label: "Disabled", hint: "advanced; may reload very large sessions" },
    ],
    initialValue: currentResumeCap?.enabled === false ? "disabled" : "enabled",
  });
  const maxEntries = asPositiveInteger(
    await prompter.text({ message: "Resume cap max message-emitting entries", placeholder: "800", initialValue: String(currentResumeCap?.maxEntries ?? 800) }),
    800,
  );
  const dropErrorTurns = await prompter.select<"enabled" | "disabled">({
    message: "Drop assistant error turns from resumed in-memory branch",
    options: [
      { value: "enabled", label: "Enabled", hint: "recommended" },
      { value: "disabled", label: "Disabled", hint: "preserve error turns in live resume context" },
    ],
    initialValue: currentResumeCap?.dropErrorTurns === false ? "disabled" : "enabled",
  });
  const reserveTokensFloor = asPositiveInteger(
    await prompter.text({ message: "Pi compaction reserve token floor", placeholder: "20000", initialValue: String(currentCompaction?.reserveTokensFloor ?? 20_000) }),
    20_000,
  );
  const safeguardFallback = await prompter.select<"enabled" | "disabled">({
    message: "Fallback-only compaction safeguard",
    options: [
      { value: "disabled", label: "Disabled", hint: "normal Pi behavior unless manually enabled" },
      { value: "enabled", label: "Enabled", hint: "preserve file/tool-failure context when no model auth is available" },
    ],
    initialValue: currentCompaction?.safeguardFallback === true ? "enabled" : "disabled",
  });

  return {
    ...routing,
    pi: {
      ...routing.pi,
      resumeCap: {
        enabled: resumeCapEnabled === "enabled",
        maxEntries,
        dropErrorTurns: dropErrorTurns === "enabled",
      },
      compaction: {
        ...currentCompaction,
        reserveTokensFloor,
        safeguardFallback: safeguardFallback === "enabled",
      },
    },
  };
}

async function configureOnboardingModel(
  config: MindStoneConfig,
  prompter: MindStonePrompter,
  options: MindStoneConfigWizardOptions = {},
): Promise<MindStoneConfig> {
  await prompter.note(
    [
      "MindStone needs a model before chat/TUI can produce real answers.",
      "The recommended path is a real model through isolated Pi AgentSession. That keeps Pi's harness behavior while storing credentials under this project's .runtime directory.",
      "If you use ChatGPT Plus/Pro, choose the OpenAI Codex provider when the provider list appears.",
    ].join("\n"),
    "Connect a model",
  );

  type ModelSetupChoice = "connect" | "mock" | "skip";
  const choice = await prompter.select<ModelSetupChoice>({
    message: "Do you want to connect a model now?",
    options: [
      { value: "connect", label: "Yes — choose provider and model", hint: "recommended; OpenAI/Codex, Claude, Gemini, OpenRouter, etc." },
      { value: "mock", label: "Use a local mock model for now", hint: "good for testing the UI, but not useful for real answers" },
      { value: "skip", label: "Skip model setup for now", hint: "MindStone will save transcripts but chat will not produce real model answers" },
    ],
    initialValue: config.routing?.mode === "mock" ? "mock" : config.routing?.mode === "pi-session" || config.routing?.mode === "pi" ? "connect" : "connect",
  });

  if (choice === "skip") return config;

  if (choice === "mock") {
    return {
      ...config,
      routing: {
        ...config.routing,
        mode: "mock",
        defaultAgentId: config.routing?.defaultAgentId ?? "default",
        defaultModel: config.routing?.defaultModel ?? "mindstone/mock",
        mock: { ...config.routing?.mock, responsePrefix: config.routing?.mock?.responsePrefix ?? "Mock response" },
      },
    };
  }

  const paths = runtimePathsFromEnv();
  const defaultModel = await choosePiModel({
    prompter,
    current: config.routing?.defaultModel,
    availableModels: options.availableModels,
    availableProviders: options.availableProviders,
    discoveryError: options.modelDiscoveryError,
    setupProviderAuth: options.setupProviderAuth,
  });

  if (!defaultModel) {
    await prompter.note(
      [
        "No model was selected, so MindStone will stay in transcript-only setup mode for now.",
        "Run `mindstone config --section routing` later to connect a model.",
      ].join("\n"),
      "Model setup skipped",
    );
    return config;
  }

  return {
    ...config,
    routing: {
      ...config.routing,
      mode: "pi-session",
      defaultAgentId: config.routing?.defaultAgentId ?? "default",
      defaultModel,
      pi: { ...config.routing?.pi, agentDir: config.routing?.pi?.agentDir ?? paths.piAgentDir },
    },
  };
}

async function configureRouting(
  config: MindStoneConfig,
  prompter: MindStonePrompter,
  options: MindStoneConfigWizardOptions = {},
): Promise<MindStoneConfig> {
  const paths = runtimePathsFromEnv();
  const routing = config.routing ?? {};
  let mode = await prompter.select<NonNullable<MindStoneRoutingConfig["mode"]>>({
    message: "How should MindStone answer messages?",
    options: [
      { value: "pi-session", label: "Connect a real model", hint: "recommended; choose OpenAI/Codex, Claude, Gemini, etc. through isolated Pi" },
      { value: "placeholder", label: "Not yet — save transcripts only", hint: "safe setup mode; no model calls" },
      { value: "mock", label: "Use a mock test model", hint: "deterministic local responses for testing the UI" },
      { value: "pi", label: "Advanced: raw Pi provider fallback", hint: "bypasses AgentSession; not recommended for normal use" },
    ],
    initialValue: routing.mode && routing.mode !== "placeholder" ? routing.mode : "pi-session",
  });

  const nextRouting: MindStoneRoutingConfig = {
    ...routing,
    mode,
    defaultAgentId: routing.defaultAgentId ?? "default",
  };

  if (mode === "placeholder") {
    nextRouting.defaultModel = undefined;
  }

  if (mode === "mock") {
    nextRouting.defaultModel = routing.defaultModel ?? "mindstone/mock";
    nextRouting.mock = { ...routing.mock, responsePrefix: routing.mock?.responsePrefix ?? "Mock response" };
  }

  if (mode === "pi" || mode === "pi-session") {
    nextRouting.pi = { ...routing.pi, agentDir: routing.pi?.agentDir ?? paths.piAgentDir };
    const selectedModel = await choosePiModel({
      prompter,
      current: routing.defaultModel,
      availableModels: options.availableModels,
      availableProviders: options.availableProviders,
      discoveryError: options.modelDiscoveryError,
      setupProviderAuth: options.setupProviderAuth,
    });
    if (selectedModel) {
      nextRouting.defaultModel = selectedModel;
    } else {
      await prompter.note(
        "No model was selected, so MindStone will stay in transcript-only setup mode for now.",
        "Model setup skipped",
      );
      mode = "placeholder";
      nextRouting.mode = "placeholder";
      nextRouting.defaultModel = undefined;
    }
  }

  const advanced = await prompter.select<"done" | "advanced">({
    message: "Model setup options",
    options: [
      { value: "done", label: "Done", hint: "use these model settings" },
      { value: "advanced", label: "Advanced options", hint: "agent id, Pi runtime path, mock label/prefix" },
    ],
    initialValue: "done",
  });

  if (advanced === "advanced") {
    nextRouting.defaultAgentId = await chooseString({
      prompter,
      message: "Default agent id",
      current: nextRouting.defaultAgentId ?? "default",
    });

    if (mode === "mock") {
      nextRouting.defaultModel = await chooseOptionalString({
        prompter,
        message: "Mock default model label",
        current: nextRouting.defaultModel,
        suggested: "mindstone/mock",
        suggestedLabel: "Use mindstone/mock",
      });
      const responsePrefix = await chooseString({
        prompter,
        message: "Mock response prefix",
        current: nextRouting.mock?.responsePrefix ?? "Mock response",
      });
      nextRouting.mock = { ...nextRouting.mock, responsePrefix };
    }

    if (mode === "pi" || mode === "pi-session") {
      const agentDir = await chooseString({
        prompter,
        message: "Isolated Pi runtime path",
        current: nextRouting.pi?.agentDir ?? paths.piAgentDir,
      });
      nextRouting.pi = { ...nextRouting.pi, agentDir };
    }

    if (mode === "pi-session") {
      Object.assign(nextRouting, await configurePiSessionSafety(nextRouting, prompter));
    }
  }

  return { ...config, routing: nextRouting };
}

async function configureContext(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  const current = resolveContextManagementPolicy(config.contextManagement);
  const mode = await prompter.select<ContextManagementMode>({
    message: "Context management mode",
    options: [
      { value: "sliding_window", label: "Sliding window", hint: "MindStone proper default; prune prompt window only" },
      { value: "auto_compact", label: "Auto compact", hint: "Pi/Claude-style checkpoint/handoff/compact" },
    ],
    initialValue: current.mode,
  });

  const preset = await prompter.select<"recommended" | "custom">({
    message: `${mode === "sliding_window" ? "Sliding-window" : "Auto-compact"} policy`,
    options: [
      { value: "recommended", label: "Use recommended/current values", hint: "recommended" },
      { value: "custom", label: "Customize policy numbers", hint: "advanced" },
    ],
    initialValue: "recommended",
  });

  if (mode === "auto_compact") {
    const currentAuto = current.mode === "auto_compact" ? current : undefined;
    if (preset === "recommended") {
      return {
        ...config,
        contextManagement: {
          mode,
          checkpointWarningPercent: currentAuto?.checkpointWarningPercent ?? 85,
          compactTargetPercent: currentAuto?.compactTargetPercent ?? 92,
          keepRecentTokens: currentAuto?.keepRecentTokens ?? 20_000,
          emergencyAutoHandoff: currentAuto?.emergencyAutoHandoff ?? false,
        },
      };
    }
    const checkpointWarningPercent = asPercent(
      await prompter.text({ message: "Checkpoint/handoff warning percent", placeholder: "85", initialValue: String(currentAuto?.checkpointWarningPercent ?? 85) }),
      85,
    );
    const compactTargetPercent = asPercent(
      await prompter.text({ message: "Auto compact target percent", placeholder: "92", initialValue: String(currentAuto?.compactTargetPercent ?? 92) }),
      92,
    );
    const keepRecentTokens = asPositiveInteger(
      await prompter.text({ message: "Keep recent tokens", placeholder: "20000", initialValue: String(currentAuto?.keepRecentTokens ?? 20_000) }),
      20_000,
    );
    return {
      ...config,
      contextManagement: {
        mode,
        checkpointWarningPercent,
        compactTargetPercent,
        keepRecentTokens,
        emergencyAutoHandoff: currentAuto?.emergencyAutoHandoff ?? false,
      },
    };
  }

  const currentSliding = current.mode === "sliding_window" ? current : undefined;
  if (preset === "recommended") {
    return {
      ...config,
      contextManagement: {
        mode,
        ceilingPercent: currentSliding?.ceilingPercent ?? 92,
        floorPercent: currentSliding?.floorPercent ?? 70,
        minRecentMessages: currentSliding?.minRecentMessages ?? 24,
        preserveTranscript: currentSliding?.preserveTranscript ?? true,
      },
    };
  }
  const ceilingPercent = asPercent(
    await prompter.text({ message: "Sliding-window ceiling percent", placeholder: "92", initialValue: String(currentSliding?.ceilingPercent ?? 92) }),
    92,
  );
  const floorPercent = asPercent(
    await prompter.text({ message: "Sliding-window floor percent", placeholder: "70", initialValue: String(currentSliding?.floorPercent ?? 70) }),
    70,
  );
  const minRecentMessages = asPositiveInteger(
    await prompter.text({ message: "Minimum recent messages", placeholder: "24", initialValue: String(currentSliding?.minRecentMessages ?? 24) }),
    24,
  );
  return {
    ...config,
    contextManagement: {
      mode,
      ceilingPercent,
      floorPercent: Math.min(floorPercent, ceilingPercent - 1),
      minRecentMessages,
      preserveTranscript: true,
    },
  };
}

async function chooseEmbeddingProvider(prompter: MindStonePrompter, current?: string): Promise<string | undefined> {
  type Choice = "unset" | "current" | "ollama" | "openai" | "openai-compatible" | "custom";
  const options: Array<MindStoneSelectOption<Choice>> = [
    { value: "unset", label: "None", hint: "memory can still use lexical/file recall" },
  ];
  if (current) options.push({ value: "current", label: `Keep current: ${current}` });
  options.push(
    { value: "ollama", label: "Ollama local", hint: "default local embeddings via /v1/embeddings" },
    { value: "openai-compatible", label: "OpenAI-compatible endpoint", hint: "uses EMBEDDER_BASE_URL / EMBEDDER_API_KEY" },
    { value: "openai", label: "OpenAI", hint: "uses OPENAI_API_KEY or EMBEDDER_API_KEY" },
    { value: "custom", label: "Custom provider spec", hint: "advanced, e.g. provider:model" },
  );

  const choice = await prompter.select<Choice>({
    message: "Embedding provider",
    options,
    initialValue: current ? "current" : "ollama",
  });

  if (choice === "unset") return undefined;
  if (choice === "current") return current;
  if (choice === "custom") {
    const value = await prompter.text({
      message: "Custom embedding provider spec",
      placeholder: current ?? "ollama:nomic-embed-text",
      initialValue: current ?? "ollama:nomic-embed-text",
    });
    return trimOrUndefined(value);
  }

  if (choice === "ollama") {
    const model = await prompter.select<"nomic-embed-text" | "mxbai-embed-large" | "custom">({
      message: "Ollama embedding model",
      options: [
        { value: "nomic-embed-text", label: "nomic-embed-text", hint: "recommended local default" },
        { value: "mxbai-embed-large", label: "mxbai-embed-large", hint: "common higher-capacity local option" },
        { value: "custom", label: "Custom Ollama model", hint: "manual" },
      ],
      initialValue: current?.startsWith("ollama:mxbai-embed-large") ? "mxbai-embed-large" : "nomic-embed-text",
    });
    if (model !== "custom") return `ollama:${model}`;
    const customModel = await prompter.text({ message: "Custom Ollama embedding model", placeholder: "nomic-embed-text", initialValue: "nomic-embed-text" });
    return `ollama:${trimOrUndefined(customModel) ?? "nomic-embed-text"}`;
  }

  if (choice === "openai") {
    const model = await prompter.select<"text-embedding-3-small" | "text-embedding-3-large" | "custom">({
      message: "OpenAI embedding model",
      options: [
        { value: "text-embedding-3-small", label: "text-embedding-3-small", hint: "smaller/faster" },
        { value: "text-embedding-3-large", label: "text-embedding-3-large", hint: "larger/higher quality" },
        { value: "custom", label: "Custom OpenAI model", hint: "manual" },
      ],
      initialValue: current?.startsWith("openai:text-embedding-3-large") ? "text-embedding-3-large" : "text-embedding-3-small",
    });
    if (model !== "custom") return `openai:${model}`;
    const customModel = await prompter.text({ message: "Custom OpenAI embedding model", placeholder: "text-embedding-3-small", initialValue: "text-embedding-3-small" });
    return `openai:${trimOrUndefined(customModel) ?? "text-embedding-3-small"}`;
  }

  const model = await prompter.text({
    message: "OpenAI-compatible embedding model",
    placeholder: "nomic-embed-text",
    initialValue: current?.includes(":") ? current.split(":").slice(1).join(":") : "nomic-embed-text",
  });
  return `openai-compatible:${trimOrUndefined(model) ?? "nomic-embed-text"}`;
}

async function configureMemory(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  const memory = config.memory ?? {};
  const autoRecall = await prompter.confirm({
    message: "Enable automatic memory recall in prompt assembly?",
    initialValue: memory.autoRecall ?? false,
  });
  const vectorStore = await prompter.select<"lancedb" | "sqlite-vec" | "memory">({
    message: "Vector store",
    options: [
      { value: "sqlite-vec", label: "sqlite-vec", hint: "simple local default" },
      { value: "lancedb", label: "LanceDB", hint: "MindStone lineage vector store" },
      { value: "memory", label: "Memory", hint: "ephemeral/testing only" },
    ],
    initialValue: memory.vectorStore ?? "sqlite-vec",
  });
  const embeddingProvider = await chooseEmbeddingProvider(prompter, memory.embeddingProvider);
  return { ...config, memory: { ...memory, autoRecall, vectorStore, embeddingProvider } };
}

async function configureIdentity(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  const currentDefault = config.routing?.defaultAgentId ?? "default";
  const id = await chooseString({ prompter, message: "Agent id", current: currentDefault });
  const currentAgent = config.agents?.[id] ?? { id };
  const identityPath = await chooseString({
    prompter,
    message: "Identity file path",
    current: currentAgent.identityPath ?? `agents/${id}/IDENTITY.md`,
  });
  const userPath = await chooseString({
    prompter,
    message: "User file path",
    current: currentAgent.userPath ?? `agents/${id}/USER.md`,
  });
  return {
    ...config,
    routing: { ...config.routing, defaultAgentId: id },
    agents: {
      ...config.agents,
      [id]: {
        ...currentAgent,
        id,
        identityPath,
        userPath,
      },
    },
  };
}

async function configureChannels(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  await prompter.note(formatMindStoneChannelCatalog(config), "Channel/plugin catalog");
  await prompter.note(
    [
      "Channel setup is diagnostic-only in this MVP step.",
      "The catalog lists local surfaces, Gateway APIs, planned external channel plugins, and honest validation state.",
      "No listeners are started, no networks are probed, no config is mutated, and no secrets are requested here.",
    ].join("\n"),
    "Channel setup status",
  );
  return config;
}

async function configureSection(
  section: MindStoneConfigWizardSection,
  config: MindStoneConfig,
  prompter: MindStonePrompter,
  options: MindStoneConfigWizardOptions = {},
): Promise<MindStoneConfig> {
  switch (section) {
    case "workspace":
      return configureWorkspace(config, prompter);
    case "gateway":
      return configureGateway(config, prompter);
    case "routing":
      return configureRouting(config, prompter, options);
    case "context":
      return configureContext(config, prompter);
    case "memory":
      return configureMemory(config, prompter);
    case "identity":
      return configureIdentity(config, prompter);
    case "channels":
      return configureChannels(config, prompter);
    case "all":
      return config;
  }
}

export async function runMindStoneConfigWizard(
  prompter: MindStonePrompter,
  options: MindStoneConfigWizardOptions = {},
): Promise<MindStoneConfigWizardResult> {
  const configPath = resolve(options.configPath ?? resolveConfigPath());
  const loaded = loadMindStoneConfig(configPath);
  if (loaded.error) throw new Error(`Cannot load MindStone config at ${configPath}: ${loaded.error}`);

  const before = loaded.config ?? {};
  let after: MindStoneConfig = { ...before };

  if (options.showIntro ?? true) {
    await prompter.intro?.("MindStone configuration");
  }
  if (options.showHeader ?? true) {
    await prompter.note(formatMindStoneConfigHeader(), "MindStone 🔶");
  }
  await prompter.note(formatConfigSummary(after), loaded.exists ? "Current config" : "No config found; starting from defaults");

  const selected = options.sections?.length
    ? options.sections
    : sectionList(
        await prompter.select({
          message: "Configuration section",
          options: SECTION_OPTIONS,
          initialValue: "all",
        }),
      );

  const changedSections: string[] = [];
  for (const section of selected) {
    if (section === "all") continue;
    const next = await configureSection(section, after, prompter, options);
    if (JSON.stringify(next) !== JSON.stringify(after)) changedSections.push(section);
    after = next;
  }

  const issues = validateMindStoneConfig(after);
  if (issues.length > 0) {
    await prompter.note(issues.map((issue) => `- ${issue}`).join("\n"), "Config validation failed");
    throw new Error("MindStone config validation failed");
  }

  await prompter.note(formatConfigChangeSummary(before, after), "Proposed config diff");
  await prompter.note(formatConfigSummary(after), "Proposed config summary");

  const shouldWrite = !options.dryRun && (await prompter.confirm({ message: `Write config to ${configPath}?`, initialValue: true }));
  if (shouldWrite) {
    writeMindStoneConfig(configPath, after);
    await prompter.outro?.(`MindStone config written: ${configPath}`);
  } else {
    await prompter.outro?.("MindStone config not written.");
  }

  return { path: configPath, wrote: shouldWrite, config: after, changedSections };
}

function markdownEscape(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function selectedProfileToLines(profile: MindStoneSelectedProfile | undefined): string[] {
  if (!profile) return ["Base profile: unset"];
  const definition = getBuiltInMindStoneProfile(profile.id);
  if (!definition) {
    return [
      `Base profile: ${profile.label}`,
      `Description: ${profile.customDescription ?? profile.description}`,
    ];
  }
  return [
    `Base profile: ${definition.label}`,
    `Description: ${definition.description}`,
    `Purpose seed: ${definition.purposeSeed}`,
    "Interaction bias:",
    ...definition.interactionBias.map((item) => `- ${item}`),
    "Memory priorities:",
    ...definition.memoryPriorities.map((item) => `- ${item}`),
    "Suggested skills/modules:",
    ...definition.suggestedSkills.map((item) => `- ${item}`),
    "Boundaries:",
    ...definition.boundaries.map((item) => `- ${item}`),
  ];
}

function applySelectedProfile(config: MindStoneConfig, profile: MindStoneSelectedProfile): MindStoneConfig {
  const defaultAgentId = config.routing?.defaultAgentId ?? "default";
  const currentAgent = config.agents?.[defaultAgentId];
  return {
    ...config,
    onboarding: {
      ...config.onboarding,
      profile,
    },
    agents: {
      ...config.agents,
      [defaultAgentId]: {
        id: defaultAgentId,
        ...currentAgent,
        profileId: profile.id,
      },
    },
  };
}

async function chooseOnboardingProfile(
  config: MindStoneConfig,
  prompter: MindStonePrompter,
): Promise<MindStoneSelectedProfile> {
  type ProfileChoice = BuiltInMindStoneProfileId | "custom";
  const currentProfile = config.onboarding?.profile;
  const initialValue: ProfileChoice = currentProfile && isBuiltInMindStoneProfileId(currentProfile.id)
    ? currentProfile.id
    : "general_companion";
  const choice = await prompter.select<ProfileChoice>({
    message: "Base profile",
    options: [
      ...BUILT_IN_MINDSTONE_PROFILES.map((profile) => ({
        value: profile.id,
        label: profile.label,
        hint: profile.description,
      })),
      { value: "custom", label: "Custom / Write-in", hint: "describe a custom role and collaboration shape" },
    ],
    initialValue,
  });

  if (choice !== "custom") {
    const profile = getBuiltInMindStoneProfile(choice);
    if (!profile) throw new Error(`Unknown built-in profile: ${choice}`);
    return {
      id: profile.id,
      label: profile.label,
      description: profile.description,
      selectedAt: new Date().toISOString(),
    };
  }

  const label = markdownEscape(
    await prompter.text({
      message: "Custom profile name",
      placeholder: currentProfile?.id === "custom" ? currentProfile.label : "Integration Research Partner",
      initialValue: currentProfile?.id === "custom" ? currentProfile.label : "",
    }),
  ) || "Custom Profile";
  const customDescription = markdownEscape(
    await prompter.text({
      message: "Custom profile description",
      placeholder: "what this agent should be especially good at, how it should work, and important boundaries",
      initialValue: currentProfile?.id === "custom" ? currentProfile.customDescription ?? currentProfile.description : "",
    }),
  );
  return {
    id: "custom",
    label,
    description: customDescription || "Custom user-defined MindStone profile.",
    customDescription: customDescription || undefined,
    selectedAt: new Date().toISOString(),
  };
}

function applyOnboardingPreferences(
  config: MindStoneConfig,
  preferences: MindStoneOnboardingPreferences,
): MindStoneConfig {
  return {
    ...config,
    onboarding: {
      ...config.onboarding,
      preferences,
    },
  };
}

function selectedPreferencesToLines(preferences: MindStoneOnboardingPreferences | undefined): string[] {
  if (!preferences) return ["Preferences: unset"];
  return [
    `Interaction detail: ${preferenceLabel(preferences.interactionDetail)}`,
    `Recommendation style: ${preferenceLabel(preferences.recommendationStyle)}`,
    `Work style: ${preferenceLabel(preferences.workStyle)}`,
    `Approval mode: ${preferenceLabel(preferences.approvalMode)}`,
    preferences.approvalNotes ? `Approval notes: ${preferences.approvalNotes}` : undefined,
    `Memory style: ${preferenceLabel(preferences.memoryStyle)}`,
    preferences.projectContext ? `Project/domain context: ${preferences.projectContext}` : undefined,
    preferences.sensitiveContext ? `Sensitive context / cautions: ${preferences.sensitiveContext}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

async function chooseOnboardingPreferences(
  config: MindStoneConfig,
  prompter: MindStonePrompter,
): Promise<MindStoneOnboardingPreferences> {
  const current = config.onboarding?.preferences;
  const interactionDetail = await prompter.select<MindStoneInteractionDetail>({
    message: "Interaction detail",
    options: [
      { value: "concise", label: "Concise", hint: "short answers unless more detail is requested" },
      { value: "balanced", label: "Balanced", hint: "default; enough context without overbuilding" },
      { value: "detailed", label: "Detailed", hint: "more explanation, rationale, and examples" },
    ],
    initialValue: current?.interactionDetail ?? "balanced",
  });

  const recommendationStyle = await prompter.select<MindStoneRecommendationStyle>({
    message: "Recommendation style",
    options: [
      { value: "direct", label: "Direct recommendations", hint: "say what you think when there is enough evidence" },
      { value: "options_tradeoffs", label: "Options + tradeoffs", hint: "present choices before recommending" },
      { value: "ask_first", label: "Ask before recommending", hint: "clarify more often before choosing a path" },
    ],
    initialValue: current?.recommendationStyle ?? "direct",
  });

  const workStyle = await prompter.select<MindStoneWorkStyle>({
    message: "Work style",
    options: [
      { value: "act_directly", label: "Act directly", hint: "when safe, inspect/edit/test without extra ceremony" },
      { value: "plan_first", label: "Plan first", hint: "outline approach before changing things" },
      { value: "ask_first", label: "Ask first", hint: "pause more often before taking action" },
    ],
    initialValue: current?.workStyle ?? "act_directly",
  });

  const approvalMode = await prompter.select<MindStoneApprovalMode>({
    message: "Approval boundaries",
    options: [
      { value: "standard", label: "Standard safety", hint: "confirm destructive/auth/git push/credential/memory changes" },
      { value: "strict", label: "Strict", hint: "ask before most file, network, or configuration changes" },
      { value: "custom", label: "Custom", hint: "write specific approval rules" },
    ],
    initialValue: current?.approvalMode ?? "standard",
  });
  const approvalNotes = approvalMode === "custom"
    ? markdownEscape(await prompter.text({
        message: "Custom approval rules",
        placeholder: current?.approvalNotes ?? "ask before changing files outside the project; never push without approval...",
        initialValue: current?.approvalNotes ?? "",
      }))
    : undefined;

  const memoryStyle = await prompter.select<MindStoneMemoryStyle>({
    message: "How should MindStone remember things?",
    options: [
      { value: "propose_checkpoint_memories", label: "Suggest memories at checkpoints", hint: "recommended; MindStone proposes what seems worth remembering and you approve it" },
      { value: "minimal", label: "Remember very little", hint: "only clearly durable project/user facts" },
      { value: "ask_each_time", label: "Ask before every memory", hint: "confirm before treating anything as memory-worthy" },
    ],
    initialValue: current?.memoryStyle ?? "propose_checkpoint_memories",
  });

  await prompter.note(
    [
      "The next prompt is a plain text field, not an arrow-key menu.",
      "Write one or two sentences about what you are using MindStone for right now.",
      "Examples:",
      "- Building a TypeScript agent framework with Pi and Gateway surfaces.",
      "- Personal research assistant for climate-policy papers; prefer concise summaries.",
      "- Security engineering work; do not change infrastructure without approval.",
      "You can leave it blank and add it later.",
    ].join("\n"),
    "Work context help",
  );
  const projectContext = markdownEscape(await prompter.text({
    message: "What are you working on? (optional)",
    placeholder: current?.projectContext ?? "one or two sentences about the project/domain and important constraints",
    initialValue: current?.projectContext ?? "",
  }));

  const sensitiveChoice = await prompter.select<"none" | "custom">({
    message: "Sensitive context or cautions",
    options: [
      { value: "none", label: "None for now", hint: "you can add this later" },
      { value: "custom", label: "Add sensitive cautions", hint: "private areas, disclosure limits, political/safety concerns" },
    ],
    initialValue: current?.sensitiveContext ? "custom" : "none",
  });
  const sensitiveContext = sensitiveChoice === "custom"
    ? markdownEscape(await prompter.text({
        message: "Sensitive context / cautions",
        placeholder: current?.sensitiveContext ?? "things the agent should be especially careful with...",
        initialValue: current?.sensitiveContext ?? "",
      }))
    : undefined;

  return {
    interactionDetail,
    recommendationStyle,
    workStyle,
    approvalMode,
    approvalNotes: approvalNotes || undefined,
    memoryStyle,
    projectContext: projectContext || undefined,
    sensitiveContext: sensitiveContext || undefined,
    selectedAt: new Date().toISOString(),
  };
}

function applyOnboardingIdentity(
  config: MindStoneConfig,
  identity: MindStoneOnboardingIdentity,
): MindStoneConfig {
  return {
    ...config,
    onboarding: {
      ...config.onboarding,
      identity,
    },
  };
}

function selectedIdentityToLines(identity: MindStoneOnboardingIdentity | undefined): string[] {
  if (!identity) return ["Identity emergence: unset"];
  return [
    `Identity emergence mode: ${preferenceLabel(identity.mode)}`,
    identity.candidateName ? `Candidate name: ${identity.candidateName}` : undefined,
    identity.identityDirection ? `Identity direction: ${identity.identityDirection}` : undefined,
    identity.namingNotes ? `Naming notes: ${identity.namingNotes}` : undefined,
    "Identity rule: do not pretend the identity is complete until first activation/collaboration makes it real.",
  ].filter((line): line is string => Boolean(line));
}

async function chooseOnboardingIdentity(
  config: MindStoneConfig,
  prompter: MindStonePrompter,
): Promise<MindStoneOnboardingIdentity> {
  const current = config.onboarding?.identity;
  const mode = await prompter.select<MindStoneIdentityEmergenceMode>({
    message: "Identity / naming approach",
    options: [
      { value: "defer", label: "Defer identity formation", hint: "recommended; agent forms identity on first activation" },
      { value: "seed", label: "Seed a candidate identity", hint: "capture a possible name/direction without finalizing it" },
      { value: "custom", label: "Custom identity direction", hint: "write identity/naming guidance" },
    ],
    initialValue: current?.mode ?? "defer",
  });

  if (mode === "defer") {
    return {
      mode,
      selectedAt: new Date().toISOString(),
    };
  }

  if (mode === "seed") {
    const candidateName = markdownEscape(await prompter.text({
      message: "Candidate name",
      placeholder: current?.candidateName ?? "leave blank if not known yet",
      initialValue: current?.candidateName ?? "",
    }));
    const identityDirection = markdownEscape(await prompter.text({
      message: "Candidate identity direction",
      placeholder: current?.identityDirection ?? "how this agent might describe its role, voice, or stance",
      initialValue: current?.identityDirection ?? "",
    }));
    const namingNotes = markdownEscape(await prompter.text({
      message: "Naming notes or style preferences",
      placeholder: current?.namingNotes ?? "optional: names to avoid/prefer, tone, symbols, lineage...",
      initialValue: current?.namingNotes ?? "",
    }));
    return {
      mode,
      candidateName: candidateName || undefined,
      identityDirection: identityDirection || undefined,
      namingNotes: namingNotes || undefined,
      selectedAt: new Date().toISOString(),
    };
  }

  const identityDirection = markdownEscape(await prompter.text({
    message: "Custom identity direction",
    placeholder: current?.identityDirection ?? "identity should emerge as... / should avoid... / should emphasize...",
    initialValue: current?.identityDirection ?? "",
  }));
  const namingNotes = markdownEscape(await prompter.text({
    message: "Naming notes or style preferences",
    placeholder: current?.namingNotes ?? "optional: names to avoid/prefer, tone, symbols, lineage...",
    initialValue: current?.namingNotes ?? "",
  }));
  return {
    mode,
    identityDirection: identityDirection || undefined,
    namingNotes: namingNotes || undefined,
    selectedAt: new Date().toISOString(),
  };
}

function resolveOnboardingAgentPaths(config: MindStoneConfig, configPath: string): {
  agentId: string;
  identityPath: string;
  userPath: string;
} {
  const agentId = config.routing?.defaultAgentId ?? "default";
  const agent = config.agents?.[agentId];
  return {
    agentId,
    identityPath: resolvePathRelativeToConfig(agent?.identityPath ?? `agents/${agentId}/IDENTITY.md`, configPath),
    userPath: resolvePathRelativeToConfig(agent?.userPath ?? `agents/${agentId}/USER.md`, configPath),
  };
}

function writeIfMissing(path: string, body: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${body.trimEnd()}\n`, "utf-8");
  return true;
}

async function createOnboardingIdentityFiles(params: {
  prompter: MindStonePrompter;
  config: MindStoneConfig;
  configPath: string;
}): Promise<Pick<MindStoneOnboardingResult, "identityPath" | "userPath" | "identityCreated" | "userCreated">> {
  const paths = resolveOnboardingAgentPaths(params.config, params.configPath);
  const identityExists = existsSync(paths.identityPath);
  const userExists = existsSync(paths.userPath);

  if (identityExists && userExists) {
    await params.prompter.note(
      [`Identity already exists: ${paths.identityPath}`, `User context already exists: ${paths.userPath}`, "No identity/user files were overwritten."].join("\n"),
      "Identity scaffold",
    );
    return { identityPath: paths.identityPath, userPath: paths.userPath, identityCreated: false, userCreated: false };
  }

  await params.prompter.note(
    [
      "MindStone does not ask the human to name the agent or define its whole identity up front.",
      "Onboarding writes a minimal scaffold and a user/project seed.",
      "The agent should develop its identity through first activation and collaboration.",
    ].join("\n"),
    "Identity model",
  );

  const profile = params.config.onboarding?.profile;
  const profileDefinition = getBuiltInMindStoneProfile(profile?.id);
  const profileLines = selectedProfileToLines(profile);
  const preferenceLines = selectedPreferencesToLines(params.config.onboarding?.preferences);
  const identityLines = selectedIdentityToLines(params.config.onboarding?.identity);
  await params.prompter.note(profileLines.join("\n"), "Selected profile seed");
  await params.prompter.note(preferenceLines.join("\n"), "User preference seed");
  await params.prompter.note(identityLines.join("\n"), "Identity emergence seed");

  await params.prompter.note(
    [
      "The next two text prompts seed the first IDENTITY.md and USER.md files.",
      "Keep them short. You can edit the files later.",
      "If you are not sure, write the immediate job you want the agent to help with first.",
    ].join("\n"),
    "First activation seed",
  );
  const purpose = markdownEscape(
    await params.prompter.text({
      message: `First job for this ${profile?.label ?? "MindStone agent"} (optional)`,
      placeholder: profileDefinition?.purposeSeed ?? "example: help build a TypeScript agent framework on Pi",
    }),
  );
  const userContext = markdownEscape(
    await params.prompter.text({
      message: "Anything important it should know before the first chat? (optional)",
      placeholder: "example: prefer direct answers; ask before destructive changes; current project is...",
    }),
  );

  const now = new Date().toISOString();
  const identityBody = `# MindStone Agent Identity Pending

This identity scaffold was created by \`mindstone onboard\` on ${now}.

The agent has not yet established a durable name, voice, or self-description. On first activation, it should read the user context, understand the requested purpose, and collaboratively form its own identity rather than pretending a complete identity already exists.

## Base profile seed

${profileLines.join("\n")}

## Preference seed

${preferenceLines.join("\n")}

## Identity emergence seed

${identityLines.join("\n")}

## Purpose seed

${purpose || profileDefinition?.purposeSeed || profile?.description || "No purpose seed provided."}

## Operating notes

- Be honest about uncertainty.
- Do not overclaim unverified work.
- Protect user files, credentials, and memory.
- Prefer durable continuity over performative personality.
- Treat any candidate name or direction as a seed, not a completed identity, until first activation and collaboration make it real.
`;

  const userBody = `# User Context

This user/project context scaffold was created by \`mindstone onboard\` on ${now}.

## Base profile

${profileLines.join("\n")}

## Interaction and operating preferences

${preferenceLines.join("\n")}

## Identity emergence

${identityLines.join("\n")}

## Initial purpose

${purpose || profileDefinition?.purposeSeed || profile?.description || "No initial purpose provided."}

## Initial context

${userContext || "No initial context provided."}

## Collaboration defaults

- Ask before destructive filesystem, git, database, credential, or memory operations.
- State what was verified versus inferred.
- Preserve useful context in memory/checkpoints when appropriate.
`;

  const identityCreated = writeIfMissing(paths.identityPath, identityBody);
  const userCreated = writeIfMissing(paths.userPath, userBody);
  await params.prompter.note(
    [
      `${identityCreated ? "Created" : "Kept existing"}: ${paths.identityPath}`,
      `${userCreated ? "Created" : "Kept existing"}: ${paths.userPath}`,
    ].join("\n"),
    "Identity scaffold",
  );

  return { identityPath: paths.identityPath, userPath: paths.userPath, identityCreated, userCreated };
}

export async function runMindStoneOnboardingWizard(
  prompter: MindStonePrompter,
  options: MindStoneConfigWizardOptions = {},
): Promise<MindStoneOnboardingResult> {
  const runtimePaths = runtimePathsFromEnv();
  const configPath = resolve(options.configPath ?? resolveConfigPath());
  await prompter.intro?.("MindStone onboarding");
  if (options.showHeader ?? true) {
    await prompter.note(formatMindStoneConfigHeader(), "MindStone 🔶");
  }
  await prompter.note(
    [
      "MindStone is powerful agent infrastructure. It can read files, call tools, and eventually run through channels and Gateway surfaces.",
      "Use least privilege. Keep secrets out of reachable context where possible. Do not expose Gateway or channel surfaces without auth and pairing/allowlist controls.",
    ].join("\n"),
    "Security / risk acknowledgement",
  );
  const accepted = await prompter.confirm({
    message: "I understand this is powerful and inherently risky. Continue onboarding?",
    initialValue: false,
  });
  if (!accepted) throw new Error("Onboarding cancelled: risk not accepted");

  await prompter.note(
    [
      `Root: ${runtimePaths.root}`,
      `Runtime dir: ${runtimePaths.runtimeDir}`,
      `Pi agent dir: ${runtimePaths.piAgentDir}`,
      `Pi session dir: ${runtimePaths.piSessionDir}`,
      `Data dir: ${runtimePaths.dataDir}`,
      "This runtime is project-local and must not share global ~/.pi/agent state.",
    ].join("\n"),
    "Runtime isolation",
  );

  await prompter.note(
    [
      "Onboarding will walk through four things:",
      "1. What kind of agent you want.",
      "2. How you prefer it to work with you.",
      "3. Whether to connect a model/account now.",
      "4. A first identity/user-context scaffold.",
      "Arrow-key menus are choices. Text prompts are optional notes you can leave blank unless marked otherwise.",
    ].join("\n"),
    "Onboarding workflow",
  );

  const loadedForProfile = loadMindStoneConfig(configPath);
  if (loadedForProfile.error) throw new Error(`Cannot load MindStone config at ${configPath}: ${loadedForProfile.error}`);
  const selectedProfile = await chooseOnboardingProfile(loadedForProfile.config ?? {}, prompter);
  const selectedPreferences = await chooseOnboardingPreferences(loadedForProfile.config ?? {}, prompter);
  const selectedIdentity = await chooseOnboardingIdentity(loadedForProfile.config ?? {}, prompter);

  const mode =
    options.onboardingMode ??
    (await prompter.select<MindStoneOnboardingMode>({
      message: "Setup depth",
      options: [
        { value: "quickstart", label: "Recommended setup", hint: "safe defaults, model connection, then identity/user seed" },
        { value: "manual", label: "Advanced setup", hint: "edit workspace, Gateway, model routing, context, memory, identity paths, and channels" },
      ],
      initialValue: "quickstart",
    }));

  let configResult: MindStoneConfigWizardResult;
  if (mode === "quickstart") {
    const loaded = loadMindStoneConfig(configPath);
    if (loaded.error) throw new Error(`Cannot load MindStone config at ${configPath}: ${loaded.error}`);
    const before = loaded.config ?? {};
    const defaulted = withDefaultOnboardingConfig(
      applyOnboardingIdentity(applyOnboardingPreferences(applySelectedProfile(before, selectedProfile), selectedPreferences), selectedIdentity),
    );
    const after = await configureOnboardingModel(defaulted, prompter, options);
    await prompter.note(formatConfigSummary(after), loaded.exists ? "QuickStart existing/defaulted config" : "QuickStart config");
    const issues = validateMindStoneConfig(after);
    if (issues.length > 0) {
      await prompter.note(issues.map((issue) => `- ${issue}`).join("\n"), "Config validation failed");
      throw new Error("MindStone config validation failed");
    }
    const shouldWrite = !options.dryRun && (await prompter.confirm({ message: `Write QuickStart config to ${configPath}?`, initialValue: true }));
    if (shouldWrite) writeMindStoneConfig(configPath, after);
    configResult = {
      path: configPath,
      wrote: shouldWrite,
      config: after,
      changedSections: JSON.stringify(before) === JSON.stringify(after) ? [] : ["quickstart"],
    };
  } else {
    await prompter.note(
      [
        "Manual setup walks each core section.",
        "Most prompts have a safe default. Use arrow keys for choices; text entry appears only when a custom value is needed.",
      ].join("\n"),
      "Manual setup",
    );
    configResult = await runMindStoneConfigWizard(prompter, {
      ...options,
      configPath,
      showHeader: false,
      showIntro: false,
      sections: ["workspace", "gateway", "routing", "context", "memory", "identity", "channels"],
    });
    const profiledConfig = applyOnboardingIdentity(
      applyOnboardingPreferences(applySelectedProfile(configResult.config, selectedProfile), selectedPreferences),
      selectedIdentity,
    );
    const issues = validateMindStoneConfig(profiledConfig);
    if (issues.length > 0) {
      await prompter.note(issues.map((issue) => `- ${issue}`).join("\n"), "Config validation failed");
      throw new Error("MindStone config validation failed");
    }
    if (configResult.wrote && !options.dryRun) writeMindStoneConfig(configResult.path, profiledConfig);
    configResult = {
      ...configResult,
      config: profiledConfig,
      changedSections: configResult.changedSections.includes("profile")
        ? configResult.changedSections
        : [...configResult.changedSections, "profile"],
    };
  }

  const identityResult = configResult.wrote
    ? await createOnboardingIdentityFiles({ prompter, config: configResult.config, configPath: configResult.path })
    : { identityPath: undefined, userPath: undefined, identityCreated: false, userCreated: false };

  await prompter.outro?.(
    [
      "MindStone onboarding complete.",
      "Next useful commands:",
      "  mindstone status",
      "  mindstone config",
      "  mindstone gateway start",
    ].join("\n"),
  );

  return { ...configResult, ...identityResult };
}
