# ADR-0001: Anthropic-only client chains are the default; `USE_MIXED_CHAINS=1` opts out

**Date**: 2026-05-19 — the date the decision was taken
**Status**: accepted

Every BAML function had declared a mixed-provider fallback chain spanning Groq,
OpenRouter and OpenAI, and their combined rate limits made dev iteration too
noisy to debug against: a failure was as likely to be someone else's quota as our
own bug. Every BAML function now routes through an Anthropic-only chain
(`baml_src/anthropic-only.baml`) by default, applied through a single role-based
override surface in `app/src/lib/harness-patterns/clients.server.ts`, and
`USE_MIXED_CHAINS=1` unsets the override so each function falls back to its
declared production chain in `baml_src/clients.baml`.

## Considered options

- **Keep mixed chains everywhere and absorb the noise.** Rejected: the chains are
  a production resilience feature, and paying their failure modes during every
  local iteration inverted the cost.
- **Delete the mixed chains outright.** Rejected: multi-provider fallback is the
  point of the chains in production, and the declarations are the only place that
  routing is expressed. An env flag keeps both shapes alive from one declaration
  set.
- **Per-function opt-in.** Rejected: routing is a deployment-wide property, not a
  per-call one; one flag is one thing to reason about.

## Consequences

- Anthropic-only runs **propagate `BamlValidationError`** rather than silently
  retrying on a degraded provider. The manual Groq-fallback path in
  `baml-adapters.server.ts` was scoped to mixed-mode only in the same change —
  in the default mode a structured-output failure is now visible instead of
  papered over.
- `ANTHROPIC_API_KEY` becomes unconditionally required; the other three keys are
  needed only under `USE_MIXED_CHAINS=1`.
- Production deployments and any mixed-chain testing must remember to set the
  flag — the default is the dev-comfortable one, not the production one.

## Sources

Back-filled. Rationale mined from commit `8455052` (2026-05-19,
`fix(harness): critic owns loop exit; drop assistant prefill; Anthropic-default
routing`), section **P1.5**, which states the cross-provider rate-limit motive
and the `USE_MIXED_CHAINS` opt-in verbatim; and from the "Client routing:
Anthropic-default, mixed-chains opt-in" section of `CLAUDE.md`, which carries the
standing disposition. The chains themselves were later re-pointed at Sonnet 5 by
commit `818e3cb` (2026-07-16) — a model bump, not a change to this decision.
