# ADR-0009: HITL decisions are events in the UnifiedContext, and resume derives from them

**Date**: 2026-10-04
**Status**: proposed

A human-in-the-loop request and its answer are recorded as `hitl_request` and
`hitl_response` events in the `UnifiedContext`. Everything a resume needs comes
from those events, through one pure reader: what is pending, the run's answers,
and where to re-enter. Nothing about a decision lives in `ctx.data`, in a core
store, or in a host flag. We chose this for three reasons:

- The serialized context already is the session, so there is no second store to
  keep in step (#458).
- An answer's per-run lifetime then holds by construction, instead of depending
  on a clear that a host can skip (#457).
- Binding an answer to the exact pause it was issued for (#456 (c)) needs a
  request record to check the answer against.

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
  never be read as an answer.
- A host table (the app's `hitl_requests`) may hold an answer in transit and
  index pending requests. Core still validates every answer against the blob's
  pending requests, so the table never decides a resume.
- Out-of-run proposals, such as the memory hook's, are recorded as non-blocking
  requests in the same stream. They are appended through the conversation's
  optimistic-concurrency write.
