---
'@hames-ai/harness-patterns': minor
---

**#419 M2 erasure semantics (owner decision (b)).** Additive for hosts: an implementation of `MemoryWriteTx` keeps compiling; only code that builds a `MemoryInsertRow` itself must now supply `evidenceEventId`.

- `MemoryInsertRow` and `MemoryWriteTx.update`'s `next` gain a required `evidenceEventId`: the `user_message` event the stored `evidence` quotes. `settleMemory` always sets it (to the turn's user event) and a host stores it beside the text, replacing both together on `update`.
- The `memory.merge` decision uses the endpoint verdict. A failed, refused or timed-out call inserts the new memory separately, keeping both memories.
- SPEC.md "Erasure semantics" records the rule M3 (compaction) inherits: an `update` keeps every `memory_sources` row, including those no longer supporting the text, so deleting a conversation removes every memory that ever drew on it. `MemoryWriteTx` has no way to remove a source row, and a pin keeps it so.
