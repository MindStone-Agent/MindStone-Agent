#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/env.sh"

"${SCRIPT_DIR}/build-pi-base.sh"

# A first install gets a runtime config with safe defaults: not onboarded,
# routing.mode "placeholder", gateway on 127.0.0.1:19789 with auth "none". Setup
# can then finish in a terminal (mindstone onboard) or in the web Console. An
# existing config.json is never touched (#108).
"${SCRIPT_DIR}/init-runtime.sh" --if-no-config

cat <<MSG
MindStone-Agent native foundation installed.

Isolated Pi agent dir:     ${PI_CODING_AGENT_DIR}
Isolated Pi session dir:   ${PI_CODING_AGENT_SESSION_DIR}
MindStone-Agent data dir:  ${MINDSTONE_AGENT_DATA_DIR}

Run MindStone-Agent with:
  mindstone status
  mindstone onboard     (or set it up in the web Console instead)
  mindstone config

If the bare 'mindstone' command is not on PATH yet, link it intentionally with:
  npm run link:cli

Connect subscription/OAuth model accounts through MindStone:
  mindstone auth login openai-codex

Do not run bare 'pi' for this project.
MSG
