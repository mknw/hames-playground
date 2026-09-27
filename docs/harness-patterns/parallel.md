# Parallel execution: design notes

> **Status.** Design notes first written 2026-02-05 and brought up to date 2026-09-24: what `parallel` does, and two further options that were considered and not built; the implementation lives in [`packages/harness-patterns/patterns/parallel.server.ts`](../../packages/harness-patterns/patterns/parallel.server.ts).

`parallel` is a pattern (one step of a harness composition) that runs several
other patterns at the same time and merges what they produce. The reference entry
is the [`parallel` section of SPEC.md](../../packages/harness-patterns/SPEC.md#parallelpatterns).
No agent shipped in `@hames-ai/agents` composes `parallel` or `judge` today.

---

## What was built: `Promise.allSettled`

### Composing two branches (excerpt)

```typescript
import { parallel, simpleLoop, type SimpleLoopData, type ToolSet } from '@hames-ai/harness-patterns'
import { createLoopControllerAdapter } from '@hames-ai/harness-baml'

// Tool names grouped by namespace, from `Tools({ namespaces })` at startup.
declare const tools: ToolSet

type Data = SimpleLoopData & Record<string, unknown>

const research = parallel<Data>(
  [
    simpleLoop(createLoopControllerAdapter(), tools.web ?? [], { patternId: 'web-search' }),
    simpleLoop(createLoopControllerAdapter(), tools.neo4j ?? [], { patternId: 'graph-lookup' }),
  ],
  { patternId: 'concurrent-search' },
)
```

### Behaviour

- Each branch runs in its own scope: an empty event list, the branch's
  `patternId` as its id, and the parent's data object itself, not a copy, so a
  branch that mutates it in place is seen by the others. All branches start
  together under `Promise.allSettled`.
- A branch that fulfils has its events appended to the parent, between a
  `pattern_enter` and a `pattern_exit` event, and its data merged into the
  parent's. The merge is shallow and runs in branch order, so where two branches
  set the same key, the later branch in the list wins.
- A branch that rejects adds one `error` event, `Branch <name> failed: <reason>`.
  The name is the pattern's type (`simpleLoop`), not its `patternId`, so two
  loops that both reject read the same. That error is
  recoverable, so the rest of the chain still runs on the branches that survived.
  If every branch rejects, the errors are marked irrecoverable and the chain stops
  there, rather than handing an empty result to the answer-writing step.
- Patterns in this library catch their own failures and record them as `error`
  events ([GUIDE.md §4](../../packages/harness-patterns/GUIDE.md#4-the-error-surface)),
  so a branch that failed usually still fulfils, with an `error` event among its
  events. Rejection means a branch threw past its own handler.
- For progress displays, a `parallel` step is estimated at the turn count of its
  longest branch.

**Use cases:**

- Search several sources at once (web, docs, graph).
- Fetch independent data in parallel.
- Fan out one query to several backends.

---

## Options considered, not built

Two further shapes were sketched. Neither exists in the package; the sketches are
not valid against its API.

### Streaming (progressive results)

```text
parallelStream(patterns, onChunk)
// Patterns emit via ctx.emit(), results streamed as available
```

**Use case:** updating a UI as each branch produces a result; acting on the first
result to arrive.

A related mechanism did ship for a different purpose: a pattern configured with
`liveEvents: true` streams its events to the harness's `onEvent` listener as they
happen instead of at commit ([GUIDE.md §2](../../packages/harness-patterns/GUIDE.md#configuration)).
It reports progress; it does not let a later step act on an early result.

### Event-driven coordination

```text
parallel(
  { searcher, critic, compactExecution },
  {
    on: {
      'searcher:RESULT': (d) => emit('critic:EVALUATE', d),
      'critic:APPROVED': (d) => emit('compactExecution:PRIME', d),
      'compactExecution:SUFFICIENT': () => controller.abort()
    }
  }
)
```

**Use case:** branches that negotiate with each other, or a run that stops early
once one branch reports it has enough.

---

## Combining with `judge` (excerpt)

The composition this was designed for: search several sources at once, rank what
came back, then write the answer. `judge` is the ranking step. It takes an
evaluator function you write; no model-backed evaluator ships in
`@hames-ai/harness-baml`.

```typescript
import {
  parallel,
  simpleLoop,
  judge,
  compactExecution,
  type ConfiguredPattern,
  type EvaluatorFn,
  type JudgeData,
  type SimpleLoopData,
  type ToolSet,
} from '@hames-ai/harness-patterns'
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'

declare const tools: ToolSet
// Yours: score each candidate, return the rankings and the best one.
declare const qualityEvaluator: EvaluatorFn

type Data = SimpleLoopData & JudgeData

const baml = bamlPatterns()

const sources = parallel<Data>([
  simpleLoop(createLoopControllerAdapter(), tools.web ?? [], { patternId: 'web' }),
  simpleLoop(createLoopControllerAdapter(), tools.neo4j ?? [], { patternId: 'graph' }),
  simpleLoop(createLoopControllerAdapter(), tools.context7 ?? [], { patternId: 'docs' }),
])

const patterns: ConfiguredPattern<Data>[] = [
  sources,
  judge<Data>(qualityEvaluator, { patternId: 'judge' }),
  compactExecution<Data>({ mode: 'response', synthesize: baml.synthesize }),
]
```

`judge` hands the evaluator every `tool_result` event its view can see, each as
`{ source: <patternId>, content: <the event's data as JSON> }`, optionally capped
by `maxCandidates`. It sets `data.response` to the best candidate's content,
with `data.judgeReasoning` and `data.rankings` beside it. It also describes the
evaluation in a `controller_action` event, but `judge` has no default
`trackHistory` entry, so that event is not committed unless you pass one, for
example `trackHistory: 'controller_action'`. With no
`tool_result` to rank, it records a recoverable `error` event
("No candidates to evaluate") and changes nothing.
