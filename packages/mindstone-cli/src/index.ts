#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  backfillSqliteMemoryEmbeddings,
  backfillSqliteMemoryIndex,
  formatConfigSummary,
  formatMindStoneConfigHeader,
  getCurrentHandoffStatus,
  getMindStoneDoctorReport,
  getMindStoneSystemStatus,
  getSqliteMemoryIndexStats,
  loadMindStoneConfig,
  probeMemoryEmbeddingProvider,
  resolveConfigPath,
  resolveConfiguredSessionKey,
  resolveMindStoneChatModel,
  runMindStoneChatTurn,
  runMindStoneConfigWizard,
  runMindStoneOnboardingWizard,
  runtimePathsFromEnv,
  type AgentRunner,
  type MindStoneDoctorReport,
  type MindStoneModelInfo,
  type MindStoneProviderAuthSetupRequest,
  type MindStoneProviderInfo,
  type MindStonePrompter,
  type MindStoneSelectOption,
} from "@mindstone-agent/core";
import { MockMindStoneProvider, PiMindStoneProvider, PiSessionAgentRunner, PiSessionMindStoneProvider } from "@mindstone-agent/gateway";
import { runTuiCommand } from "./tui.js";

type Command = "chat" | "tui" | "config" | "onboard" | "status" | "doctor" | "memory" | "help";

