import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { GatewayRunManager } from "./run-manager.js";
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


type GatewayRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

function rpcSuccess(id: GatewayRpcRequest["id"], result: unknown): unknown {
  return { id: id ?? null, ok: true, result };
}

function rpcError(id: GatewayRpcRequest["id"], code: string, message: string): unknown {
  return { id: id ?? null, ok: false, error: { code, message } };
}

function labelMessage(label: unknown, message: string): string {
  return typeof label === "string" && label.trim() ? `[${label.trim()}]\n\n${message}` : message;
}

const runManager = new GatewayRunManager();

function abortGatewayRuns(sessionKey: string, runId: unknown): { aborted: boolean; reason: string; runs: unknown[] } {
  const results = typeof runId === "string" && runId.trim()
    ? [runManager.abort(runId.trim())]
    : runManager.abortSession(sessionKey);
  const aborted = results.some((result) => result.aborted);
  const firstMiss = results.find((result) => !result.aborted);
  return {
    aborted,
    reason: aborted ? "aborted" : firstMiss && !firstMiss.aborted ? firstMiss.reason : "not_found",
    runs: results.map((result) => result.run).filter(Boolean),
  };
}

type GatewayRpcExecution = {
  status: number;
  body: unknown;
};

async function executeGatewayRpc(rpc: GatewayRpcRequest): Promise<GatewayRpcExecution> {
  const id = rpc.id;
  const method = rpc.method;
  const params = typeof rpc.params === "object" && rpc.params !== null ? rpc.params as Record<string, unknown> : {};
  if (!method) {
    return { status: 400, body: rpcError(id, "invalid_request", "method is required") };
  }

  if (method === "chat.sessions") {
    return { status: 200, body: rpcSuccess(id, { sessions: listTranscriptSessions() }) };
  }

  if (method === "chat.history") {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    if (!sessionKey) {
      return { status: 400, body: rpcError(id, "invalid_request", "sessionKey is required") };
    }
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    return {
      status: 200,
      body: rpcSuccess(id, { sessionKey, entries: readTranscriptEntries(sessionKey, limit ? { limit } : {}) }),
    };
  }

  if (method === "chat.inject") {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "default";
    const message = typeof params.message === "string" ? params.message : typeof params.text === "string" ? params.text : "";
    if (!sessionKey || !message.trim()) {
      return { status: 400, body: rpcError(id, "invalid_request", "sessionKey and message are required") };
    }
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "assistant",
      text: labelMessage(params.label, message),
      metadata: { source: "gateway-rpc", method: "chat.inject" },
    });
    return { status: 200, body: rpcSuccess(id, { ok: true, entry }) };
  }

  if (method === "chat.send") {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "default";
    const message = typeof params.message === "string" ? params.message : typeof params.text === "string" ? params.text : "";
    if (!sessionKey || !message.trim()) {
      return { status: 400, body: rpcError(id, "invalid_request", "sessionKey and message are required") };
    }
    const userEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "user",
      text: message,
      metadata: { source: "gateway-rpc", method: "chat.send" },
    });
    const eventEntry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: "MindStone routing is not implemented yet; message persisted but no assistant run was started.",
      parentId: userEntry.id,
      metadata: { event: "routing_not_implemented", source: "gateway-rpc", method: "chat.send" },
    });
    return {
      status: 200,
      body: rpcSuccess(id, {
        ok: false,
        code: "not_implemented",
        persisted: true,
        entries: [userEntry, eventEntry],
      }),
    };
  }

  if (method === "chat.abort") {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "default";
    if (!sessionKey) {
      return { status: 400, body: rpcError(id, "invalid_request", "sessionKey is required") };
    }
    const abort = abortGatewayRuns(sessionKey, params.runId);
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: abort.aborted ? "Abort requested and active run aborted." : "Abort requested, but no active run was found.",
      metadata: {
        event: "abort_requested",
        source: "gateway-rpc",
        method: "chat.abort",
        runId: typeof params.runId === "string" ? params.runId : undefined,
        abortReason: abort.reason,
      },
    });
    return { status: 200, body: rpcSuccess(id, { ok: true, aborted: abort.aborted, reason: abort.reason, runs: abort.runs, entry }) };
  }

  return { status: 404, body: rpcError(id, "method_not_found", `Unknown Gateway RPC method: ${method}`) };
}

