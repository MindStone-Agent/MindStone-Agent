import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import { appendTranscriptEntry, type TranscriptEntry, type TranscriptSource } from "../transcript/index.js";
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
export type ProposedActionKind = "connector_send" | "memory_write" | "connector_mutation";

export type ProposedActionStatus = "pending" | "approved" | "rejected";

export type MemoryWritePayload = {
  /** Relative path inside the memory directory (sanitized on apply). */
  path: string;
  content: string;
};

/**
 * A proposed mutation against an external service (issue #22): create/update
 * a calendar event, task, etc. Mutations are ALWAYS approval-gated — there is
 * no auto path for connector_mutation at all. On approve the payload is
 * enqueued onto the target connector's delivery queue as a typed outbound
 * message; the connector's sendOutbound applies it (retry/dead-letter apply).
 */
export type ConnectorMutationPayload = {
  /** Target connector (e.g. "calendar"). */
  connectorId: string;
  operation: "create" | "update";
  /** Resource type in the target service's vocabulary (e.g. "event", "task"). */
  resource: string;
  /** Provider-shaped resource data (validated by the connector on apply). */
  data: Record<string, unknown>;
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
  /** connector_mutation: the external-service mutation to apply on approval. */
  mutation?: ConnectorMutationPayload;
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
// Action-proposal block extraction (issues #21/#22): a model reply may carry
// fenced blocks proposing consequential actions — a durable memory write
// (mindstone-memory-proposal) or an external-service mutation such as a
// calendar event (mindstone-calendar-proposal). Blocks are extracted (and
// stripped from the visible reply) into pending ProposedActions — model
// output derives from untrusted input (email bodies, chat), which is exactly
// why every proposal terminates in the human approval gate and is never
// applied directly.
// ---------------------------------------------------------------------------

const PROPOSAL_FENCE = /```mindstone-(memory|calendar)-proposal\s*\n([\s\S]*?)```/g;

export type ExtractedActionProposals = {
  /** Reply text with every proposal block stripped. */
  text: string;
  memory?: MemoryWritePayload;
  mutations: ConnectorMutationPayload[];
};

export function extractActionProposals(replyText: string): ExtractedActionProposals {
  const mutations: ConnectorMutationPayload[] = [];
  let memory: MemoryWritePayload | undefined;
  const text = replyText
    .replace(PROPOSAL_FENCE, (_, fenceKind: string, body: string) => {
      try {
        const parsed = JSON.parse(body);
        if (fenceKind === "memory") {
          const path = typeof parsed?.path === "string" ? parsed.path.trim() : "";
          const content = typeof parsed?.content === "string" ? parsed.content : "";
          if (path && content && !memory) memory = { path, content };
        } else {
          const operation = parsed?.operation === "update" ? "update" : parsed?.operation === "create" ? "create" : undefined;
          const resource = typeof parsed?.resource === "string" && parsed.resource.trim() ? parsed.resource.trim() : "event";
          const data = parsed?.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? (parsed.data as Record<string, unknown>) : undefined;
          if (operation && data) {
            mutations.push({ connectorId: "calendar", operation, resource, data });
          }
        }
      } catch {
        // malformed proposal blocks are dropped from the reply, never applied
      }
      return "";
    })
    .trim();
  return { text, memory, mutations };
}

/** Back-compat single-memory-proposal shape (issue #21 callers/tests). */
export function extractMemoryProposal(replyText: string): { text: string; proposal?: MemoryWritePayload } {
  const extracted = extractActionProposals(replyText);
  return { text: extracted.text, proposal: extracted.memory };
}

/** Strip proposal fences from a string WITHOUT proposing; no-op (identity) when none present. */
export function stripProposalFences(text: string): string {
  const fence = /```mindstone-(?:memory|calendar)-proposal\s*\n[\s\S]*?```/g;
  if (!fence.test(text)) return text;
  fence.lastIndex = 0;
  return text.replace(fence, "").trim();
}

/**
 * Deep strip-only pass over an arbitrary content value (Slate's #22 QA
 * finding): providers may return structured/opaque `content` alongside
 * `text`, and transcript/context/auto-compact/webchat paths can read it — so
 * a fence stripped from `text` must not survive in `content`. Walks plain
 * JSON-ish data (strings, arrays, objects) and strips fences from every
 * string; never proposes (proposing is text-path-only, keeping it
 * single-source).
 */
export function stripActionProposalsDeep(value: unknown): unknown {
  if (typeof value === "string") return stripProposalFences(value);
  if (Array.isArray(value)) return value.map((entry) => stripActionProposalsDeep(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, stripActionProposalsDeep(entry)]));
  }
  return value;
}

/**
 * The single shared proposal-discipline step (issues #21/#22), called by BOTH
 * assistant-reply finalization sites (core chat turn AND the Gateway's
 * configured-route path): extract proposal blocks from the reply, persist
 * them as pending ProposedActions, append approval_proposed audit events, and
 * return the stripped reply text. Nothing consequential executes here — apply
 * happens only via an explicit approve.
 */
export function applyActionProposalDiscipline(params: {
  replyText: string;
  /** Provider `content` payload persisted alongside text — deep-stripped of fences (never proposed from). */
  content?: unknown;
  sessionKey?: string;
  agentId?: string;
  /** Where the reply came from (e.g. "chat", "gateway", "connector:email"). */
  origin: string;
  source?: TranscriptSource;
  runId?: string;
  store?: ApprovalStore;
}): { text: string; content: unknown; events: TranscriptEntry[]; proposals: ProposedAction[] } {
  const extracted = extractActionProposals(params.replyText);
  // Sanitize content whenever it plausibly carries a fence — proposals may
  // exist in content even when text is already clean (diverging shapes).
  const contentProbe = params.content !== undefined ? JSON.stringify(params.content) : undefined;
  const content = contentProbe?.includes("```mindstone-") ? stripActionProposalsDeep(params.content) : params.content;
  if (!extracted.memory && !extracted.mutations.length) {
    return { text: extracted.text, content, events: [], proposals: [] };
  }
  const approvals = params.store ?? new ApprovalStore();
  const proposals: ProposedAction[] = [
    ...(extracted.memory
      ? [approvals.propose({
          kind: "memory_write" as const,
          connectorId: params.origin,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          createdAt: new Date().toISOString(),
          summary: `memory write proposal from ${params.origin}: ${extracted.memory.path}`,
          memory: extracted.memory,
        })]
      : []),
    ...extracted.mutations.map((mutation) =>
      approvals.propose({
        kind: "connector_mutation" as const,
        connectorId: mutation.connectorId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        createdAt: new Date().toISOString(),
        summary: `${mutation.operation} ${mutation.resource} via ${mutation.connectorId}: ${JSON.stringify(mutation.data).slice(0, 80)}`,
        mutation,
      }),
    ),
  ];
  const events = params.sessionKey
    ? proposals.map((proposal) =>
        appendTranscriptEntry({
          sessionKey: params.sessionKey!,
          agentId: params.agentId ?? "default",
          role: "event",
          text: `approval proposed: ${proposal.kind} ${proposal.id} (${proposal.summary})`,
          source: params.source,
          runId: params.runId,
          metadata: { event: "approval_proposed", approvalId: proposal.id, kind: proposal.kind, origin: params.origin },
        }),
      )
    : [];
  return { text: extracted.text, content, events, proposals };
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
