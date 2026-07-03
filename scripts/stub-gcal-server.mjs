#!/usr/bin/env node
// Local stub of the Google Calendar API + OAuth token endpoint for smoke
// tests (issue #22). Implements the connector's exact call surface:
//   POST /token                                          -> OAuth refresh->access
//   GET  /calendar/v3/calendars/:id/events               -> upcoming list
//   POST /calendar/v3/calendars/:id/events               -> insert (create)
//   PATCH /calendar/v3/calendars/:id/events/:eventId     -> patch (update)
// plus test control endpoints:
//   POST /_test/seed    {event}   -> seed an upcoming event for list calls
//   POST /_test/fail    {count}   -> fail the next N mutations (HTTP 500)
//   GET  /_test/created           -> captured inserts
//   GET  /_test/patched           -> captured patches
//   GET  /_test/state             -> token exchanges + observed list queries
// Every /calendar/* call requires a Bearer token issued by /token.

import { createServer } from "node:http";

const PORT = Number(process.env.STUB_GCAL_PORT ?? "19821");
const CLIENT_ID = process.env.STUB_GCAL_CLIENT_ID ?? "stub-gcal-client-id";
const CLIENT_SECRET = process.env.STUB_GCAL_CLIENT_SECRET ?? "stub-gcal-client-secret";
const REFRESH_TOKEN = process.env.STUB_GCAL_REFRESH_TOKEN ?? "stub-gcal-refresh-token";

let events = [];
let created = [];
let patched = [];
let listQueries = [];
let failNextMutations = 0;
let tokenSeq = 0;
let eventSeq = 1;
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

function bearerOk(req) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return issuedTokens.has(token);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    // --- test controls ---
    if (req.method === "POST" && url.pathname === "/_test/seed") {
      const body = JSON.parse((await readBody(req)) || "{}");
      events.push({ id: body.id ?? `ev${eventSeq++}`, ...body });
      json(res, 200, { ok: true, count: events.length });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_test/fail") {
      const body = JSON.parse((await readBody(req)) || "{}");
      failNextMutations = Number(body.count ?? 1);
      json(res, 200, { ok: true, failNextMutations });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/created") {
      json(res, 200, { ok: true, created });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/patched") {
      json(res, 200, { ok: true, patched });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_test/state") {
      json(res, 200, { ok: true, exchanges: tokenSeq, listQueries });
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
      const token = `stub-gcal-access-${++tokenSeq}`;
      issuedTokens.add(token);
      json(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
      return;
    }

    // --- Calendar API surface (Bearer-gated) ---
    if (url.pathname.startsWith("/calendar/")) {
      if (!bearerOk(req)) {
        json(res, 401, { error: { message: "Invalid Credentials" } });
        return;
      }
    }
    const eventsMatch = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (eventsMatch && req.method === "GET") {
      listQueries.push(Object.fromEntries(url.searchParams.entries()));
      json(res, 200, { items: events });
      return;
    }
    if (eventsMatch && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (failNextMutations > 0) {
        failNextMutations -= 1;
        json(res, 500, { error: { message: "stub-injected mutation failure" } });
        return;
      }
      const event = { id: `created-${created.length + 1}`, ...body };
      created.push(event);
      json(res, 200, event);
      return;
    }
    const patchMatch = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname);
    if (patchMatch && req.method === "PATCH") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (failNextMutations > 0) {
        failNextMutations -= 1;
        json(res, 500, { error: { message: "stub-injected mutation failure" } });
        return;
      }
      patched.push({ eventId: decodeURIComponent(patchMatch[2]), body });
      json(res, 200, { id: decodeURIComponent(patchMatch[2]), ...body });
      return;
    }

    json(res, 404, { error: { message: `Unknown path: ${url.pathname}` } });
  } catch (error) {
    json(res, 500, { error: { message: String(error) } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-gcal listening on http://127.0.0.1:${PORT}`);
});
