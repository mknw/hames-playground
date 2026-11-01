# Archived walkthrough: carrying data across turns with `withReferences`

> **Archived example, not runnable in the current app.** This page records the retired `search` agent's two-turn `withReferences` flow. #898 removed that agent and its picker entry; the current `general-next` agent uses a different `decisionLoop` composition. The steps, timeline, prompts, and code excerpt below describe the former agent and should not be used as current setup instructions. The turn-2 graph lookup was never verified end to end after the 2026-10-03 read-only change.

**Former example:** the `search` agent fetched information about a topic on one
turn, then looked that data up in Neo4j on the next. The example was designed
to take about five minutes.

This page is the historical counterpart to the design record,
[`with-references.md`](./with-references.md). Two terms it uses:

- **`withReferences`** wraps a pattern (one step of an agent's composition). When
  the wrapped pattern starts, it picks which earlier tool results are relevant and
  hands them in as short summaries.
- **`expandPreviousResult`** is a tool the loop adds for its controller (the model
  that chooses each tool call) whenever such summaries are present. Calling it
  loads the full result behind a summary.

---

## Former two-turn example

A two-turn conversation:

1. **Turn 1**: _"Search the web for TypeScript 5.7 release info. What are the 5 most important new features?"_
2. **Turn 2**: _"Which of these 5 features does the Neo4j graph already have a Concept node for?"_

Without `withReferences`, turn 2 fails: the Neo4j route starts with no prior
results, and its controller cannot see what the web route fetched on turn 1. The
`search` agent wraps both of its routes in `withReferences`, so on turn 2 the Neo4j
route starts with the turn-1 results attached.

---

## Former step 1: start a fresh chat

The former app offered **Search Agent** in the agent selector. That picker entry was removed in #898, so this step can no longer be performed.

The former timeline appeared in the side panel’s **Context manager** tab. The retired `search` agent’s composition was:

```text
router → routes({
  neo4j:      withReferences(neo4j-query loop, { selector }),
  web_search: withInjectionGuard(withReferences(web-search loop, { selector })),
}) → compactExecution (patternId response-synth)
```

The injection guard on the web route neutralizes instructions hidden in web
content before the controller reads it. The Neo4j route is not guarded, because
that graph holds the hames app's own data.

---

## Former step 2: turn 1, the web search

The example’s message was:

> Search the web for TypeScript 5.7 release info. What are the 5 most important new features?

The router classifies the message as `web_search`. The `withReferences` wrapper
finds no earlier tool results, so it attaches nothing and calls no model
(`skipped: 'empty'`). The `web-search` loop calls a search tool, then ends with
`Return`, and `response-synth` writes the answer listing the features.

The timeline shows the router, the web route and its tool calls, then
`response-synth`. It shows no row for the wrapper's decision: that event,
`reference_attached`, is not recorded by default ([Recording the selector's decision](#recording-the-selectors-decision-excerpt) below).

---

## Former step 3: turn 2, look them up in the graph

The example’s message was:

> Which of these 5 features does the Neo4j graph already have a Concept node for?

The router classifies the message as `neo4j`. On entry, the wrapper collects the
successful tool results from turn 1 as candidates. With one candidate it attaches
it without asking the selector (`skipped: 'single'`); with several, the selector
model chooses the relevant ones, up to five. The attached summaries reach the
`neo4j-query` loop's controller.

---

## Former step 4: inspect what the controller received

In the former timeline, the first `controller_action` event under `neo4j-query`
showed the arguments passed to the BAML `LoopController` function. The attached
results are in `turns_previous_runs`:

```jsonc
"turns_previous_runs": [
  {
    "ref_id": "ev-…",
    "tool": "search",
    "summary": "TypeScript 5.7 introduces …",
    "expanded_in_turn": null
  },
  …
]
```

Each entry names the event that holds the full result (`ref_id`) and carries a
summary of it. In the prompt they appear under **RESULTS FROM PREVIOUS TASKS**, one
line each, as `[ref:<ref_id>] <tool>: <summary>`. The controller can get the full
data in two ways:

- write `ref:<ref_id>` as a value in any tool's arguments, and the loop substitutes
  the full result before the tool runs, or
- call `expandPreviousResult` with `tool_args` of `ref:<ref_id>` (or
  `ref:<id_1>,<id_2>` for several) to load the full content into the turn.

Either way the turn records the expansion, and the prompt shows the expanded
content inside that turn, under "Expanded refs (now in your context — do not
re-expand)", so the controller reuses it instead of expanding it again.

`expanded_in_turn` is the loop's own note of the first turn that expanded each
ref. It is set to `null`, not left out, for refs not yet expanded, because BAML's
template engine treats a missing field and a null one differently. The current
prompt does not print it; the prior-results block renders the summaries only, so
that this part of the prompt stays identical from turn to turn and can be served
from Anthropic's prompt cache.

---

## Former step 5: check what the controller looked up

The former `tool_call` event under `neo4j-query` was expected to name the five
features from turn 1, either written into the query or its parameters, or as a
`ref:<ref_id>` value the loop replaced with the full result before the query ran
(the turn then records the expansion). Either way the names come from the
attached results, not from the model's memory. The answer says which of the five
the graph holds; on the demo graph that is probably none of them.

The example compared the answer with `MATCH (c:Concept) RETURN c.name ORDER BY c.name` in Neo4j Browser.

---

## Recorded flow

```text
Turn 1                                Turn 2
──────                                ──────
user_message                          user_message
router (route: web_search)            router (route: neo4j)
withReferences (skipped='empty')      withReferences (turn-1 results attached)
  └─ web-search loop                    └─ neo4j-query loop
       └─ search → tool_result               └─ read_neo4j_cypher
       └─ Return                             └─ Return
response-synth                        response-synth
```

The deciding moment is the wrapper running as turn 2's Neo4j route starts. Without
it, the loop would start with no prior results, and its controller would have
no feature names to look up: it would stop, or make them up. With it, the controller's prompt carries summaries
of the turn-1 results, and `expandPreviousResult` loads the full data when needed.

The channel is the one `simpleLoop` already used for its own window of recent
turns (`priorTurnCount`); the wrapper adds entries chosen across patterns, and
where both surface the same result it appears once.

---

## Recording the selector's decision (excerpt)

The wrapper describes each decision in a `reference_attached` event: the
candidates, the ones selected with a reason each, the selector’s reasoning, and
`skipped` when no model was called. The former agent did not commit that event by
default. This excerpt illustrates the optional `trackHistory` setting; it is not
a runnable replacement for the removed agent:

```typescript
import {
  withReferences,
  type ConfiguredPattern,
} from "@hames-ai/harness-patterns";
import { bamlPatterns } from "@hames-ai/harness-baml";
import type { AgentData } from "@hames-ai/agents";

// Former search-agent Neo4j loop; illustrative only.
declare const neo4jPattern: ConfiguredPattern<AgentData>;

const baml = bamlPatterns();
const neo4jRoute = withReferences<AgentData>(neo4jPattern, {
  scope: "global",
  selector: baml.selector,
  // Commit the selector's decision to the event log.
  trackHistory: "reference_attached",
});
```

`trackHistory` also takes a list of event types. In that former app flow, the
event appeared as its own row in the timeline, with a link icon.

---

## Current references

- **Reference:** the [`withReferences` section of SPEC.md](../../packages/harness-patterns/SPEC.md#withreferencespattern-config).
- **Design record:** [`with-references.md`](./with-references.md), including [what shipped differently](./with-references.md#14-what-shipped-differently) from the design.
- **Eval suite:** [`with-references-eval.test.ts`](../../app/src/__tests__/lib/harness-patterns/with-references-eval.test.ts), the canonical selection cases (postgres-18, conversational-unrelated, multiple-relevant, scope=self, stale-on-topic), each run with a deterministic fixture selector.
- **Your own selector:** `selector` accepts any function of the `SelectorFn` shape, for deterministic, rule-based or vector-similarity selection. The design record has [a deterministic example](./with-references.md#supplying-a-selector-excerpt).
