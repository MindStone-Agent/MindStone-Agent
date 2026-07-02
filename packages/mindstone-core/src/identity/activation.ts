import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadMindStoneConfig, resolveConfigPath, resolvePathRelativeToConfig } from "../config/load.js";
import type { MindStoneConfig, MindStoneOnboardingIdentity, MindStoneOnboardingPreferences } from "../config/types.js";
import { getBuiltInMindStoneProfile } from "../profile/index.js";

export type MindStoneIdentityActivationOptions = {
  configPath?: string;
  agentId?: string;
  dryRun?: boolean;
  force?: boolean;
  now?: string;
};

export type MindStoneIdentityActivationResult = {
  ok: boolean;
  wrote: boolean;
  wouldWrite: boolean;
  dryRun: boolean;
  forced: boolean;
  reason?: string;
  agentId: string;
  name: string;
  configPath: string;
  identityPath?: string;
  userPath?: string;
  identityExists: boolean;
  userExists: boolean;
  previousIdentityPending: boolean;
  backupPath?: string;
  identityMarkdown: string;
};

function sanitizeMarkdownLine(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\r?\n/g, " ");
}

function preferenceLabel(value: string | undefined): string {
  return value?.replace(/_/g, " ") ?? "unset";
}

function formatPreferenceLines(preferences: MindStoneOnboardingPreferences | undefined): string[] {
  if (!preferences) return ["- Preferences: unset"];
  return [
    `- Interaction detail: ${preferenceLabel(preferences.interactionDetail)}`,
    preferences.interactionDetailNotes ? `- Interaction detail notes: ${sanitizeMarkdownLine(preferences.interactionDetailNotes)}` : undefined,
    `- Recommendation style: ${preferenceLabel(preferences.recommendationStyle)}`,
    preferences.recommendationStyleNotes ? `- Recommendation style notes: ${sanitizeMarkdownLine(preferences.recommendationStyleNotes)}` : undefined,
    `- Work style: ${preferenceLabel(preferences.workStyle)}`,
    preferences.workStyleNotes ? `- Work style notes: ${sanitizeMarkdownLine(preferences.workStyleNotes)}` : undefined,
    `- Approval mode: ${preferenceLabel(preferences.approvalMode)}`,
    preferences.approvalNotes ? `- Approval notes: ${sanitizeMarkdownLine(preferences.approvalNotes)}` : undefined,
    `- Memory/checkpoint style: ${preferenceLabel(preferences.memoryStyle)}`,
    preferences.memoryStyleNotes ? `- Memory/checkpoint notes: ${sanitizeMarkdownLine(preferences.memoryStyleNotes)}` : undefined,
    preferences.setupNotes ? `- Setup notes: ${sanitizeMarkdownLine(preferences.setupNotes)}` : undefined,
    preferences.modelSetupNotes ? `- Model setup notes: ${sanitizeMarkdownLine(preferences.modelSetupNotes)}` : undefined,
    preferences.projectContext ? `- Project/domain context: ${sanitizeMarkdownLine(preferences.projectContext)}` : undefined,
    preferences.sensitiveContext ? "- Sensitive context: configured in USER.md; treat as private and do not disclose casually." : undefined,
  ].filter((line): line is string => Boolean(line));
}

