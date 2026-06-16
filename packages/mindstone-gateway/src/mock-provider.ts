import type { MindStoneChatRequest, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider } from "@mindstone-agent/core";

export type MockProviderOptions = {
  responsePrefix?: string;
};

export class MockMindStoneProvider implements MindStoneModelProvider {
  readonly id = "mock";
  readonly #responsePrefix: string;

  constructor(options: MockProviderOptions = {}) {
    this.#responsePrefix = options.responsePrefix ?? "Mock MindStone response";
  }

  listModels(): MindStoneModelInfo[] {
    return [{ id: "mindstone/mock", provider: this.id, name: "MindStone Mock", contextWindowTokens: 128_000 }];
  }

  async completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult> {
    if (request.signal?.aborted) throw new Error("aborted");
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
