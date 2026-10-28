#!/usr/bin/env bash
# Media-placeholder tokens in text no longer break requests that carry an image.
# A fetched model card can quote a chat template (`<｜deepseek_image｜>`, `<|image|>`). With an
# image in the same request, Ollama cloud counts two image slots for one image and answers 500,
# and the text stays in the session, so every later turn fails too. A request that carries an
# image is now sent with those tokens' angle brackets made full-width; the session keeps the
# original, a request with no image is sent unchanged, and other control tokens, tool
# definitions and signed blocks are never rewritten.
#
# The stub provider below behaves like the cloud did: 500 for an image plus a raw media token,
# 200 otherwise. It runs real Pi (vendor/pi must be built: npm run build:pi).
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

echo "-- the helper, the payload hook and the Pi adapter"
npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  neutralizeModelControlTokens as n,
  neutralizeModelControlTokensDeep as deep,
  neutralizeProviderPayload as hook,
  payloadCarriesImage,
} from "./packages/mindstone-core/src/index.ts";
import { guardPiSessionProviderPayloads } from "./packages/mindstone-gateway/src/pi-session-executor.ts";
import mindstoneAgentPiAdapter from "./packages/mindstone-pi-adapter/src/index.ts";

// Media placeholders are rewritten, in both shapes and any case.
assert.equal(n("a <｜deepseek_image｜> b"), "a ＜｜deepseek_image｜＞ b");
assert.equal(n("x <|image|> y"), "x ＜|image|＞ y");
assert.equal(n("<｜DEEPSEEK_IMAGE｜>"), "＜｜DEEPSEEK_IMAGE｜＞", "full-width shape, any case");
assert.equal(n("<|IMAGE_PAD|><|vision_start|><|video|><|audio_bos|><|img|>"), "＜|IMAGE_PAD|＞＜|vision_start|＞＜|video|＞＜|audio_bos|＞＜|img|＞");
const template = "{{ '<｜deepseek_image｜>' }} ... {{ '<｜deepseek_image｜>' }}";
assert.equal(n(template).match(/＜｜deepseek_image｜＞/g)?.length, 2, "every occurrence");
// Everything else is left alone: other control tokens (agents copy these into files), Gemma 4's
// one-sided tokens (they pass with an image), plain tags and ordinary text.
for (const text of [
  "<|im_end|>", "<|im_start|>user", "<｜tool▁calls▁begin｜>", "<｜begin▁of▁sentence｜><｜User｜>", "<|begin_of_text|><|eot_id|>",
  "<|image>", "<image|>", "<|turn>", "<|tool_call>",
  "hello", "a < b and c > d", "<image> [IMG] <start_of_image>", '<img src="x.png"> <div class="a|b">', "ls | grep x > out.txt", "a <| b |> c", "<||>",
]) {
  assert.equal(n(text), text, `left alone: ${text}`);
}