const gold = (text: string) => `\x1b[38;5;214m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

function usage(): string {
  return [
    gold("🔶 MindStone-Agent"),
    "",
    "Usage:",
    "  mindstone chat         Start native terminal chat over the canonical MindStone session",
    "  mindstone chat --once \"message\"  Send one chat turn and print the assistant response",
    "  mindstone tui          Start styled MindStone-Agent TUI over the canonical MindStone session",
    "  mindstone config       Configure MindStone-Agent runtime settings",
    "  mindstone onboard      First-run onboarding with risk notice, config, and identity/user scaffold",
    "  mindstone status       Show isolated runtime/config status",
    "  mindstone doctor       Check runtime, config, identity, memory, routing, and provider discovery",
    "  mindstone memory backfill [--embed] [--force]  Index file memory/transcripts and optionally embed chunks",
    "  mindstone memory status    Show SQLite memory DB status",
    "  mindstone help         Show this help",
    "",
    "Environment:",
    "  MINDSTONE_AGENT_ROOT        Project/root directory",
    "  MINDSTONE_AGENT_CONFIG      Override config path",
    "  MINDSTONE_AGENT_DATA_DIR    Runtime data directory",
  ].join("\n");
}

function parseCommand(argv: string[]): Command {
  const raw = argv[2] ?? "help";
  if (raw === "--help" || raw === "-h") return "help";
  if (raw === "chat" || raw === "tui" || raw === "config" || raw === "onboard" || raw === "status" || raw === "doctor" || raw === "memory" || raw === "help") return raw;
  throw new Error(`Unknown command: ${raw}\n\n${usage()}`);
}

function arrowOptionLines<T extends string>(
  options: Array<MindStoneSelectOption<T>>,
  selectedIndex: number,
): string[] {
  return options.map((option, index) => {
    const selected = index === selectedIndex;
    const pointer = selected ? gold("◆") : " ";
    const label = selected ? bold(gold(option.label)) : option.label;
    const hint = option.hint ? dim(` — ${option.hint}`) : "";
    return ` ${pointer} ${label}${hint}`;
  });
}

function selectWithArrows<T extends string>(params: {
  message: string;
  options: Array<MindStoneSelectOption<T>>;
  initialValue?: T;
}): Promise<T> {
  if (!input.isTTY || !output.isTTY) {
    return Promise.resolve(
      params.options.find((option) => option.value === params.initialValue)?.value ?? params.options[0].value,
    );
  }

  let selectedIndex = Math.max(
    0,
    params.initialValue ? params.options.findIndex((option) => option.value === params.initialValue) : 0,
  );
  if (selectedIndex < 0) selectedIndex = 0;
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) output.write(`\x1b[${renderedLines}A\x1b[0J`);
    const lines = [
      bold(params.message),
      dim("Use ↑/↓ arrows, Enter to select, Ctrl+C to cancel."),
      ...arrowOptionLines(params.options, selectedIndex),
    ];
    renderedLines = lines.length;
    output.write(`${lines.join("\n")}\n`);
  };

  return new Promise<T>((resolve, reject) => {
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      output.write("\x1b[?25h");
    };

    const finish = (value: T) => {
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      if (data === "\u0003") {
        cleanup();
        output.write("\n");
        reject(new Error("Cancelled"));
        return;
      }
      if (data === "\r" || data === "\n") {
        finish(params.options[selectedIndex].value);
        return;
      }
      if (data === "\u001b[A" || data === "k" || data === "\u0010") {
        selectedIndex = (selectedIndex - 1 + params.options.length) % params.options.length;
        render();
        return;
      }
      if (data === "\u001b[B" || data === "j" || data === "\u000e") {
        selectedIndex = (selectedIndex + 1) % params.options.length;
        render();
      }
    };

    input.on("data", onData);
    render();
  });
}

function inputHidden(message: string, placeholder?: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) return Promise.resolve("");
  output.write(`${message}${placeholder ? ` [${placeholder}]` : ""}: `);
  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw;
    let value = "";
    input.setRawMode(true);
    input.resume();
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
    };
    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      if (data === "\u0003") {
        cleanup();
        output.write("\n");
        reject(new Error("Cancelled"));
        return;
      }
      if (data === "\r" || data === "\n") {
        cleanup();
        output.write("\n");
        resolve(value);
        return;
      }
      if (data === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += data;
    };
    input.on("data", onData);
  });
}

function makeTerminalPrompter(): MindStonePrompter & { close(): void } {
  const rl = createInterface({ input, output });

  const ask = async (question: string): Promise<string> => (await rl.question(question)).trim();

  return {
    close: () => rl.close(),
    intro: async (title) => {
      output.write(`${gold(formatMindStoneConfigHeader())}\n`);
      output.write(`${bold(title)}\n\n`);
    },
    outro: async (message) => {
      output.write(`\n${gold("🔶")} ${message}\n`);
    },
    note: async (message, title) => {
      if (title) output.write(`${bold(title)}\n`);
      output.write(`${message}\n\n`);
    },
    confirm: async ({ message, initialValue }) => {
      rl.pause();
      try {
        return (
          (await selectWithArrows({
            message,
            options: [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ],
            initialValue: initialValue ? "yes" : "no",
          })) === "yes"
        );
      } finally {
        rl.resume();
      }
    },
    select: async <T extends string>({ message, options, initialValue }: {
      message: string;
      options: Array<MindStoneSelectOption<T>>;
      initialValue?: T;
    }): Promise<T> => {
      rl.pause();
      try {
        return await selectWithArrows({ message, options, initialValue });
      } finally {
        rl.resume();
      }
    },
    text: async ({ message, placeholder, initialValue, sensitive, validate }) => {
      const fallback = initialValue ?? "";
      const value = sensitive ? await inputHidden(message, placeholder) : await ask(`${message}${fallback || placeholder ? ` [${fallback || placeholder}]` : ""}: `);
      const resolved = value || fallback;
      const issue = validate?.(resolved);
      if (issue) throw new Error(issue);
      return resolved;
    },
  };
}

async function discoverPiModels(): Promise<{ models: MindStoneModelInfo[]; providers: MindStoneProviderInfo[]; error?: string }> {
  try {
    const paths = runtimePathsFromEnv();
    const provider = new PiMindStoneProvider({ agentDir: paths.piAgentDir });
    const [models, providers] = await Promise.all([provider.listModels(), provider.listProviders()]);
    return { models, providers };
  } catch (error) {
    return { models: [], providers: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function setupProviderAuth(request: MindStoneProviderAuthSetupRequest): string | undefined {
  const paths = runtimePathsFromEnv();
  if (request.mode === "login") {
    return [
      "Subscription/OAuth login is handled by isolated Pi.",
      "After this wizard, run:",
      `  ./scripts/pi-agent`,
      "Then inside Pi:",
      `  /login ${request.providerId}`,
      "This will store OAuth credentials in the isolated MindStone-Agent Pi auth file.",
    ].join("\n");
  }

  const authPath = join(paths.piAgentDir, "auth.json");
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  const existing = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown> : {};
  existing[request.providerId] = request.mode === "env"
    ? { type: "api_key", key: `$${request.envVar}` }
    : { type: "api_key", key: request.apiKey };
  writeFileSync(authPath, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  return request.mode === "env"
    ? `Stored ${request.providerId} auth reference in isolated auth.json: $${request.envVar}`
    : `Stored ${request.providerId} API key in isolated auth.json.`;
}

function printMemoryStatus(): void {
  const stats = getSqliteMemoryIndexStats(runtimePathsFromEnv());
  output.write(`${gold("🔶 MindStone memory status")}\n\n`);
  output.write(
    [
      `Database: ${stats.databasePath}`,
      `Present: ${stats.present}`,
      `Sources: ${stats.sources}`,
      `Chunks: ${stats.chunks}`,
      `Embedded chunks: ${stats.embeddedChunks}`,
      `Vector backend: ${stats.vectorBackend}`,
      `sqlite-vec available: ${stats.sqliteVec.available}`,
      stats.sqliteVec.version ? `sqlite-vec version: ${stats.sqliteVec.version}` : undefined,
      stats.sqliteVec.extensionPath ? `sqlite-vec extension: ${stats.sqliteVec.extensionPath}` : undefined,
      stats.sqliteVec.error ? `sqlite-vec note: ${stats.sqliteVec.error}` : undefined,
      stats.updatedAt ? `Updated: ${stats.updatedAt}` : undefined,
      stats.error ? `Error: ${stats.error}` : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  );
  output.write("\n");
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasOption(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function runMemoryCommand(argv: string[]): Promise<void> {
  const subcommand = argv[3] ?? "status";
  if (subcommand === "status") {
    printMemoryStatus();
    return;
  }
  if (subcommand === "backfill") {
    const paths = runtimePathsFromEnv();
    const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
    if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
    const embed = argv.includes("--embed");
    const force = argv.includes("--force");
    const result = backfillSqliteMemoryIndex({ config: loaded.config, paths });
    const lines = [
      `Database: ${result.databasePath}`,
      `Sources indexed: ${result.sourcesIndexed}`,
      `Chunks indexed: ${result.chunksIndexed}`,
      `File documents: ${result.fileDocuments}`,
      `Transcript documents: ${result.transcriptDocuments}`,
    ];
    if (embed) {
      const embeddingResult = await backfillSqliteMemoryEmbeddings({ config: loaded.config, paths, force });
      lines.push(
        `Embedding provider: ${embeddingResult.providerId}:${embeddingResult.model}`,
        `Chunks considered for embedding: ${embeddingResult.chunksConsidered}`,
        `Chunks embedded: ${embeddingResult.chunksEmbedded}`,
        embeddingResult.dimensions ? `Embedding dimensions: ${embeddingResult.dimensions}` : "Embedding dimensions: n/a",
      );
    }
    output.write(`${gold("🔶 MindStone memory backfill")}\n\n`);
    output.write(lines.join("\n"));
    output.write("\n");
    return;
  }
  throw new Error(`Unknown memory command: ${subcommand}\n\n${usage()}`);
}

function resolveChatProvider(config: ReturnType<typeof loadMindStoneConfig>["config"]): MockMindStoneProvider | PiMindStoneProvider | PiSessionMindStoneProvider {
  const mode = config?.routing?.mode ?? "placeholder";
  const paths = runtimePathsFromEnv();
  if (mode === "mock") return new MockMindStoneProvider(config?.routing?.mock);
  if (mode === "pi-session") {
    return new PiSessionMindStoneProvider({
      projectRoot: paths.root,
      agentDir: config?.routing?.pi?.agentDir ?? paths.piAgentDir,
      sessionDir: paths.piSessionDir,
      cwd: config?.workspace?.root,
      defaultModel: config?.routing?.defaultModel,
      additionalExtensionPaths: config?.routing?.pi?.additionalExtensionPaths,
      additionalSkillPaths: config?.routing?.pi?.additionalSkillPaths,
      additionalPromptTemplatePaths: config?.routing?.pi?.additionalPromptTemplatePaths,
      additionalThemePaths: config?.routing?.pi?.additionalThemePaths,
      noExtensions: config?.routing?.pi?.noExtensions,
      noSkills: config?.routing?.pi?.noSkills,
      noPromptTemplates: config?.routing?.pi?.noPromptTemplates,
      noThemes: config?.routing?.pi?.noThemes,
      noContextFiles: config?.routing?.pi?.noContextFiles,
    });
  }
  if (mode === "pi") {
    return new PiMindStoneProvider({
      agentDir: config?.routing?.pi?.agentDir,
      defaultModel: config?.routing?.defaultModel,
    });
  }
  throw new Error("MindStone chat requires routing.mode to be mock, pi-session, or pi. Current mode is placeholder; run `mindstone config` or edit config.json first.");
}

function resolveChatRunner(config: ReturnType<typeof loadMindStoneConfig>["config"], provider: MockMindStoneProvider | PiMindStoneProvider | PiSessionMindStoneProvider): AgentRunner | undefined {
  if (config?.routing?.mode !== "pi-session") return undefined;
  void provider;
  const paths = runtimePathsFromEnv();
  return new PiSessionAgentRunner({
    projectRoot: paths.root,
    agentDir: config?.routing?.pi?.agentDir ?? paths.piAgentDir,
    sessionDir: paths.piSessionDir,
    cwd: config?.workspace?.root,
    defaultModel: config?.routing?.defaultModel,
    additionalExtensionPaths: config?.routing?.pi?.additionalExtensionPaths,
    additionalSkillPaths: config?.routing?.pi?.additionalSkillPaths,
    additionalPromptTemplatePaths: config?.routing?.pi?.additionalPromptTemplatePaths,
    additionalThemePaths: config?.routing?.pi?.additionalThemePaths,
    noExtensions: config?.routing?.pi?.noExtensions,
    noSkills: config?.routing?.pi?.noSkills,
    noPromptTemplates: config?.routing?.pi?.noPromptTemplates,
    noThemes: config?.routing?.pi?.noThemes,
    noContextFiles: config?.routing?.pi?.noContextFiles,
  });
}

async function runOneChatTurn(params: {
  argv: string[];
  message: string;
  loaded: ReturnType<typeof loadMindStoneConfig>;
}): Promise<Awaited<ReturnType<typeof runMindStoneChatTurn>>> {
  const config = params.loaded.config;
  if (!config) throw new Error(`Config not found. Run ./scripts/init-runtime.sh or mindstone onboard first. Expected: ${params.loaded.path}`);
  const mode = config.routing?.mode ?? "placeholder";
  if (mode !== "mock" && mode !== "pi-session" && mode !== "pi") {
    throw new Error("MindStone chat requires routing.mode to be mock, pi-session, or pi. Current mode is placeholder; run `mindstone config` or edit config.json first.");
  }
  const agentId = optionValue(params.argv, "--agent") ?? config.routing?.defaultAgentId ?? "default";
  const sessionKey = resolveConfiguredSessionKey(config, {
    agentId,
    substrate: "mindstone-cli",
    channel: "terminal",
    chatType: "direct",
    senderId: "local",
    explicitSessionKey: optionValue(params.argv, "--session"),
  });
  const metadata: Record<string, unknown> = {
    source: "mindstone-cli",
    method: "chat",
  };
  const modelOverride = optionValue(params.argv, "--model");
  if (modelOverride) metadata.model = modelOverride;
  const provider = resolveChatProvider(config);
  const runner = resolveChatRunner(config, provider);
  const model = resolveMindStoneChatModel({ config, agentId, routingMode: mode, metadata });
  return runMindStoneChatTurn({
    agentId,
    sessionKey,
    message: params.message,
    config,
    configPath: params.loaded.path,
    provider,
    model,
    runner,
    source: {
      substrate: "mindstone-cli",
      channel: "terminal",
      chatType: "direct",
      senderId: "local",
    },
    metadata,
  });
}

async function runChatCommand(argv: string[]): Promise<void> {
  const paths = runtimePathsFromEnv();
  const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
  if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
  const once = optionValue(argv, "--once") ?? optionValue(argv, "--message");
  const json = hasOption(argv, "--json");

  if (once !== undefined) {
    const result = await runOneChatTurn({ argv, message: once, loaded });
    output.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.assistantEntry.text ?? ""}\n`);
    return;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive chat requires a TTY. Use `mindstone chat --once \"message\"` for non-interactive use.");
  }

  output.write(`${gold("🔶 MindStone chat")} ${dim("(/exit to quit)")}\n`);
  const config = loaded.config;
  const agentId = optionValue(argv, "--agent") ?? config?.routing?.defaultAgentId ?? "default";
  const sessionKey = config
    ? resolveConfiguredSessionKey(config, {
        agentId,
        substrate: "mindstone-cli",
        channel: "terminal",
        chatType: "direct",
        senderId: "local",
        explicitSessionKey: optionValue(argv, "--session"),
      })
    : "agent:default:main";
  output.write(`${dim(`session: ${sessionKey}`)}\n\n`);

  const rl = createInterface({ input, output, prompt: `${gold("you")}> ` });
  try {
    rl.prompt();
    for await (const line of rl) {
      const message = line.trim();
      if (!message) {
        rl.prompt();
        continue;
      }
      if (message === "/exit" || message === "/quit") break;
      try {
        const result = await runOneChatTurn({ argv, message, loaded });
        output.write(`${gold("mindstone")}> ${result.assistantEntry.text ?? ""}\n`);
      } catch (error) {
        output.write(`${bold("error")}> ${error instanceof Error ? error.message : String(error)}\n`);
      }
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

function printStatus(): void {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath();
  const loaded = loadMindStoneConfig(configPath);
  const handoff = getCurrentHandoffStatus(paths);
  const status = getMindStoneSystemStatus();
  output.write(`${gold("🔶 MindStone-Agent status")}\n\n`);
  output.write(
    [
      `Root: ${paths.root}`,
      `Runtime dir: ${paths.runtimeDir}`,
      `Pi agent dir: ${paths.piAgentDir}`,
      `Pi session dir: ${paths.piSessionDir}`,
      `Data dir: ${paths.dataDir}`,
      `Config: ${configPath}`,
      `Config exists: ${loaded.exists}`,
      loaded.error ? `Config error: ${loaded.error}` : undefined,
      `Current handoff: ${handoff.exists ? `${handoff.path} (${handoff.bytes} bytes)` : `none (${handoff.path})`}`,
      `WebChat: ${status.webchat.url}`,
      `WebChat default session: ${status.webchat.defaultSessionKey}`,
      `WebChat source: ${status.webchat.source.substrate}/${status.webchat.source.channel}/${status.webchat.source.chatType}`,
      `WebChat API auth applies: ${status.webchat.apiAuthApplies}`,
      loaded.config ? "" : undefined,
      loaded.config ? formatConfigSummary(loaded.config) : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  );
  output.write("\n");
}

function severityIcon(severity: MindStoneDoctorReport["checks"][number]["severity"]): string {
  if (severity === "pass") return "✓";
  if (severity === "warn") return "!";
  if (severity === "fail") return "✗";
  return "i";
}

function printDoctor(report: MindStoneDoctorReport): void {
  output.write(`${gold("🔶 MindStone-Agent doctor")}\n\n`);
  for (const check of report.checks) {
    const icon = severityIcon(check.severity);
    const title = check.severity === "fail" ? bold(check.title) : check.title;
    output.write(`${icon} [${check.severity}] ${check.id}: ${title}`);
    if (check.detail) output.write(`\n    ${dim(check.detail)}`);
    output.write("\n");
  }
  output.write("\n");
  output.write(
    [
      `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.info} info`,
      `Result: ${report.ok ? "ok" : "failed"}`,
    ].join("\n"),
  );
  output.write("\n");
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  if (command === "help") {
    output.write(`${usage()}\n`);
    return;
  }
  if (command === "status") {
    printStatus();
    return;
  }
  if (command === "memory") {
    await runMemoryCommand(process.argv);
    return;
  }
  if (command === "chat") {
    await runChatCommand(process.argv);
    return;
  }
  if (command === "tui") {
    await runTuiCommand(process.argv);
    return;
  }
  if (command === "doctor") {
    const discovery = await discoverPiModels();
    const paths = runtimePathsFromEnv();
    const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
    const embeddingProbe = loaded.config?.memory?.embeddingProvider
      ? await probeMemoryEmbeddingProvider(loaded.config)
      : undefined;
    const report = getMindStoneDoctorReport({
      providerDiscovery: {
        providerCount: discovery.providers.length,
        modelCount: discovery.models.length,
        error: discovery.error,
      },
      embeddingProbe,
    });
    printDoctor(report);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const prompter = makeTerminalPrompter();
  try {
    const discovery = await discoverPiModels();
    if (command === "onboard") {
      await runMindStoneOnboardingWizard(prompter, {
        showHeader: false,
        availableModels: discovery.models,
        availableProviders: discovery.providers,
        modelDiscoveryError: discovery.error,
        setupProviderAuth,
      });
    } else {
      await runMindStoneConfigWizard(prompter, {
        showHeader: false,
        availableModels: discovery.models,
        availableProviders: discovery.providers,
        modelDiscoveryError: discovery.error,
        setupProviderAuth,
      });
    }
  } finally {
    prompter.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
