# Sensitive Context Routing and Declassification Bridge

**Status:** Design spike  
**Date:** 2026-06-28  
**Project:** MindStone-Agent  
**Scope:** Core/Gateway routing, prompt assembly, source policy, transcript metadata, and future agent-pack configuration

## 1. Problem statement

MindStone-Agent needs a way to handle sensitive inputs without assuming every inference can safely go to the default model route.

Sensitive context may include:

- files under specific paths;
- file globs or repositories;
- data types such as credentials, legal material, medical notes, incident evidence, customer data, or proprietary source;
- memory namespaces or journals;
- channel messages from sensitive rooms;
- tool outputs;
- transcript segments;
- user-provided attachments;
- organization-defined classifications.

The easy part is detecting and labeling sensitive sources.

The hard part is what happens after the sensitive route processes them.

A sensitive route may be local-only, but it does not have to be. An organization may have an approved trusted cloud route for sensitive work. The policy requirement is not simply “local versus cloud.” The requirement is:

```text
Raw sensitive material must only be sent to routes authorized for that sensitivity class.
Derived output must remain tainted until a declassification bridge produces an approved safe artifact for less-trusted routes.
```

This feature therefore has two halves:

1. **Sensitive context routing** — decide which route may see raw inputs.
2. **Declassification bridge** — decide what derived output may cross back to the default/main route.

## 2. Goals

- Allow users/orgs to designate paths, files, data types, memory namespaces, channels, transcript sources, and tool outputs as sensitive.
- Route turns or sub-tasks involving sensitive raw context to an authorized route/model.
- Support more than one sensitive route, including local models and org-approved cloud providers.
- Keep raw sensitive material out of unauthorized model prompts.
- Preserve transcript/source authority without leaking raw sensitive content into lower-trust routes.
- Allow the main route to continue useful work using sanitized artifacts, opaque handles, and policy-approved summaries.
- Track provenance and taint state of derived outputs.
- Make crossing a sensitivity boundary explicit, auditable, and testable.
- Integrate with existing MindStone-Agent routing, prompt-window, memory, and transcript design rather than bolt on a separate sidecar.

## 3. Non-goals for first implementation

- Perfect automatic data-loss prevention.
- Full enterprise policy language on day one.
- Automatic legal/compliance classification without user configuration.
- Cryptographic information-flow control.
- Redaction guarantees for arbitrary model-generated text without review.
- Rewriting all provider/routing code before the basic policy model is proven.

The MVP should make policy explicit and conservative. It should reject or escalate uncertain boundary crossings rather than silently guessing.

## 4. Core concept

The proposed flow:

```text
input sources
  ↓
sensitivity policy matcher
  ↓
source labels + taint graph
  ↓
route planner
  ├─ default route for non-sensitive context
  └─ authorized sensitive route for sensitive raw context
       ↓
    sensitive-route result
       ↓
    declassification bridge
       ↓
    sanitized artifact + opaque handles
       ↓
default/main route may continue using safe artifact only
```

The core invariant:

```text
The default route never receives raw context above its clearance.
```

A second invariant:

```text
Output derived from sensitive input remains sensitive until a bridge explicitly declassifies it.
```

## 5. Definitions

### Sensitivity label

A label that classifies a source or derived artifact.

Examples:

```text
public
internal
confidential
restricted
regulated
secret
customer-data
incident-evidence
credentials
local-only
org-cloud-ok
```

Labels should be configurable. MindStone should ship a small default vocabulary but not assume every organization’s taxonomy.

### Route clearance

A route/model/provider declares which labels it may receive.

Examples:

```text
default route:
  allowedLabels: [public, internal]

local-sensitive route:
  allowedLabels: [public, internal, confidential, restricted, credentials, local-only]

org-cloud-sensitive route:
  allowedLabels: [public, internal, confidential, regulated]
  deniedLabels: [credentials, local-only]
```

### Taint

If an output is derived from a sensitive source, it inherits that source’s sensitivity until declassified.

Example:

```text
source: /clients/acme/secrets.env → labels [credentials, local-only]
analysis: "The API key is missing a rotation date" → tainted [credentials, local-only]
sanitary artifact: "A credential rotation issue was found in source handle S-123" → declassified to [internal]
```

### Opaque handle

A stable reference to a sensitive source or sensitive result that lower-clearance routes can use without seeing raw content.

Example:

```text
sensitive://source/S-2026-06-28-00014
```

The main route may say:

```text
The sensitive route found a credential rotation issue in handle S-00014.
```

