import type { MindStoneSkillDefinition } from "./types.js";

export type IntegrationBuilderKind = "api" | "webhook" | "channel" | "tool" | "automation" | "unknown";

export type IntegrationBuilderBriefInput = {
  name?: string;
  kind?: IntegrationBuilderKind;
  goal?: string;
  auth?: string;
  surface?: string;
  constraints?: string[];
};

export type IntegrationBuilderBrief = {
  skill: MindStoneSkillDefinition;
  title: string;
  kind: IntegrationBuilderKind;
  markdown: string;
  phases: string[];
  immediateQuestions: string[];
  safetyGates: string[];
};

export const INTEGRATION_BUILDER_SKILL: MindStoneSkillDefinition = {
  id: "integration-builder",
  label: "Integration Builder",
  description: "Builds integration briefs and implementation checklists for APIs, webhooks, channel adapters, tools, automations, and agent bridges.",
  whenToUse: [
    "creating a new API/client integration",
    "designing a webhook or event-ingest surface",
    "planning a channel adapter or messaging bridge",
    "adding a tool surface that touches external systems",
    "turning an automation idea into a safe implementation plan",
  ],
  outputs: [
    "interface map",
    "credential and safety plan",
    "event/transcript/session mapping",
    "implementation phases",
    "validation checklist",
    "open questions before coding",
  ],
  safetyNotes: [
    "do not expose endpoints without auth, pairing, or allowlist controls",
    "do not store raw credentials in transcripts, logs, or memory",
    "prefer small verifiable probes before long-running listeners",
    "preserve append-only transcript authority for MindStone conversations",
  ],
};

