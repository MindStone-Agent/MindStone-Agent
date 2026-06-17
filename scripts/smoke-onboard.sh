#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CONFIG="$TMP_DIR/config.json"

cd "$ROOT"
MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" npx tsx <<'TS'
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runMindStoneOnboardingWizard, type MindStonePrompter, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

const configPath = process.env.MINDSTONE_AGENT_CONFIG!;
const texts = [
  "MindStone-Agent rebuild on isolated Pi with Gateway, onboarding, memory, and channel work.",
  "help build and operate MindStone-Agent",
  "Clint prefers truthful, verified work and no destructive changes without approval.",
];
const selects = [
  "integration_builder",
  "balanced",
  "direct",
  "act_directly",
  "standard",
  "propose_checkpoint_memories",
  "none",
  "quickstart",
];
const confirms = [true, true];

const prompter: MindStonePrompter = {
  intro: async () => undefined,
  outro: async () => undefined,
  note: async () => undefined,
  confirm: async () => {
    const next = confirms.shift();
    if (next === undefined) throw new Error("Unexpected confirm prompt");
    return next;
  },
  select: async <T extends string>({ options }: { message: string; options: Array<MindStoneSelectOption<T>>; initialValue?: T }): Promise<T> => {
    const next = selects.shift();
    if (next === undefined) throw new Error("Unexpected select prompt");
    const found = options.find((option) => option.value === next);
    if (!found) throw new Error(`Selection not available: ${next}`);
    return found.value;
  },
  text: async () => {
    const next = texts.shift();
    if (next === undefined) throw new Error("Unexpected text prompt");
    return next;
  },
};

const result = await runMindStoneOnboardingWizard(prompter, { configPath, showHeader: false });
if (!result.wrote) throw new Error("Onboarding did not write config");
if (!result.identityCreated) throw new Error("Onboarding did not create identity file");
if (!result.userCreated) throw new Error("Onboarding did not create user file");
if (texts.length || selects.length || confirms.length) throw new Error("Smoke prompt queues were not fully consumed");

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
if (config.routing?.mode !== "placeholder") throw new Error("QuickStart placeholder routing mode was not written");
if (config.gateway?.auth?.mode !== "none") throw new Error("QuickStart gateway auth mode was not written");
if (config.contextManagement?.mode !== "sliding_window") throw new Error("Context mode was not written");
if (config.memory?.autoRecall !== false) throw new Error("QuickStart memory autoRecall default was not written");
if (config.onboarding?.profile?.id !== "integration_builder") throw new Error("Selected onboarding profile was not written");
if (config.onboarding?.preferences?.interactionDetail !== "balanced") throw new Error("Interaction preference was not written");
if (config.onboarding?.preferences?.recommendationStyle !== "direct") throw new Error("Recommendation preference was not written");
if (config.onboarding?.preferences?.projectContext !== "MindStone-Agent rebuild on isolated Pi with Gateway, onboarding, memory, and channel work.") throw new Error("Project context preference was not written");
if (config.agents?.default?.profileId !== "integration_builder") throw new Error("Agent profileId was not written");

const identityPath = resolve(dirname(result.path), "agents/default/IDENTITY.md");
const userPath = resolve(dirname(result.path), "agents/default/USER.md");
if (!existsSync(identityPath)) throw new Error("Identity file does not exist");
if (!existsSync(userPath)) throw new Error("User file does not exist");
const identity = readFileSync(identityPath, "utf-8");
const user = readFileSync(userPath, "utf-8");
if (!identity.includes("MindStone Agent Identity Pending")) throw new Error("Identity scaffold content missing");
if (!identity.includes("Base profile: Integration Builder")) throw new Error("Identity profile seed missing");
if (!identity.includes("Interaction detail: balanced")) throw new Error("Identity preference seed missing");
if (!user.includes("Base profile: Integration Builder")) throw new Error("User profile seed missing");
if (!user.includes("Project/domain context: MindStone-Agent rebuild")) throw new Error("User project context missing");
if (!user.includes("Clint prefers truthful")) throw new Error("User scaffold content missing");

console.log(`onboard smoke passed: ${result.path}`);
TS
