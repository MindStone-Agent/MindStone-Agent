#!/usr/bin/env node
// Local stub of the Telegram Bot API for smoke tests (issue #17).
// Implements the connector's exact call surface (getMe / getUpdates /
// sendMessage) plus test control endpoints:
//   POST /_test/push   {update}          -> queue an update for getUpdates
//   POST /_test/fail   {count}           -> fail the next N sendMessage calls (HTTP 500)
//   GET  /_test/sent                     -> messages accepted by sendMessage
// Token check: any /bot<token>/ path where <token> === STUB_TELEGRAM_TOKEN
// (default "stub-token") is accepted; anything else gets Telegram's 401 shape.

import { createServer } from "node:http";

const PORT = Number(process.env.STUB_TELEGRAM_PORT ?? "19813");
const TOKEN = process.env.STUB_TELEGRAM_TOKEN ?? "stub-token";

let updates = [];
let sent = [];
let failNextSends = 0;
let updateSeq = 1;

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/_test/push") {
      const body = await readBody(req);
      const update = { update_id: updateSeq++, ...body };
      updates.push(update);
      json(res, 200, { ok: true, update_id: update.update_id });
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

    const botMatch = /^\/bot([^/]+)\/(.+)$/.exec(url.pathname);
    if (!botMatch) {
      json(res, 404, { ok: false, description: "Not Found" });
      return;
    }
    if (botMatch[1] !== TOKEN) {
      json(res, 401, { ok: false, description: "Unauthorized" });
      return;
    }
    const method = botMatch[2];

    if (method === "getMe") {
      json(res, 200, { ok: true, result: { id: 999001, is_bot: true, first_name: "StubBot", username: "mindstone_stub_bot" } });
      return;
    }
    if (method === "getUpdates") {
      const body = await readBody(req);
      const offset = Number(body.offset ?? 0);
      const batch = updates.filter((update) => update.update_id >= offset);
      json(res, 200, { ok: true, result: batch });
      return;
    }
    if (method === "sendMessage") {
      const body = await readBody(req);
      if (failNextSends > 0) {
        failNextSends -= 1;
        json(res, 500, { ok: false, description: "stub-injected delivery failure" });
        return;
      }
      sent.push(body);
      json(res, 200, { ok: true, result: { message_id: 5000 + sent.length } });
      return;
    }
    json(res, 404, { ok: false, description: `Unknown method: ${method}` });
  } catch (error) {
    json(res, 500, { ok: false, description: String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-telegram listening on http://127.0.0.1:${PORT} (token: ${TOKEN})`);
});
