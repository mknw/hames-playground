# Tutorial: Cross-pattern data flow with `withReferences`

> **Reading time:** ~5 minutes · **Prerequisite:** the dev stack running (`pnpm dev:exposed` + `docker compose up`).
> **What you'll see:** the default agent fetching information about a topic, then writing the same data to Neo4j on a follow-up turn — without re-fetching, and without the controller hallucinating content.

This tutorial walks through the same workflow that motivated the `withReferences` design ([#30](https://github.com/mknw/harness-playground/issues/30)) and the synthetic `expandPreviousResult` tool ([#19](https://github.com/mknw/harness-playground/issues/19)). The full design rationale lives in [`with-references.md`](with-references.md); this is the hands-on counterpart.

---

## What we'll build

A two-turn conversation:

1. **Turn 1** — *"Search the web for TypeScript 5.7 release info — what are the 5 most important new features?"*
2. **Turn 2** — *"Add these 5 features to the Neo4j graph as Concept nodes connected to a TypeScript 5.7 root node."*

Without `withReferences`, turn 2 fails: the neo4j route receives `priorResults: []` and the controller has no access to the data the web-search route fetched in turn 1. With `withReferences` (now wired into the default agent), the LLM-driven selector picks the most relevant prior `tool_result` events and attaches them to the neo4j route's `priorResults` channel on entry.

---

## Step 1 — start with a fresh chat

Pick the **Default Agent** in the agent picker, click **+ New Chat**.

![Fresh chat, default agent selected, observability panel empty](screenshots/01-fresh-chat.png)

The right panel's **Observability** tab will fill with events as the agent runs. The agent is composed of:

```
router → routes({
  neo4j:      withReferences(neo4jPattern),
  web_search: withReferences(webPattern),
}) → compactExecution
```

See [`app/src/lib/harness-client/agents/default.server.ts`](../../app/src/lib/harness-client/agents/default.server.ts) for the source.

---

## Step 2 — turn 1: web search

Send:

> Search the web for TypeScript 5.7 release info — what are the 5 most important new features?

The router classifies the intent as `web_search`, the `withReferences` wrapper runs (with no eligible candidates yet → `skipped: 'empty'`, no refs attached), and the inner `simpleLoop` calls `search` and then `Return`. The compactExecution renders the 5 features.

![Turn 1 — chat shows the 5 TypeScript 5.7 features; observability shows router → withReferences → web-search → response-synth](screenshots/02-search-response.png)

In the timeline you'll see the chain fire:

- `router-…` → enter / `Looking into that...` / exit
- `routes-…` → enter
- `withReferences-…` → enter / exit (no `reference_attached` event in the panel because the wrapper's default `trackHistory` doesn't include this type — see [Tweaking observability](#tweaking-observability) below)
- `web-search` → controller_action (`search`) → tool_call → controller_action (`Return`) → exit
- `response-synth` → enter / assistant_message / exit

---

## Step 3 — turn 2: add to the graph

Send:

> Add these 5 features to the Neo4j graph as Concept nodes connected to a TypeScript 5.7 root node.

This is where `withReferences` earns its keep. The router classifies the intent as `neo4j`, the wrapper runs the LLM selector over visible `tool_result` events, picks the prior web-search refs, and attaches them as compact `priorResults` to the inner `simpleLoop`'s controller.

![Turn 2 — chat shows the agent confirming the writes; observability shows the second withReferences fire and the neo4j-query controller actions](screenshots/03-add-to-graph-response.png)

---

## Step 4 — inspect the priorResults

Click on the first `controller_action` event under `neo4j-query` (in the Observability tab). You'll see the variables passed to BAML's `LoopController`:

![Controller action detail — variables include turns_previous_runs with explicit `expanded_in_turn: null` on each ref](screenshots/04-reference-attached-detail.png)

The critical bit:

```jsonc
"turns_previous_runs": [
  {
    "ref_id": "ev-…",
    "tool": "search",
    "summary": "TypeScript 5.7 introduces …",
    "expanded_in_turn": null    // ← explicit null, not absent
  },
  …
]
```

`expanded_in_turn: null` is a deliberate detail: BAML's MiniJinja templating distinguishes None from undefined, and `is none` only matches None. If the field were absent, MiniJinja would render `(expanded in turn )` for every ref and the controller would hallucinate. See the [PR #34 fix commit](https://github.com/mknw/harness-playground/pull/34/commits) for the deeper explanation.

The compact ref entries appear under **RESULTS FROM PREVIOUS TASKS** in the rendered prompt. The controller can either:
- pass `ref:<ref_id>` as a tool argument (inline-expanded by `resolveRefs` before the tool runs), or
- call the synthetic `expandPreviousResult` tool (auto-injected when prior results exist) with `tool_args = ref:<ref_id>` to load the full content into a turn record.

Either path records an `expansions[]` entry on the `LoopTurn`, and the compact ref is then annotated with `(expanded in turn N)` in subsequent iterations — telling the controller "you've already pulled this data; reuse it".

---

## Step 5 — view the resulting graph

Switch to the **🗄️ Neo4j** tab.

![Neo4j tab — TypeScript 5.7 root concept connected to 5 child Concept nodes for each feature](screenshots/05-neo4j-graph-result.png)

Verify with a Cypher query (you can paste this into the Neo4j Browser at <http://localhost:7474>):

```cypher
MATCH (root:Concept {name: 'TypeScript 5.7'})-[r]-(child:Concept)
RETURN root.name, type(r), child.name, child.description
```

The descriptions on the child nodes contain real content from the web search (specifics that the LLM couldn't have produced from training data alone) — proof the controller used the attached refs rather than hallucinating.

---

## What just happened

```
Turn 1                              Turn 2
──────                              ──────
user_message                        user_message
router (intent: web_search)         router (intent: neo4j)
withReferences (skipped='empty')    withReferences (selector picked 3 refs)
  └─ simpleLoop                       └─ simpleLoop
       └─ search → tool_result            └─ get_neo4j_schema
       └─ Return                          └─ write_neo4j_cypher × N
compactExecution                              └─ Return
                                    compactExecution
```

The pivotal moment is `withReferences` running on turn 2's neo4j route ingress. Without it, the inner pattern would have received `priorResults: []` and the controller would have written either nothing or hallucinated content. With it, the controller's prompt includes compact summaries of the prior web-search results, and `expandPreviousResult` lets it pull the full data when needed.

This is the same `priorResults` channel `simpleLoop` already used for its own intra-pattern turn window — the wrapper just augments that channel with cross-pattern, LLM-curated entries.

---

## Tweaking observability

The `reference_attached` event (which records the selector's decision: candidates, selected, reasoning, skipped fast-path) isn't surfaced in the Observability tab by default — the wrapper's `trackHistory` doesn't include it. To make selection decisions visible:

```ts
withReferences(neo4jPattern, {
  scope: 'global',
  trackHistory: 'reference_attached'   // or ['reference_attached', 'tool_call', ...]
})
```

You can then filter the timeline by event type (use the eye icon in the panel header).

---

## Where to go next

- **API reference:** [`app/src/lib/harness-patterns/README.md#withreferencespattern-config`](../../app/src/lib/harness-patterns/README.md#withreferencespattern-config)
- **Design doc:** [`with-references.md`](with-references.md) — full taxonomy (ingress vs. mid-loop), alternatives considered, open questions
- **Eval suite:** [`app/src/__tests__/lib/harness-patterns/with-references-eval.test.ts`](../../app/src/__tests__/lib/harness-patterns/with-references-eval.test.ts) — canonical selection cases (postgres-18, conversational-unrelated, multiple-relevant, scope=self, stale-on-topic) with deterministic fixture selectors
- **Custom selectors:** pass `selector: SelectorFn` in the wrapper config to swap in deterministic, vector-similarity, or rule-based selection — useful for tests, evals, or fast-paths

---

## Capturing screenshots

The image filenames above (in `docs/harness-patterns/screenshots/`) are placeholders. To capture them:

1. `01-fresh-chat.png` — fresh chat, default agent selected, Observability tab open and empty
2. `02-search-response.png` — full chat reply for the TypeScript 5.7 query, with the Observability tab visible in the side panel showing the chain
3. `03-add-to-graph-response.png` — chat reply for the "add to graph" turn, side panel showing the second route's events
4. `04-reference-attached-detail.png` — close-up of a `controller_action` detail overlay (click an event in the timeline) showing the `Variables` block with `turns_previous_runs` containing `expanded_in_turn: null`
5. `05-neo4j-graph-result.png` — the **🗄️ Neo4j** tab showing the new TypeScript 5.7 nodes with their relationships

Drop the PNGs into `docs/harness-patterns/screenshots/` and the tutorial will render correctly.
