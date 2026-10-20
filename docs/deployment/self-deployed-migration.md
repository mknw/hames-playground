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

| Old                                                                    | New                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `E2E_LIVE=verda`                                                       | `E2E_LIVE=self_deployed`                                                       |
| `EVAL_CLIENT=VerdaQwen`                                                | `EVAL_CLIENT=SelfDeployedQwen`                                                 |
| `EVAL_CLIENT=VerdaQwenThink`                                           | `EVAL_CLIENT=SelfDeployedQwenThink`                                            |
| `VERDA_BODY` (Modal smoke)                                             | `SELF_DEPLOYED_BODY`                                                           |
| Tier literal `verda`                                                   | `self_deployed`                                                                |
| `INFERENCE_TIERS=private`                                              | `INFERENCE_TIERS=self_deployed` (old value accepted for one release)           |
| `DEFAULT_VERDA_EUR_PER_HOUR`                                           | `DEFAULT_LARGE_LLM_EUR_PER_HOUR`                                               |
| `DEFAULT_VERDA_SCALEDOWN_SECONDS`                                      | `DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS`                                          |
| `DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS`                                | `DEFAULT_LARGE_LLM_WAKE_ATTEMPT_TIMEOUT_MS`                                    |
| `DEFAULT_VERDA_WAKE_POLL_INTERVAL_MS`                                  | `DEFAULT_LARGE_LLM_WAKE_POLL_INTERVAL_MS`                                      |
| `DEFAULT_VERDA_WAKE_TIMEOUT_MS`                                        | `DEFAULT_LARGE_LLM_WAKE_TIMEOUT_MS`                                            |
| `SEAM_DEFAULT_VERDA_EUR_PER_HOUR`                                      | `SEAM_DEFAULT_LARGE_LLM_EUR_PER_HOUR`                                          |
| `USE_VERDA_INFERENCE`                                                  | `USE_SELF_DEPLOYED_INFERENCE`                                                  |
| `VERDA_CLIENT_BY_ROLE`                                                 | `SELF_DEPLOYED_CLIENT_BY_ROLE`                                                 |
| `VERDA_CLIENT_NAME`                                                    | `SELF_DEPLOYED_CLIENT_NAME`                                                    |
| `VERDA_EUR_PER_HOUR`                                                   | `LARGE_LLM_EUR_PER_HOUR`                                                       |
| `VERDA_INFERENCE_API_KEY`                                              | `LARGE_LLM_API_KEY`                                                            |
| `VERDA_INFERENCE_ENDPOINT`                                             | `LARGE_LLM_BASE_URL`                                                           |
| `VERDA_MODEL_ID`                                                       | `SELF_DEPLOYED_MODEL_ID`                                                       |
| `VERDA_SCALEDOWN_SECONDS`                                              | `LARGE_LLM_SCALEDOWN_SECONDS`                                                  |
| `VERDA_WAKE_ATTEMPT_TIMEOUT_MS`                                        | `LARGE_LLM_WAKE_ATTEMPT_TIMEOUT_MS`                                            |
| `VERDA_WAKE_FAILED`                                                    | `SELF_DEPLOYED_WAKE_FAILED`                                                    |
| `VERDA_WAKE_POLL_INTERVAL_MS`                                          | `LARGE_LLM_WAKE_POLL_INTERVAL_MS`                                              |
| `VERDA_WAKE_PROMPT`                                                    | `SELF_DEPLOYED_WAKE_PROMPT`                                                    |
| `VERDA_WAKE_TIMEOUT_MS`                                                | `LARGE_LLM_WAKE_TIMEOUT_MS`                                                    |
| `VerdaGlobal`                                                          | `SelfDeployedGlobal`                                                           |
| `VerdaQwen`                                                            | `SelfDeployedQwen`                                                             |
| `VerdaQwenThink`                                                       | `SelfDeployedQwenThink`                                                        |
| `VerdaState`                                                           | `SelfDeployedState`                                                            |
| `VerdaWarmth`                                                          | `SelfDeployedWarmth`                                                           |
| `assertServedByVerda`                                                  | `assertServedBySelfDeployed`                                                   |
| `assertVerdaConfigured`                                                | `assertSelfDeployedConfigured`                                                 |
| `beginVerdaTurn`                                                       | `beginSelfDeployedTurn`                                                        |
| `endVerdaTurn`                                                         | `endSelfDeployedTurn`                                                          |
| `ensureVerdaAwake`                                                     | `ensureSelfDeployedAwake`                                                      |
| `igniteVerdaBox`                                                       | `igniteSelfDeployedBox`                                                        |
| `noteVerdaCallCompleted`                                               | `noteSelfDeployedCallCompleted`                                                |
| `noteVerdaCallStarting`                                                | `noteSelfDeployedCallStarting`                                                 |
| `resetVerdaActivity`                                                   | `resetSelfDeployedActivity`                                                    |
| `resetVerdaWake`                                                       | `resetSelfDeployedWake`                                                        |
| `verdaAvailable`                                                       | `selfDeployedAvailable`                                                        |
| `verdaCallShare`                                                       | `selfDeployedCallShare`                                                        |
| `verdaCalls`                                                           | `selfDeployedCalls`                                                            |
| `verdaClientFor`                                                       | `selfDeployedClientFor`                                                        |
| `verdaConfigured`                                                      | `selfDeployedConfigured`                                                       |
| `verdaEurPerHour`                                                      | `selfDeployedEurPerHour`                                                       |
| `verdaInferenceEnabled`                                                | `selfDeployedInferenceEnabled`                                                 |
| `verdaLastCallCompletedAt`                                             | `selfDeployedLastCallCompletedAt`                                              |
| `verdaProvenWarm`                                                      | `selfDeployedProvenWarm`                                                       |
| `verdaScaledownSeconds`                                                | `selfDeployedScaledownSeconds`                                                 |
| `verdaWake`                                                            | `selfDeployedWake`                                                             |
| `verdaWakeAttemptTimeoutMs`                                            | `selfDeployedWakeAttemptTimeoutMs`                                             |
| `verdaWakePollIntervalMs`                                              | `selfDeployedWakePollIntervalMs`                                               |
| `verdaWakeTimeoutMs`                                                   | `selfDeployedWakeTimeoutMs`                                                    |
| `verdaWarmth`                                                          | `selfDeployedWarmth`                                                           |
| `app/src/__tests__/lib/harness-patterns/clients-verda.test.ts`         | `app/src/__tests__/lib/harness-patterns/clients-self-deployed.test.ts`         |
| `app/src/__tests__/lib/harness-patterns/smoke-verda-describe.test.ts`  | `app/src/__tests__/lib/harness-patterns/smoke-self-deployed-describe.test.ts`  |
| `app/src/__tests__/lib/harness-patterns/smoke-verda-preflight.test.ts` | `app/src/__tests__/lib/harness-patterns/smoke-self-deployed-preflight.test.ts` |
| `app/src/__tests__/lib/harness-patterns/verda-body-shape.test.ts`      | `app/src/__tests__/lib/harness-patterns/self-deployed-body-shape.test.ts`      |
| `app/src/__tests__/lib/inference/verda-activity.test.ts`               | `app/src/__tests__/lib/inference/self-deployed-activity.test.ts`               |
| `app/src/__tests__/lib/inference/verda-wake.test.ts`                   | `app/src/__tests__/lib/inference/self-deployed-wake.test.ts`                   |
| `app/src/lib/inference/scripts/smoke-verda-load.ts`                    | `app/src/lib/inference/scripts/smoke-self-deployed-load.ts`                    |
| `app/src/lib/inference/scripts/smoke-verda.ts`                         | `app/src/lib/inference/scripts/smoke-self-deployed.ts`                         |
| `app/src/lib/inference/verda-activity.server.ts`                       | `app/src/lib/inference/self-deployed-activity.server.ts`                       |
| `packages/harness-baml/baml_src/verda-client.baml`                     | `packages/harness-baml/baml_src/self-deployed-client.baml`                     |

`VERDA_CLIENT_ID`, `VERDA_CLIENT_SECRET`, `VERDA_CONTROL_PLANE_BASE`,
`VERDA_DEPLOYMENT_ID`, `VerdaControlPlaneProbe`, `probeVerdaReplicas` and
`verdaControlPlaneConfigured` retain their names. Verda deployment history and
provider documentation keep the provider name.

## Operator follow-up after merge

The server lane owns the environment migration on both deployment clones. In a
stated release window, back up the environment files, journal the change and its
undo, rename one clone's settings, then re-check health before proceeding to the
other clone. Keep this separate from this source change; no deployment or live
inference call is part of the rename PR. Code and SECURITY reviews must converge,
and the owner must check this table before merge.
