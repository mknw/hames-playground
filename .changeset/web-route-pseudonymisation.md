---
'@hames-ai/harness-patterns': minor
'@hames-ai/agents': minor
---

Add `withPseudonymisedInputs` and its host `PseudonymiseForWeb` seam for #507 G14.
Rewrite and post-check earlier event-data copies and all inherited child data on
every run except an explicit Anthropic run, preserving provenance fences,
restricting copied events to the child's view and withholding residual identities
per string body. Missing or unavailable host wiring still fails closed. Check
outgoing arguments for every capability except declared local reads at `callTool`
through concatenating run-frame
`egressChecks`. `decisionLoop` supplies every preceding iteration's source
payloads as roster-only input to declaring routes, removed before inner dispatch.
Local results extend the outgoing literal check through `afterToolCall`.
ActorCritic output records unfence string leaves before JSON stringification;
literal checks normalise JSON escapes and bound compact names to single tokens.
`AgentDeps.pseudonymiseForWeb` lets hosts supply the ephemeral implementation.
