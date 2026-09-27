import { appendFileSync } from "node:fs";
import type { MindStoneChatRequest, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider } from "@mindstone-agent/core";

export type MockProviderOptions = {
  responsePrefix?: string;
  /** Smoke tests only: append each request's messages to this file as JSON lines. */
  captureFile?: string;
  /** Smoke tests only: throw when the last user message contains this text. */
  failWhenTextIncludes?: string;
  /** Smoke tests only: reply with empty text when the last user message contains this text. */
  emptyWhenTextIncludes?: string;
};

export class MockMindStoneProvider implements MindStoneModelProvider {
  readonly id = "mock";
  readonly #responsePrefix: string;
  readonly #captureFile: string | undefined;
  readonly #options: MockProviderOptions;

  constructor(options: MockProviderOptions = {}) {
    this.#options = options;
    this.#responsePrefix = options.responsePrefix ?? "Mock MindStone response";
    // Honoured only when the smoke harness also sets MINDSTONE_AGENT_MOCK_CAPTURE=1,
    // so a config edit alone can't start writing full prompts to disk (#61).
    this.#captureFile = process.env.MINDSTONE_AGENT_MOCK_CAPTURE === "1" ? options.captureFile?.trim() || undefined : undefined;
  }

  listModels(): MindStoneModelInfo[] {
    return [{ id: "mindstone/mock", provider: this.id, name: "MindStone Mock", contextWindowTokens: 128_000 }];
  }

  async completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult> {
    if (request.signal?.aborted) throw new Error("aborted");
    if (this.#captureFile) {
      appendFileSync(this.#captureFile, `${JSON.stringify({ model: request.model, messages: request.messages })}\n`, { mode: 0o600 });
    }
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user" && message.text?.trim());
    const { failWhenTextIncludes: fail, emptyWhenTextIncludes: empty } = this.#options;
    if (fail && lastUser?.text?.includes(fail)) throw new Error("mock model not available");
    return {
      role: "assistant",
      text: empty && lastUser?.text?.includes(empty) ? "" : `${this.#responsePrefix}: ${lastUser?.text ?? "no user message"}`,
      model: request.model,
      usage: {
        inputTokens: request.messages.reduce((total, message) => total + Math.ceil(JSON.stringify(message).length / 4), 0),
        outputTokens: 12,
      },
    };
  }
}
