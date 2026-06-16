#!/usr/bin/env bash
# Shared environment for MindStone-Agent native/dev commands.
# Source this file from wrapper scripts; do not run bare `pi` for this project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MINDSTONE_AGENT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export MINDSTONE_AGENT_RUNTIME_DIR="${MINDSTONE_AGENT_RUNTIME_DIR:-${MINDSTONE_AGENT_ROOT}/.runtime}"

# Hard isolation from the user's normal ~/.pi/agent install.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-${MINDSTONE_AGENT_RUNTIME_DIR}/pi-agent}"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-${MINDSTONE_AGENT_RUNTIME_DIR}/pi-sessions}"
export PI_PACKAGE_DIR="${PI_PACKAGE_DIR:-${MINDSTONE_AGENT_ROOT}/vendor/pi/packages/coding-agent}"

# Keep Pi startup deterministic unless explicitly overridden.
export PI_SKIP_VERSION_CHECK="${PI_SKIP_VERSION_CHECK:-1}"
export PI_OFFLINE="${PI_OFFLINE:-1}"

# MindStone-Agent-owned runtime state.
export MINDSTONE_AGENT_DATA_DIR="${MINDSTONE_AGENT_DATA_DIR:-${MINDSTONE_AGENT_RUNTIME_DIR}/mindstone}"
export MINDSTONE_AGENT_TOKEN_DIR="${MINDSTONE_AGENT_TOKEN_DIR:-${MINDSTONE_AGENT_DATA_DIR}/tokens}"
export MINDSTONE_AGENT_VECTOR_DIR="${MINDSTONE_AGENT_VECTOR_DIR:-${MINDSTONE_AGENT_DATA_DIR}/vectors}"
export MINDSTONE_AGENT_TRANSCRIPT_DIR="${MINDSTONE_AGENT_TRANSCRIPT_DIR:-${MINDSTONE_AGENT_DATA_DIR}/transcripts}"
export MINDSTONE_AGENT_GATEWAY_HOST="${MINDSTONE_AGENT_GATEWAY_HOST:-127.0.0.1}"
export MINDSTONE_AGENT_GATEWAY_PORT="${MINDSTONE_AGENT_GATEWAY_PORT:-19789}"

mkdir -p \
  "${PI_CODING_AGENT_DIR}" \
  "${PI_CODING_AGENT_SESSION_DIR}" \
  "${MINDSTONE_AGENT_TOKEN_DIR}" \
  "${MINDSTONE_AGENT_VECTOR_DIR}" \
  "${MINDSTONE_AGENT_TRANSCRIPT_DIR}"

# Avoid accidentally reusing host/account provider credentials. Put project-local
# credentials in .runtime/env.local, or set MSA_ALLOW_HOST_PROVIDER_ENV=1.
if [[ "${MSA_ALLOW_HOST_PROVIDER_ENV:-0}" != "1" ]]; then
  unset ANTHROPIC_API_KEY || true
  unset OPENAI_API_KEY || true
  unset AZURE_OPENAI_API_KEY || true
  unset AZURE_OPENAI_BASE_URL || true
  unset GEMINI_API_KEY || true
  unset GOOGLE_API_KEY || true
  unset OPENROUTER_API_KEY || true
  unset GROQ_API_KEY || true
  unset XAI_API_KEY || true
  unset TOGETHER_API_KEY || true
  unset FIREWORKS_API_KEY || true
  unset MISTRAL_API_KEY || true
  unset CEREBRAS_API_KEY || true
  unset DEEPSEEK_API_KEY || true
  unset NVIDIA_API_KEY || true
  unset AWS_PROFILE || true
  unset AWS_ACCESS_KEY_ID || true
  unset AWS_SECRET_ACCESS_KEY || true
  unset AWS_BEARER_TOKEN_BEDROCK || true
fi

if [[ -f "${MINDSTONE_AGENT_RUNTIME_DIR}/env.local" ]]; then
  # shellcheck disable=SC1091
  source "${MINDSTONE_AGENT_RUNTIME_DIR}/env.local"
fi
