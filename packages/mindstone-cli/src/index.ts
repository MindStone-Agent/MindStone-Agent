#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import {
  INTEGRATION_BUILDER_SKILL,
  backfillSqliteMemoryEmbeddings,
  backfillSqliteMemoryIndex,
  buildIntegrationBuilderBrief,
  formatConfigSummary,
  formatIntegrationBuilderSkillMarkdown,
  formatMindStoneChannelCatalog,
  formatMindStoneConfigHeader,
  getCurrentHandoffStatus,
  getMindStoneChannelCatalog,
  getMindStoneDoctorReport,
  getMindStoneSystemStatus,
  getSqliteMemoryIndexStats,
  maintainSqliteMemoryIndex,
  loadMindStoneConfig,
  probeMemoryEmbeddingProvider,
  resolveConfigPath,
  resolveConfiguredSessionKey,
  resolveMindStoneChatModel,
  runMindStoneChatTurn,
  runMindStoneConfigWizard,
  runMindStoneOnboardingWizard,
  runtimePathsFromEnv,
  synthesizeMindStoneIdentityActivation,
  type AgentRunner,
  type MindStoneDoctorReport,
  type MindStoneModelInfo,
  type MindStoneConfigWizardSection,
  type MindStoneProviderAuthSetupRequest,
  type MindStoneProviderInfo,
  type MindStonePrompter,
  type IntegrationBuilderKind,
  type MindStoneSelectOption,
} from "@mindstone-agent/core";
import { MockMindStoneProvider, PiMindStoneProvider, PiSessionAgentRunner, PiSessionMindStoneProvider } from "@mindstone-agent/gateway";
import { runTuiCommand } from "./tui.js";

type Command = "chat" | "tui" | "config" | "onboard" | "auth" | "gateway" | "identity" | "skill" | "channels" | "status" | "doctor" | "memory" | "help";

const gold = (text: string) => `\x1b[38;5;220m${text}\x1b[0m`;
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
    "  mindstone config [--section NAME|--sections a,b] [--dry-run]",
    "                         Configure MindStone-Agent runtime settings or one section",
    "  mindstone onboard      First-run onboarding with risk notice, config, and identity/user scaffold",
    "  mindstone auth login <provider> [--dry-run]",
    "                         Connect a subscription/OAuth provider through MindStone's isolated auth flow",
    "  mindstone gateway [status|run|start|stop|restart|logs|install|uninstall]",
    "                         Manage the local MindStone Gateway process/service",
    "  mindstone identity activate [--agent ID] [--dry-run] [--force] [--yes] [--json]",
    "                         Synthesize first-activation identity from onboarding seed",
    "  mindstone skill list   Show built-in MindStone skill surfaces",
    "  mindstone skill integration-builder [--name NAME] [--kind KIND] [--goal TEXT] [--json]",
    "                         Build an integration/channel/tool implementation brief",
    "  mindstone channels [--json]",
    "                         Show channel/surface catalog without starting listeners",
    "  mindstone status       Show isolated runtime/config status",
    "  mindstone doctor       Check runtime, config, identity, memory, routing, and provider discovery",
    "  mindstone memory backfill [--embed] [--force] [--maintain] [--dedupe-text] [--json]  Index memory/transcripts and optionally maintain/embed chunks",
    "  mindstone memory maintain [--dry-run] [--dedupe-text] [--json]  Clean stale rows and compact SQLite memory DB",
    "  mindstone memory status [--json]    Show SQLite memory DB status",
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
  if (raw === "chat" || raw === "tui" || raw === "config" || raw === "onboard" || raw === "auth" || raw === "gateway" || raw === "identity" || raw === "skill" || raw === "channels" || raw === "status" || raw === "doctor" || raw === "memory" || raw === "help") return raw;
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

type PiOAuthSelectPrompt = {
  message: string;
  options: Array<{ id: string; label: string }>;
};

type PiAuthStorage = {
  login(providerId: string, callbacks: {
    onAuth: (info: { url: string; instructions?: string }) => void;
    onDeviceCode: (info: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }) => void;
    onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
    onProgress?: (message: string) => void;
    onSelect: (prompt: PiOAuthSelectPrompt) => Promise<string | undefined>;
    signal?: AbortSignal;
  }): Promise<void>;
};

type PiAuthStorageModule = {
  AuthStorage: { create(path?: string): PiAuthStorage };
};

async function importFromProject<T>(projectRoot: string, relativePath: string): Promise<T> {
  return import(pathToFileURL(join(projectRoot, relativePath)).href) as Promise<T>;
}

