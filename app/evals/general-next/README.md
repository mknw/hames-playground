# general-next conversation Eval (#507 W4)

[SCENARIOS.md](SCENARIOS.md) records the 18 acceptance scenarios and, as a draft for
the owner's review, the question space and the proposed rows
([scenarios.catalogue.json](scenarios.catalogue.json)). This extends the
existing role-level compatibility evals with whole conversations: run the shipped
package agent through `harness` / `continueSession`, then check tool order, routes,
termination, facts, artifacts and retrieval locators. Each scenario has its own file.

**Private tier only**, per the owner amendment of 2026-10-15. The
baseline cases run on the selected candidate only: `general` was removed on
2026-10-21 and its last live results are a **recorded** baseline
(`src/lib/eval-support/general-baseline.ts`), not a run. The default-agent flip (#606) was made on an owner
ruling (2026-10-27), not on a passed flip gate.

```bash
# All scripts run from app/ (`.env` and `evals/reports/` are cwd-relative; package paths are not,
# they resolve from the eval files). --list imports no agent and reads no credentials.
corepack pnpm eval:general-next --list
# Free: scripted inference and synthetic tools against the real agent. No .env is loaded.
corepack pnpm eval:general-next
# ONLY after the coordinator's actual “S3 merged: go” message:
EVAL_GENERAL_GO='S3 merged: go' corepack pnpm eval:general-next --live
```

| Variable               | Default        | Meaning                                                                                                                                                                                                                                      |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVAL_GENERAL_AGENT`   | `general-next` | Package agent ID; its `agents/<id>.server.ts` module exports an `AgentDefinition` with that ID. No hardcoded candidate import or registry change. Missing modules fail rather than fall back.                                                |
| `EVAL_ONLY`            | all            | Comma-separated scenario IDs; unknown IDs fail before setup. A filtered run cannot establish the flip gate.                                                                                                                                  |
| `EVAL_GENERAL_CAP_USD` | `20`           | Positive USD cap; anything above `25` is refused. The conservative stop threshold is **80%** of this amount (`16` by default), shared across baseline and candidate scenarios.                                                               |
| `EVAL_GENERAL_GO`      | unset          | Acknowledges the coordinator's go message; required in addition to `--live`. It is an operator attestation, never permission inferred from S3 appearing in the tree.                                                                         |
| `EVAL_GENERAL_CAPTURE` | unset (off)    | Exactly `1` writes a trace capture beside the report (below). Anything else, including `0`, leaves it off.                                                                                                                                   |
| `EVAL_THINKING`        | `off`          | `on` runs the reasoning twins so the model's thinking fills `reasoning`; `compare` runs every scenario thinking-off then thinking-on and reports them side by side. See [Thinking on](#thinking-on-eval_thinking). Anything else is refused. |

The runner writes one JSON report under `evals/reports`, including each scenario's
status, checks, agent, tier, observer cost, infrastructure floor and call count.
Gated and unrun scenarios have explicit rows; none are counted as passes. Every
finished scenario checkpoints the report. A synchronous process exit from the
usage observer checkpoints an interrupted scenario and prevents retries or a final
synthesis after the stop condition; throwing from an observer would be swallowed
by the shared notifier. A timer also stops private wall-clock spend during long
requests. Missing or unknown observed cost stops the run, as does any serving
client outside `LargeQwen`, `SmallQwen` and `PrivateSystemOne`.

Every graded row also carries `guards` (boundary guards slice 7): the per-turn
gate calls, screen calls, the gate's skip rate and both layers' latency, prompts
raised and defaulted, `egress_audit` and `egress_refused` events, and Decide
timeouts and failures — computed from the turn's own events (`src/lib/eval-support/guard-report.ts`), so the
report and any later re-derivation from a capture agree. A growing `decideDown`
count is an egress gate quietly degraded to the roster alone; that visibility is
the number the guard redesign exists to move.

Every graded row also carries `writer` (#1032): one entry per turn with the answer
writer's input size — `chars` (the rendered `Synthesize` prompt, from the call record's
`promptChars`, which the redaction keeps), `estimatedTokens` (`chars / 4`, the estimate
the writer's own trim works with) and `providerInputTokens` (the provider's own count) —
against `contextWindow`, the window of the client that served the call, as `windowShare`;
and `fallbackFired` / `fallbackRouteCalls`, set when the writer could not fit each route's
complete trace and fell back to compact route records (`decisionLoop`'s `writer_evidence`
warning). The report's top-level `writer` summarises the run: the largest input, its share
of the window and how many turns fell back. Computed from the turn's own events
(`src/lib/eval-support/writer-report.ts`), so a capture re-derives the same numbers; a turn
that wrote no answer reads `null`, never 0. Hermetic sizes are the scripted run's prompts,
real in size but not in content; the live run is the measurement.

The observer prices completed calls, so the final in-flight call can overshoot the
80% threshold and even the configured cap. The report adds a separate conservative
private-infrastructure line: elapsed scenario seconds (including setup and endpoint
wake waits) × (`LARGE_LLM_EUR_PER_HOUR` + the small box's served-family rate), converted to USD at
the same static `EUR_PER_USD` used by the observer, refused outside 0.75–0.95. Each hourly rate is
floored at its committed default. The small box's rate follows the GPU family its status
sample reported — `SMALL_LLM_EUR_PER_HOUR` for the L4, its derived ratio (or
`SMALL_LLM_EUR_PER_HOUR_A10`) for the A10, and the highest supported-family rate until a
family is observed — and the report records the observed family, the pricing basis, and the
conservative reservation; a family change mid-run can raise the floor, never lower it.
Observer call-time cost is also
counted, deliberately overcounting overlap. Infrastructure remains a floor because
provider rounding and unobserved infrastructure are not measured; configured scale-down tails are reserved once per run and after idle gaps longer than each box’s window;
this is not an invoice ceiling. Both cap and stop threshold appear in every report.

## Trace capture (`EVAL_GENERAL_CAPTURE=1`)

The report grades a conversation by its decision sequence and tool checks; it cannot say why the
decider chose `answer`, what a controller wrote before an attempt failed, why a critic rejected an
attempt, or what synthesis did with the results. With the flag set the
runner also writes `<report>-capture.json` next to the report (inside `evals/reports`, gitignored),
checkpointed with it, and the report names the file under `captureFile`. Off by default; the live
lane turns it on. It reads the graded trace, so it works in hermetic and live mode and adds no
call. Per scenario row:

- `decisions`: for every Decide, the `instructions` and `criteria` as sent, the `state` it was asked
  over (conversation, steps so far, latest results), the `choice`, the endpoint's `probs`, `top`,
  `margin`, `abstained`, and the raw response body.
- `controllerCalls`: the raw completion of `LoopController` / `ActorController` calls, capped at
  8,000 characters each (the prompt is not recorded): every call that ended in an `error` or
  `loop_recovery` event (`outcome` `error` / `recovery`), and, for a scenario that failed, every
  call. The org-knowledge draft loop's calls are here too, under `patternId`
  `org-knowledge-draft` with the serving `client`, recorded for EVERY scenario: the loop runs in a
  scratch context, so the driver records them beside the org trace, and that recorder sees only
  `completion` or `error`, never `recovery` (a validator-refused Return or unparseable `tool_args`
  reads as a `completion`), so the error-only rule would drop the rounds worth reading.
- `criticCalls`: every critic verdict and failed critic call, whether the scenario passed or not —
  a rejection on a passing scenario is exactly what the diagnosis reads. A verdict row carries the
  `verdict` (`is_sufficient`), the `reason` (`explanation`), `suggestedApproach`, and the raw
  output capped like a controller completion; a failed call is an `error` row from its error
  event. Each row names the BAML function (`Critic` or its `CriticThinking` twin) and the client
  that served it (`client` / `provider`), when the event carried a call record.
- `synthesizeCalls`: every `Synthesize` completion — the synthesized `output` and the raw
  completion, each capped like a controller completion — plus the serving client. A failed
  synthesis is an `error` row from its error event. The router's direct answer is not synthesis
  and is not here.
- `error`: present, with empty `decisions`, `controllerCalls`, `criticCalls` and
  `synthesizeCalls`, on a scenario that threw before it could be graded (a timeout, an escaped
  `BamlTimeoutError`), so a missing row is never read as "no decisions".

The state can quote tool results verbatim (the event's data records only the state's size; the
text is on its call record, SD-3), so the file is for the eval's synthetic fixtures; do not point
the flag at a run that feeds the agent anything else. Captured `state`, `error` and raw outputs
are verbatim: scrub them before quoting them on the public tracker. `capture.test.ts` and the `capture:` pins in `general-next.test.ts` hold the
shape (the second pins a scripted run's critic verdicts and the synthesis beside the decisions),
`runner-wiring.test.ts` the flag, the path and the checkpoint.

## Thinking on (`EVAL_THINKING`)

`EVAL_THINKING=on` runs general-next with model-side thinking on for the three patterns
that produce `reasoning` and have a reasoning twin: the loop controller
(`ControllerThinking`), the critic (`CriticThinking`) and the planner (`PlannerThinking`).
The box's reasoning parser returns the trace in a separate field, and the adapters restore
it into `reasoning` (the critic, which has no such field, records it on the call record's
`parsedOutput.reasoning`). `compare` runs each scenario once per mode in one process, so
both modes share one cold start and one scale-down tail.

How it switches, and why production is untouched:

- **One switch, the production one.** The runner sets `PRIVATE_REASONING_ROLES` to
  `controller,critic,planner` (on) or empty (off) in its own process around each
  scenario's attempts, and restores it in a `finally`
  (`src/lib/eval-support/thinking-mode.ts`). It adds no client, registry or routing path,
  so the twins run on their shipped clients: `LargeQwenThink` on the box,
  `LargeQwenThinkOR` on the OpenRouter route. Their 4 096-token / 180 s cap and timeout
  coupling is pinned in `planner-thinking-render.test.ts`, and the cap mirror in
  `CLIENT_MAX_OUTPUT_TOKENS` by `client-output-caps.test.ts`.
- **The eval owns that setting.** An inherited non-empty `PRIVATE_REASONING_ROLES` (from
  `.env` or the shell) is refused in every mode, so a row labelled `off` really ran with
  thinking off.
- **Only the eval's clients move.** `eval-thinking.test.ts` resolves every private-tier
  role through the real seam before, during and after each mode. It checks that `on`
  moves exactly `controller`, `critic` and `planner` from `LargeQwen` to
  `LargeQwenThink`, that `off` and the restore match production, that the Anthropic tier
  moves nothing, and that no module under `packages/` or `app/src` other than
  `thinking-mode.ts` contains the variable's name.
- **The actor keeps its original.** `ActorController` shares the `controller` role but
  has no twin. With `controller` thinking on, it now stays on the same route's
  non-thinking client. Before this change it was sent on the thinking leaf and then
  refused, which failed every actorCritic route.
- **The describe family and the screen stay off** (#625 G19 Q2), and the flip gate reads
  only the thinking-off rows, because it is a statement about the shipped configuration.

What the report adds. Every graded row carries `thinking` (`off` / `on`), `durationMs`
(the attempt's `driver.run` wall-clock, wake excluded) and `reasoning`. `reasoning` counts
the calls, how many were twin calls, and the total and largest `reasoning` length, per
function. It also counts `fallbacks` and `capHits`:

- `fallbacks` is twin attempts replaced by a retry without thinking. A `ControllerThinking`
  or `PlannerThinking` attempt that hits its cap or produces no answer is retried once on
  the original function, on the same endpoint. The adapter prices the failed attempt
  once, and the pattern records it as a `warning` (`task: 'controller'` or `'planner'`)
  carrying its call record and trace. So the attempt counts as a twin call plus the
  original's retry, and its trace length is in `maxChars`.
- `capHits` is twin attempts whose record says they hit the output cap.

These two are the numbers the shipped 4 096-token twin cap is judged by.
`planner-thinking.test.ts` ("Controller thinking fallback stays visible") pins the
controller half. The ledger keeps one spend row per (scenario, mode). The top-level
`thinking.comparison` has one line per scenario and one cell per mode, each with the
graded status (the MUST 2-of-3 rule included), attempts, latency, USD, reasoning
characters and calls, `fallbacks` and `capHits`.

Hermetic `EVAL_THINKING=compare` passes all 44 runnable scenarios in both modes. That is
wiring only: the fixture returns a synthetic trace for a thinking request.

**This eval leaves the planner unmeasured, live runs included.** No scenario selects the
`think` route: it was dropped by owner verdict (`unusedValues["routes:think"]` in
`scenarios.catalogue.json`). So a run reaches `PlannerThinking` only when the decider
misroutes, and that run also fails the scenario. The planner is the role whose
private-tier output cut (32 768 → 4 096 tokens) is still unmeasured. That measurement
belongs to `pnpm eval:harness`'s `planner-plan-shape` scenario, not to this eval. The
planner's routing move is pinned in `eval-thinking.test.ts`, and its twin adapter has its
own pins (`planner-thinking*.test.ts`).

### Live run (needs the owner's go and a spend cap)

From `app/`, with the same preconditions as any live run:

```bash
EVAL_GENERAL_GO='S3 merged: go' EVAL_THINKING=compare EVAL_GENERAL_CAP_USD=<cap> \
  EVAL_GENERAL_CAPTURE=1 corepack pnpm eval:general-next --live
```

`EVAL_THINKING=on` skips the thinking-off half and costs less, but the report then has no
baseline column, and the flip gate is ineligible because it has no thinking-off rows.

**Cost estimate per route, one pass, private tier.** These are estimates,
not measurements. The inputs:

- the recorded thinking-off passes on #507 (Modal 27B on a snapshot restore: about
  2.7–3.3 USD, of which about 1.7–1.9 USD is the cold start and the idle windows;
  OpenRouter route: 0.57–1.0 USD), measured when 17 scenarios were runnable;
- #625 Q5's planner twin latency, 18.8 s p50 against 2.2 s with thinking off, for about
  8× the output tokens;
- the hermetic count of 28 twin calls per pass, which a live model can multiply by two or
  three through longer loops and MUST re-runs.

| Route (`LARGE_LLM_ROUTE`) | Thinking off | Thinking on (`on`)                                                           | `compare` (one process) |
| ------------------------- | ------------ | ---------------------------------------------------------------------------- | ----------------------- |
| Modal 27B box (unset)     | 2.7–3.3 USD  | 3.9–5.8 USD: +40–80 twin calls × ~17 s at ~6.6 USD/h                         | 5.0–7.2 USD             |
| OpenRouter (`openrouter`) | 0.6–1.0 USD  | 1.1–2.1 USD: observer cost ×8 on twin calls, +small-box floor                | 1.5–3.0 USD             |
| Anthropic tier            | not runnable | not runnable: this eval is private-tier only, and the twins are too (G19 Q4) | —                       |

With 44 runnable scenarios today, the extra memory and org-knowledge rows mostly use the
small box and add little 27B time, but every scenario's wall-clock is charged against
both boxes' hourly floor. Read the upper end of each range as the realistic one. The cap
should be the `compare` figure plus margin, for example 10 USD on the box or 4 USD on
OpenRouter. The runner stops at 80% of the cap, and its final in-flight call can overshoot
(see above). Every Modal figure is over the 2 USD standing limit, and so is the upper end of
both OpenRouter thinking-on figures, so the live run needs its own go. The OpenRouter route
also sends the 27B roles to a public provider under ZDR: that is the route's existing
processor decision, not something this option changes.

## Execution boundaries and pending evidence

Hermetic mode poisons public-provider credentials, redirects the private endpoints
to a loopback fake before importing the agent, and installs a recording dead-end
HTTP proxy for non-loopback requests. It re-execs a child with `NODE_USE_ENV_PROXY=1` and all proxy variables set at spawn, requires Node ≥24.5, and refuses execution unless a startup fetch of `http://egress-selftest.invalid/` is recorded by the backstop. No Anthropic-tier run exists. Live mode reads
**this worktree's `app/.env` file**, checks remote HTTPS URLs and `/v1` versus
`/v1/systemone` paths, then installs the same private role map used in production.
It refuses a missing/stale small-model URL or key before inference; refresh a stale
worktree copy from the main checkout's `app/.env` without printing key values,
and escalate if the required values are absent. The runner does not copy or print credentials. After loading `.env`, it poisons all public-provider keys and the public decision URL in both modes, and live mode refuses a non-local embedding provider. Each live job awaits `ensurePrivateTierAwake()` after its elapsed-time clock starts. Wake failure records `LARGE_LLM_WAKE_FAILED` or `SMALL_LLM_WAKE_FAILED` (the box that failed; `PRIVATE_TIER_WAKE_FAILED` if unattributable) and stops without fallback. The owner local embedder at `127.0.0.1:8090` must answer `/health`;
otherwise escalate. Never start another embedder.

Both modes isolate all tool dependencies with synthetic fixtures. The builtin driver
uses a memory-only stash, a keyword retrieval backend and scripted shell effects. Live mode reads the production gateway descriptions/schemas through metadata-only MCP requests and the shipped Graph definitions; the sandbox tool mirrors the shipped shell schema/description. Missing metadata refuses execution. Every required tool has per-scenario argument predicates. It executes no generated code and makes no real Graph, Neo4j or
Redis request; tool execution uses a loopback fake gateway. A running production MCP gateway is a live-mode precondition for metadata-only `listTools`; missing metadata fails before wake or spend. Artifact and markdown-index checks
prove the **dependency contract**, not Office rendering, numerical Python/Excel
execution, vector search quality, app-upload HTTP integration or containment.
Those integration claims remain owed to app-path evidence using synthetic documents
seeded through the app's upload path and the shipped sandbox. The driver interface
allows those integrations to be supplied independently. The driver follows the production `GUARD_PSEUDONYMISE` switch: default/off omits
`AgentGuards.pseudonymiseForWeb`; explicit `on` supplies `createWebPseudonymiser`.
The wrapper then runs on both tiers, though this conversation runner remains
private-tier-only. Neither value warns at boot; invalid values refuse boot.
The eval disables the directory leg (`directory: 'none'`); its identity-free
fixtures exercise composition, not substitution recall.
The driver also supplies the
production `createEgressRoster` as `AgentDeps.egressRoster`, on the same `none` directory, so
every outgoing call is judged by the egress question with the payload roster as evidence.
Scripted inference checks
wiring only: hermetic green does not certify model behaviour or authorize a flip.
Scenarios 15/16 remain gated in this driver; scenario 18 is written only. `graph_file_ingest` is in general-next's own office list only when the host enables it; the executor refuses unless the host predicate positively allows it (the app: raw private run frame, `INFERENCE_TIERS=self_deployed`, no OpenRouter embedder). Turn-results materialisation stays disabled.

The acceptance gate after S3 is: all `must` scenarios pass and no recorded `general`
baseline result regresses (the candidate passes every scenario `general` last passed) on the **private tier**, with all expected scenarios present and live
model evidence. `should` / `nice` outcomes remain visible.

**MUST re-runs (#842, owner ruling 2026-10-28):** a failing `must` scenario is re-run
twice more — at most **2 extra attempts per failing MUST scenario** (3 attempts in
total) — and the gate counts it as passing when 2 of the 3 attempts pass, listing it
under the report's `flipGate.flaky`. A first-attempt pass runs once, so a clean run
pays nothing extra; the bound applies only where a MUST actually failed. `should` and
`nice` scenarios are unchanged (one attempt). A scenario that throws, or fails before
any attempt is graded (a wake failure), is not a graded failure and gets no re-run.
The report carries every attempt as its own numbered row (`attempt`), and the runner's
exit code follows the same counting rule as the gate. The counting rule lives in
`src/lib/eval-support/flip-gate.ts` (`gradeMustAttempts`), pinned hermetically by
`flip-gate.test.ts`. No scenario can pass
with zero checks. A separate default-flip draft is prepared only after that evidence.

The pure ledger, preconditions and trace checks live under `src/lib/eval-support`
so ordinary hermetic unit tests can exercise them without importing the eval runner.
The existing `evals-not-in-ci` pin remains unchanged; neither this script nor the
role evals run in CI. No public package API changed, so this PR needs no package
changeset or core SPEC/GUIDE update.

Every result row carries a `screen` block beside `spend`: the injection screen
(`ScreenUntrustedContent`) calls and observer cost, the guard gate's (`Decide` calls keyed
`guard.*`) the same, everything else the same, and each one's share. Each guard declares its
own options and none is inherited: the office and info route guards carry the screen, so it
covers their external tool results (mail and files from outside senders, sandbox results,
web and library docs); the host's classifier keeps the graph and Microsoft 365 results whose
every identity is on a home domain to the deterministic pass, and the documents route's guard
declares no screen, so retrieved hits are never screened. The
loop itself sanitises and screens nothing: a route record is built from committed events and
capped, and a quoted tool body (an `actorCritic` result, a retriever excerpt) carries the
fence it arrived in, so no call is made for a record at all and the counts below are ingress
calls only. Both tiers' declared screen default is `'off'` (revision 6, the shared
SCREEN_POLICY_BY_TIER): the eval composes no `guards.screenMode` of its own, so
by default NO screen call and NO gate question is made on either tier — the
counts below are zero while the default holds, and the report columns stay built
and idle (they read events; nothing fires). A deterministic finding forces the
screen only in a mode that already runs it, never past an `'off'`. A switch that
re-enables it (`GUARD_SCREEN` / `GUARD_SCREEN_ANTHROPIC`, `off | always` per tier;
a set `gated` or `shadow` refuses boot naming the change) moves cost through the
screen's scope, its mode per tier and the guards that declare it. On the
private tier each screen call is large-model time and each gate call small-box time.
Infrastructure and scale-down tail lines are scenario time, not attributable per function, so
the share is of observer cost only (hermetic runs price every call at 0: calls are the signal).

