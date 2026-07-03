#!/usr/bin/env bash
set -euo pipefail

# KB external sources smoke (issue #23):
#   1. unit assertions: external-source config parsing (fail-closed), Obsidian
#      wikilink normalization, deterministic HTML extraction
#   2. end-to-end: a KB mixing a LOCAL source + a FOLDER source (Obsidian-ish
#      fixture outside the KB) + a URL source (local stub doc server):
#      ingest -> citations carry provenance (origin path / URL) + sensitivity;
#      search hits preserve citations (AC2); status shows folder mtime
#      staleness AND url refreshMs staleness; re-ingest refreshes; URLs are
#      fetched at INGEST TIME ONLY (fetch counter); recall documents are
#      labeled REFERENCE MATERIAL, not memory (AC3) and carry origin +
#      sensitivity metadata — asserted on a real mock-routed chat turn
#   Binds stub port 19822 — serialize per smoke protocol (no gateway needed).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-kbsrc-smoke.XXXXXX")"
STUB_PORT="19822"
STUB_URL="http://127.0.0.1:${STUB_PORT}"

cleanup() {
  if [[ -n "${stub_pid:-}" ]]; then
    kill "${stub_pid}" >/dev/null 2>&1 || true
    wait "${stub_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export STUB_DOC_PORT="${STUB_PORT}"

cd "${PROJECT_ROOT}"

echo "== KB external sources smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-kbsrc-init.log

RUNTIME_DATA="${TEMP_RUNTIME}/mindstone"
KB_DIR="${RUNTIME_DATA}/knowledgebases"
FIXTURES="${TEMP_RUNTIME}/vault"

# --- 1. Unit assertions ---
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { extractHtmlText, normalizeWikilinks, parseExternalSources } from "./packages/mindstone-core/src/knowledgebase/sources.ts";

// Config parsing fails closed: bad entries dropped, valid ones normalized.
const parsed = parseExternalSources([
  { id: "notes", type: "folder", path: "/tmp/x", sensitivity: "internal" },
  { id: "docs", type: "url", url: "https://example.com/a", refreshMs: 60000 },
  { id: "bad1", type: "url", url: "ftp://nope" },
  { id: "bad2", type: "folder" },
  { type: "url", url: "https://no-id.example" },
  "not-an-object",
]);
assert.equal(parsed.length, 2);
assert.deepEqual(parsed.map((s) => s.id), ["notes", "docs"]);
assert.equal(parsed[0].sensitivity, "internal");
assert.equal(parsed[1].refreshMs, 60000);
assert.deepEqual(parseExternalSources(undefined), []);
assert.deepEqual(parseExternalSources("garbage"), []);

// Obsidian wikilinks: [[X]] -> X, [[X|Y]] -> Y, ![[embed]] -> embed.
assert.equal(normalizeWikilinks("See [[Reactor Notes]] and [[ops/checklist|the checklist]]."), "See Reactor Notes and the checklist.");
assert.equal(normalizeWikilinks("![[diagram.png]] stays textual"), "diagram.png stays textual");
assert.equal(normalizeWikilinks("no links here"), "no links here");

// HTML extraction: title captured, h2 -> sections, script/nav dropped, entities decoded.
const html = "<html><head><title>T &amp; Co</title><style>x{}</style></head><body><nav>menu</nav><h1>Main</h1><p>Intro &quot;quoted&quot;.</p><h2>Alpha</h2><p>Body A</p><script>evil()</script></body></html>";
const extracted = extractHtmlText(html);
assert.equal(extracted.title, "T & Co");
assert.ok(extracted.markdown.includes("# Main"));
assert.ok(extracted.markdown.includes("## Alpha"));
assert.ok(extracted.markdown.includes('Intro "quoted".'));
assert.ok(!extracted.markdown.includes("evil"));
assert.ok(!extracted.markdown.includes("menu"));
console.log("kb source parsing + wikilink + html extraction unit assertions passed");
TS

# --- 2. End-to-end ---
node scripts/stub-doc-server.mjs >/tmp/mindstone-agent-kbsrc-stub.log 2>&1 &
stub_pid=$!
for _ in $(seq 1 20); do
  curl -s "${STUB_URL}/_test/state" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -s "${STUB_URL}/_test/state" >/dev/null 2>&1 || { echo "stub-doc never came up" >&2; exit 1; }

# Seed: mock routing + auto-recall, an Obsidian-ish folder fixture OUTSIDE the
# KB, and a KB with one local source + folder & url external sources.
node <<NODE
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const runtime = \`\${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone\`;
const configPath = \`\${runtime}/config.json\`;
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routing = { mode: "mock", defaultAgentId: "default", defaultModel: "mindstone/mock", mock: { responsePrefix: "Mock response" } };
config.session = { mode: "single", defaultSessionKey: "agent:default:main" };
config.memory = { autoRecall: true };
writeFileSync(configPath, \`\${JSON.stringify(config, null, 2)}\n\`);

const vault = \`\${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/vault\`;
mkdirSync(\`\${vault}/ops\`, { recursive: true });
writeFileSync(\`\${vault}/reactor-notes.md\`, [
  "# Reactor Notes",
  "",
  "Vault-level overview of the Zephyr-9 program. See [[ops/quench-checklist|the quench checklist]].",
  "",
  "## Coil Maintenance",
  "",
  "Superconducting coils need quarterly cryo inspection.",
].join("\n"));
writeFileSync(\`\${vault}/ops/quench-checklist.md\`, [
  "# Quench Checklist",
  "",
  "## Emergency Venting",
  "",
  "Vent helium through the north manifold first.",
].join("\n"));

const kb = \`\${runtime}/knowledgebases/fusion\`;
mkdirSync(\`\${kb}/sources\`, { recursive: true });
writeFileSync(\`\${kb}/kb.json\`, JSON.stringify({
  name: "Fusion Ops",
  description: "Fusion program references",
  externalSources: [
    { id: "vault", type: "folder", path: vault, sensitivity: "internal" },
    { id: "guide", type: "url", url: \`http://127.0.0.1:\${process.env.STUB_DOC_PORT}/guide.html\`, sensitivity: "public", refreshMs: 800 },
  ],
}, null, 2));
writeFileSync(\`\${kb}/sources/local-intro.md\`, [
  "# Program Intro",
  "",
  "## Charter",
  "",
  "The fusion program charter lives here locally.",
].join("\n"));
NODE

MS="./scripts/mindstone"

# Ingest: local + folder + url sources land in one index.
${MS} kb ingest fusion --json > /tmp/kbsrc-ingest.json
grep -q '"sourceCount": 4' /tmp/kbsrc-ingest.json   # local-intro + 2 vault files + 1 url

INDEX="${KB_DIR}/fusion/index.json"
# Folder entries: virtual path, absolute origin, sensitivity, wikilink stripped.
grep -q '"sourcePath": "folder:vault/reactor-notes.md"' "${INDEX}"
# origin is the resolve()-normalized absolute path (TMPDIR may carry a
# trailing slash the provider normalizes away) — assert on the suffix.
grep -Eq '"origin": "/.*/vault/reactor-notes\.md"' "${INDEX}"
grep -q '"sensitivity": "internal"' "${INDEX}"
if grep -q '\[\[' "${INDEX}"; then echo "wikilinks must be normalized in indexed text" >&2; exit 1; fi
grep -q 'the quench checklist' "${INDEX}"
# URL entry: citation IS the url, title from <title>, fetchedAt recorded, no script text.
grep -q '"sourcePath": "url:guide"' "${INDEX}"
grep -q "\"citation\": \"http://127.0.0.1:${STUB_PORT}/guide.html § Plasma Startup\"" "${INDEX}"
grep -q '"sourceTitle": "Fusion Reactor Field Guide"' "${INDEX}"
grep -q '"fetchedAt"' "${INDEX}"
grep -q '"sensitivity": "public"' "${INDEX}"
if grep -q 'should never be ingested' "${INDEX}"; then echo "script content leaked into index" >&2; exit 1; fi

# AC2: citations + provenance survive SEARCH.
${MS} kb search fusion "plasma torch dampener" --json > /tmp/kbsrc-search-url.json
grep -q "guide.html § Plasma Startup" /tmp/kbsrc-search-url.json
grep -q '"sensitivity": "public"' /tmp/kbsrc-search-url.json
${MS} kb search fusion "cryo inspection coils" --json > /tmp/kbsrc-search-folder.json
grep -q '"citation": "folder:vault/reactor-notes.md § Coil Maintenance"' /tmp/kbsrc-search-folder.json
grep -q '"sensitivity": "internal"' /tmp/kbsrc-search-folder.json

# Refresh policy: everything fresh right after ingest...
${MS} kb status fusion --json > /tmp/kbsrc-status-1.json
if grep -q '"state": "stale"' /tmp/kbsrc-status-1.json; then echo "nothing should be stale immediately after ingest" >&2; exit 1; fi
# ...then folder mtime bump -> stale; url goes stale after refreshMs (800ms).
sleep 1.1
touch "${FIXTURES}/reactor-notes.md"
${MS} kb status fusion --json > /tmp/kbsrc-status-2.json
node -e '
const s = JSON.parse(require("node:fs").readFileSync("/tmp/kbsrc-status-2.json", "utf8"));
const by = Object.fromEntries(s.sources.map((x) => [x.sourcePath, x.state]));
if (by["folder:vault/reactor-notes.md"] !== "stale") { console.error("folder mtime bump must show stale, got", by["folder:vault/reactor-notes.md"]); process.exit(1); }
if (by["folder:vault/ops/quench-checklist.md"] !== "indexed") { console.error("untouched folder file must stay indexed"); process.exit(1); }
if (by["url:guide"] !== "stale") { console.error("url past refreshMs must show stale, got", by["url:guide"]); process.exit(1); }
if (by["local-intro.md"] !== "indexed") { console.error("local source must stay indexed"); process.exit(1); }
'
# Re-ingest refreshes both.
${MS} kb ingest fusion --json > /dev/null
${MS} kb status fusion --json > /tmp/kbsrc-status-3.json
node -e '
const s = JSON.parse(require("node:fs").readFileSync("/tmp/kbsrc-status-3.json", "utf8"));
const stale = s.sources.filter((x) => x.state !== "indexed");
if (stale.length) { console.error("re-ingest must refresh everything, still off:", JSON.stringify(stale)); process.exit(1); }
'

# URLs are fetched at INGEST TIME ONLY: exactly 2 fetches (two ingests) despite
# searches + status calls in between.
FETCHES="$(curl -s "${STUB_URL}/_test/state" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).fetches))')"
test "${FETCHES}" -eq 2

# AC3: recall documents are labeled reference material with provenance — and
# the label reaches a REAL mock-routed chat turn's recall injection.
MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" MINDSTONE_AGENT_DATA_DIR="${RUNTIME_DATA}" npx tsx <<'TS'
import assert from "node:assert/strict";
import { discoverKnowledgebaseRecallDocuments } from "@mindstone-agent/core";
const docs = discoverKnowledgebaseRecallDocuments();
const urlDoc = docs.find((doc) => doc.metadata?.sourcePath === "url:guide")!;
assert.ok(urlDoc, "url source must produce a recall document");
assert.equal(urlDoc.kind, "kb");
assert.ok(urlDoc.title.startsWith("[KB Fusion Ops]"));
assert.ok(urlDoc.text.includes("Reference material (not memory)"), "AC3 label missing");
assert.ok(urlDoc.text.includes("Sensitivity: public"));
assert.equal(urlDoc.metadata?.origin, `http://127.0.0.1:${process.env.STUB_DOC_PORT}/guide.html`);
assert.equal(urlDoc.path, `http://127.0.0.1:${process.env.STUB_DOC_PORT}/guide.html`, "external recall doc path is its origin");
const folderDoc = docs.find((doc) => String(doc.metadata?.sourcePath ?? "").startsWith("folder:vault/reactor-notes"))!;
assert.equal(folderDoc.metadata?.sensitivity, "internal");
console.log("recall-document labeling assertions passed");
TS
${MS} chat --once "How do I handle plasma startup and the dampener checklist on the Zephyr-9?" > /tmp/kbsrc-chat.log
grep -rq 'memory_recall_injected' "${RUNTIME_DATA}/transcripts/"
# A KB-sourced document (external url source) was among the injected hits.
# (The injected doc TEXT — which carries the reference-material label proven
# above — is transient prompt context and deliberately not persisted.)
grep -rq 'kb:fusion' "${RUNTIME_DATA}/transcripts/"

echo "KB external sources smoke test passed."
