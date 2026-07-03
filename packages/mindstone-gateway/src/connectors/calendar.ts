import {
  connectorCredentialRefFromChannelConfig,
  registerConnector,
  resolveConnectorCredential,
  type ConnectorContext,
  type ConnectorInboundHandle,
  type ConnectorOutboundMessage,
  type ConnectorMutationPayload,
  type ConnectorSetupAdapter,
  type MindStoneConnector,
  type MindStoneConfig,
} from "@mindstone-agent/core";

/**
 * Calendar connector MVP (issue #22), Google Calendar first behind a
 * provider-agnostic seam (M365 Calendar / Todoist / Linear / Jira / GitHub
 * Issues / Notion are the documented follow-on lane — see
 * docs/operations/CALENDAR_CONNECTOR.md).
 *
 * INTERACTION MODEL — different from every chat connector: a calendar has no
 * inbound messages and no replies. The connector is PULL + MUTATE:
 *   - pull: `mindstone calendar upcoming` reads the agenda (read-only);
 *   - mutate: the model proposes event mutations via fenced
 *     mindstone-calendar-proposal blocks → pending connector_mutation
 *     ProposedActions → an explicit `approvals approve` enqueues the mutation
 *     onto this connector's delivery queue → sendOutbound APPLIES it.
 * Mutations are ALWAYS approval-gated: there is no auto path at all, so
 * sendOutbound refuses anything that is not an approved-mutation payload.
 *
 * startInbound is a no-op listener (nothing to listen to; scheduled digests
 * are #29 scheduler territory). Credentials are the same three-REF Google
 * OAuth shape as the email connector; `apiBaseUrl`/`tokenUrl` are swappable so
 * smokes drive the exact live path against a local stub.
 */

const DEFAULT_API_BASE = "https://www.googleapis.com";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_UPCOMING_DAYS = 7;

// ---------------------------------------------------------------------------
// Google Calendar payload types (the subset the connector touches)
// ---------------------------------------------------------------------------

export type GoogleCalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit smokes)
// ---------------------------------------------------------------------------

function eventStartLabel(event: GoogleCalendarEvent): string {
  return event.start?.dateTime ?? event.start?.date ?? "unscheduled";
}

/** Deterministic agenda text for the pull surface and summarize prompts. */
export function formatUpcomingEvents(events: GoogleCalendarEvent[], options: { days: number } = { days: DEFAULT_UPCOMING_DAYS }): string {
  if (!events.length) return `No upcoming events in the next ${options.days} day(s).`;
  const lines = events.map((event) => {
    const attendees = event.attendees?.length ? ` (${event.attendees.length} attendee(s))` : "";
    const where = event.location ? ` @ ${event.location}` : "";
    return `- ${eventStartLabel(event)} — ${event.summary ?? "(no title)"}${where}${attendees}`;
  });
  return [`Upcoming events (next ${options.days} day(s)):`, ...lines].join("\n");
}

export type ValidatedCalendarMutation =
  | { operation: "create"; body: Record<string, unknown> }
  | { operation: "update"; eventId: string; body: Record<string, unknown> };

/**
 * Validate an approved mutation payload before it touches the API. Fails
 * closed: only create/update on resource "event", create requires
 * summary+start+end, update requires an eventId. The record keeps whatever
 * the model proposed; THIS is the apply-time constraint.
 */
export function validateCalendarMutation(mutation: ConnectorMutationPayload): ValidatedCalendarMutation {
  if (mutation.resource !== "event") {
    throw new Error(`calendar mutation resource "${mutation.resource}" is not supported (MVP applies events only)`);
  }
  const data = mutation.data ?? {};
  if (mutation.operation === "create") {
    const summary = typeof data.summary === "string" ? data.summary.trim() : "";
    const start = data.start && typeof data.start === "object" ? data.start : undefined;
    const end = data.end && typeof data.end === "object" ? data.end : undefined;
    if (!summary || !start || !end) {
      throw new Error("calendar create requires data.summary, data.start, and data.end");
    }
    return { operation: "create", body: data };
  }
  if (mutation.operation === "update") {
    const eventId = typeof data.eventId === "string" ? data.eventId.trim() : "";
    if (!eventId) throw new Error("calendar update requires data.eventId");
    const { eventId: _omit, ...body } = data;
    return { operation: "update", eventId, body };
  }
  throw new Error(`calendar mutation operation "${(mutation as { operation?: string }).operation}" is not supported`);
}

// ---------------------------------------------------------------------------
// CalendarProvider seam + Google implementation
// ---------------------------------------------------------------------------

