# MindStone-Agent Runtime Directory

This directory is intentionally gitignored except for this note.

It stores project-local runtime state only:

- `pi-agent/` — isolated Pi settings/auth/packages/extensions
- `pi-sessions/` — isolated Pi sessions
- `mindstone/` — MindStone-Agent data, vectors, tokens, transcripts
- `env.local` — optional local credentials/env overrides

Do not copy files from `~/.pi/agent` into this directory unless you explicitly want to import that state.
