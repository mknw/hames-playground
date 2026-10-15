---
'@hames-ai/harness-patterns': minor
'@hames-ai/agents': minor
---

Add `withPseudonymisedInputs` and its host `PseudonymiseForWeb` seam for #507 G14.
Rewrite earlier event-data copies and child plan/handoff on every run except an
explicit Anthropic run, fail closed on missing or unavailable host wiring, and
check outgoing web arguments at `callTool` through concatenating run-frame
`egressChecks`. `decisionLoop` supplies every preceding iteration's source
payloads as roster-only input to declaring routes, removed before inner dispatch.
`AgentDeps.pseudonymiseForWeb` lets hosts supply the ephemeral implementation.