export type CalendarProvider = {
  profile(): Promise<{ calendarId: string }>;
  upcoming(params: { days: number }): Promise<GoogleCalendarEvent[]>;
  createEvent(body: Record<string, unknown>): Promise<{ id?: string }>;
  updateEvent(eventId: string, body: Record<string, unknown>): Promise<{ id?: string }>;
};

type GoogleCalendarProviderConfig = {
  apiBaseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
  /** Injected clock for deterministic smoke windows; defaults to now. */
  now?: () => Date;
};

export class GoogleCalendarProvider implements CalendarProvider {
  readonly #config: GoogleCalendarProviderConfig;
  #accessToken: string | undefined;
  #accessTokenExpiresAt = 0;

  constructor(config: GoogleCalendarProviderConfig) {
    this.#config = config;
  }

  async #token(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt - 30_000) return this.#accessToken;
    const response = await fetch(this.#config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        refresh_token: this.#config.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const payload = (await response.json().catch(() => undefined)) as { access_token?: string; expires_in?: number; error?: string } | undefined;
    if (!response.ok || !payload?.access_token) {
      throw new Error(`Calendar token exchange failed: HTTP ${response.status}${payload?.error ? ` — ${payload.error}` : ""}`);
    }
    this.#accessToken = payload.access_token;
    this.#accessTokenExpiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
    return this.#accessToken;
  }

  async #call<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
    const token = await this.#token();
    const run = async (bearer: string) =>
      fetch(`${this.#config.apiBaseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${bearer}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        body: init.body,
      });
    let response = await run(token);
    if (response.status === 401) {
      this.#accessToken = undefined;
      response = await run(await this.#token());
    }
    const payload = (await response.json().catch(() => undefined)) as T | { error?: { message?: string } } | undefined;
    if (!response.ok) {
      const detail = (payload as { error?: { message?: string } } | undefined)?.error?.message;
      throw new Error(`Calendar ${init.method ?? "GET"} ${path} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }
    return payload as T;
  }

  #calendarPath(suffix = ""): string {
    return `/calendar/v3/calendars/${encodeURIComponent(this.#config.calendarId)}/events${suffix}`;
  }

  async profile(): Promise<{ calendarId: string }> {
    // Cheapest credential validation: a 1-result events probe.
    await this.#call(`${this.#calendarPath()}?maxResults=1`);
    return { calendarId: this.#config.calendarId };
  }

  async upcoming(params: { days: number }): Promise<GoogleCalendarEvent[]> {
    const now = this.#config.now?.() ?? new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + params.days * 24 * 60 * 60 * 1000).toISOString();
    const query = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    const result = await this.#call<{ items?: GoogleCalendarEvent[] }>(`${this.#calendarPath()}?${query.toString()}`);
    return result.items ?? [];
  }

  async createEvent(body: Record<string, unknown>): Promise<{ id?: string }> {
    return this.#call<{ id?: string }>(this.#calendarPath(), { method: "POST", body: JSON.stringify(body) });
  }

  async updateEvent(eventId: string, body: Record<string, unknown>): Promise<{ id?: string }> {
    return this.#call<{ id?: string }>(this.#calendarPath(`/${encodeURIComponent(eventId)}`), { method: "PATCH", body: JSON.stringify(body) });
  }
}

// ---------------------------------------------------------------------------
// Connector wiring
// ---------------------------------------------------------------------------

function resolveExtraCredential(ctx: ConnectorContext, envKey: string, fileKey: string, label: string): string {
  const ref = connectorCredentialRefFromChannelConfig({
    tokenEnv: ctx.channelConfig[envKey],
    tokenFile: ctx.channelConfig[fileKey],
  });
  const resolved = ref ? resolveConnectorCredential(ref) : undefined;
  if (!resolved?.present) {
    throw new Error(`calendar ${label} unresolved (${envKey}/${fileKey})${resolved && !resolved.present ? `: ${resolved.error}` : ""}`);
  }
  return resolved.value;
}

