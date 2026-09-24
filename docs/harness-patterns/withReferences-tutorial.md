# Walkthrough: carrying data across turns with `withReferences`

> **Status.** Hands-on walkthrough in the hames app, first written with the `withReferences` design (2026-04-30) and brought up to date 2026-09-24; the wrapper and the agent it uses live in [`packages/`](../../packages/).

**What you will see:** the `search` agent fetching information about a topic on one
turn, then writing that data to Neo4j on the next, without fetching it again and
without the model inventing the content. About five minutes.

**Before you start.** This walkthrough runs in the hames app, this repository's
reference host: a chat UI with an event timeline beside it. Follow the
[Quickstart](../../README.md#quickstart) in the root README. It starts Neo4j and
the MCP gateway (the Docker service that serves the web-search and Neo4j tools)
with `docker compose up -d`, and needs an Anthropic API key in `app/.env`, which
you get at [console.anthropic.com](https://console.anthropic.com). The hames app then
serves on <http://localhost:3444>.

This page is the hands-on counterpart to the design record,
[`with-references.md`](./with-references.md). Two terms it uses:

- **`withReferences`** wraps a pattern (one step of an agent's composition). When
  the wrapped pattern starts, it picks which earlier tool results are relevant and
  hands them in as short summaries.
- **`expandPreviousResult`** is a tool the loop adds for its controller (the model
  that chooses each tool call) whenever such summaries are present. Calling it
  loads the full result behind a summary.

---

## What you will do

A two-turn conversation:

1. **Turn 1**: _"Search the web for TypeScript 5.7 release info. What are the 5 most important new features?"_
2. **Turn 2**: _"Add these 5 features to the Neo4j graph as Concept nodes connected to a TypeScript 5.7 root node."_

Without `withReferences`, turn 2 fails: the Neo4j route starts with no prior
results, and its controller cannot see what the web route fetched on turn 1. The
`search` agent wraps both of its routes in `withReferences`, so on turn 2 the Neo4j
route starts with the turn-1 results attached.

---

## Step 1: start a fresh chat

Pick **Search Agent** in the agent selector and press **New chat** in the sidebar.

The side panel's **Context manager** tab holds the event timeline; it fills as
the agent runs. The agent's composition, abridged from
[`search.server.ts`](../../packages/agents/agents/search.server.ts):

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

## Step 2: turn 1, the web search

Send:

> Search the web for TypeScript 5.7 release info. What are the 5 most important new features?

The router classifies the message as `web_search`. The `withReferences` wrapper
finds no earlier tool results, so it attaches nothing and calls no model
(`skipped: 'empty'`). The `web-search` loop calls a search tool, then ends with
`Return`, and `response-synth` writes the answer listing the features.

The timeline shows the router, the web route and its tool calls, then
`response-synth`. It shows no row for the wrapper's decision: that event,
`reference_attached`, is not recorded by default ([Recording the selector's decision](#recording-the-selectors-decision-excerpt) below).

---

## Step 3: turn 2, add to the graph

Send:

> Add these 5 features to the Neo4j graph as Concept nodes connected to a TypeScript 5.7 root node.

The router classifies the message as `neo4j`. On entry, the wrapper collects the
successful tool results from turn 1 as candidates. With one candidate it attaches
it without asking the selector (`skipped: 'single'`); with several, the selector
model chooses the relevant ones, up to five. The attached summaries reach the
`neo4j-query` loop's controller.

---

## Step 4: inspect what the controller received

In the timeline, open the first `controller_action` event under `neo4j-query` and
select its **Variables** tab. It shows the arguments the loop passed to the BAML
`LoopController` function. The attached results are in `turns_previous_runs`:

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

## Step 5: view the resulting graph

Switch the side panel to the **Neo4j** tab to see the new nodes.

To check them in the Neo4j Browser, paste the query below into it.

> **Needs:** the Neo4j Browser at <http://localhost:7474> (user `neo4j`, password `password`), started by `docker compose up -d` in the [Quickstart](../../README.md#quickstart).

```cypher
MATCH (root:Concept {name: 'TypeScript 5.7'})-[r]-(child:Concept)
RETURN root.name, type(r), child.name, child.description
```

The node and relationship names depend on the Cypher the model wrote; if the query
returns nothing, drop the `{name: …}` filter and look for the nodes it created. The
descriptions on the child nodes should carry specifics from the web results, which
shows the controller used the attached results rather than writing from memory.

---

## What just happened

```text
Turn 1                                Turn 2
──────                                ──────
user_message                          user_message
router (route: web_search)            router (route: neo4j)
withReferences (skipped='empty')      withReferences (turn-1 results attached)
  └─ web-search loop                    └─ neo4j-query loop
       └─ search → tool_result               └─ write_neo4j_cypher × N
       └─ Return                             └─ Return
response-synth                        response-synth
```

The deciding moment is the wrapper running as turn 2's Neo4j route starts. Without
it, the loop would start with no prior results, and its controller would write
nothing or make the content up. With it, the controller's prompt carries summaries
of the turn-1 results, and `expandPreviousResult` loads the full data when needed.

The channel is the one `simpleLoop` already used for its own window of recent
turns (`priorTurnCount`); the wrapper adds entries chosen across patterns, and
where both surface the same result it appears once.

---

## Recording the selector's decision (excerpt)

The wrapper describes each decision in a `reference_attached` event: the
candidates, the ones selected with a reason each, the selector's reasoning, and
`skipped` when no model was called. `withReferences` has no default
`trackHistory` entry, so the event is not committed unless you ask for it:

```typescript
import { withReferences, type ConfiguredPattern } from '@hames-ai/harness-patterns'
import { bamlPatterns } from '@hames-ai/harness-baml'
import type { AgentData } from '@hames-ai/agents'

// The Neo4j loop, built as in search.server.ts.
declare const neo4jPattern: ConfiguredPattern<AgentData>

const baml = bamlPatterns()
const neo4jRoute = withReferences<AgentData>(neo4jPattern, {
  scope: 'global',
  selector: baml.selector,
  // Commit the selector's decision to the event log.
  trackHistory: 'reference_attached',
})
```

`trackHistory` also takes a list of event types. In the hames app the event then
appears as its own row in the timeline, with a link icon.

---

## Where to go next

- **Reference:** the [`withReferences` section of SPEC.md](../../packages/harness-patterns/SPEC.md#withreferencespattern-config).
- **Design record:** [`with-references.md`](./with-references.md), including [what shipped differently](./with-references.md#14-what-shipped-differently) from the design.
- **Eval suite:** [`with-references-eval.test.ts`](../../app/src/__tests__/lib/harness-patterns/with-references-eval.test.ts), the canonical selection cases (postgres-18, conversational-unrelated, multiple-relevant, scope=self, stale-on-topic), each run with a deterministic fixture selector.
- **Your own selector:** `selector` accepts any function of the `SelectorFn` shape, for deterministic, rule-based or vector-similarity selection. The design record has [a deterministic example](./with-references.md#supplying-a-selector-excerpt).
