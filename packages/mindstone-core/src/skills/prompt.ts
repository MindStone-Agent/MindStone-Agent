import { estimatePromptTokens } from "../context/index.js";
import { discoverMindStoneSkills, loadMindStoneSkillArtifact, type MindStoneSkillArtifact } from "./artifacts.js";

/**
 * Installed skills in the owner's prompt (#104). Every field an admin reviews
 * before installing (label, description, goal, when to use, outputs, safety
 * notes and SKILL.md) is what the agent reads. Skills past the budget are
 * listed by name only, and the Skills page says which.
 */
export const SKILLS_PROMPT_BUDGET = 24_000;

export type MindStoneSkillsPromptResult = {
  promptText: string;
  tokens: number;
  installed: number;
  /** Installed skills whose full text is in the prompt. */
  inPrompt: string[];
  /** Installed skills over the budget: only their id, label and description are in the prompt. */
  listedOnly: string[];
};

/** A skill's text can't close the wrapper it sits in. */
function contained(text: string): string {
  return text.replace(/<\/(skill|mindstone-skills)\b/gi, "</ $1");
}

/** One installed skill as the agent reads it: every reviewed field, then SKILL.md. */
export function renderMindStoneSkillForPrompt(artifact: MindStoneSkillArtifact, skillMarkdown: string): string {
  const list = (title: string, items?: string[]) => (items && items.length ? [`${title}:`, ...items.map((item) => `- ${item}`)] : []);
  return [
    `<skill id="${artifact.id}">`,
    contained(
      [
        `Label: ${artifact.label}`,
        `Description: ${artifact.description}`,
        ...(artifact.goal ? [`Goal: ${artifact.goal}`] : []),
        ...list("When to use", artifact.whenToUse),
        ...list("Outputs", artifact.outputs),
        ...list("Safety notes", artifact.safetyNotes),
        "Instructions (SKILL.md):",
        skillMarkdown.trim(),
      ].join("\n"),
    ),
    "</skill>",
  ].join("\n");
}

export function buildMindStoneSkillsPrompt(skillsDir: string, options: { budget?: number } = {}): MindStoneSkillsPromptResult {
  const budget = options.budget ?? SKILLS_PROMPT_BUDGET;
  const installed = discoverMindStoneSkills(skillsDir).filter((skill) => skill.source === "installed" && !skill.error);
  const full: string[] = [];
  const listed: string[] = [];
  const inPrompt: string[] = [];
  const listedOnly: string[] = [];
  let used = 0;
  for (const summary of installed) {
    const loaded = loadMindStoneSkillArtifact(skillsDir, summary.id, "installed");
    if (!loaded.ok) continue;
    const block = renderMindStoneSkillForPrompt(loaded.skill.artifact, loaded.skill.skillMarkdown ?? "");
    if (used + block.length <= budget) {
      full.push(block);
      inPrompt.push(summary.id);
      used += block.length;
    } else {
      listed.push(contained(`- ${summary.id}: ${summary.label}. ${summary.description ?? ""}`.trim()));
      listedOnly.push(summary.id);
    }
  }
  const lines = ["<mindstone-skills>"];
  if (full.length || listed.length) {
    lines.push("Installed skills. Follow a skill's instructions when the owner's request matches it.", ...full);
    if (listed.length) {
      lines.push(
        "These installed skills are over the prompt budget, so their instructions aren't loaded. If the owner asks for one, say so: an admin can remove other skills to make room.",
        ...listed,
      );
    }
  } else {
    lines.push("No skills are installed yet.");
  }
  lines.push(
    "When the owner asks you to create a skill, draft it and propose it for install by ending your reply with one fenced block, with the closing ``` on its own line:",
    "```mindstone-skill-proposal",
    '{"id":"lowercase-with-hyphens","label":"Short name","description":"What it does","goal":"What it is for","whenToUse":["..."],"outputs":["..."],"safetyNotes":["..."],"instructions":"The skill\'s instructions, in markdown"}',
    "```",
    "Before the block, tell the owner in a sentence or two what the skill does and that it is waiting for their approval on the Console's Approvals page.",
    "Only propose a skill when the owner asks for one. It is held for the owner's approval and does nothing until then.",
    "</mindstone-skills>",
  );
  const promptText = lines.join("\n");
  return { promptText, tokens: estimatePromptTokens(promptText), installed: installed.length, inPrompt, listedOnly };
}
