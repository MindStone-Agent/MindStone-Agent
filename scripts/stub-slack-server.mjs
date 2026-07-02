#!/usr/bin/env node
// Local stub of the Slack Web API + Socket Mode for smoke tests (issue #18).
// Web API surface used by the connector: auth.test, apps.connections.open,
// chat.postMessage. Socket Mode: a minimal RFC6455 WebSocket server at /link
// that sends `hello` on connect, delivers pushed event envelopes, and records
// the connector's envelope acks.
//
// Test controls:
//   POST /_test/push       {event}  -> deliver an events_api envelope
//   POST /_test/fail       {count}  -> fail next N chat.postMessage calls
//   POST /_test/disconnect          -> send a {type:"disconnect"} envelope
//   GET  /_test/sent                -> chat.postMessage bodies accepted
//   GET  /_test/acks                -> envelope acks received over the socket

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.STUB_SLACK_PORT ?? "19815");
const BOT_TOKEN = process.env.STUB_SLACK_BOT_TOKEN ?? "xoxb-stub";
const APP_TOKEN = process.env.STUB_SLACK_APP_TOKEN ?? "xapp-stub";
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let sent = [];
let acks = [];
let failNextSends = 0;
let envelopeSeq = 1;
let pendingEnvelopes = [];
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

function bearer(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

// --- minimal RFC6455 server side ---
function wsSend(socket, payload) {
  const data = Buffer.from(JSON.stringify(payload), "utf-8");
  const header = [0x81];
  if (data.length < 126) header.push(data.length);
  else {
    header.push(126, (data.length >> 8) & 0xff, data.length & 0xff);
  }
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

function deliverEnvelope(envelope) {
  if (activeSocket) wsSend(activeSocket, envelope);
  else pendingEnvelopes.push(envelope);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/_test/push") {
      const body = await readBody(req);
      deliverEnvelope({ envelope_id: `env-${envelopeSeq++}`, type: "events_api", payload: { event: body.event ?? body } });
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_test/fail") {
      const body = await readBody(req);
      failNextSends = Number(body.count ?? 1);
      json(res, 200, { ok: true, failNextSends });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_test/disconnect") {
      deliverEnvelope({ type: "disconnect", reason: "test" });
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/sent") {
      json(res, 200, { ok: true, sent });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/acks") {
      json(res, 200, { ok: true, acks });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth.test") {
      if (bearer(req) !== BOT_TOKEN) {
        json(res, 200, { ok: false, error: "invalid_auth" });
        return;
      }
      json(res, 200, { ok: true, user: "mindstone_bot", user_id: "U0BOT", bot_id: "B0STUB" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/apps.connections.open") {
      if (bearer(req) !== APP_TOKEN) {
        json(res, 200, { ok: false, error: "invalid_auth" });
        return;
      }
      json(res, 200, { ok: true, url: `ws://127.0.0.1:${PORT}/link` });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat.postMessage") {
      if (bearer(req) !== BOT_TOKEN) {
        json(res, 200, { ok: false, error: "invalid_auth" });
        return;
      }
      const body = await readBody(req);
      if (failNextSends > 0) {
        failNextSends -= 1;
        json(res, 200, { ok: false, error: "stub_injected_failure" });
        return;
      }
      sent.push(body);
      json(res, 200, { ok: true, ts: `${Date.now() / 1000}` });
      return;
    }
    json(res, 404, { ok: false, error: "unknown_path" });
  } catch (error) {
    json(res, 500, { ok: false, error: String(error) });
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/link") {
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
    try {
      acks.push(JSON.parse(text));
    } catch {
      acks.push({ raw: text });
    }
  });
  socket.on("close", () => {
    if (activeSocket === socket) activeSocket = undefined;
  });
  wsSend(socket, { type: "hello", num_connections: 1 });
  for (const envelope of pendingEnvelopes.splice(0)) wsSend(socket, envelope);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-slack listening on http://127.0.0.1:${PORT} (bot: ${BOT_TOKEN}, app: ${APP_TOKEN})`);
});
