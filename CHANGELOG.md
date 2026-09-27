# Changelog

Everything that ships to `main` is recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Dates are UTC.

Every pull request to `main` adds its entry under **Unreleased**. A release moves those entries into a versioned section and tags `main`.

## [Unreleased]

### Fixed
- **Chat completions no longer store the whole conversation again every turn** (#38). Clients such as LibreChat resend the full history with each request, and the gateway wrote all of it to the transcript each time. Only the new turn (the trailing user messages) is stored now.
  - **Breaking:** a request that doesn't end with a user message (for example a tool-role or assistant-prefill tail) is now a 400. A message with no role counts as a user message.
  - Client system prompts: ignored for the Console's `user` role (logged once per session as an event), stored once per session for an admin or a direct API caller. Before, every resent copy was stored.
  - Each Console conversation (`x-mindstone-conversation-id`) gets its own session, so separate chats don't share a context window. Switching persona mid-conversation keeps its history. The memory backfill indexes every conversation into memory. Recall isn't yet scoped per agent or per Console user (#71).
  - The gateway replays the auto-compact handoff only into the session that wrote it, not into every new session (the CLI and TUI are unchanged). In `per_surface` mode, one surface's handoff no longer carries over to another surface's session.

### Security
- **App Engine runs scoped to an app, tenant or user no longer get the owner's context** (#70). Such runs went through as the owner, so a tenant's run carried the owner's `USER.md`, the memory index and owner-only invariants. They now get the non-owner treatment: no `USER.md`, memory index, owner-only invariants, handoff or onboarding seed, and in `pi-session` none of the owner's Pi resources. They keep their own scoped recall and rules marked `invariant_audience: all`. This covers both the gateway's `/agents/:id/runs` and the in-process `runMindStone` API. An App Engine run scoped only to the agent is still the owner's. A scoped run may use only session keys inside its own scope (a `403` or an error otherwise, so a tenant can no longer read or write the owner's main session), and an `appId`, `tenantId` or `userId` that is present but not a non-empty string (including `null`, or a value containing `:`) is refused rather than silently dropped. Whether a tenant run may recall the owner's unscoped memory is the open App Engine scope decision and is unchanged here.

- **Memory backfill keeps tenants apart and keeps non-owner turns out of the owner's recall** (#62).
  - Before this fix, `memory backfill` indexed every transcript with no labels. One App Engine tenant's run could surface in another tenant's recall, and a stranger's channel message could come back as the owner's memory.
  - Indexed transcript chunks now carry their surface, chat type, sender, audience and, for App Engine runs, the run's scope, taken from the entry itself, else its run, else the turn it follows (one scoped run in a session no longer affects the rest of it). A scoped run, reply included, is recalled only by a run whose recall scope matches every part of it, never by the owner's own recall. Scope is applied in the recall query itself, before ranking and before the candidate limit, so one tenant's volume can't crowd others out. App Engine runs at the tenant, app or user sharing level don't recall their own transcripts yet (their recall scope leaves out the agent id); that is part of the open App Engine scope decision.
  - Non-owner turns and the entries after them up to the next turn are not indexed unless `memory.transcripts.includeNonOwner` is set. Older connector entries without the new label count as the owner's only when they are a DM from one of the connector's `ownerSenders`; older email entries never do.
  - The next backfill removes transcript chunks that an earlier backfill indexed but the new rules exclude. It prunes nothing when the transcript directory is missing, empty or not a directory, and never touches memory files. Run `mindstone memory backfill` once after upgrading.
  - A scoped App Engine run no longer receives the owner's auto-compact handoff.
- **Channel turns that aren't the owner's direct messages no longer get the owner's context** (#61).
  - Before this fix, with the default `session.mode: "single"`, a group or channel message landed in the owner's main session. Its prompt carried the owner's recalled memories, `USER.md`, the memory index and the owner's earlier DM history.
  - **Upgrade step:** the owner is now named per connector with `channels.<id>.ownerSenders` (your own sender ids). Until it is set, nobody on that connector is the owner and your DMs there get no profile or memory; `mindstone doctor` warns. Being on `allowedSenders`, paired, or in an allowed domain lets someone talk to the agent but never makes them the owner.
  - Only a direct message from an owner sender that the connector can vouch for gets the owner's context. Every other turn (group, channel, thread, no chat type, unverified sender, another allowed sender's DM) runs in its own per-surface session, keyed by connector, without autoRecall, `USER.md`, the memory index or the auto-compact handoff. Only invariants marked `invariant_audience: all` reach it. In `pi-session` mode it also gets none of the owner's Pi extensions, skills, prompt templates, context files or built-in tools. The agent's `IDENTITY.md` still applies.
  - A message with no chat type is no longer treated as a DM: in a group it needs a mention or the trigger prefix, like any other group message.
  - Email: a From address is verified only when Gmail's own `Authentication-Results` header shows a DMARC pass for its domain (any other DMARC result is final) or a DKIM pass from that domain or a parent of it. A header with quotes, backslashes, unbalanced comments, two DMARC results or a result hidden in a comment is rejected, and a From header with two addresses is never verified. This authenticates the domain, not the mailbox.
  - Owner ids are compared trimmed and ASCII-case-insensitively; ids with non-ASCII characters never match.
  - Group history from before the upgrade stays in the main session; new group turns start their own sessions. In `per_surface` mode, the keys for group turns and other senders' DMs now include the connector, so those conversations also start fresh.
  - The owner's own surfaces (webchat, REST, OpenAI endpoints, App Engine) are unchanged. Session access by key with gateway auth `none` is a separate open decision.
- **pi-session turns no longer get Pi's built-in tools unless configured** (#54).
  - Before this fix, every turn in `pi-session` routing was offered Pi's built-in `read`, `bash`, `edit` and `write`. They run unsandboxed as the gateway user and bypass MindStone approvals.
  - Only the tools named in `routing.pi.builtinTools` are offered, and only Pi's default four can be re-enabled.
  - A guard refuses the turn before any model call if the session offers a built-in that wasn't enabled.

### Added
- **OpenAI-style server-sent events for chat completions** (#47). `POST /v1/chat/completions` with `stream: true` returns the reply as one content chunk, a stop chunk and `[DONE]`. It is not streamed token by token yet. Without the flag the JSON reply is unchanged.
- **Personas as models** (#47).
  - `/v1/models` lists `mindstone/<agentId>` for each configured agent.
  - A chat completion picks the agent from that model id when no `metadata.agentId` is given.
  - The gateway accepts `x-mindstone-user-id`, `x-mindstone-user-role` and `x-mindstone-conversation-id` from a front end. The user id becomes the sender, and the role and conversation id are saved on the transcript entries.
- **MindStone Console P0 spike** (#47, `spikes/console-librechat/`). This is a pinned LibreChat setup with the gateway as its only endpoint, plus a proxy that logs what LibreChat sends.
- **Memory: an always-in-force invariant tier** (#37).
  - Memories marked critical that have an authored `invariant` are injected every turn, whatever the query, instead of having to win a recall slot. If the budget runs out, an entry is cut to its name. Existing critical memories without an `invariant` are not included.
  - The memory index is injected every turn. When it doesn't fit, every entry is first cut to a bare pointer. Entries are dropped only if that still doesn't fit, and the prompt then says how many were left out.

### Documentation
- **MindStone Console design draft** (#46): a LibreChat fork, with the assistant-surfaces notes.
- **Microsoft 365 tenant integration design for a Digital Employee** (#45). It is a design only; nothing in it is implemented.
- **Running MindStone-Agent on Qwen3.5 through Ollama Cloud** (#43, #44), written as instructions an agent can follow, with the sign-up steps.
- **Live validation recorded** for Ollama Cloud chat, the authenticated prompt/stream path (#7) and compaction (#8), with the limits of each test (e50b8132).

## [0.1.0-beta] - 2026-07-14

The first beta. See the README, and the git log up to tag `v0.1.0-beta`, for its contents.

[Unreleased]: https://github.com/MindStone-Agent/MindStone-Agent/compare/v0.1.0-beta...HEAD
[0.1.0-beta]: https://github.com/MindStone-Agent/MindStone-Agent/releases/tag/v0.1.0-beta
