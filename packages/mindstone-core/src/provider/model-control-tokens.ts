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
 * Media-placeholder tokens in both shapes are rewritten: `<｜…image…｜>` (DeepSeek) and `<|…image…|>`
 * (Gemma, Qwen and others), also `img`, `vision`, `video` and `audio`. Only the outer angle brackets
 * change, to `＜` and `＞`, so the text still reads the same to the model but no longer matches a
 * tokenizer's special token. Other control tokens (`<|im_end|>`, `<｜tool▁calls▁begin｜>`) are left
 * alone: they don't break image requests, and agents copy them into files.
 *
 * Deliberately not rewritten:
 * - Gemma 4's one-sided tokens (`<|image>`, `<image|>`, `<|turn>`): measured with a photo attached
 *   on gemma4:31b-cloud, they pass with and without an image.
 * - Plain tags such as `<image>` and `[IMG]`: ordinary text on the models tested, and HTML uses
 *   that shape.
 */

// Only media-placeholder names (image, img, vision, video, audio) are rewritten. Those are the ones
// measured to fail a request that carries an image. Rewriting every control token would also hit
// tokens like <|im_end|> that agents read from and edit back into files, and a fuzzy edit match
// (NFKC folds ＜ back to <) would then write the full-width form to disk.
const MEDIA = "[^｜|<>\\s]{0,40}(?:image|img|vision|video|audio)[^｜|<>\\s]{0,40}";
const FULLWIDTH_BAR_TOKEN = new RegExp(`<｜(${MEDIA})｜>`, "gi");
const ASCII_BAR_TOKEN = new RegExp(`<\\|(${MEDIA})\\|>`, "gi");

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
 * Blocks a provider checks byte for byte against a signature: changing their text, even inside a
 * block the model wrote itself, makes every later request in the session fail.
 */
function isSignedBlock(value: Record<string, unknown>): boolean {
  return (typeof value.signature === "string" && value.signature.length > 0) // Anthropic thinking, Bedrock reasoningText
    || value.type === "redacted_thinking"
    || (typeof value.thoughtSignature === "string" && value.thoughtSignature.length > 0) // Gemini parts
    || (value.type === "reasoning" && typeof value.encrypted_content === "string"); // OpenAI Responses
}

/**
 * Apply {@link neutralizeModelControlTokens} to every string inside plain objects and arrays.
 * Signed blocks, byte arrays (Bedrock's image bytes) and class instances are kept as they are,
 * and the input is never modified.
 */
export function neutralizeModelControlTokensDeep<T>(value: T): T {
  if (typeof value === "string") return neutralizeModelControlTokens(value) as T;
  if (Array.isArray(value)) return value.map((item) => neutralizeModelControlTokensDeep(item)) as T;
  if (isPlainObject(value)) {
    if (isSignedBlock(value)) return value;
    // fromEntries defines keys, so a "__proto__" key in tool arguments is kept rather than dropped.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, neutralizeModelControlTokensDeep(item)])) as T;
  }
  return value;
}

/** Whether a provider payload carries an image, in any of the wire shapes Pi's providers use. */
export function payloadCarriesImage(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === "string") return value.startsWith("data:image/");
  if (Array.isArray(value)) return value.some((item) => payloadCarriesImage(item, depth + 1));
  if (!isPlainObject(value)) return false;
  const type = value.type;
  if (type === "image" || type === "image_url" || type === "input_image") return true; // Anthropic and Pi, OpenAI and Mistral, Responses
  const inline = (value.inlineData ?? value.fileData) as { mimeType?: unknown } | undefined; // Google
  if (inline && typeof inline.mimeType === "string" && inline.mimeType.startsWith("image/")) return true;
  if (isPlainObject(value.image) && ("source" in value.image || "format" in value.image)) return true; // Bedrock
  return Object.values(value).some((item) => payloadCarriesImage(item, depth + 1));
}

// Tool definitions are the caller's schemas, not conversation text: an enum or const value
// rewritten here would come back from the model in the full-width form and fail validation.
const TOOL_DEFINITION_KEYS = new Set(["tools", "toolConfig"]);

/**
 * A Pi `onPayload` / `before_provider_request` hook. A request that carries an image goes out with
 * media-placeholder tokens neutralized in its system prompt, messages, tool results and tool-call
 * arguments; tool definitions and signed blocks are left alone. A request with no image is
 * returned as it is. Only this outbound copy changes; the session keeps the original text.
 */
export function neutralizeProviderPayload(payload: unknown): unknown {
  if (!payloadCarriesImage(payload)) return payload;
  if (!isPlainObject(payload)) return neutralizeModelControlTokensDeep(payload);
  return Object.fromEntries(Object.entries(payload).map(([key, item]) => [key, TOOL_DEFINITION_KEYS.has(key) ? item : neutralizeModelControlTokensDeep(item)]));
}
