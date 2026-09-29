import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A persona the agent proposes for itself (#105), held on a `persona_create`
 * approval until an admin decides. Only these fields exist: the PERSONA.md
 * is rendered from a fixed template, so a proposal can't add its own
 * sections or instructions beyond them.
 */
export type PersonaProposalPayload = {
  id: string;
  name: string;
  description?: string;
  voice?: string;
  workingStyle?: string;
  boundaries?: string[];
};

export const PERSONA_PROPOSAL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The standing instruction for the owner's turns (#105): how the agent puts a
 * persona up for approval. Nothing is written until an admin approves it.
 */
export const PERSONA_PROPOSAL_INSTRUCTIONS = [
  "# Proposing a persona",
  "When the user asks you to, or once identity formation has given you enough to go on, you can propose a working persona for yourself: your name, voice, working style and boundaries, and the skills, workflows and knowledge bases it works with. It is saved only if the owner approves it in the MindStone Console, and it takes effect only when they switch to it there.",
  "Propose it by ending your reply with exactly one fenced code block, not inside any other block. Its first line is exactly ```mindstone-persona-proposal (no space or line break between the backticks and the name), then one line of JSON, then a line of three backticks. `id` is lowercase letters, digits and hyphens. The JSON looks like this:",
  '{"id":"wren","name":"Wren","description":"One line on who this persona is.","voice":"How you speak.","workingStyle":"How you work with the user.","boundaries":["Something you will not do."]}',
  "It can also carry `components`: existing skills, workflows and shared knowledge bases by id (listing none means all skills and all shared knowledge bases), and new ones it brings. Each new one is its own card that the owner approves after the persona. Bring a new skill only when the owner asked for one; otherwise list existing skills. Limits: up to 3 new skills, each with the fields of a skill proposal and not an existing skill's id; up to 3 new workflows, each with a lowercase id and route or gate steps, none of which names a persona; up to 2 new private knowledge bases, each with a lowercase id and 1 to 5 sources of markdown `text` (at most 20,000 characters each). Don't list an id you also bring as new. If any part doesn't hold up, nothing is saved and your reply says why. For example:",
  '"components":{"skills":["existing-skill"],"workflows":[],"knowledgebases":["shared-kb"],"new":{"skills":[],"workflows":[{"id":"triage","steps":[{"id":"urgent","kind":"route","when":{"messagePrefix":"urgent:"},"skills":["existing-skill"]}]}],"privateKnowledgebases":[{"id":"notes","sources":[{"text":"# Notes\\n\\nWhat this persona should know."}]}]}}',
  "The block is removed from what the user sees, so also say in your reply that you've put a persona up for approval. A persona sets your voice, working style, and the skills, workflows and knowledge bases you use in it: it never overrides your core identity, the user's boundaries or safety rules. Don't claim it is active until the user says they switched to it.",
  "Once switched to, a persona is used in every chat, including other people's chats and connectors, so keep private details about the user out of it and out of its knowledge bases: those belong in USER.md.",
].join("\n");

const LIMITS = { name: 60, description: 300, voice: 1500, workingStyle: 1500, boundary: 300, boundaries: 12 };

/**
 * Characters an approver can't see: controls, format characters (bidi
 * overrides, zero-width joiners, tag characters), private use and
 * unassigned code points. A proposal carrying them is refused, so what the
 * admin reads on the approval card is all the persona holds (#105 review).
 */
const INVISIBLE = /[^\P{C}\n\t]|\p{Default_Ignorable_Code_Point}|[\u2028\u2029\u2800\u3164\uFFA0\u115F\u1160]/u;

/** The same check for text a persona proposal brings with it (#125): KB sources. */
export const PERSONA_TEXT_INVISIBLE = INVISIBLE;

/** Three or more combining marks on one character: they can draw over the card rows around them (#105 review). */
const STACKED_MARKS = /\p{M}{3,}/u;

function text(value: unknown, max: number, singleLine = false): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return false;
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return undefined;
  if (INVISIBLE.test(trimmed) || STACKED_MARKS.test(trimmed)) return false;
  if (trimmed.length > max || (singleLine && /\n/.test(trimmed))) return false;
  return trimmed;
}

