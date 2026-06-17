export type BuiltInMindStoneProfileId =
  | "general_companion"
  | "software_engineering_partner"
  | "integration_builder"
  | "research_analyst"
  | "project_strategist"
  | "cybersecurity_specialist"
  | "business_advisor"
  | "therapist_reflective_support"
  | "life_coach"
  | "health_advisor";

export type MindStoneProfileDefinition = {
  id: BuiltInMindStoneProfileId;
  label: string;
  shortLabel: string;
  description: string;
  purposeSeed: string;
  interactionBias: string[];
  memoryPriorities: string[];
  suggestedSkills: string[];
  boundaries: string[];
};

export type MindStoneSelectedProfile = {
  id: BuiltInMindStoneProfileId | "custom";
  label: string;
  description: string;
  customDescription?: string;
  selectedAt?: string;
};
