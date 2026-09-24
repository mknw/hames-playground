# withReferences: design record

> **Status.** Design record written 2026-04-30 and implemented in [PR #34](https://github.com/mknw/hames-playground/pull/34) ([issue #30](https://github.com/mknw/hames-playground/issues/30)); the implementation now lives in [`packages/harness-patterns/`](../../packages/harness-patterns/), and [§14](#14-what-shipped-differently) lists where it departs from this design. The motivating case writes fetched data into Neo4j, which works only when writes are enabled for the Neo4j tool server (`read_only: false` under `neo4j-cypher` in [`configs/mcp-config.yaml`](../../configs/mcp-config.yaml)).

This page records why `withReferences` exists and how it was meant to work. The
reference for the shipped wrapper is the
[`withReferences` section of SPEC.md](../../packages/harness-patterns/SPEC.md#withreferencespattern-config);
the hands-on walkthrough is [`withReferences-tutorial.md`](./withReferences-tutorial.md).

Terms used throughout:

- A **pattern** is one step of a harness composition, for example `simpleLoop` (a
  tool-calling loop) or `router` (intent classification). A **wrapper** is a
  pattern that runs another pattern inside it.
- The **controller** is the model call inside a loop that decides the next tool
  call on each turn.
- A **ref** is a pointer to an earlier `tool_result` event, identified by that
  event's id (`ref_id`), carried with a one-line summary instead of the full result.

Issues #26 and #29 were closed as superseded by #30. The companion synthetic tool
from issue #19, `expandPreviousResult`, landed in the same PR; [§4](#4-mechanism)
shows how the two compose.

## 1. Problem

Before this design, cross-pattern data flow was implicit and unspecified.

**Concrete failure** (debugging session 2026-04-30, agent `default`, since renamed `search`):

| Turn | User input                                    | Route       | What the controller saw                                    |
| ---- | --------------------------------------------- | ----------- | ---------------------------------------------------------- |
| 3    | "search the web for postgres 18 release info" | web-search  | (full web results)                                         |
| 4    | "add this info to the graph"                  | neo4j-query | `priorResults: []`, `intent: "Add this info to the graph"` |

Turn 4's `neo4j-query` controller had no access to the postgres-18 data from turn 3. It received only "Add this info" as a user message, with no content. It spent 5 turns probing the schema and looking for related nodes, never attempted a write, hit `maxTurns` silently (fixed separately), and `compactExecution` (the pattern that writes the user-facing answer) summarized turn 3's web results instead of describing graph writes that never happened.

**Root cause:** nothing recognized that data produced by an earlier pattern was relevant to the current one.

The framework had three partial answers, each covering one slice:

| Issue | Mechanism                    | Direction                 | Decision-maker              |
| ----- | ---------------------------- | ------------------------- | --------------------------- |
| #19   | `expand_data` synthetic tool | Within one loop's run     | Controller, mid-loop        |
| #26   | Router pushes `references[]` | Across pattern boundaries | Router model at dispatch    |
| #29   | `priorTurnsScope: 'self'`    | Across pattern boundaries | Static (patternId equality) |

These are three policies for the same question: **which prior data should this pattern see, in what form, and who decides?**

## 2. Goals and non-goals

### Goals

- Replace #26 and #29 with one declarative wrapper.
- Keep #19 as the inner-loop counterpart: the controller can expand any compact ref mid-loop.
- Change no controller BAML signature.
- Operate at pattern ingress; egress is already covered by event tracking and `compactBulkData` (the background summarizer of tool results).
- Leave a trace of every selection decision in `ctx.events`.

### Non-goals

- Producer-side declaration of refs (no `publishRefs` on patterns; everything in `ctx.events` is implicitly available).
- Recomputing relevance mid-loop (selection happens once per pattern entry; the next pattern's entry selects again).
- Egress filtering or summarization (already in place).
- Choosing which model writes summaries (handled by `compactBulkData` and the `describe` role).

## 3. Reference taxonomy

Two kinds of cross-pattern data flow:

```text
                            ╭─────────────────────────────────╮
                            │  pattern (e.g. simpleLoop)      │
                            │                                 │
                            │  ┌─ controller turn 1 ─┐        │
        external (ingress) ─┼──► priorResults        │  (internal)
                            │  └─ controller turn 2 ─┘  ◄────┐│
                            │     │ may call expand_data     ││
                            │     ├─ tool_call               ││
                            │     ╰─ tool_result ────────────┘│
                            ╰─────────────────────────────────╯
```

- **External (ingress).** `withReferences` decides which compact refs to attach when a pattern is entered. Output: a `priorResults` array merged into the controller's BAML input.
- **Internal (mid-loop).** `expand_data` (#19; shipped as `expandPreviousResult`) lets the controller, during its reasoning, pull the full body of any compact ref it received. One call may name several ref ids. Budgeting tokens is the controller's responsibility, with a hard cap from the wrapper.

The two compose: `withReferences` attaches **summaries**; the loop optionally expands selected refs to **full content** (or full-but-trimmed).

## 4. Mechanism

On pattern entry, the wrapper:

```text
1. Read tool_result events visible per scope/source filter
   (excluding hidden / archived per existing data-stash semantics)
2. Build candidate list: [{ ref_id, tool, summary, tool_args, ts }, ...]
3. Skip if:
   - Empty candidates → attach nothing, dispatch
   - Single candidate → attach unconditionally, dispatch
   - Cache hit on (intent_hash, stash_snapshot_hash) → reuse decision
4. Otherwise: call b.ReferenceSelector(intent, recentMessages, candidates)
   - Returns: ranked refs with reasons
   - Cap by token budget (top-K that fit)
5. Track reference_attached event with { candidates, selected, reasons }
6. Set scope.data.attachedRefs (PriorResult[])
7. Dispatch to wrapped pattern
```

The design placed the merge in the adapter layer (`baml-adapters.server.ts`): it would merge `scope.data.attachedRefs` into the BAML `turns_previous_runs: PriorResult[]` argument, which the `LoopController` prompt already renders under `RESULTS FROM PREVIOUS TASKS:`, so **no controller-prompt change** was needed. The merge shipped in `simpleLoop` instead ([§14](#14-what-shipped-differently)).

## 5. API

As designed, the wrapper took an optional config. As shipped, the config and its
`selector` are required, and the core package carries no default selector. The
field set is otherwise the one designed here. The shipped declarations are
`WithReferencesConfig`, `SelectorFn` and `ReferenceCandidate` in
[`types.ts`](../../packages/harness-patterns/types.ts), exported from
`@hames-ai/harness-patterns/patterns`.

### Supplying a selector (excerpt)

The selector is the one thing you must pass. A deterministic one needs no model,
which is how the eval suite ([§9](#9-eval-suite-canonical-cases)) exercises the
wrapper:

```typescript
import {
  withReferences,
  type ConfiguredPattern,
  type SimpleLoopData,
} from '@hames-ai/harness-patterns'
import type { SelectorFn } from '@hames-ai/harness-patterns/patterns'

// Attach the two most recent candidates, with no model call.
const newestTwo: SelectorFn = async ({ candidates }) => ({
  selected: [...candidates]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 2)
    .map((c) => ({ ref_id: c.ref_id, reason: 'most recent' })),
  reasoning: 'Deterministic policy: the two most recent results.',
})

// Your tool loop, built elsewhere.
declare const graphLoop: ConfiguredPattern<SimpleLoopData & Record<string, unknown>>

const graphRoute = withReferences(graphLoop, { scope: 'global', selector: newestTwo })
```

The model-backed selector ships in `@hames-ai/harness-baml` as
`bamlPatterns().selector`; it calls the BAML function below.

### Default selector

This is the design's BAML function. The shipped copy in
[`with-references.baml`](../../packages/harness-baml/baml_src/with-references.baml)
has the same classes, signature, client and prompt, plus a `@description` on each field.

```baml
class ReferenceCandidate {
  ref_id      string
  tool        string
  summary     string
  tool_args   string?
  ts_offset_s int  @description("Seconds before now")
}

class ReferenceSelection {
  ref_id string
  reason string
}

class ReferenceSelectorResult {
  reasoning string  @description("Why these were chosen / why none were chosen")
  selected  ReferenceSelection[]
}

function ReferenceSelector(
  intent: string,
  recent_messages: Message[],
  candidates: ReferenceCandidate[],
) -> ReferenceSelectorResult {
  client DescribeAnthropic
  prompt #"
    {{ _.role("system") }}
    Select prior tool results that are relevant to the user's current intent.

    RULES:
    - Rank candidates by relevance, but include any that are plausibly useful.
    - Return zero candidates only if **all** items are completely unrelated to the intent and recent dialogue.
    - Prefer recent items over older ones when relevance is similar.
    - Reasons should be one short sentence each.

    {{ _.role("user") }}
    INTENT: {{ intent }}

    RECENT DIALOGUE:
    {% for m in recent_messages %}
    - {{ m.role }}: {{ m.content }}
    {% endfor %}

    CANDIDATES:
    {% for c in candidates %}
    - id: {{ c.ref_id }}
      tool: {{ c.tool }}
      summary: {{ c.summary }}
      {% if c.tool_args %}args: {{ c.tool_args }}{% endif %}
      ts_offset: {{ c.ts_offset_s }}s ago
    {% endfor %}

    {{ ctx.output_format }}
  "#
}
```

The design biased toward inclusion: cap by **token budget** at the wrapper, never by relevance score. The selector ranks; the wrapper truncates.

## 6. Observability: the `reference_attached` event

A new `EventType`, `'reference_attached'`. Payload:

```typescript
interface ReferenceAttachedEventData {
  candidates: Array<{ ref_id: string; tool: string; summary: string }>
  selected: Array<{ ref_id: string; reason: string }>
  reasoning: string // The selector's overall justification
  skipped?: 'empty' | 'single' | 'cached' // When the selector wasn't called
}
```

The shipped type has exactly these fields
([`types.ts`](../../packages/harness-patterns/types.ts), `ReferenceAttachedEventData`).
For post-mortems: filter for `reference_attached` events on the failing turn,
confirm the selector saw the relevant ref, and read why it was or was not selected.
The event reaches the log only when the wrapper's `trackHistory` includes it
([§14](#14-what-shipped-differently)).

## 7. Skip optimizations

| Condition                                         | Behavior                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Empty eligible stash                              | Skip entirely; track `reference_attached` with `skipped='empty'`, `selected=[]` |
| Single eligible candidate                         | Attach unconditionally; track with `skipped='single'`, `selected=[that one]`    |
| Cache hit on `(intent_hash, stash_snapshot_hash)` | Reuse last decision; track with `skipped='cached'`                              |

`stash_snapshot_hash` was defined as a hash of `(eligible_ref_ids.sorted, ref_summaries)`. Both are stable within a turn and change slowly across turns, so the expected hit rate is high.

## 8. Plumbing: adapter merge

The design's sketch, not the shipped code:

```text
// baml-adapters.server.ts (sketch)

// In createLoopControllerAdapter:
const attachedRefs = (scope.data.attachedRefs as PriorResult[] | undefined) ?? []
const mergedPriorResults = dedupByRefId([
  ...attachedRefs,
  ...priorResultsFromExistingPath
])
```

Dedup by `ref_id`: if `withReferences` and the existing `priorTurnCount` window both surface the same event, count it once. The shipped merge does exactly this, inside `simpleLoop` ([§14](#14-what-shipped-differently)).

## 9. Eval suite (canonical cases)

The design called for a file of manually curated cases. It exists as
[`with-references-eval.test.ts`](../../app/src/__tests__/lib/harness-patterns/with-references-eval.test.ts)
in the hames app, this repository's reference host, and each case swaps in a
deterministic fixture selector, so it runs with no model and no key.

| Case                               | Stash                                                      | Intent                       | Expected selection                                             |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| **postgres-18** (the trigger case) | web-search returned full postgres-18 release content       | "Add this info to the graph" | postgres-18 ref **must be selected**                           |
| **stale on-topic**                 | neo4j query result from 5 turns ago about a different area | "list all Person nodes"      | Either; not a hard requirement                                 |
| **conversational unrelated**       | Several tool results from earlier in the session           | "thanks!"                    | **Empty selection** (hard floor)                               |
| **multiple relevant**              | 3 web searches on the same topic                           | "summarize what we found"    | All 3 selected (within budget)                                 |
| **scope=self**                     | Mix of neo4j and web results, wrapper on neo4j-query       | (anything)                   | Only neo4j-tagged candidates eligible, regardless of selection |

## 10. Implementation plan

All eight steps landed in PR #34; paths are given as they are today.

1. **Types**: `WithReferencesConfig`, `SelectorFn`, `ReferenceAttachedEventData`, the new `EventType` (`packages/harness-patterns/types.ts`).
2. **BAML**: `b.ReferenceSelector` in `packages/harness-baml/baml_src/with-references.baml`.
3. **Pattern**: `packages/harness-patterns/patterns/with-references.server.ts`.
4. **Merge**: read `scope.data.attachedRefs` and merge into `priorResults` (shipped in `packages/harness-patterns/patterns/simpleLoop.server.ts`).
5. **Cache**: designed as a per-session `Map<sessionId, Map<hash, decision>>`, cleared on session end (shipped differently, [§14](#14-what-shipped-differently)).
6. **Tests**: unit tests for the skip optimizations, plus the eval suite.
7. **Docs**: the `withReferences` section of `packages/harness-patterns/SPEC.md`.
8. **Migration**: close #26 and #29; wrap the routes of the `default` agent (now `search`, `packages/agents/agents/search.server.ts`) with `withReferences`.

## 11. Open questions

Each question as recorded, followed by what the code does today.

- **Default `scope`.** Lean `'global'`. _Today:_ `'global'`.
- **Token budget source.** Ride on `MODEL_CONTEXT_WINDOWS` or take an explicit `maxTokens`? Lean: derive from the inner pattern's client window minus a fixed reserve. _Today:_ neither; the cap is a count, `maxRefs`.
- **`expand_data` budget enforcement.** When the loop expands several refs in one call, who enforces the cap? Lean: the wrapper sets a residual budget on `scope.data.expansionBudget`, consumed per call. Out of scope for v1. _Today:_ not built. Expanding several refs is one `expandPreviousResult` call with `ref:<a>,<b>`; that is distinct from multi-call turns (`additional_calls`), which exclude `expandPreviousResult`.
- **Composition with `parallel`.** Each branch enters separately; one selector call per branch, or one shared? Lean: per branch. _Today:_ a wrapper on each branch calls its selector once per entry; nothing shares a call.
- **Cache invalidation across sessions.** Lean: session-scoped only. _Today:_ one process-wide cache, not scoped to a session.

## 12. Alternatives considered

The sketches below are the rejected APIs as proposed; they are not valid TypeScript.

### A. Policy-soup wrapper (rejected)

```text
withReferences(pattern, {
  policy: 'auto-llm' | 'pushed-by-upstream' | 'self-scoped' | 'declared',
  // ... different fields per policy
})
```

Rejected: every consumer would learn four mechanisms, even for trivial cases. The taxonomy of policies is the implementer's mental model, not the consumer's.

### B. Producer-side declaration (rejected)

```text
simpleLoop(controller, tools, {
  publishRefs: 'tool_results' | 'last' | (e) => boolean
})
```

Rejected: it adds a field to every pattern. `UnifiedContext` already holds every event; making patterns publish refs as well adds surface for no gain.

### C. Per-pattern config flags (rejected; the state before this design)

`#26` adds a router field; `#29` adds a `simpleLoop` field. Each flag covers one direction of one channel. They do not compose, and they invite more fragmentation.

### D. Mutate the user message text inline (rejected)

Inject `[REF: ev-abc summary: ...]` into the user message string. Rejected: it corrupts the user's message, makes `compactExecution`'s `view.fromAll().ofType('user_message')` queries return altered text, and complicates display.

## 13. Out of scope

- Reusing references across sessions (long-term memory).
- Vector-similarity pre-filtering as a cheap heuristic (a candidate v2 optimization).
- Asking the user for confirmation when the budget is exceeded (a separate approval-gate pattern).
- Refactoring `priorTurnCount` (orthogonal: the turn-window mechanism stays a separate feature).

## 14. What shipped differently

Where the implementation departs from the design above, with the file that shows it.

| Design                                                        | Shipped                                                                                                                                                                                                                 | Where                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Mid-loop tool named `expand_data`                             | Named `expandPreviousResult`. A controller can also write `ref:<ref_id>` inside any tool's arguments, and the loop inlines the full result before the tool runs                                                         | `patterns/simpleLoop.server.ts`                           |
| Config optional, with a default selector                      | Config and `selector` required; the core package carries no selector. `bamlPatterns().selector` in `@hames-ai/harness-baml` is the model-backed one                                                                     | `types.ts`, `harness-baml/baml-patterns.server.ts`        |
| Cap by token budget                                           | Cap by count: `maxRefs`, default 5, applied after selection                                                                                                                                                             | `patterns/with-references.server.ts`                      |
| Candidates exclude hidden and archived results                | Also exclude failed results                                                                                                                                                                                             | `patterns/with-references.server.ts`                      |
| Per-session cache keyed by two hashes, cleared at session end | One process-wide cache of at most 200 decisions, evicting the least recently used, keyed by the intent text plus the sorted `ref_id` and summary pairs                                                                  | `patterns/with-references.server.ts`                      |
| Merge in the adapter layer                                    | Merge in `simpleLoop`, attached refs first so the selector's choice wins the dedup. `simpleLoop` is the only reader of `attachedRefs`: wrapping any other pattern records the decision, and no controller sees the refs | `patterns/simpleLoop.server.ts`                           |
| Every decision leaves a `reference_attached` event            | The event is committed only when the wrapper's `trackHistory` includes it; `withReferences` has no default entry, so by default it is not                                                                               | `types.ts` (`DEFAULT_TRACK_HISTORY`), `context.server.ts` |
| (not specified)                                               | If the selector throws, the wrapper records one `error` event, recoverable by default, and the wrapped pattern does not run on that entry                                                                               | `patterns/with-references.server.ts`                      |

Paths are relative to [`packages/harness-patterns/`](../../packages/harness-patterns/) unless they name another package.
