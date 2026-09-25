# Console spike (P0)

LibreChat, pinned to v0.8.8-rc3, against the local MindStone gateway in mock routing mode. Answers the P0 questions in `docs/refactor/CONSOLE_DESIGN.md`: does LibreChat require streaming, do personas surface as models, does the user id reach the gateway.

Run: start the gateway with chat completions enabled and token auth (`MINDSTONE_AGENT_GATEWAY_TOKEN=console-spike-token mindstone gateway start`), then `docker compose up -d` here and open http://localhost:3080. The first registered account is admin.

Everything in this directory is disposable. `.env` holds generated local secrets and is gitignored.
