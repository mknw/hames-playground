# Decision calibration (#418 T8)

T8 is built against main `36811416`, including T1–T7 and #528's G7/G8 fixes.
There was no calibration scenario, host feed or smoke decide step on that main.
This change makes **no live run**. Jev's ECE for our questions is **unmeasured**
until the owner runs the commands below; no value is invented here.

The scenario covers the actual exported `memory.recall`, four `memory.store.*`,
`memory.merge` and `document.injection` questions. `route` is explicitly an
eval-only proposal: T9/T10 must refit if their question or labels differ. The
merge question exists on main; #527's policy changes are still a separate open
dependency. Its eventual `requireCalibrated` gate is covered by the corpus.
No consumer, shadow step or routing map is changed here.

## Measurement and interpretation

`app/evals/decision-calibration-fixtures.json` is a versioned synthetic corpus:
112 labelled items, 56 fit and 56 holdout, all eight keys, every label in both
splits. States are distinct across splits per key. Each item is read in canonical
and reversed option order: **224 decision requests per client**. These are
single-question calls even on Jev; batching and latency under batching are not
measured here. The option swap compares label IDs, not positions. Swapped reads
never fit. The report records each serving client from the adapter's actual
`llmCall`, and refuses absent/mismatched evidence; it also retains call timing.

Fits use only the predeclared fit split. Held-out raw and fitted accuracy,
multiclass Brier (sum of squared label errors, range 0–2), ten-bin equal-width
ECE (top-label `p_max` versus correctness), mean label coverage (logprob only),
raw order-swap agreement, and selective retention/accuracy/ECE are reported per
client × key. ECE is **not** computed from the chance-recentred policy confidence.
The confidence-cut sweep uses 0, .25, .5, .75, .9 and 1. Coverage and the number
of coverage samples remain absent/zero for Jev.

For logprob clients a bounded deterministic coordinate search minimises fit
Brier over temperature and letter bias. Letter A is the fixed reference bias;
other biases are additive in log space. Temperature is constrained to .05–20.
The evaluation transform follows production `calibrateLabelMass`. Cut fitting
checks observed confidence/margin boundaries and maximises retained samples
subject to **95% empirical fit accuracy**. No feasible retained sample means no
complete candidate is emitted, rather than representing reject-all with cuts
that could still admit a certain wrong prediction.

**G7: Jev fits CUTS ONLY.** No temperature or bias enters its candidate. Cuts
cannot change Jev's all-sample ECE. If held-out ECE exceeds **.05**, its report
includes the explicit line `REOPEN G7(a): Jev measured ECE=…` and asks for the
owner's decision; T8 does not apply a transform itself. The .95 accuracy floor
and .05 ECE ceiling are **owner-tunable diagnostic defaults under G10**, via
`EVAL_DECISION_ACCURACY` and `EVAL_DECISION_ECE`. They are not new consumer
policies. Held-out ECE and retained accuracy failing those criteria make the
scenario red, while preserving measurements and fitted candidates.

This small corpus is a reproducible diagnostic, not a population calibration
certificate. Some per-key holdouts have only six items; ten-bin ECE is noisy
there. The owner should expand/relabel the corpus and refit before claiming
coverage of real traffic. Reports state this limitation.

## Versioned artifact and host feed

`app/src/lib/inference/decision-calibration.json` is statically imported by
`config.server.ts` and validated through `feedDecisionCalibration` at host
composition, before model calls. Static import also makes a missing file a
build/load failure. There is no runtime filesystem path or fallback artifact.
Its initial committed value is intentionally:

```json
{
  "schemaVersion": 1,
  "contractRevision": "418-t8-v1",
  "status": "unmeasured",
  "clients": {}
}
```

This feeds an **empty table**, so it does not label a logprob readout calibrated.
Jev's existing provider `calibrated` marker stays its transport's fact; without
an entry no fitted cuts are supplied. Missing/malformed/mismatched artifacts
throw, and validation finishes before the process-wide table is replaced.
An explicit unmeasured artifact with entries is refused.

A measured candidate uses the same envelope with `status: "measured"` and:

```json
{
  "JevDecide": {
    "fingerprint": "64-character SHA-256",
    "entries": {
      "route": {
        "minConfidence": 0.6,
        "minMargin": 0.3,
        "n": 6,
        "fittedAt": "2026-10-08T00:00:00Z"
      }
    }
  }
}
```

