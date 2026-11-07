---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
---

Complete the general agent's turn-clock context: the decision state, compact-intent call and both critic variants now receive the same time block as the controllers, planner and synthesizer. Render an ISO date-time with offset, weekday and zone, with an explicit UTC fallback. Keep volatile time after stable prompt prefixes and memoize the shared rendering per turn clock.

Direct generated-client callers passing an options bag to `CompactIntent`, `Critic` or `CriticThinking` must insert `null` (or a current-time block) before that bag. Regenerated clients are included; inference routing is unchanged.

Persist the turn clock through pause/resume, including its zone and unknown-zone flag, and replace it on a new user message. Scope relative-date instructions to the current request, respecting explicit reference dates and dated quotations.