function openAuthUrl(url: string): boolean {
  if (!url) return false;
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function runProviderOAuthLogin(prompter: MindStonePrompter, providerId: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Provider OAuth login requires an interactive terminal. For automated setup, use env-var or API-key auth.");
  }

  const paths = runtimePathsFromEnv();
  const authPath = join(paths.piAgentDir, "auth.json");
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });

  const { AuthStorage } = await importFromProject<PiAuthStorageModule>(
    paths.root,
    "vendor/pi/packages/coding-agent/dist/core/auth-storage.js",
  );
  const authStorage = AuthStorage.create(authPath);

  await prompter.note(
    [
      `MindStone will connect ${providerId} now using the embedded Pi OAuth provider.`,
      `Credential target: ${authPath}`,
      "This does not use your global Pi auth file.",
    ].join("\n"),
    "Connect account",
  );

  await authStorage.login(providerId, {
    onAuth: (info) => {
      const opened = openAuthUrl(info.url);
      output.write(`${bold("OAuth browser login")}\n`);
      if (opened) output.write("Opened the login URL in your browser.\n");
      output.write(`${info.instructions ? `${info.instructions}\n` : ""}`);
      output.write(`${info.url}\n\n`);
    },
    onDeviceCode: (info) => {
      const opened = openAuthUrl(info.verificationUri);
      output.write(`${bold("OAuth device login")}\n`);
      if (opened) output.write("Opened the verification URL in your browser.\n");
      output.write(`Verification URL: ${info.verificationUri}\n`);
      output.write(`Code: ${bold(info.userCode)}\n`);
      if (info.expiresInSeconds) output.write(`Expires in: ${info.expiresInSeconds}s\n`);
      output.write("\n");
    },
    onPrompt: async (prompt) => prompter.text({
      message: prompt.message,
      placeholder: prompt.placeholder,
      validate: prompt.allowEmpty ? undefined : (value) => value.trim() ? undefined : "Required",
    }),
    onProgress: (message) => {
      output.write(`${dim(message)}\n`);
    },
    onSelect: async (prompt) => {
      if (prompt.options.length === 0) return undefined;
      return prompter.select({
        message: prompt.message,
        options: prompt.options.map((option) => ({ value: option.id, label: option.label })),
        initialValue: prompt.options[0]?.id,
      });
    },
  });

  return `Connected ${providerId}. Credentials saved in isolated auth file: ${authPath}`;
}

