export type GatewayRunStatus = "running" | "completed" | "aborted" | "failed";

export type GatewayRun = {
  id: string;
  sessionKey: string;
  agentId: string;
  status: GatewayRunStatus;
  startedAt: string;
  updatedAt: string;
  abortController: AbortController;
  metadata?: Record<string, unknown>;
};

export type StartGatewayRunInput = {
  id?: string;
  sessionKey: string;
  agentId: string;
  metadata?: Record<string, unknown>;
};

export type AbortGatewayRunResult =
  | { aborted: true; run: GatewayRun }
  | { aborted: false; reason: "not_found" | "already_finished"; run?: GatewayRun };

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class GatewayRunManager {
  readonly #runs = new Map<string, GatewayRun>();

  start(input: StartGatewayRunInput): GatewayRun {
    const now = new Date().toISOString();
    const run: GatewayRun = {
      id: input.id ?? createRunId(),
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      status: "running",
      startedAt: now,
      updatedAt: now,
      abortController: new AbortController(),
      metadata: input.metadata,
    };
    this.#runs.set(run.id, run);
    return run;
  }

  get(runId: string): GatewayRun | undefined {
    return this.#runs.get(runId);
  }

  listActive(sessionKey?: string): GatewayRun[] {
    return [...this.#runs.values()].filter((run) => run.status === "running" && (!sessionKey || run.sessionKey === sessionKey));
  }

  complete(runId: string): GatewayRun | undefined {
    return this.#finish(runId, "completed");
  }

  fail(runId: string): GatewayRun | undefined {
    return this.#finish(runId, "failed");
  }

  abort(runId: string): AbortGatewayRunResult {
    const run = this.#runs.get(runId);
    if (!run) return { aborted: false, reason: "not_found" };
    if (run.status !== "running") return { aborted: false, reason: "already_finished", run };
    run.abortController.abort();
    run.status = "aborted";
    run.updatedAt = new Date().toISOString();
    return { aborted: true, run };
  }

  abortSession(sessionKey: string): AbortGatewayRunResult[] {
    const activeRuns = this.listActive(sessionKey);
    if (activeRuns.length === 0) return [{ aborted: false, reason: "not_found" }];
    return activeRuns.map((run) => this.abort(run.id));
  }

  #finish(runId: string, status: Exclude<GatewayRunStatus, "running">): GatewayRun | undefined {
    const run = this.#runs.get(runId);
    if (!run) return undefined;
    run.status = status;
    run.updatedAt = new Date().toISOString();
    return run;
  }
}