export function calendarProviderFromContext(ctx: ConnectorContext): GoogleCalendarProvider {
  if (!ctx.credential) throw new Error("calendar refresh token is not resolved (configure tokenEnv or tokenFile)");
  const apiBaseUrl = (typeof ctx.channelConfig.apiBaseUrl === "string" && ctx.channelConfig.apiBaseUrl.trim() ? ctx.channelConfig.apiBaseUrl.trim() : DEFAULT_API_BASE).replace(/\/+$/, "");
  const tokenUrl = typeof ctx.channelConfig.tokenUrl === "string" && ctx.channelConfig.tokenUrl.trim() ? ctx.channelConfig.tokenUrl.trim() : DEFAULT_TOKEN_URL;
  const calendarId = typeof ctx.channelConfig.calendarId === "string" && ctx.channelConfig.calendarId.trim() ? ctx.channelConfig.calendarId.trim() : "primary";
  return new GoogleCalendarProvider({
    apiBaseUrl,
    tokenUrl,
    calendarId,
    clientId: resolveExtraCredential(ctx, "clientIdEnv", "clientIdFile", "OAuth client id"),
    clientSecret: resolveExtraCredential(ctx, "clientSecretEnv", "clientSecretFile", "OAuth client secret"),
    refreshToken: ctx.credential,
  });
}

/** Extract the approved mutation payload from a queued outbound message. */
export function mutationFromOutbound(message: ConnectorOutboundMessage): ConnectorMutationPayload | undefined {
  const raw = message.metadata?.mutation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const mutation = raw as ConnectorMutationPayload;
  if (mutation.operation !== "create" && mutation.operation !== "update") return undefined;
  if (typeof mutation.resource !== "string" || !mutation.data || typeof mutation.data !== "object") return undefined;
  return mutation;
}

const CALENDAR_SETUP: ConnectorSetupAdapter = {
  async configure({ config, prompter }) {
    const refreshRef = await prompter.text({
      message: "Environment variable holding the Google OAuth REFRESH token (refs only — the token itself never enters config)",
      placeholder: "MINDSTONE_GCAL_REFRESH_TOKEN",
    });
    const clientIdRef = await prompter.text({
      message: "Environment variable holding the OAuth client id",
      placeholder: "MINDSTONE_GCAL_CLIENT_ID",
    });
    const clientSecretRef = await prompter.text({
      message: "Environment variable holding the OAuth client secret",
      placeholder: "MINDSTONE_GCAL_CLIENT_SECRET",
    });
    const calendarId = await prompter.text({
      message: "Calendar id (default: primary)",
      placeholder: "primary",
    });
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    channels.calendar = {
      enabled: true,
      tokenEnv: String(refreshRef).trim(),
      clientIdEnv: String(clientIdRef).trim(),
      clientSecretEnv: String(clientSecretRef).trim(),
      ...(String(calendarId ?? "").trim() && String(calendarId).trim() !== "primary" ? { calendarId: String(calendarId).trim() } : {}),
      // No sendPolicy knob matters here: calendar has no reply path at all —
      // mutations are ALWAYS approval-gated (connector_mutation kind).
    };
    return { config: { ...config, channels } as MindStoneConfig };
  },
  disable(config) {
    const channels = { ...(config.channels ?? {}) } as Record<string, unknown>;
    const section = channels.calendar;
    channels.calendar = { ...(typeof section === "object" && section !== null ? section : {}), enabled: false };
    return { ...config, channels } as MindStoneConfig;
  },
};

export const CALENDAR_CONNECTOR: MindStoneConnector = {
  id: "calendar",
  meta: {
    id: "calendar",
    label: "Calendar (Google)",
    blurb: "Gateway-owned Google Calendar connector: agenda pull + approval-gated event mutations on the shared connector framework.",
  },
  capabilities: { chatTypes: ["direct"] },
  setup: CALENDAR_SETUP,

  async startInbound(ctx): Promise<ConnectorInboundHandle> {
    // Validate credentials up front (visible startup failure), then idle:
    // a calendar has nothing to listen to. Scheduled digests belong to the
    // #29 scheduler; the pull surface is `mindstone calendar upcoming`.
    const provider = calendarProviderFromContext(ctx);
    await provider.profile();
    return { stop: () => undefined };
  },

  async sendOutbound(ctx, message: ConnectorOutboundMessage): Promise<void> {
    // The ONLY thing this connector delivers is an approved mutation. Plain
    // replies are refused loudly — there is no chat surface to reply to, and
    // refusing keeps "mutations are always approval-gated" structural.
    const mutation = mutationFromOutbound(message);
    if (!mutation) {
      throw new Error("calendar outbound only applies approved connector_mutation payloads (no reply path exists)");
    }
    const validated = validateCalendarMutation(mutation);
    const provider = calendarProviderFromContext(ctx);
    if (validated.operation === "create") {
      await provider.createEvent(validated.body);
      return;
    }
    await provider.updateEvent(validated.eventId, validated.body);
  },

  async probe(ctx) {
    try {
      const provider = calendarProviderFromContext(ctx);
      const profile = await provider.profile();
      return { ok: true, detail: `calendar ${profile.calendarId}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};

registerConnector(CALENDAR_CONNECTOR);