It may not dereference the handle unless it is itself routed through an authorized route.

### Declassification bridge

A policy-controlled process that transforms tainted sensitive output into a lower-sensitivity artifact.

It may be:

- rule-based redaction;
- model-assisted summarization on the sensitive route;
- schema-constrained extraction;
- human approval;
- a combination.

The bridge should produce structured output with an explicit decision:

```text
allow
allow_with_redactions
requires_human_review
deny
```

## 6. Policy surface

A future config shape could look like:

```json
{
  "sensitiveContext": {
    "enabled": true,
    "defaultLabel": "internal",
    "rules": [
      {
        "id": "credentials",
        "match": {
          "pathGlobs": ["**/.env", "**/*secret*", "**/*credential*"],
          "mimeTypes": ["application/x-env"]
        },
        "labels": ["credentials", "local-only"],
        "route": "local-sensitive"
      },
      {
        "id": "client-confidential",
        "match": {
          "pathGlobs": ["clients/**", "customer-data/**"]
        },
        "labels": ["confidential", "customer-data"],
        "route": "org-sensitive-cloud"
      },
      {
        "id": "incident-evidence",
        "match": {
          "pathGlobs": ["incidents/**", "forensics/**"]
        },
        "labels": ["incident-evidence", "restricted"],
        "route": "local-sensitive"
      }
    ],
    "routes": {
      "default": {
        "allowedLabels": ["public", "internal"]
      },
      "local-sensitive": {
        "routingMode": "pi-session",
        "model": "local/deepseek-or-qwen",
        "allowedLabels": ["public", "internal", "confidential", "restricted", "credentials", "local-only", "incident-evidence"],
        "declassification": {
          "mode": "schema_then_policy",
          "defaultDecision": "requires_human_review"
        }
      },
      "org-sensitive-cloud": {
        "routingMode": "pi-session",
        "model": "approved-cloud/vendor-model",
        "allowedLabels": ["public", "internal", "confidential", "customer-data", "regulated"],
        "deniedLabels": ["credentials", "local-only"],
        "declassification": {
          "mode": "schema_then_policy",
          "defaultDecision": "requires_human_review"
        }
      }
    }
  }
}
```

The exact schema should be refined, but these concepts are load-bearing:

- rules classify sources;
- routes declare clearance;
- labels travel with sources and derived artifacts;
- bridge decisions govern cross-route movement.

## 7. Source classification

Classification should happen before prompt assembly.

Potential source kinds:

```ts
type SensitiveSourceKind =
  | "file"
  | "directory"
  | "memory"
  | "journal"
  | "transcript"
  | "channel_message"
  | "tool_result"
  | "attachment"
  | "user_prompt"
  | "generated_artifact";
```

Signals for matching:

- path glob;
- exact path;
- repo/project root;
- file extension;
- MIME type;
- channel id;
- memory namespace;
- frontmatter tags;
- transcript metadata;
- source-provided labels;
- tool name;
- regex/content sniffing for known secret shapes;
- user-declared classification.

Important rule:

```text
Content sniffing can upgrade sensitivity. It should not usually downgrade sensitivity.
```

If a path rule says `clients/**` is confidential, a content classifier should not silently mark one file public unless policy explicitly allows downgrades.

## 8. Route planning

The route planner should inspect the planned prompt inputs before provider execution.

Current MindStone-Agent route flow:

```text
entries + identity + handoff + memory recall
→ buildPromptWindow(...)
→ messages
→ provider.completeChat(...)
```

Sensitive routing should eventually interpose between source selection and final messages:

```text
entries + identity + handoff + memory recall
→ classify sources
→ build candidate prompt window
→ evaluate route clearance
→ split or reroute as needed
→ execute sensitive route if raw sensitive context is required
→ bridge/declassify derived artifact
→ execute default route with safe artifact if needed
```

MVP decision:

- If the user prompt or required source context is above default-route clearance, route the whole turn to the sensitive route.
- Do not attempt multi-route decomposition until the single sensitive-route path works.
- If a lower-clearance final answer is requested, require bridge output rather than exposing raw sensitive route output.

Future decision:

- Allow subtask routing: sensitive route inspects raw sources and returns sanitized findings; default route uses sanitized findings for broader reasoning.

## 9. Declassification bridge

The bridge is the most important part of this design.

A sensitive route may produce a raw answer that still contains sensitive details. That raw answer must not automatically flow to the default route.

The bridge should transform:

