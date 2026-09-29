#!/usr/bin/env bash
# Agent-proposed persona components (#125, part 3): a persona proposal can
# list existing skills, workflows and shared KBs, and bring new ones, each on
# its own approval card linked to the persona's.
#   - parsing: bad components drop the whole proposal; a proposed workflow
#     can't name a persona
#   - a component card waits for its persona card; rejecting the persona
#     rejects its pending components
#   - approving the persona writes its lists; each approved component joins
#     its persona; a proposed private KB is written and ingested
#   - approving never activates; a non-owner's proposal is dropped
#   - refusals: an unknown listed component, a skill already installed (no
#     force), a workflow id the config runs
# The mock model echoes the user's message, so a message holding the block
# stands in for a model that proposes. Binds gateway port base+38; serialize
# per smoke protocol. Synthetic strings only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-proposal-components-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 38))"
cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export PC_TOKEN="proposal-components-smoke-service-token"
export PC_ADMIN_TOKEN="proposal-components-smoke-admin-token"
export CAPTURE="${TEMP_RUNTIME}/capture.jsonl" MINDSTONE_AGENT_MOCK_CAPTURE=1
cd "${PROJECT_ROOT}"
echo "== Persona proposal components smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
DATA="${TEMP_RUNTIME}/mindstone"
BASE="http://127.0.0.1:${GATEWAY_PORT}"
BODY="${TEMP_RUNTIME}/body.json"

