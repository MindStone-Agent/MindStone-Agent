import {
  createLocalMemoryRecallProvider,
  createMemoryEmbeddingProvider,
  discoverFileMemoryDocuments,
  getSqliteMemoryIndexStats,
  runMindStoneConfigWizard,
  runtimePathsFromEnv,
  loadMindStoneConfig,
  resolveConfigPath,
  sqliteMemoryDatabasePath,
  SqliteMemoryRecallProvider,
  type MemoryHit,
  type MemoryRecallProvider,
  type MindStonePrompter,
  type MindStoneSelectOption,
} from "@mindstone-agent/core";

type PiNotifyKind = "info" | "warning" | "error";

type PiCommandContext = {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, kind?: PiNotifyKind): void;
  };
};

type PiExtensionApi = {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: PiCommandContext): Promise<void> | void;
    },
  ): void;
};

function formatOption<T extends string>(option: MindStoneSelectOption<T>): string {
  return option.hint ? `${option.label} — ${option.hint}` : option.label;
}

function parseRecallSearchArgs(args: string): { query: string; limit: number } {
  const parts = args.trim().split(/\s+/g).filter(Boolean);
  const queryParts: string[] = [];
  let limit = 5;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if ((part === "--limit" || part === "-n") && parts[i + 1]) {
      const parsed = Number.parseInt(parts[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, 20);
      i += 1;
      continue;
    }
    queryParts.push(part);
  }
  return { query: queryParts.join(" ").trim(), limit };
}

function truncateSnippet(text: string, maxChars = 360): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatMemoryHit(hit: MemoryHit, index: number): string {
  const title = hit.title ?? hit.path ?? hit.id;
  const providerScore = typeof hit.metadata?.providerScore === "number" ? ` provider=${hit.metadata.providerScore.toFixed(3)}` : "";
  const recallMode = typeof hit.metadata?.recallMode === "string" ? ` mode=${hit.metadata.recallMode}` : "";
  return [
    `${index + 1}. ${title}`,
    `   score=${hit.score.toFixed(3)}${providerScore}${recallMode}`,
    `   ${truncateSnippet(hit.text)}`,
  ].join("\n");
}

function memoryStatusMessage(): string {
  const paths = runtimePathsFromEnv();
  const stats = getSqliteMemoryIndexStats(paths);
  return [
    "MindStone memory status",
    `Database: ${stats.databasePath}`,
    `Present: ${stats.present}`,
    `Sources: ${stats.sources}`,
    `Chunks: ${stats.chunks}`,
    `Embedded chunks: ${stats.embeddedChunks}`,
    `Duplicate text chunks: ${stats.duplicateTextChunks}`,
    `Vector backend: ${stats.vectorBackend}`,
    `sqlite-vec available: ${stats.sqliteVec.available}`,
    stats.sqliteVec.version ? `sqlite-vec version: ${stats.sqliteVec.version}` : undefined,
    stats.sqliteVec.error ? `sqlite-vec note: ${stats.sqliteVec.error}` : undefined,
    stats.updatedAt ? `Updated: ${stats.updatedAt}` : undefined,
    stats.error ? `Error: ${stats.error}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function resolveMemoryRecallProvider(): MemoryRecallProvider | undefined {
  const paths = runtimePathsFromEnv();
  const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
  if (loaded.error) throw new Error(`Config error: ${loaded.error}`);
  const stats = getSqliteMemoryIndexStats(paths);
  if (stats.present && stats.chunks > 0) {
    return new SqliteMemoryRecallProvider({
      databasePath: sqliteMemoryDatabasePath(paths),
      embeddingProvider: createMemoryEmbeddingProvider(loaded.config),
    });
  }
  return createLocalMemoryRecallProvider(discoverFileMemoryDocuments({ config: loaded.config, paths }));
}

function piPrompter(ctx: PiCommandContext): MindStonePrompter {
  return {
    intro: async (title) => ctx.ui.notify(title, "info"),
    outro: async (message) => ctx.ui.notify(message, "info"),
    note: async (message, title) => ctx.ui.notify(title ? `${title}\n${message}` : message, "info"),
    confirm: async ({ message }) => ctx.ui.confirm("MindStone", message),
    select: async <T extends string>({ message, options, initialValue }: {
      message: string;
      options: Array<MindStoneSelectOption<T>>;
      initialValue?: T;
    }): Promise<T> => {
      const labels = options.map(formatOption);
      const selected = await ctx.ui.select(message, labels);
      if (!selected) {
        if (initialValue) return initialValue;
        throw new Error("Selection cancelled");
      }
      const index = labels.indexOf(selected);
      if (index < 0) throw new Error(`Unknown selection: ${selected}`);
      return options[index].value;
    },
    text: async ({ message, placeholder, initialValue, validate }) => {
      const value = await ctx.ui.input(message, placeholder ?? initialValue);
      const resolved = value ?? initialValue ?? "";
      const issue = validate?.(resolved);
      if (issue) throw new Error(issue);
      return resolved;
    },
  };
}

export default function mindstoneAgentPiAdapter(pi: PiExtensionApi): void {
  pi.registerCommand("mindstone-agent-status", {
    description: "Show MindStone-Agent isolated runtime status",
    handler: async (_args, ctx) => {
      const paths = runtimePathsFromEnv();
      ctx.ui.notify(
        [
          "MindStone-Agent runtime isolation",
          `Pi agent dir: ${paths.piAgentDir}`,
          `Pi session dir: ${paths.piSessionDir}`,
          `Data dir: ${paths.dataDir}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("mindstone-recall-status", {
    description: "Show MindStone-Agent memory/recall index status",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(memoryStatusMessage(), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("mindstone-recall-search", {
    description: "Search MindStone-Agent memory from the isolated runtime",
    handler: async (args, ctx) => {
      try {
        const { query, limit } = parseRecallSearchArgs(args);
        if (!query) {
          ctx.ui.notify("Usage: /mindstone-recall-search <query> [--limit N]", "warning");
          return;
        }
        const provider = resolveMemoryRecallProvider();
        if (!provider) {
          ctx.ui.notify("No MindStone memory provider is available. Run memory backfill or add memory files first.", "warning");
          return;
        }
        const hits = await provider.search({ text: query, limit });
        ctx.ui.notify(
          [
            `MindStone recall search: ${query}`,
            `Provider: ${provider.id}`,
            `Hits: ${hits.length}`,
            "",
            ...hits.map(formatMemoryHit),
          ].join("\n"),
          hits.length ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("mindstone-config", {
    description: "Configure MindStone-Agent runtime settings",
    handler: async (_args, ctx) => {
      try {
        const result = await runMindStoneConfigWizard(piPrompter(ctx));
        ctx.ui.notify(
          [
            result.wrote ? "MindStone-Agent config updated." : "MindStone-Agent config unchanged.",
            `Path: ${result.path}`,
            `Changed sections: ${result.changedSections.length ? result.changedSections.join(", ") : "none"}`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
