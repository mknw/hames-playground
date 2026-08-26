# Harness / client compatibility evals

Run these **whenever a BAML client changes** — a new provider, a new model id, a
re-pointed role, a bumped `max_tokens` — to find out whether the workflows this
repo already ships still work on it.

```bash
# from app/
pnpm eval:harness                          # baseline: the declared Anthropic chains
EVAL_CLIENT=VerdaQwen pnpm eval:harness    # the self-hosted deployment
```

A report lands in [`reports/`](reports/) and the exit code is non-zero if any
scenario failed.

---

## What this is not

**It is not part of the test suite, and it never runs in CI.** Every scenario
makes real, billed LLM calls against a live endpoint: a metered provider API,
and a self-hosted GPU box that scales to zero and pays a multi-minute cold start
on the first call after idle. A CI job that picked these up would bill every
push and go red on someone else's network.

That separation is structural, not just conventional:

|                            |                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/vitest.config.ts`     | `test.include` and `coverage.include` are both rooted at `src/**`. `evals/` is outside both, so vitest cannot collect these files and coverage cannot count them. |
| `.github/workflows/ci.yml` | runs typecheck · lint · format · test · build. None of them invoke `eval:harness`.                                                                                |
| `package.json`             | `eval:harness` is a standalone script. No `pre*` hook chains it.                                                                                                  |
| `src/**`                   | imports nothing from `evals/`.                                                                                                                                    |

[`src/__tests__/evals-not-in-ci.test.ts`](../src/__tests__/evals-not-in-ci.test.ts)
pins every row of that table, and is itself an ordinary test — so the guard runs
in the job it protects. **If you widen a vitest glob, add a `pretest` hook, or
import an eval module from `src/`, that test goes red.** Do not fix it by
loosening the guard.

The evals _are_ covered by `pnpm typecheck`, `pnpm lint` and `prettier`
(`tsconfig.json` includes `evals`, and eslint applies the `src` rule block to
it), so they cannot rot into unbuildable code unnoticed.

---

## Knobs

| Env var              | Default                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVAL_CLIENT`        | unset                    | The BAML client to route through, e.g. `VerdaQwen`. Unset (or `default`) is the **baseline**: no override anywhere, so every function runs the Anthropic chain it declares in `baml_src/`.                                                                                                                                                                                                                                             |
| `EVAL_ROLES`         | the production Verda map | Comma-separated roles `EVAL_CLIENT` applies to. Default is `controller,actor,critic,compactExecution,router,planner,describe,screen` — the same set a verda tier decision moves in production (widened twice on 2026-08-26, the second time to include the injection screen), so a plain run measures the shipped route rather than a hypothetical one. Set it to NARROW a run while bisecting. No role is refused; nothing is pinned. |
| `EVAL_RELIABILITY_N` | `20`                     | Calls in the structured-output reliability sample. `0` skips them, for a quick structural-only pass.                                                                                                                                                                                                                                                                                                                                   |
| `EVAL_ONLY`          | unset                    | Comma-separated scenario ids, to re-run one thing. Unknown ids throw.                                                                                                                                                                                                                                                                                                                                                                  |

The script sets `BAML_LOG=warn` so the console stays readable; override it
(`BAML_LOG=info pnpm eval:harness`) to see the rendered prompts and raw replies
while debugging a scenario.

Credentials come from `app/.env` via `--env-file` — `ANTHROPIC_API_KEY` always,
plus `VERDA_INFERENCE_ENDPOINT` (which must end in `/v1`) and
`VERDA_INFERENCE_API_KEY` for a Verda run. See `app/.env.example`.

### How the client override works, and why it is not a new switch

`EVAL_CLIENT` is read in exactly one file — [`client.ts`](client.ts) — and
**nothing under `app/src/` knows this suite exists.** That is deliberate. The
provider posture is a compliance property rather than a performance one
(ADR-0001, and `SD-12` in the sensitive-domain brief): there is no configuration
that sends a _production_ prompt to a different provider, and the one opt-in
that moves traffic, `USE_VERDA_INFERENCE`, is all-or-nothing and documented. An
eval runner that added a general "point any role at any client" env var into
`src/` would re-introduce precisely the switch that was deleted on 2026-08-24.

So the suite reuses the existing seam instead of widening it.
`clientOverrideFor()` works by spreading `{ client: '<name>' }` into a BAML
call's options bag; every scenario here does the same thing with a value
`client.ts` owns. Production resolution is untouched, and still consulted —
`resolveClientForRole()` is what the report prints as each scenario's expected
client.

### The screen is measured, not pinned

`screen` was in a `PINNED_ROLES` list until 2026-08-26 and no combination of env
vars could move it, on the reasoning that a security control's model is not a
knob an eval may turn. That list is **gone**, and its removal is the point.

The owner ruled the same day that no call made under the private tier may be
sent to any public AI provider, so production routes the injection screen to the
self-hosted box. The two properties a screener needs — it must not be talked out
of reporting by the content it reviews, and it must copy `spans`
character-for-character, because the guard neutralizes them by literal match —
were **unmeasured** on that client. They were unmeasured _because_ of the pin: a
suite that refuses to point the screen at a candidate is the reason no candidate
has ever been measured as a screener. Measuring a control before shipping it is
the opposite of tuning it.

So `screen-on-the-tier` (`scenarios/screen.ts`) replaces the old
`screen-stays-anthropic`. It grades those two properties on whatever client the
run routes, twice — once on an instruction buried in a plausible page, once on a
page that addresses the screening model directly and asks it to stay quiet,
fence and all. **A failing run of it is the evidence that the production move
was wrong**, and it is the only thing in the repo that can say otherwise.

What survives from the old reasoning, and is why `screen` is still a role of its
own rather than folded into `describe` (`SD-4` / `SA-M5`): nothing may move the
screen _implicitly_. It is its own entry in `DEFAULT_ROUTED_ROLES`, so narrowing
a run to `describe` does not drag it, and `EVAL_ROLES=screen` measures it alone.

To measure the screen end to end on the box, set **both** `EVAL_CLIENT` and
`USE_VERDA_INFERENCE=1`: the graded calls follow `EVAL_CLIENT`, but the one
production-adapter call in that scenario resolves its client through
`clientOverrideFor('screen')` like production does, and the report shows them
separately rather than pretending they agree.

---

## The scenarios

Each pins a **recurrent branch** — a path these workflows really take — with
deterministic assertions. Prose quality is never graded: a check that reads a
model's wording and decides whether it is good enough measures the reader, not
the client. Where a branch has no deterministic reading, the value is recorded
as an _observation_ instead, which lands in the report but never fails the run.

| Scenario                                   | Role             | Branch it pins                                                                                                                                                                                                                              |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controller-truncation-detection-wired`    | controller       | `CLIENT_MAX_OUTPUT_TOKENS` has an entry for this client. Without one, `llmCallHitOutputCap()` returns false for every call and the corrective retry is silently dead (`SA-C2`). No model call.                                              |
| `screen-on-the-tier`                       | screen           | The two properties `withInjectionGuard` depends on, on the routed client: an injection is reported, and every span is an exact substring — including on a page that tells the screen to stay quiet.                                         |
| `planner-plan-shape`                       | planner          | Non-empty plan, `n_steps` in the region of the steps written, only catalog tools named (a decoy in the request is not), and output tokens under the cap with headroom. Closes the gap the `planner:` entry in `VERDA_CLIENT_BY_ROLE` names. |
| `router-intent-classification`             | router           | 5 canonical utterances: the tool/no-tool branch, the route name is one of the offered ones, and a back-reference resolves into a self-contained `intent`.                                                                                   |
| `controller-tool-call-turn`                | controller       | Turn 0, empty history: picks an offered tool, emits `tool_args` the loop can `JSON.parse`.                                                                                                                                                  |
| `controller-final-answer-turn`             | controller       | The answer is already in the turn log: terminates with `Return` + `is_final` and carries the facts through, rather than re-querying.                                                                                                        |
| `controller-tool-error-feedback`           | controller       | The previous call errored: reacts instead of re-issuing the identical failing call.                                                                                                                                                         |
| `critic-accepts-sufficient-attempt`        | critic           | An attempt that answers the intent is passed — a critic that rejects everything is a budget burner.                                                                                                                                         |
| `critic-rejects-then-actor-revises`        | actor            | A wrong-but-_successful_ attempt is rejected, and the rejection reaches the actor as `Attempt.feedback` and changes the proposal (`SA-C1`).                                                                                                 |
| `synthesizer-grounded-summary`             | compactExecution | Reports the counts that are in the log, does **not** invent the one whose query failed, and admits the failure.                                                                                                                             |
| `describe-batch-shape`                     | describe         | One summary per item with ids echoed verbatim — the contract `compactBulkData` matches results back on.                                                                                                                                     |
| `controller-structured-output-reliability` | controller       | N escaping-heavy controller calls, counting parse failures. Reported as a rate; the pass/fail threshold is deliberately an owner decision, so the only check is "at least one valid action".                                                |

### Latency

Every report opens with a **Latency** section: per-call wall-clock (p50 / p95)
and aggregate decode throughput, broken out per client for the whole run and
then per scenario. It is first-class output rather than a footnote, because a
new client's latency profile is one of the two things nobody knows up front and
this suite is the first thing pointed at it.

Three things to know before reading a number out of it:

- **The sample is collected by the runner, not by the scenarios.** `runScenario`
  attaches a second collector to every options bag `ctx.opts` builds, so a
  scenario can neither forget to be timed nor choose which of its calls count —
  which is what makes the reliability scenario's N calls a real p95 sample even
  though it reports only its first collector in the served-by column. The one
  call outside the bag is the injection screen's production-adapter call, so
  that scenario's `ms` exceeds the calls counted for it — deliberately, because
  that call is there to show the production wiring, not to be timed.
- **Samples are attributed to the leaf client that served them**, not to the
  client under test, and non-selected fallback attempts are included. A chain
  that fell back shows up as two rows rather than one blended number, and the
  attempt that failed still cost the caller its wall-clock.
- **Percentiles are nearest-rank over `n` calls, and `n` is printed.** Most
  scenarios make one to three calls, so read p95 there as "the slowest of a
  handful".

The header also carries a **Prompt caching** line, because whether repeated
prefixes get cheaper is what makes the same numbers mean different things on
different routes. It is keyed by client in `CACHING_NOTES` (`report.ts`) and
says _unrecorded_ rather than nothing for a client nobody has recorded yet.
`VerdaQwen` has none today, on both counts: the client declares no
`allowed_role_metadata`, so the templates' `cache_control` breakpoints are
dropped, and the deployment runs vLLM without `--enable-prefix-caching` — so a
repeated long prompt pays full prefill on that route.

### Adding one

Write a module under `scenarios/`, export a `Scenario`, and add it to
`SCENARIOS` in [`run.ts`](run.ts) (declaration order is report order; put cheap
structural checks first). Two rules:

- **Assert structure, not prose.** Envelope parses, route name is in the offered
  set, span is a literal substring, id was echoed back.
- **A scenario with zero checks fails.** `scenarioPassed()` enforces it, because
  a green cell that asserts nothing is worse than a red one — it manufactures a
  coverage number.