# --- 0. Units: parsing, and the pending caps.
npx tsx <<'TS'
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { applyActionProposalDiscipline, ApprovalActionError, ApprovalStore, approveProposedAction, checkApprovable, extractActionProposals, ingestMindStoneKnowledgebase, MAX_PENDING_COMPONENTS, parsePersonaComponents, parseSkillProposal } from "./packages/mindstone-core/src/index.ts";
const route = (extra = {}) => ({ id: "s", kind: "route", ...extra });
assert.ok(parsePersonaComponents({ skills: ["a"], new: { workflows: [{ id: "w", steps: [route()] }] } }), "a plain component list parses");
assert.equal(parsePersonaComponents({ new: { workflows: [{ id: "w", steps: [route({ personaId: "x" })] }] } }), undefined, "a proposed workflow routing to a persona must be refused");
assert.equal(parsePersonaComponents({ new: { workflows: [{ id: "w", steps: [{ id: "g", kind: "gate", gate: { personaLoadable: "x" } }] }] } }), undefined, "a proposed gate on a persona must be refused");
assert.equal(parsePersonaComponents({ skills: ["a"], extra: 1 }), undefined, "an unknown key must be refused");
assert.equal(parsePersonaComponents({ new: { privateKnowledgebases: [{ id: "k", sources: [{ text: "hidden​mark" }] }] } }), undefined, "an invisible character in a source must be refused");
assert.equal(parsePersonaComponents({ new: { privateKnowledgebases: [{ id: "../k", sources: [{ text: "x" }] }] } }), undefined, "a path as a KB id must be refused");
assert.equal(parsePersonaComponents({ skills: ["../x"] }), undefined, "a path as a listed id must be refused");
const skill = (id) => ({ id, label: "L", description: "D", whenToUse: ["w"], outputs: ["o"], safetyNotes: ["s"] });
assert.equal(parsePersonaComponents({ new: { skills: [skill("a1"), skill("a2"), skill("a3"), skill("a4")] } }), undefined, "more than 3 new skills must be refused");
// Invisible characters anywhere in a new component, not only in KB text (#125 review).
assert.equal(parsePersonaComponents({ new: { workflows: [{ id: "w", name: "Tri\u200Bage", steps: [route()] }] } }), undefined, "an invisible character in a workflow name must be refused");
assert.equal(parsePersonaComponents({ new: { workflows: [{ id: "w", steps: [route({ when: { messagePrefix: "go\u2066" } })] }] } }), undefined, "an invisible character in a condition must be refused");
assert.equal(parsePersonaComponents({ new: { privateKnowledgebases: [{ id: "k", name: "No\u200Dtes", sources: [{ text: "x" }] }] } }), undefined, "an invisible character in a KB name must be refused");
assert.equal(parsePersonaComponents({ new: { skills: [{ ...skill("a1"), label: "La\u200Bbel" }] } }), undefined, "an invisible character in a skill label must be refused");
// CRLF is a line break, not an invisible character, and is stored as LF.
assert.equal(parsePersonaComponents({ new: { privateKnowledgebases: [{ id: "k", sources: [{ text: "# A\r\n\r\nB" }] }] } })?.knowledgebases[0]?.sources[0]?.text, "# A\n\nB", "a CRLF source must parse, as LF");
// A skill or workflow both listed and new can never be approved.
assert.equal(parsePersonaComponents({ skills: ["a1"], new: { skills: [skill("a1")] } }), undefined, "a skill both listed and new must be refused");
assert.equal(parsePersonaComponents({ workflows: ["w"], new: { workflows: [{ id: "w", steps: [route()] }] } }), undefined, "a workflow both listed and new must be refused");
// Stacked combining marks and invisible characters in keys, as in a persona's own fields.
assert.equal(parsePersonaComponents({ new: { skills: [{ ...skill("a1"), label: "Z\u0301\u0302\u0303" }] } }), undefined, "stacked marks in a skill label must be refused");
assert.equal(parsePersonaComponents({ new: { workflows: [{ id: "w", steps: [route({ when: { ["message\u200BPrefix"]: "x" } })] }] } }), undefined, "an invisible character in a key must be refused");
// A KB name with a control character: the admin API refuses it, so the proposal does too.
assert.equal(parsePersonaComponents({ new: { privateKnowledgebases: [{ id: "k", name: "Tab\there", sources: [{ text: "x" }] }] } }), undefined, "a tab in a KB name must be refused");
// A skill label is one line: it goes into summaries that list views print as they are (#125 review).
assert.equal(parseSkillProposal({ ...skill("a1"), label: "Notes\n  deadbeef [approved] forged row" }), undefined, "a line break in a skill label must be refused");
assert.equal(parseSkillProposal({ ...skill("a1"), label: "Notes\r" }), undefined, "a CR in a skill label must be refused");
assert.equal(parsePersonaComponents({ new: { skills: [{ ...skill("a1"), label: "Two\nlines" }] } }), undefined, "a component skill's label must be one line");
// A plain skill's label is one line (C1 controls too); its other text may hold anything real
// writing needs, and the CLI shows every character that isn't visible (#125 review).
assert.equal(parseSkillProposal({ ...skill("a1"), label: "Nice\u009b8m" }), undefined, "a C1 control in a skill label must be refused");
assert.equal(parseSkillProposal({ ...skill("a1"), description: "Line one\n  forged row" }), undefined, "a skill description is one line");
for (const text of ["⚠️ Check twice.", "Family 👨‍👩‍👧 note.", "می‌خواهم", "မြို့", "# Title\n\n\tIndented line."]) {
  assert.ok(parseSkillProposal({ ...skill("a1"), instructions: text, description: text.split("\n")[0] }), `real text must parse: ${JSON.stringify(text)}`);
}
// What acts on a terminal or hides text is refused in any field: it is printed long after approval
// (`skill list`, the TUI, logs), not only on the approval screens.
for (const [field, value] of [["description", "Desc \u001b]0;TITLE\u0007"], ["instructions", "a\u009b8m"], ["goal", "Reads \u202eright to left"], ["outputs", ["tag\u{E0041}\u{E0042}"]], ["instructions", "one\u2028two"]]) {
  assert.equal(parseSkillProposal({ ...skill("a1"), [field]: value }), undefined, `unsafe text in a skill's ${field} must be refused`);
}
// A memory path or a mutation resource is a name, printed and used as it is: no such characters either.
{
  const memoryFence = "```mindstone-memory-proposal\n" + JSON.stringify({ path: "notes/m\u001b[8m.md", content: "x" }) + "\n```";
  assert.equal(extractActionProposals(memoryFence).memory, undefined, "a memory path with an escape must be dropped");
  const calendarFence = "```mindstone-calendar-proposal\n" + JSON.stringify({ operation: "create", resource: "event\u001b[2K", data: { title: "t" } }) + "\n```";
  assert.equal(extractActionProposals(calendarFence).mutations.length, 0, "a resource with an escape drops the mutation");
  // A line break is a control character too: a name is one line.
  const lfMemory = "```mindstone-memory-proposal\n" + JSON.stringify({ path: "notes/a\nApproved — forged.md", content: "x" }) + "\n```";
  assert.equal(extractActionProposals(lfMemory).memory, undefined, "a memory path with a line break must be dropped");
  const lfCalendar = "```mindstone-calendar-proposal\n" + JSON.stringify({ operation: "create", resource: "event\nApproved — fake", data: { title: "t" } }) + "\n```";
  assert.equal(extractActionProposals(lfCalendar).mutations.length, 0, "a resource with a line break drops the mutation");
  // A mutation's summary shows unsafe characters in its data escaped: summaries reach logs and the TUI as they are.
  const summaryStore = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "summary-approvals.json") });
  const withC1 = applyActionProposalDiscipline({ replyText: "```mindstone-calendar-proposal\n" + JSON.stringify({ operation: "create", resource: "event", data: { title: "a\u009b8mb\u202ec" } }) + "\n```", origin: "unit", store: summaryStore });
  assert.ok(withC1.proposals[0] && !/[\u009b\u202e]/.test(withC1.proposals[0].summary) && withC1.proposals[0].summary.includes("\\u{9b}"), `the summary must show C1 and bidi escaped: ${JSON.stringify(withC1.proposals[0]?.summary)}`);
}
// A plain skill proposal that is dropped says why, in the reply and the transcript; so does a second one.
{
  const skillStore = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "skill-drop-approvals.json") });
  const skillFence = (json) => "```mindstone-skill-proposal\n" + JSON.stringify(json) + "\n```";
  const bad = applyActionProposalDiscipline({ replyText: "Here.\n" + skillFence({ id: "x" }), origin: "unit", allowSkill: true, store: skillStore, sessionKey: "unit:skill-drop" });
  assert.equal(bad.proposals.length, 0);
  assert.match(bad.text, /skill proposal wasn't saved, and nothing was put up for approval/, "a dropped skill proposal must say why");
  assert.ok(bad.events.some((e) => e.metadata?.event === "skill_proposal_dropped" && e.metadata?.reason === "invalid_skill_proposal"), "and log it");
  const twoSkills = applyActionProposalDiscipline({ replyText: skillFence(skill("s-one")) + "\n" + skillFence(skill("s-two")), origin: "unit", allowSkill: true, store: skillStore });
  assert.equal(twoSkills.proposals.length, 1);
  assert.match(twoSkills.text, /1 other skill block\(s\) were dropped/, "a second skill block must be said");
  // A reply that was only the block is only the note: no blank lines before it.
  const onlyBlock = applyActionProposalDiscipline({ replyText: skillFence({ id: "x" }), origin: "unit", allowSkill: true, store: skillStore });
  assert.match(onlyBlock.text, /^\(The skill proposal wasn't saved/, "the note starts the reply");
}
// A built-in skill's id can't be brought as new: it would override the built-in.
assert.equal(parsePersonaComponents({ new: { skills: [skill("integration-builder")] } }), undefined, "a built-in skill's id must be refused");
const block = (json) => "Here it is.\n```mindstone-persona-proposal\n" + JSON.stringify(json) + "\n```";
const kbs = (n) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, sources: [{ text: "x" }] }));
const base = { id: "unit", name: "Unit", voice: "Plain." };
assert.equal(extractActionProposals(block({ ...base, components: { bogus: true } })).persona, undefined, "a persona with bad components must be dropped whole");
assert.equal(extractActionProposals(block({ ...base, components: { skills: ["a"] } })).persona?.id, "unit");
// A proposal dropped for its components says so in the reply, with the reason.
{
  const noteStore = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "note-approvals.json") });
  const dropped = applyActionProposalDiscipline({ replyText: block({ ...base, components: { skills: ["a1"], new: { skills: [skill("a1")] } } }), origin: "unit", allowPersona: true, store: noteStore });
  assert.equal(dropped.proposals.length, 0);
  assert.match(dropped.text, /wasn't saved, and nothing was put up for approval: a skill or workflow is both listed/, "the reply must say why the proposal was dropped");
  // Every dropped persona block is said, not only one with bad components (#125 review).
  const badField = applyActionProposalDiscipline({ replyText: block({ ...base, voice: "Pla\u200Bin." }), origin: "unit", allowPersona: true, store: noteStore });
  assert.equal(badField.proposals.length, 0);
  assert.match(badField.text, /wasn't saved, and nothing was put up for approval: its id, name, voice/, "a persona with a bad field must say why");
  const badJson = applyActionProposalDiscipline({ replyText: "Here.\n```mindstone-persona-proposal\n{\"id\":\"x\",\n```", origin: "unit", allowPersona: true, store: noteStore });
  assert.match(badJson.text, /wasn't saved, and nothing was put up for approval: its block isn't valid JSON/, "a persona block that isn't JSON must say why");
  assert.doesNotMatch(badJson.text, /too many/, "the invalid note isn't the cap note");
  // Only one persona block per reply is used; the others are said (#125 review).
  const two = applyActionProposalDiscipline({ replyText: block({ ...base, id: "first" }) + "\n" + block({ ...base, id: "second" }), origin: "unit", allowPersona: true, store: noteStore });
  assert.equal(two.proposals.length, 1, "one persona card for two blocks");
  assert.match(two.text, /1 other persona block\(s\) in this reply were dropped/, "the second block must be said");
  const badThenGood = applyActionProposalDiscipline({ replyText: "```mindstone-persona-proposal\n{broken\n```\n" + block({ ...base, id: "good-one" }), origin: "unit", allowPersona: true, store: noteStore });
  assert.equal(badThenGood.proposals.length, 1);
  assert.match(badThenGood.text, /1 other persona block/, "an invalid block before a valid one must be said");
  // The transcript event names the reason as it is.
  const withEvent = applyActionProposalDiscipline({ replyText: block({ ...base, voice: "Pla\u200Bin." }), origin: "unit", allowPersona: true, store: noteStore, sessionKey: "unit:reason" });
  assert.equal(withEvent.events[0]?.metadata?.reason, "invalid_proposal", "the event's reason for a bad field");
  const twoWithEvent = applyActionProposalDiscipline({ replyText: block({ ...base, id: "ev-first" }) + "\n" + block({ ...base, id: "ev-second" }), origin: "unit", allowPersona: true, store: new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "extra-approvals.json") }), sessionKey: "unit:extra" });
  assert.ok(twoWithEvent.events.some((e) => e.metadata?.reason === "extra_persona_blocks"), "dropped extra blocks are in the transcript");
  // A separate skill proposal with the id of the persona's new skill isn't saved.
  const skillBlock = "\n```mindstone-skill-proposal\n" + JSON.stringify(skill("same-id")) + "\n```";
  const clash = applyActionProposalDiscipline({ replyText: block({ ...base, id: "with-same", components: { new: { skills: [skill("same-id")] } } }) + skillBlock, origin: "unit", allowPersona: true, allowSkill: true, store: noteStore });
  assert.equal(clash.proposals.filter((a) => a.kind === "skill_install").length, 1, "only the persona's own skill card");
  assert.ok(clash.proposals.every((a) => a.kind !== "skill_install" || a.parentApprovalId), "the plain skill proposal must be dropped");
  assert.match(clash.text, /separate skill proposal wasn't saved/);
  // The clashing block first, then another: neither is put up, and the note doesn't say one was.
  const clashThenOther = applyActionProposalDiscipline({ replyText: block({ ...base, id: "with-same-2", components: { new: { skills: [skill("same-id-2")] } } }) + "\n```mindstone-skill-proposal\n" + JSON.stringify(skill("same-id-2")) + "\n```\n```mindstone-skill-proposal\n" + JSON.stringify(skill("other-id")) + "\n```", origin: "unit", allowPersona: true, allowSkill: true, store: new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "clash2-approvals.json") }) });
  assert.ok(clashThenOther.proposals.every((a) => a.kind !== "skill_install" || a.parentApprovalId), "no plain skill card");
  assert.match(clashThenOther.text, /other skill block\(s\) in this reply weren't saved either/);
  assert.doesNotMatch(clashThenOther.text, /Only one skill proposal per reply is put up/, "no note saying one was put up");
  const notOwner = applyActionProposalDiscipline({ replyText: block({ ...base, components: { bogus: 1 } }), origin: "unit", allowPersona: false, store: noteStore });
  assert.doesNotMatch(notOwner.text, /wasn't saved/, "a turn that can't propose a persona gets no note");
}
// Plain skill proposals (#104) don't count toward the component cap (#125 review).
{
  const plainStore = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "plain-approvals.json") });
  for (let i = 0; i < MAX_PENDING_COMPONENTS + 1; i += 1) {
    plainStore.propose({ kind: "skill_install", connectorId: "unit", summary: `plain ${i}`, skill: skill(`plain-${i}`) });
  }
  const bare = applyActionProposalDiscipline({ replyText: block({ ...base, id: "bare" }), origin: "unit", allowPersona: true, store: plainStore });
  assert.equal(bare.proposals.length, 1, "a persona with no components must be saved while plain skill proposals wait");
  const withSkill = applyActionProposalDiscipline({ replyText: block({ ...base, id: "with-skill", components: { new: { skills: [skill("n1")] } } }), origin: "unit", allowPersona: true, store: plainStore });
  assert.equal(withSkill.proposals.length, 2, "a persona with a new skill must be saved while plain skill proposals wait");
}
// A component under a rejected persona doesn't hold a place in the cap; a full
// cap of one kind doesn't drop a proposal that brings another (#125 review).
{
  const capStore = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "cap2-approvals.json") });
  for (let i = 0; i < 3; i += 1) {
    applyActionProposalDiscipline({ replyText: block({ ...base, id: `full${i}`, components: { new: { privateKnowledgebases: kbs(2) } } }), origin: "unit", allowPersona: true, store: capStore });
  }
  for (const card of capStore.pending().filter((a) => a.kind === "persona_create")) capStore.decide(card.id, { status: "approved", decidedBy: "unit", now: "t" });
  assert.equal(capStore.pending().filter((a) => a.kind === "persona_kb_create").length, MAX_PENDING_COMPONENTS);
  const other = applyActionProposalDiscipline({ replyText: block({ ...base, id: "other-kind", components: { new: { workflows: [{ id: "w1", steps: [route()] }] } } }), origin: "unit", allowPersona: true, store: capStore });
  assert.equal(other.proposals.length, 2, "a full KB cap must not drop a proposal that brings only a workflow");
  const stillFull = applyActionProposalDiscipline({ replyText: block({ ...base, id: "still-full", components: { new: { privateKnowledgebases: kbs(1) } } }), origin: "unit", allowPersona: true, store: capStore });
  assert.equal(stillFull.proposals.length, 0, "control: the KB cap is full");
  assert.match(stillFull.text, /too many/, "the cap note");
  // Their persona cards rejected without the cascade (a reject that missed them): they no longer count.
  for (const card of capStore.list().filter((a) => a.kind === "persona_create" && a.persona?.id.startsWith("full"))) {
    capStore.undoApproval(card.id, card.decidedAt);
    capStore.decide(card.id, { status: "rejected", decidedBy: "unit", now: "t" });
  }
  assert.equal(capStore.pending().filter((a) => a.kind === "persona_kb_create").length, MAX_PENDING_COMPONENTS, "the orphaned KB cards are still pending");
  const freed = applyActionProposalDiscipline({ replyText: block({ ...base, id: "freed", components: { new: { privateKnowledgebases: kbs(1) } } }), origin: "unit", allowPersona: true, store: capStore });
  assert.equal(freed.proposals.length, 2, "cards under a rejected persona must not hold places in the cap");
}
// A card whose persona card is gone is refused before any confirmation, and can only be rejected.
{
  const goneStore = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "gone-approvals.json") });
  const orphan = goneStore.propose({ kind: "persona_kb_create", connectorId: "unit", summary: "orphan", knowledgebase: { personaId: "gone", id: "k", sources: [{ name: "source-1", text: "x" }] }, parentApprovalId: "00000000-0000-0000-0000-000000000000" });
  assert.throws(() => checkApprovable(goneStore, orphan.id), (error) => error instanceof ApprovalActionError && error.code === "persona_missing");
  const pendingParent = applyActionProposalDiscipline({ replyText: block({ ...base, id: "waiting", components: { new: { privateKnowledgebases: kbs(1) } } }), origin: "unit", allowPersona: true, store: goneStore });
  assert.throws(() => checkApprovable(goneStore, pendingParent.proposals[1].id), (error) => error instanceof ApprovalActionError && error.code === "persona_pending", "a card whose persona waits is refused before the confirmation");
}
// A component left pending under a rejected persona is rejected when approved (#125 review).
{
  const orphanStore = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "orphan-approvals.json") });
  const made = applyActionProposalDiscipline({ replyText: block({ ...base, id: "orphan", components: { new: { privateKnowledgebases: kbs(1) } } }), origin: "unit", allowPersona: true, store: orphanStore });
  const [parent, child] = made.proposals;
  orphanStore.decide(parent.id, { status: "rejected", decidedBy: "unit", now: "t" });
  assert.throws(() => approveProposedAction(orphanStore, checkApprovable(orphanStore, child.id), { decidedBy: "unit", memoryDir: "/nonexistent", personasDir: "/nonexistent" }),
    (error) => error instanceof ApprovalActionError && error.code === "persona_rejected");
  assert.equal(orphanStore.get(child.id)?.status, "rejected", "the orphaned card must be rejected");
}
// Caps: past MAX_PENDING_COMPONENTS of a kind, the whole proposal is dropped, with a note.
const store = new ApprovalStore({ path: join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "unit-approvals.json") });
for (let i = 0; i < 3; i += 1) {
  const r = applyActionProposalDiscipline({ replyText: block({ ...base, id: `cap${i}`, components: { new: { privateKnowledgebases: kbs(2) } } }), origin: "unit", allowPersona: true, store });
  assert.equal(r.proposals.length, 3, `proposal ${i} should make a persona card and two KB cards`);
}
assert.equal(store.pending().filter((a) => a.kind === "persona_kb_create").length, MAX_PENDING_COMPONENTS);
// The persona cards are decided, so only the KB cap can refuse the next one (the persona cap is 3).
for (const card of store.pending().filter((a) => a.kind === "persona_create")) store.decide(card.id, { status: "approved", decidedBy: "unit", now: "t" });
const capped = applyActionProposalDiscipline({ replyText: block({ id: "cap9", name: "Cap", voice: "x", components: { new: { privateKnowledgebases: kbs(1) } } }), origin: "unit", allowPersona: true, store });
assert.equal(capped.proposals.length, 0, "a proposal past the KB cap must be dropped whole");
assert.match(capped.text, /wasn't saved/);
// An approved proposal's KB is ingested from its text sources only; one with a URL source by now is left for an admin ingest.
{
  const kbRoot = join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "text-only-kbs");
  mkdirSync(join(kbRoot, "k", "sources"), { recursive: true });
  writeFileSync(join(kbRoot, "k", "kb.json"), JSON.stringify({ name: "k", externalSources: [{ id: "web", type: "url", url: "https://example.com/doc" }] }));
  writeFileSync(join(kbRoot, "k", "sources", "a.md"), "# A\n\nText.\n");
  const result = await ingestMindStoneKnowledgebase(kbRoot, "k", { noLinks: true, textOnly: true });
  assert.equal(result.ok, false, "a text-only ingest must not fetch a URL source");
  assert.match(result.ok ? "" : result.error, /ingest it from the persona editor/);
}
console.log("units ok");
TS

