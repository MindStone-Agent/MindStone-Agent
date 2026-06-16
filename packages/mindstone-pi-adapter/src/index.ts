import {
  runMindStoneConfigWizard,
  runtimePathsFromEnv,
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
