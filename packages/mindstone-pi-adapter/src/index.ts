import { runtimePathsFromEnv } from "@mindstone-agent/core";

type PiCommandContext = {
  ui: {
    notify(message: string, kind?: "info" | "success" | "warning" | "error"): void;
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
}
