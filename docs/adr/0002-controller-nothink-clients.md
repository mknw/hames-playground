# ADR-0002: The simpleLoop controller runs on the `*NoThink` clients

**Date**: 2026-07-29 — the date the decision was taken
**Status**: accepted

These models run extended thinking by default — nothing in the app asks for it —
and the trace comes back unexposed (empty string plus a signature), so we pay for
tokens that can neither be read nor replayed into `reasoning`. Measured on 12
captured controller prompts × 6 samples × 2 variants (144 calls), thinking-off
was strictly better for the simpleLoop controller — 72/72 valid actions vs 70/72,
zero empty completions vs two, median output 438 → 249 tokens — so
`ControllerAnthropic` was pointed at the new `AnthropicSonnet5NoThink` /
`AnthropicSonnet46NoThink` clients (#139).

The measurement's real finding is behavioural rather than economic: `Return` was
chosen 34/72 with thinking off against 21/72 with it on. Given a search that had
already returned 14 results, thinking-off returned them (4/4) while thinking-on
searched **again** (3/4), one of those re-running the same query with `limit` 14
instead of 15. The controller stops re-querying when it already holds the answer.

## Considered options

- **Leave thinking on and rely on the empty-completion retry** added in #138.
  Rejected: the retry is a net, not a cure — it catches the 2/72 failures but not
  the churn, which was the larger cost.
- **Disable thinking for every Anthropic client.** Rejected, and deliberately so.
  The corpus contained **zero actor prompts** and nothing deeper than two turns,
  so the result does not transfer. `ActorAnthropic` was split out in the same
  change — it previously shared `ControllerAnthropic` — specifically to stop a
  measurement taken on simpleLoop from silently applying to the actor, which
  drives the deepest loop we run. Router, critic, synthesizer and describe were
  left untouched for the same reason.

## Consequences

- The backstop stays Sonnet-tier (`AnthropicSonnet46NoThink`, no Haiku fallback):
  structured output is what the controller emits, and demoting a tier on the
  retry trades one failure mode for another.
- The new client names had to be registered in all three client-keyed maps in
  `app/src/lib/settings.ts`. A missing `CLIENT_MAX_OUTPUT_TOKENS` entry would make
  `llmCallHitOutputCap()` blind and silently disable the truncation retry; a
  missing pricing entry reports cost as unknown. Both are asserted by test rather
  than left to review.
- The actor, router, critic and synthesizer keep thinking **unmeasured**. That is
  a known gap, not an endorsement.

## Sources

Back-filled. Rationale mined from issue **#139** (the problem statement, the
unexposed-trace JSON, and the replay-harness methodology) and commit `f19e9eb`
(2026-07-29, `feat(harness): disable extended thinking on the simpleLoop
controller (#139)`), which carries the measurement table, the scoping rationale
and the settings-map note. The condensed version lives in `CLAUDE.md` under
**Extended thinking (#139)**.
