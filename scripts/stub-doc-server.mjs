#!/usr/bin/env node
// Local stub document server for KB url-source smoke tests (issue #23).
// Serves an HTML guide the connector ingests, and counts fetches so the smoke
// can prove URLs are fetched at INGEST TIME ONLY (never during search/status/
// recall):
//   GET /guide.html   -> HTML doc (title + h2 sections)
//   GET /_test/state  -> { fetches }

import { createServer } from "node:http";

const PORT = Number(process.env.STUB_DOC_PORT ?? "19822");

let fetches = 0;

const GUIDE_HTML = `<!doctype html>
<html>
<head><title>Fusion Reactor Field Guide</title><style>body{font:sans}</style></head>
<body>
<nav>Home | Docs</nav>
<h1>Fusion Reactor Field Guide</h1>
<p>Practical notes for the Zephyr-9 tokamak &amp; friends.</p>
<h2>Plasma Startup</h2>
<p>Warm the coils before igniting the plasma torch sequence.</p>
<p>Never skip the dampener checklist.</p>
<h2>Shutdown Procedure</h2>
<p>Vent the containment ring gradually to avoid quench events.</p>
<script>console.log("should never be ingested")</script>
</body>
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/_test/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ fetches }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/guide.html") {
    fetches += 1;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(GUIDE_HTML);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `Unknown path: ${url.pathname}` }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-doc listening on http://127.0.0.1:${PORT}`);
});
