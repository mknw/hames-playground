# Decision calibration (#418 T8)

T8 includes merged #526 (decision transport controls) and #527 (calibrated merge gate).
This change makes **no live run**. Jev's ECE for our questions is **unmeasured**
until the owner runs the commands below; no value is invented here.

The scenario covers the actual exported `memory.recall`, four `memory.store.*`,
`memory.merge` and `document.injection` questions. `route` is explicitly an
eval-only proposal: T9/T10 must refit if their question or labels differ.
`eval.noul` and `eval.score` are also eval-only, with no production consumer.
They use neutral synthetic requests: asking for a human reply and urgency on
three concrete levels. No existing two-label choice migrates to noul (Q6).
No consumer, shadow step or routing map is changed here.

## Measurement and interpretation

`app/evals/decision-calibration-fixtures.json` is a versioned synthetic corpus:
**136 labelled items, 68 fit and 68 holdout**, ten keys, every answer in both
splits, revision `418-t8-v2`. The original eight choice keys retain their 112
items unchanged. Each new key has six fit and six holdout items. States are
distinct across splits per key. A score gold is a level id; rubric gold is
noisier than choice gold, so exact accuracy is always reported beside within-one.

Choice and score items are read in canonical and reversed option/level order,
mapped back by semantic id before comparison. Swaps never fit. **Noul gets one
native read per item**, with order-swap agreement explicitly `N/A (native noul
has no option order)`: N/A never counts as agreement or a pass. This makes
**260 decision requests per client** (224 choice, 24 score, 12 noul). Jev still
uses single-question calls; batching performance is not measured. The report
requires the actual serving `llmCall` client and method, and retains timing.

| Type   | Fit loss and proper score                                          | ECE (ten equal-width bins)                                       | Accuracy and cuts                                                                                     |
| ------ | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| choice | Multiclass Brier: sum squared errors, range 0–2                    | Top-label `p_max` versus correctness                             | Exact accuracy; confidence and margin cuts                                                            |
| noul   | Binary Brier `(p-y)²`; fit binary log loss `-log(P(gold))`         | P(true) versus observed frequency of true                        | Exact `holds` accuracy; confidence cut only (symmetric band)                                          |
| score  | Normalized RPS `Σ(F_k-O_k)²/(n-1)` over the n−1 ordinal thresholds | P(level ≥ k) versus observed frequency, averaged over thresholds | MAE of expected index; exact and within-one mode accuracy; confidence cut only, within-one ≥ .95 (Q8) |

Reports label `eceKind` as `top-label`, `binary` or `cumulative`. Score ECE never
uses its ordinal concentration statistic; neither choice nor noul ECE uses
chance-recentred policy confidence. Zero probability on a true outcome has
infinite log loss, rendered as `"Infinity"` rather than JSON null.
The confidence-cut sweep uses 0, .25, .5, .75, .9 and 1. Coverage and its sample
count remain absent/zero for Jev.

Pools are **separate by type**: the existing choice `ALL` pool has its unchanged
56 holdouts; `ALL (score)` and `ALL (noul)` have six each, using their own ECE
above. Each pool has its own red/green gate against `EVAL_DECISION_ECE`; an
empty pool says `no data` and fails. There is no cross-type overall ECE.

For logprob clients a bounded deterministic coordinate search minimises fit
the type's loss above over temperature and letter bias. Letter A is the fixed reference bias;
other biases are additive in log space. Temperature is constrained to .05–20.
The evaluation transform follows production `calibrateLabelMass`. Cut fitting
checks observed confidence boundaries (and margin for choice only) and maximises retained samples
subject to **95% empirical fit accuracy for choice/noul**, or **within-one
accuracy ≥ 95% for score, with exact accuracy reported beside it** (Q8). No feasible retained sample means no
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

**Spike rule:** S5 cut defaults are diagnostics until the owner live run (G10),
even though S3 already completed the real local 4B score/noul spike. S5 lands
before the owner TypeSafe T8 run (Q7). This small corpus is a reproducible
diagnostic, not a population calibration certificate. Some per-key holdouts have only six items; ten-bin ECE is noisy
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
  "contractRevision": "418-t8-v2",
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
every client must have all ten question keys. Clients may be measured and
committed separately; an absent client's table remains empty. Every entry needs
a finite confidence cut in [0,1]; choice additionally requires a finite margin cut
in [0,1], while score/noul refuse any `minMargin` property (even undefined).
Every entry also needs a positive integer fit sample count and valid timestamp.
Logprob entries additionally require positive finite `temperature` and a finite
bias for **every canonical answer letter** (`A`, `B`, etc.), not semantic IDs:
all score level letters, exactly A and B for noul.
Jev refuses temperature/bias, even identity values, both at the host boundary
and in `configureDecisionCalibration` (G7). Unknown clients, keys and entry
properties are refused.