```text
raw sensitive result + taint metadata + policy
```

into:

```text
sanitized artifact + crossing decision + provenance map
```

### 9.1 Bridge output schema

A first-pass schema:

```ts
type DeclassificationDecision =
  | "allow"
  | "allow_with_redactions"
  | "requires_human_review"
  | "deny";

type DeclassifiedArtifact = {
  id: string;
  decision: DeclassificationDecision;
  fromLabels: string[];
  toLabels: string[];
  summary?: string;
  facts?: Array<{
    text: string;
    confidence?: "low" | "medium" | "high";
    sourceHandles: string[];
  }>;
  redactions?: Array<{
    kind: "secret" | "pii" | "customer" | "path" | "quote" | "other";
    replacement: string;
    reason: string;
  }>;
  handles?: Array<{
    handle: string;
    labelSummary: string;
    allowedOperations: Array<"cite" | "request_sensitive_followup" | "human_review">;
  }>;
  blocked?: Array<{
    reason: string;
    sourceHandles?: string[];
  }>;
  audit: {
    bridgeRoute: string;
    policyVersion?: string;
    createdAt: string;
    rawArtifactHandle?: string;
  };
};
```

The default route should receive only the declassified artifact, not the raw sensitive result.

### 9.2 Bridge modes

Possible bridge modes:

1. **Deny all** — sensitive route can answer the user directly, but nothing crosses to default.
2. **Schema-only** — sensitive route must emit a constrained JSON artifact; raw prose is not passed along.
3. **Redaction** — bridge removes detected secrets/PII/forbidden spans.
4. **Summary only** — bridge emits high-level non-sensitive summary with source handles.
5. **Human review** — bridge drafts artifact but requires approval before crossing.
6. **Policy allowlist** — only specific fields/fact types may cross.

Recommended default for MVP:

```text
schema-only + requires_human_review for unknown/sensitive labels
```

### 9.3 Bridge prompts

The sensitive route can be asked to produce a bridge artifact using strict instructions:

```text
You may inspect raw sensitive context.
Your output must be a declassification artifact for a lower-clearance route.
Do not include secrets, credentials, PII, customer-identifying details, exact proprietary code, or raw quotes unless policy explicitly allows them.
Use opaque handles for sources.
If a fact cannot be safely stated, put it in blocked[].
When uncertain, set decision to requires_human_review.
```

The bridge output should still be validated by code. Model compliance is not enough.

## 10. Transcript and audit model

MindStone’s transcript is authoritative and append-only. Sensitive routing must not break that.

However, transcript entries must be label-aware.

Recommended transcript events:

```json
{
  "event": "sensitivity_classified",
  "sourceCount": 3,
  "labels": ["confidential", "customer-data"],
  "ruleIds": ["client-confidential"],
  "handles": ["sensitive://source/S-1", "sensitive://source/S-2"]
}
```

```json
{
  "event": "sensitive_route_selected",
  "routeId": "org-sensitive-cloud",
  "reason": "source_label_requires_route",
  "labels": ["confidential", "customer-data"],
  "defaultRouteAllowed": false
}
```

```json
{
  "event": "declassification_bridge_completed",
  "artifactId": "D-1",
  "decision": "allow_with_redactions",
  "fromLabels": ["confidential", "customer-data"],
  "toLabels": ["internal"],
  "handleCount": 2,
  "redactionCount": 4
}
```

The transcript should not store raw sensitive content in lower-clearance transcript entries.

Open design question:

```text
Should MindStone maintain per-label transcript partitions, or a single transcript with entry-level sensitivity labels and encrypted/opaque payloads?
```

Recommendation:

- Keep one logical transcript for continuity.
- Add entry-level sensitivity labels.
- Store raw payloads only in authorized local/private stores where needed.
- Store safe summaries/handles in general transcript entries.

This preserves continuity without pretending all transcript entries can be injected into every route.

## 11. Memory and recall implications

Memory recall must become sensitivity-aware.

Current memory strategy:

```text
standing context stays thin
per-turn auto-recall injects selected memory/transcript hits
```

Sensitive routing adds a rule:

```text
Auto Recall may not inject hits whose labels exceed the selected route clearance.
```

Recall can still return handles or safe summaries.

Possible behavior:

- If default route asks a question and top recall hit is sensitive, inject a safe pointer:
  ```text
  A related sensitive memory exists: sensitive://memory/M-123. Request sensitive-route follow-up to inspect.
  ```
