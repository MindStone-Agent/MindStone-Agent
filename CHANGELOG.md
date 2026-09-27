# Changelog

Everything that ships to `main` is recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Dates are UTC.

Every pull request to `main` adds its entry under **Unreleased**. A release moves those entries into a versioned section and tags `main`.

## [Unreleased]

### Security
- **Channel turns that aren't the owner's direct messages no longer get the owner's context** (#61).
  - Before this fix, with the default `session.mode: "single"`, a group or channel message landed in the owner's main session. Its prompt carried the owner's recalled memories, `USER.md`, the memory index and the owner's earlier DM history.
  - Only a direct message from a sender the connector can vouch for counts as the owner. Group, channel and thread turns, messages with no chat type and unverified senders run in their own per-surface session, without autoRecall, `USER.md` or the memory index. The agent's `IDENTITY.md` and its always-in-force rules still apply.
  - A message with no chat type is no longer treated as a DM: in a group it needs a mention or the trigger prefix, like any other group message.
  - Email: the From address counts as the owner only when Gmail's own `Authentication-Results` header shows a DMARC pass for its domain, or a DKIM pass from that domain or a parent of it.
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
