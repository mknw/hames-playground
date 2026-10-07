---
"@hames-ai/harness-baml": minor
---

**#418 slice T5 — the explicit verbalized secondary: `DecideVerbalized`, `DecideAnthropic`, `createVerbalizedDecide()`, `configureDecideSecondary()`.** Additive; with nothing configured, behaviour is unchanged.

- `baml_src/decide.baml`: `DecideVerbalized(state, question, options) -> VerbalizedOption[]` — a chat model states a probability per option. `anthropic-only.baml`: `DecideAnthropic`, its own Sonnet-tier, thinking-off chain (not in the `DescribeAnthropic` block). The regenerated `baml_client` is committed.
- `createVerbalizedDecide()` (`baml-adapters.server.ts`): the injectable secondary for `createDecideAdapter({ verbalized })`. `method: 'verbalized'` and `calibrated: false` are constants, so a `requireCalibrated` policy abstains on it; a response with no usable probability is an `LLMCallError`, never a confident distribution. It carries its own tier lock (positive match on the Anthropic tier) and refuses to serve the role's default client, so it answers only a client an operator named.
- `clients.server.ts`: `configureDecideSecondary('DecideAnthropic' | undefined)` — validated, applied on a positive match of the Anthropic tier, and read through one function by both `resolveClientForRole('decide')` and `clientOverrideFor('decide')`. New exports `DECIDE_SECONDARY_CLIENTS`, `DECIDE_DEFAULT_CLIENT`, `DecideSecondaryClient`, `verbalizedProbabilities`.
