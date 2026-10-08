---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
---

**#419 slice M5a — `withMemory`, `memory_context` threading, and the DATA-fence escape.** Core + BAML only; no app change.

- `@hames-ai/harness-patterns`: `withMemory(cfg)(patterns)` returns `[memoryRecall(cfg), ...patterns]` (the opt-in; the patterns come back as the same objects) and `memoryStoreConfig(cfg)` derives the store half from the same `MemoryConfig`, so recall and `settleMemory` share one owner, embedder, decision seam, wake and **switch** (`enabled` is required). `CompactExecutionInput.memoryContext?` (set from `data.memoryContext` only when non-blank) and `RouteFn`'s trailing `extra?: RouteExtra` (the router passes it only when non-blank). Additive: a `route`/`synthesize` written before them is called exactly as before when nothing is recalled.
- `@hames-ai/harness-baml`: `routeMessageOp` and `defaultSynthesize` pass the block to the trailing BAML `memory_context` parameter. **Breaking for a direct caller of `routeMessageOp`:** its optional collector moved from the fourth parameter to the fifth (`routeMessageOp(message, history, routes, extra, collector)`) so it satisfies `RouteFn`; pass `undefined` for `extra`. New `escapeDataFence` (`@hames-ai/harness-baml/data-fence`): every string the adapters put inside a `---BEGIN DATA---` fence (the extractor's window and latest user message, the compactor's members, the `memory_context` blocks, and the `Decide`/`DecideVerbalized` state) has any fence marker neutralised, so assistant text composed from tool results cannot end the fence. No `.baml` change, so no regenerated client.