**What a hermetic pass proves.** The scripted `Synthesize` echoes `answerIncludes`, the
citation link and "The graph is read-only." whatever the tools returned, so "answer
contains…", "explains read-only capability", "does not claim a graph write" and "acknowledges
failure" are self-fulfilling there. Only these discriminate hermetically: tool order and
arguments, route selection and completion, stash artifacts, the index and retrieval checks,
and "first turn recorded a tool failure". A scenario whose only discriminating checks are
absent (06) is a vacuous pass hermetically; every hermetic report says so in `hermeticCaveat`.
Per-user memory runs on the rows that declare it (05, 19–31 and tn35/tn36/tn41/tn58) and on no other, so no other row pays a recall or a store step; see the next section. The organizational-knowledge hook likewise runs only on the rows that declare `org` (32–43); see the section after it.

## Per-user memory (withMemory)

`general-next` wraps its patterns in `withMemory` when the host passes `deps.memory`, and the app always does; the user's switch decides. The driver passes it to the memory rows only, built the way the host builds it — the production `createDecideAdapter` / `createDecideAllAdapter` / `createMemoryExtractAdapter`, each wrapped to record the state or input it was handed — over a **writable synthetic store** (`src/lib/eval-support/synthetic-memory.ts`): in memory, owner-scoped (two invented owners, the owner resolved on every call), transactional (a throwing body rolls back, which the stale refusal and the provenance no-op need). After each turn the driver does what the host's post-turn continuation does: `settleMemory`, then — between turns — the person's answer to any `memory.confirm` proposal (`answerProposal`, and on save core's `applyMemoryProposal`), then one save of the context. A scenario can start a new conversation, as either owner, and can change a stored memory between a proposal and its answer.

