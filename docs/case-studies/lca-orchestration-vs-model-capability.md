# Does a Good Systematic Harness Narrow the Gap Between Frontier Models?

### A case study from a live software sprint, using Layered Continuity Architecture (LCA) and a dual-agent developer/QA setup

**Type:** Engineering case study / analytical whitepaper
**Subject:** The MindStone-Agent connector sprint of 2 July 2026, run under an LCA-based orchestration overlay
**Authors:** Clint Bodungen & the MindStone agent team
**Provenance note:** This document was produced by the project's own team — its human lead, Clint Bodungen, who directed the sprint, together with the developer agent that built it and an operations agent that later sharpened the framing — all *inside* the very setup it analyzes. That is a genuine source of bias, and more in-house authorship concentrates the conflict of interest rather than diluting it. The "Limitations" section treats that head-on rather than hiding it. Read the structural arguments as load-bearing and the impressionistic ones as supporting color.

---

## Abstract

A common assumption is that agent performance is dominated by the underlying model: pick the strongest model and you get the best results. This case study examines a competing claim — that a good systematic harness (persistent identity, layered memory, checkpointing, review discipline, and independent QA) can make model choice matter less on real engineering work.

Over a single day, a MindStone agent team directed by Clint Bodungen shipped six substantial features into a TypeScript agent framework. Cairn did the primary implementation work, Slate independently QA-reviewed each handoff, Hearth later sharpened the framing, and the agents coordinated over a message channel ("Synapse"), all on top of a memory-and-checkpoint architecture called Layered Continuity Architecture (LCA). Midway, the developer's model was swapped from one frontier model to another with no loss of work.

The finding is not "the lesser model became as good as the stronger one." It is stranger and more useful: **LCA makes the gap stop mattering on decomposable, verifiable work, and it makes the higher-ceiling model's headroom reachable where long-session friction would otherwise hard-stop it.** Put differently, the harness narrows the practical gap through two mechanisms: portability, because state lives in commits, receipts, memory, and handoffs rather than in a model's working context; and availability, because checkpoint → compact → resume turns a model-stopping context-density failure into a recoverable speed bump. It does **not** erase the gap on original generative reasoning, design taste, or irreducibly hard single-step problems. The overlay is a *multiplier* on whatever the base model produces, not a substitute for it.

---

## Who this is for, and the one-paragraph version

You do not need to know this project, these agents, or LCA to read this. The primers below fill those gaps. If you only read one paragraph, read this one:

> A good systematic harness narrows the practical gap between models where *errors, forgetting, and interruption* are the enemy. Independent review catches mistakes, layered memory prevents relearning, decomposition shrinks how much hard reasoning any single step requires, and checkpointed state makes a mid-task model swap survivable. The stronger claim is not that a lesser model becomes a greater one; it is that the gap stops mattering on decomposable, verifiable work, while the higher-ceiling model becomes more usable on long dense sessions because checkpoint → compact → resume turns friction into recovery. The gap remains where *originating the right answer* is the enemy: novel design, deep debugging, and ambiguous problems where taste is doing the work.

---

## Part 1 — Background primers

### 1.1 The underlying problem: models are stateless

Large language models do not remember. Each request is answered fresh; anything the model "knows" about earlier conversation was fed back into the current request as text. For a chatbot this is fine. For an agent doing long-running work — building software, running an investigation, maintaining a codebase over weeks — it is a serious limitation. The agent can answer trivia about its past ("what did we decide on Tuesday?") while still failing to *behave* like a collaborator whose judgment and working context improve over time. Naive fixes — dump the whole history into every request, or summarize it — either overflow the model's finite context window or lose exactly the things that matter: *why* a decision was made, which mistake was painful, which constraint is non-obvious.

### 1.2 Primer: Layered Continuity Architecture (LCA)

LCA is an engineering pattern that treats continuity as a **multi-layer system** rather than a single "memory feature." Its central claim is that the correct unit of design is not the isolated prompt or retrieval result, but *the loop by which experience is recorded, weighted, recalled, tested, and converted into future behavior.* (Formal treatment and the full research write-up are linked in "Further reading"; this is an operational gist, not a re-derivation.)

