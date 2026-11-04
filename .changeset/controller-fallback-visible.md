---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": patch
---

A thinking loop-controller attempt that falls back no longer disappears. When a `ControllerThinking` attempt hits its output cap or produces no answer, the adapter retries it once without thinking. It now also prices the failed attempt and hands its record, with the parser trace, to the controller seam's new optional second argument, `ControllerHooks.onRetry` (`ControllerFn(input, hooks?)`; the input stays plain data). `simpleLoop` records that record as a `warning`, and `WarningTask` gains `'controller'`. This is the planner's existing `onRetry` contract. **Breaking for exhaustive consumers** of `WarningTask`: an exhaustive switch over it must handle the new member.
