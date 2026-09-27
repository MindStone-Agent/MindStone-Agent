# Changelog

Everything that ships to `main` is recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Dates are UTC.

Every pull request to `main` adds its entry under **Unreleased**. A release moves those entries into a versioned section and tags `main`.

## [Unreleased]

### Security
- **pi-session turns no longer get Pi's built-in tools unless configured** (#54).
  - Before this fix, every turn in `pi-session` routing was offered Pi's built-in `read`, `bash`, `edit` and `write`. They run unsandboxed as the gateway user and bypass MindStone approvals.
  - Only the tools named in `routing.pi.builtinTools` are offered, and only Pi's default four can be re-enabled.
  - A guard refuses the turn before any model call if the session offers a built-in that wasn't enabled.

### Added
- **Streaming chat completions** (#47). `POST /v1/chat/completions` with `stream: true` returns OpenAI-style server-sent events; without the flag the JSON reply is unchanged.
- **Personas as models** (#47). The agent is resolved from the model id, and identity headers are forwarded.
- **MindStone Console P0 spike** (#47, `spikes/console-librechat/`). This is a pinned LibreChat setup using the gateway as its only endpoint.
- **Memory: an always-in-force invariant tier** (#37).
  - Memories marked critical, with an invariant, load on every turn instead of competing in similarity recall.
  - The memory index is injected on every turn. When it doesn't fit, it drops line by line with a note, rather than being left out.

### Documentation
- **MindStone Console design draft** (#46): a LibreChat fork, with the assistant-surfaces notes.
- **Microsoft 365 tenant integration design for a Digital Employee** (#45). It is a design only; nothing in it is implemented.
- **Running MindStone-Agent on Qwen3.5 through Ollama Cloud** (#43, #44), written as instructions an agent can follow, with the sign-up steps.

## [0.1.0-beta] - 2026-07-14

The first beta. See the README, and the git log up to tag `v0.1.0-beta`, for its contents.

[Unreleased]: https://github.com/MindStone-Agent/MindStone-Agent/compare/v0.1.0-beta...HEAD
[0.1.0-beta]: https://github.com/MindStone-Agent/MindStone-Agent/releases/tag/v0.1.0-beta