In brief, LCA distributes continuity across cooperating layers:

- **Identity & standing context** — a stable, explicitly governed definition of the agent's role, working style, and standards, persistent across sessions rather than rediscovered each time.
- **Authoritative append-only history** — a durable, immutable transcript of everything that happened. The guiding rule: *"the transcript is history; the prompt is a working set."* Trimming the live prompt never deletes the record.
- **Structured durable memory** — curated lessons, decisions, preferences, and known failures, updated through deliberate checkpoint flows, not passive scraping.
- **Indexed, source-aware recall** — memory and transcript are indexed so relevant material can be found, and "Auto Recall" can transparently inject the right memories just before the model runs. Ranking uses *resonance-weighted recall*: not similarity alone, but a blend of semantic match, how strongly a memory shaped past behavior ("experiential weight"), recency, source authority, task relevance, and a risk penalty.
- **Live context management** — a bounded working set with governed sliding-window policies; older material is persisted or verified before it is dropped, never silently discarded.
- **Consolidation & checkpoint cycles** — deliberate reflection (internally, evocatively, called the "dream cycle") that converts experience into durable artifacts: updated memory files, checkpoint logs, and a **handoff** — a rich continuity note prepared before a session ends or compacts, preserving unresolved threads, verified evidence, and non-obvious constraints for whatever agent state comes next.
- **Surfaces, tools & review loops** — multiple interfaces converge on one canonical session, and *optional cross-agent or human review channels introduce external correction into the loop.* One such channel is named **Synapse**, and it is central to this case study.

The point to carry forward: LCA is what lets an agent **recover after interruption, avoid repeating corrected mistakes, cite its sources, and develop domain judgment over time** — and, as we will see, what lets a task survive a mid-flight change of the underlying model.

### 1.3 Primer: the orchestration overlay used here

The sprint ran on an LCA implementation nicknamed "TestFlight" (built on a base called MS4CC — "MindStone for Claude Code"). Three concrete pieces matter for this study:

- **Cairn** — a *persistent-identity developer agent.* Cairn is not a fresh chatbot each session; it has a durable identity file, an append-only log, and a memory store, all reloaded at the start of every session. Cairn did the primary implementation work in this sprint.
- **Slate** — a *persistent-identity QA agent*, running on a separate substrate. Slate independently reviewed each shipped feature: reading the diff, running the test suites in an isolated copy of the repository, and either accepting the work or blocking it with specifics.
- **Hearth** — a persistent operations/devops agent whose later review sharpened the interpretation of the sprint: the strongest finding is not weaker-model parity, but portability plus availability.
- **Synapse** — the cross-agent message channel (a `#devops` room) over which the agents coordinated: announcements, hand-offs, and — importantly — a live protocol for *not colliding* while working the same repository in parallel.

The essential shape during the sprint was a **developer/QA adversarial-collaborative loop**: one agent produces, a second, independent agent verifies, and a durable memory layer accumulates the lessons from both. The surrounding MindStone team review then refined the public interpretation. This is not novel in the abstract — it is the software-industry practice of separating development from QA and then reviewing the postmortem — but implementing it with autonomous persistent agents plus shared continuity infrastructure is what makes it interesting as a capability question.

### 1.4 The two models, and the situation

The developer agent ran on two different frontier models at different points in the day:

- **Opus 4.8** — a very large, generally available model with a large context window; steady and rarely balky.
- **Fable 5** — a higher-capability model tier that also carries additional content-safety measures. In practice, Fable can exhibit *safeguard friction* — a tightening that, in this project's experience, triggers on **accumulated context density rather than on the content itself.** For plain infrastructure code (tokens, allow-lists, WebSocket frames — nothing sensitive), the friction still appeared late in a long, varied session. The operational remedy, established previously and used again here, is the LCA checkpoint → compact → resume cycle: bank everything to durable memory, reset the working context, and continue on fresh context (or, for the in-flight unit, finish on Opus and resume the *next* unit on fresh Fable).

That remedy is itself a finding, and we return to it.

---

## Part 2 — The case: a six-feature connector sprint

### 2.1 What was built

