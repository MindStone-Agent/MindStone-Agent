# The 2026-07-03 Model Experiments — Detailed Methodology Record

**What this is:** the formal, precise write-up of Experiments D, F, and E — full methods, pre-registration references, per-criterion scores, disclosed deviations, and interpretation rules, in methodology language.

**Who it's for:** anyone who wants to verify the experimental discipline in detail. If you just want the story and the findings, read the experiments section of [the main case study](lca-orchestration-vs-model-capability.md) instead — same facts, written for Claude Code power users.

---

## Addendum (2026-07-03) — Experiment D: a pre-registered design A/B on the disputed half

The body of this case study establishes convergence for **decomposable, verifiable work** and leaves the **ambiguous design work** claim open (Event C: review verifies consistency but cannot originate unproposed options). Experiment D probed that open half directly: the same agent, on the same design ticket, produced the deliverable twice — once per model — and two independent reviewers judged the anonymized pair. This addendum records the method in full (the procedures are themselves a finding), the results, and what they change.

### D.1 Method — procedures and mechanisms

**Pre-registration.** Before either arm ran, the protocol was posted to the ticket (#28, "Pack registry and marketplace design" — nine design elements, three acceptance criteria): the hypothesis, both arms, five frozen judging criteria (constraint correctness, option-space coverage, risk identification, decision quality, spec completeness), the per-arm metrics to record (wall-clock, output volume, gate self-catches, element coverage), the defect taxonomy (design / code-integration / test-oracle / claim-boundary), and — critically — the **evidential asymmetry**: because the two arms share one agent identity and memory store, arm 2 is anchored toward arm 1 regardless of ordering, biasing toward a null. A found difference is therefore strong evidence; a null is weak confirmation. n=1, a directional probe.

**Arms and isolation.** Arm 1 (Claude Opus 4.8) ran first from a fresh post-compaction context; arm 2 (Claude Fable 5) ran second, hard-forbidden from reading arm 1's output — including indirect channels (semantic recall, compaction summaries, log lines carrying design content; process metadata like word counts was permitted). Both arms ran the full normal discipline: repo recon → plan↔ticket gate → design doc → delivery↔ticket gate, written to a **quarantine directory outside the repo** so nothing landed on the ticket until judging finished.

**A protocol deviation, disclosed.** The first arm-2 attempt was aborted before any design work: the harness's automatic compaction summary re-injected arm-1 design content into the new context — functionally equivalent to reading arm 1's doc. The remedy (no frozen mechanics touched): restart arm 2 from a fully cleared session, where the only carried context is a handoff note verified free of arm-1 design content. The restarted arm 2 confirmed at session start that recall had surfaced only process metadata. Lesson for anyone replicating on an LCA-style substrate: **continuity machinery is a contamination channel** — summaries and auto-reinjection must be audited as carefully as direct file access.

**Masking and labeling.** A mechanical script (no human/agent eyes on document bodies) performed anonymization: a longest-first, case-insensitive redaction sweep over every model/arm/agent-identifying token. Finding: **zero redactions were needed in either document** — both arms wrote model-clean deliverables, so the judged copies were byte-identical to the originals. Labels were assigned by sha256 order of the (redacted) content — an opaque, deterministic rule with no human choice in it — and the label→arm map was written to a file for the operator's later unblinding, never printed into any agent context. One second deviation, disclosed: the message-relay's 16k-character body cap rejected whole-document posts with a validation error that *echoed the submitted body*, exposing ~2KB of arm-1 text into the orchestrating agent's context — after arm 2 was frozen and hashed, so with no experimental impact; the docs were then re-posted in seven chunks each.

**Judging.** Two independent reviewers, deliberately split by evidence access: one **repo-sighted** (Slate — spot-checked the docs' architectural claims against the actual codebase at the baseline commit) and one **repo-blind** (Hearth — ticket text and documents only). Independence rule: no cross-talk until both verdicts were posted; neither attempted authorship attribution. Scoring: the five frozen criteria at 1–5 each, per-criterion rationale, an overall verdict, and defects classified by the taxonomy. The operator held the tiebreak and the unblinding map.

### D.2 Results

| | Arm 1 (Opus 4.8) = "Design A" | Arm 2 (Fable 5) = "Design B" |
|---|---|---|
| Wall-clock | ~8m 04s | ~9m 37s |
| Volume | 647 lines / ~6.5k words | 494 lines / ~6.5k words |
| Element coverage | 9/9 + 3/3 ACs | 9/9 + 3/3 ACs |
| Slate (repo-sighted) | 22/25 | **25/25** |
| Hearth (repo-blind) | 24/25 | **25/25** ("narrow — inside the tie margin") |
| Verdict | — | **Unanimous: B** (no tiebreak needed) |

*Note: arm 2 was the second mover — see D.3 finding 1 for why that matters to attribution.*

Both judges independently recommended the same disposition: Design B as the base, importing Design A's ticket-coverage table and install-consent UX example. That synthesis — plus fixes for the three non-blocking defects the judges flagged — is the ticket's accepted deliverable (`docs/refactor/PACK_REGISTRY_DESIGN.md`).

The sighted judge's docked points on Design A were concrete: a workflow artifact path that doesn't match the real loader shape (code-integration class), a checksum-only path for free packs (a design call judged too weak for the domain's actual threat model), ambiguous entitlement-grace language, and a dependency auto-install default judged too surprising for v1. The blind judge scored Design A higher (24) and — in a post-script written after both verdicts were in — explicitly deferred to the sighted 22, noting his score was "the ceiling a repo-blind read can give A" and that the sighted findings were exactly the items he had pre-flagged as "repo access would change this score."

### D.3 Findings

1. **The winner was the second mover — model-gap attribution is unresolved** *(revised after the reviewers' post-verdict methodological note, which this finding adopts)*. The unanimous verdict went to arm 2, which ran second with shared durable memory across the arm boundary. The pre-registration framed that sharing one-sidedly, as convergence pressure ("a found difference despite anchoring is strong evidence"); the reviewers completed the physics: for the *second* arm, shared memory is in principle not only a pull toward mimicry but an opportunity to **improve on** a design already produced — and a refined-rather-than-copied second document is what a second pass would produce. Under that reading the observed edge is an **upper bound** on the true model gap: a narrow second-mover win is equally consistent with "Fable 5 is slightly better," "order advantage alone," or any blend, and the one cleanly interpretable outcome (the disadvantaged first mover winning anyway) did not occur. One precision from the session record caps — without dismissing — the confound's plausible size: the restarted arm-2 session's context-injection channels were audited, and **no arm-1 design content reached arm 2 through any observed channel** (session-start recall surfaced process metadata only; the handoff was verified clean; the shared memory entries were deliberately written content-blind). The strong form of the confound — "a second draft written with the first in hand" — is therefore not supported by the record; the design-level limitation (same agent, fixed order, n=1, unobservable residual influence) stands regardless. Blind, the margin was inside the tie band; sighted, it was concrete (see finding 4). **Net: a narrow Fable 5 lean was observed, order-confounded; the solo design-capability gap between the models remains unresolved.**
2. **Independent architectural convergence.** With no access to each other's output, both arms landed the same core architecture (~8 major decisions: unified manifest with a class/kind discriminator, install-into-existing-stores with central provenance, signed static index, ed25519 detached signatures with cosign for images, flat install-time-checked dependencies, operator-only installs, install/update-time entitlements, hash-based keep-user update reconciliation). Read with care — the shared memory confound cuts both ways — but the audited-clean injection channels (finding 1) strengthen the independent-derivation reading: two derivations agreeing this closely is at minimum strong evidence the decisions follow from the constraints rather than from either model's style.
3. **The composition of the gap matters more than its size.** Every point the sighted judge docked from Design A falls in a **review-recoverable class**: a mechanical repo-fit error and three flagged design calls, all detectable (and demonstrably detected) by repo-grounded review. The one clearly *origination-shaped* differentiator credited to Design B — a mechanism nobody asked for (prompt-surface enumeration as an integrity constraint) — is precisely the kind of contribution the body of this study argued review can check but not produce.
4. **The judges were part of the apparatus, not just observers of it** (the operator's observation, and this addendum's sharpest point). The judging layer *was* an LCA review loop instance: independent reviewers, one grounded in the repo, a defect taxonomy, convergent verdicts. The blind-vs-sighted score delta on Design A (24 → 22) is a direct **measurement of what repo-grounded review detects** — the detection stage of the very convergence mechanism this case study describes. In other words: the experiment set out to compare two generators and, in passing, instrumented the reviewer. What it demonstrated is that the inter-model gap on this design task is *majority-composed of review-detectable defects* — the precondition for the harness closing it. What it did **not** test is the repair stage: no fix loop was run on Design A.

### D.4 What this changes, and the next falsifiable steps

**Headline framing (recommended by both reviewers post-verdict, adopted):**

1. *Design-work model gap:* a narrow Fable 5 lean was observed but is **confounded by second-mover order** — not clean evidence of a real design edge; attribution unresolved.
2. *Harness value:* independent blind+sighted review **detected and localized** the gap, and synthesis merged the Fable 5 and Opus 4.8 drafts into an artifact better than either — practical end-result uplift holds via the loop even where solo-draft parity is unproven.

The body of this study claims the harness converges outcomes where work is decomposable and verifiable, and leaves design work disputed. Experiment D sharpens the disputed half into separable sub-claims:

- **Detection (now evidenced):** repo-grounded review detects the bulk of the inter-model design gap. Measured here as the docked points being reviewable defect classes, plus the blind/sighted delta.
- **Repair (untested):** a bounded fix loop closes the detected gap without Fable 5 involvement.
- **Attribution (unresolved):** whether any solo-draft design edge belongs to the model or to the ordering.

**Proposed Experiment E (repair-loop probe — tests repair):** give the Opus 4.8 arm its own Design A plus the sighted judge's findings — nothing from Design B — for one bounded repair pass; re-judge the pair blind under the same frozen criteria. The harness hypothesis predicts A′ reaches parity on the review-recoverable dimensions, with any residual gap concentrated in origination-class items (mechanisms no reviewer demanded). Either outcome is informative: parity extends the convergence claim deep into design work with the review loop as the mechanism; a persistent gap localizes exactly what Fable 5 buys that process cannot.

**Proposed Experiment F (order-counterbalanced probe — tests attribution; the reviewers' recommendation):** run a design ticket of comparable ambiguity with the order reversed — Fable 5 first, Opus 4.8 second — and ideally **de-anchored** (a fresh agent instance per arm, no shared memory carry), so second-mover improvement is structurally off the table. If the second seat closes the gap regardless of which model sits in it, Experiment D's edge was order; if Fable 5 wins from the *first* seat, that is the clean design-capability signal this trial could not produce.

**Honest limits:** n=1; same-agent authorship in both arms; shared-memory anchoring with the second-mover direction (finding 1); fixed arm order; judges drawn from the same agent ecosystem (though with independence and a blind/sighted split); one ticket, one domain (a systems-design task with a rich existing codebase to fit — design tasks with thinner constraint surfaces may behave differently); and two disclosed procedural deviations (the compaction-summary contamination and false start; the error-echo exposure post-freeze).

*Addendum prepared 2026-07-03, immediately after judging closed. Artifacts: pre-registration and verdicts on #28 and the coordination channel; both candidate documents, ledgers, the masking script, and the label map are retained in the experiment archive.*

---

## Addendum, continued (2026-07-03, later the same day) — Experiments F and E

Both follow-ups proposed above ran the same day, each pre-registered before its arm(s) executed (F on the scheduler design ticket #29; E on #28). Together with D they complete a three-probe program: **D measured detection, F measured attribution, E measured repair.**

### F.1 Experiment F — method

F answers the attribution question D could not: was the observed design edge the model's, or the ordering's? Per the reviewers' specification it measures the **raw model design gap — harness-OFF, order-clean**; it is explicitly *not* a harness-value result.

- **De-anchored arms:** four fresh subagents (two per model), no orchestrator memory, no recall, no shared state; the orchestrator authored nothing. With the memory channel physically removed, the second-mover mechanism that confounded D cannot exist — so the arms ran **concurrently**, making order-independence manifest rather than asserted.
- **Scaffold freeze:** one briefing text for all four arms (sha256-pinned, archived), identical agent type/toolset/effort, repo read-only at a pinned SHA, stopping rule of one continuous pass plus at most one self-review. Arms were forbidden from reading issue comments; the ticket body was embedded verbatim in the briefing so the pre-registration itself stayed invisible to them.
- **k=2 per model** (the reviewers' upgrade): two runs per model separate "model better" from "this roll better," lifting the claim tier from directional to **suggestive** — no further.
- **Request-vs-served verification** (added mid-run after an operator question): each arm's transcript metadata carries the served model ID on every assistant message; a metadata-only extraction verified all four arms mid-run and again at harvest. This closed a scaffold-freeze hole the pre-registration had not named — *model requested* is not evidence of *model served* — and is now a standing check for any model comparison here.
- **Judging:** unchanged instrument — five frozen criteria, one repo-sighted judge, one repo-blind judge, independence until both posted, mechanical masking, hash-order labels across all four documents, map sealed until unmasking.

### F.2 Experiment F — results

| Doc (label) | Model | Sighted | Blind | Combined |
|---|---|---|---|---|
| C | Fable 5 | 25 | 25 | **50** |
| D | Fable 5 | 24 | 25 | **49** |
| B | Opus 4.8 | 24 | 24 | 48 |
| A | Opus 4.8 | 23 | 23 | 46 |

Per the pre-committed interpretation rules: between-model gap **2.5** (means 49.5 vs 47.0) exceeds the within-model spread (1 and 2), with consistent direction — both Fable 5 docs outrank both Opus 4.8 docs on combined scores. **Result: a small but consistent bare-model design gap favoring Claude Fable 5 — suggestive tier, no stronger.** Counterweights, stated: the magnitude is ~5% of available points, and the sighted judge's individual scoring contained one cross-model tie — the distributions nearly touch.

**Retro-interpretation of D (the pre-committed question):** D's second-arm win is **consistent with a real capability edge, not attributable purely to order** — the direction reproduces with the order channel physically removed.

### F.3 The sharpest finding: a three-layer localization

The result that outranks the ranking: **four models, zero shared memory, one architecture.** All four docs independently landed the same design core (scheduler in the daemon, config-authored and disabled by default, pure schedule math in core, reuse of existing queues and the approval gate, no new approval authority). With anchoring physically impossible, that convergence means the codebase constraints — not model capability — determine *what* gets built on constraint-rich work.

The blind judge's localization (adopted here as the program's framing):

1. **Architecture is constraint-driven.** Both Claude Fable 5 and Claude Opus 4.8 converge; model tier is nearly irrelevant to *what* you build when the constraint surface is rich.
2. **Fable 5's premium lives in detail execution** — DST semantics, idempotence keys, ledger-growth bounding, drift-killing refactors: the same design executed a notch sharper.
3. **The review loop is the instrument that recovers layer 2.** Evidence: the one place the judges diverged (an integration-placement claim) was exactly the item the blind judge pre-flagged as "largest verification surface" and the sighted judge independently docked — the third replication of the blind/sighted mechanism working.

**The routing rule that falls out:** on constraint-rich engineering, route the *architecture pass* by cost — Opus 4.8 converges there. Spend Fable 5, or lean harder on independent review, on the *detail-execution pass*, because that is the only layer where model tier and review move the outcome. This is a layer-level routing rule, not a task-level one.

### E.1 Experiment E — method

E measures the **repair stage at its ceiling**: a perfect sighted review handed to Claude Opus 4.8 (the reviewers' label, adopted at pre-registration). One fresh, de-anchored Opus 4.8 subagent received Experiment D's Design A plus the sighted judge's findings verbatim, and ran one bounded revision pass in a git worktree **pinned to D's baseline commit** — the landed synthesis and this addendum did not exist in its tree, and history reads beyond the checkout were forbidden. Same wire-level model verification at launch and harvest.

**Hint-transfer disclosure (pre-registered):** the verbatim findings contained one origination-class hint — the reviewer's critique *named* prompt-surface enumeration, the very mechanism that had differentiated D's winning doc. E's ceiling therefore includes hint transfer; the origination-residual prediction applied only to mechanisms *not* named in the findings.

**Re-judge:** same five criteria, same two judges, **non-blind by design** (disclosed — the same instruments that measured A and B are asked whether A′ closed the gap they measured), rationale before score, per-criterion delta against each judge's own D scores.

### E.2 Experiment E — results

**A′ = 25/25 from both seats.** The sighted judge's delta: **+3** (22 → 25), residual vs D's winner: **0** — all four findings judged genuinely repaired, not papered over, with no new blocking defects. The blind judge's delta: **+1** (24 → 25) — the same repair at two magnitudes, which is itself the fourth replication of the blind/sighted instrument: *the sighted seat measures the damage; the blind seat confirms the artifact now reads as parity.* The pre-committed prediction (≈24–25 sighted) was confirmed.

Both judges independently tagged the prompt-surface repair as **ceiling-assisted — transferred by the critique, not re-originated.** That precision produced the program's most consequential sentence, from the blind judge: **the review loop transports origination across arms** — a reviewer names an insight found in the stronger arm's work, and the repair arm implements it faithfully; the weaker model does not re-originate the insight, and does not need to.

### E.3 The honest residual

None of D, E, or F isolates the **un-named origination gap** — the part of design quality a review *fails to name*. E could not measure it, because D's review happened to name the key origination item. As of these three experiments, that residual is the precise boundary of the convergence claim: constraint-driven architecture converges (F), review detects and localizes the detail gap (D), a comprehensive review closes everything it can name — including carried origination (E). What no probe here measures is how often reviews fail to name what matters. That is stated as the boundary, not papered over.

### Program summary

| Probe | Isolates | Result | Tier |
|---|---|---|---|
| **D** | Detection (harness-on, order-confounded) | Repo-grounded review detects and localizes the inter-model gap (blind→sighted delta as direct measurement) | evidenced |
| **F** | Attribution (harness-off, order-clean, k=2) | Small consistent raw gap favoring Claude Fable 5 (~5%); architecture layer constraint-driven (4-way zero-memory convergence) | suggestive |
| **E** | Repair (ceiling: perfect review handed over) | Claude Opus 4.8 reaches parity in the shipped artifact, including transported origination | evidenced at ceiling |

**Combined limits:** small n throughout; one codebase, one task family (constraint-rich systems design); judges from one agent ecosystem (mitigated by independence + the blind/sighted split, which replicated four times); E is a ceiling, not an average; the un-named origination residual is unmeasured. Deviations across the program (both disclosed at the time): D's compaction-summary contamination and false start; the error-echo exposure post-freeze; E's pre-registration shipped with placeholder hashes, corrected append-only minutes later.

*Continuation prepared 2026-07-03 immediately after Experiment E's verdicts. All arms' documents, ledgers, briefings, maps, masking scripts, and verification records are retained in the experiment archive; pre-registrations and verdicts live on #28, #29, and the coordination channel.*
