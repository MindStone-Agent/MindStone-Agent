export type MindStoneSkillDefinition = {
  id: string;
  label: string;
  description: string;
  /** What the skill is for, in the owner's words (#104). */
  goal?: string;
  whenToUse: string[];
  outputs: string[];
  safetyNotes: string[];
};
