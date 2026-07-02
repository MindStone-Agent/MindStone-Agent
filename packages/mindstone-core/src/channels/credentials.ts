import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";

/**
 * Connector credential handling (issue #16): config carries REFS, never raw
 * secrets. A credential resolves from an env var or an isolated secret file;
 * status surfaces only presence + a masked preview.
 */
export type ConnectorCredentialRef = {
  /** Environment variable name holding the secret. */
  tokenEnv?: string;
  /** Path to a secret file (relative paths resolve under the runtime data dir). */
  tokenFile?: string;
};

export type ResolvedConnectorCredential =
  | { present: true; value: string; source: "env" | "file"; warning?: string }
  | { present: false; error?: string };

export function connectorCredentialRefFromChannelConfig(channelConfig: Record<string, unknown> | undefined): ConnectorCredentialRef | undefined {
  if (!channelConfig) return undefined;
  const tokenEnv = typeof channelConfig.tokenEnv === "string" && channelConfig.tokenEnv.trim() ? channelConfig.tokenEnv.trim() : undefined;
  const tokenFile = typeof channelConfig.tokenFile === "string" && channelConfig.tokenFile.trim() ? channelConfig.tokenFile.trim() : undefined;
  if (!tokenEnv && !tokenFile) return undefined;
  return { tokenEnv, tokenFile };
}

export function resolveConnectorCredential(
  ref: ConnectorCredentialRef | undefined,
  options: { env?: NodeJS.ProcessEnv; paths?: MindStoneRuntimePaths } = {},
): ResolvedConnectorCredential {
  if (!ref?.tokenEnv && !ref?.tokenFile) return { present: false, error: "no credential ref configured (tokenEnv or tokenFile)" };
  const env = options.env ?? process.env;

  if (ref.tokenEnv) {
    const value = env[ref.tokenEnv]?.trim();
    if (value) return { present: true, value, source: "env" };
    if (!ref.tokenFile) return { present: false, error: `env var ${ref.tokenEnv} is unset or empty` };
  }

  if (ref.tokenFile) {
    const paths = options.paths ?? runtimePathsFromEnv(env);
    const path = isAbsolute(ref.tokenFile) ? ref.tokenFile : resolve(paths.dataDir, ref.tokenFile);
    if (!existsSync(path)) return { present: false, error: `secret file not found: ${path}` };
    const value = readFileSync(path, "utf-8").trim();
    if (!value) return { present: false, error: `secret file is empty: ${path}` };
    const mode = statSync(path).mode & 0o777;
    const warning = (mode & 0o077) !== 0 ? `secret file ${path} is group/world-readable (mode ${mode.toString(8)}); chmod 600 recommended` : undefined;
    return { present: true, value, source: "file", warning };
  }

  return { present: false, error: "credential ref did not resolve" };
}

/** Safe preview for status/doctor output — never the value. */
export function maskCredential(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`;
}
