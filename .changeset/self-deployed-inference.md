---
"@hames-ai/harness-baml": minor
"@hames-ai/harness-patterns": patch
"@hames-ai/agents": patch
---

BREAKING (shipped as a minor bump): rename the
built-in inference tier from `verda` to `self_deployed`, the BAML clients to
`LargeQwen` / `LargeQwenThink` (the 27B) and `SmallQwen` (was `LocalQwenSmall`; the
small box runs on Modal, so `Local` was a misnomer, and `LocalGLM` keeps its name),
and the exported routing and cost identifiers. `self_deployed` names the tier (two boxes); identifiers about the large
model alone take `large` (`largeEurPerHour`, `LARGE_LLM_MODEL_ID`, the `'large'`
wake box). The full old → new table, with each name's scope, is in
`docs/deployment/self-deployed-migration.md`.

Migration for consumers: update imports, role maps (`VERDA_CLIENT_BY_ROLE` →
`SELF_DEPLOYED_CLIENT_BY_ROLE`), model tables, cost-rate registration
(`verdaEurPerHour` → `largeEurPerHour`), `VERDA_CLIENT_NAME` → `LARGE_LLM_CLIENT_NAME`,
`assertServedByVerda` → `assertServedByLarge`, per-call `client` overrides and run frames
together. Regenerate the BAML client from the renamed `large-client.baml`. A run frame still
carrying `'verda'` is read as `self_deployed` (and only that spelling).

The reference host reads historical tier values, and stored `VerdaQwen` /
`VerdaQwenThink` / `LocalQwenSmall` client names, without rewriting rows. Migrate
27B settings to `LARGE_LLM_BASE_URL`, `LARGE_LLM_API_KEY`, `LARGE_LLM_EUR_PER_HOUR`,
`LARGE_LLM_SCALEDOWN_SECONDS` and `LARGE_LLM_WAKE_*`; use
`USE_SELF_DEPLOYED_INFERENCE=1` for the boot-time check that the tier is configured and
`INFERENCE_TIERS=self_deployed` for the restriction. Old environment names and
`INFERENCE_TIERS=private` remain accepted for one release with a boot warning; the
list of what is removed afterwards is in the migration doc. Verda control-plane
credentials retain their provider-specific names. UI copy continues to say Private.
