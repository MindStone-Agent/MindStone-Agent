import type { MindStoneConfig } from "../config/index.js";

export type PiSessionSafetyStatus = {
  routingMode: string;
  active: boolean;
  isolatedAgentDir?: string;
  isolatedSessionDir?: string;
  usesGlobalPiAgentDir: boolean;
  resumeCap: {
    enabled: boolean;
    maxEntries: number;
    dropErrorTurns: boolean;
  };
  compaction: {
    reserveTokensFloor: number;
    safeguardFallback: boolean;
  };
};

const DEFAULT_PI_SESSION_RESUME_CAP_MAX_ENTRIES = 800;
const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function getPiSessionSafetyStatus(input: {
  config?: MindStoneConfig;
  piAgentDir: string;
  piSessionDir: string;
  homeDir?: string;
}): PiSessionSafetyStatus {
  const routingMode = input.config?.routing?.mode ?? "placeholder";
  const configuredResumeCap = input.config?.routing?.pi?.resumeCap;
  const configuredCompaction = input.config?.routing?.pi?.compaction;
  const homeDir = input.homeDir ?? process.env.HOME;
  const globalPiAgentDir = homeDir ? `${homeDir.replace(/\/$/, "")}/.pi/agent` : undefined;
  const isolatedAgentDir = input.config?.routing?.pi?.agentDir ?? input.piAgentDir;
  return {
    routingMode,
    active: routingMode === "pi-session",
    isolatedAgentDir,
    isolatedSessionDir: input.piSessionDir,
    usesGlobalPiAgentDir: Boolean(globalPiAgentDir && isolatedAgentDir === globalPiAgentDir),
    resumeCap: {
      enabled: configuredResumeCap?.enabled !== false,
      maxEntries: nonNegativeInt(configuredResumeCap?.maxEntries) ?? DEFAULT_PI_SESSION_RESUME_CAP_MAX_ENTRIES,
      dropErrorTurns: configuredResumeCap?.dropErrorTurns !== false,
    },
    compaction: {
      reserveTokensFloor: nonNegativeInt(configuredCompaction?.reserveTokensFloor) ?? DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
      safeguardFallback: configuredCompaction?.safeguardFallback === true,
    },
  };
}