// The deep walk: input not modified, byte arrays kept, __proto__ keys kept, signed blocks byte-identical.
const input = { url: "u", n: 3, ok: true, none: null, list: ["<|image|>", { q: "<｜x_image｜>" }] };
assert.deepEqual(deep(input), { url: "u", n: 3, ok: true, none: null, list: ["＜|image|＞", { q: "＜｜x_image｜＞" }] });
assert.equal(input.list[0], "<|image|>", "the input is not modified");
const bytes = new Uint8Array([60, 124, 105, 124, 62]);
assert.equal((deep({ image: { bytes } }) as { image: { bytes: Uint8Array } }).image.bytes, bytes, "byte arrays (Bedrock images) are kept");
const protoArgs = JSON.parse('{"__proto__": {"x": "<|image|>"}, "y": 1}');
const protoOut = deep(protoArgs) as Record<string, unknown>;
assert.ok(Object.prototype.hasOwnProperty.call(protoOut, "__proto__"), "a __proto__ key in tool arguments is kept");
assert.equal(JSON.stringify(protoOut), '{"__proto__":{"x":"＜|image|＞"},"y":1}');
const signed = [
  { type: "thinking", thinking: "the template says <|image|>", signature: "SIGNED_abc" },
  { type: "redacted_thinking", data: "opaque <|image|>" },
  { reasoningContent: { reasoningText: { text: "<|image|>", signature: "SIG" } } },
  { text: "<|image|>", thoughtSignature: "TSIG" },
  { type: "reasoning", encrypted_content: "enc", summary: [{ type: "summary_text", text: "<|image|>" }] },
  { type: "thinking", thinking: "pi-native <|image|>", thinkingSignature: "SIGNED_pi" },
  { type: "reasoning.text", text: "<|image|>", signature: "SIG_or" },
];
const signedOut = deep(signed) as Array<Record<string, unknown>>;
assert.equal(JSON.stringify(signedOut.slice(0, 2)), JSON.stringify(signed.slice(0, 2)), "Anthropic thinking and redacted thinking are byte-identical");
assert.equal(JSON.stringify(signedOut[2]), JSON.stringify(signed[2]), "Bedrock signed reasoning is byte-identical");
assert.equal(JSON.stringify(signedOut.slice(3, 5)), JSON.stringify(signed.slice(3, 5)), "Gemini and Responses signed parts are byte-identical");
assert.equal(JSON.stringify(signedOut[5]), JSON.stringify(signed[5]), "Pi-native (pi-messages) signed thinking is byte-identical");
assert.equal(JSON.stringify(signedOut[6]), JSON.stringify(signed[6]), "OpenRouter signed reasoning_details are byte-identical");
// A "signature" field in tool arguments doesn't make them a signed block.
const toolUse = deep({ type: "tool_use", id: "t1", name: "send", input: { signature: "Best, Sam", body: "template: <|image|>" } }) as { input: { body: string } };
assert.equal(toolUse.input.body, "template: ＜|image|＞", "tool arguments with a signature field are still rewritten");

