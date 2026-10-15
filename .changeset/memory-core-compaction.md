---
'@hames-ai/harness-patterns': minor
---

Add the optional core memory compaction pass, deterministic clustering and acceptance, configurable per-kind retention, and a daily sweep seam.

`settleMemory` now refuses insertion at `hardLimit` (default 400) with `skipped: full` and `compactionDue: true`, while continuing later reinforcement/update candidates.
