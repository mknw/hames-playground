---
"@hames-ai/harness-patterns": minor
---

**#418 slice T6 — a calibration probe's input and a `decision_made` timeline preview.** Additive.

- `PatternCapabilities.calibratedDecisionKeys` + `harnessCalibratedDecisionKeys(patterns)`: the subset of `decisionKeys` whose policy sets `requireCalibrated` — the keys that abstain on every call until a calibration entry exists. `typedDecision` and `decisionRouter` declare it, and only when the policy requires it. `decisionKeys` and `harnessDecisionKeys` keep their shape and behaviour.
- `getEventPreview` renders a `decision_made` row as `key: label` (or `key: abstained (reason) → fallback`) instead of an empty cell. Metadata only: never the question or the state. Documented in SPEC.md beside the decision paragraph (coordinator decision G6).
