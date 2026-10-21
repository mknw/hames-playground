# Self-deployed inference migration

The tier is `self_deployed`; the UI calls it **Private**. The capable model can
run on either supported provider. Provider control-plane settings still name
Verda because they address that provider's API.

## Compatibility for one release

Old environment names below remain accepted with a boot warning naming their
replacement. Canonical settings take precedence even if explicitly empty, so an
empty required canonical setting refuses configuration rather than reviving an
old setting. Neither spellings being set still refuses the tier, and under
`INFERENCE_TIERS=self_deployed` (legacy `private`) refuses server startup.

Stored `verda` conversation, preference and memory tiers are read as `self_deployed`.
Memory/provenance reads and typed turn metadata use the same read projection.
An old private memory remains invisible to public turns; unknown memory/proposal
tiers select no rows or are refused.
The existing memory CHECK is widened transactionally to admit both spellings,
without rewriting rows. Held proposal payloads and usage counters also read the alias.
Historical rows are not rewritten. New selections and run frames use the canonical
literal. The BAML client is regenerated from the single committed corpus.

## Complete rename table

One rule decides each name: **`self_deployed` names the tier, which is two boxes** (the
27B and the small model), and an identifier about the 27B box alone takes **`large`**,
matching its `LARGE_LLM_*` settings and its existing `small` siblings. The Scope column
records which one the code does; a few client-name rows are kept for a stated reason.

