import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import { INTEGRATION_BUILDER_SKILL, formatIntegrationBuilderSkillMarkdown } from "./integration-builder.js";
import type { MindStoneSkillDefinition } from "./types.js";

/**
 * On-disk skill artifact layout (issue #13), mirroring the persona package pattern:
 *
 *   <skillsDir>/<id>/skill.json + SKILL.md          — installed (approved) skills
 *   <skillsDir>/drafts/<id>/skill.json + SKILL.md   — drafts awaiting explicit install
 *
 * The draft -> install hop is the named approval boundary: generated skills are
 * never discoverable as installed until an operator promotes them.
 */

export type MindStoneSkillSource = "builtin" | "installed" | "draft";

export type MindStoneSkillArtifact = MindStoneSkillDefinition & {
  version?: string;
  /** Where this artifact came from, e.g. "builtin:integration-builder" or "custom". */
  origin?: string;
  createdAt?: string;
};

export type MindStoneSkill = {
  artifact: MindStoneSkillArtifact;
  source: MindStoneSkillSource;
  dir?: string;
  /** SKILL.md body — the loadable prompt surface for the skill. */
  skillMarkdown?: string;
};

export type MindStoneSkillSummary = {
  id: string;
  label: string;
  description?: string;
  version?: string;
  source: MindStoneSkillSource;
  dir?: string;
  error?: string;
};

export type MindStoneSkillRefStatus = {
  id: string;
  status: MindStoneSkillSource | "missing";
};

export function skillsDirFromConfig(config: MindStoneConfig | undefined, paths?: MindStoneRuntimePaths): string {
  const resolved = paths ?? runtimePathsFromEnv();
  return resolve(config?.skills?.dir ?? join(resolved.dataDir, "skills"));
}

export function skillDraftsDir(skillsDir: string): string {
  return join(skillsDir, "drafts");
}

