---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
"@hames-ai/agents": minor
---

The answer writer can read each `decisionLoop` route call's complete trace (#1032). `decisionLoop({ writerEvidence: 'trace' })` (default `'record'`, unchanged) has each route record name the ids of its route call's committed events (`routeRecord.trace`), and `compactExecution`'s thread mode renders them for a record of the current turn: every controller action with its reasoning, every tool call and every successful result, each `actorCritic` attempt with the critic's verdict, the planner's plan with its reasoning and the retriever's full passages with their locators and references. Errored steps are left out and counted; untrusted content arrives exactly as the injection guard committed it; the decisions model and the previous turn keep the compact records. The compact record rides beside the trace as `LoopIteration.compact`, and `defaultSynthesize` falls back to it, oldest route call first, when the traces do not fit the writer's window, reporting the fallen-back calls as `SynthesisResult.fellBack`, which `compactExecution` records as a `writer_evidence` warning before its existing trim. The Synthesize template gains one rule, rendered only beside a trace: a rejected attempt is not the answer. general-next opts in.
