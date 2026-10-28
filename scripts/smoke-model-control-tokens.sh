#!/usr/bin/env bash
# Model control tokens in text no longer break requests that carry an image.
# A fetched model card can quote a chat template (`<｜deepseek_image｜>`, `<|image|>`). With an
# image in the same request, Ollama cloud counts two image slots for one image and answers 500,
# and the text stays in the session, so every later turn fails too. Every provider request is
# now sent with those tokens' angle brackets made full-width; the session keeps the original.
#
# The stub provider below behaves like the cloud did: 500 for an image plus a raw token, 200
# otherwise. It runs real Pi (vendor/pi must be built: npm run build:pi).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-control-tokens.XXXXXX")"
cleanup() { rm -rf "${TEMP_ROOT}"; }
trap cleanup EXIT
export TEMP_ROOT

cd "${PROJECT_ROOT}"
echo "== Model control tokens smoke test =="
npm run build:mindstone >/dev/null

echo "-- the helper"
npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  neutralizeModelControlTokens as n,
  neutralizeModelControlTokensDeep as deep,
  neutralizeProviderPayload,
} from "./packages/mindstone-core/src/index.ts";

assert.equal(n("a <｜deepseek_image｜> b"), "a ＜｜deepseek_image｜＞ b");
assert.equal(n("<｜tool▁calls▁begin｜>"), "＜｜tool▁calls▁begin｜＞");
assert.equal(n("x <|image|> y"), "x ＜|image|＞ y");
assert.equal(n("<|begin_of_text|><|eot_id|>"), "＜|begin_of_text|＞＜|eot_id|＞");
const template = "{{ '<｜deepseek_image｜>' }} ... {{ '<｜deepseek_image｜>' }}";
assert.equal(n(template).match(/＜｜deepseek_image｜＞/g)?.length, 2, "every occurrence");
for (const text of ["hello", "a < b and c > d", "<image> [IMG] <start_of_image>", '<img src="x.png"> <div class="a|b">', "ls | grep x > out.txt", "a <| b |> c", "<||>"]) {
  assert.equal(n(text), text, `left alone: ${text}`);
}

const input = { url: "u", n: 3, ok: true, none: null, list: ["<|image|>", { q: "<｜x｜>" }] };
assert.deepEqual(deep(input), { url: "u", n: 3, ok: true, none: null, list: ["＜|image|＞", { q: "＜｜x｜＞" }] });
assert.equal(input.list[0], "<|image|>", "the input is not modified");
const bytes = new Uint8Array([60, 124, 105, 124, 62]);
const withBytes = deep({ image: { bytes }, text: "<|image|>" }) as { image: { bytes: Uint8Array }; text: string };
assert.equal(withBytes.image.bytes, bytes, "byte arrays (Bedrock images) are kept as they are");
assert.equal(withBytes.text, "＜|image|＞");
const payload = { messages: [{ role: "user", content: [{ type: "text", text: "<|image|>" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
assert.deepEqual(neutralizeProviderPayload(payload), { messages: [{ role: "user", content: [{ type: "text", text: "＜|image|＞" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] });
console.log("helper: ok");
TS

echo "-- both gateway seams, through real Pi to a stub provider"
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiMindStoneProvider, PiSessionExecutor, piSessionFileForKey } from "./packages/mindstone-gateway/dist/index.js";
import { SessionManager } from "./vendor/pi/packages/coding-agent/dist/core/session-manager.js";

const RAW = ["<｜deepseek_image｜>", "<|image|>"];
const bodies = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    bodies.push(body);
    const hasImage = body.includes("data:image/");
    if (hasImage && RAW.some((token) => body.includes(JSON.stringify(token).slice(1, -1)) || body.includes(token))) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Internal Server Error", type: "api_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "vision", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: "assistant", content: "stub-ok" }, null));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const root = process.env.TEMP_ROOT;
const agentDir = join(root, "pi-agent");
const sessionDir = join(root, "pi-sessions");
const cwd = join(root, "work");
for (const dir of [agentDir, sessionDir, cwd]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    stub: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "stub-key",
      models: [{ id: "vision", name: "vision", input: ["text", "image"], contextWindow: 128000, maxTokens: 1024 }],
    },
  },
}));

// History as an agent would have it: a photo earlier, then a fetched model card quoting the template.
const sessionKey = "agent:default:main";
const sessionFile = piSessionFileForKey(sessionDir, sessionKey);
mkdirSync(join(sessionFile, ".."), { recursive: true });
const seeded = SessionManager.open(sessionFile, sessionDir, cwd);
const now = Date.now();
seeded.appendMessage({ role: "user", content: [{ type: "text", text: "Here's a photo." }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], timestamp: now });
seeded.appendMessage({ role: "assistant", content: [{ type: "text", text: "A model card says the template uses <｜deepseek_image｜> for images." }], api: "openai-completions", provider: "stub", model: "vision", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: now + 1 });
assert.ok(readFileSync(sessionFile, "utf8").includes("deepseek_image"), "the seeded session holds the token");

const model = { id: "stub/vision", provider: "stub", name: "vision" };
const executor = new PiSessionExecutor({ projectRoot: process.cwd(), agentDir, sessionDir, cwd, defaultProvider: "stub", defaultModel: "vision", noExtensions: true, noSkills: true });
const result = await executor.completeChat({
  agentId: "default",
  sessionKey,
  model,
  messages: [{ role: "system", text: "System note: <|image|> is a token." }, { role: "user", text: "Which is it, <｜deepseek_image｜> or <|image|>?" }],
  transcriptEntries: [],
});
const sessionBody = bodies.at(-1);
assert.ok(sessionBody, "the session sent a request");
assert.ok(sessionBody.includes("data:image/png;base64,iVBORw0KGgo="), "the photo is still sent");
for (const token of RAW) assert.ok(!sessionBody.includes(token), `session request has no raw ${token}`);
assert.ok(sessionBody.includes("＜｜deepseek_image｜＞") && sessionBody.includes("＜|image|＞"), "tokens arrive with full-width brackets");
assert.equal(result.text, "stub-ok", `the session turn succeeded (got ${JSON.stringify(result.text)})`);
assert.ok(readFileSync(sessionFile, "utf8").includes("<｜deepseek_image｜>"), "the stored session keeps the original text");
console.log("session seam: ok");

const provider = new PiMindStoneProvider({ projectRoot: process.cwd(), agentDir, defaultProvider: "stub", defaultModel: "vision" });
const before = bodies.length;
const direct = await provider.completeChat({ agentId: "default", sessionKey: "direct", model, messages: [{ role: "user", text: "Template: <｜deepseek_image｜> <|image|>" }], transcriptEntries: [] });
const directBody = bodies.at(-1);
assert.equal(bodies.length, before + 1, "the provider sent one request");
for (const token of RAW) assert.ok(!directBody.includes(token), `direct request has no raw ${token}`);
assert.equal(direct.text, "stub-ok");
console.log("direct provider seam: ok");
server.close();
NODE
echo "== Model control tokens smoke test passed =="