Two deliberate differences from production. **Every personal memory asks** (`settle.routineKinds: []`): production lets a plainly volunteered episodic, semantic or preference memory skip the question, and the confirm-flow rows must not depend on what the gate's `confirm` field said, so that unasked-write path is not exercised here. **Hermetic embeddings are synthetic** (a bag of stemmed words plus one shared axis standing in for the production query instruction); every similarity a row relies on — the reinforce and update bands, the recall floor — is pinned in `synthetic-memory.test.ts`. Live runs embed with the production embedder (the owner's local one, a live precondition already).

What the rows cover, each with what a pass proves in its catalogue `notes` and in SCENARIOS.md:

| Row            | Claim                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| 05             | recall of a seeded memory into the answer, two turns; nothing of the other owner's                            |
| 19             | a stated preference → one proposal with verbatim evidence → saved on confirm → recalled in a NEW conversation |
| 20 / 21        | a restated preference reinforces; a changed one updates (the merge question)                                  |
| 22             | a memory changed between the proposal and the answer is refused as stale; nothing written                     |
| 23             | a discarded proposal stores nothing                                                                           |
| 24, tn58, tn41 | owner isolation: the other owner's recall and answer never carry this owner's memory                          |
| 25–27, 30, 31  | true negatives: small talk, a question, a hypothetical, a secret, a fact about a colleague                    |
| 28             | a "remember that…" inside a fetched page: nothing stored, and no memory input reads the page                  |
| 29             | a fact only the assistant said: nothing stored                                                                |
| tn35, tn36     | memory wired, switch OFF: nothing stored, nothing recalled                                                    |

