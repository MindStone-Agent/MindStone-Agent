import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MindStoneWorkflowDecision } from "../workflow/types.js";
import type { MindStonePersona } from "./types.js";

/**
 * A persona's components at run time (#125). A persona lists skills,
 * workflows and global knowledge-base collections, and owns private
 * knowledge bases under its own folder. This module decides, per turn,
 * which of those are in play.
 */

/** Where a persona's private knowledge bases live: `<personas>/<id>/knowledgebases/<kbId>/`, in the global KB format. */
export function personaKnowledgebasesDir(personaDir: string): string {
  return join(personaDir, "knowledgebases");
}

/**
 * The persona's private-KB folder, when it is a real directory. A link there
 * could point anywhere, so it is not searched (#125: private KBs are the
 * persona's own files).
 */
export function readablePersonaKnowledgebasesDir(personaDir: string): string | undefined {
  const dir = personaKnowledgebasesDir(personaDir);
  try {
    return lstatSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Letters, digits, dot, underscore and hyphen, not starting with a dot: one folder name, never a path. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export function isSafeComponentId(value: string | undefined): value is string {
  return typeof value === "string" && SAFE_SEGMENT.test(value);
}

/**
 * Which turns get the active persona's private knowledge bases. The product
 * owner (#125, 2026-09-28): "Owner and whatever persona it's attached to (but
 * it is owner driven)", confirmed as: a private KB is recalled on the owner's
 * turns and on tenant App Engine runs under its persona, never under another
 * persona. Non-owner chats get no recall at all, so they never reach here.
 */
export function privateKnowledgebasesAllowed(audience: string | undefined): boolean {
  return audience === "owner" || audience === "tenant";
}

export type MindStoneTurnComponents = {
  /** The persona whose components apply; absent when no persona is active. */
  personaId?: string;
  /** Installed skill ids allowed in the prompt. Absent: every installed skill. */
  skills?: string[];
  /** Global KB collections searched. Absent: every global collection. */
  globalKnowledgebases?: string[];
  /**
   * A workflow step's `knowledgebases`: they narrow global and private KBs
   * separately (see `discoverKnowledgebaseRecallDocuments`), so naming a
   * private KB never switches global recall off.
   */
  stepKnowledgebases?: string[];
  /** The persona's private KBs searched on this turn; absent when none are. */
  privateKnowledgebases?: { personaId: string; dir: string };
};

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** A step's list narrows a set: absent set means "everything", so the step's list is the set. */
function narrow(base: string[] | undefined, step: string[] | undefined): string[] | undefined {
  if (!step?.length) return base;
  return base ? base.filter((id) => step.includes(id)) : unique(step);
}

/**
 * The folder is on disk under exactly this name. A case-insensitive
 * filesystem finds "Persona-Two" for "persona-two"; its private KBs are only
 * used under the id as written on disk, so their recall ids are canonical.
 */
function isExactEntry(path: string): boolean {
  try {
    return readdirSync(dirname(path)).includes(basename(path));
  } catch {
    return false;
  }
}

/** A real directory, not a link (checked on the last path part). */
export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The components in play for one turn. Nothing changes when no persona
 * answers: every skill and every global KB, and a workflow step's lists are
 * only logged, as before.
 * - Skills: the persona's list, or every installed skill when it lists none.
 * - Global KBs: the persona's list, or every collection when it lists none.
 *   Private KBs never switch global recall off.
 * - Private KBs: the persona's own, on the turns `privateKnowledgebasesAllowed`
 *   names, when its id is one folder name and neither its folder nor its
 *   `knowledgebases` folder is a link.
 * - `decision` is the workflow step that applies to this persona (the caller
 *   drops one that routed to a different persona); its `skills` narrow the
 *   skill set and its `knowledgebases` narrow the KBs.
 */
export function resolveTurnComponents(params: {
  persona?: MindStonePersona;
  decision?: MindStoneWorkflowDecision;
  privateAllowed: boolean;
}): MindStoneTurnComponents {
  const { persona, decision } = params;
  if (!persona) return {};
  const skills = narrow(persona.skills.length ? unique(persona.skills) : undefined, decision?.skills);
  const globalKnowledgebases = persona.knowledgebases.length ? unique(persona.knowledgebases) : undefined;
  const privateDir = params.privateAllowed && isSafeComponentId(persona.id) && isRealDirectory(persona.dir) && isExactEntry(persona.dir)
    ? readablePersonaKnowledgebasesDir(persona.dir)
    : undefined;
  return {
    personaId: persona.id,
    ...(skills ? { skills } : {}),
    ...(globalKnowledgebases ? { globalKnowledgebases } : {}),
    ...(decision?.knowledgebases.length ? { stepKnowledgebases: unique(decision.knowledgebases) } : {}),
    ...(privateDir ? { privateKnowledgebases: { personaId: persona.id, dir: privateDir } } : {}),
  };
}

/**
 * The workflow decision that applies to the answering persona. A persona
 * named by the request answers even when a workflow step routed elsewhere;
 * that step's lists belong to the other persona, so they don't narrow this one.
 */
export function decisionForAnsweringPersona<T extends { personaId?: string }>(
  decision: T | undefined,
  forcedPersonaId: string | undefined,
): T | undefined {
  if (!decision) return undefined;
  if (forcedPersonaId && decision.personaId && decision.personaId !== forcedPersonaId) return undefined;
  return decision;
}

/**
 * What a turn record says about the persona's components (#125): the
 * assistant entry and the chat response carry it, so the Console and the
 * journey can see which skills and knowledge bases were in play.
 */
export function personaComponentsSummary(
  components: MindStoneTurnComponents,
  skills?: { inPrompt: string[]; missing?: string[] },
  /** A step's KB ids that match no global or private KB: they narrow nothing. */
  unknownStepKnowledgebases?: string[],
): Record<string, unknown> {
  return {
    personaId: components.personaId,
    skills: components.skills ?? "all",
    ...(skills ? { skillsInPrompt: skills.inPrompt } : {}),
    ...(skills?.missing?.length ? { skillsMissing: skills.missing } : {}),
    globalKnowledgebases: components.globalKnowledgebases ?? "all",
    ...(components.stepKnowledgebases ? { stepKnowledgebases: components.stepKnowledgebases } : {}),
    ...(unknownStepKnowledgebases?.length ? { stepKnowledgebasesUnknown: unknownStepKnowledgebases } : {}),
    privateKnowledgebases: components.privateKnowledgebases ? "own" : "none",
  };
}