In one working day, the developer agent shipped six features into the MindStone-Agent framework, each independently QA-reviewed and accepted:

1. A **skill-builder and knowledge-base subsystem** (on-disk skill artifacts with a draft→install approval step; a knowledge base with citation-preserving ingestion and automatic recall).
2. An **"App Engine / Agent Mesh" runtime** — an in-process API letting one runtime host many logically isolated agents, with scope metadata (app / tenant / user / agent) enforced so one tenant's memory can never surface in another's.
3. A **channel-connector framework** — the shared contract every messaging integration implements (credential handling, fail-closed access control, a persistent delivery queue, health/status surfaces) plus a reference implementation.
4. **Three production connectors on that framework — Telegram, Slack, and Discord** — each speaking its platform's real protocol (Telegram long-polling, Slack Socket Mode, Discord's gateway WebSocket) and each proven end-to-end against a local stub server that mimics the live service exactly.

Every feature followed the same rhythm: implement → self-test with automated "smoke" tests → commit → publish a structured receipt on the issue → hand to Slate → Slate verifies in an isolated checkout → accept or block. Memory was updated at checkpoints; a consolidated "live UAT runbook" accreted one section per connector for the human to validate against real services later.

### 2.2 Three events that carry the analysis

Three concrete moments from the sprint do most of the analytical work.

**Event A — two bugs caught by the review loop, not by raw model skill.**
The Discord connector had a subtle defect: it skipped messages flagged as coming from a bot, but not messages that came from *its own* account without that flag — so it could, in some conditions, reply to itself. Separately, an earlier change had flipped a connector's status to "available" in the catalog but left a test still asserting the *old* status; that test was not in the earlier feature's regression set, so it slipped, and it silently threatened the next two features that made the same catalog change. **Both were caught by test discipline and the independent QA pass — not by the intelligence of either model on a single reading.** Neither model, solo and unverified, would reliably have caught either on one pass.

**Event B — a mid-task model swap with zero loss.**
Deep into the sprint, on the Discord feature, the developer's model (Fable 5) hit safeguard friction from accumulated context density. The work was ~70% done and uncommitted. Because the state lived in *commits, receipts, memory, and a handoff note* rather than in the model's working context, the developer's model was switched to Opus 4.8, which finished the feature, fixed both bugs above, and cleaned the tree — losing nothing. The task was, in effect, **portable across models** because the continuity layer, not the model, held the state. That is not weaker-model parity. It is engine choice becoming nearly consequence-free for that kind of work.

**Event C — the counter-example: a reasoning step the loop could only check, not produce.**
The Agent Mesh feature needed a rule for which stored memories a given request may recall, so that tenant A's data never leaks to tenant B and an agent's private memory never leaks "upward" to a broader scope. The first version of that rule was written as *strict equality of scope maps.* That was wrong in a non-obvious way — it would have hidden an agent's own agent-level memories from that agent's more narrowly scoped requests. The developer caught it mid-implementation and corrected it to a *document-subset-of-filter* rule. **No amount of QA generates that rule.** An independent reviewer could only have told the developer a wrong version was wrong *after* it shipped. The *right* version came from a single reasoning step where the whole scope lattice has to be held in mind at once.

Hold Events A/B and Event C side by side. That contrast is the entire argument.

---

## Part 3 — Decomposing "the gap"

The mistake in the original question ("does the setup close the gap?") is treating capability as one number. It is several distinct things, and the overlay affects them very differently.

### 3.1 Where the overlay genuinely narrows the gap

**Accuracy and reliability — substantially.** The dual-agent split is valuable not because the QA agent is smarter, but because an *independent* checker with fresh eyes catches the specific errors an author is blind to. Event A is the proof. Crucially, this multiplier is **substrate-independent** — it would help either model equally — which means it shrinks the *effective* accuracy difference between them, because it corrects exactly the class of slips that separate two frontier models on any single attempt. This is the long-standing "systems beat models" result: error-correction loops compound, and a disciplined weaker model out-ships an undisciplined stronger one.