// The hook: only a request that carries an image is rewritten, and never its tool definitions.
const dataUrl = "data:image/png;base64,AAAA";
const shapes: Array<[string, unknown]> = [
  ["OpenAI completions", { messages: [{ role: "user", content: [{ type: "text", text: "<|image|>" }, { type: "image_url", image_url: { url: dataUrl } }] }] }],
  ["OpenAI Responses", { input: [{ role: "user", content: [{ type: "input_text", text: "<|image|>" }, { type: "input_image", image_url: dataUrl }] }] }],
  ["Anthropic", { system: "<|image|>", messages: [{ role: "user", content: [{ type: "text", text: "<|image|>" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] }],
  ["Google", { contents: [{ role: "user", parts: [{ text: "<|image|>" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] }] }],
  ["Bedrock", { messages: [{ role: "user", content: [{ text: "<|image|>" }, { image: { format: "png", source: { bytes } } }] }] }],
  // Images that only appear inside a tool result, deeper than the shapes above.
  ["Anthropic tool_result", { system: "<|image|>", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "<|image|>" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] }] }],
  ["Bedrock toolResult", { messages: [{ role: "user", content: [{ text: "<|image|>" }, { toolResult: { toolUseId: "t", content: [{ json: { note: "x" } }, { image: { format: "png", source: { bytes } } }] } }] }] }],
];
for (const [name, payload] of shapes) {
  assert.ok(payloadCarriesImage(payload), `${name}: the image is seen`);
  const out = JSON.stringify(hook(payload), (_k, v) => (v instanceof Uint8Array ? "bytes" : v));
  assert.ok(!out.includes("<|image|>") && out.includes("＜|image|＞"), `${name}: rewritten`);
}
const textOnly = { system: "<|image|>", messages: [{ role: "user", content: "the template uses <|image|> and <｜deepseek_image｜>" }] };
assert.equal(hook(textOnly), textOnly, "a request with no image is returned as it is");
assert.ok(!payloadCarriesImage({ messages: [{ role: "user", content: "see data:image/png;base64,AAAA in the docs" }] }), "a data URL inside text is not an image");
assert.ok(!payloadCarriesImage({ messages: [{ role: "user", content: "data:image/png;base64,AAAA" }] }), "nor is user text that starts with one");
const withTools = { tools: [{ type: "function", function: { name: "pick", parameters: { type: "object", properties: { k: { enum: ["<|image|>"] } } } } }], toolConfig: { tools: [{ toolSpec: { name: "p", description: "<|image|>" } }] }, messages: (shapes[0][1] as { messages: unknown[] }).messages };
const toolsOut = hook(withTools) as typeof withTools;
assert.equal(JSON.stringify(toolsOut.tools), JSON.stringify(withTools.tools), "tool definitions are not rewritten");
assert.equal(JSON.stringify(toolsOut.toolConfig), JSON.stringify(withTools.toolConfig), "Bedrock toolConfig is not rewritten");
assert.ok(!JSON.stringify(toolsOut.messages).includes("<|image|>"), "the messages still are");
const googleTools = { contents: (shapes[3][1] as { contents: unknown[] }).contents, config: { systemInstruction: "<|image|>", tools: [{ functionDeclarations: [{ name: "pick", description: "<|image|>", parameters: { type: "object", properties: { k: { enum: ["<|image|>"] } } } }] }] } };
const googleOut = hook(googleTools) as typeof googleTools;
assert.equal(JSON.stringify(googleOut.config.tools), JSON.stringify(googleTools.config.tools), "Google's config.tools are not rewritten");
assert.equal(googleOut.config.systemInstruction, "＜|image|＞", "the rest of Google's config is");
// Tools added mid-session: pi-messages carries them on a system message; Responses as items.
const piTools = { messages: [
  { role: "system", content: "<|image|>", toolsAdded: [{ name: "pick", description: "<|image|>", parameters: { enum: ["<|image|>"] } }] },
  { role: "user", content: [{ type: "text", text: "<|image|>" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "t", name: "configure", input: { toolsAdded: "<|image|>", tools: "<|image|>" } }] },
] };
const piOut = hook(piTools) as { messages: Array<Record<string, unknown>> };
assert.equal(JSON.stringify(piOut.messages[0].toolsAdded), JSON.stringify(piTools.messages[0].toolsAdded), "pi-messages toolsAdded on a system message are not rewritten");
assert.equal(piOut.messages[0].content, "＜|image|＞", "that system message's text is");
assert.ok(!JSON.stringify(piOut.messages[1].content).includes("<|image|>"), "the user content is");
assert.equal(JSON.stringify(piOut.messages[2].content), '[{"type":"tool_use","id":"t","name":"configure","input":{"toolsAdded":"＜|image|＞","tools":"＜|image|＞"}}]', "tool-call arguments named toolsAdded or tools are rewritten");
const responsesTools = { input: [
  { role: "user", content: [{ type: "input_text", text: "<|image|>" }, { type: "input_image", image_url: dataUrl }] },
  { type: "additional_tools", tools: [{ type: "function", name: "pick", description: "<|image|>", parameters: { enum: ["<|image|>"] } }] },
] };
const responsesOut = hook(responsesTools) as typeof responsesTools;
assert.equal(JSON.stringify(responsesOut.input[1]), JSON.stringify(responsesTools.input[1]), "a Responses additional_tools item is not rewritten");
assert.ok(!JSON.stringify(responsesOut.input[0]).includes("<|image|>"), "the input text is");
console.log("helper and hook: ok");

// The session guard composes with Pi's own hook (extensions' before_provider_request).
const imagePayload = shapes[0][1] as { messages: unknown[] };
const marked = { agent: { onPayload: async (payload: unknown) => ({ ...(payload as object), marked: true }) } };
guardPiSessionProviderPayloads(marked);
const markedOut = (await marked.agent.onPayload(imagePayload)) as { marked?: boolean; messages: unknown[] };
assert.equal(markedOut.marked, true, "the prior hook runs and its payload is used");
assert.ok(!JSON.stringify(markedOut).includes("<|image|>"), "and that payload is neutralized");
const passthrough = { agent: { onPayload: async () => undefined } } as { agent: { onPayload: (payload: unknown, model?: unknown) => Promise<unknown> } };
guardPiSessionProviderPayloads(passthrough);
assert.ok(!JSON.stringify(await passthrough.agent.onPayload(imagePayload)).includes("<|image|>"), "undefined from the prior hook keeps the original payload");
const injecting = { agent: { onPayload: async (payload: unknown) => ({ ...(payload as object), extra: "added by an extension: <|image|>" }) } };
guardPiSessionProviderPayloads(injecting);
const injected = (await injecting.agent.onPayload(imagePayload)) as { extra?: string };
assert.equal(injected.extra, "added by an extension: ＜|image|＞", "the guard runs after the prior hook, so text it adds is neutralized too");
console.log("session guard composition: ok");

// The Pi adapter (Pi's own agent) registers the same hook.
const handlers = new Map<string, (event: { payload: unknown }, ctx: unknown) => unknown>();
mindstoneAgentPiAdapter({ on: (event: string, handler: never) => { handlers.set(event, handler); }, registerTool: () => undefined, registerCommand: () => undefined } as never);
const adapterHook = handlers.get("before_provider_request");
assert.ok(adapterHook, "the adapter registers before_provider_request");
assert.ok(!JSON.stringify(await adapterHook({ payload: imagePayload }, {})).includes("<|image|>"), "the adapter neutralizes an image request");
assert.equal(await adapterHook({ payload: textOnly }, {}), textOnly, "and leaves a request with no image as it is");
console.log("pi adapter: ok");
TS

echo "-- the gateway session, through real Pi to a stub provider"
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiSessionExecutor, piSessionFileForKey } from "./packages/mindstone-gateway/dist/index.js";
import { SessionManager } from "./vendor/pi/packages/coding-agent/dist/core/session-manager.js";

