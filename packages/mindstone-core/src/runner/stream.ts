import type { AgentRunFailedEvent } from "./types.js";

export function agentRunStreamErrorFromUnknown(error: unknown): AgentRunFailedEvent["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: typeof error === "string" ? error : "Unknown AgentRunner stream error",
  };
}