The host loads only metadata from
`app/src/lib/inference/decision-calibration-contract.json`; a hermetic drift pin
requires it to match every current production question export, normalizing
absent type to `choice` only in this metadata. The contract declares `type` for
every spec and `levels` / optional `criteria` in place of `labels` for new types. This
keeps the host feed off the tool-transport import path. Update that versioned
contract alongside a changed production question, and refit; a mismatched
contract revision is refused at composition.

Fingerprints bind the client name, contract revision and **all ordered question
types, texts, label/level descriptions and noul criteria**, plus Jev's pinned model/G7 transport revision or the
committed local BAML prompt and client declaration. A changed question, label
order, local model or request flags invalidates the measured artifact. A
key changing type is a contract revision bump (Q10), while lookup stays
`(client, key)` and `schemaVersion` stays 1. Adding the two eval keys changes
every client fingerprint; all v1 measured artifacts need a refit. The committed
artifact stays unmeasured with empty clients; no measured values land in S5. A
server replacing weights under the same model alias is outside this source
fingerprint: the operator must invalidate/refit then. Changing the corpus or
fitter semantics requires a contract revision bump. Candidate files are written
under gitignored `app/evals/reports/`; nothing feeds them automatically. After
reviewing the report, the owner replaces the committed artifact (merging both
client records if needed), runs the hermetic feed pins and commits it.

## Owner live-run commands

**These commands are intentionally not run for this PR.** Run from `app/`.
Ensure `.env` contains the intended endpoints and keys; do not paste secrets
into the report or PR. The transport reads only `JEV_DECISIONS_API_KEY`, with no
fallback. `JEV_DECISIONS_URL` is guarded to require HTTPS or loopback HTTP;
OpenRouter requests carry default `zdr: true` and `data_collection: 'deny'`
provider preferences (#526). The owner still configures the decision-only key
and provider choice per the 2026-10-08 decision before a live run.

```sh
# .env holds JEV_DECISIONS_API_KEY (decision-only credential), never printed.
# Direct TypeSafe leg: includes native score and noul plus unchanged choices.
JEV_DECISIONS_URL=https://api.typesafe.ai/v1/systemone \
  USE_VERDA_INFERENCE=0 EVAL_CLIENT=default EVAL_ROLES=decide \
  EVAL_ONLY=decision-calibration pnpm eval:harness

# Owner starts tracked make llm-small flags from repo root, on an isolated port:
# make llm-small LLM_SMALL_PORT=18095
# Stop that owned foreground server with Ctrl-C (or kill its PID, never pkill).
# .env holds SMALL_LLM_API_KEY as appropriate; no credentials printed.
# Local 4B leg: includes ordered score and A=true/B=false noul.
# USE_VERDA_INFERENCE=0 avoids waking/refusing the unrelated 27B at import;
# the scenario opens a private run frame for the selected decide client.
SMALL_LLM_BASE_URL=http://127.0.0.1:18095/v1 \
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

Jev evaluation costs 260 provider requests per client run; the actual bill is
provider-reported. The private evaluation costs 260 small-model calls, with no
27B calls in the decide-only command; the deployment's GPU time/scale-to-zero
cost still belongs to the owner. The adapter's local pricing basis is not proof
that hosted GPU time is free. The smoke can incur cold-start plus GPU runtime.
No monetary estimate is invented without a live measurement.

## Hermetic pins and mutation command

From `app/`:

```sh
pnpm exec vitest run --config scripts/vitest-decision-calibration.config.ts
python3 scripts/check-decision-calibration-mutations.py --s5
python3 scripts/check-decision-calibration-mutations.py
pnpm typecheck
pnpm lint
```

The standalone pin config has no global database setup. It runs the new
synthetic report/math/feed/structure/smoke pins and fake-adapter scenario/plumbing tests and the relevant existing adapter,
Jev, probe, core decision and CI-exclusion pins. The smoke adapter is mocked;
existing adapter tests serve fixtures over ephemeral loopback HTTP, never
providers. Mutations run a single named pin, require an **assertion failure**
(compiler/loader failures do not count), and restore source in `finally`.
The PR body records each mutation and its observed result. The eval remains
outside CI's collection graph and no CI job invokes `eval:harness`.

## Public type sources (read as documentation only)

Naming and primitive intent follow [TypeSafe coding agents](https://docs.typesafe.ai/introduction/coding-agents)
and the [published skill](https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md),
read-only data, never installed. [Score](https://docs.typesafe.ai/primitives/score)
defines 2–10 independently described low-to-high levels, a probability-weighted
index and string index probabilities. [Noul](https://docs.typesafe.ai/primitives/noul)
is P(true), without a separate confidence; [confidence](https://docs.typesafe.ai/confidence)
defines ordinal concentration and suggests `abs(2p-1)` for noul. These define
what is measured, rather than granting permission to act.