function line(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function normalizeKind(kind: IntegrationBuilderKind | undefined): IntegrationBuilderKind {
  return kind ?? "unknown";
}

function bulletList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function numberedList(values: string[]): string {
  return values.map((value, index) => `${index + 1}. ${value}`).join("\n");
}

function defaultQuestions(kind: IntegrationBuilderKind): string[] {
  const common = [
    "What is the minimum useful end-to-end probe?",
    "What credentials, tokens, scopes, or pairing steps are required?",
    "What data is sensitive and must be redacted from logs/transcripts?",
    "What failure modes should be visible in status/doctor output?",
  ];
  if (kind === "channel") {
    return [
      "Which inbound message types are in scope: DM, group, channel, thread, mentions, reactions, media?",
      "How should sender identity, account IDs, and allowlists map into transcript source metadata?",
      "What outbound delivery guarantees are required: best-effort, queue, retry, or explicit ack?",
      ...common,
    ];
  }
  if (kind === "webhook") {
    return [
      "How are webhook signatures verified and replay attacks prevented?",
      "Which event schemas are accepted, versioned, and rejected?",
      "What is the dead-letter or quarantine behavior for malformed events?",
      ...common,
    ];
  }
  if (kind === "api") {
    return [
      "Which endpoints are required for the first useful path?",
      "What rate limits, pagination, idempotency, and retry semantics matter?",
      "How should API errors map into user-visible diagnostics?",
      ...common,
    ];
  }
  if (kind === "tool") {
    return [
      "What exact tool inputs are allowed, and what should be rejected?",
      "What tool outputs are safe to persist versus display transiently?",
      "Does the tool mutate external state, and what approval gate is required?",
      ...common,
    ];
  }
  return common;
}

function defaultSafetyGates(kind: IntegrationBuilderKind): string[] {
  const gates = [
    "Credential handling is explicit; secrets come from env/keychain/token files, not prompt text.",
    "Logs, transcripts, diagnostics, and memory store summaries or redacted values only.",
    "Destructive or externally mutating operations require a named approval boundary.",
    "Status/doctor output can report configured/running/error state without leaking secrets.",
  ];
  if (kind === "channel") {
    gates.push("Channel access policy is explicit: account IDs, sender allowlists, group/channel allowlists, and thread behavior are visible.");
    gates.push("Transcript source metadata preserves substrate/channel/chatType/sender without splitting canonical session continuity by accident.");
  }
  if (kind === "webhook") {
    gates.push("Webhook endpoints fail closed when signatures, timestamps, schema versions, or allowlists are invalid.");
  }
  if (kind === "tool") {
    gates.push("Tool schemas reject unknown or overbroad inputs and summarize large/raw results before persistence.");
  }
  return gates;
}

function defaultPhases(kind: IntegrationBuilderKind): string[] {
  const noun = kind === "unknown" ? "integration" : kind;
  return [
    `Define the ${noun} contract: inputs, outputs, events, identity mapping, errors, and ownership boundaries.`,
    "Add configuration shape and safe status reporting before long-running behavior.",
    "Build the smallest deterministic smoke path with fake/local credentials or mock events.",
    "Add the real adapter/client/listener behind explicit auth and least-privilege config.",
    "Persist only safe transcript/source metadata and sanitized diagnostics.",
    "Document setup, verification commands, operational risks, and rollback/disable steps.",
  ];
}

export function buildIntegrationBuilderBrief(input: IntegrationBuilderBriefInput = {}): IntegrationBuilderBrief {
  const kind = normalizeKind(input.kind);
  const name = line(input.name, "Unnamed integration");
  const goal = line(input.goal, "Define the first safe, testable integration path before implementation.");
  const auth = line(input.auth, "unset; identify least-privilege auth before live use");
  const surface = line(input.surface, kind === "channel" ? "Gateway-owned channel plugin" : "MindStone Core/Gateway adapter surface");
  const constraints = input.constraints?.map((item) => item.trim()).filter(Boolean) ?? [];
  const immediateQuestions = defaultQuestions(kind);
  const safetyGates = defaultSafetyGates(kind);
  const phases = defaultPhases(kind);
  const title = `Integration Builder brief: ${name}`;

  const markdown = `# ${title}

## Objective

${goal}

## Integration shape

- Name: ${name}
- Kind: ${kind}
- Runtime surface: ${surface}
- Auth/pairing: ${auth}
${constraints.length ? `- Constraints:\n${constraints.map((item) => `  - ${item}`).join("\n")}` : "- Constraints: none captured yet"}

## Interface map to define

- Inbound inputs/events/messages and their schemas.
- Outbound actions/responses and delivery semantics.
- Identity mapping: user/account/channel/thread/source metadata.
- Error taxonomy: user-visible, retryable, security failure, malformed input, provider outage.
- Persistence policy: what enters transcript, status, diagnostics, memory, and logs.

## Safety gates

${bulletList(safetyGates)}

## Implementation phases

${numberedList(phases)}

## Immediate questions

${bulletList(immediateQuestions)}

## Validation checklist

- Config parses and unknown/sensitive fields are preserved or rejected intentionally.
- Status/doctor can report configured/running/error state without network dependency where possible.
- First smoke uses mock/local fixtures before live credentials.
- Live probe is gated by an explicit environment flag or operator action.
- Transcript entries preserve canonical session continuity and sanitized source metadata.
- Disable/rollback path is documented.
`;

  return { skill: INTEGRATION_BUILDER_SKILL, title, kind, markdown, phases, immediateQuestions, safetyGates };
}

export function formatIntegrationBuilderSkillMarkdown(): string {
  return `---
name: integration-builder
description: Builds safe integration briefs and implementation checklists for APIs, webhooks, channel adapters, tools, automations, and agent bridges. Use when creating/configuring integrations, channels, external tools, or webhook/API surfaces.
---

# Integration Builder

Use this skill when designing or implementing an integration, channel adapter, tool surface, webhook, API client, automation, or agent bridge.

## Operating rules

${bulletList(INTEGRATION_BUILDER_SKILL.safetyNotes)}

## Workflow

1. Identify the integration kind: API, webhook, channel, tool, automation, or bridge.
2. Define the smallest useful end-to-end path before building broad behavior.
3. Map interfaces: inputs, outputs, events, identities, source metadata, errors, and persistence.
4. Define credentials and approval boundaries before touching live systems.
5. Build config/status/doctor visibility before long-running listeners.
6. Add deterministic smoke tests with mock/local fixtures.
7. Gate live probes behind explicit operator action or environment flags.
8. Persist only sanitized transcript/source metadata and diagnostics.

## Required output shape

When invoked, produce:

- objective
- integration shape
- interface map
- credential/auth plan
- safety gates
- implementation phases
- validation checklist
- open questions

## MindStone-specific constraints

- Gateway owns long-running channel listeners.
- Pi adapter may expose diagnostic/setup commands, but should not imply a channel is implemented.
- Transcript JSONL continuity is authoritative and append-only.
- Prompt pruning and compaction must not rewrite transcript history.
- Channel/session source metadata should preserve continuity without leaking secrets.
`;
}
