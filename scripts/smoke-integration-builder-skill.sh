#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npx tsx <<'TS'
import { buildIntegrationBuilderBrief, formatIntegrationBuilderSkillMarkdown, INTEGRATION_BUILDER_SKILL } from "./packages/mindstone-core/src/index.ts";

const brief = buildIntegrationBuilderBrief({
  name: "Telegram channel adapter",
  kind: "channel",
  goal: "Plan a safe Telegram Gateway channel adapter before live bot token use.",
  auth: "Telegram bot token from env only",
  surface: "Gateway channel plugin",
  constraints: ["No raw token persistence", "Canonical transcript continuity"],
});
if (INTEGRATION_BUILDER_SKILL.id !== "integration-builder") throw new Error("Skill id mismatch");
if (!brief.markdown.includes("Telegram channel adapter")) throw new Error("Brief name missing");
if (!brief.markdown.includes("Gateway channel plugin")) throw new Error("Runtime surface missing");
if (!brief.markdown.includes("Credential handling is explicit")) throw new Error("Credential gate missing");
if (!brief.markdown.includes("Transcript source metadata preserves")) throw new Error("Channel transcript gate missing");
if (!brief.markdown.includes("Immediate questions")) throw new Error("Questions section missing");
if (brief.safetyGates.length < 5) throw new Error("Expected channel-specific safety gates");

const skillMd = formatIntegrationBuilderSkillMarkdown();
if (!skillMd.startsWith("---\nname: integration-builder")) throw new Error("Skill markdown frontmatter missing");
if (!skillMd.includes("Gateway owns long-running channel listeners")) throw new Error("MindStone channel constraint missing");
if (!skillMd.includes("Required output shape")) throw new Error("Output shape missing");

console.log("integration builder core smoke passed");
TS

if [[ -f "$ROOT/packages/mindstone-cli/dist/index.js" ]]; then
  LIST_OUTPUT="$(node "$ROOT/packages/mindstone-cli/dist/index.js" skill list)"
  if ! grep -q "integration-builder" <<<"$LIST_OUTPUT"; then
    echo "skill list did not include integration-builder" >&2
    echo "$LIST_OUTPUT" >&2
    exit 1
  fi

  BRIEF_OUTPUT="$(node "$ROOT/packages/mindstone-cli/dist/index.js" skill integration-builder --name "Webhook Intake" --kind webhook --goal "Design signed webhook intake" --auth "HMAC signature" --constraint "Reject replay attacks")"
  if ! grep -q "Webhook Intake" <<<"$BRIEF_OUTPUT" || ! grep -q "Webhook endpoints fail closed" <<<"$BRIEF_OUTPUT" || ! grep -q "Reject replay attacks" <<<"$BRIEF_OUTPUT"; then
    echo "integration-builder CLI brief missing expected content" >&2
    echo "$BRIEF_OUTPUT" >&2
    exit 1
  fi

  JSON_OUTPUT="$(node "$ROOT/packages/mindstone-cli/dist/index.js" skill integration-builder --name "API Client" --kind api --json)"
  JSON_PAYLOAD="$JSON_OUTPUT" node <<'NODE'
const payload = JSON.parse(process.env.JSON_PAYLOAD);
if (payload.skill.id !== 'integration-builder') throw new Error('JSON skill id missing');
if (payload.kind !== 'api') throw new Error('JSON kind mismatch');
if (!payload.markdown.includes('API Client')) throw new Error('JSON markdown missing name');
NODE

  SKILL_MD="$(node "$ROOT/packages/mindstone-cli/dist/index.js" skill integration-builder --emit-skill-md)"
  if ! grep -q "name: integration-builder" <<<"$SKILL_MD"; then
    echo "skill markdown emitter missing frontmatter" >&2
    echo "$SKILL_MD" >&2
    exit 1
  fi
  if ! grep -q "Required output shape" <<<"$SKILL_MD"; then
    echo "skill markdown emitter missing required output shape" >&2
    echo "$SKILL_MD" >&2
    exit 1
  fi
else
  echo "CLI dist not built; skipped CLI integration-builder skill smoke path"
fi

echo "integration builder skill smoke passed"
