---
'@hames-ai/harness-patterns': minor
---

Asking a human: the DX surface (#433, slice S4). Additive — the mechanism is S1–S3's, unchanged.

- **`confirm(config)`** — the one-call gate at a chain boundary. Two options: Approve, which the unattended rule never picks (nothing is approved without a person, P4), and Reject — the default, the unattended choice, and by default a `stopsRun` option, so a rejection ends the run. `onReject: 'continue'` lets the chain run past the gate instead; `unattended: 'park'` waits for a person.
- **`humanGate({ request, onAnswer })`** — the custom gate. `request(view, data)` builds any `HitlRequest`, or returns null to ask nothing; `onAnswer` runs once per DECISION — the unattended rule's pick on the run that raised it, and the replayed person's answer on the re-entry after a resume — with the shape the record holds.
- **The runner `harness(...)` returns is bound.** `agent.resume(serialized, answers, opts?)` and `agent.continue(serialized, input, onEvent?, frame?)` carry the agent's own patterns, so a resume can only be made on the agent the pause belongs to. `resumeHarness` / `continueSession` stay for hosts that hold the pattern array themselves.
- **`HarnessResultScoped` is a union on status [F18]**: when the status is `'paused'`, `pending` is non-optional and lists every waiting request; a `running` / `done` / `error` result has no `pending` field. The two-request consumer narrows with `if (r.status === 'paused')` and never reaches for `!`.
- The GUIDE gains the section "Asking a human", whose typechecked snippet is the spec §6 two-request consumer; SPEC documents the gate patterns and the union.
