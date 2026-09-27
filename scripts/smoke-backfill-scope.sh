#!/usr/bin/env bash
set -euo pipefail

# Transcript backfill scope smoke (issue #62). No gateway, no ports:
#   1. a tenant's App Engine run (user turn and reply) is recalled only at that
#      tenant's exact scope: not by another tenant, not in companion mode
#   2. one scoped App Engine run inside the owner's main session does not
#      relabel the owner's other entries there
#   3. a non-owner channel turn and everything after it up to the next user
#      turn (reply, events) never reach the owner's recall; the owner's own DM
#      still does (control); ownerTurn:false wins over a direct chat type
#   4. legacy entries with no ownerTurn: a DM from an ownerSenders id counts,
#      another sender's DM doesn't, and email never does
#   5. an older index without the new labels is cleaned up by the next backfill;
#      pruning touches only transcript ids and never runs without the
#      transcript directory
#   6. scope is applied before ranking: a flood of one tenant's chunks can't
#      push the owner's own out of recall
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
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  appendTranscriptEntry,
  backfillSqliteMemoryIndex,
  createSqliteMemoryRecallProvider,
  recallMindStoneMemory,
  runtimePathsFromEnv,
  sqliteMemoryDatabasePath,
} from "./packages/mindstone-core/src/index.ts";

