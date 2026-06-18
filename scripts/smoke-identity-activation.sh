#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CONFIG="$TMP_DIR/config.json"

cd "$ROOT"
MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CONFIG" npx tsx <<'TS'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { synthesizeMindStoneIdentityActivation } from "./packages/mindstone-core/src/index.ts";

const configPath = process.env.MINDSTONE_AGENT_CONFIG!;
const runtime = dirname(configPath);
mkdirSync(resolve(runtime, "agents/default"), { recursive: true });
writeFileSync(configPath, JSON.stringify({
  workspace: { root: "." },
  routing: { mode: "placeholder", defaultAgentId: "default" },
  onboarding: {
    profile: {
      id: "integration_builder",
      label: "Integration Builder",
      description: "Connector builder for APIs and channel bridges."
    },
    preferences: {
      interactionDetail: "detailed",
      recommendationStyle: "options_tradeoffs",
      workStyle: "plan_first",
      approvalMode: "strict",
      approvalNotes: "Ask before network-exposed integration changes.",
      memoryStyle: "propose_checkpoint_memories",
      projectContext: "Build integrations and channel adapters safely.",
      sensitiveContext: "Credentials and pairing tokens are sensitive.",
      selectedAt: "2026-06-18T00:00:00.000Z"
    },
    identity: {
      mode: "seed",
      candidateName: "Bridgewright",
      identityDirection: "A careful integration-building MindStone agent.",
      namingNotes: "Prefer grounded names.",
      selectedAt: "2026-06-18T00:00:00.000Z"
    }
  },
  agents: {
    default: {
      id: "default",
      identityPath: "agents/default/IDENTITY.md",
      userPath: "agents/default/USER.md",
      profileId: "integration_builder"
    }
  }
}, null, 2));
writeFileSync(resolve(runtime, "agents/default/IDENTITY.md"), `# MindStone Agent Identity Pending\n\nThis identity scaffold was created by \`mindstone onboard\`. First activation should replace it.\n`);
writeFileSync(resolve(runtime, "agents/default/USER.md"), `# User Context\n\nInitial integration-builder user context.\n`);

const dry = synthesizeMindStoneIdentityActivation({ configPath, dryRun: true, now: "2026-06-18T12:00:00.000Z" });
if (dry.wrote) throw new Error("Dry run wrote identity");
if (!dry.wouldWrite) throw new Error("Dry run did not report wouldWrite");
if (dry.name !== "Bridgewright") throw new Error(`Unexpected synthesized name: ${dry.name}`);
if (!dry.identityMarkdown.includes("# Bridgewright")) throw new Error("Dry-run identity missing synthesized title");
if (!dry.identityMarkdown.includes("Profile: Integration Builder")) throw new Error("Profile seed missing");
if (!dry.identityMarkdown.includes("Sensitive context: configured in USER.md")) throw new Error("Sensitive context safety line missing");

const result = synthesizeMindStoneIdentityActivation({ configPath, now: "2026-06-18T12:00:00.000Z" });
if (!result.wrote) throw new Error("Activation did not write identity");
if (!result.backupPath || !existsSync(result.backupPath)) throw new Error("Pending identity backup was not written");
const identity = readFileSync(resolve(runtime, "agents/default/IDENTITY.md"), "utf-8");
if (!identity.includes("# Bridgewright")) throw new Error("Activated identity title missing");
if (!identity.includes("mindstone identity activate")) throw new Error("Activation provenance missing");
if (!identity.includes("Prior identity state: pending scaffold")) throw new Error("Prior state missing");
if (!identity.includes("Ask before destructive filesystem")) throw new Error("Operating boundary missing");

const skipped = synthesizeMindStoneIdentityActivation({ configPath, now: "2026-06-18T12:01:00.000Z" });
if (skipped.wrote) throw new Error("Second activation overwrote non-pending identity without force");
if (skipped.reason !== "identity_not_pending") throw new Error(`Unexpected second activation reason: ${skipped.reason}`);

console.log(`identity activation core smoke passed: ${configPath}`);
TS

CLI_CONFIG="$TMP_DIR/cli-config.json"
CLI_RUNTIME="$(dirname "$CLI_CONFIG")"
mkdir -p "$CLI_RUNTIME/agents/default"
cat > "$CLI_CONFIG" <<'JSON'
{
  "routing": { "mode": "placeholder", "defaultAgentId": "default" },
  "onboarding": {
    "profile": { "id": "research_analyst", "label": "Research Analyst" },
    "preferences": { "interactionDetail": "balanced", "recommendationStyle": "direct", "workStyle": "act_directly", "approvalMode": "standard", "memoryStyle": "minimal" },
    "identity": { "mode": "defer" }
  },
  "agents": {
    "default": { "id": "default", "identityPath": "agents/default/IDENTITY.md", "userPath": "agents/default/USER.md" }
  }
}
JSON
cat > "$CLI_RUNTIME/agents/default/IDENTITY.md" <<'MD'
# MindStone Agent Identity Pending

This identity scaffold was created by `mindstone onboard`. First activation should replace it.
MD
cat > "$CLI_RUNTIME/agents/default/USER.md" <<'MD'
# User Context

Research smoke context.
MD

if [[ -f "$ROOT/packages/mindstone-cli/dist/index.js" ]]; then
  OUTPUT="$(MINDSTONE_AGENT_ROOT="$ROOT" MINDSTONE_AGENT_CONFIG="$CLI_CONFIG" node "$ROOT/packages/mindstone-cli/dist/index.js" identity activate --yes)"
  if ! grep -q "Identity activated" <<<"$OUTPUT" || ! grep -q "MindStone Research Analyst" <<<"$OUTPUT"; then
    echo "CLI identity activation output missing expected content" >&2
    echo "$OUTPUT" >&2
    exit 1
  fi
  if ! grep -q "# MindStone Research Analyst" "$CLI_RUNTIME/agents/default/IDENTITY.md"; then
    echo "CLI identity activation did not write synthesized identity" >&2
    exit 1
  fi
else
  echo "CLI dist not built; skipped CLI identity activation smoke path"
fi

echo "identity activation smoke passed"