| Old                                                                    | New                                                                            | Scope | Why                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_LIVE=verda`                                                       | `E2E_LIVE=self_deployed`                                                       | tier  | live mode that runs the whole tier                                                                                                                             |
| `EVAL_CLIENT=VerdaQwen`                                                | `EVAL_CLIENT=SelfDeployedQwen`                                                 | box   | BAML client name; see the client rows                                                                                                                          |
| `EVAL_CLIENT=VerdaQwenThink`                                           | `EVAL_CLIENT=SelfDeployedQwenThink`                                            | box   | BAML client name; see the client rows                                                                                                                          |
| `VERDA_BODY` (Modal smoke)                                             | `LARGE_LLM_BODY`                                                               | box   | the 27B smoke request body                                                                                                                                     |
| UI copy `Private (Verda)`                                              | `Private`                                                                      | n/a   | copy only                                                                                                                                                      |
| Tier literal `verda`                                                   | `self_deployed`                                                                | tier  | stored values read as the new one; no rewrite                                                                                                                  |
| Wake-box literal `verda`                                               | `large`                                                                        | box   | `WakeBox` is now `'large'` or `'small'`; sibling of `small`                                                                                                    |
| `INFERENCE_TIERS=private`                                              | `INFERENCE_TIERS=self_deployed`                                                | tier  | old value accepted for one release                                                                                                                             |
| `DEFAULT_VERDA_EUR_PER_HOUR`                                           | `DEFAULT_LARGE_LLM_EUR_PER_HOUR`                                               | box   |                                                                                                                                                                |
| `DEFAULT_VERDA_SCALEDOWN_SECONDS`                                      | `DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS`                                          | box   |                                                                                                                                                                |
| `DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS`                                | `DEFAULT_LARGE_LLM_WAKE_ATTEMPT_TIMEOUT_MS`                                    | box   |                                                                                                                                                                |
| `DEFAULT_VERDA_WAKE_POLL_INTERVAL_MS`                                  | `DEFAULT_LARGE_LLM_WAKE_POLL_INTERVAL_MS`                                      | box   |                                                                                                                                                                |
| `DEFAULT_VERDA_WAKE_TIMEOUT_MS`                                        | `DEFAULT_LARGE_LLM_WAKE_TIMEOUT_MS`                                            | box   |                                                                                                                                                                |
| `SEAM_DEFAULT_VERDA_EUR_PER_HOUR`                                      | `SEAM_DEFAULT_LARGE_LLM_EUR_PER_HOUR`                                          | box   |                                                                                                                                                                |
| `USE_VERDA_INFERENCE`                                                  | `USE_SELF_DEPLOYED_INFERENCE`                                                  | tier  | switches the whole tier on                                                                                                                                     |
| `VERDA_CLIENT_BY_ROLE`                                                 | `SELF_DEPLOYED_CLIENT_BY_ROLE`                                                 | tier  | maps every role the tier moves, across both boxes                                                                                                              |
| `VERDA_CLIENT_NAME`                                                    | `SELF_DEPLOYED_CLIENT_NAME`                                                    | box   | KEPT: mirrors the BAML client name `SelfDeployedQwen`, which the spec fixes (item 2)                                                                           |
| `VERDA_EUR_PER_HOUR`                                                   | `LARGE_LLM_EUR_PER_HOUR`                                                       | box   |                                                                                                                                                                |
| `VERDA_INFERENCE_API_KEY`                                              | `LARGE_LLM_API_KEY`                                                            | box   |                                                                                                                                                                |
| `VERDA_INFERENCE_ENDPOINT`                                             | `LARGE_LLM_BASE_URL`                                                           | box   |                                                                                                                                                                |
| `VERDA_MODEL_ID`                                                       | `LARGE_LLM_MODEL_ID`                                                           | box   | the 27B's served model id                                                                                                                                      |
| `VERDA_SCALEDOWN_SECONDS`                                              | `LARGE_LLM_SCALEDOWN_SECONDS`                                                  | box   |                                                                                                                                                                |
| `VERDA_WAKE_ATTEMPT_TIMEOUT_MS`                                        | `LARGE_LLM_WAKE_ATTEMPT_TIMEOUT_MS`                                            | box   |                                                                                                                                                                |
| `VERDA_WAKE_FAILED`                                                    | `LARGE_LLM_WAKE_FAILED`                                                        | box   | sibling `SMALL_LLM_WAKE_FAILED`                                                                                                                                |
| `VERDA_WAKE_POLL_INTERVAL_MS`                                          | `LARGE_LLM_WAKE_POLL_INTERVAL_MS`                                              | box   |                                                                                                                                                                |
| `VERDA_WAKE_PROMPT`                                                    | `LARGE_LLM_WAKE_PROMPT`                                                        | box   | the 27B's completion ping                                                                                                                                      |
| `VERDA_WAKE_TIMEOUT_MS`                                                | `LARGE_LLM_WAKE_TIMEOUT_MS`                                                    | box   |                                                                                                                                                                |
| `VerdaGlobal`                                                          | `LargeGlobal`                                                                  | box   | activity-module state type                                                                                                                                     |
| `VerdaQwen`                                                            | `SelfDeployedQwen`                                                             | box   | KEPT: BAML client the spec names (item 2); also a persisted `clientName` and an `EVAL_CLIENT` value. One-line flip to `LargeQwen` if the front rules otherwise |
| `VerdaQwenThink`                                                       | `SelfDeployedQwenThink`                                                        | box   | as `VerdaQwen`                                                                                                                                                 |
| `VerdaState`                                                           | `LargeState`                                                                   | box   | activity-module state type                                                                                                                                     |
| `VerdaWarmth`                                                          | `LargeWarmth`                                                                  | box   | warm state of the 27B box                                                                                                                                      |
| `assertServedByVerda`                                                  | `assertServedBySelfDeployed`                                                   | box   | KEPT with the client name it asserts                                                                                                                           |
| `assertVerdaConfigured`                                                | `assertLargeModelConfigured`                                                   | box   | checks the 27B endpoint and key only; sibling `assertSmallModelConfigured`; the whole-tier check is `assertPrivateTierConfigured`                              |
| `beginVerdaTurn`                                                       | `beginSelfDeployedTurn`                                                        | tier  | counts turns on the tier, whichever box serves each call                                                                                                       |
| `endVerdaTurn`                                                         | `endSelfDeployedTurn`                                                          | tier  | as `beginVerdaTurn`                                                                                                                                            |
| `ensureVerdaAwake`                                                     | `ensureLargeAwake`                                                             | box   | sibling `ensureSmallAwake`                                                                                                                                     |
| `igniteVerdaBox`                                                       | `igniteSelfDeployedBox`                                                        | tier  | calls `ensurePrivateTierAwake`, which wakes both boxes                                                                                                         |
| `noteVerdaCallCompleted`                                               | `noteLargeCallCompleted`                                                       | box   | sibling `noteSmallCallCompleted`                                                                                                                               |
| `noteVerdaCallStarting`                                                | `noteLargeCallStarting`                                                        | box   |                                                                                                                                                                |
| `resetVerdaActivity`                                                   | `resetLargeActivity`                                                           | box   | sibling `resetSmallActivity`                                                                                                                                   |
| `resetVerdaWake`                                                       | `resetLargeWake`                                                               | box   | sibling `resetSmallWake`                                                                                                                                       |
| `verdaAvailable`                                                       | `selfDeployedAvailable`                                                        | tier  | "may a user pick the tier" — answered by the whole-tier check                                                                                                  |
| `verdaCallShare`                                                       | `selfDeployedCallShare`                                                        | tier  | share of the day's calls whose counter row is on the tier                                                                                                      |
| `verdaCalls`                                                           | `selfDeployedCalls`                                                            | tier  | as `verdaCallShare`                                                                                                                                            |
| `verdaClientFor`                                                       | `selfDeployedClientFor`                                                        | tier  | looks a role up in the tier's map                                                                                                                              |
| `verdaConfigured`                                                      | `selfDeployedConfigured`                                                       | tier  | runs the whole-tier assertion                                                                                                                                  |
| `verdaEurPerHour`                                                      | `largeEurPerHour`                                                              | box   |                                                                                                                                                                |
| `verdaInferenceEnabled`                                                | `selfDeployedInferenceEnabled`                                                 | tier  | reads the tier's deployment flag                                                                                                                               |
| `verdaLastCallCompletedAt`                                             | `largeLastCallCompletedAt`                                                     | box   |                                                                                                                                                                |
| `verdaProvenWarm`                                                      | `largeProvenWarm`                                                              | box   | sibling `smallProvenWarm`                                                                                                                                      |
| `verdaScaledownSeconds`                                                | `largeScaledownSeconds`                                                        | box   | sibling `smallScaledownSeconds`                                                                                                                                |
| `verdaWake`                                                            | `largeWake`                                                                    | box   | sibling `smallWake`                                                                                                                                            |
| `verdaWakeAttemptTimeoutMs`                                            | `largeWakeAttemptTimeoutMs`                                                    | box   |                                                                                                                                                                |
| `verdaWakePollIntervalMs`                                              | `largeWakePollIntervalMs`                                                      | box   |                                                                                                                                                                |
| `verdaWakeTimeoutMs`                                                   | `largeWakeTimeoutMs`                                                           | box   |                                                                                                                                                                |
| `verdaWarmth`                                                          | `largeWarmth`                                                                  | box   |                                                                                                                                                                |
| data-testid `verda-warmth`                                             | `large-warmth`                                                                 | box   | header GPU indicator                                                                                                                                           |
| data-testid `verda-ignite-failed`                                      | `self-deployed-ignite-failed`                                                  | tier  | the ignite action                                                                                                                                              |
| `app/src/__tests__/lib/harness-patterns/clients-verda.test.ts`         | `app/src/__tests__/lib/harness-patterns/clients-self-deployed.test.ts`         | tier  |                                                                                                                                                                |
| `app/src/__tests__/lib/harness-patterns/smoke-verda-describe.test.ts`  | `app/src/__tests__/lib/harness-patterns/smoke-self-deployed-describe.test.ts`  | tier  |                                                                                                                                                                |
| `app/src/__tests__/lib/harness-patterns/smoke-verda-preflight.test.ts` | `app/src/__tests__/lib/harness-patterns/smoke-self-deployed-preflight.test.ts` | tier  |                                                                                                                                                                |
| `app/src/__tests__/lib/harness-patterns/verda-body-shape.test.ts`      | `app/src/__tests__/lib/harness-patterns/self-deployed-body-shape.test.ts`      | tier  | renders every routed function                                                                                                                                  |
| `app/src/__tests__/lib/inference/verda-activity.test.ts`               | `app/src/__tests__/lib/inference/large-activity.test.ts`                       | box   |                                                                                                                                                                |
| `app/src/__tests__/lib/inference/verda-wake.test.ts`                   | `app/src/__tests__/lib/inference/large-wake.test.ts`                           | box   |                                                                                                                                                                |
| `app/src/lib/inference/scripts/smoke-verda-load.ts`                    | `app/src/lib/inference/scripts/smoke-large-load.ts`                            | box   | measures the 27B route under load                                                                                                                              |
| `app/src/lib/inference/scripts/smoke-verda.ts`                         | `app/src/lib/inference/scripts/smoke-self-deployed.ts`                         | tier  | routes six calls across both boxes                                                                                                                             |
| `app/src/lib/inference/verda-activity.server.ts`                       | `app/src/lib/inference/large-activity.server.ts`                               | box   |                                                                                                                                                                |
| `packages/harness-baml/baml_src/verda-client.baml`                     | `packages/harness-baml/baml_src/self-deployed-client.baml`                     | box   | holds the `SelfDeployedQwen` clients; named with them                                                                                                          |

`VERDA_CLIENT_ID`, `VERDA_CLIENT_SECRET`, `VERDA_CONTROL_PLANE_BASE`,
`VERDA_DEPLOYMENT_ID`, `VerdaControlPlaneProbe`, `probeVerdaReplicas` and
`verdaControlPlaneConfigured` retain their names. Verda deployment history and
provider documentation keep the provider name.

## Rollback

The app image is forward-only once a turn has run on the new build. New rows carry
`self_deployed` in `conversations.inference_tier`, `user_prefs.inference_tier`,
`memories.tier` and `usage_counters.tier`, and the previous image does not read that
spelling (it treats it as an unknown tier), so rows written meanwhile would not route
or show there. The new image accepts both environment spellings but the previous one
reads only the old names, so keep the OLD names set until the release is final. Roll
the image back only before any turn has run on the new build.

## What comes out after one release

The compatibility below is deleted together, in one change:

- `LEGACY_INFERENCE_ENV` and the boot warnings in `packages/harness-baml/inference-env.server.ts`,
  and the `INFERENCE_TIERS=private` reader in `tier-config.server.ts`;
- the `'verda'` readers: `activeInferenceTier()`'s frame alias, `normalizeStoredInferenceTier`,
  `normalizeStoredContextTiers` and the query-side tier expansions;
- the env aliases in `scripts/bootstrap-vps.sh` (`env_get`) and
  `app/src/lib/eval-support/live-preconditions.ts`;
- the widened memory CHECK and the legacy value in the conversation backfill.

The mutation script `app/scripts/check-self-deployed-mutations.py` lists every pin that
goes with them; delete its cases in the same change.

## Operator follow-up after merge

The server lane owns the environment migration on both deployment clones. In a
stated release window, back up the environment files, journal the change and its
undo, rename one clone's settings, then re-check health before proceeding to the
other clone. Keep this separate from this source change; no deployment or live
inference call is part of the rename PR. Code and SECURITY reviews must converge,
and the owner must check this table before merge.
