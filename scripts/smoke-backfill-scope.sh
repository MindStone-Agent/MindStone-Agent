#!/usr/bin/env bash
set -euo pipefail

# Transcript backfill scope smoke (issue #62). No gateway, no ports:
#   1. a tenant's App Engine run (user turn and reply) is recalled only at that
#      tenant's exact scope: not by another tenant, not in companion mode
#   2. a non-owner channel turn and the reply to it never reach the owner's
#      recall; the owner's own DM still does (control)
#   3. an older backfill that indexed non-owner text is cleaned up by the next
#      one (pruned), and includeNonOwner opts back in
#   4. legacy entries with no ownerTurn label fall back to the chat type
# Synthetic sentinels only.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-backfill-scope-smoke.XXXXXX")"
trap 'rm -rf "${TEMP_RUNTIME}"' EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"

cd "${PROJECT_ROOT}"
echo "== Transcript backfill scope smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh >/tmp/mindstone-agent-backfill-scope-init.log

MINDSTONE_AGENT_ROOT="${PROJECT_ROOT}" npx tsx <<'TS'
import assert from "node:assert/strict";
import {
  appendTranscriptEntry,
  backfillSqliteMemoryIndex,
  createSqliteMemoryRecallProvider,
  recallMindStoneMemory,
  runtimePathsFromEnv,
} from "./packages/mindstone-core/src/index.ts";

const paths = runtimePathsFromEnv();
const agentId = "default";
const say = (sessionKey: string, role: "user" | "assistant", text: string, source: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
  appendTranscriptEntry({ sessionKey, agentId, role, text, source: source as never, metadata }, { paths });

// Owner DM (control).
const dmSource = { substrate: "connector:loopback", channel: "dm-clint", chatType: "direct", senderId: "clint" };
say("agent:default:main", "user", "The kestrel ledger code is OWNER-KESTREL.", dmSource, { ownerTurn: true });
say("agent:default:main", "assistant", "Noted the kestrel ledger code.", dmSource);

// Non-owner channel turn and the reply to it.
const groupSource = { substrate: "connector:loopback", channel: "ops", chatType: "group", senderId: "mallory" };
say("agent:default:loopback:ops:group:ops", "user", "The kestrel ledger code is GROUP-KESTREL.", groupSource, { ownerTurn: false });
say("agent:default:loopback:ops:group:ops", "assistant", "Echo kestrel REPLY-KESTREL.", groupSource);

// Legacy entries in the main session (before #61): no ownerTurn label.
say("agent:default:main", "user", "Legacy kestrel note LEGACY-GROUP-KESTREL.", { ...groupSource, channel: "ops-old" });
say("agent:default:main", "assistant", "Legacy reply LEGACY-REPLY-KESTREL.", { ...groupSource, channel: "ops-old" });
say("agent:default:main", "user", "Owner again about the kestrel ledger OWNER-KESTREL-2.", dmSource);

// Two App Engine tenants.
const appSource = { substrate: "gateway-app-engine", channel: "api", chatType: "internal" };
const tenantA = { tenantId: "tenant-a", appId: "app-1" };
const tenantB = { tenantId: "tenant-b", appId: "app-1" };
say("agent:default:app:tenant-a", "user", "Tenant kestrel secret TENANT-A-KESTREL.", appSource, { appEngine: true, scope: tenantA });
say("agent:default:app:tenant-a", "assistant", "Tenant A reply kestrel TENANT-A-REPLY.", appSource);
say("agent:default:app:tenant-b", "user", "Tenant kestrel note TENANT-B-KESTREL.", appSource, { appEngine: true, scope: tenantB });

const recall = async (scope?: Record<string, string>) => {
  const provider = createSqliteMemoryRecallProvider({ paths });
  assert.ok(provider, "sqlite memory database missing after backfill");
  const result = await recallMindStoneMemory({
    agentId,
    provider,
    config: { maxResults: 40, maxPromptTokens: 8000, minScore: 0.01 },
    entries: [{ id: "q", sessionKey: "q", agentId, role: "user", text: "kestrel ledger code tenant reply", timestamp: new Date().toISOString() } as never],
    ...(scope ? { scope } : {}),
  });
  return (result?.hits ?? []).map((hit) => hit.text).join("\n");
};
const absent = (text: string, sentinels: string[], label: string) => {
  for (const sentinel of sentinels) assert.ok(!text.includes(sentinel), `${label}: ${sentinel} must not be recalled:\n${text}`);
};

// 3a. An old, unscoped, unfiltered index (as before the fix) holds everything.
const before = backfillSqliteMemoryIndex({ paths, config: { memory: { transcripts: { includeNonOwner: true } } } });
assert.ok(before.transcriptDocuments >= 10);
assert.ok((await recall()).includes("GROUP-KESTREL"), "control: includeNonOwner indexes non-owner turns");

// Default backfill: non-owner documents pruned.
const after = backfillSqliteMemoryIndex({ paths });
assert.ok(after.transcriptSourcesPruned >= 4, `expected the non-owner sources to be pruned, got ${after.transcriptSourcesPruned}`);

const owner = await recall();
for (const sentinel of ["OWNER-KESTREL", "OWNER-KESTREL-2"]) assert.ok(owner.includes(sentinel), `control: owner recall is missing ${sentinel}:\n${owner}`);
absent(owner, ["GROUP-KESTREL", "REPLY-KESTREL", "LEGACY-GROUP-KESTREL", "LEGACY-REPLY-KESTREL"], "owner recall");
absent(owner, ["TENANT-A-KESTREL", "TENANT-A-REPLY", "TENANT-B-KESTREL"], "companion-mode recall");

const a = await recall(tenantA);
assert.ok(a.includes("TENANT-A-KESTREL") && a.includes("TENANT-A-REPLY"), `tenant A must recall its own run, reply included:\n${a}`);
absent(a, ["TENANT-B-KESTREL", "GROUP-KESTREL"], "tenant A recall");
const b = await recall(tenantB);
absent(b, ["TENANT-A-KESTREL", "TENANT-A-REPLY"], "tenant B recall");
assert.ok(b.includes("TENANT-B-KESTREL"));

// A rerun is stable: nothing more to prune.
assert.equal(backfillSqliteMemoryIndex({ paths }).transcriptSourcesPruned, 0);
console.log("backfill scope assertions passed");
TS

echo "Transcript backfill scope smoke test passed."
