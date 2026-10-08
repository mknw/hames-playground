---
"@hames-ai/harness-patterns": minor
---

**#419 slice M2 — `settleMemory`, the store step of persistent memory.** Additive; no existing pattern changes behaviour.

- `settleMemory(ctx, config)`: after the reply, one `decideFields` over the question/answer pair (`sensitive`, `target`, `confirm`, `kind`; each `requireCalibrated`, fail-closed fallbacks `sensitive`/`none`/`ask`/`episodic`), then extract → deterministic acceptance → embed → a per-candidate transaction. Never throws; every uncertain path stores nothing and returns a reason. The host starts it from inside its post-turn continuation and awaits it before saving, so the `memory_written` events ride that one save.
- The evidence rule: a memory's evidence must be a verbatim span of the CURRENT user message; tool results, non-final assistant text and `llmCall` records never enter the window. `acceptCandidate` (pure, exported) also enforces the closed kind set, one line ≤ 280 characters, identifier closure and a zero-finding injection sanitizer.
- Dedupe and merge under the owner's lock: near-duplicates reinforce, related preferences/traits go to a bounded `memory.merge` question, everything else inserts. The provenance row is written in the SAME transaction as its memory and a primary-key conflict rolls the candidate back, so a retry is a no-op and a crash leaves no orphan.
- Seams: `MemoryWriteStore`/`MemoryWriteTx` (the transactional write side of the owner-bound store), `MemoryExtractFn`, `MemoryEmbedder` (recall's query half plus `documents`). Pre-M6 (`ask` with no confirmation mechanism) and pre-M12 (an org-graph target with no writer) store nothing and log; an org target always asks.
- New `memory_written` event (ids, kind, tier and action — never the content, nor a hash of it; the extractor's call rides it redacted; explicit metadata-only `formatEventData` case). `settings.enabled` is required for a write (absent → nothing stored, D11); `MemoryWriteTx.addSource` returns `{ inserted, memoryId }` and `read(id)` is added so a retry re-records a lost event. SPEC.md and GUIDE.md updated.