/** The payload from a parsed proposal block, or undefined when it doesn't hold up. */
export function parsePersonaProposal(value: unknown): PersonaProposalPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!PERSONA_PROPOSAL_ID.test(id)) return undefined;
  const name = text(record.name, LIMITS.name, true);
  const description = text(record.description, LIMITS.description, true);
  const voice = text(record.voice, LIMITS.voice);
  const workingStyle = text(record.workingStyle, LIMITS.workingStyle);
  if (!name || description === false || voice === false || workingStyle === false) return undefined;
  if (!voice && !workingStyle) return undefined;
  let boundaries: string[] | undefined;
  if (record.boundaries !== undefined) {
    if (!Array.isArray(record.boundaries) || record.boundaries.length > LIMITS.boundaries) return undefined;
    const items = record.boundaries.map((item) => text(item, LIMITS.boundary, true));
    if (items.some((item) => item === false)) return undefined;
    boundaries = items.filter((item): item is string => typeof item === "string");
  }
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(voice ? { voice } : {}),
    ...(workingStyle ? { workingStyle } : {}),
    ...(boundaries?.length ? { boundaries } : {}),
  };
}

/**
 * The proposal's own text stays text: headings (`#`, and setext underlines),
 * code fences and HTML comments are quoted, so nothing in it can open a new
 * section or swallow the footer line.
 */
function quoteHeadings(value: string): string {
  return value
    .replace(/^(\s*)#/gm, "$1\\#")
    .replace(/^(\s*)(=+|-+)(\s*)$/gm, "$1\\$2$3")
    .replace(/`{3,}|~{3,}/g, (fence) => fence.split("").map((char) => `\\${char}`).join(""))
    .replace(/<!--/g, "&lt;!--")
    // An HTML block or a link reference definition at a line start would hide
    // the rest of the file, or itself, in a rendered view.
    .replace(/^(\s*)([<[])/gm, "$1\\$2");
}

export function renderPersonaMarkdown(persona: PersonaProposalPayload): string {
  const lines = [`# ${persona.name}`, ""];
  if (persona.description) lines.push(quoteHeadings(persona.description), "");
  if (persona.voice) lines.push("## Voice", "", quoteHeadings(persona.voice), "");
  if (persona.workingStyle) lines.push("## Working style", "", quoteHeadings(persona.workingStyle), "");
  if (persona.boundaries?.length) lines.push("## Boundaries", "", ...persona.boundaries.map((item) => `- ${quoteHeadings(item)}`), "");
  lines.push("This persona was proposed by the agent and approved by its owner. It sets voice, working style and the components it lists; the core identity, the user's boundaries and the safety rules still govern.");
  return `${lines.join("\n")}\n`;
}

export class PersonaExistsError extends Error {}

/**
 * Write an approved persona into `<personasDir>/<id>/` (PERSONA.md and
 * metadata.json). Never overwrites: an existing id, or anything already at
 * that path (a link included), is refused.
 */
export function writeProposedPersona(params: {
  personasDir: string;
  persona: PersonaProposalPayload;
  approvedBy: string;
  now: string;
}): string {
  if (!PERSONA_PROPOSAL_ID.test(params.persona.id)) throw new Error(`not a persona id: ${params.persona.id}`);
  const dir = join(params.personasDir, params.persona.id);
  mkdirSync(params.personasDir, { recursive: true });
  try {
    // Exclusive: anything already there, a dangling link included, fails
    // with EEXIST, and so does a second approve racing this one.
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PersonaExistsError(`a persona named ${params.persona.id} already exists`);
    throw error;
  }
  try {
  writeFileSync(join(dir, "PERSONA.md"), renderPersonaMarkdown(params.persona), { flag: "wx" });
  writeFileSync(
    join(dir, "metadata.json"),
    `${JSON.stringify({ name: params.persona.name, version: "1", description: params.persona.description, createdBy: "agent", approvedBy: params.approvedBy, approvedAt: params.now }, null, 2)}\n`,
    { flag: "wx" },
  );
  } catch (error) {
    // A half-written persona would block its id for good: remove it.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}
