# Assistant surfaces: what MindStone-Agent takes from Grok Bot

**Status:** Design draft, 2026-09-23. Proposals for discussion; nothing here is scheduled.
**Part of:** the MindStone Console design (`CONSOLE_DESIGN.md`, #15, #38). Most of what follows is harness work in the gateway and core; the Console is where a person sees and controls it.
**Touches:** #29 (scheduler), #41 (clean-room review session), #24 (approvals), #28 (pack registry), #39 (Synapse).
**Owner:** Product direction by Clint, 2026-09-23. Research and engineering design by Cairn.

## 1. Why this document exists

xAI released Grok Bot in beta on 2026-08-11 and added enterprise controls on 2026-09-03. It is an always-on team of agents that message each other, set up their own routines and skills, and work on a cloud computer. Several of those features are things a MindStone-Agent user will expect. This document records what Grok Bot does (from its own documentation, read 2026-09-23), which parts MindStone-Agent should adopt, how each would surface in the Console, and which parts it should not copy.

The short version: Grok Bot is strongest at the action and setup layer and simplest at the memory layer. MindStone-Agent is the reverse. The two serve different buyers. Grok Bot is a hosted product for individuals and teams; MindStone-Agent is a self-hosted harness for organizations that need their own models, their own infrastructure, large knowledge bases, and an agent that accumulates judgment over time. The features worth adopting are the ones that make an assistant useful day to day, built on top of LCA instead of around it.

## 2. What Grok Bot is

Every point below is from xAI's or Cursor's own pages unless marked otherwise. Sources are in section 9.

**Platform.** Grok Bot runs on Cursor's infrastructure and signs in with a Cursor account; plugin, MCP, and privacy settings follow Cursor's. It runs only on Cursor-hosted computers: "On-premises deployment, deployment inside your own perimeter, and bring-your-own-image" are not supported. Computers run in the United States. The model is chosen by Cursor and "can change"; an enterprise model allowlist exists but enforcement is described as not guaranteed.

**Agents and agent-to-agent communication.** Up to about 50 Bots per account. A Bot can send another Bot an asynchronous direct message; the receiver wakes, works, and replies later, and the handoff is visible in the conversation. Group chats hold 2 to 6 Bots plus the user; the user can let the Bots decide who answers or address one with `@Bot` or `@everyone`. A Bot can suggest or create a new, focused Bot. Bots can also launch Cursor cloud coding agents.

**Self-configuration.** "Setup is a message, not a workflow builder." A Bot creates its own routines, skills, and settings changes, and each change appears as an event in the transcript. An independent review model, **Auto Review**, checks shell commands, plugin calls, computer use, changes to routines and triggers, and agent launches, and can allow, ask, or deny. It does not review memory writes or most settings changes. Connectors are the exception to self-setup: a person adds them in the marketplace and completes the sign-in.

**Routines.** Schedules and event triggers (Slack, GitHub, Linear, webhooks); up to 50 routines per Bot; the last 20 runs kept.

**The computer.** One persistent cloud computer per user (a Firecracker microVM with a desktop, browser, terminal, and files), shared by all of that user's Bots. Each Bot has its own screen, but logins, cookies, files, and command-line credentials are shared, and the documentation says plainly: "Do not use separate Bots as a security boundary." For passwords, 2FA, CAPTCHAs, and payments the user takes over the screen. A masked secret-request form keeps a secret out of the transcript and away from the model. Connector OAuth tokens stay on Cursor's backend.

**Memory.** A Bot "can retain stable working preferences, important facts, and summaries from its work." Memory is per Bot, held as plain files on the computer (a profile file and monthly log files, per staff answers on Cursor's forum), with a shared layer that staff mention but the documentation does not describe. There is no memory viewer. Retrieval, ranking, retention, and what triggers an automatic write are not documented. The conversation is re-read on every turn and summarized only near the context limit; Cursor staff recommend starting a fresh chat when a conversation grows, and described bots waking other bots as a large share of token use for one customer.

**Knowledge.** Attachments only, six at a time, 25 MB each for documents. No knowledge base or bulk ingestion is documented.

**Enterprise.** SAML SSO through Cursor, SCIM on Enterprise, admin controls, network allowlists, audit logs to a SIEM, 90-day action recording, ISO/IEC 27001 and 42001 for the operating company. Pricing through Cursor and xAI plans with a weekly usage allowance.

## 3. What to adopt, in priority order

Each item says what it is, where the work lives, and what the Console shows. Items 1 to 4 are harness work first; the Console panels depend on them.

### 3.1 Routines: schedules and event triggers

**Why first.** An assistant that only answers when spoken to is a chat window. Scheduled and triggered work is the baseline for personal-assistant use, and MindStone-Agent has none today.

**Harness.** Build the scheduler designed in `SCHEDULER_DESIGN.md` (#29), extended with event triggers: connector events (a message in a watched channel, an email matching a rule), inbound webhooks on the gateway, and file or knowledge base changes. A routine is owned by an agent, runs under that agent's persona, and writes its run into the transcript like any other turn, so recall and audit see it.

**Console.** A Routines panel: list per agent, next run, trigger, enabled switch, last runs with outcome and a link into the transcript. Creating or editing a routine from chat shows up here as a pending change until approved (3.4).

### 3.2 Agents that talk to each other

**Why.** Delegation is the multiplier: a general assistant hands a research task to a research agent and a drafting task to a writing agent, and the person sees the handoff.

**Harness.** Two layers, one transport.

- *Local:* several agents in one gateway already exist as scopes (`APP_ENGINE.md`). Add a message primitive between them: `send(toAgent, message)` for an asynchronous direct message, and threads with several agents and people. Delegation by description: each agent has a short public description, and a router agent picks the recipient from those descriptions.
- *Across machines:* Synapse. The original MindStone has a working Synapse channel client (`extensions/synapse-client/`: a bearer token per identity, several accounts per gateway, one autonomous reply per thread); port it as a connector, so an agent on one box and an agent on another use the same primitive. #39 continues to decide Synapse's own future.
- The #41 clean-room review session is the first consumer: a reviewer agent with no memory injection, reached through the same send primitive.

**Design rule from Grok Bot's experience.** Waking an agent must not mean re-reading its whole transcript. The woken agent gets the message plus LCA recall for that message, inside its sliding window, which is the point of LCA. Put a per-thread budget on agent-to-agent turns and a loop guard (one autonomous reply per thread per wake, as the Synapse client already does).

**Console.** An Agents panel (roster, description, persona, status, sandbox status) and agent threads rendered as conversations the person can read and join. LibreChat conversations have one owner (`CONSOLE_DESIGN.md` §9), so multi-agent threads are a MindStone panel backed by gateway data, not LibreChat conversations.

### 3.3 An execution sandbox per agent, and tool permissions

**Why.** Grok Bot's agents share one computer by design. For organizations, isolation between agents is a requirement, and it is where MindStone-Agent can be stronger than a hosted product.

**Harness.**

- A sandbox per agent: a container (or microVM where available) with its own filesystem, its own browser profile, and its own credentials, created from the agent's pack. Nothing shared by default; sharing is an explicit mount.
- A tool permission model per agent: which tools are enabled, which need approval, and which are denied, set in the agent's config and enforced at the gateway before the tool runs; the Pi session's tool set is built from that allowlist.
- Network policy per sandbox: allowlist by default for enterprise profiles.
- Browser automation inside the sandbox. The original MindStone has a browser tool and a sandbox browser image to port.
- Take-over: the person can view and drive the sandbox's browser for sign-ins, 2FA, and CAPTCHAs, and the agent resumes after.

This aligns with the agent-pack design in `PACK_REGISTRY_DESIGN.md` (Phase 3: agent packs as Compose stacks with verified images).

**Console.** Sandbox status on each agent, a live view of the sandbox browser for take-over, and the tool permission table per agent (admin role).

### 3.4 Agents that set things up, behind an independent review

**Why.** "Setup is a message" is the feature people notice first. MindStone-Agent already has the pieces behind human approval (`mindstone skill build` and `install`, persona overlays, signed packs); the gap is that an agent cannot propose them itself.

**Harness.**

- Model-facing tools that *propose*: create a skill, create or change a routine, create an agent from a persona, install a pack. Each proposal becomes a pending action of a new kind next to the existing three (`connector_send`, `memory_write`, `connector_mutation`).
- An independent reviewer in front of the human gate: a fresh-context review session (#41) that checks the proposal against policy and returns allow, ask, or deny with a reason. Unlike Auto Review, **memory writes are in scope**: a memory write is the change with the longest life, so it gets the same review. The human gate stays the final approval for anything the policy marks as needing a person.
- Pack signing stays the trust boundary for anything installed from outside.

**Console.** The Approvals center (P3 in `CONSOLE_DESIGN.md`) shows each proposal with the reviewer's verdict and reason, the diff it would apply, and approve or reject. Email and message drafts appear here as editable drafts with Send and Discard, which is the `connector_send` approval with a better face.

### 3.5 MCP support and connector breadth

**Why.** MCP is how most third-party tools now ship. Supporting it gives agents a large tool catalogue without a connector per service.

**Harness.** MCP client support in the gateway, per agent, with each MCP server's tools passing through the permission model in 3.3 and the review in 3.4. LibreChat has its own MCP support; it stays off (`CONSOLE_DESIGN.md` §5), because tools belong to the agent, not the chat window.

**Console.** An Integrations panel: MCP servers and connectors per agent, health, and the sign-in flow for OAuth connectors.

### 3.6 Smaller patterns worth borrowing

- **Secret request form.** When an agent needs a secret, it asks through a form that writes to the gateway's secret store; the value never enters the transcript or the model's context. This is `POST /admin/secrets/<name>` from `CONSOLE_DESIGN.md` §4.3 with an agent-initiated entry point.
- **Visible configuration events.** Every change an agent makes to itself (routine, skill, setting) appears in the transcript as an event, so the record explains the agent's behaviour.
- **Voice and mobile** stay on the wishlist (#30).

## 4. What not to copy

- **One computer shared by all agents.** Isolation per agent (3.3).
- **Hosted-only deployment and a model chosen for you.** MindStone-Agent stays self-hosted with any provider through Pi, including local models.
- **Re-reading the whole conversation on every turn.** Sliding window plus recall, per `CONTEXT_MANAGEMENT.md` and `MEMORY_STRATEGY.md`.
- **Memory writes outside review.** In scope for the reviewer and the human gate (3.4).
- **Memory as opaque files with no viewer.** The Console shows memory writes with provenance (`GET /admin/memory/recent`, P3) and recall results (`GET /admin/recall`).

## 5. Where MindStone-Agent already leads

These are the reasons an organization would choose it, and the adoption work above must not dilute them:

- **Layered Continuity Architecture:** identity files, append-only transcripts as the record, ranked recall with authority from mistakes prevented, and auto-recall on every surface.
- **Knowledge bases** with citations and external sources (folders, Obsidian vaults, URLs), with more sources designed.
- **The persona system:** personas as overlays under the core persona, with skills, workflows, and knowledge bases, distributed as signed packs.
- **Approval gates** on memory writes, connector sends, and connector mutations, each recorded in the transcript.
- **Self-hosting and model choice**, including local and air-gapped deployments.

## 6. Where each piece lands in the Console phases

| Adopted item | Harness work | Console surface | Phase |
|---|---|---|---|
| 3.4 Drafts with Send and Discard | none new (existing `connector_send` approval) | Approvals center | P3 (beta gate) |
| 3.6 Secret request form | agent entry point to the secrets API | form in chat | P2 |
| 3.1 Routines | scheduler (#29) plus triggers | Routines panel | P4 |
| 3.4 Self-setup with review | propose tools, reviewer session (#41), new pending kinds | Approvals center with verdicts | P4 |
| 3.2 Agent-to-agent | send primitive, router, Synapse connector port | Agents panel, agent threads | P4 |
| 3.3 Sandbox and permissions | sandbox per agent, tool allowlist, network policy, browser | agent sandbox view, take-over, permission table | P5 |
| 3.5 MCP | MCP client in the gateway | Integrations panel | P5 |

P4 and P5 are new phases after the beta. The tool allowlist in 3.3 is not tied to P5; it is harness hardening and should land as soon as it is designed.

## 7. Risks and thoughts

- **Agent-to-agent cost.** Agents waking each other multiplies turns. Budgets per thread and recall-based context (not transcript replay) are part of the design, not tuning.
- **Self-setup is an attack surface.** A prompt-injected agent that can propose routines, skills, and agents can try to persist itself. The reviewer and the human gate are the defence; the reviewer must run in a fresh context with no memory injection, and anything that runs unattended (routines, triggers) needs approval to create.
- **Sandboxes change the install story.** A container per agent needs Docker or an equivalent on the host. Keep a single-process mode for local use, with the tool allowlist as its protection, and make sandboxes the default for server profiles.
- **Scope.** This is a lot of harness work. Routines and the approval face (drafts, verdicts) give the most value for the least; agent-to-agent and sandboxes are the larger projects.

## 8. Open questions

1. Router design for delegation: a dedicated router agent, or every agent able to address any other by description.
2. Whether routines created by an agent always need human approval, or only above a risk level set by policy.
3. Sandbox runtime: Docker containers everywhere, or microVMs where the host supports them.
4. Whether the Synapse connector port happens before or after #39 decides Synapse's direction.
5. Which review policy ships by default for single-user local installs.

## 9. Sources

Grok Bot documentation and posts, read 2026-09-23:

- Introducing Grok Bot (2026-08-11): https://x.ai/news/introducing-grok-bot
- Designing Grok Bot (2026-09-03): https://x.ai/news/designing-grok-bot
- Grok Bot for Enterprise (2026-09-03): https://x.ai/news/grok-bot-for-enterprise
- Documentation: https://docs.x.ai/grok-bot/overview, `/bots`, `/chat-and-collaboration`, `/computer-and-apps`, `/skills-routines-and-automations`, `/files-and-results`, `/security`, `/security-faq`, `/teams-and-enterprises`, `/faq`
- Plans: https://cursor.com/help/grok-bot/plans
- Cursor staff answers on memory files, memory scope, and transcript re-reads: https://forum.cursor.com/t/170714, https://forum.cursor.com/t/170523, https://forum.cursor.com/t/168333, https://forum.cursor.com/t/172705

MindStone-Agent state is from the repository at `beb5502a` and the issue tracker, 2026-09-23.
