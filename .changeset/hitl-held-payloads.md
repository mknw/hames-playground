---
"@hames-ai/harness-patterns": minor
---

**A blocking request can hold a payload for its logical call (decision-loop-agent slice 8, the subset boundary-guards slice 10 needs).**

- `simpleLoop` computes each dispatched call's logical `callKey` (sha256 of the run, the resumable path to the loop, the turn and the call's position), records it on the `tool_call` event and sets it on the run frame around the dispatch. A retry of the same call recomputes it in any process; it is never the process-local tool-call id.
- New run-frame slot `hitlPayloads` (`HitlPayloadStore`): the host's insert-only store, bound to the run's owner and conversation.
- New `askHumanHolding(request, payload)`: holds the payload under the call key, asks with the key `${digest}:${callKey}` and the `payloadRef`, answers `rebound` when the call is already bound to another payload, and drops the row when the unattended rule decided at once. Also exported: `canonicalJson`, `HOLDING_EXPIRES_IN_MS`, `HitlPayloadStore`, `HoldingOutcome`.