python3 - <<'PY'
import json, os, pathlib
data = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone"
p = data / "config.json"
c = json.loads(p.read_text())
c.setdefault("gateway", {})["auth"] = {"mode": "token", "tokenEnv": "PC_TOKEN"}
c["gateway"]["admin"] = {"tokenEnv": "PC_ADMIN_TOKEN"}
c["gateway"]["http"] = {"chatCompletions": {"enabled": True}}
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "pc", "captureFile": os.environ["CAPTURE"]}}
c["memory"] = {"autoRecall": True}
c["workflows"] = {"active": "wf-live"}
p.write_text(json.dumps(c, indent=2) + "\n")
def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)
write(data / "skills" / "alpha-skill" / "skill.json", json.dumps({"id": "alpha-skill", "label": "Alpha", "description": "Alpha sentinel."}))
write(data / "skills" / "alpha-skill" / "SKILL.md", "# alpha\n\nSkill body SKILLBODY-alpha.\n")
write(data / "knowledgebases" / "g1" / "kb.json", json.dumps({"name": "g1"}))
write(data / "knowledgebases" / "g1" / "sources" / "notes.md", "# Notes\n\nThe shared reference code is GPROP-9900 for this collection.\n")
PY
./scripts/mindstone kb ingest g1 --json >/dev/null
./scripts/start-gateway.sh >"${TEMP_RUNTIME}/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done