The graders read the store, the proposal, the answer's report and what recall attached — `memory-checks.ts`, pinned with a red each in `memory-checks.test.ts` — and a row's memory and pattern graders come from its own catalogue row (`catalogue-checks.ts`), so the reviewed JSON is the run's. Every true negative asserts **no proposal and every row as seeded** (`noMemoryStored`); it is never satisfied by a reply that says nothing was saved.

**Hermetic vs live.** Hermetically the gate, merge question and extractor are scripted per turn (`memory.turns[n].model`) and Synthesize answers only from the memory block recall handed it. So the recall, isolation and exclusion checks discriminate, and so do the negatives whose stop is deterministic: the switch (tn35, tn36), input isolation and the evidence rule (28, 29: the scripted model falls for the page or the guess), the organisation target having no writer (31), the sensitive stop after a sensitive answer (30). For small talk, a question and a hypothetical (25–27) the scripted gate answers as a correct model would, so a hermetic pass proves only that the store stops on that answer; the model's own judgement on every negative is a live claim. Claim checks on replies (tn35, tn36, tn41) stay self-fulfilling hermetically. **No live run has been made**: the same rows run unchanged on the private tier (`--live`, after FRONT's go), where the store gate, the extractor (`SmallQwen`) and the recall gate are real calls the report prices.

