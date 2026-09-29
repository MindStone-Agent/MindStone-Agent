#!/usr/bin/env bash
# A persona's private KB URLs (#125, #142 review): refused when they point at
# this machine or a private network, by name, by resolved address and on every
# redirect; and a fetched page must be HTML, markdown or plain text, within the
# size and time limits. Errors never carry a socket error code or a redirect
# target.
#   - add time: loopback, private, link-local and intranet hosts in every
#     spelling the URL parser folds (decimal, hex, octal, short, mapped IPv6,
#     trailing dot) are refused; the host's opt-out allows them
#   - fetch time: a loopback URL stored anyway is refused; a redirect to a
#     refused host is refused; a name that resolves to a refused address is
#     refused; too many redirects, a binary type, NUL bytes, a gzip bomb, a
#     stalled body, a 404 and a closed port each fail in general terms
#   - a global KB's URL (the CLI's `kb ingest`) is fetched as before
# Tests on this machine swap the host policy (`refusedHost`) so that the stub
# on 127.0.0.1 counts as public and 127.0.0.2 as private. No gateway, no
# ports beyond an ephemeral stub. Synthetic data only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-kb-url-guard-smoke.XXXXXX")"
trap 'rm -rf "${TEMP_RUNTIME}"' EXIT
export KB_GUARD_DIR="${TEMP_RUNTIME}"
cd "${PROJECT_ROOT}"
echo "== Private KB URL guard smoke test =="

npx tsx <<'TS'
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { loadUrlSourceDocument } from "./packages/mindstone-core/src/knowledgebase/sources.ts";
import { addPrivateKnowledgebaseSource, createPrivateKnowledgebase, PersonaComposeError } from "./packages/mindstone-core/src/persona/compose.ts";

// --- Add time.
const personaDir = join(process.env.KB_GUARD_DIR!, "personas", "guard");
mkdirSync(personaDir, { recursive: true });
writeFileSync(join(personaDir, "PERSONA.md"), "# Guard\n");
createPrivateKnowledgebase(personaDir, { id: "notes" });
const refusedAtAdd = [
  "http://2130706433:1/doc.md", "http://localhost/doc", "http://127.1/doc", "http://0x7f000001/doc",
  "http://017700000001/doc", "http://[::ffff:127.0.0.1]/doc", "http://localhost./doc", "http://0.0.0.0/doc",
  "http://169.254.169.254/latest/meta-data", "http://10.1.2.3/doc", "http://192.168.1.1/doc", "http://[::1]/doc",
  "http://[fd00::1]/doc", "http://intranet/doc", "http://wiki.corp/doc",
];
refusedAtAdd.forEach((url, index) => {
  assert.throws(
    () => addPrivateKnowledgebaseSource(personaDir, "notes", { kind: "url", name: `u${index}`, url }),
    (error) => error instanceof PersonaComposeError && error.code === "invalid_source" && /public address/.test(error.message),
    `adding ${url} must be refused`,
  );
});
assert.deepEqual(addPrivateKnowledgebaseSource(personaDir, "notes", { kind: "url", name: "public", url: "https://example.com/doc" }), { kind: "url", name: "public" });
assert.deepEqual(
  addPrivateKnowledgebaseSource(personaDir, "notes", { kind: "url", name: "stub", url: "http://127.0.0.1:9/doc" }, { allowPrivateHosts: true }),
  { kind: "url", name: "stub" },
  "the host's opt-out allows a private host",
);
console.log("add-time checks ok");

// --- Fetch time, against a stub on 127.0.0.1.
let loopHits = 0;
const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, "a"));
const server = createServer((req, res) => {
  const path = req.url ?? "/";
  if (path === "/doc.md") { res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }); res.end("# Doc\n\nThe guard reference is KBGUARD-4242.\n"); return; }
  if (path === "/redir-ok") { res.writeHead(302, { location: "/doc.md" }); res.end(); return; }
  if (path === "/redir-private") { res.writeHead(302, { location: `http://127.0.0.2:${port}/secret-target` }); res.end(); return; }
  if (path.startsWith("/loop/")) { loopHits += 1; res.writeHead(302, { location: `/loop/${Number(path.slice(6)) + 1}` }); res.end(); return; }
  if (path === "/bin") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end("binary"); return; }
  if (path === "/nul") { res.writeHead(200, { "content-type": "text/plain" }); res.end("text\u0000more"); return; }
  if (path === "/bomb") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); res.end(bomb); return; }
  if (path === "/stall") { res.writeHead(200, { "content-type": "text/plain" }); res.write("partial"); return; }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("missing");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const source = (id: string, url: string) => ({ id, type: "url" as const, url });