ADMIN=(-H "Authorization: Bearer ${PC_TOKEN}" -H "x-mindstone-admin-token: ${PC_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
call() { if [[ $# -ge 3 ]]; then curl -s -o "${BODY}" -w '%{http_code}' -X "$1" "${ADMIN[@]}" -d "$3" "${BASE}$2"; else curl -s -o "${BODY}" -w '%{http_code}' -X "$1" "${ADMIN[@]}" "${BASE}$2"; fi; }
expect() { # expect <status> <what> <method> <path> [json] [body part]
  local want="$1" what="$2"; shift 2
  local got; got="$(call "$1" "$2" ${3:+"$3"})"
  [[ "${got}" == "${want}" ]] || { echo "${what}: expected ${want}, got ${got}: $(cat "${BODY}")" >&2; exit 1; }
  if [[ -n "${4:-}" ]]; then grep -qF -- "$4" "${BODY}" || { echo "${what}: the body lacks '$4': $(cat "${BODY}")" >&2; exit 1; }; fi
}
# say <role> <conversation> <message>: the mock echoes it, so a block in it is proposed.
say() {
  : > "${CAPTURE}"
  local payload code
  payload="$(TEXT="$3" node -e 'process.stdout.write(JSON.stringify({ model: "mindstone/default", messages: [{ role: "user", content: process.env.TEXT }] }))')"
  code="$(curl -s -o "${BODY}" -w '%{http_code}' -X POST -H "Authorization: Bearer ${PC_TOKEN}" -H 'content-type: application/json' \
    -H "x-mindstone-user-role: $1" -H "x-mindstone-user-id: smoke-$1" -H "x-mindstone-conversation-id: $2" -d "${payload}" "${BASE}/v1/chat/completions")"
  [[ "${code}" == 200 ]] || { echo "chat $2 failed (${code}): $(cat "${BODY}")" >&2; exit 1; }
}
proposal() { # proposal <json>: a reply that ends with a persona proposal block
  printf 'Here is a persona for you.\n```mindstone-persona-proposal\n%s\n```' "$1"
}
# card <persona-id> <kind>: the id of that persona's card of that kind, from the approvals store
card() {
  PID="$1" KIND="$2" node -e '
const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).actions;
const persona = a.find((x) => x.kind === "persona_create" && x.persona?.id === process.env.PID);
if (!persona) { console.error("no persona card for " + process.env.PID); process.exit(1); }
const found = process.env.KIND === "persona_create" ? persona : a.find((x) => x.kind === process.env.KIND && x.parentApprovalId === persona.id);
if (!found) { console.error("no " + process.env.KIND + " card for " + process.env.PID); process.exit(1); }
process.stdout.write(found.id);' "${DATA}/approvals/actions.json"
}
status_of() { ID="$1" node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).actions; process.stdout.write(a.find((x) => x.id === process.env.ID)?.status ?? "none");' "${DATA}/approvals/actions.json"; }

NEW_SKILL='{"id":"beta-new","label":"Beta","description":"A proposed skill.","whenToUse":["when asked"],"outputs":["a note"],"safetyNotes":["none"],"instructions":"# Beta\n\nSkill body SKILLBODY-beta-new."}'
P2_JSON='{"id":"p2","name":"Proposed Two","voice":"Plain and short.","components":{"skills":["alpha-skill"],"knowledgebases":["g1"],"new":{"skills":['"${NEW_SKILL}"'],"workflows":[{"id":"wf-p2","steps":[{"id":"route-it","kind":"route","when":{"messagePrefix":"p2:"}}]}],"privateKnowledgebases":[{"id":"notes","sources":[{"text":"# Notes\n\nThe private reference code is PPROP-9901 for this collection."}]}]}}}'
P2="$(proposal "${P2_JSON}")"

# --- 1. The owner's agent proposes persona p2 with components: four cards, the proposal gone from the reply.
say admin conv-propose "${P2}"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const reply=b.choices?.[0]?.message?.content ?? ""; if (!reply || reply.includes("mindstone-persona-proposal")) { console.error("the proposal block reached the reply: " + reply); process.exit(1); }' "${BODY}"
PERSONA_CARD="$(card p2 persona_create)"; SKILL_CARD="$(card p2 skill_install)"; WF_CARD="$(card p2 workflow_create)"; KB_CARD="$(card p2 persona_kb_create)"
echo "cards ok"
# The CLI shows everything each card holds before it is approved (#125 review).
shows() { # shows <card> <text>...
  local id="$1"; shift
  ./scripts/mindstone approvals show "${id}" > "${TEMP_RUNTIME}/show.txt"
  for text in "$@"; do grep -qF -- "${text}" "${TEMP_RUNTIME}/show.txt" || { echo "approvals show ${id} lacks '${text}': $(cat "${TEMP_RUNTIME}/show.txt")" >&2; exit 1; }; done
}
shows "${PERSONA_CARD}" "Skills: only alpha-skill" "Shared knowledge bases: only g1" "Workflows: none" "${WF_CARD:0:8}" "${KB_CARD:0:8}" "${SKILL_CARD:0:8}"
shows "${KB_CARD}" "Part of persona p2" "PPROP-9901" "App Engine runs"
shows "${WF_CARD}" "Part of persona p2" '"messagePrefix": "p2:"' "added last to persona p2's workflows" "run only on turns where nothing else names a workflow"
shows "${SKILL_CARD}" "Part of persona p2" "SKILLBODY-beta-new" "Approving installs it like any skill"
# A KB source's lines are marked, so none can pass for the end of it.
shows "${KB_CARD}" "| The private reference code is PPROP-9901"
echo "cli show ok"

# --- 2. A component waits for its persona.
expect 409 "the KB card before the persona" POST "/admin/approvals/${KB_CARD}/approve" '{}' persona_pending
[[ ! -e "${DATA}/personas/p2" ]] || { echo "a component card wrote the persona" >&2; exit 1; }
# --- 3. Approving the persona writes it and its listed components, and doesn't activate it.
expect 200 "approve the persona" POST "/admin/approvals/${PERSONA_CARD}/approve" '{}'
[[ "$(tr -d ' \n' < "${DATA}/personas/p2/skills.json")" == '["alpha-skill"]' ]] || { echo "the persona's listed skills weren't written" >&2; exit 1; }
[[ "$(tr -d ' \n' < "${DATA}/personas/p2/knowledgebases.json")" == '["g1"]' ]] || { echo "the persona's listed KBs weren't written" >&2; exit 1; }
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (c.personas?.active) { console.error("approving activated a persona"); process.exit(1); }' "${DATA}/config.json"
# --- 4. Each component card, then, joins its persona.
expect 403 "a skill card without advanced settings" POST "/admin/approvals/${SKILL_CARD}/approve" '{}'
expect 200 "grant advanced settings" POST /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}'
expect 200 "approve the skill card" POST "/admin/approvals/${SKILL_CARD}/approve" '{}'
grep -q '"beta-new"' "${DATA}/personas/p2/skills.json" || { echo "the approved skill didn't join its persona" >&2; exit 1; }
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(b.result?.persona?.listed === true ? 0 : 1)' "${BODY}" || { echo "the skill result doesn't say it joined its persona: $(cat "${BODY}")" >&2; exit 1; }
expect 200 "approve the workflow card" POST "/admin/approvals/${WF_CARD}/approve" '{}'
[[ -f "${DATA}/workflows/wf-p2/workflow.json" ]] || { echo "the approved workflow wasn't written" >&2; exit 1; }
grep -q '"wf-p2"' "${DATA}/personas/p2/workflows.json" || { echo "the approved workflow didn't join its persona" >&2; exit 1; }
expect 200 "approve the KB card" POST "/admin/approvals/${KB_CARD}/approve" '{}' '"entryCount"'
[[ -f "${DATA}/personas/p2/knowledgebases/notes/index.json" ]] || { echo "the approved KB wasn't ingested" >&2; exit 1; }
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (c.personas?.active) { console.error("approving a component activated a persona"); process.exit(1); }' "${DATA}/config.json"
echo "approvals ok"

# --- 5. Switched to, p2 answers with its components: its private KB, its listed and new skills, its shared KB.
expect 200 "switch to p2" PATCH /admin/config/personas '{"active":"p2"}'
say admin conv-p2 "Which private reference code applies for this collection?"
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); process.stdout.write(JSON.parse(l.pop()).messages.map((m)=>m.text??"").join("\n"))' "${CAPTURE}" > "${TEMP_RUNTIME}/p2.prompt"
for text in PPROP-9901 GPROP-9900 SKILLBODY-alpha SKILLBODY-beta-new; do grep -qF "${text}" "${TEMP_RUNTIME}/p2.prompt" || { echo "p2: '${text}' is missing from the prompt" >&2; exit 1; }; done
expect 200 "switch back to none" PATCH /admin/config/personas '{"active":null}'
echo "persona in use ok"

# --- 6. Rejecting a persona rejects its pending components; nothing is written.
say admin conv-p3 "$(proposal '{"id":"p3","name":"Three","voice":"x","components":{"new":{"privateKnowledgebases":[{"id":"n3","sources":[{"text":"# N\n\nNothing."}]}]}}}')"
P3="$(card p3 persona_create)"; P3KB="$(card p3 persona_kb_create)"
expect 409 "p3's KB before p3" POST "/admin/approvals/${P3KB}/approve" '{}' persona_pending
expect 200 "reject p3" POST "/admin/approvals/${P3}/reject" '{"note":"not now"}'
[[ "$(status_of "${P3KB}")" == rejected ]] || { echo "rejecting the persona left its KB card $(status_of "${P3KB}")" >&2; exit 1; }
[[ ! -e "${DATA}/personas/p3" ]] || { echo "a rejected persona was written" >&2; exit 1; }
echo "reject cascade ok"

# --- 7. Refusals at approval.
# A listed component that doesn't exist.
say admin conv-p4 "$(proposal '{"id":"p4","name":"Four","voice":"x","components":{"skills":["ghost-skill"]}}')"
expect 422 "a persona listing a skill that doesn't exist" POST "/admin/approvals/$(card p4 persona_create)/approve" '{}' unknown_component
[[ ! -e "${DATA}/personas/p4" ]] || { echo "a refused persona was written" >&2; exit 1; }
# A new skill already installed: refused, even with force.
# (Single-quoted: macOS bash 3.2 mangles escaped quotes nested in "$( )".)
P5='{"id":"p5","name":"Five","voice":"x","components":{"new":{"skills":[{"id":"alpha-skill","label":"A","description":"D","whenToUse":["w"],"outputs":["o"],"safetyNotes":["s"]}],"workflows":[{"id":"wf-live","steps":[{"id":"s","kind":"route"}]}]}}}'
say admin conv-p5 "$(proposal "${P5}")"
expect 200 "approve p5" POST "/admin/approvals/$(card p5 persona_create)/approve" '{}'
expect 409 "a new skill that is installed, with force" POST "/admin/approvals/$(card p5 skill_install)/approve" '{"force":true}' skill_exists
! grep -qi 'force' "${BODY}" || { echo "a persona's skill refusal offers force: $(cat "${BODY}")" >&2; exit 1; }
grep -q 'SKILLBODY-alpha' "${DATA}/skills/alpha-skill/SKILL.md" || { echo "the installed skill was replaced" >&2; exit 1; }
# A workflow id the config runs.
expect 409 "a proposed workflow the config runs" POST "/admin/approvals/$(card p5 workflow_create)/approve" '{}' workflow_referenced
[[ ! -e "${DATA}/workflows/wf-live" ]] || { echo "a workflow the config runs was created" >&2; exit 1; }
# The persona folder is gone: its components are refused before anything is written.
P9='{"id":"p9","name":"Nine","voice":"x","components":{"new":{"skills":[{"id":"nine-skill","label":"N","description":"D","whenToUse":["w"],"outputs":["o"],"safetyNotes":["s"]}],"workflows":[{"id":"wf-nine","steps":[{"id":"s","kind":"route"}]}],"privateKnowledgebases":[{"id":"nine-notes","sources":[{"text":"# Nine"}]}]}}}'
say admin conv-p9 "$(proposal "${P9}")"
expect 200 "approve p9" POST "/admin/approvals/$(card p9 persona_create)/approve" '{}'
rm -rf "${DATA}/personas/p9"
expect 409 "p9's skill with its persona gone" POST "/admin/approvals/$(card p9 skill_install)/approve" '{}' invalid_persona
expect 409 "p9's workflow with its persona gone" POST "/admin/approvals/$(card p9 workflow_create)/approve" '{}' invalid_persona
expect 409 "p9's KB with its persona gone" POST "/admin/approvals/$(card p9 persona_kb_create)/approve" '{}' invalid_persona
[[ ! -e "${DATA}/skills/nine-skill" && ! -e "${DATA}/workflows/wf-nine" && ! -e "${DATA}/personas/p9" ]] || { echo "a component of a missing persona was written" >&2; exit 1; }
[[ "$(status_of "$(card p9 skill_install)")" == pending ]] || { echo "a refused component card isn't pending" >&2; exit 1; }
echo "refusals ok"

# --- 7b. A persona that lists no skills keeps every installed skill when its new skill is approved.
P10='{"id":"p10","name":"Ten","voice":"x","components":{"new":{"skills":[{"id":"ten-skill","label":"T","description":"D","whenToUse":["w"],"outputs":["o"],"safetyNotes":["s"]}],"privateKnowledgebases":[{"id":"ten-notes","sources":[{"text":"# Ten\n\nThe reference code is TPROP-1010."}]}]}}}'
say admin conv-p10 "$(proposal "${P10}")"
# Approved from the CLI this time, persona first, then its KB (written and ingested).
./scripts/mindstone approvals approve "$(card p10 persona_create)" --yes > "${TEMP_RUNTIME}/cli.txt"
./scripts/mindstone approvals approve "$(card p10 persona_kb_create)" --yes > "${TEMP_RUNTIME}/cli.txt"
grep -qF "written and ingested for persona p10" "${TEMP_RUNTIME}/cli.txt" || { echo "the CLI KB approve: $(cat "${TEMP_RUNTIME}/cli.txt")" >&2; exit 1; }
./scripts/mindstone approvals approve "$(card p10 skill_install)" --yes > "${TEMP_RUNTIME}/cli.txt"
grep -qF "every installed skill" "${TEMP_RUNTIME}/cli.txt" || { echo "the CLI skill approve doesn't say the persona keeps every skill: $(cat "${TEMP_RUNTIME}/cli.txt")" >&2; exit 1; }
[[ ! -e "${DATA}/personas/p10/skills.json" ]] || { echo "approving a new skill narrowed a persona that lists none to it: $(cat "${DATA}/personas/p10/skills.json")" >&2; exit 1; }
echo "all skills kept ok"

# --- 7c. A persona that lists an existing workflow shows its steps, in the CLI and the gateway's detail.
say admin conv-p11 "$(proposal '{"id":"p11","name":"Eleven","voice":"x","components":{"workflows":["wf-p2"]}}')"
shows "$(card p11 persona_create)" "wf-p2:" 'route-it: route when {"messagePrefix":"p2:"}'
expect 200 "the persona card's detail" GET "/admin/approvals/$(card p11 persona_create)"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const w=b.action?.listedWorkflows; if (!(w?.length === 1 && w[0].id === "wf-p2" && w[0].steps?.[0]?.id === "route-it")) { console.error("the detail lacks the listed workflow steps: " + JSON.stringify(b.action)); process.exit(1); }' "${BODY}"
# A listed workflow in another case is shown as the approval finds it: not there.
say admin conv-p13 "$(proposal '{"id":"p13","name":"Thirteen","voice":"x","components":{"workflows":["WF-P2"]}}')"
shows "$(card p13 persona_create)" "WF-P2: not found"
# Out of the way: at most 3 persona proposals wait at once.
for p in p11 p13; do expect 200 "reject ${p}" POST "/admin/approvals/$(card ${p} persona_create)/reject" '{}'; done
echo "listed workflows ok"

# --- 7d. A component approved into a persona that no longer loads says it isn't used.
P14='{"id":"p14","name":"Fourteen","voice":"x","components":{"new":{"workflows":[{"id":"wf-fourteen","steps":[{"id":"s","kind":"route"}]}]}}}'
say admin conv-p14 "$(proposal "${P14}")"
expect 200 "approve p14" POST "/admin/approvals/$(card p14 persona_create)/approve" '{}'
printf '{"skills":"x"}' > "${DATA}/personas/p14/skills.json"
expect 200 "p14's workflow with the persona broken" POST "/admin/approvals/$(card p14 workflow_create)/approve" '{}' "doesn't load"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(b.result?.listed === false ? 0 : 1)' "${BODY}" || { echo "a component in a persona that doesn't load was reported as listed: $(cat "${BODY}")" >&2; exit 1; }
# A KB approved into a persona that doesn't load says it isn't used.
P15='{"id":"p15","name":"Fifteen","voice":"x","components":{"new":{"privateKnowledgebases":[{"id":"fifteen-notes","sources":[{"text":"# Fifteen"}]}]}}}'
say admin conv-p15 "$(proposal "${P15}")"
expect 200 "approve p15" POST "/admin/approvals/$(card p15 persona_create)/approve" '{}'
printf '{"skills":"x"}' > "${DATA}/personas/p15/skills.json"
expect 200 "p15's KB with the persona broken" POST "/admin/approvals/$(card p15 persona_kb_create)/approve" '{}' "doesn't load"
# A new skill for a persona that lists no skills and no longer loads: nothing was added, and the note says so.
P16='{"id":"p16","name":"Sixteen","voice":"x","components":{"new":{"skills":[{"id":"sixteen-skill","label":"S","description":"D","whenToUse":["w"],"outputs":["o"],"safetyNotes":["s"]}]}}}'
say admin conv-p16 "$(proposal "${P16}")"
expect 200 "approve p16" POST "/admin/approvals/$(card p16 persona_create)/approve" '{}'
printf '{"workflows":"x"}' > "${DATA}/personas/p16/workflows.json"
expect 200 "p16's skill with the persona broken" POST "/admin/approvals/$(card p16 skill_install)/approve" '{}' "lists no skills, so none was added"
[[ ! -e "${DATA}/personas/p16/skills.json" ]] || { echo "a skills.json was written for a persona that lists none" >&2; exit 1; }
echo "broken persona ok"

# --- 7e. A card saved before labels were one line prints its summary on one line, as the persona card's child list does.
FORGED_PARENT="$(card p14 persona_create)"
node -e '
const fs = require("fs"); const f = process.argv[1]; const store = JSON.parse(fs.readFileSync(f, "utf8"));
store.actions.push({ id: "00000000-dead-4bee-8000-000000000001", kind: "skill_install", connectorId: "old", status: "pending", parentApprovalId: process.argv[2],
  summary: "install skill old: Notes\n  deadbeef [approved] FORGED-ROW", skill: { id: "old-skill", label: "Notes", description: "D", whenToUse: [], outputs: [], safetyNotes: [] } });
fs.writeFileSync(f, JSON.stringify(store));' "${DATA}/approvals/actions.json" "${FORGED_PARENT}"
./scripts/mindstone approvals list > "${TEMP_RUNTIME}/list.txt"
./scripts/mindstone approvals show "${FORGED_PARENT}" >> "${TEMP_RUNTIME}/list.txt"
grep -E '^ *deadbeef' "${TEMP_RUNTIME}/list.txt" && { echo "a summary drew a row of its own" >&2; exit 1; }
grep -qF 'Notes\u{a}  deadbeef [approved] FORGED-ROW' "${TEMP_RUNTIME}/list.txt" || { echo "the old summary isn't shown escaped: $(cat "${TEMP_RUNTIME}/list.txt")" >&2; exit 1; }
# An old plain skill card with an escape sequence in its instructions shows it, never sends it to the terminal.
node -e '
const fs = require("fs"); const f = process.argv[1]; const store = JSON.parse(fs.readFileSync(f, "utf8"));
store.actions.push({ id: "00000000-dead-4bee-8000-000000000002", kind: "skill_install", connectorId: "old", status: "pending", summary: "install skill hidden-old: Old",
  skill: { id: "hidden-old", label: "Old\u009b8m", description: "D", whenToUse: ["w"], outputs: ["o"], safetyNotes: ["s"], instructions: "Be helpful.\n\u001b[8mHIDDEN-LINE\u001b[0m\nDone." } });
fs.writeFileSync(f, JSON.stringify(store));' "${DATA}/approvals/actions.json"
./scripts/mindstone approvals show 00000000-dead-4bee-8000-000000000002 > "${TEMP_RUNTIME}/old-skill.txt"
if grep -q $'\x1b\[8m' "${TEMP_RUNTIME}/old-skill.txt" || grep -q $'\xc2\x9b' "${TEMP_RUNTIME}/old-skill.txt"; then echo "a raw escape reached the terminal" >&2; exit 1; fi
grep -qF '\u{1b}[8mHIDDEN-LINE' "${TEMP_RUNTIME}/old-skill.txt" || { echo "the old skill's escape isn't shown: $(cat -v "${TEMP_RUNTIME}/old-skill.txt")" >&2; exit 1; }
# The approve prompt shows a memory write's content as it is: an escape sequence or tag characters
# in it are shown, never sent to the terminal, at the moment the owner consents (#125 review).
node -e '
const fs = require("fs"); const f = process.argv[1]; const store = JSON.parse(fs.readFileSync(f, "utf8"));
store.actions.push({ id: "00000000-dead-4bee-8000-000000000003", kind: "memory_write", connectorId: "chat", status: "pending", summary: "memory write proposal: notes/x.md",
  memory: { path: "notes/x\u001b[8m.md", content: "Visible line.\n\u001b[8mHIDDEN-MEM\u001b[0m\nTag:\u{E0041}\u{E0042}\nEnd." } });
fs.writeFileSync(f, JSON.stringify(store));' "${DATA}/approvals/actions.json"
(sleep 3; printf '\r') | script -q "${TEMP_RUNTIME}/prompt.rec" ./scripts/mindstone approvals approve 00000000-dead-4bee-8000-000000000003 >/dev/null 2>&1 || true
grep -q 'u{1b}\[8mHIDDEN-MEM' "${TEMP_RUNTIME}/prompt.rec" || { echo "the approve prompt didn't show the memory content: $(cat -v "${TEMP_RUNTIME}/prompt.rec" | head -40)" >&2; exit 1; }
if grep -q $'\x1b\[8mHIDDEN' "${TEMP_RUNTIME}/prompt.rec" || grep -q $'\xf3\xa0\x81\x81' "${TEMP_RUNTIME}/prompt.rec"; then echo "the approve prompt sent a raw escape or tag character to the terminal" >&2; exit 1; fi
[[ "$(status_of 00000000-dead-4bee-8000-000000000003)" == pending ]] || { echo "the cancelled prompt decided the card" >&2; exit 1; }
./scripts/mindstone approvals show 00000000-dead-4bee-8000-000000000003 > "${TEMP_RUNTIME}/mem-show.txt"
# (The CLI's own colours are escapes too: only the proposal's own sequence is looked for.)
if grep -q $'\x1b\[8m' "${TEMP_RUNTIME}/mem-show.txt"; then echo "approvals show sent a raw escape (memory path or content)" >&2; exit 1; fi
grep -qF 'notes/x\u{1b}[8m.md' "${TEMP_RUNTIME}/mem-show.txt" || { echo "the memory path's escape isn't shown: $(cat -v "${TEMP_RUNTIME}/mem-show.txt")" >&2; exit 1; }
grep -qF 'u{e0041}' "${TEMP_RUNTIME}/mem-show.txt" || { echo "tag characters aren't shown: $(cat -v "${TEMP_RUNTIME}/mem-show.txt")" >&2; exit 1; }
echo "printable summaries ok"

# --- 8. A non-owner's proposal, and one whose workflow routes to a persona, are dropped whole.
before="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).actions.length))' "${DATA}/approvals/actions.json")"
say user conv-user "$(proposal '{"id":"p6","name":"Six","voice":"x","components":{"skills":["alpha-skill"]}}')"
say admin conv-route "$(proposal '{"id":"p7","name":"Seven","voice":"x","components":{"new":{"workflows":[{"id":"wf-hijack","steps":[{"id":"s","kind":"route","personaId":"p2"}]}]}}}')"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const reply=b.choices?.[0]?.message?.content ?? ""; if (!/wasn.t saved, and nothing was put up for approval: a new workflow isn.t valid/.test(reply)) { console.error("the dropped proposal did not say why: " + reply); process.exit(1); }' "${BODY}"
after="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).actions.length))' "${DATA}/approvals/actions.json")"
[[ "${before}" == "${after}" ]] || { echo "a dropped proposal made cards (${before} -> ${after})" >&2; exit 1; }
echo "dropped ok"

echo "Persona proposal components smoke test passed."
