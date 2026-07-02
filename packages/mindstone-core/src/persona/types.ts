export type MindStonePersonaMetadata = {
  name?: string;
  version?: string;
  description?: string;
};

export type MindStonePersona = {
  id: string;
  dir: string;
  name: string;
  version?: string;
  description?: string;
  /** PERSONA.md body — the role/domain overlay text. */
  personaMarkdown: string;
  /** safety.md body, if present — appended to the overlay prompt. */
  safetyMarkdown?: string;
  /** Referenced capability ids from skills.json/workflows.json/knowledgebases.json (metadata for now). */
  skills: string[];
  workflows: string[];
  knowledgebases: string[];
};

export type MindStonePersonaSummary = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  dir: string;
  hasSafety: boolean;
  skillCount: number;
  workflowCount: number;
  knowledgebaseCount: number;
  error?: string;
};

export type MindStonePersonaResolution = {
  personaId: string;
  /** Why this persona is active: "route:<field>" or "config.active". */
  reason: string;
};

export type MindStoneRoutePersonaContext = {
  personaId: string;
  reason: string;
  promptText: string;
};

export type MindStoneRoutePersonaContextSummary = {
  injected: boolean;
  personaId: string;
  reason: string;
  tokenEstimate: number;
};