// On this machine: 127.0.0.1 counts as public, 127.0.0.2 as private.
const only127002 = { allowPrivateHosts: false, refusedHost: (host: string) => host === "127.0.0.2" };
const fetchWith = (url: string, privateKb: object, extra: object = {}) => loadUrlSourceDocument(source("s", url), { privateKb: privateKb as never, ...extra });
const refusedWith = async (what: string, promise: Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, pattern, what);
    assert.doesNotMatch(error.message, /E[A-Z]{3,}|127\.0\.0\.2|secret-target/, `${what}: the error must not name a socket code or the redirect target`);
    return true;
  }, what);
};

// The real policy refuses the stub itself: it is on this machine.
await refusedWith("a loopback URL stored anyway", fetchWith(`${base}/doc.md`, { allowPrivateHosts: false }), /on this machine or a private network/);
// With 127.0.0.1 counted as public: a page, and a redirect to a page, are fetched.
assert.match((await fetchWith(`${base}/doc.md`, only127002)).raw, /KBGUARD-4242/);
assert.match((await fetchWith(`${base}/redir-ok`, only127002)).raw, /KBGUARD-4242/);
// A redirect to a refused host is refused, before any connection to it.
await refusedWith("a redirect to a private host", fetchWith(`${base}/redir-private`, only127002), /redirected to this machine or a private network/);
// A name is refused by what it resolves to: "localhost" is allowed by name here, its addresses aren't.
const byAddress = { allowPrivateHosts: false, refusedHost: (host: string) => host === "127.0.0.1" || host === "::1" };
await refusedWith("a name that resolves to a refused address", fetchWith(`http://localhost:${port}/doc.md`, byAddress), /on this machine or a private network/);
assert.match((await fetchWith(`http://localhost:${port}/doc.md`, { allowPrivateHosts: false, refusedHost: () => false })).raw, /KBGUARD-4242/, "control: the same name with nothing refused is fetched");
// At most 5 redirects.
await refusedWith("a redirect loop", fetchWith(`${base}/loop/0`, only127002), /redirected too many times/);
assert.equal(loopHits, 6, "the first request and 5 redirects, then it stops");
// Only text.
await refusedWith("a binary type", fetchWith(`${base}/bin`, only127002), /is not HTML, markdown or plain text/);
await refusedWith("NUL bytes", fetchWith(`${base}/nul`, only127002), /is not text/);
await refusedWith("a gzip bomb", fetchWith(`${base}/bomb`, only127002, { maxBytes: 1024 * 1024 }), /larger than 1048576 bytes/);
const started = Date.now();
await refusedWith("a stalled body", fetchWith(`${base}/stall`, only127002, { timeoutMs: 500 }), /timed out/);
assert.ok(Date.now() - started < 3000, "the time limit holds for the body too");
await refusedWith("a 404", fetchWith(`${base}/missing`, only127002), /HTTP 404/);
// A closed port: said in general terms, never ECONNREFUSED.
const closed = createServer();
await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
const closedPort = (closed.address() as { port: number }).port;
await new Promise<void>((done) => closed.close(() => done()));
await refusedWith("a closed port", fetchWith(`http://127.0.0.1:${closedPort}/doc.md`, only127002), /could not be fetched/);
// The host's opt-out: the stub is fetched with the real policy switched off.
assert.match((await fetchWith(`${base}/doc.md`, { allowPrivateHosts: true })).raw, /KBGUARD-4242/);
// A global KB's URL (no privateKb) is fetched as before.
assert.match((await loadUrlSourceDocument(source("g", `${base}/doc.md`))).raw, /KBGUARD-4242/);
server.close();
console.log("fetch-time checks ok");
TS

echo "Private KB URL guard smoke test passed."
