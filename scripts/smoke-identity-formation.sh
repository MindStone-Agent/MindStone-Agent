#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$ROOT"

echo "== First-activation identity formation smoke test =="

MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_RUNTIME_DIR="$TMP_DIR/runtime" npx tsx <<'TS'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  runMindStoneChatTurn,
  type MindStoneConfig,
  type MindStoneModelProvider,
} from "./packages/mindstone-core/src/index.ts";

const runtime = process.env.MINDSTONE_AGENT_RUNTIME_DIR!;
const configPath = resolve(runtime, "mindstone/config.json");
mkdirSync(dirname(configPath), { recursive: true });
mkdirSync(resolve(runtime, "mindstone/agents/default"), { recursive: true });
writeFileSync(resolve(runtime, "mindstone/agents/default/IDENTITY.md"), "# MindStone General Companion\n\nThis identity was synthesized by `mindstone identity activate` on test. It is a first-activation working identity.\n");
writeFileSync(resolve(runtime, "mindstone/agents/default/USER.md"), "# User Context\n\nProject/domain context: General software engineering.\n");

const config: MindStoneConfig = {
  workspace: { root: "." },
  agents: {
    default: {
      id: "default",
      identityPath: "agents/default/IDENTITY.md",
      userPath: "agents/default/USER.md",
      profileId: "general_companion",
    },
  },
  routing: {
    mode: "mock",
    defaultAgentId: "default",
    defaultModel: "mindstone/mock",
  },
  onboarding: {
    profile: {
      id: "general_companion",
      label: "General Companion",
      description: "Broad utility partner for projects, writing, research, planning, and continuity.",
      selectedAt: "2026-06-30T00:00:00.000Z",
    },
    preferences: {
      interactionDetail: "balanced",
      recommendationStyle: "direct",
      workStyle: "ask_first",
      approvalMode: "standard",
      memoryStyle: "propose_checkpoint_memories",
      projectContext: "General software engineering",
      selectedAt: "2026-06-30T00:00:00.000Z",
    },
    identity: {
      mode: "defer",
      selectedAt: "2026-06-30T00:00:00.000Z",
    },
  },
  contextManagement: { mode: "sliding_window" },
  memory: { autoRecall: false },
  session: { mode: "single", defaultSessionKey: "agent:default:main" },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const seen: string[][] = [];
const provider: MindStoneModelProvider = {
  id: "identity-formation-smoke-provider",
  listModels() {
    return [{ id: "identity-formation-smoke-model", provider: "identity-formation-smoke-provider", contextWindowTokens: 4096 }];
  },
  async completeChat(request) {
    seen.push(request.messages.map((message) => message.text ?? String(message.content ?? "")));
    return {
      role: "assistant",
      text: "First activation acknowledged. Tell me what kind of agent you want me to become, how we should collaborate, and whether any names resonate. I currently lean toward Ember because it suggests a small beginning that can grow into durable continuity.",
      model: request.model,
    };
  },
};

const common = {
  agentId: "default",
  sessionKey: "agent:default:main",
  config,
  configPath,
  provider,
  model: { id: "identity-formation-smoke-model", provider: "identity-formation-smoke-provider", contextWindowTokens: 4096 },
  source: { substrate: "smoke", channel: "test", chatType: "direct", senderId: "local" },
} as const;

const first = await runMindStoneChatTurn({ ...common, message: "hello" });
if (!first.events.some((entry) => entry.metadata?.event === "identity_formation_prompted")) {
  throw new Error("First turn did not record identity_formation_prompted event");
}
const firstPrompt = seen[0]?.join("\n---\n") ?? "";
if (!firstPrompt.includes("MindStone first-activation identity formation")) {
  throw new Error("First turn did not inject identity formation prompt");
}
if (!firstPrompt.includes("Focus primarily on learning about the human")) {
  throw new Error("Identity formation prompt missing human-focused instruction");
}
if (!firstPrompt.includes("What should I call you?")) {
  throw new Error("Identity formation prompt missing human name question");
}
if (!firstPrompt.includes("What would make me feel genuinely helpful to you day-to-day?")) {
  throw new Error("Identity formation prompt missing day-to-day helpfulness question");
}
if (!firstPrompt.includes("answer as the MindStone companion")) {
  throw new Error("Identity formation prompt missing provider-identity correction instruction");
}
if (!firstPrompt.includes("tentative candidate names")) {
  throw new Error("Identity formation prompt missing tentative naming instruction");
}

const second = await runMindStoneChatTurn({ ...common, message: "I want a software partner" });
if (second.events.some((entry) => entry.metadata?.event === "identity_formation_prompted")) {
  throw new Error("Identity formation prompt repeated on second turn");
}
const secondPrompt = seen[1]?.join("\n---\n") ?? "";
if (secondPrompt.includes("MindStone first-activation identity formation")) {
  throw new Error("Second turn still injected identity formation prompt");
}

console.log(JSON.stringify({
  ok: true,
  firstEvents: first.events.map((entry) => entry.metadata?.event).filter(Boolean),
  firstMessageCount: seen[0]?.length ?? 0,
  secondMessageCount: seen[1]?.length ?? 0,
}, null, 2));
TS

echo "First-activation identity formation smoke test passed."
