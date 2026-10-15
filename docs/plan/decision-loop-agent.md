# General Agent as a Decision Loop (Plan)

> **Status: design, not built. Round 2.** This replaces round 1's "patternTool inside a `simpleLoop`" core. Round 1 is in git history as `docs/plan/pattern-tools.md`; its two reviews are on [#507](https://github.com/mknw/hames-playground/issues/507). The shape below is the owner's (2026-10-13). This doc says how it works, what each piece sees, and what it still owes. Nothing is dispatched until the owner signs off. Every call raised in round 2 was ruled in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323) (2026-10-13, owner-delegated); the conditions are folded in below and summarised in [Rulings](#rulings-g12-g14).

## The problem, in one paragraph

An agent's topology is fixed when it is built, and today's `general` is `planner → simpleLoop → compactExecution` over every tool. #507 is a request whose plan needed three steps: fetch a file, read it back, then compute over it. `general` could only do the first. It has no way to read the stash and no sandbox, so the plan described an agent that did not exist. The fix is to let one turn move between groups of capabilities, choosing the next group after seeing what the last one produced.

## The shape

This is the target composition, including the core changes specified below, not runnable code on current main. Source checks for this fix round use `origin/main` at `7a3446ca`; that commit is already an ancestor of this branch. In particular, slice 3 follows #418 G11's deletion/client-migration slice (P5), and the file-ingest path stays off until P4.

```typescript
// S-f: withhold by exact tool name until the P4 file-path wiring lands.
const OFFICE_TOOLS = MS365_TOOLS.filter((name) => name !== 'graph_file_ingest')
const screen = createInjectionScreen() // role-resolved; outage handling is specified below
const doc_ag = withInjectionGuard(DOC_GUARD)(                      // office + data work
  withSandbox({ id: `${sessionId}:office`, rootfs: 'office', egress: 'mcp-only', syncWorkspace: true })(
    actorCritic(actor, critic, OFFICE_TOOLS, { patternId: 'doc', … }),
  ),
)
const info_ag = withInjectionGuard(INFO_GUARD)(                    // knowledge lookups
  withPseudonymisedInputs({ pseudonymise: deps.pseudonymiseForWeb })(   // G14: the web route, private tier only
  withReferences(
    simpleLoop(createLoopControllerAdapter(), [...NEO4J_READ, ...WEB], { patternId: 'info', returnStyle: 'answer', rememberPriorTurns: false }),
    { selector, source: ['retriever', 'info'], viewConfig: { fromLastNTurns: 1 } },
  )),
)
const retrieve = withInjectionGuard({ tools: ['retriever'] })(retriever({ backends: [redis], patternId: 'retriever' }))   // the Data Stash
const think = planner(createPlannerAdapter(…), PLANNABLE_TOOLS, { patternId: 'think' })

const orchestrator = withInjectionGuard({
  ...GUARD_UNION, // INFO_GUARD + DOC_GUARD + retriever, with the catalog for namespace validation
  tools: [...GUARD_UNION.tools, 'decision_loop_output'],
  spotlight: 'always',
  screen,
})(decisionLoop(
  {
    'office-data': { pattern: doc_ag, description: 'Work on Microsoft 365 files and mail; run code over them' },
    'info-retrieval': { pattern: info_ag, description: 'Look things up in the knowledge graph or on the web' },
    'read-documents': { pattern: retrieve, description: 'Search documents already in this conversation' },
    think: { pattern: think, description: 'Decide the steps before acting' },
  },
  { decide, answer: 'Generate the answer for the user now, from the conversation and any results so far', handoff: { lastN: 2 }, maxIterations: 6, patternId: 'orchestrator' },
))

agent = withMemory(deps.memory)([orchestrator, compactExecution({ mode: 'thread', patternId: 'response-synth', viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 } })])
```

There are three differences from the owner's sketch, each argued below:

- the retriever is its own route rather than a tool inside `info_ag` (see [Routes](#routes-and-how-tools-are-grouped));
- `doc_ag` takes the sketch's second form (see [Sandbox](#where-memory-guards-and-the-sandbox-sit));
- `skip_to_synthesizer` is a terminal choice, `answer`, not a route that runs the synthesizer (see [Answer](#answer)). G12 calls it `done`; it is renamed `answer` on review, because "generate the answer for the user" is what the option does, and that is the description the decisions model reads.

## The new piece: `decisionLoop`

This is the one new pattern. It is a loop over `routes` in which a **decisions model** picks the next route each time round. One iteration:

1. **Build the state** (below) and ask one `choice` question: "Which step should run next?" The options are the route names plus `answer`, each with its description. The model answers one label, with its probability. It submits no arguments.
2. **If `answer`**, stop. The top-level synthesizer runs next.
3. **Otherwise run that route's pattern** in a child scope, given the task described below.
4. **Record what the route produced** as a route output (below), then go to 1.

The decision is a plain `choice` through the existing `decide()` path. It reuses `decisionRouter`'s machinery (`typedDecision.server.ts:1452-1540`): labels from route descriptions, one `decision_made` event per decision, and `data.decisions[key]`. The loop and custom `state` also require an explicit failure check: `decisionLoop` never acts on `label` when `abstained` is true, for **any** reason. Every non-decision, including a state-builder throw, follows N3 below. On current main `scoreDecision` maps abstains/errors to `policy.fallback` (`packages/harness-patterns/patterns/typedDecision.server.ts:402-403, 460-464, 520`); the new loop must not copy that label dispatch. A slice-1 pin makes a throwing state builder on iteration 1 end the turn with a visible error and no route or synthesis dispatch. This remains the failure contract after G11 removes the abstain policy.

There is no calibration and no threshold. Per #418 G11, the answer's probabilities are recorded as returned and used for nothing else.

**Why this is not the orchestrator ADR-0005 forbids.** ADR-0005 rules out recreating `baml-agent/`'s monolithic orchestrator, which kept session state outside `UnifiedContext`. `decisionLoop` is a pattern: its decisions, its route outputs and every child's events are events in the one context, and it composes with `harness(...)` like `routes` does. The owner's word "orchestrator" names its role in this agent. The pattern's name should not be that word, so the ADR stays legible. A new ADR records the primitive when implementation is approved. It supersedes nothing.

### What the decisions model sees each iteration

The systemone request is `{ model, state, questions }`, where `state` is one string (`jev-decide.server.ts:304-311`), capped at the model's state window (32k tokens for Jev, `limitsFor('decide')`). `decisionLoop` passes a custom `state`, because the default one renders only user and final assistant messages (`typedDecision.server.ts:1259-1276`) and so would never see this turn's progress. The state is rendered as:

```
Conversation (recent turns):
User: …
Assistant: …
User: <latest message>

This turn so far:
1. info-retrieval — succeeded (simpleLoop: 3 turns, 4 tool calls, 0 errors, 21s)
2. think — succeeded (plan: 3 steps)
3. read-documents — failed: no documents matched (searched 12 documents, 0 matches)

Latest results (most recent last):
[think] Plan: 1) find the spreadsheet … 2) …
[read-documents] failed: no documents matched. Reason: …
```

- **The conversation window** is `routerTurnWindow` turns, the same as `decisionRouter`'s default.
- **"This turn so far"** lists **every** iteration of this turn in one line each: route, status and **stats**. This is what lets the model see that it is going round in circles.
  - The stats are counted by code from the child's events: turns or attempts used against the child's own bound, tool calls, errors and wall time; for the retriever, documents searched and matches.
  - A route that hit its own bound (for example the sandbox actor using all its attempts) reads differently from one that finished early, even when both report success.
  - Together with the last N full outputs below, this is the information the decision rests on (review, 2026-10-14).
- **"Latest results"** shows the **last N** route outputs in full (result + reasoning, below).
- **Trimming.** The whole block is trimmed oldest-first to the decide window, as the default state is.
- **Caching.** The state is **append-only within a turn**: conversation first, then iterations in order. A provider prefix cache could therefore reuse everything but the tail.
  - On the Anthropic tier the decide call goes to the systemone provider, not to an Anthropic model. That transport records no cache reads (`jev-decide.server.ts:180-182`), and the provider documents no prompt cache, so there is nothing to switch on today.
  - The prompts that grow and do run on Anthropic models are the children's. Their handoff rides `plan_context`, which renders in the run-static tier 2 behind the #122 `cache_control` breakpoints. So within one child run the handoff is cached after its first call, and across iterations the system block and tier 1 stay byte-identical.
  - Nothing new is needed for v1. Measure the cache-read share on a multi-iteration turn before designing more.
- **What is left out.** The route descriptions are not in the state: they are the question's options. Memory is not in the state either (see [Memory](#where-memory-guards-and-the-sandbox-sit)).

Route outputs are untrusted: they carry what the agents read on the web or in mail. They enter the state only as **sanitized** text (see [When a route fails and other boundaries](#untrusted-content-on-the-way-up)), fenced by the guard's spotlight.

### What a route's agent receives as its task

The router passes no arguments, so a child gets:

- **its instruction: the user's latest message.** `decisionLoop` leaves `data.intent` unset, so `simpleLoop` and `actorCritic` fall back to the last user message, as they already do (`simpleLoop.server.ts:381`, `actorCritic.server.ts:293`). The retriever already searches with that message.
- **its context: the existing `plan_context` string channel, with a required core formatter change.** Only the latest `think` plan belongs under the **PLAN** heading. It is copied from `think`'s **sanitized route-output record**, never from raw child `data.plan`.
  - **Earlier step results — data, not instructions:** a separate heading carries every earlier iteration's one-line status and stats, followed by the last N sanitized/capped outputs. This lets the child compare the plan with work already done without presenting retrieved content as instructions.
  - On current main the loop patterns call `formatPlanContext(data.plan)` (`simpleLoop.server.ts:322`, `actorCritic.server.ts:139`), and that formatter labels the whole value "PLAN … follow it" (`packages/harness-patterns/patterns/planner.server.ts:93-104`). Slice 1 must keep the plan and handoff separate in child data and compose these headings into `plan_context`; it must not encode the handoff in `data.plan`. The BAML argument stays a string, so no BAML signature changes. Pin the rendered child prompt: route outputs and the step list are outside the PLAN section.
  - `think` is the exception to the controller channel: its invocation receives the same handoff through the planner's existing `context` argument, with the static agent map separately labelled (required wiring below).

A **cursor** along the plan, marking the current step, is a v2 idea. v1 relies on the child reading the plan against the steps already done.

The child's `data` is built fresh: the sanitized plan and separate handoff blocks plus what the child pattern needs. It **excludes** `memories` and `memoryContext` (security review §4). **Nothing the child writes to `data` flows back** (architecture review §2). Only the route output does.

### How data from one route reaches the next

There are four channels, from cheapest to richest:

1. **The handoff.** The last N outputs, capped, in the next child's `plan_context` (above). It works for every route kind and costs nothing extra.
2. **Selected reference previews with on-demand expansion: `withReferences`.** `withReferences` does **not** connect to the Data Stash. It runs a selector over the `tool_result` events its view can see, and attaches only `{ ref_id, tool, summary }` previews to the inner loop's `turns_previous_runs` (`with-references.server.ts:162-167, 295-296`); the loop can request a selected result's full payload with `expandPreviousResult` (`simpleLoop.server.ts:499-519`). Only `simpleLoop` consumes them (`simpleLoop.server.ts:309-310`). `ActorController` has no prior-results input (`actorCritic.baml:222-232`), so wrapping `doc_ag` would attach nothing.
3. **The Data Stash, for documents.** Documents uploaded by the user, ingested by an agent or promoted from `/work/out` are read by the `read-documents` route. The retriever emits its matches as a `tool_result` (`retriever.server.ts:28-29`). So they ride the handoff as a summary, and channel 2 can offer their previews and on-demand full expansion to a loop that has no stash access of its own.
   - `info_ag` has no stash tool, deliberately. The only existing one, the redis server's search, is not scoped to the conversation.
   - If a stash search _inside_ a loop is ever needed, the way to do it is a conversation-scoped app tool that takes its session from the request, the way `graph_file_ingest` does.
4. **Files, for the sandbox; the Graph-ingest path is gated on P4.** Stash → `/work/in` on entry, plus the re-hydrate fix (N4); the Graph-ingest path is withheld until pseudonymisation is wired (S-f). Materialisation follows once P4 is met ([Data between routes](#data-between-routes)).

**Each child's view is its own, within the allowed sibling boundary (review, 2026-10-15).** `decisionLoop` supplies a synthetic **context** containing the committed events and this turn's earlier children's events, restricted to the siblings allowed for that child. Result visibility is enforced in that context, not just as a selector filter; excluded sibling `tool_result` payloads (including copies in orchestrator records) must be unavailable even to an unfiltered expansion lookup. Preserve the user-message input independently, so filtering sibling results cannot remove the task. It does that the way `chain()` does, a synthetic context plus `dropHitl` (`chain.server.ts:331-341`). The child's view is then built from that context and **the child's own `viewConfig`**, as `chain()` builds `createEventView(syntheticCtx, pattern.config.viewConfig, subId)`. `routes`' pass-through of the parent's view is the thing not to copy.

So the selection is declared on the child, independently per child:

- **`withReferences`' own config.** `source: ['retriever', 'info']` limits **selector candidates** to those sibling patterns (`with-references.server.ts:200-210`). `viewConfig: { fromLastNTurns: 1 }` limits them to this turn. `decisionLoop` runs once per turn, so "this turn" is "this invocation". Keep `patternId: 'retriever'`: the current capability probe requires that literal before inspecting backends (`packages/harness-patterns/pattern-capabilities.ts:27-36, 51-53`), so naming it `retrieve` would disable the upload auto-ingest probe.
- **Close the independent prior-results path.** In this composition `info_ag` sets `rememberPriorTurns: false`: current `simpleLoop` otherwise gathers visible results and merges them with selected references (`simpleLoop.server.ts:283-310`). Its child result view and expansion visibility must admit only `retriever` and `info` siblings, plus its own current work; `doc` results stay unavailable to that path. Slice 1 pins both the candidate/preview path and an attempted expansion of an excluded `doc` event ID, while asserting that the latest user message is retained. The separately labelled, capped handoff remains governed by R1 below.
- **No tool-level filter (owner, 2026-10-15).** The sibling's name in `source` is enough to define what a search may draw on, so `WithReferencesConfig` gains no `tools` option. One is added only if a privacy case needs it.
- **A decisions-model selector.** It is a second `SelectorFn` through the existing required `selector` seam, not a second pattern. Tracked in #570.

**The allowed sibling set is also a privacy control.** `doc_ag`'s results are mail and files. Attached to `info_ag`, which holds web tools, they can become search queries or fetched URLs (SD-1). So `info_ag`'s `source` excludes `doc` unless the owner rules otherwise. R1 on PR #566 covers three flows explicitly: (1) the capped handoff of `doc_ag` output to every route; (2) selected reference previews and on-demand expansion, where `doc` remains excluded from `info_ag`; and (3) the sanitized/capped decision state, including `doc_ag` output under N1. On the Anthropic tier flow (3) goes to the configured decide endpoint, a processor other than Anthropic (`packages/harness-baml/jev-decide.server.ts:301-311`; SD-12); on the private tier it goes only to the self-hosted shim after G11. N1 settles that this decision-state flow happens; R1 must account for it knowingly. **R1 is settled for `info_ag` on the private tier by [G14](https://github.com/mknw/hames-playground/issues/507#issuecomment-6191473862).** Flows (1) and (2) reach `info_ag` only through the [pseudonymisation guard on the web route](#pseudonymisation-guard-on-the-web-route). They are pseudonymised, not stripped, so the web route keeps their content without the identities. Flow (3) and the Anthropic tier are deferred by G14 ("keep as is"), and this doc designs nothing for them.

**Data Stash or `withReferences`: every case in this agent.** The boundary: **the stash holds documents (bytes), and a route reads them through a stash-connected step. `withReferences` re-uses earlier tool results, for a loop that has no stash connection.**

| Data                                                           | Needed by                                          | Channel                                               | Why                                                       |
| -------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| an uploaded or ingested file (Graph-ingest path gated on P4)   | `doc_ag` (code over it)                            | stash → `/work/in`                                    | the sandbox reads files; its actor takes no attached refs |
| a file `doc_ag` produced (`/work/out`)                         | a later turn, or `read-documents`                  | promotion → stash                                     | durable, conversation-scoped bytes                        |
| text inside stash documents                                    | `read-documents`                                   | stash vector search                                   | the retriever is the stash's reader                       |
| `read-documents`' matches, in full                             | `info_ag` (e.g. a web search seeded by a document) | selected preview + expansion, `source: ['retriever']` | `info_ag` has no stash connection                         |
| Cypher rows or web results from an earlier iteration this turn | `info_ag`                                          | selected preview + expansion, `source: ['info']`      | avoids re-querying; the summary alone may drop the rows   |
| Cypher rows or web results                                     | `doc_ag` (compute over them)                       | handoff summary; full rows via materialisation (P4)   | the actor takes no attached refs                          |
| any route's result + reasoning                                 | the next decision, `think`, every child            | state / planner context / `plan_context`              | always on, capped                                         |
| everything this turn produced                                  | the synthesizer                                    | `fromPatterns: ['orchestrator']`                      | it reads the route-output records                         |

So `withReferences` is needed in this agent in exactly one place, around `info_ag`, and the stash in three. Neither replaces the other.

### "Last N route outputs", and where N lives

N is `handoff.lastN` on `decisionLoop`'s config, default 2. It counts **iterations of this loop in this turn**, not patterns. The existing `ViewConfig.fromLastN` counts distinct pattern ids (`event-view.server.ts:84-90, 433-441`), so a route that ran twice would count once, which is the wrong meaning here. `decisionLoop` therefore reads its own route-output records, not a view.

The same N serves both readers: the decisions model's "Latest results", and the next child's handoff block.

### What a route returns: result + reasoning

Each iteration records one **route output**: `{ route, status: 'succeeded' | 'failed', stats, result, reasoning }`. It is built by code from the child's committed events, not by a model call. So there is no new LLM role, and the tier rule has nothing to route.

| Route kind        | `result`                                                                                                                                                   | `reasoning`                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `simpleLoop`      | its final `Return` text, with `returnStyle: 'answer'`. The default `'summary'` returns one line like "Task complete" (architecture review §2)              | the `Return` action's `reasoning`                                |
| `actorCritic`     | the accepted attempt's `tool_result`, the one written to `data.result` on acceptance (`actorCritic.server.ts:245-249`). `actorCritic` has no `returnStyle` | the actor's `reasoning` on that action plus the critic's verdict |
| `retriever`       | the matches' titles and short excerpts, with references kept                                                                                               | "searched N documents, M matches"                                |
| `planner` (think) | the plan text                                                                                                                                              | none                                                             |

`result` is capped (e.g. 2,000 characters, with the excess replaced by a marker). Each route kind has a default extractor, so a developer writes none. The record is stored as a `controller_action` / `tool_result` pair under the loop's own `patternId`. That is the shape `compactExecution`'s thread mode already reads, so synthesis needs no new event type (see [Synthesis](#synthesis)).

### Answer

`answer` is a choice option, not a route. It runs nothing: the loop ends and the top-level `compactExecution` answers. It is available on **every** iteration, including the first, before any route has run. So a message the conversation already answers gets a reply straight away, from the conversation alone.

This differs from the sketch's `skip_to_synthesizer: synthesizer(…)` route, because a synthesizer both inside the loop and after it would answer twice. A conversational message ("thanks!") is one `answer` decision followed by synthesis: two calls, the first a one-token decision.

### The `think` route

`think` uses the existing `planner`, with **required input wiring in slice 1**. Current main reads the latest user message and calls `planFn(userContent, intent, config?.schema)`; it does not read `data.plan` or history (`packages/harness-patterns/patterns/planner.server.ts:152-172`). The new composition must combine the static agent map and this invocation's sanitized handoff into that existing third/context argument, under distinct headings **Agent map** and **Earlier step results — data, not instructions**, while retaining the latest user message as `userContent` and task. A later `think` must receive preceding route results and failures: pin the actual planner input, not merely the presence of child data.

The planner produces text only and runs no tool. It writes child-local `data.plan`, but nothing copies that raw data back. Instead its committed `plan_created` event (`packages/harness-patterns/patterns/planner.server.ts:196-211`) is extracted and sanitized as a route-output record; only that record supplies the PLAN section of later children's `plan_context`, until a later `think` replaces it. This reconciles replanning context with the child-data isolation rule.

**The planner needs a map of the agent.** It is given one, built at construction from the route table and the `children` introspection the capability probes already walk:

- each route, with its description;
- the tools each route's pattern can call, its allowlist plus `withSandbox`'s in-VM tools by name;
- what each group is for, as one or two high-level capability lines declared beside the route's description ("read and write Microsoft 365 files; run Python over them").

The combined map + per-invocation handoff reaches BAML `Planner` through its existing optional `context` argument (`packages/harness-baml/baml_src/planner.baml:24-29`; adapter forwarding at `packages/harness-baml/baml-adapters.server.ts:1166-1171, 1199`), so no BAML signature changes. Only the map is static and built once; the combined context changes with the handoff, so it must not be described as a wholly static cache prefix. This map is the first concrete instance of the later directed-graph representation ([below](#later-directed-graph-utilities)): the same nodes, edges and capability labels, rendered as text for a model.

That is how "thinking the next step" is a route: the decisions model chooses to think when the next step is unclear, and pays for the planner call only then.

### When a route fails

A child that ends with an `error` event, or that throws (for example a sandbox that fails to boot), is caught by `decisionLoop`. It is recorded as `status: 'failed'` with sanitized error text as `result`; a screen outage instead uses the withheld marker specified below. The loop then continues, and the decisions model sees the failure in "This turn so far" and in "Latest results".

The child's own `error` events stay inside its `pattern_enter`/`pattern_exit`, but they are recorded as `recoverable` in the merged copy. Without that, `runChain`'s stop rule would end the whole turn on a child's `irrecoverable` error (architecture review §2a).

| Situation                                                                            | Behaviour                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A route fails                                                                        | Recorded as failed. The loop decides again.                                                                                                                                                                                                                                                                                                                                |
| `maxIterations` reached (default 6)                                                  | The loop stops as if `answer`. The synthesizer answers from what exists and says the work is partial.                                                                                                                                                                                                                                                                      |
| The decide call itself fails                                                         | On the **first** iteration, the turn ends with a visible error: nothing ran, so synthesizing would silently answer without the agent's tools. On a later iteration, the loop stops as if `answer`, and the error is recorded for the synthesizer. Ruled N3 in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323): never a silent fallback. |
| After the G11 prerequisite, the decide transport is unconfigured on the private tier | Refused per #418 G11, and treated like the first-iteration case: a visible error, never a fall-back.                                                                                                                                                                                                                                                                       |

## Routes, and how tools are grouped

- **`read-documents` is its own route** rather than a tool inside `info_ag`. The retriever is a pattern, not an MCP tool. Putting it in `simpleLoop`'s tool list would need round 1's `patternTool` primitive. The redis server's `search_redis_documents` cannot stand in for it: it is not scoped to the conversation, so the model could name another conversation's keys (the same reason `graph_file_ingest` takes its session from the request). As a route it needs nothing new, and `harnessHasRedisRetriever` still finds it through `children`.
- **`info_ag` holds Neo4j reads and web tools.** That grouping is the owner's. Free-form Cypher stays. The agent slice waits for [G13's network isolation and required evidence](https://github.com/mknw/hames-playground/issues/241#issuecomment-6181475778), which supersedes G12 S-a's procedure allow-list dependency; see P3.
- **`doc_ag` holds the Microsoft 365 tools, inside a sandbox.** S-f means **the file path stays off until wired**: withhold `graph_file_ingest` from `MS365_TOOLS` in the agent's effective allowlist until P4's file-path pseudonymisation is wired. Pin the exact name's absence in slice 3. Its eventual presence is conditional on that wiring, not permission for slice 3 to carry real Graph file bytes into `/work/in`.

## Where memory, guards and the sandbox sit

**Memory.** `withMemory(deps.memory)` wraps the top-level array, outermost, as #419 requires. On main, recalled memory has exactly two readers, `router` and `compactExecution`. This shape has no `router`: `decisionLoop` uses the decide path, which reads no memory. So memory reaches **only the synthesizer**:

- it does not reach the decisions model or any child's task;
- `routerMemory` (#546) has nothing to act on in this agent;
- the round-1 concern that memory could flow into web queries and sandbox code is settled by construction.

Recall, wake and settle still run only on interactive turns (#553).

**Injection guards.** Each inner agent gets its own `withInjectionGuard`, as in the sketch, declared by exact name where namespaces cannot reach:

- **`INFO_GUARD`**: `namespaces: ['web', 'neo4j']`.
- **`DOC_GUARD`**: `namespaces: ['graph']` plus the sandbox tools **by name** (`sandbox_read`, `sandbox_bash`, …). `namespaces: ['sandbox']` is refused when the agent is built (security review §1).
- **`read-documents`**: needs `tools: ['retriever']` on a guard that wraps it.
- **One guard around `orchestrator`**, shown in the shape: the union of the three plus the exact fixed tool key **`decision_loop_output`**, `spotlight: 'always'`, and `screen: createInjectionScreen()` (the role-resolved adapter, `packages/harness-baml/baml-adapters.server.ts:1663-1720`). `decisionLoop` uses that key for every output sanitize call; it never uses the route name for this boundary. Nested guards union and never shadow, so the inner guards stay as the local declaration of each agent's sources.
- **S2's pin** walks every name each route can call, and asserts that each is untrusted or on a short trusted list with a reason.

**Sandbox.** `doc_ag` is `withInjectionGuard(withSandbox(actorCritic(…)))`, the sketch's second form. The first form, `actorCritic({ tools: [sandbox, ms-365] })`, cannot be written today: a sandbox's tools exist only inside a `withSandbox` scope. `withSandbox` stays the grouping that shares one machine (owner, round 1).

**One gap inside `doc_ag`.** `withSandbox` hydrates `/work/in` once, on entry, before the actor runs (`with-sandbox.server.ts:665`, then `:703`). A file ingested with `graph_file_ingest` during the same run is in the stash but **not** on disk until the route is entered again. This is the current core gap; in this agent that path remains withheld until P4, and N4 must land before it is enabled. There are three fixes, in order of preference:

1. `withSandbox` re-hydrates after any tool call in its scope that stored a stash document. This is code-driven, needs no model step, and reuses `hydrateWorkspace`'s diff.
2. The decisions model runs `office-data` twice.
3. A separate ingest route.

Ruled N4 in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323): fix (1). It is a core change, so it gets its own slice and its own review.

### Untrusted content on the way up

A route output never passes the `callTool` chokepoint. `decisionLoop` records it directly, and it then reaches two places: the decisions model's state and the next child's `plan_context`, which is an instruction-adjacent slot. So `decisionLoop` passes each `result` and `reasoning` through `currentRunFrame()?.guard?.sanitize('decision_loop_output', value)` before recording it, under the orchestrator-level guard. The fixed key is declared in that guard's `tools`; current `sanitize` is otherwise a no-op (`packages/harness-patterns/patterns/withInjectionGuard.server.ts:152-167`). It builds them only from the child's committed (already sanitized) events, never from a file or a transport read. A pin feeds a known injection string through a child, and expects a neutralized record plus a `content_sanitized` event.

`spotlight: 'always'` on that guard fences everything handed up (ruled S-c in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323)). Slice 1 pins a regex-clean route output coming back fenced; mutation: remove `decision_loop_output` from the guard's `tools` and the pin must fail.

**S-d is implemented at this loop boundary in slice 1.** Current core catches screen throws and returns the content with a `screenReason` (`packages/harness-patterns/patterns/withInjectionGuard.server.ts:187-203`); detections also use that field (`packages/harness-patterns/injection-guard.ts:772`). Add a typed `screenUnavailable?: boolean` flag to `SanitizeReport` and its redacted `SanitizeSummary`, preserving it through `redactReport` (current summary/projection: `injection-guard.ts:173-195`). Never infer an outage from a reason prefix. When either of the loop's sanitize calls reports that flag, mark the route **failed** (A3), replace `result` with **"withheld: screen unavailable"**, and discard `reasoning` and all original output content before creating the record. The loop decides again; neither the state, handoff nor synthesis gets the withheld content. This is this agent's failure policy, not a global change to every guard. Pin a throwing screen and assert a failed marker-only record with no original content in any of those three projections.

Extractors and the later materialiser must never read `content_sanitized` event data (SD-3). Those human-only events may contain verbatim findings. Slices 1 and 5 each pin this using a fixture containing both a sanitized `tool_result` and a `content_sanitized` event with an unmistakable synthetic raw span.

### Pseudonymisation guard on the web route

Ruled in [G14](https://github.com/mknw/hames-playground/issues/507#issuecomment-6191473862); revised for delta review 2 (PR #566, comment 6192033926, D1–D6). `info_ag` is the one route whose tools can send text out of our environment, as a `web_search` query or a `fetch` URL, which is a GET to a public host. The guard makes sure the model composing those arguments never sees a real identity taken from earlier results. It is an extra, outbound-facing filter, and the injection guard stays as it is.

**Where it sits.** It is a core wrapper, `withPseudonymisedInputs`, directly around `withReferences` inside `info_ag`, as in [the shape](#the-shape).

- **The pseudonymiser is injected, not imported.** It lives app-side (`app/src/lib/privacy/pseudonymise.ts`, #160: roster-based, no model), and core cannot import the app. The host supplies it as a new optional `AgentDeps` field, `pseudonymiseForWeb`, the same way it supplies `deps.memory` (`packages/agents/types.ts:91-93`). The agent passes it to the wrapper's config. (`withReferences`' `selector` is a field of that pattern's own config, not an `AgentDeps` seam.)
- **When it applies: every run except one explicitly on the Anthropic tier (D2).** The wrapper applies **unless the run frame's raw tier is exactly `'anthropic'`**. That is the mirror of `onExplicitAnthropicTier` (`packages/harness-baml/clients.server.ts:689-692`), and it errs toward protecting.
  - A positive match on the private tier would miss two kinds of run that still route privately. One is a frame with no tier slot: a script or background job, for which routing falls back to the deployment default (`clients.server.ts:840-866`). The other is an unrecognised value, which routing narrows to that same default.
  - Core cannot read the deployment default itself, because the tier policy lives in `harness-baml`.
  - Turns on the turn path always fill the slot, so an Anthropic-tier conversation is unaffected. A frameless run on an Anthropic-default deployment is pseudonymised needlessly, which is the safe error.
  - G14 defers the Anthropic tier, so there the wrapper passes everything through unchanged.

**What it rewrites: the view and the child's handoff data (D1).** Before the inner pattern runs, the wrapper does two things. Both feed one roster and one table.

1. **It rebuilds the view it hands inward**, as `chain()` builds a child's view (`chain.server.ts:331-335`). Every event the route did not produce in this invocation goes through `apply(value, table)` (`pseudonymise.ts:368`): earlier siblings' `tool_result`s (`retriever`, earlier `info`) and earlier turns' events. `withReferences` passes that view straight to the loop (`with-references.server.ts:304`), and expansion reads `view.fromAll()` (`simpleLoop.server.ts:503`). So selector previews and `expandPreviousResult` payloads are both covered.
2. **It rewrites the plan and handoff fields of the child's `data`.** The handoff is not an event. It lives in the child's `scope.data` and is rendered into `plan_context` from there (`simpleLoop.server.ts:322`), so a view rewrite never reaches it. That covers the latest `think` plan, the earlier-step lines, and the capped result bodies, including `doc_ag`'s summaries (R1 flow 1).

The one exception is the **latest user message**. It is the user's own request, not something "from prior routes". The rewritten copies exist only in that view and that child `data`: `ctx.events` and the stored conversation are untouched.

**The roster, including identities the route never sees (D1).** A capped summary carries no labelled Graph fields. And the `doc` events that do carry them are, by design, outside `info_ag`'s context. So a roster built only from what `info_ag` can see would leave an external mail correspondent who is not a directory member in clear in the handoff. The roster is therefore the union of three sources:

- **what is being rewritten:** `extractRoster` (`graph-roster.ts:193`) over the payloads in the view;
- **everything this turn has produced (E1):** the source `tool_result`s of **every iteration of this turn**, not only those behind the last-N handed-off records. A `think` plan, and the planner input that produced it, can name a sender from a record outside the handoff window. `decisionLoop` ran every iteration, so it holds all of these payloads, `doc_ag`'s mail results included.
  - **They are roster input only.** `decisionLoop` passes them in a child-data key that no adapter renders. They are never shown to `info_ag`, and the sibling restriction on its context still holds.
  - **The key is removed on every path (E2).** `decisionLoop` attaches it only to a route whose pattern declares the wrapper, a `pseudonymisedInputs` capability found through `children` as the other probes are.
  - The wrapper deletes the key in a `finally` before anything runs inside it: on the rewrite path, on the explicit-Anthropic pass-through, on fail-closed and on a throw. `doc_ag`'s raw payloads therefore never sit in `info_ag`'s `data`;
- **the tenant directory:** `rosterFromDirectory`, merged with `mergeRosters` (`org-roster.ts:89, 143`) and read from Neo4j `Member` nodes through `org-graph/roster-source.server.ts`. This is what catches a colleague named only in prose.

The table is built in memory, one per invocation, and dropped when the invocation ends: never stored, never reversed. Placeholders stay placeholders in `info_ag`'s output and in its route-output record. The synthesizer answers with whatever names it has from the other routes.

**Placeholder numbering across invocations (review note).** `buildTable` numbers placeholders by roster position, so `PERSON_1` in an earlier `info` output (already pseudonymised, and left alone by a later `apply`) can name a different person from `PERSON_1` in a later invocation. Merging the directory **first**, in its fixed order, keeps colleagues' numbers stable across invocations. External identities are numbered after them in first-seen order and can still collide. That can confuse the model, but leaks nothing. A per-invocation placeholder prefix would remove it, but that changes `pseudonymise.ts`, so it is left as a known limitation.

**What it does not catch.**

- A person named only in prose who is in neither the directory nor any source payload's labelled fields, such as a customer named only in a mail body.
- Non-person private data, such as project names or amounts. It is not in the roster at all.
- The outgoing check below matches **URL-decoded literals only**, so initials, re-spellings and other encodings pass it (D4).

**Failure mode: withhold, never pass in clear.** On every run the wrapper applies to, it fails closed when:

- **no pseudonymiser was supplied (D3).** `pseudonymiseForWeb` is optional because Anthropic-only deployments do not need it, but absent is never pass-through. The tier is known only per run, so this is enforced at run time, not at construction;
- building the roster or the table throws;
- the directory cannot be read;
- the directory reads as empty when the deployment did not declare that it has none.
  - **The declaration (D4)** is a constructor argument on the app's factory: `createWebPseudonymiser({ directory: 'required' | 'none' })`, default `'required'`.
  - `'none'` is only for a deployment without an org graph.
  - The argument is set in code at the composition root, never by an env var, so relaxing the check is a reviewed line.

When it fails closed:

- the roster-input key is still deleted (E2);
- no references are attached;
- the handoff to `info_ag` keeps only the one-line route / status / stats list, and drops the plan text and every result body;
- every web call in that invocation is refused (below);
- a `warning` records "earlier results withheld: privacy filter unavailable".

The route still runs, on the user's message and the Neo4j reads. It is not a turn error.

**A consequence to state (D4).** The directory comes from Neo4j. So an outage of Neo4j, or of the relay in front of it, refuses every private-tier web call until it recovers.

**Outgoing-argument check: recommended, as the second half of the same guard.** The input rewrite cannot cover what `info_ag` fetches **itself** in this invocation. Free-form Cypher can return a colleague's row, and the next turn of the same loop can put that name into a search query.

- **The check.** It is a pre-dispatch check at the `callTool` chokepoint. Every `web`-namespace call (`fetch`, `web_search`, …) has its arguments URL-decoded and matched against the same roster's literals.
- **Its slot (D4).** It rides a new named run-frame slot, `egressChecks`.
  - `amendRunFrame` copies slots field by field (`run-frame.server.ts:279-289`), so the slot needs its own merge rule. A nested amend **concatenates** with the open frame's checks, never replaces them. Every check runs, and any one denial denies the call.
  - That is the union rule guards follow, applied to a list, as `transports` already concatenates.
- **A match denies the call.** The model gets a recoverable tool failure ("the query contained a private identity; rephrase without it"). This counts as a failed dispatch, not a turn error.
- **Placeholders are denied too (E3).** A placeholder has no value as a search term. With the directory merged first, a colleague keeps the same `PERSON_n` across invocations, turns and conversations, so a placeholder sent to a search provider would become an identifier it can link across sessions, and one that can be traced back to the person in-house. The check therefore also denies any web argument containing a placeholder token, matched as a pattern, `PERSON_<n>` with any suffix: `buildTable` mints `_EMAIL`, `_SLUG`, `_LOCAL`, `_NAME<n>`, `_GIVEN[<n>]` and `_FAMILY[<n>]` (`pseudonymise.ts:185-250`), so an enumerated list would go stale, with the feedback "placeholders are not search terms".
- **Literals in the latest user message are allowed.** A person the user named and asked to search for is the user's call. The owner can tighten this default.
- **No roster, no web calls.** In every fail-closed case above, every web call in that invocation is refused rather than checked against nothing.

This is consistent with ADR-0006. The input half rewrites the view and data a child receives, before any model reads them; it is not a pre- or post-check. The outgoing half acts at the tool chokepoint, which is where that record says guards belong.

**What wiring it decides, and narrowing the tripwire (D5).** `app/src/__tests__/lib/privacy/egress-wiring.test.ts` fails on the first production import of `lib/privacy/`, and its own header asks the wiring commit to delete it. **Narrow it instead.** Rewrite it to allow exactly one production import site, the composition root that builds `pseudonymiseForWeb`, and to fail on any other. Otherwise nothing would flag the next import, such as the S-f file path or an Anthropic-tier hook that G14 defers. The wiring commit states how Q1–Q3 of `graph-pseudonymisation.md` went under G14:

- **Q1, the hook.** This route's input view and handoff data, plus its outgoing web arguments. Nothing else.
- **Q2, what the store holds.** Unchanged: the stored conversation keeps what it holds today.
- **Q3, the table.** None is kept. It lives for one invocation and is never stored or reversed.

**Pins (layer 1).** Each of these is checked by mutation:

- a synthetic Graph payload and a directory member named only in prose both reach the inner controller as placeholders, through both previews and expansion;
- **(D1)** a synthetic mail result in `doc_ag` from an external sender who is not in the directory reaches `info_ag`'s rendered `plan_context` as a placeholder. Mutation: rewrite the view only, and this pin fails;
- **(E1)** with `lastN: 2`, the sequence `doc_ag` reads a mail from an external non-directory sender → `think` names the sender → two other routes → `info_ag`: the sender appears in `info_ag`'s PLAN section as a placeholder. Mutation: draw the roster input from the handed-off records only, and this pin fails;
- **(E2)** the roster-input key is absent from the inner pattern's `data` on the rewrite path, the explicit-Anthropic pass-through, fail-closed and a throw, and a route whose pattern does not declare the wrapper is never given the key;
- **(E3)** a web call whose arguments contain `PERSON_3` or `PERSON_3_EMAIL` is denied;
- the latest user message reaches the inner controller unchanged;
- **(D2)** a frame with no tier slot, and one with an unrecognised tier value, both get the rewrite. A frame whose raw tier is exactly `'anthropic'` is a pass-through;
- **(D3)** on a private-tier run with no `pseudonymiseForWeb`, nothing is attached, no result body is in the handoff, and a web call is refused;
- a roster or table failure, and an unreadable or undeclared-empty directory, each attach nothing and refuse web calls;
- a web call whose URL carries a percent-encoded roster address is denied, and a nested `egressChecks` amend keeps the outer check;
- **(D5)** a second production import of `lib/privacy/` fails the narrowed tripwire.

Mutations: drop the `apply` call; skip the data rewrite; narrow the roster input to the last-N records; move the key deletion out of the `finally`; drop the placeholder-token rule; skip the expansion path; turn the tier rule back into a positive private-tier match; let a missing pseudonymiser pass through; delete the outgoing check; make a nested `egressChecks` replace instead of concatenate.

## Data between routes

- **Files**, once P4 is wired, move through the stash: `graph_file_ingest` → stash → `/work/in` on `doc_ag`'s next entry, or within one entry after N4. Those are real bytes (security review §5), so the path itself stays off until file-path pseudonymisation is wired (S-f), with `graph_file_ingest` withheld by exact name beforehand.
- **Results that are not files.** Under round 1's option (c), as ruled, these reach the sandbox by being materialised into `/work/in/turn/` on entry. This shape narrows (c) to the **handoff**: only the last N route outputs are materialised, the same records the child already sees in `plan_context`, not every tool result of the turn. That settles round 1's "every result, or only referenced ones" question without a `ref:` argument, since routes take no arguments.

  It stays gated on P4, and keeps both review conditions:
  - the materialised files are wiped on entry **and** on exit;
  - promotion skips any `/work/out` file whose hash matches a materialised one.

  The S3 option takes a pseudonymiser, with no boolean form, so "on without P4" cannot be written (security review §6).

## Synthesis

The top-level `compactExecution` in `thread` mode reads loop history through `view.fromLastPattern()` (`compactExecution.server.ts:82-83`). Under this shape the last pattern to enter is the last **child**, not `orchestrator`, so synthesis would silently drop to `response` mode. This is round 1's architecture finding 1, which still applies here.

The fix is small and stated as a slice item: `thread` mode honours `viewConfig.fromPatterns` when it is set, instead of `fromLastPattern()`, and is pinned on exactly this nesting. With `fromPatterns: ['orchestrator']`, the synthesizer reads the route-output records, which is the owner's "view on the last N pattern outputs". It does not read the children's internal traces.

## Preconditions the design owes

- **P1 — Pause and resume.** A resume re-runs the paused top-level pattern from its start (SPEC). Here, that means `decisionLoop` from iteration 1, re-running earlier routes.
  - It becomes cheaper to fix than in round 1: `decisionLoop`'s history is its own compact route-output events, so on resume it can rebuild its iterations from this run's records instead of re-deciding.
  - v1 keeps the round-1 rule: no gated tool inside any route, pinned by allowlist names rather than a `children` walk (architecture review §5.3).
  - No production code pauses today.
- **P2 — The stuck-run reaper.** Its 25-call bound assumes one loop per turn. This shape is up to 6 iterations of up to 15-call children. Arithmetic: 6 × 15 + 6 decisions + 1 synthesis = 97. The architecture review's fix applies unchanged: reap on a dead turn lease, with an age backstop. Ruled A1 in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323): the age bound is a named constant with its justification beside it.
- **P3 — The injection boundary.** As stated in [the guards section](#where-memory-guards-and-the-sandbox-sit), plus **G13 landed, with its evidence**: no egress from Neo4j, and `file://` closed. [G13](https://github.com/mknw/hames-playground/issues/241#issuecomment-6181475778) replaces the historical [G12 S-a](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323) procedure allow-list dependency; free-form Cypher stays. In both compose files, Neo4j must be isolated on its internal network behind the relay, file-URL CSV imports disabled, and APOC file imports off. The G13 implementation PR must carry the specified throwaway-project evidence: public `apoc.load.json` and gateway `apoc.load.jsonParams` POST fail from Neo4j; Redis and Postgres are unreachable; host and gateway Bolt through the relay work; dropping `internal: true` or reconnecting Neo4j to `app-network` makes the egress test fail. These are dependency evidence requirements, not checks run by this docs PR. Historical residual wording: **`LOAD CSV` survives the allow-list**; that network/file-read exposure is closed by G13, rather than left as an allow-list residual. The surviving risk is in `info_ag`: graph rows and untrusted web text share a loop with a model-chosen `fetch` URL or `web_search` query. The guard reduces this risk but cannot stop every paraphrased instruction; Neo4j isolation does not constrain those app-side web calls.
- **P4 — Pseudonymisation** on the materialisation path, unchanged from round 1. It depends on `graph-pseudonymisation.md`'s Q1, Q2, Q3 and Q5. The file path carries real bytes too, so **the path**, not just its pseudonymiser, stays off until wired: `graph_file_ingest` is withheld from the slice-3 effective tool allowlist by exact name. Ruled S-f in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323): the `graph_file_ingest` → `/work/in` path is pseudonymised as well, and stays off until wired.
- **P5 — The decisions model on the private tier.** **Order slice 3 after #418 G11's deletion/client-migration slice.** At the checked main commit the private decide role still resolves to `LocalQwenSmallDecide` (`packages/harness-baml/clients.server.ts:564-572`), so today's code would not enforce the shim-only refusal described here. After that prerequisite, G11 requires private-tier decisions to use a separately configured systemone URL (the self-hosted shim), refused when unset. Until the shim is served, this agent then works on the Anthropic tier only and shows a visible error on the private tier; this is target behaviour after G11, not a claim about current main.

## Rulings (G12, G14)

All 11 round-2 calls and the 3 departures from the sketch were accepted as recommended in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323). The conditions that bind the slices:

- **A1, the reaper.** Reap on a dead turn lease. The age backstop is a named constant with its justification beside it.
- **A3, route failures.** A failed route is a failed output, and the loop decides again. The next decision's state shows it as a failure, never as an empty success.
- **S-a, #241, amended by G13.** G12's historical words were **`LOAD CSV` survives the allow-list**. [G13](https://github.com/mknw/hames-playground/issues/241#issuecomment-6181475778) supersedes that gate and closes that exposure at the network/file boundary. The agent slice waits for G13's network isolation and required evidence (P3), with free-form Cypher retained and no procedure allow-list gate.
- **S-c, spotlight.** `spotlight: 'always'` on the guard around the orchestrator.
- **S-d, the screen.** Fail-closed for this agent (#206 D1): a screen that cannot run blocks the route output from reaching the next decision.
- **S-e, derived files.** They persist as the deliverable, and verbatim copies stay blocked by the hash check. Persisted files leave the sandbox only through the existing owner-scoped `/work` ⇄ DataStash sync, never a new path. This applies once materialisation is built.
- **S-f, pseudonymisation.** The `graph_file_ingest` → `/work/in` path is pseudonymised too. **The path stays off until wired**, enforced by withholding the tool by name until P4.
- **N1, the decision state.** As in [What the decisions model sees](#what-the-decisions-model-sees-each-iteration), with no memory. On the Anthropic tier the state goes to the systemone provider like any other Anthropic-tier call. On the private tier it goes only to the self-hosted shim (#418 G11).
- **N2, the handoff.** `handoff.lastN` defaults to 2, counted in iterations.
- **N3, decide failure.** It ends the turn visibly on iteration 1, and stops as `answer` with the answer marked partial on a later iteration.
- **N4, re-hydration.** `withSandbox` re-hydrates after a stash-storing tool call in its scope. This is its own slice, with its own review.
- **N5, the iteration bound.** `maxIterations` defaults to 6. At the bound the loop stops as `answer`, with the answer marked partial.
- **G14 (2026-10-15), pseudonymisation.** An outbound filter around `withReferences` on the web route (`info_ag`), on the private tier only, with no table kept and no reverse. The filter applies unless a run is explicitly on the Anthropic tier, and it covers the handoff data as well as the view. A roster that cannot be built withholds the references; they are never passed in clear. Designed in [Pseudonymisation guard on the web route](#pseudonymisation-guard-on-the-web-route).
- **The three departures:** the retriever is its own route; `doc_ag` is the sketch's second form; `answer` (`done` in G12) is a choice, so the synthesizer answers once.

The round-1 reviewers' terms (architecture 6068693140, security 6068708025) bind the delta review. Nothing is built before that review converges.

## Later: directed-graph utilities

The owner named a later step: utilities that instantiate loops, agents, harnesses and orchestrators from a directed graph (cycles allowed). `decisionLoop` is the first concrete node type such a graph would need: a node whose outgoing edges are chosen by a decision. The route-output record is the edge payload, and the planner's agent map is the graph rendered as text, so the DG layer should generate that map rather than sit beside a second description of the same agent. Designing the DG layer waits until this agent has run.

## Rollout

Ship as a new agent beside `general` (working id `general-next`). It replaces `general` when:

1. an eval scenario shows no regression on `general`'s current cases, on the private tier only (owner amendment, 2026-10-15; #507 W4);
2. a synthetic fetch → read back → compute request passes;
3. P2, P3 (G13 landed with its evidence) and P5 (G11 deletion/client migration first) are met;
4. P1 is met, or "no gates in routes" is pinned;
5. the M7 memory opt-in moves with it;
6. until P4, `graph_file_ingest` is absent by name, its file path stays off, and no turn-results materialisation capability is declared. The fetch → read back → compute case that needs this path remains gated on P4.

## Slices (dispatched only after owner approval)

1. **`decisionLoop` in core**, which includes:
   - the iteration;
   - the custom state;
   - the route-output record, its stats and the per-kind extractors;
   - each child's synthetic context with `dropHitl`, its own `viewConfig`, and allowed-sibling result/expansion visibility preserving the latest user message; pin that `info_ag` cannot expand an excluded `doc` event and sets `rememberPriorTurns: false`;
   - fresh child data, pinned to contain neither `memories` nor `memoryContext`;
   - the planner's static agent map combined with this invocation's separately labelled handoff in the existing context argument; pin that a later `think` actually receives the preceding output/failure;
   - the core formatter change: only the sanitized `think` record under PLAN, earlier step statuses/results under a data heading; pin the rendered child prompt;
   - sanitizing both output fields under the declared `decision_loop_output` key, with the orchestrator screen; pin regex-clean fencing and verify the key-removal mutation fails;
   - typed screen-outage reporting in `SanitizeSummary` and the failed marker-only record on outage; pin no original content reaches state, handoff or synthesis;
   - extractors reading sanitized committed results only, never `content_sanitized` data, pinned with the two-event fixture (SD-3);
   - rejecting every non-decision under N3, regardless of fallback label; pin the iteration-1 state-builder throw;
   - failure capture and severity downgrade;
   - `maxIterations`;
   - `children` and `estimateTurns`, the latter meaning iterations, not N × child.
2. **`compactExecution` `thread` mode** reads `fromPatterns`, pinned on the nested shape.
3. **The agent**: `general-next`, its orchestrator and per-route guards, and the exact-tool-name walk pin, with an app-path e2e over a synthetic case supported by the enabled capabilities. Gated on P2, **G13 landed with its evidence** (P3), and **G11 deletion/client migration** (P5). Use `patternId: 'retriever'` consistently with reference sources, and pin that the nested Redis capability probe sees it. Until P4, pin by name that the effective `MS365_TOOLS` excludes `graph_file_ingest` and `general-next` declares no turn-results capability.
   The source/formatter/failure/data-isolation pins in slice 1 and these composition pins belong to layer 1 (unit); this slice's real-turn scenario belongs to layer 2 (app-path e2e). They are implementation obligations, not tests added or run by this design PR.
4. **`withSandbox` re-hydrate on stash write** (N4). A core change with its own review.
5. **Materialisation and enabling the file path**, gated on P4. The pseudonymiser-valued option has no boolean form. Include a source-scan pin that no env var can enable materialisation; pin entry/exit wipes and the verbatim-hash promotion block; pin that the materialiser never reads `content_sanitized` data with the same two-event fixture as slice 1. Only after file-path pseudonymisation and N4 are wired may `graph_file_ingest` enter the effective allowlist and its file path run. These deterministic pins belong to layer 1.
6. **Resume from route records** (P1), only when a gate is wanted inside a route.
7. **The web-route pseudonymisation guard ([G14](https://github.com/mknw/hames-playground/issues/507#issuecomment-6191473862)).** `withPseudonymisedInputs` (rewriting the view and the child's plan/handoff data) and the `callTool` outgoing check on a new concatenating `egressChecks` run-frame slot, in core; `decisionLoop` passing the handoff's source payloads as roster input; `AgentDeps.pseudonymiseForWeb` built by the app's `createWebPseudonymiser` from `lib/privacy/`; the `egress-wiring` tripwire **narrowed** to that one import site, not deleted, with Q1–Q3 stated in the commit as in [the section](#pseudonymisation-guard-on-the-web-route). The pins listed there belong to layer 1. On the private tier, slice 3's `info_ag` ships only with this guard in place.

## See also

- #507: the diagnosis, both round-1 reviews, and this round's calls and their rulings (G12).
- #418 G11 (the decisions client) · #419 (memory) · #241 (Neo4j) · #446 (the reaper) · ADR-0005 · ADR-0009
- [`sandbox.md`](sandbox.md) · [`graph-pseudonymisation.md`](graph-pseudonymisation.md) · [`packages/harness-patterns/SPEC.md`](../../packages/harness-patterns/SPEC.md)
