/**
 * Neutralize model control tokens that appear as plain text in a request.
 *
 * Text an agent sends (a fetched web page, a file, a tool result) can contain a model's own
 * special-token strings. A Hugging Face model card quotes its chat template, for example, and
 * DeepSeek's template contains `<｜deepseek_image｜>`. When a request also carries an image, the
 * provider counts the image-placeholder tokens in the text against the images attached, finds a
 * mismatch and fails the whole request with a bare 500. Every later turn then fails the same way,
 * because the text stays in the session.
 *
 * Measured against Ollama cloud (`/api/chat` and `/v1/chat/completions`) on 2026-10-28, with one
 * image attached:
 * - deepseek-v4.1-flash:1017-cloud fails on `<｜deepseek_image｜>`
 * - gemma4:31b-cloud fails on `<|image|>`
 * The same requests pass with no image, and with the angle brackets swapped for full-width ones.
 *
 * Both control-token shapes are rewritten, whatever the name inside: `<｜name｜>` (DeepSeek) and
 * `<|name|>` (ChatML, Llama, Gemma, Qwen). Only the outer angle brackets change, to `＜` and `＞`,
 * so the text still reads the same to the model but no longer matches a tokenizer's special token.
 * Plain tags such as `<image>` and `[IMG]` are left alone: they are ordinary text on the models
 * tested, and HTML uses that shape.
 */

const FULLWIDTH_BAR_TOKEN = /<｜([^｜<>\n]{1,64})｜>/g;
const ASCII_BAR_TOKEN = /<\|([^|<>\s]{1,64})\|>/g;

export function neutralizeModelControlTokens(text: string): string {
  if (!text.includes("<")) return text;
  return text.replace(FULLWIDTH_BAR_TOKEN, "＜｜$1｜＞").replace(ASCII_BAR_TOKEN, "＜|$1|＞");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Apply {@link neutralizeModelControlTokens} to every string inside plain objects and arrays.
 * Anything else (byte arrays such as Bedrock's image bytes, class instances) is kept as is, and
 * the input is never modified.
 */
export function neutralizeModelControlTokensDeep<T>(value: T): T {
  if (typeof value === "string") return neutralizeModelControlTokens(value) as T;
  if (Array.isArray(value)) return value.map((item) => neutralizeModelControlTokensDeep(item)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = neutralizeModelControlTokensDeep(item);
    return out as T;
  }
  return value;
}

/**
 * A Pi `onPayload` hook: the provider request as built for the wire (system prompt, messages,
 * tool results and tool-call arguments, in whatever shape the provider uses), with control
 * tokens neutralized. Only this outbound copy changes; the session keeps the original text.
 */
export function neutralizeProviderPayload(payload: unknown): unknown {
  return neutralizeModelControlTokensDeep(payload);
}
