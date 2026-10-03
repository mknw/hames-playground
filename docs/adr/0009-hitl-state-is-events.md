# ADR-0009: HITL decisions are events in the UnifiedContext, and resume derives from them

**Date**: 2026-10-04
**Status**: proposed

A human-in-the-loop request and its answer are recorded as `hitl_request` and
`hitl_response` events in the `UnifiedContext`, and one pure reader derives all
a resume needs from them: what is pending, the run's answers, where to re-enter.
Nothing about a decision lives in `ctx.data`, a core store or a host flag. Why:
no second store holds decision state; host copies are transport and index, and
core validates every answer against the events (#458). An answer's per-run
lifetime then holds by construction, not by a clear a host can skip (#457). And
binding an answer to the exact pause it was issued for (#456 (c)) needs a
request record to check it against.

## Considered options

- **A journal on `ctx.data`**: `hitl.pending`, `hitl.answers` and `resumeAt`
  (#433's first sketch), like today's `approved` flag. It is a second copy of
  facts the events already hold, and it is the shape that leaked `approved` into
  every later turn.
- **A core `HitlStore` that the host implements.** Every package consumer would
  have to implement storage before a gate could pause, and the decision record
  would sit outside the context that the run is resumed from.

## Consequences

- The reserved `approval_request` and `approval_response` names are retired, not
  reused. A legacy `approval_response {approved}` in a stored blob can therefore
  never be read as an answer. Until 1.0, core also keeps deleting a legacy
  `data.approved`.
- A host table may hold an answer in transit and index pending requests. Core
  still validates every answer against the blob's pending requests, so the table
  never decides a resume.
- Out-of-run proposals, such as the memory hook's, are recorded as non-blocking
  requests in the same stream. Appending them requires the version-checked
  context write (#458).
