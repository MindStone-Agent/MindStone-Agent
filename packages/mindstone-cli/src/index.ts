#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  formatConfigSummary,
  formatMindStoneConfigHeader,
  loadMindStoneConfig,
  resolveConfigPath,
  runMindStoneConfigWizard,
  runtimePathsFromEnv,
  type MindStonePrompter,
  type MindStoneSelectOption,
} from "@mindstone-agent/core";

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
    "  mindstone onboard      First-run onboarding (currently same core flow as config)",
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

function numberedOptions<T extends string>(options: Array<MindStoneSelectOption<T>>): string {
  return options
    .map((option, index) => {
      const hint = option.hint ? dim(` — ${option.hint}`) : "";
      return `  ${index + 1}) ${option.label}${hint}`;
    })
    .join("\n");
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
      const suffix = initialValue ? "Y/n" : "y/N";
      const answer = (await ask(`${message} [${suffix}] `)).toLowerCase();
      if (!answer) return initialValue ?? false;
      return answer === "y" || answer === "yes";
    },
    select: async <T extends string>({ message, options, initialValue }: {
      message: string;
      options: Array<MindStoneSelectOption<T>>;
      initialValue?: T;
    }): Promise<T> => {
      output.write(`${message}\n${numberedOptions(options)}\n`);
      const defaultIndex = initialValue ? options.findIndex((option) => option.value === initialValue) + 1 : 0;
      while (true) {
        const answer = await ask(defaultIndex > 0 ? `Select [${defaultIndex}]: ` : "Select: ");
        const index = answer ? Number.parseInt(answer, 10) : defaultIndex;
        if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].value;
        const byValue = options.find((option) => option.value === answer);
        if (byValue) return byValue.value;
        output.write(`Choose 1-${options.length} or an option value.\n`);
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
    await runMindStoneConfigWizard(prompter);
  } finally {
    prompter.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
