#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  formatConfigSummary,
  formatMindStoneConfigHeader,
  loadMindStoneConfig,
  resolveConfigPath,
  runMindStoneConfigWizard,
  runMindStoneOnboardingWizard,
  runtimePathsFromEnv,
  type MindStoneModelInfo,
  type MindStoneProviderInfo,
  type MindStonePrompter,
  type MindStoneSelectOption,
} from "@mindstone-agent/core";
import { PiMindStoneProvider } from "@mindstone-agent/gateway";

type Command = "config" | "onboard" | "status" | "help";

const gold = (text: string) => `\x1b[38;5;214m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

function usage(): string {
  return [
    gold("🔶 MindStone-Agent"),
    "",
    "Usage:",
    "  mindstone config       Configure MindStone-Agent runtime settings",
    "  mindstone onboard      First-run onboarding with risk notice, config, and identity/user scaffold",
    "  mindstone status       Show isolated runtime/config status",
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
  if (raw === "config" || raw === "onboard" || raw === "status" || raw === "help") return raw;
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
      const hint = fallback || placeholder ? ` [${fallback || placeholder}]` : "";
      const value = await ask(`${message}${hint}: `);
      const resolved = value || fallback;
      const issue = validate?.(resolved);
      if (issue) throw new Error(issue);
      if (sensitive && value) return value;
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

function printStatus(): void {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath();
  const loaded = loadMindStoneConfig(configPath);
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
      loaded.config ? "" : undefined,
      loaded.config ? formatConfigSummary(loaded.config) : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
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

  const prompter = makeTerminalPrompter();
  try {
    const discovery = await discoverPiModels();
    if (command === "onboard") {
      await runMindStoneOnboardingWizard(prompter, {
        showHeader: false,
        availableModels: discovery.models,
        availableProviders: discovery.providers,
        modelDiscoveryError: discovery.error,
      });
    } else {
      await runMindStoneConfigWizard(prompter, {
        showHeader: false,
        availableModels: discovery.models,
        availableProviders: discovery.providers,
        modelDiscoveryError: discovery.error,
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