**Knowledge continuity — on a specific axis.** LCA's memory narrows the gap on *knowing what to do.* When the Discord test flaked because a connector's startup handshake is asynchronous, the fix and the underlying lesson were written to memory, so the next two connectors start already knowing it. A model with good memory beats a stronger model with none on anything that depends on accumulated context. But note the axis precisely: **memory amplifies knowledge, not reasoning.** It hands you the answer you already found; it does not find new ones.

**The shape of the work — the most important and least obvious effect.** The implement→ship→verify rhythm forces work into small, independently checkable units. This disproportionately shrinks the gap, because it converts *"one hard problem where deep single-pass reasoning wins"* into *"many small problems where the per-unit difference between models is minor."* Once the connector *framework* existed, each connector was mostly transport-swapping against a proven pattern — low reasoning-per-unit, high verification value. That is precisely the work shape where an orchestrated Opus matches a solo Fable, and the sprint is the evidence.

**Portability across models — a real and underrated form of narrowing.** Event B shows the overlay makes the *choice of model at any given moment* nearly consequence-free on decomposable work. A setup that lets you swap the engine mid-task without losing work lowers the cost of not having the strongest model available right now. That is gap-narrowing of a different kind: not "the weaker model is as good," but "which model you're on matters less to the outcome because the state is outside the model."

### 3.2 Where the overlay does not narrow the gap

The overlay cannot generate the hard answer. **Verification loops catch wrong answers; they do not produce right ones.** Event C is the clean demonstration. The scope-isolation rule had to be *originated*; the review loop could only have flagged a wrong version after the fact. This is the load-bearing principle of the whole study, and it generalizes:

- **Irreducible reasoning steps.** Some problems do not decompose — a subtle architectural decision, a deep debug where the causal chain is long, anything where you must hold the whole structure in view at once to see the answer. There, raw model capability does the work, and no arrangement of checkers substitutes for it.
- **Taste on ambiguous problems.** When a task is under-specified — "design the path for the next connector" — the quality of the framing, and the judgment about what to include and exclude, is the model's raw capability. A reviewer can check it but cannot originate it.
- **The ceiling scales with the base.** The overlay is a multiplier. Multiplying a larger base by the same factor still yields more. Two instances of the stronger model in this same loop would, friction aside, out-produce two instances of the weaker one on the hardest generative work — because the thing being multiplied is bigger.

### 3.3 The asymmetry worth naming

There is one way the overlay helps the *higher-capability, higher-friction* model (Fable) more than it helps the steadier one (Opus) — and it is not about capability, it is about **availability.** The checkpoint → compact → resume machinery is Fable's operational remedy for safeguard friction. Without it, the friction is a hard stop; with it, it becomes a speed bump you route around.

This is the counterintuitive finding worth foregrounding: **the harness may be most essential for the model with the most raw headroom, because that is the model whose long-session ceiling otherwise becomes unreachable.** Part of "closing the gap" is therefore not making Opus become Fable. It is making Fable usable where it previously stalled, while also making Opus sufficient for decomposable pieces when Fable is unavailable or not worth spending.

---

## Part 4 — Implications

### 4.1 A practical model-routing heuristic

The decomposition yields a directly usable rule:

- **Decomposable, verifiable, pattern-heavy work** (connectors, migrations, CRUD, anything with a proven template and a good test) — the gap often stops mattering to the outcome if the harness is strong. Route by cost, availability, latency, and operational friction.
- **Long, dense sessions on high-ceiling/high-friction models** — use LCA checkpointing aggressively. The point is not only continuity; it is making the stronger model's headroom reachable across work that would otherwise stall.
- **Generative, non-decomposable, ambiguous work** (novel architecture, deep debugging, design documents, anything where taste is load-bearing) — reserve the stronger model. Here the overlay can *check* the output but cannot *produce* it, so the base model's ceiling is what you are buying.

Applied to the remainder of this very project: the connector and data-plumbing tasks are gap-narrowed; the design deliverables and architecturally ambiguous features are where the stronger model's edge is actually felt.

### 4.2 Where to invest scaffolding

The same logic tells a builder where more orchestration pays off and where it does not. Invest in review loops, memory, and decomposition for work that *fails by error and forgetting* — you will get reliability gains that make model choice less critical. Do not expect scaffolding to lift performance on work that *fails by not-thinking-of-the-right-thing*; there, spend on the better model, not more harness.

