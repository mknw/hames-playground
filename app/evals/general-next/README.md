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
EVAL_GENERAL_AGENT=general corepack pnpm eval:general-next
# ONLY after the coordinator's actual “S3 merged: go” message:
EVAL_GENERAL_GO='S3 merged: go' corepack pnpm eval:general-next --live
```

| Variable               | Default        | Meaning                                                                                                                                                                                       |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVAL_GENERAL_AGENT`   | `general-next` | Package agent ID; its `agents/<id>.server.ts` module exports an `AgentDefinition` with that ID. No hardcoded candidate import or registry change. Missing modules fail rather than fall back. |
| `EVAL_ONLY`            | all            | Comma-separated scenario IDs; unknown IDs fail before setup. A filtered run cannot establish the flip gate.                                                                                   |
| `EVAL_GENERAL_CAP_USD` | `20`           | Positive USD cap; anything above `25` is refused. The conservative stop threshold is **80%** of this amount (`16` by default), shared across baseline and candidate scenarios.                |
| `EVAL_GENERAL_GO`      | unset          | Acknowledges the coordinator's go message; required in addition to `--live`. It is an operator attestation, never permission inferred from S3 appearing in the tree.                          |
| `EVAL_GENERAL_CAPTURE` | unset (off)    | Exactly `1` writes a trace capture beside the report (below). Anything else, including `0`, leaves it off.                                                                                    |

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

The observer prices completed calls, so the final in-flight call can overshoot the
80% threshold and even the configured cap. The report adds a separate conservative
private-infrastructure line: elapsed scenario seconds (including setup and endpoint
wake waits) × (`LARGE_LLM_EUR_PER_HOUR` + `SMALL_LLM_EUR_PER_HOUR`), converted to USD at
the same static `EUR_PER_USD` used by the observer, refused outside 0.75–0.95. Each hourly rate is floored at its committed default. Observer call-time cost is also
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
  call.
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
allows those integrations to be supplied independently. The driver supplies the production
`createWebPseudonymiser` as `AgentDeps.pseudonymiseForWeb`, so `general-next`'s `info`
route is not refused. The production G14 filter is present and passes identity-free
payloads; no substitution is exercised (no fixture carries an identity, and the directory
leg is off: `directory: 'none'`). Scripted inference checks
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
calls only. On the self-deployed tier, where this eval runs, the screen's mode is `'shadow'`:
the gate is asked on every external result and its answer recorded, and the screen runs as
well, so each screened result costs a gate call too until the eval bar moves the tier to
`'gated'`. A deterministic finding forces the screen in every mode but `'off'`. The levers that
move cost are the screen's scope, its mode per tier and the guards that declare it. On the
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
The eval passes `deps.memory` to scenario 05 alone, as a synthetic read-only owner-scoped store (`src/lib/eval-support/synthetic-memory.ts`) whose recall gate is a fixed answer, and never runs the store step; so no `withMemory` gate or describe calls are priced that production makes.

The JSON report includes a computed `flipGate` with explicit reasons; hermetic or filtered reports are ineligible. See the catalogue’s rollout criterion map and each scenario’s “A live pass proves” statement.