- If sensitive route handles the turn, it may receive the raw memory hit.
- If sensitive memory contributes to a derived public/internal answer, the bridge must declassify the derived artifact first.

Memory files may need frontmatter:

```yaml
sensitivity: confidential
labels: [customer-data]
route: org-sensitive-cloud
```

or labels in a parallel metadata index rather than in public markdown frontmatter. The right choice depends on storage privacy.

Important distinction:

```text
Memory can be durable and sensitive.
Durable does not mean globally injectable.
```

## 12. Tool and file access implications

Sensitive routing interacts strongly with tools.

Examples:

- A file-read tool returns content from a sensitive path.
- A shell command prints environment variables.
- A code search crosses into `clients/**`.
- A database query returns customer data.
- A screenshot contains private data.

The tool result must carry sensitivity metadata.

Tool execution policy should support:

- pre-read classification by path;
- post-read upgrade by content scanning;
- route-bound tool availability;
- blocked tool calls when current route lacks clearance;
- automatic reroute/escalation prompt when a lower-clearance route requests sensitive content.

For MVP, a conservative rule is acceptable:

```text
If a tool result source path matches sensitive policy, do not pass its raw content to an unauthorized route. Return a blocked/sensitive handle instead.
```

## 13. User experience

The user should understand when routing changed because of sensitivity.

Examples:

```text
This request touches files under clients/acme/**, which are classified confidential.
Routing this turn to org-sensitive-cloud.
```

or:

```text
The default route cannot inspect .env files. I can send this to local-sensitive, or you can approve a one-time override.
```

The system should avoid noisy prompts when policy is clear, but it should surface meaningful boundary crossings.

Possible UX controls:

- `/sensitive status`
- `/sensitive explain <handle>`
- `/sensitive approve-crossing <artifact>`
- `/sensitive route <routeId>`
- TUI panel: active route, labels, blocked handles, pending bridge approvals
- doctor/status output: configured rules, route clearance, unsafe gaps

## 14. Route types

This design should not hard-code “sensitive means local.”

Route examples:

### Local-only route

For credentials, unreleased code, private journals, or data that cannot leave machine.

```text
routeId: local-sensitive
provider: ollama / local OpenAI-compatible / local Pi route
allowedLabels: [local-only, credentials, restricted]
```

### Org-trusted cloud route

For organizations with approved enterprise model contracts.

```text
routeId: org-sensitive-cloud
provider: enterprise cloud
allowedLabels: [confidential, regulated]
deniedLabels: [credentials, local-only]
```

### Human-review route

No model sees raw context until a human approves or manually summarizes.

```text
routeId: human-review
allowedLabels: [secret, legal-hold]
action: block_and_request_review
```

### Default route

Normal model route.

```text
routeId: default
allowedLabels: [public, internal]
```

## 15. Security boundaries

This feature should be described carefully.

It improves routing discipline, but it is not a formal proof that no sensitive information can leak.

Risks:

- model-generated summaries can accidentally include secrets;
- redaction can miss transformed sensitive data;
- code can infer sensitive facts from aggregate outputs;
- logs/transcripts can accidentally persist raw content;
- a trusted cloud route may still be inappropriate for some labels;
- a malicious prompt can ask the bridge to reveal raw values;
- tool outputs can contain unexpected sensitive content.

Safeguards:

- conservative default decisions;
- schema-constrained bridge outputs;
- code-level redaction checks;
- taint propagation;
- route clearance validation before every model call;
- audit events;
- human approval for uncertain crossings;
- no raw sensitive content in route diagnostics;
- tests with canary secrets.

Recommended public claim discipline:

```text
Sensitive Context Routing helps enforce configured model-routing boundaries and declassification workflows.
It is not a complete DLP system by itself.
```

## 16. Implementation phases

### Phase 0 — design and types

- Add `SensitiveContextPolicy` config types.
- Add source label/taint types.
- Add route clearance metadata.
- Add design docs and tests for pure policy decisions.

### Phase 1 — classification and route selection

- Classify file/tool/memory/transcript sources before prompt assembly.
- Prevent default route from receiving above-clearance raw content.
- Route the whole turn to a configured sensitive route when required.
- Record transcript events for classification and route selection.
- Add status/doctor visibility.

### Phase 2 — bridge MVP

- Sensitive route produces schema-constrained declassification artifact.
- Default route can receive only the artifact, not raw sensitive text.
- Add opaque handles.
- Add conservative redaction checks.
- Require human review for uncertain/unknown labels.

### Phase 3 — recall integration