async function setupProviderAuth(
  prompter: MindStonePrompter,
  request: MindStoneProviderAuthSetupRequest,
  options: { dryRun?: boolean } = {},
): Promise<string | undefined> {
  const paths = runtimePathsFromEnv();
  const authPath = join(paths.piAgentDir, "auth.json");

  if (request.mode === "login") {
    if (options.dryRun) {
      return [
        `MindStone would start embedded subscription/OAuth login for ${request.providerId}.`,
        `Credential target: ${authPath}`,
        "Global Pi auth is not used.",
      ].join("\n");
    }
    return runProviderOAuthLogin(prompter, request.providerId);
  }

  if (options.dryRun) {
    return request.mode === "env"
      ? `MindStone would store ${request.providerId} auth reference in isolated auth.json: $${request.envVar}`
      : `MindStone would store ${request.providerId} API key in isolated auth.json.`;
  }

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

function printJson(value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printMemoryStatus(options: { json?: boolean } = {}): void {
  const stats = getSqliteMemoryIndexStats(runtimePathsFromEnv());
  if (options.json) {
    printJson(stats);
    return;
  }
  output.write(`${gold("🔶 MindStone memory status")}\n\n`);
  output.write(
    [
      `Database: ${stats.databasePath}`,
      `Present: ${stats.present}`,
      `Sources: ${stats.sources}`,
      `Chunks: ${stats.chunks}`,
      `Embedded chunks: ${stats.embeddedChunks}`,
      `Duplicate text chunks: ${stats.duplicateTextChunks}`,
      `Vector backend: ${stats.vectorBackend}`,
      `sqlite-vec available: ${stats.sqliteVec.available}`,
      stats.sqliteVec.version ? `sqlite-vec version: ${stats.sqliteVec.version}` : undefined,
      stats.sqliteVec.extensionPath ? `sqlite-vec extension: ${stats.sqliteVec.extensionPath}` : undefined,
      stats.sqliteVec.error ? `sqlite-vec note: ${stats.sqliteVec.error}` : undefined,
      stats.updatedAt ? `Updated: ${stats.updatedAt}` : undefined,
      stats.bloat ? `DB bytes: ${stats.bloat.databaseBytes}` : undefined,
      stats.bloat ? `WAL bytes: ${stats.bloat.walBytes}` : undefined,
      stats.bloat ? `Estimated free bytes: ${stats.bloat.estimatedFreeBytes}` : undefined,
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

function optionValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function hasOption(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function runMemoryCommand(argv: string[]): Promise<void> {
  const subcommand = argv[3] ?? "status";
  const json = argv.includes("--json");
  if (subcommand === "status") {
    printMemoryStatus({ json });
    return;
  }
  if (subcommand === "backfill") {
    const paths = runtimePathsFromEnv();
    const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
    if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
    const embed = argv.includes("--embed");
    const force = argv.includes("--force");
    const maintain = argv.includes("--maintain") || argv.includes("--dedupe-text");
    const deduplicateText = argv.includes("--dedupe-text");
    const result = backfillSqliteMemoryIndex({ config: loaded.config, paths });
    let maintenanceResult: ReturnType<typeof maintainSqliteMemoryIndex> | undefined;
    let embeddingResult: Awaited<ReturnType<typeof backfillSqliteMemoryEmbeddings>> | undefined;
    const lines = [
      `Database: ${result.databasePath}`,
      `Sources indexed: ${result.sourcesIndexed}`,
      `Chunks indexed: ${result.chunksIndexed}`,
      `Chunk embeddings preserved: ${result.chunkEmbeddingsPreserved}`,
      `File documents: ${result.fileDocuments}`,
      `Transcript documents: ${result.transcriptDocuments}`,
    ];
    if (maintain) {
      maintenanceResult = maintainSqliteMemoryIndex({ paths, deduplicateText });
      lines.push(
        `Maintenance stale sources removed: ${maintenanceResult.staleSourcesRemoved}`,
        `Maintenance duplicate text chunks removed: ${maintenanceResult.duplicateTextChunksRemoved}`,
        `Maintenance empty sources removed: ${maintenanceResult.emptySourcesRemoved}`,
        `Maintenance optimized: ${maintenanceResult.optimized}`,
        `Maintenance vacuumed: ${maintenanceResult.vacuumed}`,
      );
      if (maintenanceResult.error) lines.push(`Maintenance error: ${maintenanceResult.error}`);
    }
    if (embed) {
      embeddingResult = await backfillSqliteMemoryEmbeddings({ config: loaded.config, paths, force });
      lines.push(
        `Embedding provider: ${embeddingResult.providerId}:${embeddingResult.model}`,
        `Chunks considered for embedding: ${embeddingResult.chunksConsidered}`,
        `Chunks embedded: ${embeddingResult.chunksEmbedded}`,
        embeddingResult.dimensions ? `Embedding dimensions: ${embeddingResult.dimensions}` : "Embedding dimensions: n/a",
      );
    }
    if (json) {
      printJson({ backfill: result, maintenance: maintenanceResult, embedding: embeddingResult });
      if (maintenanceResult?.error) process.exitCode = 1;
      return;
    }
    output.write(`${gold("🔶 MindStone memory backfill")}\n\n`);
    output.write(lines.join("\n"));
    output.write("\n");
    if (maintenanceResult?.error) process.exitCode = 1;
    return;
  }
  if (subcommand === "maintain") {
    const paths = runtimePathsFromEnv();
    const result = maintainSqliteMemoryIndex({
      paths,
      dryRun: argv.includes("--dry-run"),
      deduplicateText: argv.includes("--dedupe-text"),
      removeStaleSources: !argv.includes("--no-stale"),
      optimize: !argv.includes("--no-optimize"),
      vacuum: !argv.includes("--no-vacuum"),
    });
    if (json) {
      printJson(result);
      if (result.error) process.exitCode = 1;
      return;
    }
    const lines = [
      `Database: ${result.databasePath}`,
      `Present: ${result.present}`,
      `Dry run: ${result.dryRun}`,
      result.before ? `Sources before: ${result.before.sources}` : undefined,
      result.before ? `Chunks before: ${result.before.chunks}` : undefined,
      result.before ? `Embedded chunks before: ${result.before.embeddedChunks}` : undefined,
      result.before ? `Duplicate text chunks before: ${result.before.duplicateTextChunks}` : undefined,
      result.before?.bloat ? `DB bytes before: ${result.before.bloat.databaseBytes}` : undefined,
      result.before?.bloat ? `Estimated free bytes before: ${result.before.bloat.estimatedFreeBytes}` : undefined,
      `Stale sources found: ${result.staleSourcesFound}`,
      `Stale sources removed: ${result.staleSourcesRemoved}`,
      `Duplicate text chunks found: ${result.duplicateTextChunksFound}`,
      `Duplicate text chunks removed: ${result.duplicateTextChunksRemoved}`,
      `Empty sources found: ${result.emptySourcesFound}`,
      `Empty sources removed: ${result.emptySourcesRemoved}`,
      `Optimized: ${result.optimized}`,
      `Vacuumed: ${result.vacuumed}`,
      result.after ? `Sources after: ${result.after.sources}` : undefined,
      result.after ? `Chunks after: ${result.after.chunks}` : undefined,
      result.after ? `Embedded chunks after: ${result.after.embeddedChunks}` : undefined,
      result.after ? `Duplicate text chunks after: ${result.after.duplicateTextChunks}` : undefined,
      result.after?.bloat ? `DB bytes after: ${result.after.bloat.databaseBytes}` : undefined,
      result.after?.bloat ? `Estimated free bytes after: ${result.after.bloat.estimatedFreeBytes}` : undefined,
      result.error ? `Error: ${result.error}` : undefined,
    ].filter((line) => line !== undefined);
    output.write(`${gold("🔶 MindStone memory maintenance")}\n\n`);
    output.write(lines.join("\n"));
    output.write("\n");
    if (result.error) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown memory command: ${subcommand}\n\n${usage()}`);
}

function isChatRunnableRoutingMode(mode: string): mode is "mock" | "pi-session" | "pi" {
  return mode === "mock" || mode === "pi-session" || mode === "pi";
}

function chatRoutingRequiredMessage(mode = "placeholder"): string {
  if (mode === "placeholder") {
    return "MindStone chat is still in transcript-only setup mode. Start interactive `mindstone chat` from a TTY to choose an answer mode, or configure routing with `mindstone config --section routing`.";
  }
  return `MindStone chat requires routing.mode to be mock, pi-session, or pi. Current mode is ${mode}.`;
}

async function ensureChatRoutingConfigured(argv: string[], loaded: ReturnType<typeof loadMindStoneConfig>): Promise<ReturnType<typeof loadMindStoneConfig>> {
  const config = loaded.config;
  if (!config) return loaded;
  const routingMode = config.routing?.mode ?? "placeholder";
  if (isChatRunnableRoutingMode(routingMode)) return loaded;
  if (routingMode !== "placeholder") return loaded;

  output.write([
    "MindStone chat needs an answer mode before it can start an interactive chat surface.",
    "Let's choose one now.",
    "",
  ].join("\n"));

  const prompter = makeTerminalPrompter();
  try {
    const discovery = await discoverPiModels();
    await runMindStoneConfigWizard(prompter, {
      configPath: optionValue(argv, "--config") ?? loaded.path,
      sections: ["routing"],
      showHeader: false,
      availableModels: discovery.models,
      availableProviders: discovery.providers,
      modelDiscoveryError: discovery.error,
      setupProviderAuth: (request) => setupProviderAuth(prompter, request),
    });
  } finally {
    prompter.close();
  }

  const nextLoaded = loadMindStoneConfig(loaded.path);
  if (nextLoaded.error) throw new Error(`Config error after chat setup: ${nextLoaded.error}`);
  return nextLoaded;
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
      contextManagement: config?.contextManagement,
      compaction: config?.routing?.pi?.compaction,
      resumeCap: config?.routing?.pi?.resumeCap,
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
  throw new Error(chatRoutingRequiredMessage(mode));
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
    contextManagement: config?.contextManagement,
    compaction: config?.routing?.pi?.compaction,
    resumeCap: config?.routing?.pi?.resumeCap,
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
  if (!config) throw new Error(`Config not found. Run mindstone onboard first. Expected: ${params.loaded.path}`);
  const mode = config.routing?.mode ?? "placeholder";
  if (!isChatRunnableRoutingMode(mode)) {
    throw new Error(chatRoutingRequiredMessage(mode));
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
  let loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
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

  loaded = await ensureChatRoutingConfigured(argv, loaded);
  const config = loaded.config;
  if (!config) throw new Error(`Config not found. Run mindstone onboard first. Expected: ${loaded.path}`);
  const routingMode = config.routing?.mode ?? "placeholder";
  if (!isChatRunnableRoutingMode(routingMode)) {
    throw new Error("MindStone chat is still in transcript-only setup mode. Choose a real model or mock model before opening interactive chat.");
  }

  output.write(`${gold("🔶 MindStone chat")} ${dim("(/exit to quit)")}\n`);
  const agentId = optionValue(argv, "--agent") ?? config.routing?.defaultAgentId ?? "default";
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

function printChannels(json = false): void {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath(process.env, paths);
  const loaded = loadMindStoneConfig(configPath);
  if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
  const catalog = getMindStoneChannelCatalog(loaded.config);
  if (json) {
    output.write(`${JSON.stringify({ configPath, ...catalog }, null, 2)}\n`);
    return;
  }
  output.write(`${gold("🔶 MindStone channels")}\n\n`);
  output.write(`Config: ${configPath}\n`);
  output.write(formatMindStoneChannelCatalog(loaded.config));
  output.write("\n");
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
      `Gateway: ${status.gateway.baseUrl}`,
      `Gateway auth mode: ${status.gateway.auth.mode}`,
      `Gateway auth source: ${status.gateway.auth.source}`,
      `Gateway models API enabled: ${status.gateway.http.modelsEnabled}`,
      `Gateway chat completions enabled: ${status.gateway.http.chatCompletionsEnabled}`,
      `Gateway responses enabled: ${status.gateway.http.responsesEnabled}`,
      `WebChat: ${status.webchat.url}`,
      `WebChat default session: ${status.webchat.defaultSessionKey}`,
      `WebChat source: ${status.webchat.source.substrate}/${status.webchat.source.channel}/${status.webchat.source.chatType}`,
      `WebChat API auth applies: ${status.webchat.apiAuthApplies}`,
      `Memory SQLite present: ${status.memory.sqlite.present}`,
      `Memory SQLite chunks: ${status.memory.sqlite.chunks} (${status.memory.sqlite.embeddedChunks} embedded)`,
      `Memory SQLite duplicate text chunks: ${status.memory.sqlite.duplicateTextChunks}`,
      `Memory SQLite backend: ${status.memory.sqlite.vectorBackend}`,
      status.memory.sqlite.bloat ? `Memory SQLite free bytes: ${status.memory.sqlite.bloat.estimatedFreeBytes}` : undefined,
      `Pi-session safety active: ${status.piSessionSafety.active}`,
      `Pi-session resume cap: ${status.piSessionSafety.resumeCap.enabled} (${status.piSessionSafety.resumeCap.maxEntries} entries, dropErrorTurns=${status.piSessionSafety.resumeCap.dropErrorTurns})`,
      `Pi-session compaction floor: ${status.piSessionSafety.compaction.reserveTokensFloor}`,
      `Pi-session safeguard fallback: ${status.piSessionSafety.compaction.safeguardFallback}`,
      loaded.config ? "" : undefined,
      loaded.config ? formatConfigSummary(loaded.config) : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  );
  output.write("\n");
}

type GatewayManagedState = {
  pid?: number;
  running: boolean;
  dir: string;
  pidPath: string;
  logPath: string;
  scriptPath: string;
};

function gatewayStatePaths(): { dir: string; pidPath: string; logPath: string; scriptPath: string } {
  const paths = runtimePathsFromEnv();
  const dir = join(paths.dataDir, "gateway");
  return {
    dir,
    pidPath: join(dir, "gateway.pid"),
    logPath: join(dir, "gateway.log"),
    scriptPath: join(paths.root, "packages/mindstone-gateway/dist/main.js"),
  };
}

function readGatewayPid(pidPath: string): number | undefined {
  if (!existsSync(pidPath)) return undefined;
  const raw = readFileSync(pidPath, "utf-8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function getManagedGatewayState(): GatewayManagedState {
  const state = gatewayStatePaths();
  const pid = readGatewayPid(state.pidPath);
  const running = isProcessRunning(pid);
  if (pid && !running) {
    try { unlinkSync(state.pidPath); } catch { /* ignore stale cleanup */ }
  }
  return { ...state, pid: running ? pid : undefined, running };
}

async function waitForGatewayHealth(baseUrl: string, timeoutMs = 5000): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { ok: boolean; detail: string } = { ok: false, detail: "not checked" };
  while (Date.now() < deadline) {
    last = await probeGatewayHealth(baseUrl);
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

async function probeGatewayHealth(baseUrl: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body = await response.json() as { ok?: boolean; service?: string };
    return { ok: body.ok === true, detail: body.service ? `${body.service} ok=${body.ok === true}` : `ok=${body.ok === true}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function gatewayLaunchdPlist(params: { label: string; cliPath: string; root: string; runtimeDir: string; logPath: string }): string {
  const escape = (value: string) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escape(params.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(params.cliPath)}</string>
    <string>gateway</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${escape(params.root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escape(params.logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(params.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MINDSTONE_AGENT_ROOT</key><string>${escape(params.root)}</string>
    <key>MINDSTONE_AGENT_RUNTIME_DIR</key><string>${escape(params.runtimeDir)}</string>
    <key>PI_SKIP_VERSION_CHECK</key><string>1</string>
    <key>PI_OFFLINE</key><string>1</string>
  </dict>
</dict>
</plist>
`;
}

function gatewayLaunchdPaths(): { label: string; plistPath: string } {
  return {
    label: "com.mindstone-agent.gateway",
    plistPath: join(homedir(), "Library", "LaunchAgents", "com.mindstone-agent.gateway.plist"),
  };
}

function runLaunchctl(args: string[], allowFailure = false): void {
  const result = spawnSync("launchctl", args, { stdio: allowFailure ? "ignore" : "inherit" });
  if (!allowFailure && result.status !== 0) throw new Error(`launchctl ${args.join(" ")} failed with status ${result.status}`);
}

function startManagedGateway(): GatewayManagedState {
  const state = getManagedGatewayState();
  if (state.running) return state;
  if (!existsSync(state.scriptPath)) {
    throw new Error(`Gateway is not built yet. Run: npm run build:mindstone\nMissing: ${state.scriptPath}`);
  }
  mkdirSync(state.dir, { recursive: true, mode: 0o700 });
  const logFd = openSync(state.logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [state.scriptPath], {
      cwd: runtimePathsFromEnv().root,
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    writeFileSync(state.pidPath, `${child.pid}\n`, { encoding: "utf-8", mode: 0o600 });
    return { ...state, pid: child.pid, running: true };
  } finally {
    closeSync(logFd);
  }
}

async function stopManagedGateway(options: { force?: boolean } = {}): Promise<GatewayManagedState> {
  const state = getManagedGatewayState();
  if (!state.pid || !state.running) return state;
  process.kill(state.pid, options.force ? "SIGKILL" : "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessRunning(state.pid)) break;
  }
  if (isProcessRunning(state.pid)) process.kill(state.pid, "SIGKILL");
  try { unlinkSync(state.pidPath); } catch { /* ignore */ }
  return getManagedGatewayState();
}

async function runGatewayCommand(argv: string[]): Promise<void> {
  const subcommand = argv[3] ?? "status";
  const json = hasOption(argv, "--json");
  const dryRun = hasOption(argv, "--dry-run");
  const paths = runtimePathsFromEnv();
  const configured = getMindStoneSystemStatus().gateway;
  const managed = getManagedGatewayState();

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    output.write([
      gold("🔶 MindStone gateway"),
      "",
      "Usage:",
      "  mindstone gateway status [--json]",
      "  mindstone gateway run",
      "  mindstone gateway start",
      "  mindstone gateway stop [--force]",
      "  mindstone gateway restart",
      "  mindstone gateway logs [--lines N]",
      "  mindstone gateway install [--dry-run]",
      "  mindstone gateway uninstall [--dry-run]",
      "",
      "Notes:",
      "  start/stop/restart manage a local background Gateway process using isolated runtime state.",
      "  install/uninstall manage a user launchd service on macOS.",
    ].join("\n"));
    output.write("\n");
    return;
  }

  if (subcommand === "status") {
    const live = await probeGatewayHealth(configured.baseUrl);
    const payload = { configured, managed, live };
    if (json) {
      printJson(payload);
      return;
    }
    output.write(`${gold("🔶 MindStone Gateway status")}\n\n`);
    output.write([
      `Endpoint: ${configured.baseUrl}`,
      `Auth: ${configured.auth.mode} (${configured.auth.source})`,
      `Models API: ${configured.http.modelsEnabled}`,
      `Chat completions: ${configured.http.chatCompletionsEnabled}`,
      `Responses: ${configured.http.responsesEnabled}`,
      `Managed PID: ${managed.pid ?? "none"}`,
      `Managed running: ${managed.running}`,
      `PID file: ${managed.pidPath}`,
      `Log file: ${managed.logPath}`,
      `Live health: ${live.ok} (${live.detail})`,
    ].join("\n"));
    output.write("\n");
    return;
  }

  if (subcommand === "run") {
    if (!existsSync(managed.scriptPath)) throw new Error(`Gateway is not built yet. Run: npm run build:mindstone\nMissing: ${managed.scriptPath}`);
    const { startGateway } = await import("@mindstone-agent/gateway");
    const gateway = await startGateway();
    output.write(`MindStone-Agent Gateway listening at ${gateway.url}\n`);
    const shutdown = async () => {
      await gateway.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    await new Promise(() => undefined);
    return;
  }

  if (subcommand === "start") {
    const next = startManagedGateway();
    const live = await waitForGatewayHealth(configured.baseUrl);
    output.write(`${gold(next.running ? "Gateway started" : "Gateway start requested")}\nPID: ${next.pid}\nLog: ${next.logPath}\nEndpoint: ${configured.baseUrl}\nLive health: ${live.ok} (${live.detail})\n`);
    return;
  }

  if (subcommand === "stop") {
    const before = getManagedGatewayState();
    await stopManagedGateway({ force: hasOption(argv, "--force") });
    output.write(before.running ? `${gold("Gateway stopped")}\nPID: ${before.pid}\n` : "Gateway is not running.\n");
    return;
  }

  if (subcommand === "restart") {
    await stopManagedGateway({ force: hasOption(argv, "--force") });
    const next = startManagedGateway();
    const live = await waitForGatewayHealth(configured.baseUrl);
    output.write(`${gold("Gateway restarted")}\nPID: ${next.pid}\nLog: ${next.logPath}\nEndpoint: ${configured.baseUrl}\nLive health: ${live.ok} (${live.detail})\n`);
    return;
  }

  if (subcommand === "logs") {
    const lines = Number.parseInt(optionValue(argv, "--lines") ?? "80", 10);
    if (!existsSync(managed.logPath)) {
      output.write(`No Gateway log file yet: ${managed.logPath}\n`);
      return;
    }
    const text = readFileSync(managed.logPath, "utf-8");
    output.write(text.split(/\r?\n/).slice(-Math.max(1, lines)).join("\n"));
    output.write("\n");
    return;
  }

  if (subcommand === "install") {
    const launchd = gatewayLaunchdPaths();
    const cliPath = join(paths.root, "packages/mindstone-cli/bin/mindstone.js");
    const plist = gatewayLaunchdPlist({ label: launchd.label, cliPath, root: paths.root, runtimeDir: paths.runtimeDir, logPath: managed.logPath });
    if (process.platform !== "darwin") throw new Error("Gateway service install currently supports macOS launchd only. Use `mindstone gateway start` for managed background mode.");
    if (dryRun) {
      output.write(`${gold("Gateway launchd install dry run")}\nPlist: ${launchd.plistPath}\nLabel: ${launchd.label}\n`);
      return;
    }
    mkdirSync(dirname(launchd.plistPath), { recursive: true, mode: 0o700 });
    mkdirSync(managed.dir, { recursive: true, mode: 0o700 });
    writeFileSync(launchd.plistPath, plist, { encoding: "utf-8", mode: 0o600 });
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Cannot install launchd service: process uid unavailable.");
    runLaunchctl(["bootout", `gui/${uid}`, launchd.plistPath], true);
    runLaunchctl(["bootstrap", `gui/${uid}`, launchd.plistPath]);
    runLaunchctl(["enable", `gui/${uid}/${launchd.label}`], true);
    runLaunchctl(["kickstart", "-k", `gui/${uid}/${launchd.label}`], true);
    output.write(`${gold("Gateway service installed")}\nLabel: ${launchd.label}\nPlist: ${launchd.plistPath}\nLog: ${managed.logPath}\n`);
    return;
  }

  if (subcommand === "uninstall") {
    const launchd = gatewayLaunchdPaths();
    if (process.platform !== "darwin") throw new Error("Gateway service uninstall currently supports macOS launchd only.");
    if (dryRun) {
      output.write(`${gold("Gateway launchd uninstall dry run")}\nPlist: ${launchd.plistPath}\nLabel: ${launchd.label}\n`);
      return;
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Cannot uninstall launchd service: process uid unavailable.");
    runLaunchctl(["bootout", `gui/${uid}`, launchd.plistPath], true);
    if (existsSync(launchd.plistPath)) unlinkSync(launchd.plistPath);
    output.write(`${gold("Gateway service uninstalled")}\nLabel: ${launchd.label}\nPlist: ${launchd.plistPath}\n`);
    return;
  }

  throw new Error(`Unknown gateway command: ${subcommand}`);
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

function parseIntegrationBuilderKind(value: string | undefined): IntegrationBuilderKind | undefined {
  if (!value) return undefined;
  if (value === "api" || value === "webhook" || value === "channel" || value === "tool" || value === "automation" || value === "unknown") return value;
  throw new Error(`Invalid integration kind: ${value}`);
}

async function runSkillCommand(argv: string[]): Promise<void> {
  const subcommand = argv[3] ?? "list";
  const json = hasOption(argv, "--json");
  if (subcommand === "list") {
    const skills = [INTEGRATION_BUILDER_SKILL];
    if (json) {
      output.write(`${JSON.stringify(skills, null, 2)}\n`);
      return;
    }
    output.write(`${gold("🔶 MindStone skills")}\n\n`);
    for (const skill of skills) {
      output.write(`${bold(skill.id)} — ${skill.description}\n`);
      output.write(`${dim(`outputs: ${skill.outputs.join(", ")}`)}\n\n`);
    }
    return;
  }
  if (subcommand !== "integration-builder") throw new Error(`Unknown skill subcommand: ${subcommand}`);

  if (hasOption(argv, "--emit-skill-md")) {
    output.write(formatIntegrationBuilderSkillMarkdown());
    output.write("\n");
    return;
  }

  const brief = buildIntegrationBuilderBrief({
    name: optionValue(argv, "--name"),
    kind: parseIntegrationBuilderKind(optionValue(argv, "--kind")),
    goal: optionValue(argv, "--goal"),
    auth: optionValue(argv, "--auth"),
    surface: optionValue(argv, "--surface"),
    constraints: optionValues(argv, "--constraint"),
  });
  if (json) {
    output.write(`${JSON.stringify(brief, null, 2)}\n`);
    return;
  }
  output.write(brief.markdown);
}

const CONFIG_SECTION_VALUES: MindStoneConfigWizardSection[] = ["all", "workspace", "gateway", "routing", "context", "memory", "identity", "channels"];

function parseConfigWizardSection(value: string): MindStoneConfigWizardSection {
  if ((CONFIG_SECTION_VALUES as string[]).includes(value)) return value as MindStoneConfigWizardSection;
  throw new Error(`Invalid config section: ${value}. Expected one of: ${CONFIG_SECTION_VALUES.join(", ")}`);
}

function parseConfigWizardSections(argv: string[]): MindStoneConfigWizardSection[] | undefined {
  const sections = [
    ...optionValues(argv, "--section"),
    ...optionValues(argv, "-s"),
    ...optionValues(argv, "--sections").flatMap((value) => value.split(",")),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(parseConfigWizardSection);
  return sections.length ? sections : undefined;
}

async function runIdentityCommand(argv: string[]): Promise<void> {
  const subcommand = argv[3] ?? "help";
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    output.write(
      [
        gold("🔶 MindStone identity"),
        "",
        "Usage:",
        "  mindstone identity activate [--agent ID] [--dry-run] [--force] [--yes] [--json]",
        "",
        "Notes:",
        "  activate synthesizes a first-activation identity from onboarding seeds.",
        "  It refuses to overwrite a non-pending identity unless --force is used.",
        "  Existing pending identity files are backed up before replacement.",
      ].join("\n"),
    );
    output.write("\n");
    return;
  }
  if (subcommand !== "activate") throw new Error(`Unknown identity subcommand: ${subcommand}`);

  const json = hasOption(argv, "--json");
  const dryRun = hasOption(argv, "--dry-run");
  const force = hasOption(argv, "--force");
  const yes = hasOption(argv, "--yes") || hasOption(argv, "-y");
  const agentId = optionValue(argv, "--agent");
  const configPath = optionValue(argv, "--config") ?? resolveConfigPath();

  const preview = synthesizeMindStoneIdentityActivation({ configPath, agentId, dryRun: true, force });
  if (dryRun || !preview.wouldWrite) {
    if (json) {
      output.write(`${JSON.stringify(preview, null, 2)}\n`);
    } else if (!preview.wouldWrite) {
      output.write(`${gold("Identity activation skipped")}\n`);
      output.write(`Reason: ${preview.reason ?? "unchanged"}\n`);
      output.write(`Identity: ${preview.identityPath ?? "unset"}\n`);
    } else {
      output.write(`${gold("Identity activation dry run")}\n`);
      output.write(`Agent: ${preview.agentId}\n`);
      output.write(`Name: ${preview.name}\n`);
      output.write(`Identity: ${preview.identityPath ?? "unset"}\n`);
      output.write(`User: ${preview.userPath ?? "unset"}\n`);
      output.write(`Would replace pending identity: ${preview.previousIdentityPending}\n`);
    }
    return;
  }

  if (!yes) {
    if (!input.isTTY || !output.isTTY) {
      throw new Error("Refusing non-interactive identity activation without --yes");
    }
    const prompter = makeTerminalPrompter();
    try {
      await prompter.note(
        [
          `Agent: ${preview.agentId}`,
          `Synthesized name: ${preview.name}`,
          `Identity path: ${preview.identityPath ?? "unset"}`,
          `User path: ${preview.userPath ?? "unset"}`,
          `Previous identity pending: ${preview.previousIdentityPending}`,
          "A backup will be written before replacing an existing pending identity.",
        ].join("\n"),
        "First-activation identity synthesis",
      );
      const accepted = await prompter.confirm({ message: "Activate this identity now?", initialValue: false });
      if (!accepted) {
        output.write("Identity activation cancelled.\n");
        return;
      }
    } finally {
      prompter.close();
    }
  }

  const result = synthesizeMindStoneIdentityActivation({ configPath, agentId, force });
  if (json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  output.write(`${gold("Identity activated")}\n`);
  output.write(`Agent: ${result.agentId}\n`);
  output.write(`Name: ${result.name}\n`);
  output.write(`Identity: ${result.identityPath ?? "unset"}\n`);
  if (result.backupPath) output.write(`Backup: ${result.backupPath}\n`);
}

async function runAuthCommand(argv: string[]): Promise<void> {
  const subcommand = argv[3] ?? "help";
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    output.write(
      [
        gold("🔶 MindStone auth"),
        "",
        "Usage:",
        "  mindstone auth login <provider> [--dry-run]",
        "",
        "Examples:",
        "  mindstone auth login openai-codex",
        "  mindstone auth login anthropic",
        "",
        "Notes:",
        "  Credentials are stored in MindStone-Agent's isolated .runtime/pi-agent/auth.json.",
        "  Global Pi auth is not used.",
      ].join("\n"),
    );
    output.write("\n");
    return;
  }
  if (subcommand !== "login") throw new Error(`Unknown auth subcommand: ${subcommand}`);

  const providerId = argv[4];
  if (!providerId || providerId.startsWith("--")) {
    throw new Error("Provider is required. Example: mindstone auth login openai-codex");
  }

  const prompter = makeTerminalPrompter();
  try {
    const message = await setupProviderAuth(
      prompter,
      { providerId, mode: "login" },
      { dryRun: hasOption(argv, "--dry-run") },
    );
    if (message) await prompter.note(message, hasOption(argv, "--dry-run") ? "Provider auth dry run" : "Provider auth connected");
  } finally {
    prompter.close();
  }
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
  if (command === "channels") {
    printChannels(hasOption(process.argv, "--json"));
    return;
  }
  if (command === "memory") {
    await runMemoryCommand(process.argv);
    return;
  }
  if (command === "identity") {
    await runIdentityCommand(process.argv);
    return;
  }
  if (command === "skill") {
    await runSkillCommand(process.argv);
    return;
  }
  if (command === "auth") {
    await runAuthCommand(process.argv);
    return;
  }
  if (command === "gateway") {
    await runGatewayCommand(process.argv);
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
        setupProviderAuth: (request) => setupProviderAuth(prompter, request),
      });
    } else {
      await runMindStoneConfigWizard(prompter, {
        configPath: optionValue(process.argv, "--config"),
        sections: parseConfigWizardSections(process.argv),
        dryRun: hasOption(process.argv, "--dry-run"),
        showHeader: false,
        availableModels: discovery.models,
        availableProviders: discovery.providers,
        modelDiscoveryError: discovery.error,
        setupProviderAuth: (request) => setupProviderAuth(prompter, request, { dryRun: hasOption(process.argv, "--dry-run") }),
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
