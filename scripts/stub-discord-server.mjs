#!/usr/bin/env node
// Local stub of the Discord REST API + Gateway WebSocket for smoke tests
// (issue #19). REST surface used by the connector: /users/@me, /gateway/bot,
// /channels/:id/messages. Gateway WS at /gw implements the protocol slice the
// connector speaks: op 10 hello -> expects op 2 identify (recorded, incl.
// intents) -> READY dispatch; op 1 heartbeats recorded and acked with op 11;
// pushed MESSAGE_CREATE dispatches delivered.
//
// Test controls:
//   POST /_test/push        {message}  -> MESSAGE_CREATE dispatch
//   POST /_test/fail        {count}    -> fail next N channel message posts (HTTP 500)
//   GET  /_test/sent                   -> messages accepted by the REST send
//   GET  /_test/identifies             -> identify payloads received (intents!)
//   GET  /_test/heartbeats             -> count of op 1 heartbeats received

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.STUB_DISCORD_PORT ?? "19817");
const TOKEN = process.env.STUB_DISCORD_TOKEN ?? "discord-stub-token";
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HEARTBEAT_INTERVAL_MS = 400;

let sent = [];
let identifies = [];
let heartbeats = 0;
let failNextSends = 0;
let sequenceCounter = 1;
let pendingDispatches = [];
let activeSocket;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function botAuth(req) {
  return (req.headers.authorization ?? "") === `Bot ${TOKEN}`;
}

function wsSend(socket, payload) {
  const data = Buffer.from(JSON.stringify(payload), "utf-8");
  const header = [0x81];
  if (data.length < 126) header.push(data.length);
  else header.push(126, (data.length >> 8) & 0xff, data.length & 0xff);
  socket.write(Buffer.concat([Buffer.from(header), data]));
}

function wsAttachParser(socket, onText) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      buffer = buffer.subarray(offset + maskLength + length);
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x1) onText(payload.toString("utf-8"));
    }
  });
}

function dispatch(event, data) {
  const frame = { op: 0, t: event, s: sequenceCounter++, d: data };
  if (activeSocket) wsSend(activeSocket, frame);
  else pendingDispatches.push(frame);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/_test/push") {
      const body = await readBody(req);
      dispatch("MESSAGE_CREATE", body.message ?? body);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_test/fail") {
      const body = await readBody(req);
      failNextSends = Number(body.count ?? 1);
      json(res, 200, { ok: true, failNextSends });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/sent") {
      json(res, 200, { ok: true, sent });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/identifies") {
      json(res, 200, { ok: true, identifies });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/heartbeats") {
      json(res, 200, { ok: true, heartbeats });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v10/users/@me") {
      if (!botAuth(req)) {
        json(res, 401, { message: "401: Unauthorized" });
        return;
      }
      json(res, 200, { id: "999002", username: "mindstone_stub_discord", bot: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v10/gateway/bot") {
      if (!botAuth(req)) {
        json(res, 401, { message: "401: Unauthorized" });
        return;
      }
      json(res, 200, { url: `ws://127.0.0.1:${PORT}/gw` });
      return;
    }
    const sendMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method === "POST" && sendMatch) {
      if (!botAuth(req)) {
        json(res, 401, { message: "401: Unauthorized" });
        return;
      }
      const body = await readBody(req);
      if (failNextSends > 0) {
        failNextSends -= 1;
        json(res, 500, { message: "stub-injected delivery failure" });
        return;
      }
      sent.push({ channel_id: sendMatch[1], ...body });
      json(res, 200, { id: `sent-${sent.length}` });
      return;
    }
    json(res, 404, { message: "Not Found" });
  } catch (error) {
    json(res, 500, { message: String(error) });
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/gw") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${key}${WS_MAGIC}`).digest("base64");
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"),
  );
  activeSocket = socket;
  wsAttachParser(socket, (text) => {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.op === 2) {
      identifies.push(frame.d);
      dispatch("READY", { user: { id: "999002", username: "mindstone_stub_discord" }, session_id: "stub-session" });
      for (const pending of pendingDispatches.splice(0)) wsSend(socket, pending);
      return;
    }
    if (frame.op === 1) {
      heartbeats += 1;
      wsSend(socket, { op: 11 });
    }
  });
  socket.on("close", () => {
    if (activeSocket === socket) activeSocket = undefined;
  });
  wsSend(socket, { op: 10, d: { heartbeat_interval: HEARTBEAT_INTERVAL_MS } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-discord listening on http://127.0.0.1:${PORT} (token: ${TOKEN})`);
});
