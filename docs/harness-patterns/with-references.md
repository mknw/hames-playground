# withReferences — Design Doc

> **Status:** Implemented. Shipped in [PR #34](https://github.com/mknw/harness-playground/pull/34) ([issue #30](https://github.com/mknw/harness-playground/issues/30)).
> **Supersedes:** #26, #29 (both marked `[SUPERSEDED by #30]`).
> **Companion:** #19's `expandPreviousResult` synthetic tool also landed in PR #34 — see [§4 Mechanism](#4-mechanism) for how the two compose.
> **API reference:** [`app/src/lib/harness-patterns/README.md#withreferencespattern-config`](../../app/src/lib/harness-patterns/README.md#withreferencespattern-config).

## 1. Problem

Cross-pattern data flow is currently implicit, ad-hoc, and underspecified.

**Concrete failure** (debugging session 2026-04-30, agent `default`):

| Turn | User input | Route | What the controller saw |
|---|---|---|---|
| 3 | "search the web for postgres 18 release info" | web-search | (full web results) |
| 4 | "add this info to the graph" | neo4j-query | `priorResults: []`, `intent: "Add this info to the graph"` |

Turn 4's `neo4j-query` controller had no access to the postgres-18 data from turn 3. It received only "Add this info" as a user message — with no actual content. It spent 5 turns probing the schema and looking for related nodes, never attempted a write, hit `maxTurns` (silently — separate fix), and the synthesizer ended up summarizing turn 3's web results instead of describing the (non-existent) graph mutations.

**Root cause:** there is no mechanism to recognize that data produced by an earlier pattern is relevant to the current one.

The framework currently has *three* partial answers to this, each addressing one slice:

| | Mechanism | Direction | Decision-maker |
|---|---|---|---|
| #19 | `expand_data` synthetic tool | Within one loop's execution | Controller LLM mid-loop |
| #26 | Router pushes `references[]` | Across pattern boundaries | Router LLM at dispatch |
| #29 | `priorTurnsScope: 'self'` | Across pattern boundaries | Static (patternId equality) |

These are three *policies* for the same underlying question: **which prior data should this pattern see, expressed in what form, and who decides?**

## 2. Goals / non-goals

### Goals
- Replace #26 and #29 with one declarative wrapper.
- Keep #19 as the inner-loop counterpart (controller can opt to expand any compact ref mid-loop).
- Zero changes to existing controller BAML signatures.
- Operate at *pattern ingress*; egress is already covered by event tracking + `scheduleSummarization`.
- Observable: every selection decision should leave a trace in `ctx.events`.

### Non-goals
- Producer-side declaration of refs (no `publishRefs` on patterns; everything in `ctx.events` is implicitly available).
- Mid-loop relevance recomputation (selection happens once per pattern entry; refresh happens at the next pattern's entry).
- Egress filtering or summarization (already in place).
- Determining *which* model writes summaries (handled by existing `scheduleSummarization` / `DescribeFallback`).

## 3. Reference taxonomy

Two distinct kinds of cross-pattern data flow:

```
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

- **External (ingress)** — `withReferences` decides which compact refs to attach when a pattern is entered. Output: a `priorResults` array merged into the controller's BAML input.
- **Internal (mid-loop)** — `expand_data` (#19) lets the controller, *during* its reasoning, pull the full body of any compact ref it received. Multiple ref_ids per call. Token-budget management is the controller's responsibility (with hard cap from the wrapper).

These compose: `withReferences` attaches **summaries**; the loop optionally expands selected refs to **full content** (or full-but-trimmed) via `expand_data`.

## 4. Mechanism

On pattern entry, the wrapper:

```
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

The adapter layer (`baml-adapters.server.ts`) merges `scope.data.attachedRefs` into the BAML `turns_previous_runs: PriorResult[]` argument. The existing `LoopController` prompt already renders this block under `RESULTS FROM PREVIOUS TASKS:` — **no controller-prompt changes**.

## 5. API

```typescript
import type { PriorResult, EventView } from '../types'

export interface WithReferencesConfig extends PatternConfig {
  /** Which patterns' tool_results are eligible. Default: 'global' */
  scope?: 'self' | 'global'

  /** Explicit patternId allow-list. Overrides scope when set. */
  source?: string | string[]

  /** Cap on attached refs. Default: 5 */
  maxRefs?: number

  /** Override default LLM-driven selector */
  selector?: SelectorFn
}

export type SelectorFn = (input: {
  intent: string
  recentMessages: Array<{ role: 'user' | 'assistant', content: string }>
  candidates: Array<{ ref_id: string, tool: string, summary: string, tool_args?: string, ts: number }>
}) => Promise<{
  selected: Array<{ ref_id: string, reason: string }>
  reasoning: string
}>

export function withReferences<T>(
  pattern: ConfiguredPattern<T>,
  config?: WithReferencesConfig
): ConfiguredPattern<T>
```

### Default selector

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
  client DescribeFallback
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

Bias toward inclusion: cap by **token budget** at the wrapper, never by relevance score. The selector ranks; the wrapper truncates.

## 6. Observability — `reference_attached` event

New `EventType`: `'reference_attached'`. Payload:

```typescript
interface ReferenceAttachedEventData {
  candidates: Array<{ ref_id: string, tool: string, summary: string }>
  selected:   Array<{ ref_id: string, reason: string }>
  reasoning:  string  // The selector's overall justification
  skipped?:   'empty' | 'single' | 'cached'  // When the selector wasn't called
}
```

UI integration: the observability panel shows attachments as their own row (similar to `controller_action`). Post-mortem flow: filter for `reference_attached` events on the failing turn → confirm selector saw the relevant ref, see why it was/wasn't selected.

## 7. Skip optimizations

| Condition | Behavior |
|---|---|
| Empty eligible stash | Skip entirely; track `reference_attached` with `skipped='empty'`, `selected=[]` |
| Single eligible candidate | Attach unconditionally; track with `skipped='single'`, `selected=[that one]` |
| Cache hit on `(intent_hash, stash_snapshot_hash)` | Reuse last decision; track with `skipped='cached'` |

`stash_snapshot_hash` = hash of `(eligible_ref_ids.sorted, ref_summaries)`. Both are stable within a turn and slow-changing across turns, so cache hit rate is high.

## 8. Plumbing — adapter merge

```typescript
// baml-adapters.server.ts (sketch)

// In createLoopControllerAdapter:
const attachedRefs = (scope.data.attachedRefs as PriorResult[] | undefined) ?? []
const mergedPriorResults = dedupByRefId([
  ...attachedRefs,
  ...priorResultsFromExistingPath
])
```

Dedup by `ref_id` — if `withReferences` and the existing `priorTurnCount` mechanism both surface the same event, count it once.

## 9. Eval suite (canonical cases)

A `app/src/__tests__/lib/harness-patterns/with-references-eval.test.ts` file with manually-curated cases:

| Case | Stash | Intent | Expected selection |
|---|---|---|---|
| **postgres-18** (the trigger case) | web-search returned full postgres-18 release content | "Add this info to the graph" | postgres-18 ref **must be selected** |
| **stale on-topic** | neo4j query result from 5 turns ago about a different schema area | "list all Person nodes" | Could be either; not a hard requirement |
| **conversational unrelated** | Several tool results from earlier in session | "thanks!" | **Empty selection** (hard floor) |
| **multiple relevant** | 3 web searches on the same topic | "summarize what we found" | All 3 selected (within budget) |
| **scope=self** | Mix of neo4j and web results, wrapper on neo4j-query | (anything) | Only neo4j-tagged candidates eligible regardless of selection |

Each case stubs the LLM (or runs against the real fallback model with a recorded fixture) and asserts the `selected` array matches expectations.

## 10. Implementation plan

1. **Types** — `WithReferencesConfig`, `SelectorFn`, `ReferenceAttachedEventData`, new `EventType`.
2. **BAML** — `b.ReferenceSelector` function in `baml_src/with-references.baml`.
3. **Pattern** — `app/src/lib/harness-patterns/patterns/with-references.server.ts`.
4. **Adapter merge** — extend `baml-adapters.server.ts` to read `scope.data.attachedRefs` and merge into `priorResults`.
5. **Cache** — small in-memory `Map<sessionId, Map<hash, decision>>` cleared on session end.
6. **Tests** — unit tests for skip optimizations + eval suite.
7. **Docs** — update `harness-patterns/README.md` API reference + add an example.
8. **Migration** — close #26 / #29; update `default` agent to wrap routes with `withReferences`.

## 11. Open questions

- **Default `scope`**: lean `'global'`. Consumers can tighten with `'self'` or explicit `source`.
- **Token budget source**: ride on existing `MODEL_CONTEXT_WINDOWS` (deduct from inner pattern's budget), or take an explicit `maxTokens` config? Lean: derive from inner pattern's BAML client window minus a fixed reserve.
- **`expand_data` budget enforcement**: when the loop expands multiple refs in one call, who enforces the cap? Lean: wrapper sets a residual budget on `scope.data.expansionBudget`; `simpleLoop` consumes per call. Out of scope for v1; track as follow-up. (Note: multi-ref expansion is one `expandPreviousResult` call with `ref:<a>,<b>` — distinct from multi-call turns (`additional_calls`), which explicitly exclude `expandPreviousResult`.)
- **Composition with `parallel`**: each branch enters separately. Should each branch get its own selector call, or share one? Lean: per-branch (different intents may apply).
- **Cache invalidation**: `(intent_hash, stash_snapshot_hash)` is per-session. What about *across* sessions (e.g., long-lived agent)? Lean: session-scoped only.

## 12. Alternatives considered

### A. Policy-soup wrapper (rejected)

```typescript
withReferences(pattern, {
  policy: 'auto-llm' | 'pushed-by-upstream' | 'self-scoped' | 'declared',
  // ... different fields per policy
})
```

Rejected: forces every consumer to learn four mechanisms, even for trivial cases. The taxonomy of policies is *implementer's* mental model, not consumer's.

### B. Producer-side declaration (rejected)

```typescript
simpleLoop(controller, tools, {
  publishRefs: 'tool_results' | 'last' | (e) => boolean
})
```

Rejected: pollutes every pattern with a new field. UnifiedContext already has every event; making patterns redundantly *publish* refs adds API surface for no gain.

### C. Per-pattern config flags (rejected — current state)

`#26` adds a router field; `#29` adds a simpleLoop field. Each new flag covers one direction of one channel. Doesn't compose; encourages future fragmentation.

### D. Mutate the user_message text inline (rejected)

Inject `[REF: ev-abc summary: ...]` directly into the user message string. Rejected: corrupts the actual user message, makes synthesizer's `view.fromAll().ofType('user_message')` queries return mutated text, complicates downstream display.

## 13. Out of scope

- Cross-session reference reuse (long-term memory).
- Vector-similarity pre-filtering as cheap heuristic (good v2 optimization).
- "Ask user for confirmation when budget exceeded" (a separate guardrail-style pattern).
- Refactoring `priorTurnCount` (orthogonal — the existing turn-window mechanism stays as a different feature).

---

**Last updated:** 2026-04-30