This is an **illustration of the `clients` field**, not a loadable artifact:
every client must have all eight question keys. Clients may be measured and
committed separately; an absent client's table remains empty. Every entry needs
finite cuts in [0,1], positive integer fit sample count and valid timestamp.
Logprob entries additionally require positive finite `temperature` and a finite
bias for **every canonical answer letter** (`A`, `B`, etc.), not semantic IDs.
Jev refuses temperature/bias, even identity values, both at the host boundary
and in `configureDecisionCalibration` (G7). Unknown clients, keys and entry
properties are refused.

Fingerprints bind the client name, contract revision and **all ordered question
texts/label descriptions**, plus Jev's pinned model/G7 transport revision or the
committed local BAML prompt and client declaration. A changed question, label
order, local model or request flags invalidates the measured artifact. A
server replacing weights under the same model alias is outside this source
fingerprint: the operator must invalidate/refit then. Changing the corpus or
fitter semantics requires a contract revision bump. Candidate files are written
under gitignored `app/evals/reports/`; nothing feeds them automatically. After
reviewing the report, the owner replaces the committed artifact (merging both
client records if needed), runs the hermetic feed pins and commits it.

## Owner live-run commands

**These commands are intentionally not run for this PR.** Run from `app/`.
Ensure `.env` contains the intended endpoints and keys; do not paste secrets
into the report or PR. The privacy controls of the owner's Jev-provider follow-up
must be in place before the first live Jev run (SD-12).

On the main this PR builds from, the Jev transport reads `OPENROUTER_API_KEY`
even when `JEV_DECISIONS_URL` points elsewhere. Use a decision-provider-only
credential under that current name and an explicitly configured owner-approved
zero-retention Decisions-compatible HTTPS endpoint. The separate decision-key
name, URL guard and OpenRouter zero-retention preferences from the owner's
2026-10-08 decision are a separate dependency; update the credential name in
these commands when that follow-up lands. Do not take this runbook as permission
to use the transport's OpenRouter fallback without those controls.

```sh
# .env: JEV_DECISIONS_URL and the decision-only key under the CURRENT
# transport's OPENROUTER_API_KEY name (see dependency above).
USE_VERDA_INFERENCE=0 EVAL_CLIENT=default EVAL_ROLES=decide \
  EVAL_ONLY=decision-calibration pnpm eval:harness

# .env: SMALL_LLM_BASE_URL ends in /v1; SMALL_LLM_API_KEY as appropriate.
# USE_VERDA_INFERENCE=0 avoids waking/refusing the unrelated 27B at import;
# the scenario opens a private run frame for the selected decide client.
USE_VERDA_INFERENCE=0 EVAL_CLIENT=tier EVAL_ROLES=decide \
  EVAL_ONLY=decision-calibration pnpm eval:harness

# Owner-tunable diagnostics, same commands with these additional variables:
# EVAL_DECISION_ACCURACY=0.95 EVAL_DECISION_ECE=0.05
```

A decide-only run skips the chat Critic preflight, so it does not call Anthropic
or wake the Verda 27B just to measure the 4B. The scenario uses the normal decide
adapter inside an explicit tier frame and requires actual serving evidence.
`LocalQwenSmallDecide` already declares `max_tokens 2` on main (G3); no script
lowers it to 1 or uses the summarizer's 2048-token request shape.

The added smoke step runs **after** the existing six steps, so the full smoke
**does wake and bill the 27B** and also calls the small model:

```sh
# .env additionally: VERDA_INFERENCE_ENDPOINT ends in /v1,
# VERDA_INFERENCE_API_KEY; the SMALL_LLM variables above.
USE_VERDA_INFERENCE=1 pnpm dlx tsx --env-file=.env \
  src/lib/inference/scripts/smoke-verda.ts
```

Jev evaluation costs 224 provider requests per client run; the actual bill is
provider-reported. The private evaluation costs 224 small-model calls, with no
27B calls in the decide-only command; the deployment's GPU time/scale-to-zero
cost still belongs to the owner. The adapter's local pricing basis is not proof
that hosted GPU time is free. The smoke can incur cold-start plus GPU runtime.
No monetary estimate is invented without a live measurement.

## Hermetic pins and mutation command

From `app/`:

```sh
pnpm exec vitest run --config scripts/vitest-decision-calibration.config.ts
python3 scripts/check-decision-calibration-mutations.py
pnpm typecheck
pnpm lint
```

The standalone pin config has no global database setup. It runs the new
synthetic math/feed/structure/smoke pins and the relevant existing adapter,
Jev, probe, core decision and CI-exclusion pins. The smoke adapter is mocked;
existing adapter tests serve fixtures over ephemeral loopback HTTP, never
providers. Mutations run a single named pin, require an **assertion failure**
(compiler/loader failures do not count), and restore source in `finally`.
The PR body records each mutation and its observed result. The eval remains
outside CI's collection graph and no CI job invokes `eval:harness`.
