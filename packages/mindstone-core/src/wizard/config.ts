import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveContextManagementPolicy, type ContextManagementMode } from "../context/index.js";
import { runtimePathsFromEnv } from "../paths/runtime.js";
import { loadMindStoneConfig, resolveConfigPath, resolvePathRelativeToConfig } from "../config/load.js";
import type { GatewayAuthConfig, MindStoneConfig, MindStoneRoutingConfig } from "../config/types.js";
import type { MindStoneModelInfo, MindStoneProviderInfo } from "../provider/index.js";
import type { MindStonePrompter, MindStoneSelectOption } from "./prompter.js";

export type MindStoneConfigWizardSection =
  | "all"
  | "workspace"
  | "gateway"
  | "routing"
  | "context"
  | "memory"
  | "identity";

export type MindStoneOnboardingMode = "quickstart" | "manual";

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
  { value: "all", label: "All core sections", hint: "workspace, gateway, routing, context, memory, identity" },
  { value: "workspace", label: "Workspace", hint: "project root / working directory" },
  { value: "gateway", label: "Gateway", hint: "host, port, auth, HTTP surfaces" },
  { value: "routing", label: "Routing / provider", hint: "placeholder, mock, or isolated Pi provider" },
  { value: "context", label: "Context management", hint: "sliding-window or auto-compact policy" },
  { value: "memory", label: "Memory", hint: "autoRecall, vector store, embedding provider" },
  { value: "identity", label: "Identity / user", hint: "default agent identity and user paths" },
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
  if (selection === "all") return ["workspace", "gateway", "routing", "context", "memory", "identity"];
  return [selection];
}

