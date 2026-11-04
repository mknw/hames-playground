---
"@hames-ai/harness-patterns": minor
---

The organizational-knowledge validator refuses a near-duplicate node (rule V11): a new node of a name-keyed class whose `nearNameKey` — `nameKey` with accents, punctuation and the class's own label word folded — equals a stored node's of the same label. The refusal names the stored node, and the draft loop's repair feedback tells the model to link to it under its stored name. `OrgGraphStore.snapshot` now also returns the near-duplicates of each requested name, of its label, so the validator can see them. New exports: `nearNameKey`, `rejectionNote`, and the `NearDuplicate` / `RejectedAssertion` types. The check is repeated at write time: `isStale` refuses a new node whose near-duplicate now exists (`StaleView` gains `nodesOf`; `newNodeNames` lists what a write's re-read must include), and a snapshot that cannot be checked completely throws `OrgSnapshotIncompleteError`, which the hook reports as `graph-incomplete`.
