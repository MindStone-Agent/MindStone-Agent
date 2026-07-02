# Live UAT runbook — one sitting, every deferred live check

Everything below is **implemented + smoke-tested (non-live)**; these are the
live legs that need a human with credentials. Ordered so one pass covers the
lot. Each item says what "pass" looks like and which claim it upgrades.
Maintained continuously during the wishlist sprint — new items are appended as
issues ship, so check the tail before starting.

_Last updated: 2026-07-02 (post-#14). Items 1–5 cover the MVP marathon; the
appendix accumulates wishlist-sprint additions._

## 0. Prereq — connect auth into the ISOLATED runtime (~1 min)

```bash
cd /Users/clint/Projects/MindStone-Agent
./scripts/mindstone auth login openai-codex
```

Never touches global `~/.pi/agent`. Any subscription/OAuth provider works;
adjust the model ids below to match.

## 1. Issue #7 — live Pi-session prompt/stream (runbook Gate 6, ~3 min)

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

**Pass:** exit 0 with a real streamed assistant response captured in the
canonical transcript. Upgrades #7 to live-validated; close it with the output
pasted in a comment.

## 2. Issue #8 — live Pi-session compaction (~3 min)

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_COMPACT=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

**Pass:** an authenticated `AgentSession.compact()` produces a real summary.
Upgrades #8; public docs then drop "compaction: live validation pending".

## 3. Issue #3 residual — Ollama Cloud live chat (~3 min, needs ollama.com key)

Steps in [`LOCAL_MODELS.md`](LOCAL_MODELS.md): register the Ollama Cloud
provider through onboarding or `mindstone config --section routing`, supply the
API key, then:

```bash
./scripts/mindstone chat --once "hello from ollama cloud" --json
```

**Pass:** a real completion from `https://ollama.com/v1`. Upgrades the #3
Ollama Cloud lane from pending to live-validated.

## 4. Issue #6 residual — human-keyboard TUI check (~2 min)

```bash
./scripts/mindstone tui
```

Type a message, get a reply, then `/quit`. **Pass:** clean exit, both turns in
the transcript. Closes the one #6 residual my pty harness couldn't claim (real
human keyboard timing).

## 5. Live judgment spot-checks (optional but high-value, ~10 min)

With any live provider configured, one conversational pass exercises the whole
context-composition stack the mock smokes can only prove structurally:

- **Persona overlay honored in prose:** activate a persona
  (`mindstone persona activate <id>`), ask something in its domain, confirm
  the voice/role actually shifts — and that core identity still governs.
- **KB recall in a live answer:** with an indexed KB
  (`mindstone kb ingest <id>`), ask a question the KB answers; confirm the
  reply reflects the KB summary and can cite the source when asked.
- **Auto Recall relevance:** ask about something from an earlier session;
  confirm recalled memory shapes the answer sensibly (not verbatim dumping).

**Pass:** subjective — the composed prompt stack behaves as designed with a
real model in the loop.

## 6. Push decision

Local `main` is ahead of `origin` (all receipts on the issues). If UAT looks
good: say the word and the sprint's commits push.

---

## Appendix — wishlist-sprint additions (live legs land here as issues ship)

- **#14 App Engine / Agent Mesh:** no live leg required — scope isolation and
  routing authority are fully provable with mocks (and were). Optional: repeat
  item 5 through `POST /agents/<id>/runs` on a running gateway to feel the
  mesh surface.
- **#16 Connector framework:** no external live leg (the loopback reference
  connector is deliberately local). Optional 2-min feel-check with a live
  provider configured: start the gateway with `channels.loopback` enabled,
  append `{"messageId":"x1","text":"hello","senderId":"<you>","chatType":"direct"}`
  to `<dataDir>/connectors/loopback/inbox.jsonl`, and watch a real model reply
  land in `outbox.jsonl`.
- **#17 Telegram (live leg, ~5 min, needs a bot token from @BotFather):**

  ```bash
  export MINDSTONE_TELEGRAM_TOKEN='<token from @BotFather>'
  # configure: channels.telegram = { enabled, tokenEnv: "MINDSTONE_TELEGRAM_TOKEN",
  #   allowedSenders: ["<your numeric Telegram user id>"] }   (or run the setup wizard)
  ./scripts/mindstone gateway run
  ```

  Then DM the bot from your allowlisted account. **Pass:** a real reply
  arrives in Telegram; `mindstone status --json` shows the connector
  `running` with the delivery queue draining; a message from a
  non-allowlisted account gets NO reply (fail closed). Upgrades #17 from
  smoke-tested (local stub Bot API) to live-validated.
- **#18 Slack (live leg, ~10 min, needs a Slack app):** create an app at
  api.slack.com → enable **Socket Mode** (app-level token with
  `connections:write`) → bot token scopes `chat:write`, `app_mentions:read`,
  `im:history`, `im:read` → subscribe to `app_mention` + `message.im` events →
  install to workspace.

  ```bash
  export MINDSTONE_SLACK_BOT_TOKEN='xoxb-…'
  export MINDSTONE_SLACK_APP_TOKEN='xapp-…'
  # channels.slack = { enabled, tokenEnv: "MINDSTONE_SLACK_BOT_TOKEN",
  #   appTokenEnv: "MINDSTONE_SLACK_APP_TOKEN",
  #   allowedSenders: ["<your member id, e.g. U012ABC>"] }
  ./scripts/mindstone gateway run
  ```

  **Pass:** DM the bot → real reply; @mention it in a channel → reply lands
  *in a thread* on your message; a non-allowlisted member gets nothing.
  Upgrades #18 from smoke-tested (local stub Web API + Socket Mode) to
  live-validated.
- _(Connectors #19–#22 will add per-service live legs as they ship.)_
