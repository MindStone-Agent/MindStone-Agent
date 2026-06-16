import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveContextManagementPolicy, type ContextManagementMode } from "../context/index.js";
import { runtimePathsFromEnv } from "../paths/runtime.js";
import { loadMindStoneConfig, resolveConfigPath, resolvePathRelativeToConfig } from "../config/load.js";
import type { GatewayAuthConfig, MindStoneConfig, MindStoneRoutingConfig } from "../config/types.js";
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

async function configureGateway(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  const gateway = config.gateway ?? {};
  const host = await prompter.text({
    message: "Gateway host",
    placeholder: "127.0.0.1",
    initialValue: gateway.host ?? "127.0.0.1",
  });
  const portRaw = await prompter.text({
    message: "Gateway port",
    placeholder: "19789",
    initialValue: String(gateway.port ?? 19789),
  });
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
    const tokenEnv = await prompter.text({
      message: "Token environment variable",
      placeholder: "MINDSTONE_GATEWAY_TOKEN",
      initialValue: gateway.auth?.mode === "token" ? gateway.auth.tokenEnv ?? "MINDSTONE_GATEWAY_TOKEN" : "MINDSTONE_GATEWAY_TOKEN",
    });
    auth = { mode: "token", tokenEnv: tokenEnv.trim() || "MINDSTONE_GATEWAY_TOKEN" };
  } else if (authMode === "password") {
    const passwordEnv = await prompter.text({
      message: "Password environment variable",
      placeholder: "MINDSTONE_GATEWAY_PASSWORD",
      initialValue: gateway.auth?.mode === "password" ? gateway.auth.passwordEnv ?? "MINDSTONE_GATEWAY_PASSWORD" : "MINDSTONE_GATEWAY_PASSWORD",
    });
    auth = { mode: "password", passwordEnv: passwordEnv.trim() || "MINDSTONE_GATEWAY_PASSWORD" };
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
      host: host.trim() || "127.0.0.1",
      port: asPositivePort(portRaw, gateway.port ?? 19789),
      auth,
      http: {
        ...gateway.http,
        chatCompletions: { ...gateway.http?.chatCompletions, enabled: chatCompletions },
        responses: { ...gateway.http?.responses, enabled: responses },
      },
    },
  };
}

