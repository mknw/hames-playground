---
'@hames-ai/harness-patterns': minor
'@hames-ai/harness-baml': minor
---

One tier rule: a run frame's tier is the Anthropic tier only when it says exactly
`'anthropic'`; an absent, empty or unrecognised tier takes the host's default tier,
and routing and the guards now read that one answer.

`@hames-ai/harness-patterns` adds `registerEffectiveTier(read)` and
`effectiveTier()` to `run-frame.server`. Core interprets no tier string: the tier
module registers the function that answers, and `effectiveTier()` returns what it
returns, or `undefined` when nothing is registered. `withPseudonymisedInputs` now
decides "explicit Anthropic" from `effectiveTier()` (falling back to the raw frame
tier only when nothing is registered).

`@hames-ai/harness-baml` moves the tier vocabulary and readers into a new
`tier.server` module (`InferenceTier`, `InferenceTierPolicy`,
`configureInferencePolicy`, `assertInferenceTier`, `activeInferenceTier`,
`onExplicitAnthropicTier`, `privateInferenceOnly`); `clients.server` re-exports every
name, so import paths do not change. The module registers `activeInferenceTier` as
`effectiveTier()` at load.

Migration for consumers (pre-1.0, so a minor bump):

- `onExplicitAnthropicTier()` now answers from `activeInferenceTier()`, so a frame with
  an unrecognised tier is read as the policy's default tier rather than as "not
  explicitly Anthropic".
- A host whose policy's `defaultTier` is `'self_deployed'` now has that default
  reachability-checked (`assertTierReachable`) on every read of a run that named no
  tier, and the run is refused when the tier is not configured; it is never routed to
  the Anthropic tier. A policy that names `'self_deployed'` as its default without an
  `assertTierReachable` is refused for the same reason an explicit
  `assertInferenceTier('self_deployed')` is.
- With no host policy registered, the package's fallback is unchanged: the Anthropic
  tier. A library user with no self-deployed tier sees no difference, except that
  `withPseudonymisedInputs` no longer rewrites a run that names no tier.
