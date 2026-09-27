import { appendFileSync } from "node:fs";
import type { MindStoneChatRequest, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider } from "@mindstone-agent/core";

export type MockProviderOptions = {
  responsePrefix?: string;
  /** Smoke tests only: append each request's messages to this file as JSON lines. */
  captureFile?: string;
};

export class MockMindStoneProvider implements MindStoneModelProvider {
  readonly id = "mock";
  readonly #responsePrefix: string;
  readonly #captureFile: string | undefined;

  constructor(options: MockProviderOptions = {}) {
    this.#responsePrefix = options.responsePrefix ?? "Mock MindStone response";
    this.#captureFile = options.captureFile?.trim() || undefined;
  }

  listModels(): MindStoneModelInfo[] {
    return [{ id: "mindstone/mock", provider: this.id, name: "MindStone Mock", contextWindowTokens: 128_000 }];
  }

  async completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult> {
    if (request.signal?.aborted) throw new Error("aborted");
    if (this.#captureFile) {
      appendFileSync(this.#captureFile, `${JSON.stringify({ model: request.model, messages: request.messages })}\n`);
    }
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user" && message.text?.trim());
    return {
      role: "assistant",
      text: `${this.#responsePrefix}: ${lastUser?.text ?? "no user message"}`,
      model: request.model,
      usage: {
        inputTokens: request.messages.reduce((total, message) => total + Math.ceil(JSON.stringify(message).length / 4), 0),
        outputTokens: 12,
      },
    };
  }
}
