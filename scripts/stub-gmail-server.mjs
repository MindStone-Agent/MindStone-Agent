#!/usr/bin/env node
// Local stub of the Gmail REST API + OAuth token endpoint for smoke tests
// (issue #21). Implements the connector's exact call surface:
//   POST /token                                  -> OAuth refresh->access exchange
//   GET  /gmail/v1/users/me/profile              -> mailbox identity
//   GET  /gmail/v1/users/me/messages?q=...       -> scoped message-id list
//   GET  /gmail/v1/users/me/messages/:id         -> full message
//   GET  /gmail/v1/users/me/threads/:id          -> thread with messages
//   POST /gmail/v1/users/me/messages/send        -> capture the raw MIME send
// plus test control endpoints:
//   POST /_test/push   {from, subject, body, threadId?} -> add a mailbox message
//   POST /_test/fail   {count}                  -> fail the next N sends (HTTP 500)
//   GET  /_test/sent                            -> captured sends (raw + decoded MIME)
//   GET  /_test/state                           -> token exchanges + observed queries
// Every /gmail/* call requires a Bearer token previously issued by /token —
// the exchange itself (client id/secret/refresh token) is part of the smoke.

import { createServer } from "node:http";

const PORT = Number(process.env.STUB_GMAIL_PORT ?? "19819");
const CLIENT_ID = process.env.STUB_GMAIL_CLIENT_ID ?? "stub-client-id";
const CLIENT_SECRET = process.env.STUB_GMAIL_CLIENT_SECRET ?? "stub-client-secret";
const REFRESH_TOKEN = process.env.STUB_GMAIL_REFRESH_TOKEN ?? "stub-refresh-token";
const SELF_ADDRESS = "agent@stub.local";

let messages = [];
let sent = [];
let queries = [];
let failNextSends = 0;
let messageSeq = 1;
let tokenSeq = 0;
const issuedTokens = new Set();

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function base64Url(text) {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function bearerOk(req) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return issuedTokens.has(token);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    // --- test controls ---
    if (req.method === "POST" && url.pathname === "/_test/push") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = body.id ?? `m${messageSeq++}`;
      const threadId = body.threadId ?? `t-${id}`;
      const text = body.body ?? "";
      messages.push({
        id,
        threadId,
        snippet: text.slice(0, 80),
        internalDate: String(Date.now()),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: body.from ?? "someone@example.com" },
            { name: "Subject", value: body.subject ?? "(no subject)" },
            { name: "Date", value: new Date().toUTCString() },
            { name: "Message-ID", value: `<${id}@stub.local>` },
          ],
          body: { data: base64Url(text) },
        },
      });
      json(res, 200, { ok: true, id, threadId });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_test/fail") {
      const body = JSON.parse((await readBody(req)) || "{}");
      failNextSends = Number(body.count ?? 1);
      json(res, 200, { ok: true, failNextSends });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/sent") {
      json(res, 200, { ok: true, sent });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/state") {
      json(res, 200, { ok: true, exchanges: tokenSeq, queries });
      return;
    }

    // --- OAuth token endpoint ---
    if (req.method === "POST" && url.pathname === "/token") {
      const params = new URLSearchParams(await readBody(req));
      if (
        params.get("client_id") !== CLIENT_ID ||
        params.get("client_secret") !== CLIENT_SECRET ||
        params.get("refresh_token") !== REFRESH_TOKEN ||
        params.get("grant_type") !== "refresh_token"
      ) {
        json(res, 401, { error: "invalid_grant" });
        return;
      }
      const token = `stub-access-${++tokenSeq}`;
      issuedTokens.add(token);
      json(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
      return;
    }

    // --- Gmail API surface (Bearer-gated) ---
    if (url.pathname.startsWith("/gmail/")) {
      if (!bearerOk(req)) {
        json(res, 401, { error: { message: "Invalid Credentials" } });
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/gmail/v1/users/me/profile") {
      json(res, 200, { emailAddress: SELF_ADDRESS });
      return;
    }
    if (req.method === "GET" && url.pathname === "/gmail/v1/users/me/messages") {
      queries.push(url.searchParams.get("q") ?? "");
      json(res, 200, { messages: messages.map((entry) => ({ id: entry.id, threadId: entry.threadId })) });
      return;
    }
    const messageMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && messageMatch) {
      const found = messages.find((entry) => entry.id === decodeURIComponent(messageMatch[1]));
      if (!found) {
        json(res, 404, { error: { message: "Not Found" } });
        return;
      }
      json(res, 200, found);
      return;
    }
    const threadMatch = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && threadMatch) {
      const threadId = decodeURIComponent(threadMatch[1]);
      json(res, 200, { id: threadId, messages: messages.filter((entry) => entry.threadId === threadId) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/gmail/v1/users/me/messages/send") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (failNextSends > 0) {
        failNextSends -= 1;
        json(res, 500, { error: { message: "stub-injected delivery failure" } });
        return;
      }
      const decoded = body.raw ? Buffer.from(body.raw, "base64url").toString("utf-8") : "";
      sent.push({ raw: body.raw, threadId: body.threadId, decoded });
      json(res, 200, { id: `sent-${sent.length}` });
      return;
    }

    json(res, 404, { error: { message: `Unknown path: ${url.pathname}` } });
  } catch (error) {
    json(res, 500, { error: { message: String(error) } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-gmail listening on http://127.0.0.1:${PORT} (self: ${SELF_ADDRESS})`);
});
