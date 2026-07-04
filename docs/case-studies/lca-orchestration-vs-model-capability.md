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

The sprint ran on a MindStone/LCA implementation built on MS4CC — "MindStone for Claude Code." Three concrete pieces matter for this study:

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

Four controlled experiments asked one question from several angles: **can a well-run MindStone/LCA review workflow process get Claude Opus 4.8 into the Claude Fable 5 quality band on real shipped work?**

**What we did:**

1. **Experiment D** — the same agent wrote the same design document twice: once on Claude Opus 4.8, once on Claude Fable 5. Two independent judges scored both without knowing which was which. The Fable 5 doc won — but it was written *second*, with shared memory across the runs, so the win could have been the model *or* the ordering.
2. **Experiment F** — to settle that, four completely fresh agents (two per model, no memory, no harness, run simultaneously) each wrote a design for a different ticket from the same frozen instructions. This isolates the *models themselves*.
3. **Experiment E** — the Opus 4.8 doc from D was handed back to Opus 4.8 along with the reviewer's critique, for one revision pass. This tests whether *review + repair* closes whatever gap exists.
4. **Experiment G** — bare Claude Fable 5, bare Claude Opus 4.8, and harnessed Claude Opus 4.8 each built the same greenfield browser music app, LoopSmith Studio, from the same frozen prompt. This tests whether the MindStone/LCA review workflow can move Opus into the Fable 5 quality band on shipped greenfield work.

**What we found:**

| # | Finding | Evidence |
|---|---|---|
| 1 | **The codebase decides the architecture, not the model.** All four independent F docs — different models, zero shared memory — landed the *same* core design. | 4-way convergence with the memory channel physically removed |
| 2 | **Claude Fable 5 is slightly better — but only at fine details.** Same architecture, executed a notch sharper (edge cases, idempotence, growth bounds). The measured gap: ~5% of available points. | F scores: Fable 5 docs 50+49 vs Opus 4.8 docs 48+46 (two judges, four docs) |
| 3 | **A good review closes the gap completely.** Given the reviewer's findings, Claude Opus 4.8's revision scored a perfect 25/25 from both judges — full parity with the Fable 5 doc, including adopting the one clever mechanism it had originally missed (the review named it; the loop carried it across). | E: 22 → 25 sighted, 24 → 25 blind |
| 4 | **The review setup itself works.** A judge with repo access paired with a judge without it caught, localized, and sized the gap — four separate times across the first three experiments. | Blind/sighted split replicated 4× |
| 5 | **On greenfield shipped work, the harness moved Opus into the Fable 5 quality band.** Bare Opus produced a good app but trailed on shipping-quality/discipline; harnessed Opus landed with the top artifacts. | G: Birch/Opus-harnessed 100/98; Maple/Fable-bare 99/97; Cedar/Opus-bare lower under Clint+Slate discipline-weighted scoring |

**What it means:** on real engineering work, the shipped artifact can become much less dependent on the top-tier model when the process includes independent, code-grounded review. Fable 5's premium buys an edge in detail execution and shipping quality; the review loop can recover much of that edge. The practical routing rule: use Opus 4.8 confidently when strong constraints and review exist, and spend Fable 5 (or extra review) where missed details, ambiguous calls, or final shipping hygiene matter most.

**The honest limit:** nothing here proves models do not matter, or that Opus 4.8 has equal raw capability to Fable 5. The evidence is for a harness/productivity claim: a serious MindStone/LCA review workflow loop can move Opus into the Fable 5 shipped-result band on these tasks. What happens when review fails to name something important remains open.

---

## How we actually ran it — the full story, for people who want to check our work