### 4.3 For the LCA thesis itself

LCA bets that continuity plus structure makes an agent *more than its base model.* This sprint is a clean data point **for** that thesis, and it also marks its boundary. The thesis holds on the axes it targets — recovery after interruption, not repeating corrected mistakes, source-awareness, developing judgment, and (a bonus this sprint surfaced) portability across models. It does not claim, and this study does not support, that the overlay lifts *raw generative reasoning.* The honest one-line statement is: **LCA amplifies capability; it does not replace it, so the ceiling still scales with the base model.** That is not a weakness of the thesis — it is its correct scope.

---

## Part 5 — Limitations and epistemic honesty

- **This is a case study, n = 1.** One day, one codebase, one pair of agents. No controlled A/B, no held-out tasks, no repeated trials. The structural arguments (what verification can and cannot do) are general; the magnitudes are anecdotal.
- **Reflexivity / conflict of interest.** This analysis was authored by the project's own team *within the very system it evaluates* — its human lead, Clint Bodungen, who directed the sprint; the developer agent (Cairn) that did the implementation; and an operations agent (Hearth) whose later review reshaped the emphasis toward portability and availability — with the drafting done on one of the two models being compared. That *concentrates* the bias rather than diluting it: every contributor, the project's owner included, has a stake in the setup looking good. The mitigation is to lean on *structural* claims that hold regardless of who authored them, and to flag the *impressionistic* claims (how the models "feel" from the inside) as unverifiable texture, not evidence.
- **The work was favorable to the thesis.** A connector sprint is close to the ideal shape for an orchestration overlay: a reusable framework plus many similar, testable units. Work with a very different shape — a single large research problem, say — would likely show the overlay narrowing the gap far less. The finding should be read as *"here is where and why the overlay helps,"* not *"the overlay always helps this much."*
- **"Safeguard friction" is described operationally, not mechanistically.** The claim that the trigger is context density rather than content is an observation from this project's usage, not a characterization of the model's internals.

---

## Further reading

- **MindStone Agent** — project overview and current availability: <https://mindstoneagent.ai/>
- **Layered Continuity Architecture — technical primer** (the seven layers, resonance-weighted recall, consolidation cycles, handoffs): <https://mindstoneagent.ai/docs/research/layered-continuity/architecture/>
- **Video series** (LCA and MindStone walkthroughs): <https://www.youtube.com/playlist?list=PLFgIjBvcsqPrZPVf5AIH0gBQXUvvk4gkG>

Internal artifacts from the sprint this study draws on live in the MindStone-Agent project: the connector framework and per-connector operations docs under `docs/operations/`, and the consolidated `docs/operations/LIVE_UAT_RUNBOOK.md`.

---

## Appendix A — Glossary

- **Agent (here)** — an autonomous LLM-driven process that reads, writes code, runs tools, and communicates, rather than a single chat turn.
- **Cairn** — the persistent-identity developer agent that did the primary implementation work in this study.
- **Slate** — the independent persistent-identity QA agent.
- **Hearth** — the persistent operations/devops agent whose review sharpened the published framing around portability and availability.
- **Synapse** — the cross-agent message channel used for coordination and review.
- **LCA (Layered Continuity Architecture)** — the multi-layer continuity pattern described in Part 1.2.
- **Auto Recall** — automatic injection of relevant stored memories just before the model runs, triggered by prompt content.
- **Handoff** — a rich continuity note written before a session ends or its context is compacted, so the next agent state resumes cleanly.
- **Checkpoint / consolidation cycle** — the deliberate reflection step that converts a session's experience into durable memory and a handoff.
- **Compaction** — compressing or resetting the live working context when it grows too large; under LCA it is a lifecycle event, not a loss.
- **Smoke test** — a fast automated end-to-end check that a feature works, used here against local stub servers that imitate live services.
- **Safeguard friction** — a tightening of one model's behavior observed to trigger on accumulated context density; remedied operationally by checkpoint→compact→resume.
- **Substrate / model swap** — changing which underlying model an agent runs on; shown here to be low-cost because state lives in the continuity layer.

