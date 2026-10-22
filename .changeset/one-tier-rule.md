---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
---

One tier rule: a run frame's tier is the Anthropic tier only when it says exactly
`'anthropic'`; an absent or empty tier takes the host's default tier, a present but
unrecognised one is the self-deployed tier (refused when it is not reachable), and
routing and the guards now read that one answer.

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

- `onExplicitAnthropicTier()` now answers from `activeInferenceTier()`: it throws on a
  restricted deployment (it used to answer), and on a defaulted self-deployed tier
  that is not reachable. A frame with an unrecognised tier is read as the
  self-deployed tier, never as the Anthropic tier, so the decide call never reaches
  Jev: it takes the private client when that tier is reachable, and is refused
  before any request otherwise.
- A host whose policy's `defaultTier` is `'self_deployed'` now has that default
  reachability-checked (`assertTierReachable`) on every read of a run that named no
  tier, and the run is refused when the tier is not configured; it is never routed to
  the Anthropic tier. A policy that names `'self_deployed'` as its default without an
  `assertTierReachable` is refused for the same reason an explicit
  `assertInferenceTier('self_deployed')` is.
- With no host policy registered, the package's fallback is unchanged: the Anthropic
  tier. A library user with no self-deployed tier sees no difference, except that
  `withPseudonymisedInputs` no longer rewrites a run that names no tier, and a frame
  carrying a present but unrecognised tier is refused rather than routed.
- The host's tier policy is now held on a `Symbol.for('hames.harness-baml.tier-policy')`
  holder, so every loaded copy of the package reads the one policy the host
  configured. A test that wants the process-start state (no policy) after
  `vi.resetModules()` must clear that holder too.
