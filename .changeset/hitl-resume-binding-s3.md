---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

Resume, binding and supersede (#433, slice S3). **Breaking**: `minor`, because the family is at `0.x` and a breaking change takes `minor` there (CONTRIBUTING, "Which bump"). This is the release-bearing changeset for human in the loop: S1 and S2 are additive, and no release happens between S2 and S4.

**Removed:**

- the boolean `resumeHarness(serialized, patterns, approved)`;
- the `ApprovalRequest`, `WithApproval`, `ApprovalRequestEventData` and `ApprovalResponseEventData` types, from `@hames-ai/harness-patterns`;
- `WithApproval` from `@hames-ai/agents`' `AgentData`, so `AgentData` no longer declares `pendingAction` or `approved`;
- the public `setPaused`, from the barrel and from `context.server`. Only the `runChain` that owns a run sets `paused`, for a request it records.

`approval_request` and `approval_response` stay in `EventType` as deprecated legacy members. Nothing emits them any more: `resumeHarness` no longer appends an `approval_response`.

**A 0.1.x paused blob cannot be resumed; `continue()` it.** Such a blob holds no `hitl_request`, so `resumeHarness` refuses it as `no-pending`. `continueSession` still deletes a legacy `data.approved`, and so does `resumeHarness`. Both are the legacy-blob scrub, kept until 1.0.

**Added and changed:**

- **`resumeHarness(serialized, patterns, answers, opts?)`.** `answers` maps each waiting `requestId` to an option id, or to `{ choice, flags }`, and to nothing else. `opts` is `{ principal?, resolve?, onEvent?, frame? }` (`ResumeOptions`). An answer resumes only the pause it was issued for. Every check runs before anything is recorded and before `resolve`, and a refusal throws `HitlAnswerError`, whose `code` is one of `not-paused`, `no-pending`, `expired`, `tier-changed`, `unknown-request`, `missing-answer`, `invalid-choice`, `unavailable-option`, `invalid-flag`, `required-flag` or `chain-changed`. Answers are checked against what the current run waits on, never against its journal, so an answer that was already applied is refused. A required flag must be set `true` by the answer itself.
- **`resolve` must be idempotent per `requestId`.** If a later `resolve` throws, nothing is recorded and the blob is still paused, so a retry calls every `resolve` again.
- **The run continues.** After the checks, `resolve` runs once per answer, inside the run frame. One `hitl_response` is recorded per answer, with `by: 'person'`, the host's `principal` and what `resolve` returned. Each held tool result becomes its outcome after `sanitizeUntrusted` (namespace `hitl`), is marked `heldBy`, and loses its `summary`. A `stopsRun` choice ends the run `done`. Otherwise the paused top-level pattern runs again, through `runChain(ctx, patterns, onEvent?, { startAt })`, and its gate replays the answer.
- **Behaviour change: `continueSession` supersedes.** Before the new message, every request the last run still waits on gets `{ choice: null, by: 'superseded' }`, and its held results say nothing was kept.
- **`expireHitl(serialized, now)`** closes every request past its `expiresAt` with `{ choice: null, by: 'expired' }`. That covers a blocking request of the current run and a non-blocking proposal anywhere in the log. A paused run whose request expired ends `done`. It returns `null` when nothing was due.
- **Behaviour change: `compactBulkData` never summarizes a held result.**
- **Behaviour change: the run's HITL bookkeeping store cannot write the record.** Its identity fields are non-writable, it hands out a copy of the owning context's events, and the owner commits from its buffer only what `askHuman` could have written there. Anything else is dropped with a `console.warn`.
- `ToolResultEventData.heldBy`, and the types `HitlAnswer`, `HitlAnswers`, `HitlAnswerErrorCode` and `ResumeOptions`.
- The observability projection previews `hitl_request` and `hitl_response` by kind and outcome, and a legacy `approval_*` event as `legacy approval event`.
