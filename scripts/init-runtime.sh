#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"

AGENT_DIR="${MINDSTONE_AGENT_DATA_DIR}/agents/default"
CONFIG_PATH="${MINDSTONE_AGENT_CONFIG:-${MINDSTONE_AGENT_DATA_DIR}/config.json}"

mkdir -p "${AGENT_DIR}" "$(dirname "${CONFIG_PATH}")" "${MINDSTONE_AGENT_MEMORY_DIR}" "${MINDSTONE_AGENT_JOURNAL_DIR}" "$(dirname "${MINDSTONE_AGENT_LOG_PATH}")" "$(dirname "${MINDSTONE_AGENT_MEMORY_INDEX_PATH}")"

if [[ ! -f "${AGENT_DIR}/IDENTITY.md" ]]; then
  cat >"${AGENT_DIR}/IDENTITY.md" <<'EOF'
# Default MindStone Agent

This is a placeholder identity for a newly initialized MindStone-Agent runtime.
Replace it during onboarding with the agent's real identity.
EOF
fi

if [[ ! -f "${AGENT_DIR}/USER.md" ]]; then
  cat >"${AGENT_DIR}/USER.md" <<'EOF'
# User Context

This is placeholder user context for a newly initialized MindStone-Agent runtime.
Replace it during onboarding with approved user/project context.
EOF
fi

if [[ ! -f "${MINDSTONE_AGENT_LOG_PATH}" ]]; then
  cat >"${MINDSTONE_AGENT_LOG_PATH}" <<'EOF'
# MindStone LOG

Append checkpoint/session ledger entries here. This is the operational continuity log, not the full memory store.
EOF
fi

if [[ ! -f "${MINDSTONE_AGENT_MEMORY_INDEX_PATH}" ]]; then
  cat >"${MINDSTONE_AGENT_MEMORY_INDEX_PATH}" <<'EOF'
---
name: MEMORY
description: Index of structured MindStone memory files.
type: index
tags: [memory, index]
projects: []
hits: 0
prevented: 0
last_applied: null
created: 2026-06-17
half_life_days: 30
critical: false
evergreen: true
---

# Memory Index

Structured durable memory files live beside this index. Use journals for narrative/experiential continuity and structured memory files for durable facts, decisions, preferences, cases, detections, and references.

## Memory Files

Add entries as memory files are created.
EOF
fi

if [[ ! -f "${MINDSTONE_AGENT_JOURNAL_DIR}/README.md" ]]; then
  cat >"${MINDSTONE_AGENT_JOURNAL_DIR}/README.md" <<'EOF'
# Journals

Narrative/dream-cycle journals live here. They preserve experiential texture and should be vectorized, but they are not the same as structured durable memory files.
EOF
fi

if [[ ! -f "${CONFIG_PATH}" ]]; then
  cat >"${CONFIG_PATH}" <<'EOF'
{
  "workspace": {
    "root": "."
  },
  "gateway": {
    "host": "127.0.0.1",
    "port": 19789,
    "auth": {
      "mode": "none"
    },
    "http": {
      "chatCompletions": {
        "enabled": false
      },
      "responses": {
        "enabled": false
      }
    }
  },
  "agents": {
    "default": {
      "id": "default",
      "identityPath": "agents/default/IDENTITY.md",
      "userPath": "agents/default/USER.md",
      "defaultModel": "mindstone/default",
      "contextWindowTokens": 128000
    }
  },
  "memory": {
    "autoRecall": false,
    "vectorStore": "sqlite-vec",
    "files": {
      "enabled": true,
      "memoryDir": "memory",
      "journalsDir": "journals",
      "logPath": "LOG.md",
      "indexPath": "memory/MEMORY.md",
      "includeMemoryFiles": true,
      "includeJournals": true,
      "includeLog": true
    }
  },
  "session": {
    "mode": "single",
    "defaultSessionKey": "mindstone"
  },
  "routing": {
    "mode": "placeholder",
    "defaultAgentId": "default",
    "defaultModel": "mindstone/default"
  },
  "contextManagement": {
    "mode": "sliding_window",
    "ceilingPercent": 92,
    "floorPercent": 70,
    "minRecentMessages": 24,
    "preserveTranscript": true
  }
}
EOF
fi

cat <<MSG
Initialized MindStone-Agent runtime if missing.

Config:       ${CONFIG_PATH}
Identity:     ${AGENT_DIR}/IDENTITY.md
User:         ${AGENT_DIR}/USER.md
LOG:          ${MINDSTONE_AGENT_LOG_PATH}
Memory index: ${MINDSTONE_AGENT_MEMORY_INDEX_PATH}
Journals:     ${MINDSTONE_AGENT_JOURNAL_DIR}
MSG
