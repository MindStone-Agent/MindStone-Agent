import type { MindStoneChatRequest, MindStoneChatResult, MindStoneModelInfo, MindStoneModelProvider, MindStoneProviderInfo } from "@mindstone-agent/core";
import {
  buildPiSessionPromptParts,
  createPiSessionEventCapture,
  PiSessionExecutor,
  piSessionFileForKey,
  summarizePiSessionEvent,
  type PiSessionExecutorOptions,
} from "./pi-session-executor.js";

export type PiSessionMindStoneProviderOptions = PiSessionExecutorOptions;

export {
  buildPiSessionPromptParts,
  createPiSessionEventCapture,
  piSessionFileForKey,
  summarizePiSessionEvent,
};

/**
 * Compatibility provider wrapper for the Pi AgentSession executor.
 *
 * New CLI/Gateway paths should prefer `PiSessionAgentRunner`; this provider is
 * retained for model discovery, older routing code, and external callers that
 * still expect a `MindStoneModelProvider`.
 */
export class PiSessionMindStoneProvider implements MindStoneModelProvider {
  readonly id = "pi-session";
  readonly #executor: PiSessionExecutor;

  constructor(options: PiSessionMindStoneProviderOptions = {}) {
    this.#executor = new PiSessionExecutor(options);
  }

  listModels(): Promise<MindStoneModelInfo[]> {
    return this.#executor.listModels();
  }

  listAvailableModels(): Promise<MindStoneModelInfo[]> {
    return this.#executor.listAvailableModels();
  }

  listProviders(): Promise<MindStoneProviderInfo[]> {
    return this.#executor.listProviders();
  }

  completeChat(request: MindStoneChatRequest): Promise<MindStoneChatResult> {
    return this.#executor.completeChat(request);
  }
}