**Not covered yet.** The host's Postgres store, its encryption and its owner scoping (layer 1: `src/__tests__/lib/db/memories-db-store.test.ts`); the app's answer RPC (`answerMemoryProposalFor`: the answer binding, its release, the version-checked save, the held-payload row); the joint memory wake (no `awaitWake`; a live job wakes both boxes before each scenario); compaction (M3), retention and forget; proposal expiry; a proposal with more than one item; `routerMemory: 'replies-only'`; organisation-graph writes (no writer before M12); what the reply should say with memory on (the open `memory-on` ruling); and recall-shaped tasks of other intents (the deferred `user-memory` cells in the catalogue).

## Organizational knowledge (the org-knowledge hook)

The hook's design (`docs/plan/org-knowledge-hook.md`, “Eval rows”) lists 34 rows. Twelve run: the nine true negatives and three positives (32–43). The other 22 are `proposed` rows in the catalogue (p88–p101, tn59–tn66); each one's notes say what it waits for. The driver runs the hook only for rows whose module names `org`, the way the host does after a turn: `settleOrgKnowledge` with the production decide adapter and the `orgDraft` loop-controller adapter, each wrapped to record what it was handed. It runs over a fresh **synthetic org graph** per scenario (`src/lib/eval-support/synthetic-org-graph.ts`: invented members, projects, placeholder pillars and themes, seeded by name). Between turns it gives the person's scripted answer: Add (`applyOrgProposal`, as that turn's owner) or Discard. A turn can hand the conversation to a second user in a new conversation of their own.

