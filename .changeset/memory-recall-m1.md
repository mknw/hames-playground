---
"@hames-ai/harness-patterns": minor
---

**#419 slice M1 — `memoryRecall`, the recall step of persistent memory.** Additive; no existing pattern changes behaviour.

- `memoryRecall(config)`: a chain step (`commitStrategy: 'always'`, `errorSeverity: 'recoverable'`, `estimateTurns: () => 0`) that, when a `memory.recall` gate says the user's message depends on remembered facts, attaches the best matches as `data.memories` + `data.memoryContext`. Core stays generic: the host injects a `MemoryStore` (bound to its owner — no method takes one), the RAW `DecideFn`, a `MemoryQueryEmbedder`, `owner()` and `visibleTiers(turnTier)`; a tier is an opaque string.
- Ranking in `memory-ranking.server.ts`: NFKC tokenizer (identifiers whole, EN/NL/FR stopwords, no stemming), BM25 over the user's own rows, cosine similarity, the floors BEFORE reciprocal-rank fusion (k = 60), the count cap and the token budget (hard-capped at 5% of the responder's window).
- The gate is a policy consumer of #418 (`evaluateDecision`) with **method-scoped thresholds**: the static cuts are fitted on `thresholdMethod` (default `logprob`) and never applied to a read from another method; a calibration entry's own cuts win, and with none the gate abstains `method-mismatch`. Gate, search and the host's wake run concurrently under one deadline (`gate.timeoutMs`, default 1500 ms); a wake that has not landed records `skipped: 'waking'` (`awaitWake` is structurally the app's `awaitMemoryWake`).
- Never stops what follows it: every failure ends in `memories = []` and a return — no `error`, no `warning` — and `data.memories`/`memoryContext` are cleared on EVERY exit.
- New `memory_recalled` event (ids only, never memory content; explicit metadata-only `formatEventData` case), `PatternCapabilities.memory` and `harnessUsesMemory(patterns)` — the opt-in probe for the memory wake and store. SPEC.md and GUIDE.md updated.
