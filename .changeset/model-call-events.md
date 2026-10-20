---
'@hames-ai/harness-patterns': minor
'@hames-ai/harness-baml': minor
---

Record the injection screen's and the describe tier's model calls as `model_call` events, and fix two boundary timestamps.

- New `EventType` `'model_call'` with `ModelCallEventData` (`role: 'screen' | 'describe'`, `source?`, `items?`). The call's record rides on the event's `llmCall` / `metrics`, so every existing cost fold (`stepCostEur`, `foldEvents`, the panel's totals) includes it, priced on the client BAML actually selected. The record is redacted where the event is built (`createModelCallEvent`, `redactCall`, both exported; `redactCall` moved from `memory-store.server` and is still re-exported there): client, usage, duration and `metrics` survive; `variables`, the prompt and the output do not. `model_call` is in `ALWAYS_COMMIT_TYPES`.
- `InjectionScreen`, `DescribeFn` and `DescribeBatchFn` take an optional trailing `onCall?: CallRecordSink` (new exported type). `withInjectionGuard` records the screen call (a failed one too); `compactBulkData` records each summary call, batch and per-item retry. Screen rows are live; describe rows are appended after the answer has gone out, so they reach the panel and cost summaries on the conversation's next load. Recording is best effort: a recorder that throws is logged and never changes a verdict. An implementation that never calls the sink stays correct and its calls stay unrecorded.
- `@hames-ai/harness-baml`: `withUsageAccounting(name, run, onCall?)` hands the sink the call's record, built from the same collector that is accounted. `createInjectionScreen`, `describeToolResultOp` and `describeToolResultsBatchOp` pass it through. A sink that throws is logged and never replaces the call's own outcome.
- `withReferences` stamped `pattern_enter` after the wrapped pattern had run, and `parallel` stamped every branch's `pattern_enter` and `pattern_exit` at the merge, so the panel (which orders by `ts`) listed a boundary after the events it contains. Both now carry the time the work started (and, for `parallel`, each branch's own end).