The graders read the graph before and after, and the proposal each turn raised; they never read the reply (`org-checks.ts`, with a red each in `org-checks.test.ts`). They are `proposalRaised`, `noProposalRaised`, `graphEntryCount`, `graphLacksEntry`, `graphNodeProperty` and `graphElementsInclude`, the last of which reads a turn's own graph tool results. A row's org graders come from its catalogue row.

**Hermetic results do not measure the gate.** Hermetically the gate and the draft are scripted per turn (`org.turns[n].model`), served through the production adapters by the fixture endpoint. A live run ignores the script and asks the real gate and the real draft loop on the private tier, with no code change. A hermetic pass therefore proves the plumbing, never the model's judgement:

- **The positives (32–34)** prove the path from draft to proposal to answer to write: one new project, a deadline on an existing project, and a replaced coordinator whose removed edge is on the card.
- **Seven of the true negatives (35–40 and 43)** have the scripted gate answer `no_organizational_knowledge` while the scripted draft would have proposed (each draft passes the validator on its own). A pass proves only that the gate's answer stops the hook before the draft.
- **Two negatives stop deterministically.** In 41 the scripted gate falls for a colleague's health, and the validator drops the fact (V7: `ABOUT` never ends at a `Member`). In 42 the scripted gate falls for an instruction inside a mail, and the validator drops the mail's project (V3: its evidence is not in the user's message).

**No live run has been made.**

**The draft reads the scenario's own graph, strictly.** The org rows' draft loop holds `read_neo4j_cypher` / `get_neo4j_schema`, served by `syntheticOrgDraftTransport` (`src/lib/eval-support/synthetic-org-graph.ts`) from the scenario's synthetic org graph, the graph its candidate is validated against. The read serves a Cypher subset as strictly as Neo4j would: `MATCH (v:Label {prop: 'x'})` patterns and a `WHERE` of `v.prop` / `toLower(v.prop)` with `=`, `CONTAINS`, `STARTS WITH` or `ENDS WITH` joined by `AND` / `OR`, with `$params` read from the call. A label is honoured, equality is exact and case-sensitive, and a pattern node that matches nothing empties the read. Anything outside the subset, or not Cypher, is a failed call naming the subset. So a lookup of `{name: 'Project Osprey'}` does not find a stored `Osprey` here either, and a row can fail by duplicating a node (LD-23). Not modelled: Neo4j's row shape (node rows are `{ label, ...properties }`, edge rows `{ from, type, to }`).

**The members are a fixture, never a database.** The synthetic graph's ten members (`SYNTHETIC_MEMBERS`) are invented, with the fields the roster ingest writes on a `Member`. No eval path reads org or member data from any Neo4j, hermetic or live: the driver's synthetic transport owns every neo4j tool, so none falls through to the gateway. `src/__tests__/lib/eval-support/no-real-neo4j.test.ts` pins that, with the mutations that turn it red in its header. `src/lib/org-graph/scripts/seed-eval-members.ts` MERGEs the same ten into a Neo4j (`createdBy: 'eval-seed'`, idempotent, never deletes) for **local manual use only**, such as the dev UI and the Org.graph tab. It needs `--target <host:port>` equal to the resolved Neo4j, and it refuses a graph that holds any `Member` it did not write, i.e. any directory data. **No eval reads what it writes.**

The JSON report includes a computed `flipGate` with explicit reasons; hermetic or filtered reports are ineligible. See the catalogue’s rollout criterion map and each scenario’s “A live pass proves” statement.