- Label memory and transcript chunks.
- Filter Auto Recall by selected route clearance.
- Return safe handles/pointers for inaccessible recall hits.
- Ensure memory backfill/index preserves label metadata.

### Phase 4 — tool and channel integration

- Label tool results.
- Add channel-based labels.
- Add attachment labels.
- Add route-bound tool access.
- Add TUI/Gateway controls for approvals and explanations.

### Phase 5 — advanced policy

- Policy inheritance by workspace/agent/channel.
- Per-org taxonomy.
- Encrypted raw sensitive payload store.
- Bridge review queues.
- Canary tests for leakage.
- Multi-route decomposition within one user turn.

## 17. Candidate Core types

Rough sketch:

```ts
export type SensitivityLabel = string;

export type SensitiveSourceRef = {
  id: string;
  kind: "file" | "memory" | "journal" | "transcript" | "tool_result" | "channel_message" | "attachment" | "generated_artifact";
  path?: string;
  transcriptEntryId?: string;
  labels: SensitivityLabel[];
  ruleIds: string[];
  handle?: string;
};

export type RouteClearance = {
  routeId: string;
  allowedLabels: SensitivityLabel[];
  deniedLabels?: SensitivityLabel[];
  defaultDecision?: "allow" | "deny" | "review";
};

export type SensitivityDecision = {
  allowed: boolean;
  routeId?: string;
  reason: string;
  labels: SensitivityLabel[];
  blockedSources?: SensitiveSourceRef[];
};

export type TaintedArtifact = {
  id: string;
  text?: string;
  content?: unknown;
  labels: SensitivityLabel[];
  sourceHandles: string[];
  producedByRoute: string;
};
```

## 18. Integration point in existing route plan

Existing `MindStoneRouteInput` could eventually gain:

```ts
sensitiveContext?: {
  policy?: SensitiveContextPolicy;
  sourceClassifier?: SensitiveSourceClassifier;
  activeRouteId?: string;
};
```

Existing `MindStoneRoutePlan` could gain:

```ts
sensitivity?: {
  selectedRouteId: string;
  sources: SensitiveSourceRef[];
  labels: string[];
  defaultRouteAllowed: boolean;
  bridgeRequired: boolean;
};
```

For runner events, `route_planned` should include sanitized sensitivity summary only:

```text
labels, routeId, counts, ruleIds
```

not raw source content.

## 19. Open design questions

1. Should sensitivity labels live directly in memory file frontmatter, an external metadata DB, or both?
2. Should the transcript be physically partitioned by sensitivity or logically unified with labeled entries?
3. What is the minimum safe bridge schema for MVP?
4. When should human approval be mandatory versus policy-driven?
5. How should user prompts themselves be labeled when they contain sensitive content?
6. Should the default route be allowed to know that sensitive material exists, or only that a safe artifact exists?
7. How much aggregate information can safely cross without leaking details?
8. How should this interact with OpenAI/OpenResponses-compatible Gateway APIs where the caller expects one response stream?
9. Should a sensitive route answer the user directly, or always bridge back through the default route?
10. How should agent packs ship default sensitivity policies for SOC, medical, legal, coding, and personal companion use cases?

## 20. Recommended MVP stance

Start conservative:

- classify by path/glob/type first;
- route the whole turn to the sensitive route when sensitive raw context is required;
- do not pass sensitive-route raw output to the default route;
- produce schema-constrained bridge artifacts;
- require human approval for crossing from restricted/local-only/credentials labels;
- log sanitized audit events;
- filter Auto Recall by route clearance;
- expose clear status/doctor output.

Do not attempt fine-grained multi-route collaboration until single sensitive-route turns and bridge artifacts are reliable.

## 21. Short version

Sensitive Context Routing lets MindStone-Agent route raw sensitive material only to authorized models/routes.

The declassification bridge lets useful derived output cross back to the main route safely.

Core flow:

```text
classify sources
→ select authorized route
→ keep raw sensitive context on that route
→ taint derived output
→ bridge/declassify into structured safe artifact
→ let default route use only the artifact and opaque handles
```

The key idea:

```text
Sensitive routing decides who may see raw context.
The bridge decides what derived meaning may cross the boundary.
```

This should be implemented in MindStone-Agent Core/Gateway first because it owns routing, prompt assembly, transcript metadata, and provider selection. MS4PI/MS4CC can later adopt simpler policy guidance or adapter-level versions, but MindStone-Agent is the right home for the full architecture.