function formatIdentitySeedLines(identity: MindStoneOnboardingIdentity | undefined): string[] {
  if (!identity) return ["- Identity emergence: unset"];
  return [
    `- Identity emergence mode: ${preferenceLabel(identity.mode)}`,
    identity.candidateName ? `- Candidate name: ${sanitizeMarkdownLine(identity.candidateName)}` : undefined,
    identity.identityDirection ? `- Identity direction: ${sanitizeMarkdownLine(identity.identityDirection)}` : undefined,
    identity.namingNotes ? `- Naming notes: ${sanitizeMarkdownLine(identity.namingNotes)}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

export function isInitializerPlaceholderIdentity(markdown: string): boolean {
  return /^#\s+Default MindStone Agent\s*$/m.test(markdown) &&
    /placeholder identity for a newly initialized MindStone-Agent runtime/i.test(markdown);
}

export function isPendingMindStoneIdentity(markdown: string): boolean {
  return /^#\s+MindStone Agent Identity Pending\s*$/m.test(markdown) ||
    isInitializerPlaceholderIdentity(markdown) ||
    (
      /identity scaffold was created by `mindstone onboard`/i.test(markdown) &&
      /first activation/i.test(markdown) &&
      /identity pending/i.test(markdown)
    );
}

function isPendingIdentity(markdown: string): boolean {
  return isPendingMindStoneIdentity(markdown);
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, "-");
}

function synthesizeName(config: MindStoneConfig, agentId: string): string {
  const candidate = sanitizeMarkdownLine(config.onboarding?.identity?.candidateName);
  if (candidate) return candidate;
  const profile = config.onboarding?.profile;
  const profileDefinition = getBuiltInMindStoneProfile(profile?.id);
  const label = sanitizeMarkdownLine(profileDefinition?.shortLabel ?? profile?.label);
  if (label) return `MindStone ${label}`;
  return agentId === "default" ? "MindStone Agent" : `MindStone ${agentId}`;
}

function buildActivatedIdentityMarkdown(params: {
  config: MindStoneConfig;
  configPath: string;
  agentId: string;
  name: string;
  identityPath?: string;
  userPath?: string;
  userExists: boolean;
  previousIdentityPending: boolean;
  now: string;
}): string {
  const profile = params.config.onboarding?.profile;
  const profileDefinition = getBuiltInMindStoneProfile(profile?.id);
  const profileLabel = sanitizeMarkdownLine(profileDefinition?.label ?? profile?.label) ?? "Unspecified";
  const profileDescription = sanitizeMarkdownLine(profileDefinition?.description ?? profile?.description);
  const purpose = sanitizeMarkdownLine(profileDefinition?.purposeSeed ?? profile?.description);
  const interactionBias = profileDefinition?.interactionBias ?? [];
  const memoryPriorities = profileDefinition?.memoryPriorities ?? [];
  const suggestedSkills = profileDefinition?.suggestedSkills ?? [];
  const boundaries = profileDefinition?.boundaries ?? [];
  const preferenceLines = formatPreferenceLines(params.config.onboarding?.preferences);
  const identitySeedLines = formatIdentitySeedLines(params.config.onboarding?.identity);

  return `# ${params.name}

This identity was synthesized by \`mindstone identity activate\` on ${params.now}.

It is a first-activation working identity derived from the audited onboarding profile, preferences, identity seed, and user context path. It is not immutable and may be revised through explicit user-approved identity work. It should not pretend to remember experiences that are not present in transcript, memory, or user-provided context.

## Who I am

I am ${params.name}, a MindStone agent for ${purpose ?? "the configured user purpose"}.

My identity is operational: it exists to make collaboration more reliable, not to perform personality. I should show continuity through verified context, careful judgment, and accountable follow-through.

## Profile seed

- Profile: ${profileLabel}
${profileDescription ? `- Description: ${profileDescription}\n` : ""}${purpose ? `- Purpose: ${purpose}\n` : ""}${interactionBias.length ? `- Interaction bias:\n${interactionBias.map((item) => `  - ${item}`).join("\n")}\n` : ""}${suggestedSkills.length ? `- Suggested skills:\n${suggestedSkills.map((item) => `  - ${item}`).join("\n")}\n` : ""}
## Collaboration preferences

${preferenceLines.join("\n")}

## Identity emergence seed

${identitySeedLines.join("\n")}

## Operating boundaries

- Be honest about uncertainty and distinguish verified facts from inference.
- Do not claim work is complete unless it was tested or otherwise verified.
- Ask before destructive filesystem, git, database, credential, or memory operations.
- Keep secrets and sensitive context out of casual disclosure.
${boundaries.map((item) => `- ${item}`).join("\n")}

## Continuity and memory stance

- Treat transcript history as authoritative continuity.
- Keep standing identity/user context thin and durable.
- Use recall/memory as evidence, not as a license to fabricate certainty.
${memoryPriorities.length ? `- Memory priorities from profile:\n${memoryPriorities.map((item) => `  - ${item}`).join("\n")}` : "- Memory priorities: preserve user preferences, active project facts, important decisions, and recurring constraints."}

## User context

The paired user context file is:

\`\`\`text
${params.userPath ?? "unset"}
\`\`\`

User context file present at activation: ${params.userExists}.

Read USER.md as durable user/project context, not as a transcript. If USER.md contains sensitive cautions, protect them.

## Activation provenance

- Agent id: ${params.agentId}
- Config path: ${params.configPath}
- Identity path: ${params.identityPath ?? "unset"}
- Prior identity state: ${params.previousIdentityPending ? "pending scaffold" : "missing or force-activated"}
- Activation command: \`mindstone identity activate\`
`;
}

export function synthesizeMindStoneIdentityActivation(
  options: MindStoneIdentityActivationOptions = {},
): MindStoneIdentityActivationResult {
  const configPath = resolve(options.configPath ?? resolveConfigPath());
  const loaded = loadMindStoneConfig(configPath);
  if (loaded.error) throw new Error(`Cannot load MindStone config at ${configPath}: ${loaded.error}`);
  if (!loaded.config) throw new Error(`MindStone config not found: ${configPath}`);

  const config = loaded.config;
  const agentId = options.agentId ?? config.routing?.defaultAgentId ?? "default";
  const agent = config.agents?.[agentId];
  if (!agent) throw new Error(`Agent not configured: ${agentId}`);

  const identityPath = agent.identityPath ? resolvePathRelativeToConfig(agent.identityPath, configPath) : undefined;
  const userPath = agent.userPath ? resolvePathRelativeToConfig(agent.userPath, configPath) : undefined;
  if (!identityPath) throw new Error(`Agent ${agentId} has no identityPath configured`);

  const identityExists = existsSync(identityPath);
  const userExists = userPath ? existsSync(userPath) : false;
  const previousIdentity = identityExists ? readFileSync(identityPath, "utf-8") : "";
  const previousIdentityPending = identityExists ? isPendingIdentity(previousIdentity) : false;
  const name = synthesizeName(config, agentId);
  const now = options.now ?? new Date().toISOString();
  const identityMarkdown = buildActivatedIdentityMarkdown({
    config,
    configPath,
    agentId,
    name,
    identityPath,
    userPath,
    userExists,
    previousIdentityPending,
    now,
  });

  if (identityExists && !previousIdentityPending && !options.force) {
    return {
      ok: true,
      wrote: false,
      wouldWrite: false,
      dryRun: options.dryRun === true,
      forced: false,
      reason: "identity_not_pending",
      agentId,
      name,
      configPath,
      identityPath,
      userPath,
      identityExists,
      userExists,
      previousIdentityPending,
      identityMarkdown,
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      wrote: false,
      wouldWrite: true,
      dryRun: true,
      forced: options.force === true,
      reason: "dry_run",
      agentId,
      name,
      configPath,
      identityPath,
      userPath,
      identityExists,
      userExists,
      previousIdentityPending,
      identityMarkdown,
    };
  }

  mkdirSync(dirname(identityPath), { recursive: true });
  const backupPath = identityExists ? `${identityPath}.pre-activation-${safeTimestamp(now)}.bak` : undefined;
  if (backupPath) writeFileSync(backupPath, previousIdentity, "utf-8");
  writeFileSync(identityPath, `${identityMarkdown.trimEnd()}\n`, "utf-8");

  return {
    ok: true,
    wrote: true,
    wouldWrite: true,
    dryRun: false,
    forced: options.force === true,
    reason: identityExists ? "activated_pending_identity" : "created_identity",
    agentId,
    name,
    configPath,
    identityPath,
    userPath,
    identityExists,
    userExists,
    previousIdentityPending,
    backupPath,
    identityMarkdown,
  };
}
