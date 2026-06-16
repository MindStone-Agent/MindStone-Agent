import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  appendTranscriptEntry,
  decideGatewayAuth,
  getMindStoneSystemStatus,
  listTranscriptSessions,
  loadMindStoneConfig,
  readTranscriptEntries,
  resolveConfigPath,
  resolveGatewayAuthRequirement,
  resolveSessionKey,
  runtimePathsFromEnv,
  type MindStoneConfig,
  type TranscriptRole,
} from "@mindstone-agent/core";

export type GatewayOptions = {
  host?: string;
  port?: number;
};

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function loadGatewayConfig(): ReturnType<typeof loadMindStoneConfig> {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath(process.env, paths);
  return loadMindStoneConfig(configPath);
}

function openAiError(message: string, type: string, code: string): { error: { message: string; type: string; code: string } } {
  return { error: { message, type, code } };
}

function isChatCompletionsEnabled(config: MindStoneConfig | undefined): boolean {
  return config?.gateway?.http?.chatCompletions?.enabled === true;
}

function openAiModels(config: MindStoneConfig | undefined): unknown {
  const agents = config?.agents ?? {};
  const data = Object.entries(agents).map(([agentId, agent]) => ({
    id: agent.defaultModel ?? `mindstone/${agentId}`,
    object: "model",
    created: 0,
    owned_by: "mindstone-agent",
  }));
  return {
    object: "list",
    data: data.length > 0 ? data : [{ id: "mindstone/default", object: "model", created: 0, owned_by: "mindstone-agent" }],
  };
}

function isTranscriptRole(value: unknown): value is TranscriptRole {
  return ["user", "assistant", "tool", "system", "event"].includes(String(value));
}

function transcriptTextFromOpenAiContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part !== "object" || part === null) return undefined;
        const record = part as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") return record.text;
        return undefined;
      })
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

function openAiRoleToTranscriptRole(role: unknown): TranscriptRole {
  if (role === "system" || role === "assistant" || role === "tool") return role;
  return "user";
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.trim().length > 0 ? JSON.parse(text) : {};
}

function enforceGatewayAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath(process.env, paths);
  const loadedConfig = loadMindStoneConfig(configPath);
  const requirement = resolveGatewayAuthRequirement({
    config: loadedConfig.config?.gateway?.auth,
    configPath,
  });
  const decision = decideGatewayAuth(requirement, req.headers);
  if (decision.allowed) return true;

  sendJson(
    res,
    decision.status,
    { ok: false, error: decision.reason },
    decision.challenge ? { "www-authenticate": decision.challenge } : {},
  );
  return false;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "mindstone-agent-gateway",
      version: "0.0.0",
      paths: runtimePathsFromEnv(),
    });
    return;
  }

  if (!enforceGatewayAuth(req, res)) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    const status = getMindStoneSystemStatus();
    sendJson(res, status.ok ? 200 : 503, {
      service: "mindstone-agent-gateway",
      version: "0.0.0",
      ...status,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat/sessions") {
    sendJson(res, 200, {
      ok: true,
      sessions: listTranscriptSessions(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat/history") {
    const sessionKey = url.searchParams.get("sessionKey")?.trim();
    if (!sessionKey) {
      sendJson(res, 400, { ok: false, error: "sessionKey is required" });
      return;
    }
    const limitText = url.searchParams.get("limit");
    const limit = limitText ? Number(limitText) : undefined;
    sendJson(res, 200, {
      ok: true,
      sessionKey,
      entries: readTranscriptEntries(sessionKey, Number.isFinite(limit) ? { limit } : {}),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/send") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const input = body as Record<string, unknown>;
    const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    const text = typeof input.text === "string" ? input.text : "";
    if (!sessionKey || !agentId || !text.trim()) {
      sendJson(res, 400, { ok: false, error: "sessionKey, agentId, and text are required" });
      return;
    }
    const userEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "user",
      text,
      metadata: typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : undefined,
    });
    const eventEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: "MindStone routing is not implemented yet; message persisted but no assistant run was started.",
      parentId: userEntry.id,
      metadata: { event: "routing_not_implemented" },
    });
    sendJson(res, 501, {
      ok: false,
      error: "MindStone routing is not implemented yet",
      code: "not_implemented",
      persisted: true,
      entries: [userEntry, eventEntry],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/abort") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const input = body as Record<string, unknown>;
    const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    if (!sessionKey || !agentId) {
      sendJson(res, 400, { ok: false, error: "sessionKey and agentId are required" });
      return;
    }
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: "Abort requested, but no active run manager is implemented yet.",
      metadata: { event: "abort_requested", runId: typeof input.runId === "string" ? input.runId : undefined },
    });
    sendJson(res, 202, {
      ok: true,
      aborted: false,
      reason: "No active run manager is implemented yet",
      entry,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/inject") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const input = body as Record<string, unknown>;
    const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    const role = input.role;
    if (!sessionKey || !agentId || !isTranscriptRole(role)) {
      sendJson(res, 400, { ok: false, error: "sessionKey, agentId, and valid role are required" });
      return;
    }
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role,
      text: typeof input.text === "string" ? input.text : undefined,
      content: input.content,
      metadata: typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : undefined,
    });
    sendJson(res, 201, { ok: true, entry });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const loadedConfig = loadGatewayConfig();
    if (loadedConfig.error) {
      sendJson(res, 503, openAiError(loadedConfig.error, "config_error", "config_error"));
      return;
    }
    if (!isChatCompletionsEnabled(loadedConfig.config)) {
      sendJson(res, 404, openAiError("OpenAI-compatible chat completions are disabled", "disabled", "disabled"));
      return;
    }
    sendJson(res, 200, openAiModels(loadedConfig.config));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const loadedConfig = loadGatewayConfig();
    if (loadedConfig.error) {
      sendJson(res, 503, openAiError(loadedConfig.error, "config_error", "config_error"));
      return;
    }
    if (!isChatCompletionsEnabled(loadedConfig.config)) {
      sendJson(res, 404, openAiError("OpenAI-compatible chat completions are disabled", "disabled", "disabled"));
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, openAiError(error instanceof Error ? error.message : String(error), "invalid_request_error", "invalid_json"));
      return;
    }

    const input = body as Record<string, unknown>;
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (messages.length === 0) {
      sendJson(res, 400, openAiError("messages must be a non-empty array", "invalid_request_error", "invalid_messages"));
      return;
    }

    const metadata = typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : {};
    const metadataSessionKey = typeof metadata.sessionKey === "string" ? metadata.sessionKey : undefined;
    const model = typeof input.model === "string" ? input.model : "mindstone/default";
    const agentId = typeof metadata.agentId === "string" ? metadata.agentId : "default";
    const sessionKey = metadataSessionKey ?? resolveSessionKey({
      agentId,
      substrate: "openai",
      senderId: typeof input.user === "string" ? input.user : model,
    });

    const persistedEntries = messages.map((message, index) => {
      const record = typeof message === "object" && message !== null ? message as Record<string, unknown> : {};
      return appendTranscriptEntry({
        sessionKey,
        agentId,
        role: openAiRoleToTranscriptRole(record.role),
        text: transcriptTextFromOpenAiContent(record.content),
        content: record.content,
        metadata: {
          source: "openai-chat-completions",
          model,
          messageIndex: index,
          originalRole: record.role,
        },
      });
    });
    const eventEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: "OpenAI-compatible chat completions are not connected to MindStone routing yet.",
      metadata: { event: "routing_not_implemented", source: "openai-chat-completions", model },
    });

    sendJson(res, 501, {
      ...openAiError(
        "OpenAI-compatible chat completions are scaffolded but not connected to MindStone routing yet",
        "not_implemented",
        "not_implemented",
      ),
      mindstone: {
        persisted: true,
        sessionKey,
        entries: [...persistedEntries, eventEntry],
      },
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

export async function startGateway(options: GatewayOptions = {}): Promise<{ close(): Promise<void>; url: string }> {
  const host = options.host ?? process.env.MINDSTONE_AGENT_GATEWAY_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.MINDSTONE_AGENT_GATEWAY_PORT ?? "19789");
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
