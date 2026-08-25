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

| Env var              | Default                  | What it does                                                                                                                                                                                                                              |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVAL_CLIENT`        | unset                    | The BAML client to route through, e.g. `VerdaQwen`. Unset (or `default`) is the **baseline**: no override anywhere, so every function runs the Anthropic chain it declares in `baml_src/`.                                                |
| `EVAL_ROLES`         | the production Verda map | Comma-separated roles `EVAL_CLIENT` applies to. Default is `controller,actor,critic,compactExecution` — the same set `USE_VERDA_INFERENCE` moves in production, so a plain run measures the shipped route rather than a hypothetical one. |
| `EVAL_RELIABILITY_N` | `20`                     | Calls in the structured-output reliability sample. `0` skips them, for a quick structural-only pass.                                                                                                                                      |
| `EVAL_ONLY`          | unset                    | Comma-separated scenario ids, to re-run one thing. Unknown ids throw.                                                                                                                                                                     |

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

### The screen is never re-pointed

`screen` is in `PINNED_ROLES` and no combination of env vars moves it. The
injection screen resolves through a role of its **own** rather than riding
`describe` (`SD-4` / `SA-M5`) because a screen is only worth running on a model
that cannot be talked out of reporting by the content it reviews, and that
copies `spans` character-for-character — the guard neutralizes them by literal
match, so a paraphrased span is a missed injection. A security control's model
is not a knob an eval may turn. The `screen-stays-anthropic` scenario asserts
this holds _in the same run_, including that a live call was actually served by
the declared chain rather than by the client under test.

---

## The scenarios

Each pins a **recurrent branch** — a path these workflows really take — with
deterministic assertions. Prose quality is never graded: a check that reads a
model's wording and decides whether it is good enough measures the reader, not
the client. Where a branch has no deterministic reading, the value is recorded
as an _observation_ instead, which lands in the report but never fails the run.

| Scenario                                   | Role             | Branch it pins                                                                                                                                                                                 |
| ------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controller-truncation-detection-wired`    | controller       | `CLIENT_MAX_OUTPUT_TOKENS` has an entry for this client. Without one, `llmCallHitOutputCap()` returns false for every call and the corrective retry is silently dead (`SA-C2`). No model call. |
| `screen-stays-anthropic`                   | screen           | The eval refuses to re-point the screen; a live call is served by the declared chain; spans come back as exact substrings.                                                                     |
| `router-intent-classification`             | router           | 5 canonical utterances: the tool/no-tool branch, the route name is one of the offered ones, and a back-reference resolves into a self-contained `intent`.                                      |
| `controller-tool-call-turn`                | controller       | Turn 0, empty history: picks an offered tool, emits `tool_args` the loop can `JSON.parse`.                                                                                                     |
| `controller-final-answer-turn`             | controller       | The answer is already in the turn log: terminates with `Return` + `is_final` and carries the facts through, rather than re-querying.                                                           |
| `controller-tool-error-feedback`           | controller       | The previous call errored: reacts instead of re-issuing the identical failing call.                                                                                                            |
| `critic-accepts-sufficient-attempt`        | critic           | An attempt that answers the intent is passed — a critic that rejects everything is a budget burner.                                                                                            |
| `critic-rejects-then-actor-revises`        | actor            | A wrong-but-_successful_ attempt is rejected, and the rejection reaches the actor as `Attempt.feedback` and changes the proposal (`SA-C1`).                                                    |
| `synthesizer-grounded-summary`             | compactExecution | Reports the counts that are in the log, does **not** invent the one whose query failed, and admits the failure.                                                                                |
| `describe-batch-shape`                     | describe         | One summary per item with ids echoed verbatim — the contract `compactBulkData` matches results back on.                                                                                        |
| `controller-structured-output-reliability` | controller       | N escaping-heavy controller calls, counting parse failures. Reported as a rate; the pass/fail threshold is deliberately an owner decision, so the only check is "at least one valid action".   |

### Adding one

Write a module under `scenarios/`, export a `Scenario`, and add it to
`SCENARIOS` in [`run.ts`](run.ts) (declaration order is report order; put cheap
structural checks first). Two rules:

- **Assert structure, not prose.** Envelope parses, route name is in the offered
  set, span is a literal substring, id was echoed back.
- **A scenario with zero checks fails.** `scenarioPassed()` enforces it, because
  a green cell that asserts nothing is worse than a red one — it manufactures a
  coverage number.
