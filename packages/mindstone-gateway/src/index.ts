import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getMindStoneSystemStatus, runtimePathsFromEnv } from "@mindstone-agent/core";

export type GatewayOptions = {
  host?: string;
  port?: number;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
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

  if (req.method === "GET" && url.pathname === "/status") {
    const status = getMindStoneSystemStatus();
    sendJson(res, status.ok ? 200 : 503, {
      service: "mindstone-agent-gateway",
      version: "0.0.0",
      ...status,
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

export async function startGateway(options: GatewayOptions = {}): Promise<{ close(): Promise<void>; url: string }> {
  const host = options.host ?? process.env.MINDSTONE_AGENT_GATEWAY_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.MINDSTONE_AGENT_GATEWAY_PORT ?? "19789");
  const server = createServer(handleRequest);
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
