import type { MindStoneRoutePersonaContext } from "../persona/types.js";
import type { MindStoneWorkflowOutcome } from "../workflow/types.js";

/**
 * App Engine Mode + Agent Mesh scope model (issue #14, design:
 * docs/refactor/APP_ENGINE_RUNTIME_MODES.md).
 *
 * Every dimension is optional except agentId. Scope metadata rides transcripts
 * and memory documents so recall can refuse cross-tenant/cross-agent hits.
 */
export type MindStoneRunScope = {
  appId?: string;
  tenantId?: string;
  userId?: string;
  agentId: string;
};

/** Which scope level a run's memory recall is confined to. "none" disables recall for the run. */
export type MindStoneMemoryScope = "app" | "tenant" | "user" | "agent" | "none";

export type MindStoneRunRequest = {
  appId?: string;
  tenantId?: string;
  userId?: string;
  agentId: string;
  /** Explicit session key. When omitted, a canonical scoped key is derived (companion-compatible). */
  sessionKey?: string;
  /** Deterministically force a persona for this run (wins over workflow decisions and config rules). */
  personaId?: string;
  /** Deterministically force a workflow for this run (bypasses workflow selection). */
  workflowId?: string;
  input: string;
  /** Defaults to "agent" — the narrowest scope. */
  memoryScope?: MindStoneMemoryScope;
  metadata?: Record<string, unknown>;
};

export type MindStoneRunResult = {
  runId: string;
  sessionKey: string;
  scope: MindStoneRunScope;
  memoryScope: MindStoneMemoryScope;
  response: {
    text: string;
    model?: string;
    provider?: string;
  };
  personaContext?: Pick<MindStoneRoutePersonaContext, "personaId" | "reason">;
  workflow?: Pick<MindStoneWorkflowOutcome, "workflowId" | "reason" | "failed" | "decision">;
  memoryRecall?: {
    query: string;
    hitCount: number;
    promptTokens: number;
    hits: Array<{ id: string; title?: string; score: number }>;
    rejectedCount?: number;
  };
  diagnostics?: Record<string, unknown>;
};

const SCOPE_DIMENSIONS = ["appId", "tenantId", "userId", "agentId"] as const;

export function scopeFromRequest(request: Pick<MindStoneRunRequest, "appId" | "tenantId" | "userId" | "agentId">): MindStoneRunScope {
  return {
    ...(request.appId ? { appId: request.appId } : {}),
    ...(request.tenantId ? { tenantId: request.tenantId } : {}),
    ...(request.userId ? { userId: request.userId } : {}),
    agentId: request.agentId,
  };
}

/**
 * Canonical scoped session key. Omitted dimensions collapse, so an unscoped
 * request degrades exactly to the companion-mode shape `agent:<agentId>:main`.
 */
export function scopedSessionKey(scope: MindStoneRunScope, suffix = "main"): string {
  const parts: string[] = [];
  if (scope.appId) parts.push(`app:${scope.appId}`);
  if (scope.tenantId) parts.push(`tenant:${scope.tenantId}`);
  if (scope.userId) parts.push(`user:${scope.userId}`);
  parts.push(`agent:${scope.agentId}`);
  parts.push(suffix);
  return parts.join(":");
}

/**
 * The scope filter recall enforces for a given memoryScope level: which
 * dimensions of the request scope participate in matching.
 */
export function recallScopeForMemoryScope(scope: MindStoneRunScope, memoryScope: MindStoneMemoryScope): MindStoneRunScope | undefined {
  if (memoryScope === "none") return undefined;
  if (memoryScope === "app") return { ...(scope.appId ? { appId: scope.appId } : {}) } as MindStoneRunScope;
  if (memoryScope === "tenant") {
    return { ...(scope.appId ? { appId: scope.appId } : {}), ...(scope.tenantId ? { tenantId: scope.tenantId } : {}) } as MindStoneRunScope;
  }
  if (memoryScope === "user") {
    return {
      ...(scope.appId ? { appId: scope.appId } : {}),
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
      ...(scope.userId ? { userId: scope.userId } : {}),
    } as MindStoneRunScope;
  }
  return scope;
}

/**
 * Scope matching rule (document-subset-of-filter):
 * - documents with NO scope metadata are global (companion-mode compatible) and always eligible;
 * - every dimension the DOCUMENT defines must be present in the recall filter
 *   with the same value. Dimensions the document leaves undefined are broader
 *   scope and impose no constraint.
 *
 * Consequences: a tenant-A document never surfaces in tenant-B's recall; an
 * agent-private document never surfaces in another agent's run, in a broader
 * memoryScope (user/tenant/app) run, or in an unscoped companion run — while
 * agent-level documents remain visible to that agent's user-specific requests.
 */
export function scopeMatchesRecallFilter(documentScope: Record<string, unknown> | undefined, filter: MindStoneRunScope | Record<string, string> | undefined): boolean {
  if (!documentScope) return true;
  const filterRecord = (filter ?? {}) as Record<string, unknown>;
  for (const dim of SCOPE_DIMENSIONS) {
    const docValue = typeof documentScope[dim] === "string" && documentScope[dim] ? documentScope[dim] : undefined;
    if (!docValue) continue;
    const filterValue = typeof filterRecord[dim] === "string" && filterRecord[dim] ? filterRecord[dim] : undefined;
    if (filterValue !== docValue) return false;
  }
  return true;
}