*(Prefer the formal methodology write-up — full pre-registration detail, per-criterion scores, and interpretation rules in precise language? It's preserved in [the detailed record](lca-experiments-2026-07-03-detailed.md). Same facts, different register.)*

Everything below happened on 2026-07-03, live, on this repo. The agents involved: **Cairn** (the persistent dev agent, who ran the experiments), **Slate** (independent QA agent, judged with repo access), and **Hearth** (independent ops agent, judged from the documents alone). Every experiment's rules and predictions were posted to the GitHub ticket *before* it ran — so nobody could move the goalposts after seeing results. The scoring rubric was the same five things every time: does it fit the real codebase, did it genuinely weigh alternatives, did it catch the risks, are the decisions right, and could a developer actually build from it. Each scored 1–5, so 25 is a perfect doc.

### Experiment D — same agent, both models, judged blind

Cairn wrote the design doc for the pack-registry ticket (#28) twice. First run: Claude Opus 4.8, fresh context. Second run: Claude Fable 5, fresh context, hard-forbidden from reading the first doc. Both docs were then scrubbed and labeled by a script (no one read them during masking — the labels came from content hashes), and handed to the judges. The judges couldn't talk to each other until both verdicts were up.

**Two things went wrong, and they're worth knowing about if you run agents on Claude Code:**

- The first attempt at run two had to be thrown away before it started. Claude Code's own **compaction summary** carried pieces of the first doc into the new context — the continuity machinery that makes a persistent agent useful is also a leak channel. The fix: restart from a fully cleared session where no summary exists. If you ever need two runs to be genuinely independent, `/compact` is not enough; `/clear` is.
- When we posted the docs to our message channel for judging, the server's 16,000-character limit rejected them with an error that **echoed the entire rejected document back** — leaking quarantined content into the orchestrator's context. Harmless here (the second doc was already finished and hashed), but a real gotcha: oversized posts of sensitive content can bounce back at you through error messages.

**The scores:** Slate (repo access): Opus doc 22/25, Fable doc 25/25. Hearth (doc-only): 24 and 25 — "inside the tie margin." Unanimous for Fable. Slate's gap was concrete: a file-path example that didn't match the real loader, a signing policy too loose for the threat model, two fuzzy policy calls.

**Then the judges did something important: they attacked our interpretation.** After their verdicts, both pointed out that the winner *went second* — and even without reading the first doc, shared memory makes "second draft advantage" impossible to rule out. A narrow win by the second mover proves nothing by itself. They were right, we said so in writing, and that critique is what created Experiment F.

### Experiment F — four fresh agents, no memory, no help, same instructions

This is the clean model-vs-model test. Four subagents launched via the Agent tool, **at the same time**, on a different design ticket (#29, a job scheduler):

- Two on Claude Fable 5, two on Claude Opus 4.8 (the per-arm `model` override; assignment sealed in a map file until judging ended).
- Every arm got the **byte-identical prompt** (we recorded its hash), the same tools, the same repo at the same commit, and the same stopping rule. No orchestrator memory, no recall, no experiment awareness — bare model + repo + ticket.
- Two runs per model, so we could tell "this model is better" apart from "this run got lucky."
- And because "I requested Opus" is not the same as "I got Opus," we **verified the served model at the wire level** — grepping the model ID stamped on every message in each agent's transcript, mid-run and again at the end. All four arms clean. (That check exists because Clint asked, mid-run, "how do we know the right model is actually being used?" — and we didn't have a good answer until we built one. It's now standard practice here.)

**The scores** (both judges, same rubric): Fable doc #1: **50/50** combined. Fable doc #2: **49**. Opus doc #1: **48**. Opus doc #2: **46**. Both Fable docs beat both Opus docs, and the gap between models (2.5 points) was bigger than the gap within either model (1–2 points). So the direction is real — but it's about **5%**, and one judge actually had an Opus doc tied with a Fable doc. This is "Fable is a bit better," not "Fable is a different league."

**The result that matters more than the ranking:** all four agents — different models, zero communication, zero shared memory — produced **the same architecture**. Scheduler lives in the daemon, jobs declared in config and off by default, pure scheduling math in core, everything consequential routed through the existing approval gates. Nobody copied anybody; the codebase's constraints forced the design. Which gives you a three-layer picture of where model quality actually lives:

1. **Architecture: decided by your codebase.** Both models land the same design. Paying more here buys nothing.
2. **Details: where Fable 5's edge lives.** Daylight-saving-time semantics, idempotence keys, bounding a log file that would otherwise grow forever. Same blueprint, sharper finish work.
3. **Review: the thing that recovers layer 2.** The one scoring disagreement between the two judges was on a doc's integration claims — exactly the thing the doc-only judge flagged as "someone with repo access should check this," and exactly where the repo-access judge docked it. The pairing works.

**The practical routing rule for your own Claude Code usage:** put Opus 4.8 on the architecture pass when constraints are rich and review is strong — it gets there. Spend Fable 5, *or a genuinely independent review with repo access*, on the details and shipping-quality pass. That's where the result moves.

### Experiment E — hand Opus the review, let it fix its own doc

Last question: if review catches the details, can Opus actually *fix* them? We took the Opus doc from Experiment D, gave a fresh Opus 4.8 agent that doc plus Slate's critique word-for-word, and let it do one revision pass. To keep it honest, the agent worked in a checkout **pinned to the pre-experiment commit** — the winning design and everything written since didn't exist in its world, and git commands that could peek forward were off-limits.

One caveat we put on the record *before* running: Slate's critique happened to name the clever mechanism that had made the Fable doc special (treating a pack's prompt files as a first-class security surface). So this measures review-driven repair **at its best** — with a review that caught everything — not on an average day.

**The result: 25/25 from both judges.** Every finding genuinely fixed — not patched over — and nothing new broken. The judge with repo access saw the score jump +3 (he'd measured the original damage); the doc-only judge saw +1 (from his seat there'd been little visible damage to begin with). Same repair, two vantage points, and that split behaving exactly as expected is the fourth time the two-judge design validated itself in one day.

And the sentence that matters most, from Hearth: **the review loop carries ideas across.** The Opus revision adopted the clever mechanism *because the reviewer named it*. Opus did not have to invent the insight independently — it just had to build it well once someone pointed, and it did, flawlessly.

### Experiment G — greenfield app build, three arms

After D/E/F, Clint identified the missing product question: codebase-grounded design is not the same as blank-page shipped work. The team froze a new prompt for **LoopSmith Studio**, a browser-based music creation app with manual loop editing, real browser audio, local save/load, JSON import/export, and a local algorithmic **Inspire Me** generator.

Three arms built from the same prompt:

| Codename | Setup | Result |
|---|---|---|
| **Maple** | Bare Claude Fable 5 | Excellent top-band app |
| **Cedar** | Bare Claude Opus 4.8 | Good complete app, but lower under discipline-weighted judging |
| **Birch** | Claude Opus 4.8 + MindStone/LCA review workflow with Hearth QA | Top-band app, scored with Maple/Fable |

The agreed conclusion was not “models do not matter.” It was the harness/productivity claim Clint wanted to measure: **MindStone/LCA review workflow moved Opus 4.8 into the Fable 5 shipped-result band.** Bare Opus matched many visible features but trailed on shipping-quality and discipline; the harness supplied exactly that discipline layer through review, verification, hygiene checks, and defect discovery.

The important caveat is that the harnessed arm also introduced its own defect through a heavier Tone.js architecture: a phase-dependent stop/playhead bug. Hearth caught it, Cairn fixed it, and the frozen artifact was verified. The honest lesson is not that the harness magically makes every technical choice better. It is that the harness catches and repairs edge-case defects before shipment.

Also, Birch did **not** use every capability available in the broader MindStone development workflow. It used MS4CC-style memory/checkpoints/ledger discipline, Hearth's live QA/review loop, and verification/ticket-fidelity habits. It did **not** use a formal PRD, a formal design/implementation plan, role adoption, frontend-design MCP assistance, subagent delegation, or a dedicated security-scanner pass. Cairn later clarified that this was not a clean deliberate protocol choice: the review and continuity habits were automatic, while several broader workflow tools were simply not invoked. That makes G a conservative datapoint for the harness claim. Whether the fuller workflow would widen the margin is a plausible follow-up, not a measured result here.

### What the day proved, and what it didn't

| Experiment | Question | Answer |
|---|---|---|
| **D** | Can review detect the gap between models? | Yes — and locate it precisely (needed the repo-access judge to size it) |
| **F** | Is there a real model gap at all? | Yes, but small (~5%) and confined to details; the architecture converges regardless of model |
| **E** | Can review + Opus close the design gap? | Yes — to a perfect score, clever ideas included, when the review names the problems |
| **G** | Can MindStone/LCA review workflow get Opus into the Fable 5 shipped-result band on greenfield work? | Directionally yes — harnessed Opus landed in the top band with Fable, while bare Opus trailed on shipping discipline |

**Proved directionally:** with independent, code-grounded review and shipping discipline in the loop, Claude Opus 4.8 can ship in the Claude Fable 5 quality band on these tasks. The process does not make models irrelevant; it supplies the review, hygiene, validation, and defect-discovery layer that narrows the shipped-result gap.

**Not proved:** what happens when a review *misses* something. Every point recovered in E sat on something the review named, and the harnessed G arm benefited from live QA. If your reviewer is weak — or nobody with repo access checks the claims — the detail and discipline gap may remain. Nobody has measured that case yet; it's the honest asterisk.

**Other limits, plainly:** one codebase-grounded task family plus one greenfield app, small run counts, n=1 for G, mixed-blindness judging, and judges drawn from the same agent ecosystem. The evidence supports the harness/productivity claim; it is not a broad proof that models do not matter.

*Want to check the work? The rules-posted-in-advance and full verdicts are on tickets #28 and #29 and the coordination channel; every document, prompt, hash, model-verification record, and label map is archived in the experiment records. Two process mishaps (the compaction leak and the error-echo) are documented above rather than hidden — they're useful gotchas in their own right.*
