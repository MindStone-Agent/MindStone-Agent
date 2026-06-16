# MindStone-Agent Isolation Model

**Project:** MindStone-Agent  
**Date:** 2026-06-16  
**Status:** Initial operational rule

## Goal

MindStone-Agent must not share runtime state with Clint's normal Pi install, Slate/MS4PI, or any other account-level Pi state.

Do not run bare `pi` for this project. Use the project wrapper:

```bash
./scripts/pi-agent
```

## Native isolation paths

The wrapper exports:

```bash
PI_CODING_AGENT_DIR="$PROJECT_ROOT/.runtime/pi-agent"
PI_CODING_AGENT_SESSION_DIR="$PROJECT_ROOT/.runtime/pi-sessions"
PI_PACKAGE_DIR="$PROJECT_ROOT/vendor/pi/packages/coding-agent"
MINDSTONE_AGENT_GATEWAY_HOST="127.0.0.1"
MINDSTONE_AGENT_GATEWAY_PORT="19789"
```

Port `19789` is intentionally separate from common existing MindStone/Pi gateway defaults such as `18789`.

This means MindStone-Agent does **not** use:

```text
~/.pi/agent/settings.json
~/.pi/agent/auth.json
~/.pi/agent/models.json
~/.pi/agent/extensions/
~/.pi/agent/npm/
~/.pi/agent/git/
~/.pi/agent/sessions/
```

Instead it uses:

```text
.runtime/
  pi-agent/
    settings.json
    auth.json
    models.json
    extensions/
    npm/
    git/
    trust.json
  pi-sessions/
  mindstone/
    tokens/
    vectors/
    transcripts/
```

## Environment credentials

Filesystem isolation does not automatically isolate inherited environment variables. To reduce accidental credential sharing, `scripts/env.sh` unsets common provider credential variables unless this is explicitly set:

```bash
export MSA_ALLOW_HOST_PROVIDER_ENV=1
```

Preferred project-local credentials file:

```text
.runtime/env.local
```

Example:

```bash
export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."
```

`.runtime/` is gitignored.

## Docker isolation

Docker must use MindStone-Agent-specific named volumes. Do not mount host `~/.pi/agent`.

Recommended volumes:

```text
mindstone-agent-pi-agent-state:/home/node/.pi/agent
mindstone-agent-pi-session-state:/home/node/.pi-sessions
mindstone-agent-runtime-state:/home/node/.mindstone-agent
```

The MindStone-Agent data volume is mounted under the `node` user's home directory so the non-root container process can create runtime, token, vector, and transcript directories without host/global state. The image pre-creates and chowns all three mountpoints before switching to the non-root `node` user.

Mounting host `~/.pi/agent` into a container would expose host auth, settings, sessions, and extensions to the container. Do not do that.

Verified Docker smoke checks:

```bash
docker compose build
docker compose run --rm mindstone-agent-pi --version
docker compose run --rm --entrypoint bash mindstone-agent-pi -lc './scripts/start-gateway.sh >/tmp/gateway.log 2>&1 & pid=$!; sleep 1; node -e "const r=await fetch(\"http://127.0.0.1:19789/health\"); if(!r.ok) process.exit(1); console.log(await r.text())"; kill $pid'
```

The Pi adapter package can be registered and discovered inside Docker with:

```bash
docker compose run --rm mindstone-agent-pi install ./packages/mindstone-pi-adapter
docker compose run --rm --entrypoint bash mindstone-agent-pi -lc 'printf "%s\n" "{\"id\":\"1\",\"type\":\"get_commands\"}" | ./scripts/pi-agent --mode rpc --no-session --no-context-files'
```

## Package isolation

Do not use global `pi install` for MindStone-Agent packages.

Use project-local package settings under `.runtime/pi-agent` or project `.pi/` only when intentionally testing project-package behavior. The normal development path uses the vendored Pi base in:

```text
vendor/pi
```

## Update isolation

Upstream Pi updates are performed with git subtree:

```bash
git subtree pull --prefix vendor/pi https://github.com/earendil-works/pi main --squash
```

This updates source under `vendor/pi`; it does not mutate the global Pi installation.

## Operational rule

If a command would touch `~/.pi/agent`, `~/.synapse`, global npm, global pnpm, global gh auth, or any shared credential store, stop and get explicit approval before running it.
