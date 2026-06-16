import type { ContextManagementPolicy } from "../context/index.js";

export type GatewayAuthConfig =
  | { mode: "none" }
  | { mode: "token"; tokenFile?: string; tokenEnv?: string }
  | { mode: "password"; passwordEnv?: string };

export type MindStoneAgentConfig = {
  id: string;
  identityPath?: string;
  userPath?: string;
  defaultModel?: string;
  /** Configured maximum context window for the agent's current/default model. */
  contextWindowTokens?: number;
};

export type MindStoneMemoryConfig = {
  autoRecall?: boolean;
  vectorStore?: "lancedb" | "sqlite-vec" | "memory";
  embeddingProvider?: string;
};

export type MindStoneConfig = {
  workspace?: { root?: string };
  gateway?: {
    host?: string;
    port?: number;
    auth?: GatewayAuthConfig;
    http?: {
      chatCompletions?: { enabled?: boolean };
      responses?: { enabled?: boolean };
    };
  };
  agents?: Record<string, MindStoneAgentConfig>;
  channels?: Record<string, unknown>;
  memory?: MindStoneMemoryConfig;
  contextManagement?: ContextManagementPolicy;
};