export function builtinMindStoneSkills(): MindStoneSkill[] {
  return [
    {
      artifact: { ...INTEGRATION_BUILDER_SKILL, version: "1.0.0", origin: "builtin" },
      source: "builtin",
      skillMarkdown: formatIntegrationBuilderSkillMarkdown(),
    },
  ];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function validateSkillId(id: string): string | undefined {
  if (!SKILL_ID_PATTERN.test(id)) return `Invalid skill id "${id}": expected lowercase letters, digits, and hyphens`;
  if (id === "drafts") return `Invalid skill id "drafts": reserved for the draft area`;
  return undefined;
}

export type LoadSkillArtifactResult =
  | { ok: true; skill: MindStoneSkill }
  | { ok: false; skillId: string; error: string };

export function loadMindStoneSkillArtifact(dir: string, skillId: string, source: MindStoneSkillSource): LoadSkillArtifactResult {
  const skillDir = join(dir, skillId);
  const jsonPath = join(skillDir, "skill.json");
  if (!existsSync(jsonPath)) {
    return { ok: false, skillId, error: `skill.json not found at ${jsonPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } catch (error) {
    return { ok: false, skillId, error: `skill.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, skillId, error: "skill.json must be an object" };
  }
  const record = parsed as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (!id) return { ok: false, skillId, error: "skill.json is missing required string field: id" };
  if (id !== skillId) return { ok: false, skillId, error: `skill.json id "${id}" does not match directory name "${skillId}"` };
  const label = typeof record.label === "string" && record.label.trim() ? record.label : undefined;
  if (!label) return { ok: false, skillId, error: "skill.json is missing required string field: label" };
  const description = typeof record.description === "string" && record.description.trim() ? record.description : undefined;
  if (!description) return { ok: false, skillId, error: "skill.json is missing required string field: description" };

  const skillMdPath = join(skillDir, "SKILL.md");
  // An unreadable SKILL.md (permissions, a directory in its place) is this
  // skill's error, never a throw: skills are loaded on every owner turn (#104).
  let skillMarkdown: string | undefined;
  try {
    skillMarkdown = existsSync(skillMdPath) ? readFileSync(skillMdPath, "utf-8") : undefined;
  } catch (error) {
    return { ok: false, skillId, error: `SKILL.md can't be read at ${skillMdPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!skillMarkdown?.trim()) {
    return { ok: false, skillId, error: `SKILL.md missing or empty at ${skillMdPath}` };
  }

  return {
    ok: true,
    skill: {
      artifact: {
        id,
        label,
        description,
        goal: typeof record.goal === "string" && record.goal.trim() ? record.goal : undefined,
        whenToUse: stringList(record.whenToUse),
        outputs: stringList(record.outputs),
        safetyNotes: stringList(record.safetyNotes),
        version: typeof record.version === "string" ? record.version : undefined,
        origin: typeof record.origin === "string" ? record.origin : undefined,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
      },
      source,
      dir: skillDir,
      skillMarkdown,
    },
  };
}

function discoverArtifactDirs(dir: string, source: MindStoneSkillSource): MindStoneSkillSummary[] {
  if (!existsSync(dir)) return [];
  const summaries: MindStoneSkillSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (source === "installed" && entry.name === "drafts") continue;
    const loaded = loadMindStoneSkillArtifact(dir, entry.name, source);
    if (loaded.ok) {
      summaries.push({
        id: loaded.skill.artifact.id,
        label: loaded.skill.artifact.label,
        description: loaded.skill.artifact.description,
        version: loaded.skill.artifact.version,
        source,
        dir: loaded.skill.dir,
      });
    } else {
      summaries.push({ id: entry.name, label: entry.name, source, dir: join(dir, entry.name), error: loaded.error });
    }
  }
  return summaries;
}

/** Discover every skill surface: built-ins, installed artifacts, and drafts awaiting approval. */
export function discoverMindStoneSkills(skillsDir: string): MindStoneSkillSummary[] {
  const builtins: MindStoneSkillSummary[] = builtinMindStoneSkills().map((skill) => ({
    id: skill.artifact.id,
    label: skill.artifact.label,
    description: skill.artifact.description,
    version: skill.artifact.version,
    source: "builtin",
  }));
  return [
    ...builtins,
    ...discoverArtifactDirs(skillsDir, "installed"),
    ...discoverArtifactDirs(skillDraftsDir(skillsDir), "draft"),
  ].sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source));
}

/** Load one skill by id: installed wins over draft; built-ins resolve when no artifact shadows them. */
export function loadMindStoneSkill(skillsDir: string, skillId: string): LoadSkillArtifactResult {
  if (existsSync(join(skillsDir, skillId, "skill.json"))) {
    return loadMindStoneSkillArtifact(skillsDir, skillId, "installed");
  }
  if (existsSync(join(skillDraftsDir(skillsDir), skillId, "skill.json"))) {
    return loadMindStoneSkillArtifact(skillDraftsDir(skillsDir), skillId, "draft");
  }
  const builtin = builtinMindStoneSkills().find((skill) => skill.artifact.id === skillId);
  if (builtin) return { ok: true, skill: builtin };
  return { ok: false, skillId, error: `Skill not found: ${skillId} (checked installed, drafts, and built-ins under ${skillsDir})` };
}

export type BuildSkillDraftInput = {
  skillsDir: string;
  /** Seed the draft from a built-in skill (the Integration Builder is the first example). */
  fromBuiltin?: string;
  id?: string;
  label?: string;
  description?: string;
  /** What the skill is for (#104). */
  goal?: string;
  whenToUse?: string[];
  outputs?: string[];
  safetyNotes?: string[];
  skillMarkdown?: string;
  force?: boolean;
  now?: string;
};

export type BuildSkillDraftResult =
  | { ok: true; skillId: string; dir: string; artifact: MindStoneSkillArtifact }
  | { ok: false; error: string };

/** Generate a skill DRAFT artifact. Drafts are not usable until explicitly installed. */
export type ComposeSkillDraftResult =
  | { ok: true; artifact: MindStoneSkillArtifact; skillMarkdown: string }
  | { ok: false; error: string };

/** A draft's skill.json and SKILL.md, checked but not written anywhere. */
export function composeMindStoneSkillDraft(input: Omit<BuildSkillDraftInput, "skillsDir" | "force">): ComposeSkillDraftResult {
  let artifact: MindStoneSkillArtifact;
  let skillMarkdown: string;

  if (input.fromBuiltin) {
    const builtin = builtinMindStoneSkills().find((skill) => skill.artifact.id === input.fromBuiltin);
    if (!builtin) return { ok: false, error: `Unknown built-in skill: ${input.fromBuiltin}` };
    const id = input.id ?? builtin.artifact.id;
    const idError = validateSkillId(id);
    if (idError) return { ok: false, error: idError };
    artifact = {
      ...builtin.artifact,
      id,
      label: input.label ?? builtin.artifact.label,
      description: input.description ?? builtin.artifact.description,
      goal: input.goal ?? builtin.artifact.goal,
      origin: `builtin:${builtin.artifact.id}`,
      createdAt: input.now,
    };
    skillMarkdown = input.skillMarkdown ?? builtin.skillMarkdown ?? "";
  } else {
    if (!input.id) return { ok: false, error: "Skill id is required (--id or --from-builtin)" };
    const idError = validateSkillId(input.id);
    if (idError) return { ok: false, error: idError };
    if (!input.label?.trim()) return { ok: false, error: "Skill label is required (--label)" };
    if (!input.description?.trim()) return { ok: false, error: "Skill description is required (--description)" };
    artifact = {
      id: input.id,
      label: input.label,
      description: input.description,
      goal: input.goal?.trim() || undefined,
      whenToUse: input.whenToUse ?? [],
      outputs: input.outputs ?? [],
      safetyNotes: input.safetyNotes ?? [],
      version: "0.1.0",
      origin: "custom",
      createdAt: input.now,
    };
    skillMarkdown = input.skillMarkdown ?? skillOutlineMarkdown(artifact);
  }
  return { ok: true, artifact, skillMarkdown };
}

/** The SKILL.md a draft gets when no instructions are given: an outline of its fields. */
export function skillOutlineMarkdown(artifact: MindStoneSkillArtifact): string {
  const list = (items?: string[]) => (items ?? []).map((item) => `- ${item}`);
  return [
    `# ${artifact.label}`,
    "",
    artifact.description,
    "",
    ...(artifact.goal ? ["## Goal", "", artifact.goal, ""] : []),
    ...(artifact.whenToUse?.length ? ["## When to use", "", ...list(artifact.whenToUse), ""] : []),
    ...(artifact.outputs?.length ? ["## Outputs", "", ...list(artifact.outputs), ""] : []),
    ...(artifact.safetyNotes?.length ? ["## Safety notes", "", ...list(artifact.safetyNotes), ""] : []),
  ].join("\n");
}

export function buildMindStoneSkillDraft(input: BuildSkillDraftInput): BuildSkillDraftResult {
  const composed = composeMindStoneSkillDraft(input);
  if (!composed.ok) return composed;
  const { artifact, skillMarkdown } = composed;
  const draftDir = join(skillDraftsDir(input.skillsDir), artifact.id);
  if (existsSync(join(draftDir, "skill.json")) && !input.force) {
    return { ok: false, error: `Draft already exists at ${draftDir} (use --force to overwrite)` };
  }
  if (existsSync(join(input.skillsDir, artifact.id, "skill.json")) && !input.force) {
    return { ok: false, error: `Skill "${artifact.id}" is already installed at ${join(input.skillsDir, artifact.id)} (use --force to draft over it)` };
  }
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(join(draftDir, "skill.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(join(draftDir, "SKILL.md"), skillMarkdown.endsWith("\n") ? skillMarkdown : `${skillMarkdown}\n`);
  return { ok: true, skillId: artifact.id, dir: draftDir, artifact };
}

export type InstallSkillResult =
  | { ok: true; skillId: string; dir: string }
  | { ok: false; error: string };

/** Promote a draft to installed — the explicit approval step. Validates the draft loads cleanly first. */
export function installMindStoneSkill(skillsDir: string, skillId: string, options: { force?: boolean } = {}): InstallSkillResult {
  const draftsDir = skillDraftsDir(skillsDir);
  const loaded = loadMindStoneSkillArtifact(draftsDir, skillId, "draft");
  if (!loaded.ok) return { ok: false, error: `Cannot install ${skillId}: ${loaded.error}` };
  const installedDir = join(skillsDir, skillId);
  if (existsSync(join(installedDir, "skill.json")) && !options.force) {
    return { ok: false, error: `Skill "${skillId}" is already installed at ${installedDir} (use --force to replace)` };
  }
  writeInstalledMindStoneSkill(skillsDir, loaded.skill.artifact, loaded.skill.skillMarkdown ?? "");
  rmSync(join(draftsDir, skillId), { recursive: true, force: true });
  return { ok: true, skillId, dir: installedDir };
}

/**
 * Write an installed skill directly, without a draft: an approved chat
 * proposal (#104) never touches drafts/, so an admin's draft with the same id
 * is left alone. Replaces an installed skill of that id.
 */
export function writeInstalledMindStoneSkill(skillsDir: string, artifact: MindStoneSkillArtifact, skillMarkdown: string): string {
  const idError = validateSkillId(artifact.id);
  if (idError) throw new Error(idError);
  const installedDir = join(skillsDir, artifact.id);
  mkdirSync(installedDir, { recursive: true });
  // Both files are written in full first, then renamed into place, SKILL.md
  // before skill.json: a failure part-way never pairs a new skill.json with
  // an old or missing SKILL.md.
  const md = join(installedDir, ".SKILL.md.tmp");
  const json = join(installedDir, ".skill.json.tmp");
  try {
    writeFileSync(md, skillMarkdown.endsWith("\n") ? skillMarkdown : `${skillMarkdown}\n`);
    writeFileSync(json, `${JSON.stringify(artifact, null, 2)}\n`);
    renameSync(md, join(installedDir, "SKILL.md"));
    renameSync(json, join(installedDir, "skill.json"));
  } finally {
    rmSync(md, { force: true });
    rmSync(json, { force: true });
  }
  return installedDir;
}

/** Resolve persona/workflow skills[] references against the discoverable skill surfaces. */
export function resolveSkillRefs(ids: string[], skillsDir: string): MindStoneSkillRefStatus[] {
  const summaries = discoverMindStoneSkills(skillsDir);
  return ids.map((id) => {
    const matches = summaries.filter((summary) => summary.id === id && !summary.error);
    const installed = matches.find((summary) => summary.source === "installed");
    const builtin = matches.find((summary) => summary.source === "builtin");
    const draft = matches.find((summary) => summary.source === "draft");
    const resolved = installed ?? builtin ?? draft;
    return { id, status: resolved ? resolved.source : "missing" };
  });
}