async function handleGatewayRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, rpcError(null, "invalid_json", error instanceof Error ? error.message : String(error)));
    return;
  }

  const result = await executeGatewayRpc(body as GatewayRpcRequest);
  sendJson(res, result.status, result.body);
}

function writeWebSocketFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    const length = BigInt(payload.length);
    header.push(
      127,
      Number((length >> 56n) & 0xffn),
      Number((length >> 48n) & 0xffn),
      Number((length >> 40n) & 0xffn),
      Number((length >> 32n) & 0xffn),
      Number((length >> 24n) & 0xffn),
      Number((length >> 16n) & 0xffn),
      Number((length >> 8n) & 0xffn),
      Number(length & 0xffn),
    );
  }
  socket.write(Buffer.concat([Buffer.from(header), payload]));
}

function writeWebSocketJson(socket: Socket, body: unknown): void {
  writeWebSocketFrame(socket, 0x1, Buffer.from(JSON.stringify(body), "utf-8"));
}

function closeWebSocket(socket: Socket, code = 1000, reason = ""): void {
  const reasonBuffer = Buffer.from(reason, "utf-8");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  writeWebSocketFrame(socket, 0x8, payload);
  socket.end();
}

function acceptWebSocket(req: IncomingMessage, socket: Socket): boolean {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !key.trim()) return false;
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  return true;
}

function rejectWebSocket(socket: Socket, status: number, message: string): void {
  const body = `${message}\n`;
  socket.write([
    `HTTP/1.1 ${status} ${message}`,
    "content-type: text/plain; charset=utf-8",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
    "",
    body,
  ].join("\r\n"));
  socket.end();
}

function authorizeGatewayUpgrade(req: IncomingMessage, socket: Socket): boolean {
  const paths = runtimePathsFromEnv();
  const configPath = resolveConfigPath(process.env, paths);
  const loadedConfig = loadMindStoneConfig(configPath);
  const requirement = resolveGatewayAuthRequirement({
    config: loadedConfig.config?.gateway?.auth,
    configPath,
  });
  const decision = decideGatewayAuth(requirement, req.headers);
  if (decision.allowed) return true;
  rejectWebSocket(socket, decision.status, decision.reason);
  return false;
}

async function handleWebSocketText(socket: Socket, text: string): Promise<void> {
  let request: GatewayRpcRequest;
  try {
    request = JSON.parse(text) as GatewayRpcRequest;
  } catch (error) {
    writeWebSocketJson(socket, rpcError(null, "invalid_json", error instanceof Error ? error.message : String(error)));
    return;
  }

  const result = await executeGatewayRpc(request);
  writeWebSocketJson(socket, result.body);
}

function attachGatewayRpcWebSocket(socket: Socket): void {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          closeWebSocket(socket, 1009, "frame too large");
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      offset += maskLength;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x8) {
        closeWebSocket(socket);
        return;
      }
      if (opcode === 0x9) {
        writeWebSocketFrame(socket, 0xA, payload);
        continue;
      }
      if (opcode !== 0x1) {
        closeWebSocket(socket, 1003, "unsupported frame");
        return;
      }

      void handleWebSocketText(socket, payload.toString("utf-8")).catch((error: unknown) => {
        writeWebSocketJson(socket, rpcError(null, "internal_error", error instanceof Error ? error.message : String(error)));
      });
    }
  });
}

function handleGatewayUpgrade(req: IncomingMessage, socket: Socket): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/rpc" && url.pathname !== "/ws") {
    rejectWebSocket(socket, 404, "not found");
    return;
  }
  if (!authorizeGatewayUpgrade(req, socket)) return;
  if (!acceptWebSocket(req, socket)) {
    rejectWebSocket(socket, 400, "bad websocket request");
    return;
  }
  attachGatewayRpcWebSocket(socket);
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

  if (req.method === "POST" && url.pathname === "/rpc") {
    await handleGatewayRpc(req, res);
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
    const abort = abortGatewayRuns(sessionKey, input.runId);
    const entry = appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: abort.aborted ? "Abort requested and active run aborted." : "Abort requested, but no active run was found.",
      metadata: {
        event: "abort_requested",
        runId: typeof input.runId === "string" ? input.runId : undefined,
        abortReason: abort.reason,
      },
    });
    sendJson(res, 202, {
      ok: true,
      aborted: abort.aborted,
      reason: abort.reason,
      runs: abort.runs,
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
  server.on("upgrade", (req, socket) => {
    handleGatewayUpgrade(req, socket as Socket);
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