const paths = runtimePathsFromEnv();
const agentId = "default";
const config = { channels: { loopback: { ownerSenders: ["clint"] }, email: { ownerSenders: ["clint@example.com"] } } };
const say = (sessionKey: string, role: "user" | "assistant" | "event", text: string, source: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
  appendTranscriptEntry({ sessionKey, agentId, role, text, source: source as never, metadata }, { paths });

const dm = { substrate: "connector:loopback", channel: "dm-clint", chatType: "direct", senderId: "clint" };
const group = { substrate: "connector:loopback", channel: "ops", chatType: "group", senderId: "mallory" };
const app = { substrate: "gateway-app-engine", channel: "api", chatType: "internal" };
const tenantA = { tenantId: "tenant-a", appId: "app-1" };
const tenantB = { tenantId: "tenant-b", appId: "app-1" };
const MAIN = "agent:default:main";

// Owner DMs (control), labelled and legacy.
say(MAIN, "user", "The kestrel ledger code is OWNER-KESTREL.", dm, { ownerTurn: true });
say(MAIN, "assistant", "Noted the kestrel ledger code OWNER-REPLY-KESTREL.", dm);
say(MAIN, "user", "Legacy owner kestrel note LEGACY-OWNER-KESTREL.", dm);

// 2. An App Engine run written into the main session (no app, tenant or user).
say(MAIN, "user", "App kestrel run APP-IN-MAIN-KESTREL.", app, { appEngine: true, scope: { agentId: "default" } });
say(MAIN, "assistant", "App reply kestrel APP-IN-MAIN-REPLY.", app);
say(MAIN, "user", "Owner again about the kestrel ledger OWNER-AFTER-APP-KESTREL.", dm, { ownerTurn: true });

// 3. Non-owner turns: labelled group, labelled non-owner direct, and events after them.
say("agent:default:loopback:ops:group:ops", "user", "The kestrel ledger code is GROUP-KESTREL.", group, { ownerTurn: false });
say("agent:default:loopback:ops:group:ops", "assistant", "Echo kestrel ECHOGRP-KESTREL.", group);
say("agent:default:loopback:ops:group:ops", "event", "Tool kestrel EVENT-KESTREL.", group);
say(MAIN, "user", "Unverified kestrel DIRECT-UNVERIFIED-KESTREL.", dm, { ownerTurn: false });
say(MAIN, "event", "Kestrel event after it EVENT-AFTER-UNVERIFIED.", dm);

// 4. Legacy (no ownerTurn): another sender's DM, a legacy group turn, legacy email.
say(MAIN, "user", "Legacy kestrel from alice LEGACY-ALICE-KESTREL.", { ...dm, channel: "dm-alice", senderId: "alice" });
say(MAIN, "assistant", "Legacy reply to alice LEGACY-ALICE-REPLY.", { ...dm, channel: "dm-alice", senderId: "alice" });
say(MAIN, "user", "Legacy kestrel group LEGACY-GROUP-KESTREL.", { ...group, channel: "ops-old" });
say("agent:default:email:t1:direct:t1", "user", "Kestrel invoice EMAIL-LEGACY-KESTREL.", { substrate: "connector:email", channel: "t1", chatType: "direct", senderId: "clint@example.com" }, { sensitiveSource: "email" });
say(MAIN, "user", "Owner closing kestrel OWNER-LAST-KESTREL.", dm, { ownerTurn: true });

// 1. Two tenants.
say("agent:default:app:tenant-a", "user", "Tenant kestrel secret TENANT-A-KESTREL.", app, { appEngine: true, scope: tenantA });
say("agent:default:app:tenant-a", "assistant", "Tenant A reply kestrel TENANT-A-REPLY.", app);
say("agent:default:app:tenant-b", "user", "Tenant kestrel note TENANT-B-KESTREL.", app, { appEngine: true, scope: tenantB });

// Two tenants' runs interleaved in one session key: an unscoped event from
// A's run, written after B's turn, belongs to A (its runId), not B.
const SHARED = "agent:default:app:shared";
appendTranscriptEntry({ sessionKey: SHARED, agentId, role: "user", text: "Shared kestrel A turn SHARED-A-TURN.", source: app as never, runId: "run-a", metadata: { appEngine: true, scope: tenantA } }, { paths });
appendTranscriptEntry({ sessionKey: SHARED, agentId, role: "user", text: "Shared kestrel B turn SHARED-B-TURN.", source: app as never, runId: "run-b", metadata: { appEngine: true, scope: tenantB } }, { paths });
appendTranscriptEntry({ sessionKey: SHARED, agentId, role: "event", text: "Shared kestrel tool result SHARED-A-TOOL.", source: app as never, runId: "run-a" }, { paths });

const recall = async (text: string, scope?: Record<string, string>, maxResults = 40) => {
  const provider = createSqliteMemoryRecallProvider({ paths });
  assert.ok(provider, "sqlite memory database missing after backfill");
  const result = await recallMindStoneMemory({
    agentId,
    provider,
    config: { maxResults, maxPromptTokens: 8000, minScore: 0.01 },
    entries: [{ id: "q", sessionKey: "q", agentId, role: "user", text, timestamp: new Date().toISOString() } as never],
    ...(scope ? { scope } : {}),
  });
  return (result?.hits ?? []).map((hit) => hit.text).join("\n");
};
const has = (text: string, sentinels: string[], label: string) => {
  for (const sentinel of sentinels) assert.ok(text.includes(sentinel), `${label}: missing ${sentinel}:\n${text}`);
};
const absent = (text: string, sentinels: string[], label: string) => {
  for (const sentinel of sentinels) assert.ok(!text.includes(sentinel), `${label}: ${sentinel} must not be recalled:\n${text}`);
};
const Q = "kestrel ledger code tenant reply event legacy owner app";

// 5a. Simulate an index built before the fix: everything, with no labels.
backfillSqliteMemoryIndex({ paths, config: { ...config, memory: { transcripts: { includeNonOwner: true } } } });
const db = new DatabaseSync(sqliteMemoryDatabasePath(paths));
for (const table of ["memory_sources", "memory_chunks"]) {
  db.exec(`UPDATE ${table} SET metadata_json = json_remove(json_remove(metadata_json, '$.audience'), '$.scope') WHERE kind = 'transcript'`);
}
db.close();
assert.ok((await recall(Q)).includes("GROUP-KESTREL"), "control: the simulated old index holds non-owner text");

// A memory file whose frontmatter type is "transcript" shares the kind but not the id.
mkdirSync(paths.memoryDir, { recursive: true });
writeFileSync(join(paths.memoryDir, "note_kestrel.md"), "---\nname: note_kestrel\ndescription: Kestrel file note.\ntype: transcript\n---\n\nFile kestrel note FILE-KESTREL.\n");

// Default backfill with the owner configured.
const after = backfillSqliteMemoryIndex({ paths, config });
assert.ok(after.transcriptSourcesPruned >= 8, `expected the non-owner sources to be pruned, got ${after.transcriptSourcesPruned}`);

const owner = await recall(Q);
has(owner, ["OWNER-KESTREL", "OWNER-REPLY-KESTREL", "LEGACY-OWNER-KESTREL", "OWNER-AFTER-APP-KESTREL", "OWNER-LAST-KESTREL", "FILE-KESTREL"], "owner recall");
absent(owner, ["GROUP-KESTREL", "ECHOGRP-KESTREL", "EVENT-KESTREL", "DIRECT-UNVERIFIED-KESTREL", "EVENT-AFTER-UNVERIFIED"], "owner recall (non-owner turns)");
absent(owner, ["LEGACY-ALICE-KESTREL", "LEGACY-ALICE-REPLY", "LEGACY-GROUP-KESTREL", "EMAIL-LEGACY-KESTREL"], "owner recall (legacy non-owner)");
absent(owner, ["TENANT-A-KESTREL", "TENANT-A-REPLY", "TENANT-B-KESTREL", "APP-IN-MAIN-KESTREL", "APP-IN-MAIN-REPLY"], "companion-mode recall (scoped)");

const a = await recall(Q, tenantA);
has(a, ["TENANT-A-KESTREL", "TENANT-A-REPLY"], "tenant A recall");
absent(a, ["TENANT-B-KESTREL", "GROUP-KESTREL"], "tenant A recall");
const b = await recall(Q, tenantB);
has(b, ["TENANT-B-KESTREL", "SHARED-B-TURN"], "tenant B recall");
absent(b, ["TENANT-A-KESTREL", "TENANT-A-REPLY", "SHARED-A-TOOL"], "tenant B recall");
has(await recall("shared kestrel tool result", tenantA), ["SHARED-A-TOOL"], "tenant A recall of its own interleaved event");
has(await recall(Q, { agentId: "default" }), ["APP-IN-MAIN-KESTREL", "APP-IN-MAIN-REPLY"], "the app run in main at its own scope");

// A rerun is stable.
assert.equal(backfillSqliteMemoryIndex({ paths, config }).transcriptSourcesPruned, 0);

// 6. Scope before ranking: 60 tenant-B chunks that match better can't crowd the owner out.
for (let n = 0; n < 60; n += 1) {
  say("agent:default:app:tenant-b", "user", `kestrel kestrel kestrel ledger ledger code FLOOD-${n}`, app, { appEngine: true, scope: tenantB });
}
backfillSqliteMemoryIndex({ paths, config });
has(await recall("kestrel ledger code", undefined, 8), ["OWNER-"], "owner recall under a tenant flood");

// 6b. The candidate cap: 5100 newer tenant-B chunks can't push the owner's out.
{
  // One entry per chunk: 5100 newer tenant chunks, each its own source.
  for (let n = 0; n < 5100; n += 1) say("agent:default:app:tenant-b", "user", `unrelated tenant filler FILL-${n}`, app, { appEngine: true, scope: tenantB });
  backfillSqliteMemoryIndex({ paths, config });
  // File memory is indexed first, so it is the oldest: without the scope filter
  // in the query, the 5000-row cap would drop it.
  has(await recall("kestrel file note", undefined, 8), ["FILE-KESTREL"], "owner file memory with over 5000 newer tenant chunks");
}

// 5c. An empty transcript directory (an unmounted volume's mount point) prunes nothing.
renameSync(paths.transcriptDir, `${paths.transcriptDir}.aside`);
mkdirSync(paths.transcriptDir);
assert.equal(backfillSqliteMemoryIndex({ paths, config }).transcriptSourcesPruned, 0, "an empty transcript directory must not wipe the index");
has(await recall(Q), ["OWNER-KESTREL"], "owner recall after an empty transcript dir");
rmSync(paths.transcriptDir, { recursive: true });
renameSync(`${paths.transcriptDir}.aside`, paths.transcriptDir);

// 5b. A missing transcript directory prunes nothing.
renameSync(paths.transcriptDir, `${paths.transcriptDir}.moved`);
assert.equal(backfillSqliteMemoryIndex({ paths, config }).transcriptSourcesPruned, 0, "a moved transcript directory must not wipe the index");
has(await recall(Q), ["OWNER-KESTREL"], "owner recall after a missing transcript dir");
console.log("backfill scope assertions passed");
TS

echo "Transcript backfill scope smoke test passed."