async function configureRouting(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  const paths = runtimePathsFromEnv();
  const routing = config.routing ?? {};
  const mode = await prompter.select<NonNullable<MindStoneRoutingConfig["mode"]>>({
    message: "Routing/provider mode",
    options: [
      { value: "placeholder", label: "Placeholder", hint: "safe transcript-aware not-implemented behavior" },
      { value: "mock", label: "Mock", hint: "deterministic local provider for smoke tests" },
      { value: "pi", label: "Pi", hint: "isolated vendored Pi provider adapter" },
    ],
    initialValue: routing.mode ?? "placeholder",
  });
  const defaultAgentId = await prompter.text({
    message: "Default agent id",
    placeholder: "default",
    initialValue: routing.defaultAgentId ?? "default",
  });
  const defaultModel = trimOrUndefined(
    await prompter.text({
      message: "Default model (blank to leave unset)",
      placeholder: "openai-codex/gpt-5.5",
      initialValue: routing.defaultModel ?? "",
    }),
  );

  const nextRouting: MindStoneRoutingConfig = {
    ...routing,
    mode,
    defaultAgentId: defaultAgentId.trim() || "default",
    defaultModel,
  };

  if (mode === "mock") {
    const responsePrefix = await prompter.text({
      message: "Mock response prefix",
      placeholder: "Mock response",
      initialValue: routing.mock?.responsePrefix ?? "Mock response",
    });
    nextRouting.mock = { ...routing.mock, responsePrefix: responsePrefix.trim() || "Mock response" };
  }

  if (mode === "pi") {
    const agentDir = await prompter.text({
      message: "Isolated Pi agent dir",
      placeholder: paths.piAgentDir,
      initialValue: routing.pi?.agentDir ?? paths.piAgentDir,
    });
    nextRouting.pi = { ...routing.pi, agentDir: agentDir.trim() || paths.piAgentDir };
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

  if (mode === "auto_compact") {
    const checkpointWarningPercent = asPercent(
      await prompter.text({ message: "Checkpoint/handoff warning percent", placeholder: "85", initialValue: String(current.mode === "auto_compact" ? current.checkpointWarningPercent : 85) }),
      85,
    );
    const compactTargetPercent = asPercent(
      await prompter.text({ message: "Auto compact target percent", placeholder: "92", initialValue: String(current.mode === "auto_compact" ? current.compactTargetPercent : 92) }),
      92,
    );
    const keepRecentTokens = asPositiveInteger(
      await prompter.text({ message: "Keep recent tokens", placeholder: "20000", initialValue: String(current.mode === "auto_compact" ? current.keepRecentTokens : 20_000) }),
      20_000,
    );
    return {
      ...config,
      contextManagement: {
        mode,
        checkpointWarningPercent,
        compactTargetPercent,
        keepRecentTokens,
        emergencyAutoHandoff: false,
      },
    };
  }

  const ceilingPercent = asPercent(
    await prompter.text({ message: "Sliding-window ceiling percent", placeholder: "92", initialValue: String(current.mode === "sliding_window" ? current.ceilingPercent : 92) }),
    92,
  );
  const floorPercent = asPercent(
    await prompter.text({ message: "Sliding-window floor percent", placeholder: "70", initialValue: String(current.mode === "sliding_window" ? current.floorPercent : 70) }),
    70,
  );
  const minRecentMessages = asPositiveInteger(
    await prompter.text({ message: "Minimum recent messages", placeholder: "24", initialValue: String(current.mode === "sliding_window" ? current.minRecentMessages : 24) }),
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
  const embeddingProvider = trimOrUndefined(
    await prompter.text({
      message: "Embedding provider (blank to leave unset)",
      placeholder: "ollama:nomic-embed-text",
      initialValue: memory.embeddingProvider ?? "",
    }),
  );
  return { ...config, memory: { ...memory, autoRecall, vectorStore, embeddingProvider } };
}

async function configureIdentity(config: MindStoneConfig, prompter: MindStonePrompter): Promise<MindStoneConfig> {
  const currentDefault = config.routing?.defaultAgentId ?? "default";
  const id = (await prompter.text({ message: "Agent id", placeholder: "default", initialValue: currentDefault })).trim() || "default";
  const currentAgent = config.agents?.[id] ?? { id };
  const identityPath = await prompter.text({
    message: "Identity file path",
    placeholder: `agents/${id}/IDENTITY.md`,
    initialValue: currentAgent.identityPath ?? `agents/${id}/IDENTITY.md`,
  });
  const userPath = await prompter.text({
    message: "User file path",
    placeholder: `agents/${id}/USER.md`,
    initialValue: currentAgent.userPath ?? `agents/${id}/USER.md`,
  });
  return {
    ...config,
    routing: { ...config.routing, defaultAgentId: id },
    agents: {
      ...config.agents,
      [id]: {
        ...currentAgent,
        id,
        identityPath: identityPath.trim() || `agents/${id}/IDENTITY.md`,
        userPath: userPath.trim() || `agents/${id}/USER.md`,
      },
    },
  };
}

async function configureSection(
  section: MindStoneConfigWizardSection,
  config: MindStoneConfig,
  prompter: MindStonePrompter,
): Promise<MindStoneConfig> {
  switch (section) {
    case "workspace":
      return configureWorkspace(config, prompter);
    case "gateway":
      return configureGateway(config, prompter);
    case "routing":
      return configureRouting(config, prompter);
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
    const next = await configureSection(section, after, prompter);
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