function stableJson(config: MindStoneConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function formatMindStoneConfigHeader(): string {
  return TITLE;
}

export function formatConfigSummary(config: MindStoneConfig): string {
  const auth = config.gateway?.auth?.mode ?? "none";
  const routing = config.routing?.mode ?? "placeholder";
  const context = resolveContextManagementPolicy(config.contextManagement);
  const defaultAgent = config.routing?.defaultAgentId ?? "default";
  return [
    `workspace.root: ${config.workspace?.root ?? "."}`,
    `gateway: ${config.gateway?.host ?? "127.0.0.1"}:${config.gateway?.port ?? 19789} auth=${auth}`,
    `gateway.http.chatCompletions: ${config.gateway?.http?.chatCompletions?.enabled ?? false}`,
    `gateway.http.responses: ${config.gateway?.http?.responses?.enabled ?? false}`,
    `routing.mode: ${routing}`,
    `routing.defaultAgentId: ${defaultAgent}`,
    `routing.defaultModel: ${config.routing?.defaultModel ?? config.agents?.[defaultAgent]?.defaultModel ?? "unset"}`,
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
  if (routingMode && !["placeholder", "mock", "pi"].includes(routingMode)) {
    issues.push("routing.mode must be placeholder, mock, or pi");
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
    memory: {
      autoRecall: false,
      vectorStore: "sqlite-vec",
      ...config.memory,
    },
    agents: {
      ...config.agents,
      [defaultAgentId]: {
        id: defaultAgentId,
        identityPath: `agents/${defaultAgentId}/IDENTITY.md`,
        userPath: `agents/${defaultAgentId}/USER.md`,
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

async function choosePiModel(params: {
  prompter: MindStonePrompter;
  current?: string;
  availableModels?: MindStoneModelInfo[];
  availableProviders?: MindStoneProviderInfo[];
  discoveryError?: string;
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
        "Use the isolated Pi runtime to login or configure API keys, then rerun this wizard.",
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
    message: "Provider",
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
        `${provider.name} is not configured in this isolated runtime.`,
        "Use isolated Pi /login for subscription providers, or store an API key in the isolated auth file/env before live calls.",
        "You can still select a model now; live calls will fail until auth is configured.",
      ].join("\n"),
      "Provider auth",
    );
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
    message: `${provider?.name ?? providerId} model`,
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

async function configureRouting(
  config: MindStoneConfig,
  prompter: MindStonePrompter,
  options: MindStoneConfigWizardOptions = {},
): Promise<MindStoneConfig> {
  const paths = runtimePathsFromEnv();
  const routing = config.routing ?? {};
  const mode = await prompter.select<NonNullable<MindStoneRoutingConfig["mode"]>>({
    message: "Provider mode",
    options: [
      { value: "placeholder", label: "No model yet", hint: "safe setup mode; record transcripts only" },
      { value: "mock", label: "Mock test model", hint: "deterministic local responses for testing" },
      { value: "pi", label: "Pi model", hint: "choose from isolated Pi models" },
    ],
    initialValue: routing.mode ?? "placeholder",
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

  if (mode === "pi") {
    nextRouting.pi = { ...routing.pi, agentDir: routing.pi?.agentDir ?? paths.piAgentDir };
    nextRouting.defaultModel = await choosePiModel({
      prompter,
      current: routing.defaultModel,
      availableModels: options.availableModels,
      availableProviders: options.availableProviders,
      discoveryError: options.modelDiscoveryError,
    });
  }

  const advanced = await prompter.select<"done" | "advanced">({
    message: "Routing setup",
    options: [
      { value: "done", label: "Done", hint: "use these routing settings" },
      { value: "advanced", label: "Advanced routing options", hint: "agent id, Pi runtime path, mock label/prefix" },
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

    if (mode === "pi") {
      const agentDir = await chooseString({
        prompter,
        message: "Isolated Pi runtime path",
        current: nextRouting.pi?.agentDir ?? paths.piAgentDir,
      });
      nextRouting.pi = { ...nextRouting.pi, agentDir };
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
  const embeddingProvider = await chooseOptionalString({
    prompter,
    message: "Embedding provider",
    current: memory.embeddingProvider,
    suggested: "ollama:nomic-embed-text",
    suggestedLabel: "Use Ollama / nomic-embed-text",
  });
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

  const purpose = markdownEscape(
    await params.prompter.text({
      message: "What should this MindStone agent help with?",
      placeholder: "software engineering, research, operations, personal assistant...",
    }),
  );
  const userContext = markdownEscape(
    await params.prompter.text({
      message: "Important user/project context for first activation",
      placeholder: "preferences, boundaries, project facts, collaboration style...",
    }),
  );

  const now = new Date().toISOString();
  const identityBody = `# MindStone Agent Identity Pending

This identity scaffold was created by \`mindstone onboard\` on ${now}.

The agent has not yet established a durable name, voice, or self-description. On first activation, it should read the user context, understand the requested purpose, and collaboratively form its own identity rather than pretending a complete identity already exists.

## Purpose seed

${purpose || "No purpose seed provided."}

## Operating notes

- Be honest about uncertainty.
- Do not overclaim unverified work.
- Protect user files, credentials, and memory.
- Prefer durable continuity over performative personality.
`;

  const userBody = `# User Context

This user/project context scaffold was created by \`mindstone onboard\` on ${now}.

## Initial purpose

${purpose || "No initial purpose provided."}

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

  const mode =
    options.onboardingMode ??
    (await prompter.select<MindStoneOnboardingMode>({
      message: "Onboarding mode",
      options: [
        { value: "quickstart", label: "QuickStart", hint: "safe local defaults; only ask identity/user seed" },
        { value: "manual", label: "Manual", hint: "configure workspace, gateway, routing, context, memory, and identity paths" },
      ],
      initialValue: "quickstart",
    }));

  let configResult: MindStoneConfigWizardResult;
  if (mode === "quickstart") {
    const loaded = loadMindStoneConfig(configPath);
    if (loaded.error) throw new Error(`Cannot load MindStone config at ${configPath}: ${loaded.error}`);
    const before = loaded.config ?? {};
    const after = withDefaultOnboardingConfig(before);
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
      sections: ["workspace", "gateway", "routing", "context", "memory", "identity"],
    });
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
