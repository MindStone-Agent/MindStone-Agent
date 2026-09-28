#!/usr/bin/env bash
# CLI login prompts on Pi 0.87 (#128 review): Pi aborts a manual-code prompt
# when the browser login wins. The aborted question must end, not stay pending
# and take the next answer; a manual code may be empty; secrets are marked
# sensitive. Drives the real terminal prompter over piped streams. No ports.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"
echo "== CLI OAuth prompt smoke test =="
npm run build:mindstone
npx tsx <<'TS'
import { PassThrough } from "node:stream";
import { makeTerminalPrompter } from "./packages/mindstone-cli/src/terminal-prompter.ts";
import { piLoginInteraction } from "./packages/mindstone-cli/src/pi-login.ts";

const fail = (message: string) => { console.error(message); process.exit(1); };
const within = <T,>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))]);

const input = new PassThrough() as unknown as NodeJS.ReadStream;
const output = new PassThrough() as unknown as NodeJS.WriteStream;
output.resume();
const prompter = makeTerminalPrompter({ input, output });
const login = piLoginInteraction(prompter, { write: () => undefined, openUrl: () => false });

// 1. A manual-code prompt aborted by the browser callback rejects...
const controller = new AbortController();
const aborted = login.prompt({ type: "manual_code", message: "Paste the code", signal: controller.signal });
setTimeout(() => controller.abort(), 50);
const outcome = await within(aborted.then(() => "resolved", () => "rejected"), 2000, "aborted prompt");
if (outcome !== "rejected") fail("an aborted manual-code prompt should reject, got: " + outcome);
// ...and doesn't take the next answer.
const next = login.prompt({ type: "text", message: "Next question" });
(input as unknown as PassThrough).write("next-answer\n");
const answer = await within(next, 2000, "the next prompt").catch((error) => fail("the next prompt never got its answer: " + String(error)));
if (answer !== "next-answer") fail("the next prompt got the wrong answer: " + JSON.stringify(answer));

// 2. An empty manual code is accepted (the browser may still finish).
const empty = login.prompt({ type: "manual_code", message: "Paste the code" });
(input as unknown as PassThrough).write("\n");
const emptyAnswer = await within(empty, 2000, "empty manual code").catch((error) => fail("an empty manual code was refused: " + String(error)));
if (emptyAnswer !== "") fail("an empty manual code should give an empty answer: " + JSON.stringify(emptyAnswer));
prompter.close();

// 3. The mapping: secrets are sensitive, signals are passed, a plain text prompt still requires input.
const seen: Array<Record<string, unknown>> = [];
const recorder = { note: async () => undefined, confirm: async () => true, select: async () => "x", text: async (options: Record<string, unknown>) => { seen.push(options); return "v"; } };
const mapped = piLoginInteraction(recorder as never, { write: () => undefined, openUrl: () => false });
const signal = new AbortController().signal;
await mapped.prompt({ type: "secret", message: "API key" });
await mapped.prompt({ type: "manual_code", message: "code", signal });
await mapped.prompt({ type: "text", message: "name" });
if (seen[0].sensitive !== true) fail("a secret prompt should be sensitive");
if (seen[1].signal !== signal) fail("a manual-code prompt should pass its signal on");
if (typeof seen[2].validate !== "function" || (seen[2].validate as (v: string) => unknown)("") === undefined) fail("a text prompt should still require input");
console.log("CLI OAuth prompt assertions passed");
TS
echo "CLI OAuth prompt smoke test passed."