const RAW = ["<｜deepseek_image｜>", "<|image|>"];
const bodies = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    bodies.push(body);
    if (body.includes("data:image/") && RAW.some((token) => body.includes(token))) {
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

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const card = 'model card: "chat_template": "{{ \'<｜deepseek_image｜>\' }} ... <|im_end|>"';
// The incident's shape: a photo earlier, then a fetched model card in a tool result.
function seed(sessionKey, withImage) {
  const sessionFile = piSessionFileForKey(sessionDir, sessionKey);
  mkdirSync(join(sessionFile, ".."), { recursive: true });
  const seeded = SessionManager.open(sessionFile, sessionDir, cwd);
  const now = Date.now();
  seeded.appendMessage({ role: "user", content: withImage ? [{ type: "text", text: "Here's a photo." }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] : [{ type: "text", text: "Look up the model." }], timestamp: now });
  seeded.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "web_fetch", arguments: { url: "https://example.com/model" } }], api: "openai-completions", provider: "stub", model: "vision", usage, stopReason: "toolUse", timestamp: now + 1 });
  seeded.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "web_fetch", content: [{ type: "text", text: card }], isError: false, timestamp: now + 2 });
  seeded.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fetched." }], api: "openai-completions", provider: "stub", model: "vision", usage, stopReason: "stop", timestamp: now + 3 });
  return sessionFile;
}
const model = { id: "stub/vision", provider: "stub", name: "vision" };
const executor = new PiSessionExecutor({ projectRoot: process.cwd(), agentDir, sessionDir, cwd, defaultProvider: "stub", defaultModel: "vision", noExtensions: true, noSkills: true });
const ask = (sessionKey) => executor.completeChat({ agentId: "default", sessionKey, model, messages: [{ role: "system", text: "System note: <|image|> is a token." }, { role: "user", text: "Which is it, <|image|> or <|im_start|>?" }], transcriptEntries: [] });

const imageFile = seed("agent:default:main", true);
const result = await ask("agent:default:main");
const sent = bodies.at(-1);
assert.ok(sent.includes("data:image/png;base64,iVBORw0KGgo="), "the photo is still sent");
for (const token of RAW) assert.ok(!sent.includes(token), `no raw ${token} goes out`);
assert.ok(sent.includes("＜｜deepseek_image｜＞") && sent.includes("＜|image|＞"), "media tokens arrive with full-width brackets, the tool result's included");
assert.ok(sent.includes("<|im_end|>") && sent.includes("<|im_start|>"), "other control tokens are sent as they are");
assert.equal(result.text, "stub-ok", `the turn succeeded (got ${JSON.stringify(result.text)})`);
assert.ok(readFileSync(imageFile, "utf8").includes("<｜deepseek_image｜>"), "the stored session keeps the original text");
console.log("session with an image: ok");

seed("agent:default:text", false);
const textResult = await ask("agent:default:text");
const textSent = bodies.at(-1);
assert.ok(!textSent.includes("data:image/"), "no image in this session");
assert.ok(textSent.includes("<｜deepseek_image｜>") && textSent.includes("<|image|>") && !textSent.includes("＜"), "a request with no image is sent unchanged");
assert.equal(textResult.text, "stub-ok");
console.log("session with no image: ok");
server.close();
NODE
echo "== Model control tokens smoke test passed =="