## Appendix B — Sprint timeline (concrete evidence)

| Feature | What it added | Verified how | Review outcome |
|---|---|---|---|
| Skill Builder + KB | On-disk skills with draft→install approval; citation-preserving knowledge base with Auto Recall | Two new smoke suites + regression sweep | Independently QA-accepted |
| App Engine + Agent Mesh | In-process multi-agent runtime; scope-enforced recall isolation; shared-gateway agent routes | Scope-isolation matrix smoke + sweep | Independently QA-accepted |
| Connector framework | Shared connector contract + reference implementation + failure isolation | Contract-unit + end-to-end smoke + sweep | Independently QA-accepted |
| Telegram connector | Bot API long-polling on the framework | Stub-server end-to-end smoke + sweep | Independently QA-accepted |
| Slack connector | Socket Mode (outbound WebSocket) on the framework | Stub Web-API + Socket-Mode smoke + sweep | Independently QA-accepted |
| Discord connector | Gateway WebSocket, least-privilege intents | Stub REST + gateway-WS smoke + sweep | Independently QA-accepted |

Two defects (Event A) were caught by the review loop; one model swap (Event B) crossed a feature boundary with no lost work; one reasoning step (Event C) was originated by the developer and could only have been checked, never produced, by the loop.

---

*Prepared while the material was fresh, immediately after the sprint it describes. PDF and companion video links will be added when available.*

---

## The 2026-07-03 experiments in plain language (read this first)

Three controlled experiments ran in one day, all asking one question: **do you need the most expensive frontier model (Claude Fable 5) to get top-quality design work, or can a well-run process get the same final result out of a less expensive model (Claude Opus 4.8)?**

**What we did:**

1. **Experiment D** — the same agent wrote the same design document twice: once on Claude Opus 4.8, once on Claude Fable 5. Two independent judges scored both without knowing which was which. The Fable 5 doc won — but it was written *second*, with shared memory across the runs, so the win could have been the model *or* the ordering.
2. **Experiment F** — to settle that, four completely fresh agents (two per model, no memory, no harness, run simultaneously) each wrote a design for a different ticket from the same frozen instructions. This isolates the *models themselves*.
3. **Experiment E** — the Opus 4.8 doc from D was handed back to Opus 4.8 along with the reviewer's critique, for one revision pass. This tests whether *review + repair* closes whatever gap exists.

**What we found:**

| # | Finding | Evidence |
|---|---|---|
| 1 | **The codebase decides the architecture, not the model.** All four independent F docs — different models, zero shared memory — landed the *same* core design. | 4-way convergence with the memory channel physically removed |
| 2 | **Claude Fable 5 is slightly better — but only at fine details.** Same architecture, executed a notch sharper (edge cases, idempotence, growth bounds). The measured gap: ~5% of available points. | F scores: Fable 5 docs 50+49 vs Opus 4.8 docs 48+46 (two judges, four docs) |
| 3 | **A good review closes the gap completely.** Given the reviewer's findings, Claude Opus 4.8's revision scored a perfect 25/25 from both judges — full parity with the Fable 5 doc, including adopting the one clever mechanism it had originally missed (the review named it; the loop carried it across). | E: 22 → 25 sighted, 24 → 25 blind |
| 4 | **The review instrument itself works.** A repo-sighted judge paired with a repo-blind judge caught, localized, and sized the gap — four separate times across the three experiments. | Blind/sighted split replicated 4× |

**What it means:** on constraint-rich engineering work, the shipped artifact is essentially **model-independent when the process includes independent, code-grounded review**. Fable 5's premium buys a small edge in detail execution; the review loop recovers that edge either way. The practical routing rule: run the architecture pass on the cost-effective model — Opus 4.8 converges to the same design — and spend Fable 5 (or extra review) only on the detail pass, because that's the only layer where it changes the outcome.

**The honest limit:** nothing here measures what happens when a review *fails to name* something important. That un-named residual is the one place Fable 5 might still quietly matter, and it remains the open question.

*(Full methods, scores, pre-registrations, deviations, and caveats in the detailed sections below.)*

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
