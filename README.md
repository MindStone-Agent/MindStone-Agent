# MindStone-Agent

> ⚠️ **BETA — not guaranteed to be functional yet.**
> MindStone-Agent is currently released as **BETA** and is under active
> development. No part of it is guaranteed to work in your environment yet.
> Read every capability below at its stated maturity — see
> [Current status](#current-status) for the exact claim taxonomy
> (**implemented** / **smoke-tested** / **live-validated** / **pending**) — and
> expect rough edges. Do not depend on it for production or unattended use.

> 🚀 **Quick start:** one command installs everything (the gateway, the web Console and its database) in Docker. See [Quick start](#quick-start).

> 🤖 **AI agents:** to install this, follow [Install guide for AI agents](#install-guide-for-ai-agents). It works step by step, with a check after each step.

🔶 **Persistent AI agents with identity, memory, recall, and shared continuity across surfaces.**

MindStone-Agent is a local-first agent harness for building AI collaborators that keep their identity, history, working context, and accumulated judgment across sessions. It combines a native CLI/TUI, a local Gateway, structured memory, append-only transcripts, Auto Recall, context management, and Pi-backed model execution inside an isolated runtime.

MindStone-Agent is not just a chat wrapper. It is a continuity substrate: the transcript is authoritative history, the prompt is a managed working set, and memory is a layered system rather than a single retrieval feature.

## Why MindStone-Agent exists

Most AI agent sessions start over. Context windows fill, summaries flatten the work, and the next session has to infer what mattered from a lossy snapshot. Retrieval helps, but retrieval alone does not create continuity.

MindStone-Agent is designed for agents that should become better collaborators over time:

- know their role and operating rules;
- remember the human or organization they work with;
- preserve an append-only record of what happened;
- promote durable decisions and lessons into structured memory;
- automatically recall relevant prior context before inference;
- manage live context without deleting history;
- expose Gateway, WebChat, CLI, TUI, and API surfaces over the same continuity substrate.

## Core ideas

### Layered continuity

MindStone-Agent treats memory as multiple cooperating layers:

1. **Identity and standing context** — `IDENTITY.md`, `USER.md`, agent profile, and role/project rules.
2. **Authoritative history** — append-only JSONL transcripts with source metadata.
3. **Structured memory** — curated memory files, journals, `LOG.md`, and a memory index.
4. **Auto Recall** — automatic pre-inference recall from memory and transcript sources.
5. **Live context management** — sliding-window prompt selection and compaction-aware handoff paths.
6. **Gateway and surfaces** — CLI, TUI, WebChat, REST, RPC, WebSocket, OpenAI-compatible, and OpenResponses-compatible APIs.
7. **Checkpoint and handoff discipline** — durable continuity across compaction, interruption, and session restart.

### Auto Recall

Auto Recall is not the agent deciding to run a search. It is an automatic continuity step between the user prompt and model inference. The current prompt, task, role, project, and channel become retrieval cues; relevant memory/transcript chunks are ranked and injected into the model’s working context before the model answers.

Manual memory search can still exist, but Auto Recall is the substrate bringing the relevant past forward before the turn begins.

### Authoritative transcripts

The transcript is history. The prompt is a working set.

MindStone-Agent can prune, summarize, compact, or rebuild the live prompt, but those operations must not silently rewrite or delete the append-only transcript. This keeps recovery, audit, and re-indexing possible.

## Current status

MindStone-Agent is **BETA** and in active development. Claim taxonomy used throughout: **implemented** (code exists), **smoke-tested** (proven by the non-live smoke suite), **live-validated** (proven against a real endpoint/terminal), **pending** (not yet proven).

The non-live smoke suite is the source of truth for what works and is invoked
per-area with `npm run smoke:*` (see [Development and validation](#development-and-validation)).
The last recorded green pass of the *whole* suite was **49/49 on 2026-07-01**;
every subsystem that landed since ships with its own smoke leg, and those are
listed below at their individual maturity rather than folded into a single
whole-suite number.

**Smoke-tested (non-live), through the 2026-07-01 full-suite pass:**

- isolated runtime under `.runtime/`, separate from global `~/.pi/agent`;
- native `mindstone` CLI, onboarding/config/auth flows, `mindstone chat`, styled `mindstone tui`;
- Gateway management through `mindstone gateway ...`;
- REST chat, HTTP RPC, WebSocket RPC, OpenAI-compatible chat completions, and non-streaming OpenResponses-compatible endpoints;
- built-in WebChat shell; canonical shared session key `agent:default:main`; append-only transcript store with source metadata;
- continuity proof suite: file-backed memory, journals, LOG, SQLite indexing/backfill/maintenance, embedding vectorization (mock embed model over the real provider-HTTP + SQLite path), auto-recall injection, CLI chat recall, SCRI ranking/dedup, sliding-window pruning with transcript preservation;
- local model (Ollama / LM Studio / OpenAI-compatible) and Ollama Cloud setup lanes (`docs/operations/LOCAL_MODELS.md`);
- Pi adapter commands/tools/hooks for Pi-side use;
- Pi `AgentSession` / `SessionManager` execution path (non-live).

**Smoke-tested (non-live), landed since the 2026-07-01 pass — each with its own smoke leg:**

- content system — persona overlays (`mindstone persona`), skills plus the Skill/Integration Builder (`mindstone skill`), extractive knowledgebases (`mindstone kb`), and the deterministic workflow router; every artifact sits *below* the core `IDENTITY.md`/`USER.md` and never overrides identity, user boundaries, or safety (`smoke:persona`, `smoke:skill`, `smoke:kb`, `smoke:kb-sources`, `smoke:workflow`);
- content packs — Phase 1 signed local pack lifecycle: `build` / `inspect` / `install` / `verify` / `remove` / `status` / `keygen` / `trust-add`, ed25519-signed `.mspack` bundles with a shipped-publisher trust seed, an extraction guard (path traversal refused), a prompt-surface integrity gate, and a knowledgebase whitelist (`smoke:packs` — green **2026-07-14**);
- channel connector framework v1 — a deterministic loopback reference connector, a persistent delivery queue with retry/dead-letter, fail-closed allowlist/pairing, and the approval framework (send policies + fenced action proposals); Telegram / Slack / Discord / email / calendar connectors implemented against the shared contract (`smoke:connector`, `smoke:telegram`, `smoke:slack`, `smoke:discord`, `smoke:email`, `smoke:calendar`);
- App Engine / Agent Mesh v1 scaffold — in-process `runMindStone()` runtime and logically-isolated multi-agent mode (`smoke:app-engine`).

**Live-validated (2026-07-01):**

- fresh install/onboard/TUI E2E in a real terminal (pty): `mindstone reset --keep-pi-auth` typed confirmation → complete onboarding from scratch with in-flow identity activation → TUI turn → `/quit` clean exit;
- local/OpenAI-compatible model route end-to-end: fresh runtime → isolated `models.json` provider → pi-session `AgentSession` → live local HTTP endpoint → response in the canonical transcript (`smoke:local-route`);
- Ollama local probe (real Ollama daemon model listing) and Ollama Cloud model listing (`https://ollama.com/v1/models`).

**Live-validated (2026-08-05), all three unblocked by connecting the first authenticated provider:**

- Ollama Cloud live chat, on aarch64 (Debian 11, Node 24): isolated `models.json` provider → pi-session route → `deepseek-v4-pro:cloud` → real answer with tool use, persisted to the canonical transcript, reachable identically through `mindstone chat --once` and the Gateway REST surface, and surviving a reboot under systemd (issue #3 residual);
- live authenticated Pi-session prompt/**stream** validation (issue #7): `smoke:pi-session-live` exit 0, `ok: true`, 25 stream events with 24 persisted;
- live **compaction** validation (issue #8): `smoke:pi-session-live` with `MINDSTONE_PI_SESSION_LIVE_COMPACT=1`, exit 0, a real `AgentSession.compact()` summary. The probe session was 4 entries, so this proves the mechanism, not summary quality on a long conversation.

Bounds and what remains untested for these three: `docs/operations/LOCAL_MODELS.md`.

**Pending (documented, not claimed):**

- native `sqlite-vec` nearest-neighbor backend (current fallback: `js-cosine`);
- human-at-keyboard TUI `/quit` spot-check (pty-verified already);
- live validation of the production channel connectors against real Telegram / Slack / Discord / email / calendar services (the framework and connectors are smoke-tested non-live only);
- pack registry Phase 2 — the signed static registry index and a `mindstone packs install <id>` auto-resolver (Phase 1 install is manual from a local `.mspack` + `.sig`);
- Microsoft Teams connector (designed under issue #20 in `docs/operations/TEAMS_CONNECTOR_DESIGN.md`; implementation tracked as #32, not started).

## Media and demos

- YouTube channel: <https://www.youtube.com/@MindStoneAgent>
- Videos playlist: <https://www.youtube.com/playlist?list=PLFgIjBvcsqPrZPVf5AIH0gBQXUvvk4gkG>
- First video: <https://www.youtube.com/watch?v=kMPmOvRrg2c>

## Quick start

### Install everything (Docker)

The gateway, the web Console and its database, all in Docker. You need only Docker with Compose v2 or newer (Docker Desktop on macOS or Windows; Docker Engine on Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.sh | bash
```

The installer asks for the Console admin's email, name and password (the password isn't shown), builds and starts the stack, and ends with `Open http://localhost:3080`. Sign in there: the **Set up MindStone** banner walks you through the model, the persona and memory. On macOS, Ollama on this machine is used as it is, for chat and for embeddings. On Linux, Ollama on the host has to listen on the Docker bridge address, or add `--with-ollama` to run it in the stack (see path A0 below).

Don't run it with `sudo`: on Linux, add your user to the `docker` group instead.

On Windows, run the same command in a WSL 2 terminal (Ubuntu, for example) with Docker Desktop's WSL integration turned on for that distribution. Ollama for Windows is reached the same way as on macOS. This path hasn't been tested yet.

Everything lives in `~/.mindstone-stack`. Running the same command again updates the stack and keeps your secrets and data. For the options, and a step-by-step with a check after each step, see [Install guide for AI agents](#install-guide-for-ai-agents), path A; for what runs where, see [Docker](#docker).

### Install from the public repository

The gateway and the `mindstone` CLI only, natively on this machine (Node.js 22.19 or newer):

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install.sh | bash
mindstone onboard
```

Custom install directory:

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install.sh | \
  bash -s -- --dir "$HOME/Projects/MindStone-Agent"
```

The installer clones or updates the repository, installs dependencies, builds the vendored Pi base, initializes isolated runtime directories and, on a first install, the runtime config (not onboarded yet), and links the `mindstone` CLI onto your PATH unless `--no-link` is used. `mindstone onboard` finishes setup in a terminal; to set up in the web Console instead, see the [install guide for AI agents](#install-guide-for-ai-agents), step B2(b).

### Install from source

```bash
git clone https://github.com/MindStone-Agent/MindStone-Agent.git
cd MindStone-Agent
npm install
npm run install:native
npm run link:cli
mindstone onboard
```

For an unlinked checkout, use:

```bash
./node_modules/.bin/mindstone status
```

## Install guide for AI agents

This section is written so an AI coding agent (Claude Code, Codex and similar) can install and run MindStone-Agent from start to finish; humans can follow it too. Every step ends with a check, and you shouldn't move on until the check passes. **Never print a token, password or credential into your output.** Write secrets straight to files, as the commands below do, and check them by counting, never by showing them.

Choose **one** path:
- **A. The whole stack in Docker (recommended).** The gateway, the web Console and MongoDB run in Docker, set up by one installer. Nothing is built on the host, and setup finishes in the Console.
- **B. Native.** The gateway and the `mindstone` CLI run on this machine (Node.js 22.19 or newer). Set it up in a terminal (`mindstone onboard`), or add the Console separately from its own repo.

### A. The whole stack in Docker

The commands below assume the default install folder `~/.mindstone-stack` and the default ports: the Console on `127.0.0.1:3080` and the gateway on `127.0.0.1:19789`. Both listen on loopback only.

#### A0. Requirements

- macOS or Linux (arm64 or x86_64), with `curl`.
- Docker with Compose v2 or newer: Docker Desktop on macOS, or Docker Engine with the Compose plugin on Linux. Docker must be running.
- About 10 GB of free disk space for the images. The first build takes 10 to 20 minutes.
- Your user can run Docker. On Linux, that means being in the `docker` group (`sudo usermod -aG docker $USER`, then log in again). Don't run the installer with `sudo`: it would install into root's home, with root's ids.
- Optional: [Ollama](https://ollama.com) on this machine, for local models and embeddings.
  - **macOS (Docker Desktop):** nothing to do.
  - **Linux:** the containers reach the host at its Docker bridge address (usually `172.17.0.1`; see `ip -4 addr show docker0`), and Ollama listens on `127.0.0.1` by default. The simplest choice is `--with-ollama` (step A1), which runs Ollama in the stack. To use the host's Ollama instead, set `OLLAMA_HOST=172.17.0.1` (the Docker bridge address) in its service's environment. `OLLAMA_HOST` takes one address, so this replaces `127.0.0.1`: the host's own `ollama` command and anything else that uses `localhost:11434` then need `OLLAMA_HOST=172.17.0.1` too. Don't bind it to `0.0.0.0`: Ollama's API has no authentication, so that opens it to your whole network.

**Check:**

```bash
docker info >/dev/null && docker compose version
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19789/health
```

The first prints `Docker Compose version` and a version of 2 or newer (for example `v2.33.1`, or `5.3.1` on current Docker Desktop); 1.x is too old. The other two print `000`: nothing is using port 3080 or port 19789 yet. A native MindStone gateway (path B) uses 19789; stop it, or choose other ports in step A1. The installer checks both ports too, and stops with a clear message if either is taken.

#### A1. Install

Without a terminal to type into, pass the admin's email. The installer then generates the admin password into `~/.mindstone-stack/admin-password` (mode 600) and prints the file's path, never the password:

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.sh | \
  bash -s -- --admin-email <the person's email>
```

A person at a terminal can leave out `--admin-email` and answer the prompts instead. Either way the details are checked before the build: the email must be one the Console accepts (no quotes, and no dot first, last or doubled before the `@`), the name must be 3 to 80 characters, and the Console username is the email's local part (letters, digits, `.` and `_`), made longer when it's under 2 characters or already taken.

The Console makes only its first account an admin. When it already has accounts, the installer sets the new account's role to `ADMIN` in its database and says so; either way it checks that the role is `ADMIN` before reporting success. If an account with that email already exists, the installer creates none and sets no password: an admin signs in with its own password, and for a regular user it prints the command that makes it an admin (or re-run with another `--admin-email`).

Options go after `bash -s --`:
- `--dir <path>`: the install folder. It must be new, empty, or an earlier stack install (it carries a `.mindstone-stack` marker file). The installer resolves the path physically first (following `..` and any symlinked parent, as `/tmp` is on macOS), then refuses any other folder, a symlink given as the folder itself, your home folder, and any folder that contains it.
- `--ref <git ref>` and `--console-ref <git ref>`: the MindStone-Agent and Console versions to build, `main` by default.
- `--admin-name <name>`.
- `--with-ollama` runs Ollama in the stack too, and `--without-ollama` goes back to Ollama on this machine. If you switch after setup is done, also change the Ollama provider's address in the Console (Settings, **Your setup**, model provider): chat keeps the address it was set up with, while memory follows the new one.
- `--ollama-url <url>`: Ollama as the gateway container sees it, ending in `/v1`. Inside the container `localhost` is the container itself, so the installer warns about it.

Ports and the Compose project name (`mindstone-stack` by default) are environment variables, set on `bash` (not on `curl`). The installer reads only its own variables from your shell (`CONSOLE_PORT`, `MINDSTONE_GATEWAY_PORT`, `MINDSTONE_PROJECT`, `MINDSTONE_REF`, `CONSOLE_REF`, `MINDSTONE_OLLAMA_BASE_URL`, `MINDSTONE_DIR`), and runs its own `docker compose` commands with every `COMPOSE_*` variable and every variable `compose.yml` reads unset, so those come from `.env`:

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.sh | \
  CONSOLE_PORT=3090 MINDSTONE_GATEWAY_PORT=19790 bash -s -- --admin-email <email>
```

If you change them, use your ports in place of 3080 and 19789 in the checks below. The installer saves them in `~/.mindstone-stack/.env`, so later runs and `docker compose` commands use them too.

What it does:
- checks Docker and Compose v2 or newer;
- downloads the compose file and the Console's config, pinned to the refs;
- generates every secret into two 600 files, `gateway.env` and `console.env`. The admin credential's plaintext is only in `console.env`; the gateway gets its sha256;
- builds and starts the stack (`docker compose up -d --build`) and waits until the gateway and the Console answer;
- creates the Console admin account;
- prints `Open http://localhost:3080`, and how to stop, update and uninstall.

**Check:** the installer exits 0 and prints `Open http://localhost:3080`. Then:

```bash
cd ~/.mindstone-stack && docker compose ps --format '{{.Service}} {{.Status}}'
```

It lists `gateway` as `Up … (healthy)`, and `console` and `mongodb` as `Up`.

#### A2. Check the secrets and the gateway

Run these in `~/.mindstone-stack`. They count and compare, and never show a value:

```bash
cd ~/.mindstone-stack
grep -cE '^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+' console.env
ls -l gateway.env console.env | cut -c1-10
curl -s http://127.0.0.1:19789/health
TOKEN_HEADER="Authorization: Bearer $(sed -n 's/^MINDSTONE_AGENT_GATEWAY_TOKEN=//p' gateway.env)"
curl -s -o /dev/null -w '%{http_code}\n' -H "$TOKEN_HEADER" http://127.0.0.1:19789/v1/models
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19789/v1/models
unset TOKEN_HEADER
```

**Check:**
- the count is `6`, and both files show `-rw-------`;
- `/health` prints JSON with `"ok":true`;
- `/v1/models` prints `200` with the token and `401` without it.

#### A3. Check the Console and sign in

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080
```

**Check:** it prints `200`. Signing in works: with a generated password, this prints `200` without showing it (`--data @-` reads the request from stdin):

```bash
cd ~/.mindstone-stack
printf '{"email":"%s","password":"%s"}' "<the admin's email>" "$(head -n 1 admin-password)" | \
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' --data @- http://127.0.0.1:3080/api/auth/login
```

Tell the person where the password file is. They should sign in once, store the password somewhere safe, and delete the file.

#### A4. Finish setup in the Console

Setup is done in the Console, in a browser: skip `mindstone onboard`, and don't set `routing` yourself. The person signs in at <http://localhost:3080>. Until setup is finished, an admin sees a **Set up MindStone** banner; the same setup is at <http://localhost:3080/mindstone/onboarding>. It chooses the model provider, the model and the persona, then sets up memory (an embedding model with a live check; with Ollama the Console can download it), optional chat connectors, and a short **About you** step. Its first step asks the person to type `enable advanced settings`.

Ollama on this machine is reached from the gateway container as `http://host.docker.internal:11434/v1`: the Ollama choice in setup is already filled in with it. To check the container reaches it:

```bash
cd ~/.mindstone-stack && docker compose exec gateway curl -s -o /dev/null -w '%{http_code}\n' http://host.docker.internal:11434/api/tags
```

**Check:**
- that prints `200` (only if you use Ollama on this machine);
- before setup, `docker compose exec gateway ./scripts/mindstone doctor` ends with `Result: ok`. Its two warnings are expected until setup finishes: `routing.mode` shows `placeholder`, and `memory.sqlite` has no index yet;
- once setup is finished, the banner is gone, `routing.mode` shows `pi-session`, and a chat message gets a real answer.

The `mindstone` CLI runs inside the gateway container as `docker compose exec gateway ./scripts/mindstone <command>`, for example `status`, `doctor` or `config`. Interactive commands (`onboard`, `auth login`) need `docker compose exec -it`.

#### A5. Update, restart, stop and uninstall

- **Update:** run the step A1 command again, with the same `--dir` if you used one (`--admin-email` isn't needed again). It keeps the refs and ports saved in `.env`, rebuilds both images, and never regenerates a secret or touches your data. To move to other versions, pass `--ref` and `--console-ref`.
- **Restart the gateway:** from the Console's settings page, or `docker compose restart gateway`. The container's restart policy brings the gateway back after the Console restarts it.
- **Stop and start:** `cd ~/.mindstone-stack && docker compose stop`, then `docker compose up -d`.
- **Customise:** put your own changes (an Ollama GPU, extra mounts) in `~/.mindstone-stack/compose.override.yml`. The installer includes it and never overwrites it; an update replaces `compose.yml`, keeping the previous copy as `compose.yml.bak.<time>`.
- **Uninstall:** run the installer with `--uninstall` (and the same `--dir`). It stops and removes the containers and keeps the data: the Docker volumes, `~/.mindstone-stack/data` and the secrets. It prints how to delete them, which can't be undone: `docker volume rm` of this project's volumes by name, and a delete of only the files and folders the installer made (never the whole folder, and never `docker compose down -v`).

**Check (after an update):** the secrets are unchanged, and the stack is healthy again:

```bash
cd ~/.mindstone-stack
cat gateway.env console.env | shasum -a 256 > .secrets-before.sha256   # before the update (sha256sum on Linux)
# ... run the update ...
cat gateway.env console.env | shasum -a 256 | diff -q - .secrets-before.sha256 >/dev/null && echo unchanged
docker compose ps --format '{{.Service}} {{.Status}}'
```

It prints `unchanged`, and `gateway` shows `(healthy)`.

**Don't:**
- print or paste the contents of `gateway.env`, `console.env` or `admin-password`;
- publish the ports on `0.0.0.0`. For another machine, put the Console behind a reverse proxy with HTTPS (see the Console README);
- run the native gateway (path B) on the same port as the stack's gateway.

### B. Native install

The gateway and the `mindstone` CLI on this machine. The web Console is optional here (step B5); for the Console and the gateway together in Docker, use path A.

#### B0. Requirements

- macOS or Linux (arm64 or x86_64).
- `git`, plus **Node.js 22.19 or newer** with `npm`. Check with `node --version`.
- A C/C++ toolchain for native modules:
  - **macOS:** the Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** `build-essential` and `python3`.
- Docker, but only if you'll also run the web Console (step B5). To run everything in Docker instead, use path A.

#### B1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install.sh | bash
```

This clones into `~/.mindstone-agent/MindStone-Agent`, installs dependencies, builds everything, and links the `mindstone` command onto `PATH`.

Options go after `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install.sh | \
  bash -s -- --dir "$HOME/MindStone-Agent" --no-link
```

With `--no-link`, run the CLI as `./node_modules/.bin/mindstone` from inside the checkout.

On a first install, the installer also creates the runtime config, `<checkout>/.runtime/mindstone/config.json`, with safe defaults:
- not onboarded: `routing.mode` is `placeholder`, so no model is called yet;
- the gateway on `127.0.0.1:19789`, with auth `none` and its HTTP APIs off;
- placeholder identity and user files. `mindstone onboard` (B2(a)) replaces them. On the Console path (B2(b)), the Console's guided setup replaces them with the first-activation scaffold (its **About you** step), keeping `.pre-onboarding-placeholder.bak` backups, and the agent then forms its identity in its first Console chat ([#102](https://github.com/MindStone-Agent/MindStone-Agent/issues/102)).

Re-running the installer (step B4) never changes an existing `config.json`.

**Check:** `mindstone status` exits 0, prints the isolated runtime paths, all under `<checkout>/.runtime/`, and shows `Config exists: true`.

#### B2. Onboard: in a terminal, or in the web Console

Choose **one** path.

##### B2(a). In a terminal: `mindstone onboard`

`mindstone onboard` and `mindstone auth login <provider>` are **interactive**: they need a real terminal (TTY), and an OAuth login opens a browser. If you are an agent without a TTY, either ask the human to run this in the checkout folder, or use path B2(b):

```bash
mindstone onboard
```

Wait until they confirm it finished. Onboarding does three things:
- connects a model provider;
- writes the routing (`routing.mode: pi-session`);
- creates the identity, user and memory files.

It updates the `config.json` the installer created. To change settings later, use `mindstone config --section <name>`.

**Check:**
- `mindstone doctor` reports no errors for runtime, config, identity and routing.
- `mindstone chat --once "hello"` returns a real answer, not a setup prompt.

##### B2(b). In the web Console: skip `mindstone onboard`

This path needs no interactive terminal (TTY): steps B3 and B5 are still shell commands, but none of them prompts. Don't run `mindstone onboard`. Instead:
1. start the gateway (step B3);
2. set the gateway up for the Console (step B5);
3. install the Console and run its guided setup, following the [Console README](https://github.com/MindStone-Agent/mindstone-console) (its path B, for a gateway already installed). Guided setup chooses the model provider, the model and the persona, then sets up memory (an embedding model with a live check; with local Ollama the Console can download it), optional chat connectors, and a short **About you** step that writes the identity scaffold. The gateway reports itself as onboarded once the provider, model, persona, memory and About you steps are done; connectors are optional (`GET /admin/status` shows each step), and the first Console chat starts identity formation.

Until then the gateway reports itself as not onboarded, and the Console shows a **Set up MindStone** banner.

**Check:** `mindstone doctor` ends with `Result: ok`. Its `routing.mode` line is a warning showing `placeholder`, which is expected until the Console's guided setup finishes.

#### B3. Start the gateway

Choose **one** of these. Don't run both, or two gateways will fight over the port.

```bash
mindstone gateway start      # a background process; manage it with gateway stop/restart
mindstone gateway install    # macOS only: a launchd service that starts at login
```

**Check:** `curl -sf http://127.0.0.1:19789/health >/dev/null && echo ok` prints `ok`.

**Using another port.** The gateway listens on port 19789 by default. Two settings choose the port, and **they must agree**:
- **`MINDSTONE_AGENT_GATEWAY_PORT`**, an environment variable, moves the listener. Set it on every `mindstone gateway start` and `restart` (for example `MINDSTONE_AGENT_GATEWAY_PORT=19790 mindstone gateway start`). It isn't read from `config.json`.
- **`gateway.port`** in `<checkout>/.runtime/mindstone/config.json` is the port the CLI uses: `gateway start`, `restart` and `status` check health there, and `mindstone status` and `doctor` report it.

If they differ, the gateway runs, but the CLI's health checks report it as down. The macOS `gateway install` service always listens on 19789. Use the new port in place of 19789 in the checks here and in step B5, and in the Console's gateway URL.

#### B4. Update later

Re-run the install command from step B1, with the same options if you used any (`--dir`, `--no-link`). It pulls the latest `main`, rebuilds, and keeps your `.runtime/` data; an existing `config.json` is left exactly as it is. Then restart the gateway (`mindstone gateway restart`, or reinstall the service).

**Check:** `mindstone doctor` is clean, and `/health` answers.

#### B5. The web Console (optional after B2(a), required for B2(b))

The MindStone Console is a web UI for chat and administration: settings, secrets, approvals, doctor and logs, and restart. It lives in [MindStone-Agent/mindstone-console](https://github.com/MindStone-Agent/mindstone-console), and its README has the install steps.

The gateway side works on either path from step B2: after `mindstone onboard` (B2(a)), or with no onboarding yet (B2(b)), using the `config.json` the installer created. Start the gateway first (step B3). Then run these commands, which write the secrets to files and never print them.

1. **The gateway token.** Paths in the config are relative to the config file's folder:
   ```bash
   cd <checkout>/.runtime/mindstone
   mkdir -p -m 700 secrets
   (umask 077; openssl rand -hex 32 > secrets/gateway-token)
   ```
   Don't also set a `MINDSTONE_AGENT_GATEWAY_TOKEN` environment variable. If it's set, it wins over the file.
2. **The admin credential.** The gateway stores only its hash, so keep the credential itself **outside** `.runtime/`. The Console needs it (Console step 2); after that, delete this copy.
   ```bash
   [ -e "$HOME/.mindstone-admin-credential" ] || (umask 077; openssl rand -hex 32 > "$HOME/.mindstone-admin-credential")
   ```
   Do this once. Replacing the credential after the Console is set up disconnects the Console until its `.env` gets the new value.
   It must differ from the gateway token, or the admin API stays off.
3. **Merge the settings into `config.json`.** This keeps everything else in the file:
   ```bash
   cd <checkout>/.runtime/mindstone
   HASH=$(printf %s "$(cat "$HOME/.mindstone-admin-credential")" | shasum -a 256 | cut -d' ' -f1) \
   node -e '
     const h = process.env.HASH || "";
     if (!/^[0-9a-f]{64}$/.test(h) || h.startsWith("e3b0c442")) throw new Error("no admin credential hash: check the credential file and shasum");
     const fs = require("fs"), f = "config.json", c = JSON.parse(fs.readFileSync(f, "utf8"));
     c.gateway = c.gateway || {};
     c.gateway.auth = { mode: "token", tokenFile: "secrets/gateway-token" };
     c.gateway.http = { ...(c.gateway.http || {}), chatCompletions: { enabled: true } };
     c.gateway.admin = { ...(c.gateway.admin || {}), tokenSha256: h };
     fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");'
   ```
   On Linux, use `sha256sum` in place of `shasum -a 256`. Don't add a `routing` section: onboarding (B2(a)) or the Console's guided setup (B2(b)) sets it.
4. **Check the route.** Run `mindstone doctor` and find the `routing.mode` line.
   - **Console-first install (B2(b)):** `placeholder` is expected. The Console's guided setup sets the route, so go on to B5.5. Console chat works once guided setup finishes.
   - **After `mindstone onboard` (B2(a)):** it should be `pi-session`. If it shows `placeholder`, onboarding didn't set a route: run `mindstone config --section routing` in a terminal, or finish setup in the Console instead. Without a route, Console chat fails.
5. **Let the Console's container reach the gateway.** The gateway listens on `127.0.0.1:19789`. The address and port it listens on come from environment variables, not from config (see "Using another port" in step B3).
   - **Docker Desktop (macOS):** it reaches the gateway as `host.docker.internal`, so nothing needs to change.
   - **Linux:** a container can't reach the host's loopback. Start the gateway bound to the Docker bridge address, and use the same variable on every restart:
     ```bash
     MINDSTONE_AGENT_GATEWAY_HOST=172.17.0.1 mindstone gateway restart
     ```
     Also set `gateway.host` to `172.17.0.1` in `config.json`. That doesn't move the listener, but `restart` and `status` use it for their health check, which otherwise reports `false`. Use that address in place of `127.0.0.1` in the checks. The macOS `gateway install` service always uses `127.0.0.1`.
6. **Restart the gateway** if you started it with `mindstone gateway start`: run `mindstone gateway restart`, with the variable from step B5 on Linux. If you used `gateway install`, skip this step. The gateway re-reads `config.json` on each request, and a `restart` would start a second process that can't get the port.

**Check:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat <checkout>/.runtime/mindstone/secrets/gateway-token)" http://127.0.0.1:19789/v1/models
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19789/v1/models
```

The first prints `200` and the second prints `401`.

**Don't:**
- put tokens in the repo, in chat or in logs;
- use the same value for the admin credential and the gateway token;
- use the upstream LibreChat compose files at the root of the Console repo. Use only its `mindstone/` folder.

## First run

The recommended first-run flow is:

```bash
mindstone onboard
```

Onboarding walks through:

- risk notice and runtime isolation;
- QuickStart vs manual setup;
- provider-first model/account setup;
- optional embedded OAuth login through isolated Pi auth;
- profile selection;
- collaboration preferences;
- memory/checkpoint preferences;
- initial identity/user scaffold creation.

You can reconfigure later without rerunning the full flow:

```bash
mindstone config
mindstone config --section routing
mindstone config --sections gateway,memory
```

Connect a provider account through MindStone’s isolated auth path:

```bash
mindstone auth login openai-codex
```

MindStone-Agent does not require or use your global Pi auth directory for its normal runtime. Credentials are stored under the project/runtime isolation path.

## Runtime isolation

MindStone-Agent keeps runtime state isolated from global Pi and from other MindStone-family agents.

Default local paths:

```text
.runtime/pi-agent      # isolated Pi agent config/auth/packages
.runtime/pi-sessions   # isolated Pi session files
.runtime/mindstone     # MindStone config, transcripts, memory, vectors, agents
```

Check the active isolation paths with:

```bash
mindstone status
./scripts/show-isolation.sh
```

For development, use the project wrapper instead of bare global Pi:

```bash
./scripts/pi-agent
```

## CLI commands

```bash
mindstone chat
mindstone chat --once "hello"
mindstone tui
mindstone status
mindstone doctor
mindstone onboard
mindstone config
mindstone auth login openai-codex
mindstone channels
mindstone identity activate
mindstone memory status
mindstone memory backfill --embed
mindstone memory maintain
mindstone persona list
mindstone persona activate <persona-id>
mindstone skill list
mindstone kb search <kb-id> "<query>"
mindstone packs list
mindstone packs install ./pack.mspack --sig ./pack.mspack.sig
mindstone channels
mindstone approvals list
```

The CLI is designed to avoid setup dead-ends. If `mindstone chat` or `mindstone tui` starts while routing is still unconfigured, it can launch model/routing setup in place.

## Native chat and TUI

Start a terminal chat over the canonical MindStone session:

```bash
mindstone chat
```

Send one turn and print the result:

```bash
mindstone chat --once "What do you remember about this project?"
```

Start the styled TUI:

```bash
mindstone tui
```

The TUI includes transcript history, live assistant updates, runner/substrate event lines, and read-only panels such as:

```text
/status
/config
/gateway
/pi
/transcript
/memory
/context
/doctor
/handoff
/identity
/events
/runs
/sessions
/agents
/models
```

## Gateway

MindStone-Agent includes a local Gateway for WebChat and API surfaces.

Manage it through the CLI:

```bash
mindstone gateway status
mindstone gateway start
mindstone gateway restart
mindstone gateway stop
mindstone gateway logs
mindstone gateway run
```

On macOS, user-service management is available through launchd:

```bash
mindstone gateway install
mindstone gateway uninstall
```

Default endpoint:

```text
http://127.0.0.1:19789
```

Health/status:

```bash
curl http://127.0.0.1:19789/health
curl http://127.0.0.1:19789/status
```

The Gateway supports:

```text
GET  /health
GET  /status
GET  /webchat
GET  /chat/sessions
GET  /chat/history
POST /chat/inject
POST /chat/send
POST /chat/abort
POST /rpc
WS   /rpc
WS   /ws
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
```

RPC method names:

```text
chat.sessions
chat.history
chat.inject
chat.send
chat.abort
```

`POST /v1/chat/completions` stores only the new turn: the trailing user messages. Clients such as LibreChat resend the whole conversation every turn and the gateway already has it. A request must end with a user message. Each Console conversation gets its own session, and all of them are indexed into memory (recall isn't per user yet: #71). Client system prompts are ignored for the Console's `user` role and kept once for an admin; see `docs/gateway/API_REFERENCE.md`.

Gateway authentication supports `none`, `token`, and `password`. `/health` remains unauthenticated for liveness checks; other endpoints enforce the configured auth mode.

See:

```text
docs/gateway/API_REFERENCE.md
docs/gateway/OPENWEBUI.md
```

## Built-in WebChat

The Gateway serves a thin built-in WebChat shell:

```text
http://127.0.0.1:19789/webchat
```

Leave the session key blank to use the canonical default:

```text
agent:default:main
```

WebChat is a native MindStone Gateway surface. It uses the same configured routing, identity context, memory recall, and append-only transcript path as CLI/TUI/Gateway calls.

## Sessions and transcripts

MindStone-Agent defaults to a single shared session:

```json
{
  "session": {
    "mode": "single",
    "defaultSessionKey": "agent:default:main"
  }
}
```

The legacy alias `mindstone` canonicalizes to `agent:default:main` for compatibility.

Supported surfaces append to the same canonical transcript by default while preserving source metadata, so the agent can maintain one continuity stream across CLI, TUI, Gateway, WebChat, OpenAI-compatible clients, and future channels.

## Memory and recall

MindStone-Agent initializes a MindStone-style memory substrate:

```text
LOG.md
memory/MEMORY.md
memory/
journals/
vectors/memory.sqlite
transcripts/
```

Useful commands:

```bash
mindstone memory status
mindstone memory backfill
mindstone memory backfill --embed
mindstone memory backfill --maintain --dedupe-text
mindstone memory maintain
mindstone memory maintain --dry-run
```

`memory backfill` indexes transcripts with their origin: surface, chat type, sender, audience, and the App Engine scope of the run each turn belongs to. A scoped run (its turn and reply) is recalled only by a run whose recall scope matches every part of it, never by the owner's own recall, and scope is applied before results are ranked. Turns that weren't the owner's (group, channel or thread messages, a missing chat type, an unverified sender, another sender's DM) and the entries after them up to the next turn are left out of the owner's memory. Older entries without the owner label count only if they are a DM from one of the connector's `ownerSenders`; older email never does. Each backfill removes transcript chunks an earlier one indexed that the rules now exclude, and prunes nothing if the transcript directory is missing. Run `mindstone memory backfill` once after upgrading. Set `memory.transcripts.includeNonOwner: true` to index non-owner turns anyway. After deleting every transcript on purpose, run `mindstone memory maintain` to drop their chunks (backfill doesn't prune from an empty transcript directory).

Memory features currently include:

- file-backed memory docs and journals;
- LOG and MEMORY index discovery;
- SQLite chunk indexing;
- OpenAI-compatible embedding provider interface;
- local Ollama default such as `ollama:nomic-embed-text`;
- embedding-backed recall with JS cosine fallback;
- lexical fallback when embeddings/vector support are unavailable;
- source-aware ranking and deduplication;
- status/doctor/TUI visibility;
- maintenance for stale/orphaned/duplicate/bloated index state.

Native sqlite-vec nearest-neighbor search is planned when the extension is available and packaged. Until then, MindStone-Agent reports the active backend as `sqlite-vec`, `js-cosine`, or `lexical` depending on local capability.

## Context management

MindStone-Agent separates live prompt management from authoritative history.

Default mode:

```json
{
  "contextManagement": {
    "mode": "sliding_window",
    "ceilingPercent": 92,
    "floorPercent": 70,
    "minRecentMessages": 24,
    "preserveTranscript": true
  }
}
```

Optional auto-compact mode:

```json
{
  "contextManagement": {
    "mode": "auto_compact",
    "checkpointWarningPercent": 85,
    "compactTargetPercent": 92,
    "keepRecentTokens": 20000,
    "emergencyAutoHandoff": false
  }
}
```

Sliding-window pruning affects the live prompt only. The append-only transcript remains the source of truth.

## Routing and models

Routing modes:

- `placeholder` — safe default; persists transcript entries and returns explicit setup/not-configured responses.
- `mock` — deterministic local responses for testing.
- `pi-session` — session-backed Pi `AgentSession` / `SessionManager` execution with isolated Pi auth/config.
- `pi` — lower-level Pi provider compatibility path.

Example mock routing:

```json
{
  "routing": {
    "mode": "mock",
    "defaultAgentId": "default",
    "defaultModel": "mindstone/mock",
    "mock": {
      "responsePrefix": "Mock response"
    }
  }
}
```

Example Pi-session routing:

```json
{
  "routing": {
    "mode": "pi-session",
    "defaultAgentId": "default",
    "defaultModel": "openai-codex/openai-codex/gpt-5.4-mini",
    "pi": {
      "agentDir": ".runtime/pi-agent"
    }
  }
}
```

Use the config/onboarding flow to choose provider → auth method → model rather than editing this by hand:

```bash
mindstone config --section routing
```

## Pi adapter

MindStone-Agent includes a Pi adapter package for Pi-side commands, tools, and lifecycle hooks.

Current Pi adapter command surface includes:

```text
/mindstone-setup
/mindstone-config
/mindstone-status
/mindstone-agent-status
/mindstone-context
/mindstone-gateway-status
/mindstone-channels
/mindstone-transcript-status
/mindstone-recall-status
/mindstone-recall-search <query> [--limit N]
```

Read-only tools include memory status/search/read and transcript status. Lifecycle hooks append conservative sanitized marker events; they do not persist raw private Pi summaries/details/messages.

## Personas, skills, knowledgebases, and workflows

MindStone-Agent loads a layer of reusable content artifacts that sit **below**
the core agent identity — an overlay never overrides `IDENTITY.md`/`USER.md`,
user boundaries, or safety rules.

- **Personas** — role/domain overlays that reference their own skills, workflows, and knowledgebases.
- **Skills** — a JSON definition plus a `SKILL.md` prompt document, with a draft → install approval path; the built-in **Integration Builder** is the first example.
- **Knowledgebases** — curated markdown sources with a deterministic, citation-preserving, extractive index and a dedicated search path.
- **Workflows** — a deterministic router that forces persona/skill/KB selection from conditions rather than model judgment, before inference.

```bash
mindstone persona list
mindstone persona activate <persona-id>

mindstone skill list
mindstone skill integration-builder \
  --name "Telegram incident notifier" \
  --kind channel \
  --goal "Send approved incident summaries to an allowlisted Telegram chat"

mindstone kb ingest <kb-id>
mindstone kb search <kb-id> "<query>"
```

See `docs/operations/PERSONAS.md`, `SKILLS.md`, `KNOWLEDGEBASES.md`, and `WORKFLOWS.md`.

## Content packs

A **content pack** is a signed, versioned bundle of the artifacts above
(personas, skills, knowledgebases, workflows) with an install lifecycle — a
**Persona Pack** is the common case. Packs are not a new runtime concept; they
bundle what the runtime already loads, then sign it and give it a lifecycle.

**Phase 1 (what ships today):** the local pack lifecycle only — no network
registry, auto-resolver, or Docker/agent packs yet.

```bash
mindstone packs build <sourceDir> --key "ed25519-priv:..." --out ./dist
mindstone packs inspect ./pack.mspack
mindstone packs install ./pack.mspack --sig ./pack.mspack.sig
mindstone packs list
mindstone packs verify
mindstone packs remove <id>
```

Packs are ed25519-signed `.mspack` archives verified against a shipped
publisher trust seed (a `mindstone/…`-signed pack installs trusted out of the
box; other publishers are added with `mindstone packs trust-add`). Install is
transactional and fail-closed: path-traversal entries are refused at
extraction, every prompt surface is enumerated and must match the manifest,
knowledgebase payloads are whitelisted, and a conflicting install rolls back
without clobbering user files. Unsigned packs install only through a two-act
escape hatch and are marked `trusted: false`.

Generate a signing keypair (writing the private key to a `chmod 600` file and
printing only the public key):

```bash
mindstone packs keygen --out ~/.mindstone/publisher.key
```

Authoring guide: `docs/operations/PACK_AUTHORING.md`. Design and rationale:
`docs/refactor/PACK_REGISTRY_DESIGN.md`.

## Channel connectors

A channel connector framework (v1) lets an agent send and receive over external
surfaces through one shared contract. It ships with a deterministic
**loopback** reference connector (a local file spool — no network), a persistent
delivery queue with retry and dead-letter, fail-closed allowlist/pairing, and
an **approval framework**: routed replies and fenced action proposals can be
diverted into a durable approval store before they leave the agent.

```bash
mindstone channels          # per-connector status without starting listeners
mindstone approvals list    # pending proposed actions
mindstone approvals approve <id>
```

Telegram, Slack, Discord, email, and calendar connectors are implemented
against the shared contract and smoke-tested **non-live**; live validation
against the real services is pending (see [Current status](#current-status)).
A Microsoft Teams connector is designed but not implemented (design #20; implementation tracked as #32).

See `docs/operations/CONNECTORS.md`, `EMAIL_CONNECTOR.md`, and
`CALENDAR_CONNECTOR.md`.

## Docker

### The whole stack

`deploy/docker/compose.yml` runs MindStone in Docker: the gateway, the MindStone Console and MongoDB. `install-stack.sh` downloads it, generates the secrets and starts it ([Install everything (Docker)](#install-everything-docker); the steps with checks are path A of the [install guide](#install-guide-for-ai-agents)).

| Service | What it is | Reached at |
|---|---|---|
| `gateway` | Built from this repo's `Dockerfile` at `MINDSTONE_REF` (the git URL, so no checkout is needed). Its entrypoint, `scripts/docker-gateway-entrypoint.sh`, runs `init-runtime.sh --if-no-config` on every start and merges the Console's settings into `config.json`: token auth, chat completions on and `gateway.admin.tokenSha256`, keeping everything else. It never touches `routing`. Then it runs the gateway in the foreground. | `127.0.0.1:${MINDSTONE_GATEWAY_PORT:-19789}` on the host, for the CLI and checks; `http://gateway:19789` from the Console |
| `console` | The MindStone Console, built from [mindstone-console](https://github.com/MindStone-Agent/mindstone-console) at `CONSOLE_REF`, with its `mindstone/librechat.yaml`. Sign-up from the page is off; the installer creates the admin. | `127.0.0.1:${CONSOLE_PORT:-3080}` |
| `mongodb` | `mongo:8.0.20`, the Console's database. | the stack's network only |
| `ollama` | Optional (Compose profile `ollama`, or `install-stack.sh --with-ollama`): Ollama in a container, for Linux or a machine without Ollama. Pull models with `docker compose exec ollama ollama pull <model>`, or let the Console download the embedding model. | the stack's network only |

What it keeps, and where (in the install folder, `~/.mindstone-stack` by default):
- **Secrets:** `gateway.env` (the gateway token and the admin credential's sha256) and `console.env` (the Console's secrets, the gateway token and the admin credential), both mode 600. The gateway's entrypoint writes the token to `secrets/gateway-token` (600) in its runtime and doesn't pass the variable on to the agent's processes.
- **Settings:** `.env` holds the refs, ports, project name and UID/GID, and no secrets. Compose reads it, so plain `docker compose` commands in the folder use the same settings, unless your shell exports `COMPOSE_*`, `OLLAMA_BASE_URL` or a port variable: an exported variable overrides `.env`, so unset it first.
- **Data:** the Docker volumes (the project is `mindstone-stack` unless `MINDSTONE_PROJECT` says otherwise) `<project>_gateway-runtime` (config, memory, transcripts), `<project>_pi-agent` and `<project>_pi-sessions` (Pi's isolated state), and `<project>_console-data`; the Console's database, uploads and logs are in `data/`.

Networks: the gateway, the Console and the optional Ollama share the `app` network; MongoDB is on an internal `db` network with the Console only, so the gateway and Ollama can't reach it.

Ollama: the gateway reaches Ollama on the host as `http://host.docker.internal:11434/v1` (`OLLAMA_BASE_URL` in `.env`, set with `--ollama-url`), for chat models and for memory embeddings. A server root such as `http://host:11434` is read as `http://host:11434/v1`.

Your changes go in `compose.override.yml` beside `compose.yml`: the installer includes it and never overwrites it.

Restarting the gateway from the Console works: the service declares `MINDSTONE_AGENT_SUPERVISOR=docker` and `restart: unless-stopped`, so the gateway exits with code 75 and Docker starts it again (`docs/operations/GATEWAY_RESTART.md`). The gateway's own port can't be changed from the Console's settings in this stack: it listens on 19789 inside the container, and `MINDSTONE_GATEWAY_PORT` moves the host port.

To build from local checkouts instead of the git URLs, set `MINDSTONE_BUILD_CONTEXT` and `CONSOLE_BUILD_CONTEXT` in `.env` to their paths.

### The Pi container

The root `docker-compose.yml` is a separate, interactive Pi container for development. Build and validate the isolated runtime:

```bash
docker compose build
docker compose run --rm mindstone-agent-pi --version
```

Run the Gateway inside the container:

```bash
docker compose run --rm --entrypoint ./scripts/start-gateway.sh mindstone-agent-pi
```

Docker uses MindStone-Agent-specific named volumes and must not mount host `~/.pi/agent`.

## Development and validation

Build MindStone packages:

```bash
npm run build:mindstone
```

Common smoke tests:

```bash
npm run smoke:mvp-native
npm run smoke:gateway-cli
npm run smoke:webchat-ui
npm run smoke:unified-session
npm run smoke:cli-chat
npm run smoke:cli-chat-recall
npm run smoke:tui
npm run smoke:doctor
npm run smoke:memory-backfill
npm run smoke:pi-session-runner
```

### Definition of done: the adversarial QA gate (canon)

Mandatory for critical outcomes — deploys, customer-facing changes,
migrations, security-adjacent code, and anything that alters a live agent's
recall/identity path (canon ruling 2026-07-07; full definition and evidence
chain: `mindstone-for-claude-code#62`, tracked here as #35):

1. Before critical work is declared done, an **independent agent context**
   (separate agent or subagent — on this repo, the Slate-as-QA protocol) runs
   adversarial verification with a **refute-don't-confirm** brief. Findings are
   ranked and CONFIRMED with file:line + a concrete failure scenario;
   "nothing real found" is a valid outcome.
2. Confirmed defects **block the ship**; residuals are ticketed.
3. The QA outcome is recorded in the ship receipt (commit / PR / issue
   comment) so it is auditable.
4. **Self-review does not satisfy the gate**, regardless of model tier — the
   author's context carries the reasoning that produced the bug.
5. The gate binds the orchestrator AND any subagent producing the work:
   include it verbatim in delegation prompts.

This formalizes what the wishlist-sprint QA protocol already practiced: the
builder never self-certifies. Pairs with the claim taxonomy above — nothing
advances past **smoke-tested** into a live substrate without the gate.

Port-binding smokes derive their listen ports from `MINDSTONE_SMOKE_PORT_BASE`
(default `19800`, which reproduces the historical fixed ports exactly). Two
lanes — e.g. a dev checkout and a pinned QA worktree — can run port smokes
concurrently by exporting different bases:

```bash
MINDSTONE_SMOKE_PORT_BASE=21800 npm run smoke:rpc
```

With distinct bases, port smokes no longer need to be serialized between
lanes; operations that touch the real `.runtime` still do. (`smoke:docker`
keeps fixed ports — they are container-internal and cannot collide on the
host.)

Live Pi-session validation is opt-in and uses isolated credentials only:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

Live compaction validation is a second opt-in step:

```bash
MINDSTONE_PI_SESSION_LIVE=1 \
MINDSTONE_PI_SESSION_LIVE_COMPACT=1 \
MINDSTONE_PI_SESSION_LIVE_MODEL='openai-codex/openai-codex/gpt-5.4-mini' \
  npm run smoke:pi-session-live
```

Do not run live validation unless you intentionally want to use configured model credentials.

## Documentation

Current operational docs:

- [Runtime Isolation Model](docs/operations/ISOLATION.md)
- [Local Models Setup](docs/operations/LOCAL_MODELS.md)
- [Gateway API Reference](docs/gateway/API_REFERENCE.md)
- [OpenWebUI Setup Prep](docs/gateway/OPENWEBUI.md)
- [Personas](docs/operations/PERSONAS.md) · [Skills](docs/operations/SKILLS.md) · [Knowledgebases](docs/operations/KNOWLEDGEBASES.md) · [Workflows](docs/operations/WORKFLOWS.md)
- [Pack Authoring Guide](docs/operations/PACK_AUTHORING.md)
- [Channel Connectors](docs/operations/CONNECTORS.md) · [Email](docs/operations/EMAIL_CONNECTOR.md) · [Calendar](docs/operations/CALENDAR_CONNECTOR.md) · [Teams (design)](docs/operations/TEAMS_CONNECTOR_DESIGN.md)
- [App Engine & Agent Mesh](docs/operations/APP_ENGINE.md)
- [Live UAT Runbook](docs/operations/LIVE_UAT_RUNBOOK.md)
- [Upstream Pi Strategy](docs/upstream/PI_BASE_STRATEGY.md)

Additional design and planning notes live under `docs/`.

## License

MindStone-Agent is **source-available** under the **Business Source License 1.1 (BSL 1.1)** — see [LICENSE](LICENSE).

In plain terms: you may use, modify, and self-host MindStone-Agent for free, including for internal and commercial purposes. You may **not** repackage, resell, redistribute for a fee, or offer it to third parties as a paid or hosted service without a separate commercial license. On the Change Date (2030-07-14), each released version converts to the Apache License 2.0.

For commercial or resale licensing, contact the Licensor, Clint Bodungen.

Vendored third-party components keep their own licenses — the bundled Pi base under `vendor/pi/` is MIT (© 2025 Mario Zechner).

---

Built by Clint Bodungen and the MindStone agents.
