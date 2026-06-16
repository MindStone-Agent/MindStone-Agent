import { existsSync, readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import type { GatewayAuthConfig } from "../config/index.js";
import { resolvePathRelativeToConfig } from "../config/index.js";

export type GatewayAuthRequirement =
  | { enabled: false; mode: "none" }
  | { enabled: true; mode: "token"; token: string }
  | { enabled: true; mode: "password"; password: string }
  | { enabled: true; mode: "misconfigured"; error: string };

export type GatewayAuthDecision = {
  allowed: boolean;
  status: number;
  reason: string;
  challenge?: string;
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readRequiredEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function readTokenFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf-8").trim();
  return value.length > 0 ? value : undefined;
}

export function resolveGatewayAuthRequirement(input: {
  config?: GatewayAuthConfig;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}): GatewayAuthRequirement {
  const env = input.env ?? process.env;
  const config = input.config ?? { mode: "none" };

  if (config.mode === "none") {
    return { enabled: false, mode: "none" };
  }

  if (config.mode === "token") {
    const tokenEnv = config.tokenEnv ?? "MINDSTONE_AGENT_GATEWAY_TOKEN";
    const envToken = readRequiredEnv(tokenEnv, env);
    if (envToken) {
      return { enabled: true, mode: "token", token: envToken };
    }

    if (config.tokenFile) {
      const tokenPath = resolvePathRelativeToConfig(config.tokenFile, input.configPath);
      const fileToken = readTokenFile(tokenPath);
      if (fileToken) {
        return { enabled: true, mode: "token", token: fileToken };
      }
      return { enabled: true, mode: "misconfigured", error: `Gateway token file is missing or empty: ${tokenPath}` };
    }

    return { enabled: true, mode: "misconfigured", error: `Gateway token env var is not set: ${tokenEnv}` };
  }

  const passwordEnv = config.passwordEnv ?? "MINDSTONE_AGENT_GATEWAY_PASSWORD";
  const password = readRequiredEnv(passwordEnv, env);
  if (!password) {
    return { enabled: true, mode: "misconfigured", error: `Gateway password env var is not set: ${passwordEnv}` };
  }
  return { enabled: true, mode: "password", password };
}

function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const authorization = firstHeader(headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function basicPassword(headers: IncomingHttpHeaders): string | undefined {
  const authorization = firstHeader(headers.authorization);
  const match = authorization?.match(/^Basic\s+(.+)$/i);
  if (!match?.[1]) return undefined;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf-8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : decoded;
  } catch {
    return undefined;
  }
}

export function decideGatewayAuth(
  requirement: GatewayAuthRequirement,
  headers: IncomingHttpHeaders,
): GatewayAuthDecision {
  if (!requirement.enabled) {
    return { allowed: true, status: 200, reason: "auth disabled" };
  }

  if (requirement.mode === "misconfigured") {
    return { allowed: false, status: 500, reason: requirement.error };
  }

  if (requirement.mode === "token") {
    const suppliedToken = bearerToken(headers) ?? firstHeader(headers["x-mindstone-token"]);
    if (suppliedToken === requirement.token) {
      return { allowed: true, status: 200, reason: "token accepted" };
    }
    return {
      allowed: false,
      status: 401,
      reason: "missing or invalid bearer token",
      challenge: "Bearer",
    };
  }

  const suppliedPassword = basicPassword(headers) ?? firstHeader(headers["x-mindstone-password"]);
  if (suppliedPassword === requirement.password) {
    return { allowed: true, status: 200, reason: "password accepted" };
  }
  return {
    allowed: false,
    status: 401,
    reason: "missing or invalid gateway password",
    challenge: 'Basic realm="MindStone-Agent Gateway"',
  };
}
