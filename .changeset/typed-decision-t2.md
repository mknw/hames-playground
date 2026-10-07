---
"@hames-ai/harness-patterns": minor
---

**#418 slice T2 — `typedDecision`, `decisionRouter`, `decideFields`.** Additive surface on top of T1; no behaviour change to any existing pattern.

- The awaited wrapper, in `patterns/typedDecision.server.ts`: `evaluateDecision` (scope-free; asks the transport what it will serve, calls the raw seam, scores — and NEVER throws: a throwing or junk-returning seam is an abstained decision on `policy.fallback`), `decide` (in-scope; records exactly one `decision_made` and, on failure, one `error`, with the call record attached to one event only) and `decideFields` (several typed fields over one state — one `decision_made` per field; a one-call `decideAll` provider, a `mode: 'joint'` product pass marginalised per field, or one byte-identical-prefix pass per field). `assertDecisionSetSpec` refuses a joint product above `MAX_DECISION_LABELS`.
- `DecideFn.serving` / `DecideAllFn.serving` (optional): the adapter's contract for the client a call will be served from — its `method` (so a `requireCalibrated` policy abstains BEFORE the call on a knowingly verbalized client) and its calibration entry (whose cuts win, F2). Absent, only the pre-call shortcut is lost; the post-call `method-mismatch` / `uncalibrated` checks still fire.
- The `typedDecision(config)` chain step (writes `data.decisions[spec.key]`, overwritten on every exit, declares `capabilities.decisionKeys`) and `decisionRouter(routes, config)` — `router()`'s decision-typed sibling: never sets `DIRECT_RESPONSE_ROUTE`, `irrecoverable` by default (failure parity with `router`), `preserveIntent`, `conversationalRoute`, and `shadow` (records, sets nothing, can never end a turn). Both have entries in `DEFAULT_TRACK_HISTORY` / `DEFAULT_COMMIT_STRATEGY` / `DEFAULT_ERROR_SEVERITY`.
