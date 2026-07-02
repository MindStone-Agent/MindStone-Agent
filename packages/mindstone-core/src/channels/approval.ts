import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type { ConnectorOutboundMessage } from "./connector.js";

/**
 * Durable proposed-action store (issue #21, designed to be absorbed by the
 * #24 Approval Center). Actions with consequences — sending an email, writing
 * a memory file — are PROPOSED here instead of executed; a human decision
 * (approve/reject) is required to act. Records are never deleted by
 * decisions: approved/rejected entries retain their full payload + decision
 * metadata, which together with the `approval_proposed`/`approval_decided`
 * transcript events is the audit trail the ticket requires.
 *
 * #21 ships two action kinds; #24 extends the taxonomy (tasks, calendar,
 * skills, personas, workflows, config) and adds a UI + defer on top of this
 * same store.
 */
export type ProposedActionKind = "connector_send" | "memory_write";

export type ProposedActionStatus = "pending" | "approved" | "rejected";

export type MemoryWritePayload = {
  /** Relative path inside the memory directory (sanitized on apply). */
  path: string;
  content: string;
};

export type ProposedAction = {
  id: string;
  kind: ProposedActionKind;
  /** Connector that produced the proposal (e.g. "email"). */
  connectorId: string;
  sessionKey?: string;
  agentId?: string;
  createdAt?: string;
  /** Human-readable one-liner for list surfaces. */
  summary: string;
  /** connector_send: the ConnectorOutboundMessage to enqueue on approval. */
  send?: ConnectorOutboundMessage;
  /** memory_write: the memory file proposal to apply on approval. */
  memory?: MemoryWritePayload;
  status: ProposedActionStatus;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
};

type ApprovalFile = {
  actions: ProposedAction[];
};

export type ApprovalStoreStatus = {
  pending: number;
  approved: number;
  rejected: number;
};

export function approvalsPath(paths?: MindStoneRuntimePaths): string {
  const resolved = paths ?? runtimePathsFromEnv();
  return join(resolved.dataDir, "approvals", "actions.json");
}

export class ApprovalStore {
  readonly #path: string;

  constructor(options: { paths?: MindStoneRuntimePaths; path?: string } = {}) {
    this.#path = options.path ?? approvalsPath(options.paths);
  }

  get path(): string {
    return this.#path;
  }

  #read(): ApprovalFile {
    if (!existsSync(this.#path)) return { actions: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as ApprovalFile).actions)) return parsed as ApprovalFile;
    } catch {
      // fall through — a corrupt approvals file is replaced, not fatal
    }
    return { actions: [] };
  }

  #write(file: ApprovalFile): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.tmp-${randomUUID().slice(0, 8)}`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temp, this.#path);
  }

  propose(action: Omit<ProposedAction, "id" | "status">): ProposedAction {
    const file = this.#read();
    const record: ProposedAction = { ...action, id: randomUUID(), status: "pending" };
    file.actions.push(record);
    this.#write(file);
    return record;
  }

  list(): ProposedAction[] {
    return this.#read().actions;
  }

  pending(): ProposedAction[] {
    return this.#read().actions.filter((action) => action.status === "pending");
  }

  get(id: string): ProposedAction | undefined {
    // Full ids match exactly; short prefixes (>= 8 chars) match uniquely.
    const actions = this.#read().actions;
    const exact = actions.find((action) => action.id === id);
    if (exact) return exact;
    if (id.length < 8) return undefined;
    const matches = actions.filter((action) => action.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Record a decision on a pending action. Decisions are immutable — deciding
   * a non-pending action throws rather than silently rewriting history.
   */
  decide(id: string, decision: { status: "approved" | "rejected"; decidedBy?: string; note?: string; now?: string }): ProposedAction {
    const file = this.#read();
    const target = file.actions.find((action) => action.id === id) ?? (id.length >= 8 ? singlePrefixMatch(file.actions, id) : undefined);
    if (!target) throw new Error(`no proposed action matches id "${id}"`);
    if (target.status !== "pending") throw new Error(`action ${target.id} is already ${target.status}; decisions are immutable`);
    target.status = decision.status;
    target.decidedAt = decision.now;
    target.decidedBy = decision.decidedBy;
    target.decisionNote = decision.note;
    this.#write(file);
    return target;
  }

  status(): ApprovalStoreStatus {
    const actions = this.#read().actions;
    return {
      pending: actions.filter((action) => action.status === "pending").length,
      approved: actions.filter((action) => action.status === "approved").length,
      rejected: actions.filter((action) => action.status === "rejected").length,
    };
  }
}

function singlePrefixMatch(actions: ProposedAction[], prefix: string): ProposedAction | undefined {
  const matches = actions.filter((action) => action.id.startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

// ---------------------------------------------------------------------------
// Send-policy resolution (issue #21): connectors whose outbound has real-world
// consequences declare approval_required as their default; config may override
// per channel, but the override is an explicit policy act surfaced by doctor.
// ---------------------------------------------------------------------------

export type ConnectorSendPolicy = "auto" | "approval_required";

export function resolveConnectorSendPolicy(params: {
  /** The connector's declared default (undefined = auto, the chat-connector norm). */
  connectorDefault?: ConnectorSendPolicy;
  channelConfig: Record<string, unknown> | undefined;
}): ConnectorSendPolicy {
  const configured = params.channelConfig?.sendPolicy;
  if (configured === "auto" || configured === "approval_required") return configured;
  return params.connectorDefault ?? "auto";
}

// ---------------------------------------------------------------------------
// Memory-proposal block extraction (issue #21): a routed reply may carry one
// fenced block proposing a durable memory write. The block is extracted (and
// stripped from the draft text) into a memory_write ProposedAction — email-
// derived memory is always proposed, never written directly. The reply text
// derives from untrusted email content (prompt injection), which is exactly
// why this terminates in the human approval gate.
// ---------------------------------------------------------------------------

const MEMORY_PROPOSAL_FENCE = /```mindstone-memory-proposal\s*\n([\s\S]*?)```/;

export function extractMemoryProposal(replyText: string): { text: string; proposal?: MemoryWritePayload } {
  const match = replyText.match(MEMORY_PROPOSAL_FENCE);
  if (!match) return { text: replyText };
  const stripped = (replyText.slice(0, match.index) + replyText.slice((match.index ?? 0) + match[0].length)).trim();
  try {
    const parsed = JSON.parse(match[1]);
    const path = typeof parsed?.path === "string" ? parsed.path.trim() : "";
    const content = typeof parsed?.content === "string" ? parsed.content : "";
    if (!path || !content) return { text: stripped };
    return { text: stripped, proposal: { path, content } };
  } catch {
    // malformed proposal blocks are dropped from the draft, never applied
    return { text: stripped };
  }
}

/**
 * Sanitize a memory-proposal path on APPLY (not on propose — the record keeps
 * what the model asked for, the apply step constrains it): relative, no
 * traversal, markdown extension enforced.
 */
export function sanitizeMemoryProposalPath(path: string): string | undefined {
  const cleaned = path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!cleaned || cleaned.includes("..")) return undefined;
  const withExt = cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
  return withExt;
}
