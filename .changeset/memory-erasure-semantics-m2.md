---
"@hames-ai/harness-patterns": minor
---

**#419 M2 erasure semantics (owner decision (b)).** Additive; every existing call keeps compiling.

- `MemoryInsertRow` and `MemoryWriteTx.update`'s `next` gain an optional `evidenceEventId`: the `user_message` event the stored `evidence` quotes. `settleMemory` always sets it (to the turn's user event) and a host stores it beside the text, replacing both together on `update`.
- The `memory.merge` decision now sets `requireCalibrated: true`. A merge destroys the older text, so an uncalibrated, abstained, refused (thrown) or timed-out read falls back to `distinct`, which inserts: both memories are kept. Until a calibration entry exists for the serving client the question abstains, so only the near-duplicate reinforce remains.
- SPEC.md "Erasure semantics" records the rule M3 (compaction) inherits: an `update` keeps every `memory_sources` row, including those no longer supporting the text, so deleting a conversation removes every memory that ever drew on it. `MemoryWriteTx` has no way to remove a source row, and a pin keeps it so.
