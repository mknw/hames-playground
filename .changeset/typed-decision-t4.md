---
"@hames-ai/harness-baml": minor
"@hames-ai/harness-patterns": patch
---

**#418 slice T4 — the Jev transport: the Anthropic tier's `decide` client.** Additive.

- `harness-baml`: `jev-decide.server.ts` — `createJevTransport()`, a REST adapter for OpenRouter's Decisions API (`typesafe/jev-1.13`) answering a whole decision set in ONE request (`decideAll`) or a single spec (`decide`), `method: 'jev'`, with its own `LLMCallRecord` and `notifyLlmUsage`. Refuses the private tier (a public provider), and fails closed — a connection error, non-2xx or malformed answer is an `LLMCallError`, never a retry elsewhere. `JEV_CLIENTS` now holds `JevDecide`; `createDecideAdapter` routes it to the transport and `serving()` reports `jev` with its calibration entry; new `createDecideAllAdapter(decide)` is the set-level entry (`decideFields`' `decideAll`). `CostEstimator`'s options gain `providerCostUsd`.
- `harness-patterns`: `CostBasis` gains `'provider'` — the figure the provider reported (USD, converted once at the static `EUR_PER_USD`). A new union member: a host exhaustively switching on `CostBasis` needs a branch.
