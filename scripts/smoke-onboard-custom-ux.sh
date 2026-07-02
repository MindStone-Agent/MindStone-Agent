#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CONFIG="$TMP_DIR/config.json"

cd "$ROOT"
MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_RUNTIME_DIR="$TMP_DIR/runtime" MINDSTONE_AGENT_CONFIG="$CONFIG" npx tsx <<'TS'
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runMindStoneOnboardingWizard, type MindStonePrompter, type MindStoneSelectOption } from "./packages/mindstone-core/src/index.ts";

const configPath = process.env.MINDSTONE_AGENT_CONFIG!;
const texts = [
  "Custom Systems Partner",
  "A custom write-in profile for systems work and continuity.",
  "Be brief unless design tradeoffs matter.",
  "Recommend directly, but label uncertainty and alternatives.",
  "Inspect freely, ask before edits, and run harmless checks without ceremony.",
  "Never push, delete, or alter credentials without explicit approval.",
  "Suggest memory only for durable decisions, corrections, and recurring constraints.",
  "Custom UX validation project.",
  "Avoid exposing private local context.",
  "Identity should form collaboratively and avoid generic assistant branding.",
  "Names should feel practical, not theatrical.",
  "Keep setup simple, but explain what is happening.",
  "Use a real model later; skip if no isolated Pi provider is available now.",
  "Help validate onboarding UX.",
  "Prefer a page-based onboarding flow with write-in options.",
];
const selects = [
  "custom", // profile
  "custom", // interaction detail
  "custom", // recommendation style
  "custom", // work style
  "custom", // approval mode
  "custom", // memory style
  "custom", // sensitive context
  "custom", // identity direction
  "custom", // setup depth
  "custom", // model setup
  "skip", // model source fallback when no providers are discovered
];
const confirms = [true, true, true];

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
    if (!found) throw new Error(`Selection not available: ${next}; options=${options.map((option) => option.value).join(",")}`);
    return found.value;
  },
  text: async () => {
    const next = texts.shift();
    if (next === undefined) throw new Error("Unexpected text prompt");
    return next;
  },
};

const result = await runMindStoneOnboardingWizard(prompter, {
  configPath,
  showHeader: false,
  availableModels: [],
  availableProviders: [],
  modelDiscoveryError: "custom UX smoke intentionally has no providers",
});
if (!result.wrote) throw new Error("Onboarding did not write config");
if (!result.identityActivated) throw new Error("Onboarding did not activate identity");
if (texts.length || selects.length || confirms.length) throw new Error(`Prompt queues were not fully consumed: texts=${texts.length} selects=${selects.length} confirms=${confirms.length}`);

const config = JSON.parse(readFileSync(result.path, "utf-8")) as any;
const prefs = config.onboarding?.preferences;
if (config.onboarding?.profile?.id !== "custom") throw new Error("Custom profile was not written");
if (!prefs?.interactionDetailNotes?.includes("brief unless design")) throw new Error("Interaction write-in not persisted");
if (!prefs?.recommendationStyleNotes?.includes("label uncertainty")) throw new Error("Recommendation write-in not persisted");
if (!prefs?.workStyleNotes?.includes("ask before edits")) throw new Error("Work style write-in not persisted");
if (!prefs?.approvalNotes?.includes("Never push")) throw new Error("Approval write-in not persisted");
if (!prefs?.memoryStyleNotes?.includes("durable decisions")) throw new Error("Memory write-in not persisted");
if (!prefs?.sensitiveContext?.includes("private local context")) throw new Error("Sensitive write-in not persisted");
if (!config.onboarding?.identity?.identityDirection?.includes("collaboratively")) throw new Error("Identity write-in not persisted");
if (!prefs?.setupNotes?.includes("Keep setup simple")) throw new Error("Setup write-in not persisted");
if (!prefs?.modelSetupNotes?.includes("real model later")) throw new Error("Model setup write-in not persisted");

const identityPath = resolve(dirname(result.path), "agents/default/IDENTITY.md");
const identity = readFileSync(identityPath, "utf-8");
if (!identity.includes("Interaction detail notes")) throw new Error("Activated identity omitted custom interaction notes");
if (!identity.includes("Model setup notes")) throw new Error("Activated identity omitted custom model notes");

console.log(`onboard custom UX smoke passed: ${result.path}`);
TS
