import type { GatewayAuthConfig, MindStoneConfig } from "../config/index.js";

export type MindStoneGatewayStatus = {
  host: string;
  port: number;
  baseUrl: string;
  auth: {
    mode: GatewayAuthConfig["mode"];
    required: boolean;
    source: string;
  };
  http: {
    modelsEnabled: boolean;
    chatCompletionsEnabled: boolean;
    responsesEnabled: boolean;
  };
  routes: {
    health: "/health";
    status: "/status";
    rpc: "/rpc";
    websocketRpc: "/rpc";
    websocketAlias: "/ws";
    webchat: "/webchat";
    chatCompletions: "/v1/chat/completions";
    responses: "/v1/responses";
  };
};

function authSource(auth: GatewayAuthConfig | undefined): string {
  if (!auth || auth.mode === "none") return "not required";
  if (auth.mode === "token") {
    if (auth.tokenEnv) return `token env ${auth.tokenEnv}`;
    if (auth.tokenFile) return "token file configured";
    return "token env MINDSTONE_AGENT_GATEWAY_TOKEN";
  }
  return `password env ${auth.passwordEnv ?? "MINDSTONE_AGENT_GATEWAY_PASSWORD"}`;
}

export function getMindStoneGatewayStatus(config: MindStoneConfig | undefined): MindStoneGatewayStatus {
  const host = config?.gateway?.host ?? "127.0.0.1";
  const port = config?.gateway?.port ?? 19789;
  const auth = config?.gateway?.auth ?? { mode: "none" as const };
  const chatCompletionsEnabled = config?.gateway?.http?.chatCompletions?.enabled === true;
  const responsesEnabled = config?.gateway?.http?.responses?.enabled === true;
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    auth: {
      mode: auth.mode,
      required: auth.mode !== "none",
      source: authSource(auth),
    },
    http: {
      modelsEnabled: chatCompletionsEnabled || responsesEnabled,
      chatCompletionsEnabled,
      responsesEnabled,
    },
    routes: {
      health: "/health",
      status: "/status",
      rpc: "/rpc",
      websocketRpc: "/rpc",
      websocketAlias: "/ws",
      webchat: "/webchat",
      chatCompletions: "/v1/chat/completions",
      responses: "/v1/responses",
    },
  };
}
