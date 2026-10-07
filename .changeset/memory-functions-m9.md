---
"@hames-ai/harness-baml": minor
---

**#419 slice M9 — the memory model functions.** Additive surface; no behaviour change for a caller that passes no memory.

- `ExtractMemory` and `CompactMemories` (`baml_src/memory.baml`, committed `baml_client`), both on the `describe` role: `DescribeAnthropic` on the Anthropic tier, `LocalQwenSmall` through the per-call `clientOverrideFor('describe')` spread on the private tier. `kind` is a plain string so core's deterministic acceptance, not the parser, drops an out-of-set value.
- `createMemoryExtractAdapter()` / `createMemoryCompactAdapter()` (and their input types) — the `MemoryExtractFn` / `MemoryCompactFn` implementations, each spreading the describe override inline. They return the model's output unfiltered.
- `Router` and `Synthesize` gain a trailing optional `memory_context`, rendered only when non-null as a user-role block after the leading system block. **Positional**: the options bag moved one slot right, so a direct `b.Router(…, opts)` / `b.Synthesize(…, opts)` caller must now pass `null` before `opts`. In-repo callers are updated.
- `SWITCHED_FUNCTIONS_BY_ROLE.describe` lists the two new functions, so `TIER_SWITCHED_FUNCTIONS` is sixteen.
