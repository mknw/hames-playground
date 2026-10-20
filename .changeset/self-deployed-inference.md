---
"@hames-ai/harness-baml": major
"@hames-ai/harness-patterns": patch
"@hames-ai/agents": patch
---

BREAKING: rename the built-in inference tier from `verda` to `self_deployed`, the
BAML clients to `SelfDeployedQwen` / `SelfDeployedQwenThink`, and the exported
`VERDA_*` / `verda*` routing and cost identifiers to `SELF_DEPLOYED_*` /
`selfDeployed*` (large-model rates use `LARGE_LLM_*`). Consumers must update
imports, role maps, model tables and run frames together.

The reference host reads historical tier values without rewriting rows. Migrate
27B settings to `LARGE_LLM_BASE_URL`, `LARGE_LLM_API_KEY`, `LARGE_LLM_EUR_PER_HOUR`,
`LARGE_LLM_SCALEDOWN_SECONDS` and `LARGE_LLM_WAKE_*`; use
`USE_SELF_DEPLOYED_INFERENCE=1` for the default and
`INFERENCE_TIERS=self_deployed` for the restriction. Old environment names and
`INFERENCE_TIERS=private` remain accepted for one release with a boot warning.
Verda control-plane credentials retain their provider-specific names. UI copy
continues to say Private.
