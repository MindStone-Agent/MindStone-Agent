import type { PromptWindowAutoCompactEvent } from "../context/index.js";
import type { MindStoneConfig } from "../config/index.js";
import type { AutoCompactHandoffResult } from "./auto-compact.js";

export type SubstrateCompactionRequest = {
  sessionKey: string;
  agentId: string;
  event: PromptWindowAutoCompactEvent;
  handoff?: AutoCompactHandoffResult;
  config?: MindStoneConfig;
  runId?: string;
};

export type SubstrateCompactionResult = {
  requested: boolean;
  available: boolean;
  substrate: "pi" | "none";
  reason: string;
  requestId?: string;
  api?: string;
  details?: Record<string, unknown>;
};

export interface SubstrateCompactionCoordinator {
  requestCompaction(request: SubstrateCompactionRequest): SubstrateCompactionResult | Promise<SubstrateCompactionResult>;
}

function routingMode(config: MindStoneConfig | undefined): "placeholder" | "mock" | "pi" | "pi-session" {
  return config?.routing?.mode ?? "placeholder";
}

export class GatewaySubstrateCompactionCoordinator implements SubstrateCompactionCoordinator {
  requestCompaction(request: SubstrateCompactionRequest): SubstrateCompactionResult {
    const mode = routingMode(request.config);
    if (mode === "pi" || mode === "pi-session") {
      return {
        requested: false,
        available: false,
        substrate: "pi",
        reason: "pi_sdk_compact_requires_live_agent_session_not_attached",
        api: "AgentSession.compact(customInstructions?)",
        details: {
          routingMode: mode,
          handoffPath: request.handoff?.latestPath,
          note: "Pi exposes AgentSession.compact(), but MindStone-Agent Gateway currently uses a stateless Pi provider path and does not own a live AgentSession handle to compact.",
        },
      };
    }

    return {
      requested: false,
      available: false,
      substrate: "none",
      reason: "substrate_compaction_not_available_for_routing_mode",
      details: {
        routingMode: mode,
        handoffPath: request.handoff?.latestPath,
      },
    };
  }
}

const gatewayCoordinator = new GatewaySubstrateCompactionCoordinator();

export function requestGatewaySubstrateCompaction(request: SubstrateCompactionRequest): SubstrateCompactionResult {
  return gatewayCoordinator.requestCompaction(request) as SubstrateCompactionResult;
}
