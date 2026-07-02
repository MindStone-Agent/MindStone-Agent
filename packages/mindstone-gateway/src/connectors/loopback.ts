import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectorDataDir,
  registerConnector,
  type ConnectorContext,
  type ConnectorInboundHandle,
  type ConnectorInboundMessage,
  type ConnectorOutboundMessage,
  type MindStoneConnector,
} from "@mindstone-agent/core";

/**
 * Loopback reference connector (issue #16) — the first end-to-end
 * implementation of the shared connector contract and the template for
 * production connectors (#17+).
 *
 * Transport is a local file spool (no network, no external service):
 *   inbound:  <dataDir>/connectors/loopback/inbox.jsonl  (append one JSON
 *             ConnectorInboundMessage per line; the listener polls for new lines)
 *   outbound: <dataDir>/connectors/loopback/outbox.jsonl (sendOutbound appends)
 *
 * Everything else — credential refs, allowlist/pairing, trigger policy,
 * session mapping, delivery queue, runtime status — is the shared framework,
 * exercised exactly as a production connector would.
 */

const DEFAULT_POLL_MS = 150;

function spoolDir(ctx: ConnectorContext): string {
  const configured = typeof ctx.channelConfig.spoolDir === "string" && ctx.channelConfig.spoolDir.trim() ? ctx.channelConfig.spoolDir.trim() : undefined;
  return configured ?? connectorDataDir("loopback");
}

function parseInboundLine(line: string): ConnectorInboundMessage | undefined {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && typeof (parsed as ConnectorInboundMessage).text === "string") {
      return parsed as ConnectorInboundMessage;
    }
  } catch {
    // malformed lines are skipped, not fatal
  }
  return undefined;
}

export const LOOPBACK_CONNECTOR: MindStoneConnector = {
  id: "loopback",
  meta: {
    id: "loopback",
    label: "Loopback (reference)",
    blurb: "File-spool reference connector proving the shared connector contract end-to-end without external services.",
  },
  capabilities: { chatTypes: ["direct", "group"], nativeCommands: false },

  async startInbound(ctx, onMessage): Promise<ConnectorInboundHandle> {
    const dir = spoolDir(ctx);
    mkdirSync(dir, { recursive: true });
    const inboxPath = join(dir, "inbox.jsonl");
    const pollMs = typeof ctx.channelConfig.pollMs === "number" && ctx.channelConfig.pollMs > 0 ? ctx.channelConfig.pollMs : DEFAULT_POLL_MS;

    // Start from the current end of the inbox — only NEW lines are consumed.
    let offset = existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8").length : 0;
    let draining = false;
    let stopped = false;

    const drain = async () => {
      if (draining || stopped) return;
      draining = true;
      try {
        if (existsSync(inboxPath)) {
          const content = readFileSync(inboxPath, "utf-8");
          if (content.length > offset) {
            const fresh = content.slice(offset);
            // Only consume complete lines; a partial trailing line waits for the next poll.
            const lastNewline = fresh.lastIndexOf("\n");
            if (lastNewline !== -1) {
              offset += lastNewline + 1;
              for (const line of fresh.slice(0, lastNewline).split("\n")) {
                if (!line.trim()) continue;
                const message = parseInboundLine(line);
                if (message) await onMessage(message);
              }
            }
          }
        }
      } finally {
        draining = false;
      }
    };

    const timer = setInterval(() => {
      void drain();
    }, pollMs);
    timer.unref?.();

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  },

  async sendOutbound(ctx, message: ConnectorOutboundMessage): Promise<void> {
    const dir = spoolDir(ctx);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "outbox.jsonl"), `${JSON.stringify(message)}\n`);
  },

  async probe(ctx) {
    const dir = spoolDir(ctx);
    try {
      mkdirSync(dir, { recursive: true });
      return { ok: true, detail: `spool at ${dir}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};

registerConnector(LOOPBACK_CONNECTOR);
