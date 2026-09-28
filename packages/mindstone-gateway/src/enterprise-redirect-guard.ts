import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { enterpriseProviderOrigins } from "@mindstone-agent/core";

/**
 * Keeps an enterprise endpoint's key and headers at the address the admin
 * registered (#126 review). Pi's OpenAI and Azure clients call the global
 * fetch and follow redirects; on a redirect to another origin fetch drops
 * Authorization but keeps every other header, Azure's api-key and a
 * gateway's subscription key among them. For a request to a registered
 * enterprise origin this guard makes a redirect an error instead.
 *
 * Every class that runs Pi against an agent dir (the gateway's providers and
 * runners, and so `mindstone chat` and the TUI, which use them) registers its
 * agent dir here. The clients read the global fetch when they are built,
 * which Pi does per request. Pi run on its own (`scripts/pi-agent`) doesn't
 * load this module and isn't covered.
 */
const GUARDED = Symbol.for("mindstone.enterpriseRedirectGuard");
const agentDirs = new Map<string, { stamp: string; origins: Set<string> }>();

function stampOf(agentDir: string): string {
  return ["models.json", "auth.json"]
    .map((name) => {
      try {
        const stat = statSync(join(agentDir, name));
        return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

function guardedOrigins(): Set<string> {
  const all = new Set<string>();
  for (const [dir, entry] of agentDirs) {
    const stamp = stampOf(dir);
    if (entry.stamp !== stamp) {
      try {
        entry.origins = enterpriseProviderOrigins(dir);
        entry.stamp = stamp;
      } catch {
        // keep the last known set
      }
    }
    for (const origin of entry.origins) all.add(origin);
  }
  return all;
}

/** Forget the cached origins: called after the gateway writes models.json or auth.json. */
export function invalidateEnterpriseOrigins(): void {
  for (const entry of agentDirs.values()) entry.stamp = "";
}

export function guardEnterpriseEndpoints(agentDir: string): void {
  // The AWS SDK takes AWS_ENDPOINT_URL(_BEDROCK_RUNTIME) or a shared-config
  // endpoint_url ahead of the region, so a Bedrock API key could leave for an
  // address nobody registered (#126 review). This sets it for the whole process
  // and everything it starts, the agent's bash tool included: AWS endpoint
  // overrides on the host don't apply to anything the gateway or CLI runs.
  process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
  const dir = resolve(agentDir);
  if (!agentDirs.has(dir)) agentDirs.set(dir, { stamp: "", origins: new Set() });
  const original = globalThis.fetch as typeof fetch & { [GUARDED]?: true };
  if (!original || original[GUARDED]) return;
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    let origin: string | undefined;
    try {
      origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    } catch {
      origin = undefined;
    }
    if (!origin || !guardedOrigins().has(origin)) return original(input, init);
    if (input instanceof Request) return original(new Request(input, { redirect: "error" }), init ? { ...init, redirect: "error" } : undefined);
    return original(input, { ...init, redirect: "error" });
  }) as typeof fetch & { [GUARDED]?: true };
  guarded[GUARDED] = true;
  globalThis.fetch = guarded;
}
