# General Agent as a Decision Loop (Plan)

> **Status: design, not built. Round 2.** This replaces round 1's "patternTool inside a `simpleLoop`" core. Round 1 is in git history as `docs/plan/pattern-tools.md`; its two reviews are on [#507](https://github.com/mknw/hames-playground/issues/507). The shape below is the owner's (2026-10-13). This doc says how it works, what each piece sees, and what it still owes. Nothing is dispatched until the owner signs off. Every call raised in round 2 was ruled in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323) (2026-10-13, owner-delegated); the conditions are folded in below and summarised in [Rulings](#rulings-g12-g14).

## The problem, in one paragraph

An agent's topology is fixed when it is built, and today's `general` is `planner → simpleLoop → compactExecution` over every tool. #507 is a request whose plan needed three steps: fetch a file, read it back, then compute over it. `general` could only do the first. It has no way to read the stash and no sandbox, so the plan described an agent that did not exist. The fix is to let one turn move between groups of capabilities, choosing the next group after seeing what the last one produced.

## The shape

This is the target composition, including the core changes specified below, not runnable code on current main. Source checks for round 2 used `origin/main` at `7a3446ca`. The sections PR #682 adds or rewrites (the file path, writes, resume inside a route, slices 5, 6, 8 and 9) were checked against `origin/main` at `821ce6c4`. In particular, slice 3 follows #418 G11's deletion/client-migration slice (P5), and the file-ingest path stays off until P4.

```typescript
// P4 (2026-10-19): the file path is open; graph_file_ingest itself refuses any run that is not positively private.
const OFFICE_TOOLS = MS365_TOOLS
const screen = createInjectionScreen() // role-resolved; outage handling is specified below
const doc_ag = withInjectionGuard(DOC_GUARD)(                      // office + data work
  withSandbox({ id: `${sessionId}:office:${tier}`, rootfs: 'office', egress: 'mcp-only', syncWorkspace: true })(
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
const knowledge_edit = withInjectionGuard(KNOWLEDGE_EDIT_GUARD)(   // H1: Neo4j writes, each approved by the person
  simpleLoop(createLoopControllerAdapter(), [...NEO4J_READ, 'cypher_write_request'], { patternId: 'knowledge-edit', returnStyle: 'answer', rememberPriorTurns: false, multiToolCalls: 'off' }),
)

const orchestrator = withInjectionGuard({
  ...GUARD_UNION, // INFO_GUARD + DOC_GUARD + KNOWLEDGE_EDIT_GUARD + retriever, with the catalog for namespace validation
  tools: [...GUARD_UNION.tools, 'decision_loop_output'],
  spotlight: 'always',
  screen,
})(decisionLoop(
  {
    'office-data': { pattern: doc_ag, description: 'Work on Microsoft 365 files and mail; run code over them' },
    'info-retrieval': { pattern: info_ag, description: 'Look things up in the knowledge graph, on the web, in library docs and in the memory graph' },
    'read-documents': { pattern: retrieve, description: 'Search documents already in this conversation' },
    'knowledge-edit': { pattern: knowledge_edit, description: "Change the knowledge graph; every change waits for the person's approval" },
    think: { pattern: think, description: 'Decide the steps before acting' },
  },
  { decide, answer: 'Generate the answer for the user now, from the conversation and any results so far', handoff: { lastN: 2 }, maxIterations: 6, patternId: 'orchestrator' },
))

// P4 tier flip: a confirmation screen before private-tier content reaches an Anthropic-tier turn.
agent = withMemory(deps.memory)([privateContentRelease(deps.privateContent), orchestrator, compactExecution({ mode: 'thread', patternId: 'response-synth', viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 } })])
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
- **"Uploaded documents in this conversation"** (#507, built; design in [`decide-document-context.md`](decide-document-context.md)) is an optional block between the conversation and "This turn so far": a capped list of every visible document's name, type and size on the private tier, a count only on every other, omitted when there are none.
- **Trimming.** The whole block is trimmed oldest-first to the decide window, as the default state is.
- **Caching.** The state is **append-only within a turn**: conversation first, then iterations in order. A provider prefix cache could therefore reuse everything but the tail.
  - On the Anthropic tier the decide call goes to the systemone provider, not to an Anthropic model. That transport records no cache reads (`jev-decide.server.ts:180-182`), and the provider documents no prompt cache, so there is nothing to switch on today.
  - The prompts that grow and do run on Anthropic models are the children's. Their handoff rides `plan_context`, which renders in the run-static tier 2 behind the #122 `cache_control` breakpoints. So within one child run the handoff is cached after its first call, and across iterations the system block and tier 1 stay byte-identical.
  - Nothing new is needed for v1. Measure the cache-read share on a multi-iteration turn before designing more.
- **What is left out.** The route descriptions are not in the state: they are the question's options. Memory is not in the state either (see [Memory](#where-memory-guards-and-the-sandbox-sit)). **Neither are the conversation's uploaded documents**, and Eval run 3 shows the cost: a question naming an uploaded file by its bare name was routed to the web. The owner has decided how to tell the decisions model (the private tier sees a capped name list, every other tier a count), designed but not built in [`decide-document-context.md`](decide-document-context.md).

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
4. **Files, for the sandbox.** Stash → `/work/in` on entry, and again after any stash-storing call in the same run (N4, built in slice 4). The Graph-ingest path runs on a positively private tier only ([The file path (P4)](#the-file-path-p4)). Materialisation of results that are not files stays deferred ([Data between routes](#data-between-routes)).

**Each child's view is its own, within the allowed sibling boundary (review, 2026-10-15).** `decisionLoop` supplies a synthetic **context** containing the committed events and this turn's earlier children's events, restricted to the siblings allowed for that child. Result visibility is enforced in that context, not just as a selector filter; excluded sibling `tool_result` payloads (including copies in orchestrator records) must be unavailable even to an unfiltered expansion lookup. Preserve the user-message input independently, so filtering sibling results cannot remove the task. It does that the way `chain()` does, a synthetic context plus `dropHitl` (`chain.server.ts:331-341`). The child's view is then built from that context and **the child's own `viewConfig`**, as `chain()` builds `createEventView(syntheticCtx, pattern.config.viewConfig, subId)`. `routes`' pass-through of the parent's view is the thing not to copy.

So the selection is declared on the child, independently per child:

- **`withReferences`' own config.** `source: ['retriever', 'info']` limits **selector candidates** to those sibling patterns (`with-references.server.ts:200-210`). `viewConfig: { fromLastNTurns: 1 }` limits them to this turn. `decisionLoop` runs once per turn, so "this turn" is "this invocation". Keep `patternId: 'retriever'`: the current capability probe requires that literal before inspecting backends (`packages/harness-patterns/pattern-capabilities.ts:27-36, 51-53`), so naming it `retrieve` would disable the upload auto-ingest probe.
- **Close the independent prior-results path.** In this composition `info_ag` sets `rememberPriorTurns: false`: current `simpleLoop` otherwise gathers visible results and merges them with selected references (`simpleLoop.server.ts:283-310`). Its child result view and expansion visibility must admit only `retriever` and `info` siblings, plus its own current work; `doc` results stay unavailable to that path. Slice 1 pins both the candidate/preview path and an attempted expansion of an excluded `doc` event ID, while asserting that the latest user message is retained. The separately labelled, capped handoff remains governed by R1 below.
- **No tool-level filter (owner, 2026-10-15).** The sibling's name in `source` is enough to define what a search may draw on, so `WithReferencesConfig` gains no `tools` option. One is added only if a privacy case needs it.
- **A decisions-model selector.** It is a second `SelectorFn` through the existing required `selector` seam, not a second pattern. Tracked in #570.

**The allowed sibling set is also a privacy control.** `doc_ag`'s results are mail and files. Attached to `info_ag`, which holds web tools, they can become search queries or fetched URLs (SD-1). So `info_ag`'s `source` excludes `doc` unless the owner rules otherwise. R1 on PR #566 covers three flows explicitly: (1) the capped handoff of `doc_ag` output to every route; (2) selected reference previews and on-demand expansion, where `doc` remains excluded from `info_ag`; and (3) the sanitized/capped decision state, including `doc_ag` output under N1. On the Anthropic tier flow (3) goes to the configured decide endpoint, a processor other than Anthropic (`packages/harness-baml/jev-decide.server.ts:301-311`; SD-12); on the private tier it goes only to the self-hosted shim after G11. N1 settles that this decision-state flow happens; R1 must account for it knowingly. **R1 is settled for `info_ag` on the private tier by [G14](https://github.com/mknw/hames-playground/issues/507#issuecomment-6191473862).** Flows (1) and (2) reach `info_ag` only through the [pseudonymisation guard on the web route](#pseudonymisation-guard-on-the-web-route). They are pseudonymised, not stripped, so the web route keeps their content without the identities. Flow (3) and the Anthropic tier are deferred by G14 ("keep as is"), and this doc designs nothing for them.

**S3b accepted flow — non-identity memory data reaches outbound tools (S3b review F5).** G14 pseudonymises people only. Project names, internal codenames and figures read from the memory graph can become web or `context7` arguments, on both tiers, as Neo4j results already can. Person-typed memory entities and every email in their observations do join the roster (`web-pseudonymiser.server.ts`, `memoryRoster`). The memory graph itself is one volume shared by all users and written by `general` without a guard; scoping it per user, or retiring it for #419's `withMemory`, is a separate decision.

**R1 flow 4 — sandbox promotion through the stash (PR #603 finding 4, owner-ruled).** Every new or changed file promoted by `promoteOutputs` carries the fixed `provenance: 'sandbox-output'` enum into its stash record; this covers arbitrary filenames and all sandbox callers, not a name allowlist (`packages/sandbox/work-artifacts.server.ts`, `workspace-store.ts`). The injected host store is the real `storeDocument` (`app/src/middleware.ts`); metadata and ingest-status updates preserve that field (`packages/harness-patterns/stash/document-store.server.ts`). Ingestion copies it to each indexed chunk; search and the Redis backend return it on each retrieval hit (`stash/document-ingest.server.ts`, `retriever/redis-backend.server.ts`). The retriever's sanitization preserves this structural field while rewriting chunk text.

`withInfoDocumentReferences`, outside `withReferences` and inside the existing web pseudonymisation wrapper, removes tagged hits and their source references from info's copied backing event view, rebuilds mixed-result previews, and removes all-promoted result events (`packages/agents/agents/info-document-references.server.ts`). Candidate selection and explicit expansion therefore consume the same filtered result, on either tier and after later-turn retrieval. The filter checks tag presence after the private projection, because that projection may rewrite string values; even a rewritten tag still excludes the hit. The original retrieval events remain available to `read-documents`, `doc`, and user synthesis. Uploaded/non-promoted documents retain their current behavior; an absent tag means not promoted, with no backfill or migration. The new field is fixed non-content provenance, classified as plaintext structural metadata alongside `ingestStatus`; it adds no free text or encrypted content column. This closes the reference relay only; the separately ruled handoff and decision-state flows remain as described above.

**Data Stash or `withReferences`: every case in this agent.** The boundary: **the stash holds documents (bytes), and a route reads them through a stash-connected step. `withReferences` re-uses earlier tool results, for a loop that has no stash connection.**

| Data                                                                          | Needed by                                          | Channel                                                   | Why                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| an uploaded or ingested file (Graph-ingest: private tier only, P4)            | `doc_ag` (code over it)                            | stash → `/work/in`                                        | the sandbox reads files; its actor takes no attached refs |
| a file `doc_ag` produced (`/work/out`)                                        | a later turn, or `read-documents`                  | promotion → stash                                         | durable, conversation-scoped bytes                        |
| text inside stash documents                                                   | `read-documents`                                   | stash vector search                                       | the retriever is the stash's reader                       |
| `read-documents`' matches, in full                                            | `info_ag` (e.g. a web search seeded by a document) | selected preview + expansion, `source: ['retriever']`     | `info_ag` has no stash connection                         |
| Cypher rows or web results from an earlier iteration this turn                | `info_ag`                                          | selected preview + expansion, `source: ['info']`          | avoids re-querying; the summary alone may drop the rows   |
| Cypher rows or web results                                                    | `doc_ag` (compute over them)                       | handoff summary; full rows via materialisation (deferred) | the actor takes no attached refs                          |
| any route's result + reasoning                                                | the next decision, `think`, every child            | state / planner context / `plan_context`                  | always on, capped                                         |
| everything this turn and the previous one produced (earlier failures dropped) | the synthesizer                                    | `fromPatterns: ['orchestrator']`, `threadTurns: 2`        | it reads the route-output records                         |

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

**Amended by #692:** a `planner` route is not offered straight after itself, nor once a plan exists this turn (live evidence: `think` chosen six of six iterations in one run, and twice in a row in another). A later `think` replacing the plan is therefore opt-in per route (`allowReplan`), not the default; `general-next` does not opt in. See SPEC's "What is offered". The guard reads only this run's records and latest plan, so it follows whatever the loop holds: today a resume re-enters the loop with neither (resume step 11); once slice 6 rebuilds them, a plan made before the pause keeps the planner withheld.

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
- **`info_ag` holds Neo4j reads, web tools, the two `context7` library-doc tools and the memory graph's READ tools** (`search_nodes`, `open_nodes`; `read_graph` stays out because the memory graph is shared by every user and the call returns all of it; S3b, to match what `general` can do for scenarios 04/05). The memory create/add/delete tools stay withheld by name. `context7` is an outbound public service, checked like web search by the G14 egress check; `memory` is declared local beside `neo4j`. The Neo4j-and-web grouping was the owner's. Free-form Cypher stays. The agent slice waits for [G13's network isolation and required evidence](https://github.com/mknw/hames-playground/issues/241#issuecomment-6181475778), which supersedes G12 S-a's procedure allow-list dependency; see P3.
- **`doc_ag` holds the Microsoft 365 tools, inside a sandbox.** Until slice 5, `graph_file_ingest` stays withheld by exact name, as slice 3 pinned. With P4 ruled (2026-10-19), slice 5 adds it to the allowlist; the tool itself refuses any run that is not positively private ([The file path (P4)](#the-file-path-p4)).
- **`knowledge-edit` holds the Neo4j read tools and the write request** (H1, accepted 2026-10-19, as `graph-edit`; renamed because the UI edit module already has that name). It has no web tools and no pseudonymisation wrapper, and it is built with slices 6 and 8 ([Writes, gated by a person](#writes-gated-by-a-person)).

## Where memory, guards and the sandbox sit

**Memory.** `withMemory(deps.memory)` wraps the top-level array, outermost, as #419 requires. On main, recalled memory has exactly two readers, `router` and `compactExecution`. This shape has no `router`: `decisionLoop` uses the decide path, which reads no memory. So memory reaches **only the synthesizer**:

- it does not reach the decisions model or any child's task;
- `routerMemory` (#546) has nothing to act on in this agent;
- the round-1 concern that memory could flow into web queries and sandbox code is settled by construction.

Recall, wake and settle still run only on interactive turns (#553).

**Injection guards.** Each inner agent gets its own `withInjectionGuard`, as in the sketch, declared by exact name where namespaces cannot reach:

- **`INFO_GUARD`**: `namespaces: ['web', 'neo4j', 'context7', 'memory']` (S3b).
- **`DOC_GUARD`**: `namespaces: ['graph']` plus the sandbox tools **by name** (`sandbox_read`, `sandbox_bash`, …). `namespaces: ['sandbox']` is refused when the agent is built (security review §1).
- **`read-documents`**: needs `tools: ['retriever']` on a guard that wraps it.
- **One guard around `orchestrator`**, shown in the shape: the union of the three plus the exact fixed tool key **`decision_loop_output`**, `spotlight: 'always'`, and `screen: createInjectionScreen()` (the role-resolved adapter, `packages/harness-baml/baml-adapters.server.ts:1663-1720`). `decisionLoop` uses that key for every output sanitize call; it never uses the route name for this boundary. Nested guards union and never shadow, so the inner guards stay as the local declaration of each agent's sources.
- **S2's pin** walks every name each route can call, and asserts that each is untrusted or on a short trusted list with a reason.

**Sandbox.** `doc_ag` is `withInjectionGuard(withSandbox(actorCritic(…)))`, the sketch's second form. The first form, `actorCritic({ tools: [sandbox, ms-365] })`, cannot be written today: a sandbox's tools exist only inside a `withSandbox` scope. `withSandbox` stays the grouping that shares one machine (owner, round 1).

**One gap inside `doc_ag`.** `withSandbox` hydrates `/work/in` once, on entry, before the actor runs (`with-sandbox.server.ts:665`, then `:703`). A file ingested with `graph_file_ingest` during the same run is in the stash but **not** on disk until the route is entered again. This was the core gap, and the file path waited for it. There were three fixes, in order of preference:

1. `withSandbox` re-hydrates after any tool call in its scope that stored a stash document. This is code-driven, needs no model step, and reuses `hydrateWorkspace`'s diff.
2. The decisions model runs `office-data` twice.
3. A separate ingest route.

Ruled N4 in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323): fix (1). It was a core change with its own slice and review, and it is built: slice 4 (`1b847214`) re-hydrates through `stashWriteObservers` (`packages/sandbox/with-sandbox.server.ts:700-757`).

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

**What it rewrites: the view and all child data (D1).** Before the inner pattern runs, the wrapper does two things. Both feed one roster and one table.

1. **It rebuilds the view it hands inward**, as `chain()` builds a child's view (`chain.server.ts:331-335`). Every visible event the route did not produce in this invocation goes through `apply(value, table)` (`pseudonymise.ts:368`): earlier siblings' `tool_result`s (`retriever`, earlier `info`) and earlier turns' events. `withReferences` passes that view straight to the loop (`with-references.server.ts:304`), and expansion reads `view.fromAll()` (`simpleLoop.server.ts:503`). So selector previews and `expandPreviousResult` payloads are both covered.
2. **It rewrites all inherited child `data` except the roster-only key.** The handoff is not an event. It lives in the child's `scope.data` and is rendered into `plan_context` from there (`simpleLoop.server.ts:322`), so a view rewrite never reaches it. This covers the latest `think` plan, earlier-step lines, capped result bodies including `doc_ag`'s summaries (R1 flow 1), and arbitrary keys such as `intent` inherited under `chain()`.

The one exception is the **latest user message**. It is the user's own request, not something "from prior routes". The copied backing context contains only events selected by the child’s view plus the latest user message, so even an unfiltered expansion cannot recover excluded events. Residual literals after rewriting replace only their string body with `[withheld: private identity]`, preserving valid provenance fences and keeping other content and web calls available. `ctx.events` and the stored conversation are untouched. Under `chain()`, the returned rewritten data is forwarded to later steps; under `decisionLoop`, route data is fresh for each child.

**The roster, including identities the route never sees (D1).** A capped summary carries no labelled Graph fields. And the `doc` events that do carry them are, by design, outside `info_ag`'s context. So a roster built only from what `info_ag` can see would leave an external mail correspondent who is not a directory member in clear in the handoff. The roster is therefore the union of three sources:

- **what is being rewritten:** `extractRoster` (`graph-roster.ts:193`) over the payloads in the view;
- **everything this turn has produced (E1):** the source `tool_result`s of **every iteration of this turn**, not only those behind the last-N handed-off records. A `think` plan, and the planner input that produced it, can name a sender from a record outside the handoff window. `decisionLoop` ran every iteration, so it holds all of these payloads, `doc_ag`'s mail results included.
  - **They are roster input only.** `decisionLoop` passes them in a child-data key that no adapter renders. They are never shown to `info_ag`, and the sibling restriction on its context still holds.
  - **The key is removed on every path (E2).** `decisionLoop` attaches it only to a route whose pattern declares the wrapper, a `pseudonymisedInputs` capability found through `children` as the other probes are.
  - The wrapper deletes the key in a `finally` before anything runs inside it: on the rewrite path, on the explicit-Anthropic pass-through, on fail-closed and on a throw. `doc_ag`'s raw payloads therefore never sit in `info_ag`'s `data`;
- **the tenant directory:** `rosterFromDirectory`, merged with `mergeRosters` (`org-roster.ts:89, 143`) and read from Neo4j `Member` nodes through `org-graph/roster-source.server.ts`. This is what catches a colleague named only in prose.

Accepted actorCritic object results have their string leaves unfenced before JSON stringification; the loop fences the complete record again. This keeps substitution boundaries intact, while normalising JSON escapes in the literal checker supplies a safety net for residual text. A JSON-shaped body is rewritten and withheld per parsed leaf (re-stringified only if a leaf changed), so a content newline before a name (`Regards,\nOtto`) costs one leaf, not the whole record. A roster identity the injection screen has already neutralized (its quoted span replaced by a `⟦neutralized:…⟧` marker in a labelled identity field) cannot be recovered, so the host throws and the wrapper takes its fail-closed path: earlier content withheld, web calls refused, one fixed warning. The refusal is conversation-sticky: the wrapper harvests every `tool_result` in the context and `continueSession` restores earlier turns, so every later web-route invocation in that conversation fails closed while that result stays in context. A sender can trigger it on purpose through the display name (a deterministic `instruction-override` marker carries the same prefix). A new conversation recovers; the durable fix is a pre-screen roster input never shown to a model.

The table is built in memory, one per invocation, and dropped when the invocation ends: never stored, never reversed. Placeholders stay placeholders in `info_ag`'s output and in its route-output record. The synthesizer answers with whatever names it has from the other routes.

**Placeholder numbering across invocations (review note).** `buildTable` numbers placeholders by roster position, so `PERSON_1` in an earlier `info` output (already pseudonymised, and left alone by a later `apply`) can name a different person from `PERSON_1` in a later invocation. Merging the directory **first**, in its fixed order, keeps colleagues' numbers stable across invocations. External identities are numbered after them in first-seen order and can still collide. That can confuse the model, but leaks nothing. A per-invocation placeholder prefix would remove it, but that changes `pseudonymise.ts`, so it is left as a known limitation.

**What it does not catch.**

- A person named only in prose who is in neither the directory nor any source payload's labelled fields, such as a customer named only in a mail body.
- Non-person private data, such as project names or amounts. It is not in the roster at all.
- Local discoveries require Graph-shaped labelled identity fields. A flat Cypher row such as `{ name, email }` adds nothing unless a recognised field or the directory already supplies that person.
- The outgoing check matches URL-decoded literals with the normalisation below; initials, re-spellings and other encodings still pass it (D4).

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

- **The check.** It is a pre-dispatch check at the `callTool` chokepoint. Every call except the declared local `neo4j` namespace has its arguments URL-decoded and matched against the roster's literals, even without the app's namespace registration. NFKD without combining marks, separators `-_.+/` mapped to spaces, and a letters-only comparison for full names of at least six characters cover URL slugs. One active alternation is compiled and rebuilt on each local observation, with user-named exemptions in a Set. JSON escapes are normalised before matching. Compact comparisons use token boundaries and never join separate tokens; an exact-token collision such as `Tim Ely` / `timely` remains accepted.
- **Local discoveries.** An `afterToolCall` hook in the same amendment extends the outgoing literal set from labelled identities in local result data, unfencing every string leaf first. It checks only and never rewrites these results; an extension error withholds that result, records fixed feedback and refuses further outgoing calls.
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

### The file path (P4)

Ruled by the owner on 2026-10-19 (recorded in [the fix-round comment on PR #682](https://github.com/mknw/hames-playground/pull/682#issuecomment-6256235215)). S-f said to pseudonymise the `graph_file_ingest` → `/work/in` path; G14 later stated what pseudonymisation is for here, which is keeping identities from leaving through an outbound call. Read together: **the file path is protected at its exits, not by rewriting the file.** No byte is rewritten and no table is kept, and a document the person asked for keeps its real names.

**Why not rewrite the bytes.** On the private tier, a rewritten copy would protect nothing that can leave:

- the `office-data` sandbox has no network at all: `egress: 'mcp-only'` (`packages/agents/agents/general-next.server.ts:61`) boots it with `--network none` (`packages/sandbox/docker-backend.server.ts:670-671`);
- the actor's model calls go only to the private tier's own deployments;
- no tool can write to Microsoft 365: delegated `graphFetch` refuses every method except GET and the Search POST before a token is touched (#680, `app/src/lib/auth/graph-token.server.ts:186-190`). `graph_file_ingest` writes only to this conversation's stash;
- the one route with outbound tools, `info-retrieval`, receives `office-data`'s output only through G14's filter, whose roster input holds every payload of the turn (E1).

What the file says reaches the actor fenced: `DOC_GUARD` names the sandbox tools (`general-next.server.ts:84-87`), and the retriever sanitizes its matches when it records them (SD-1, SD-6). Rewriting would also cost a rewriter per format (Office files are zipped XML; PDFs and images cannot be rewritten reliably), plus a reversible table to put real names back into the deliverable, which G14 chose not to keep.

**The exits, and what holds each:**

| Exit                                                      | What holds it                                                                                                                                                                                                                                                                                              | Pin                                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| a model call on the Anthropic tier, **at ingestion**      | the tool refuses any run whose raw tier is not exactly the private one (below)                                                                                                                                                                                                                             | frameless, unrecognised and `'anthropic'` frames refused; a private frame allowed                                                    |
| a model call on the Anthropic tier, **after a tier flip** | the copy is tagged and skipped, and the sandbox id carries the tier, until the person releases that version, and the history, at a confirmation screen ([below](#a-tier-flip-mid-conversation-owner-2026-10-19))                                                                                           | the trigger, tag, sandbox and binding pins below                                                                                     |
| the sandbox's network                                     | `egress: 'mcp-only'`, i.e. no network                                                                                                                                                                                                                                                                      | already pinned (`app/src/__tests__/lib/harness-client/agents/general-next.test.ts:253`)                                              |
| a web call from `info-retrieval`                          | G14: the view, the handoff data and the outgoing check                                                                                                                                                                                                                                                     | G14's pins, plus a synthetic ingested file whose text names a directory member                                                       |
| a Microsoft 365 write                                     | the #680 barrier above. None is designed here, and a writer would be a new owner decision                                                                                                                                                                                                                  | already pinned (`app/src/__tests__/lib/auth/graph-token.test.ts`; `packages/connectors/__tests__/graph/graph-connectors.test.ts:29`) |
| a Neo4j write                                             | the person's approval. An approved write also leaves the private tier and the person's Microsoft 365 permissions: every user reads the graph, on either tier ([Writes](#writes-gated-by-a-person))                                                                                                         | slice 8                                                                                                                              |
| memory                                                    | content reaches memory only through the final reply, and D9 holds it: a memory's evidence must be a verbatim span of the current user message, and every identifier in it must occur in a user message (`packages/harness-patterns/SPEC.md:2635-2653`; `packages/harness-baml/baml_src/memory.baml:21-25`) | already pinned (`input-isolation`)                                                                                                   |
| the embedder                                              | the tool refuses while `EMBEDDINGS_PROVIDER` is `openrouter`. `local` names the wire format, not the host (`stash/embeddings.server.ts:126-139`), so the endpoint behind it must be a service the deployment runs: a deployment rule, not a code check                                                     | the `openrouter` refusal only                                                                                                        |
| the conversion sidecar                                    | the same deployment rule: `DOC_CONVERT_URL` receives a convertible file's bytes (`packages/harness-patterns/stash/doc-convert.server.ts:40`)                                                                                                                                                               | none                                                                                                                                 |
| an agent holding the gateway's raw `redis` tools          | only a deployment that omits the `redis` server (`docs/PREVIEW.md:251`); the tag does not hold it ([below](#a-tier-flip-mid-conversation-owner-2026-10-19))                                                                                                                                                | none; withholding the tools is a separate issue                                                                                      |

A check on a URL would decide the same call differently on two hosts, which is why the two endpoint rules are deployment rules.

**The tier check (decision 3).** `graph_file_ingest` runs only when the run frame's raw tier is exactly the private tier's value. This is the mirror image of G14's rule. G14 errs toward protecting by **applying** unless a run is explicitly Anthropic; this check errs toward protecting by **refusing** unless a run is explicitly private.

- A frame with no tier slot, or with an unrecognised value, is refused even when the deployment default is private. That is the safe error, since turns on the turn path always fill the slot. On a private-tier-only server (#653) the Anthropic tier cannot be selected at all.
- The check sits in the tool's executor, through a predicate the host injects when it registers the graph tools (as it injects the stash). Core and the connectors stay tier-agnostic. The embedder refusal sits beside it.
- A refused call returns fixed feedback: "copying a file into the conversation runs only on the private tier".

**This closes a live gap on main.** `listTools` appends the process-registered app tools (`packages/harness-patterns/mcp-client.server.ts:663, 675`), so `tools.all` lists `graph_file_ingest`, and `general` hands `tools.all` to both of its loops (`packages/agents/agents/general.server.ts:59, 69`). So `general` can ingest a file today on the Anthropic tier, or with an OpenRouter embedder, which is exactly what P4 forbids; the security review confirmed it with a scratch test. Because the check is in the executor, it covers `general` too, and it ships first, as slice 5a.

**Stored copies (decision 2, Q2).** The stash copy is unchanged: the stash keeps the original file for 7 days (`packages/harness-patterns/stash/document-store.server.ts:154`), like an upload, and indexes its chunks in plaintext when the format allows. SD-11's session-not-owner key scoping applies to it as to every stash document. **The conversation blob is a second store:** the file text the actor reads through sandbox tools, and the route records built from it, persist in `conversations.context` with no expiry, encrypted at rest (SD-10, SD-11).

**The table (Q3).** There is none: nothing is rewritten, so nothing is reversed.

**Formats.** There are no format rules. `/work/in` receives the original bytes whatever the format (`packages/sandbox/work-artifacts.server.ts:119-121`), and the actor's code reads them. Indexing covers text formats and, with conversion on, PDF plus the Word, OpenDocument and PowerPoint formats (`stash/doc-convert.server.ts:50-61`); spreadsheets, images and everything else are stored `not_indexed`. Scenario 16's spreadsheets are read by code in the sandbox, and what gets indexed is the report that code writes.

**Q5, a stable pseudonym.** Not applicable: this path mints no placeholders.

**Accepted limitation (decision 4).** A person named only inside a file's body, who is neither in the directory nor in a labelled field of the turn, reaches `info-retrieval`'s prompt in clear through the handoff. That is exactly what happens today to a person named only in a mail body ("What it does not catch", above). The outgoing check still denies a web call carrying a roster literal, but that person is not in the roster.

#### A tier flip mid-conversation (owner, 2026-10-19)

The tier is set per turn, and a conversation's private-tier content outlives the turn that produced it: the stash copy lasts 7 days, and the conversation's history has no expiry. **Owner ruling:** _"Show HITL screen and ask for confirmation, showing the data that would be transferred to Anthropic. With warning."_ ([record](https://github.com/mknw/hames-playground/pull/682#issuecomment-6269324396)). Two readings are recorded with it.

- **"Transferred to Anthropic" means to the Anthropic tier's processors.** That tier reaches Anthropic for the model calls, and also the host of the configured decisions endpoint for the decision state: `decide` is `JevDecide` there (`packages/harness-baml/clients.server.ts:406`), posting to `JEV_DECISIONS_URL` (`packages/harness-baml/jev-decide.server.ts:45-46`; SD-12). The decision state holds the recent conversation and the last N route outputs in full (`decisionLoop.server.ts:349-372`), so once a file is released, what a route reports about it reaches that endpoint as well.
- **History is covered too (owner, 2026-10-19:** _"both"_**).** The screen covers the conversation's earlier private-tier turns, which every Anthropic-tier turn sends as history, as well as the files copied on the private tier. A file's content can already sit in an earlier final reply, and later turns read those as history (`packages/harness-patterns/patterns/typedDecision.server.ts:403-415`, read at `decisionLoop.server.ts:425`), even after the stash copy has expired. Encryption at rest does not stop this: the conversation is decrypted to run the turn (`app/src/lib/db/conversations.server.ts:169-170`), and G14 passes everything through on an explicit Anthropic run (`withPseudonymisedInputs.server.ts:69-72`).

**The tag is the default.** `graph_file_ingest` stores its copy with a new fixed provenance value, `graph-file`, beside today's `sandbox-output` (`document-store.server.ts:46, 331`). A document promoted on a private-tier turn also carries `privateTier: true`, so derived copies are covered too. On a run that is not positively private, hydrate skips such a document and the retriever drops its hits, unless the person released that exact version (below).

**The sandbox carries the tier.** The `office` sandbox is addressed by id and parked for up to an hour (`general-next.server.ts:85-90`; `packages/sandbox/settings.ts:66`), and hydrate writes only the files that are missing (`packages/sandbox/work-artifacts.server.ts:85-107`). So a file hydrated on a private turn would otherwise still be in `/work/in` on an Anthropic-tier turn, whatever the person answered (SD-21). The id therefore includes the tier, `${sessionId}:office:${tier}`, and the Anthropic-tier machine only ever hydrates released copies.

**The gate is a top-level pattern before the orchestrator**: `privateContentRelease(deps.privateContent)` in [the shape](#the-shape).

- **When it fires.** On a run that is not positively private, if the conversation holds private-tier content not yet released: any earlier turn that ran on the private tier since the last release, or any undecided `graph-file` or `privateTier` copy. Each turn records the tier it ran on; slice 5b adds that record. A turn with no recorded tier, such as one from before 5b, counts as private-tier content. `conversations.inference_tier` cannot stand in for it, because it records only the first turn's tier (`app/src/lib/db/conversations.server.ts:490`). The history alone is enough to trigger it, so an expired stash copy does not stop it firing.
- **Before anything is sent.** It raises one request (`kind: 'private-content-release'`) before any route runs.
- **Why top-level.** A gate there needs no resume inside a route: a resume re-runs it from its start, and it replays the answer (SPEC resume step 11). A gate at hydrate or retrieval would sit inside `withSandbox` or the retriever, which v1 does not resume. A run that paused inside the orchestrator on the private tier never re-runs the gate, because a resume skips the patterns before the paused one. What stops that run resuming on the Anthropic tier after a flip is core's `tier-changed` refusal (`hitl.server.ts:638-646`; SPEC P5).

**What the person sees: an authorization envelope, not a prediction.** Which route will run, and what its code will read, is not yet known. So the screen authorises the Anthropic tier's processors to receive the listed content and anything later derived from it; it does not claim to show one exact request.

- **The processors**, named from configuration: "Anthropic", and the decisions endpoint's host.
- **The history**: the earlier messages and answers the turn would send, each labelled with its turn. They are computed by the same projection functions the decision state and the synthesizer use, not re-derived.
- **Each file**: its name, type, size and copy time.
  - The preview is labelled "first 2,000 of N characters" and expands to the full text, as text only, with format and bidi characters made visible. The original file can be downloaded.
  - A converted document says that the preview is extracted text and that the model may read the original. A file with no text says "sent whole; no text preview", and its downloadable original is what the person inspects.
  - A file is includable only if the person can inspect it: through its text preview and full text, or, for a file with no text, through its original. If neither can be produced (the read fails, or the file is gone), its checkbox is disabled and it cannot be released.
- **The warning**, in the danger tone and naming the processors: "This conversation holds content produced on the private tier. Continuing sends it to [the processors], outside the private tier."
- The event carries counts only. Everything else is fetched from the manifest (below) by the owner-gated read (SD-13).

**The options.**

- **Send to the Anthropic tier** (danger tone), with one "include this file" checkbox per file, unchecked by default. The checkboxes are the Send option's declared `flags`, one per manifest entry and indexed into it. Core's `invalid-flag` check refuses any flag the request did not declare (`packages/harness-patterns/hitl.server.ts:569-578`), so a client cannot release a file that was not shown. A client-supplied document id is never read.
- **Stay private**: the default, and the option the unattended rule picks (`unattended: 'apply-default'`). It stops the run (`stopsRun`) with "This conversation holds private-tier content. Switch it back to the private tier, or start a new conversation." Nothing is sent, and nothing is recorded, so the next turn asks again.

**The release manifest binds the decision.** Before `askHuman`, the gate writes one immutable, encrypted manifest row holding:

- the owner and the session;
- the turn range of the history shown;
- the sorted `(documentId, versionDigest)` pairs, each with the representation shown: the digest of the original bytes, and of any derived text.

The gate key is the sha256 of the manifest's canonical content. The row is unique on `(owner, session, gate key)`, so a pending retry of the same request reuses its `payloadRef`. It carries `expires_at` equal to the request's expiry, for the sweep, and is purged when the request closes. Until then it is a third store of the file's text (SD-10). Stash documents have no content digest today (`document-store.server.ts:43-60`), so slice 5b computes one when a document is stored.

**The host's `resolve`.** It runs one release service, the same one the gate, hydrate and retrieval consume, and checks before it changes anything:

1. Load the manifest, recompute the gate key, and compare it with the request's; check the owner and the session.
2. Compare each document's current version digest with the manifest's. A document that changed while the request was paused is not released and stays undecided.
3. On **Send**: record the history release on the conversation, up to the manifest's last turn; record `publicTierRelease: { state: 'released', version }` on each checked document; and record `{ state: 'withheld', version }` on each unchecked one.

Hydrate and retrieval honour a release only while the document's current version equals the released one, so a replacement never inherits it. Recording a release must not reset the document's TTL, as `setDocumentFlags` does today (`document-store.server.ts:548-557`). A retry after a partial write or a failed conversation save checks each document again, so only the versions the person reviewed can become released.

**Withdrawing.** The Data Stash panel offers an owner-gated toggle that withdraws a file's release, back to undecided. A released history cannot be recalled, and the panel says so. A withdrawal also marks the conversation's non-private sandbox, `${sessionId}:office:<tier>`, so that its next acquire passes `fresh: true` (`packages/sandbox/with-sandbox.server.ts:9-12`). Otherwise the parked machine would keep the file in `/work/in` for up to an hour, because hydrate never removes a file (`work-artifacts.server.ts:104-108`).

**What it does not cover.**

- **The gateway's raw `redis` tools.** An agent holding them reads any stash key whatever its tag, tier or owner (`scan_keys`, `json_get`). `general` gets the whole catalog (`general.server.ts:59, 69`), and dev compose enables every server (`docker-compose.yaml:124`). Only a deployment that omits the `redis` server holds this exit (`docs/PREVIEW.md:251`); withholding those tools in `agent-withheld-tools.ts` is a separate issue.
- **A private-tier-only server (#653):** the gate never fires there.

**Ship order.** The gate cannot ship before slice 9's client: a pause that no client can answer would stall every flipped turn. Slice 5b therefore ships the tag, the digests, the per-turn tier record and the tiered sandbox id. Until the gate lands with slice 9, a flipped turn never sees a private file, but it still sends the history, as main does today.

**Pins (layer 1)**, each checked by mutation:

- `graph_file_ingest` is refused on a frameless frame, an unrecognised tier and `'anthropic'`, and runs on the private tier, whichever agent calls it, `general` included. Mutation: test `!== 'anthropic'` instead.
- It is refused while the embedding provider is `openrouter`. Mutation: drop the check.
- **The trigger:**
  - On a flipped turn over private-tier content, the gate raises one request before any route runs. Mutation: move the gate after the orchestrator.
  - A frameless frame and an unrecognised tier also fire it. Mutation: test `=== 'anthropic'`.
  - A private file is read, a final reply quotes a synthetic secret from it, the stash copy expires, and a public turn follows: the confirmation comes before any public request. Mutation: trigger on stash enumeration only.
  - A private run raises nothing.
- **The tag and the sandbox:**
  - Without a release, a copy is neither hydrated nor retrieved. Mutations: drop the tag check at hydrate; drop it in the retriever.
  - A private turn hydrates a file, and a flipped turn then finds no such file in `/work/in`. Mutation: keep the sandbox id without the tier.
- **The binding:**
  - A swapped payload, content changed while paused, and a replacement after a release are each not released. Mutations: re-list at `resolve`; skip the version comparison.
  - A pending retry leaves one row and one `payloadRef`.
  - A persistence failure followed by a retry releases only the reviewed versions.
- **The decision:**
  - A release persists, and the next turn does not ask again.
  - An unattended run stays private and records nothing. Mutation: record the default.
  - The warning names the decisions host when `JEV_DECISIONS_URL` is set. Mutation: a fixed "Anthropic".
- **Withdrawal:** release a file, run an Anthropic-tier turn, withdraw, run another Anthropic-tier turn: the file is not in `/work/in`. Mutation: the withdrawal flips the flag only.
- **An untiered turn:** a legacy turn with no recorded tier fires the gate. Mutation: fall back to the conversation's column.
- **Component layer:**
  - the preview labels its truncation and its representation; expanding shows the full text; a binary says "sent whole" and offers its original; the warning renders. Mutations: drop the full-text access; hide the notice; drop the warning;
  - a file whose preview and original are both unavailable cannot be selected or released. Mutation: offer inclusion despite the failed preview.
- **G14:** a synthetic ingested file whose text names a directory member reaches `info-retrieval`'s `plan_context` as a placeholder. Mutation: skip G14's data rewrite.
- **The allowlist:** `general-next`'s **own** office list includes `graph_file_ingest`, not the shared `MICROSOFT_365_TOOLS`, because the `microsoft-365` agent has no retriever (`packages/agents/agents/microsoft-365.server.ts:44-63`). Slice 3's absence pin is removed, and neither the actor prompt nor the route description says ingestion is unavailable (`general-next.server.ts:70, 153`).

Scenarios 15 and 16 stop being gated and become rollout criterion 2's Graph-file variant (G18).

## Writes, gated by a person

Ruled by the owner on 2026-10-16, closing #396 (read-only Cypher by default) in favour of this: `general-next` may write, and **every write waits for the person's approval**. On 2026-10-17 the owner set the bar for the resume: **after an approval the run continues as if it had not stopped**, inside the route that proposed the write, including whatever the agent planned to do after it. **Approval covers Neo4j writes only** (owner, 2026-10-19). Slice 6 (resume inside a route), slice 8 (the gated write) and slice 9 (the UI) build it.

### What is gated

- **Neo4j writes.** No agent can write today: `write_neo4j_cypher` is withheld from every agent (`packages/harness-patterns/agent-withheld-tools.ts:35-45, 67-68`), and the gateway serves `neo4j-cypher` with `read_only: true`. **Both stay.** The agent gets a different tool, a **write request** (working name `cypher_write_request`), whose executor never writes. It checks the statement, stores it, asks the person and returns the `held()` placeholder (`packages/harness-patterns/hitl.server.ts:451-456`). The write runs only in the host's `resolve`, after an approval ([below](#where-the-write-runs-the-hosts-resolve)). So, **for an agent**, a person's answer is the only path to a write session, and the barrier stays structural (SD-14). The app's own UI edit actions already write (`app/src/lib/neo4j/graph-edit.server.ts`, gated per SD-13); they are not agent paths.
- **Microsoft 365 writes: not designed here.** None exist, the #680 barrier refuses them structurally (`app/src/lib/auth/graph-token.server.ts:186-190`), and the consented scopes stay as they are. A Microsoft 365 writer would be a new owner decision and a design of its own.
- **Sandbox promotion: not gated.** Promotion is the owner-scoped `/work` ⇄ Data Stash sync that S-e names as the only way derived files leave the sandbox. It writes into this conversation's stash, never outside our environment, and it already runs in a `finally`, even on a pause (`packages/sandbox/with-sandbox.server.ts:835-841`). Gating it would ask the person about every chart.

### Where the write request lives (H1, accepted 2026-10-19)

**A separate route, `knowledge-edit`**: a `simpleLoop` over the Neo4j read tools plus the write request, guarded on `neo4j`, with `multiToolCalls: 'off'`, no web tools and no pseudonymisation wrapper. Its description: "Change the knowledge graph; every change waits for the person's approval". (H1 called it `graph-edit`; it is renamed because that is already the name of the UI edit module.) Two reasons for a separate route:

1. A write composed in the same loop as `web_search` and `fetch` puts untrusted web text one step from a write. The separate route reads only the graph and the handoff, which is sanitized, fenced and capped.
2. On the private tier `info-retrieval` sees earlier results through G14's rewrite, so a statement composed there can carry `PERSON_3` where a real name belongs. No table is kept, so nothing could turn it back.

### What the request refuses before it asks

Each refusal is a recoverable tool failure with fixed feedback, as G14's egress denials are:

- **A placeholder token** (`PERSON_<n>` with any suffix, matched as a pattern as in E3) anywhere in the statement or parameters: "this is a privacy placeholder, not a real value; ask the person for it". `info-retrieval`'s route output keeps its placeholders (G14), so even the separate route can receive one through the handoff.
- **A guard marker** (a `⟦` provenance fence or a `⟦neutralized:…⟧` marker) in the arguments. A span neutralized upstream must never be written back into the graph, where later reads would serve it as data.
- **Text that would display as something else.** Any statement or parameter string `s` with `s !== s.normalize('NFKC')`, or containing `\p{Cf}`, `\p{Zl}`, `\p{Zp}` or a `\p{Cc}` other than newline and tab. This is what lets the dialog show exactly the text that runs ([below](#what-the-person-sees)).
- **Size.** The statement and its parameters are capped (e.g. 8 KB).
- **A statement Neo4j cannot plan.** The request runs `EXPLAIN` in a **read** session (SD-14); `EXPLAIN` plans and never executes. A planning error goes back to the controller to fix. A pin asserts that a write statement does plan in a read session; if Neo4j refuses that, the slice reports back rather than opening a write session to plan.
- **Any procedure call, and any `CALL { … } IN TRANSACTIONS`**, found in the plan. v1 allows none; a reviewed allowlist of read-only procedures can come later. This keeps every effect of the statement inside the one transaction the executor opens. `apoc.periodic.*` commits batches of its own, which no rollback or marker can undo, and `apoc.cypher.runWrite` / `doIt` carry a write inside a string, so their plan shows one `ProcedureCall` and no delete. `apoc.*` is unrestricted (`docker-compose.yaml:32`), and the Community image (`docker/neo4j/Dockerfile:2`) has no role-based access behind the app's single credential.
- **Not refused: writes to `Member` nodes, allowed behind a warning (owner, 2026-10-19:** _"allow behind warning."_**), and bounded.** G14's directory roster is read from `Member` nodes (`app/src/lib/org-graph/roster-source.server.ts:60-62`), so a write that renamed or deleted members would narrow it silently; only an empty directory fails closed.
  - **When the warning shows.** One pure function computes `touchesDirectory` from the statement and its plan: the statement names `Member`, **and** the plan contains an operator that can change a node (a property set or removal, a label change, a delete, or a create or merge of a `Member` node). A relationship to a member, such as the ontology's ordinary `Knowledge-[:ABOUT]->Member` and `Member-[:AUTHORED]->Knowledge` (`app/src/lib/org-graph/ontology.ts:96-106`), does not show it, so the warning keeps carrying information. `resolve` recomputes the flag from the digest-verified statement, and the dialog reads it from the owner-gated payload read; the request event's copy is display only.
  - **What is allowed.** The directory is always fingerprinted at execution ([below](#where-the-write-runs-the-hosts-resolve)). An unchanged directory commits, whatever the statement named. A changed one commits only if: the request carried the warning; the approver holds `write_org_members` (below); no member's `entraId` changed; and every changed member is among the **declared members** the person was shown (below). Any number of members may change (owner, 2026-10-19: _"multiple is fine, they just need to be listed clearly in the message and warning"_). The ingest `MERGE`s on `entraId` and sets `mail` in the same transaction, and both are unique (`app/src/lib/org-graph/roster-ingest.server.ts:209-223`; `ontology.ts:128-131`), so a changed `entraId` would break the next sync for the whole tenant.
  - **The declared members.** Listing the members means knowing them before approval, which `EXPLAIN` cannot tell. Running the statement to find out would open a write session before approval, which the round-3 reviews refused. So the agent declares them: a statement with `touchesDirectory` requires `members`, the `entraId`s of every member it **may** change or delete. A statement with `touchesDirectory` and no `members` is refused. An empty list is allowed, for a statement that names `Member` but changes only a linked node; then any member change rolls back.
    - **`members` is a reserved key of the statement's `parameters`**, which the statement uses as `$members`. The canonical form sorts and deduplicates it, and a request without `touchesDirectory` carries no `members` key. So the one digest over the canonical `(statement, parameters)` covers the declared set, at raise, at the existing-row comparison and in `resolve`, and the key stays `${digest}:${callKey}`. The execution allowlist is read from those digest-verified parameters, never from the display list.
    - On a new request only, after every other refusal and the role check, the executor looks the declared members up in a **read** session (SD-14). It stores what it found (display name, mail and the other Entra-sourced values) in the payload row as the **member list** shown to the person: a display field, kept apart from the digested ids and never read by execution. A same-call retry reuses the row and its list, and does not look them up again.
    - An `entraId` that matches no member is refused ("unknown directory member"), so an agent cannot create a member: members come from Entra. A failed lookup is a recoverable tool failure and raises no request.
    - At execution the directory diff, keyed by node identity, may touch only the declared members. A change to any other member, or a created one, rolls back, so deleting and recreating an undeclared member reads as a delete plus a create. Which declared members actually change, and to what, is whatever the statement, shown verbatim, does; nothing before execution can say.
    - No write session opens before approval, so the barrier in [What is gated](#what-is-gated) holds without exception, and its source-scan pin keeps its meaning.
    - **Owner rulings (2026-10-19):** listing the members the agent declares, checked at execution, is accepted, with the requirement that it be displayed clearly and ergonomically ([The approval dialogs](#the-approval-dialogs-slice-9)). Creating a `Member` is refused, because members come from Entra (owner: _"correct"_).
  - **The role (owner, 2026-10-19:** _"role write_org_members could be used to grant permission to write to graph"_**).** A request that changes the directory requires its approver to hold the Entra app role `write_org_members`.
    - The app reads no roles today. The sign-in path reads the ID token's `roles` claim and stores it on the session, and every check reads the session server-side, never the client (SD-13, SD-15).
    - The role is checked three times. Before the member lookup, a user without it gets "changing directory members needs the write_org_members role", and nothing runs. In `resolve`, the answering session is checked. At execution, a member diff under a principal without the role rolls back.
    - **Revocation takes effect at that user's next sign-in, at most 8 hours later.** Sessions have a fixed 8-hour lifetime and are not refreshed (`app/src/lib/auth/session-store.server.ts:34, 126-129`). Re-reading the assignment at `resolve` would need a Graph permission the tenant has not consented to.
    - A run with no live session, such as a routine or a trigger, has no role, so it is refused before the lookup. The DEV bypass identity carries no roles (SD-15).
    - Defining the role on the app registration and assigning it is a tenant task outside this repo. Until someone holds it, no directory change commits, which is also the safe default.
    - Other writes keep H2: any allow-listed user, in their own conversation. The ruling's "write to graph" is read as directory (`Member`) writes, the question it answered.
  - **Entra owns these properties.** The next directory sync reverts `displayName`, `mail`, `department` and `jobTitle`, and re-creates a deleted member without its old `AUTHORED`/`ABOUT` edges (`roster-ingest.server.ts:209-223`). The ingest's own header calls removing a departed member a retention decision it must not make silently (`:21-26`). So this path is neither a rectification nor an erasure route: those go through Entra, and SD-11's erasure gap stands.
  - **An audit row.** A write that changed a member, in any ingest-owned property, appends one encrypted, append-only audit row: the principal, the time, the `requestId`, the digest, the statement and its parameters, and the declared members with the `entraId`s the diff shows changed. Deleting the conversation does not remove it. It is kept for 12 months (owner, 2026-10-19), through an `expires_at` on each row and a sweep that deletes expired rows (SD-11).
- **A batch.** `simpleLoop`'s whole-action validation refuses an action that contains a gated name together with any other call, before it dispatches any of them, using slice 6's declared list of gated names. That includes `multiToolCalls: 'off'`, which still runs batches the model was not offered (`simpleLoop.server.ts:263-267`). An executor sees only its own arguments, so it cannot do this.
- **More than three write requests in one turn.** There is no "approve all", and the cap keeps approval from becoming a reflex.

### Raising the request

**The logical call identity.** Each write request is bound to a `callKey`: the sha256 of the run's id (the one `hitl_request` events carry, `packages/harness-patterns/types.ts:1523`), the continuation path to the loop (route label and iteration at each `decisionLoop`, as [recorded for resume](#resume-inside-a-route-slice-6)), the loop's turn number and the call's position in that turn's action. `simpleLoop` computes it before dispatch and records it on the call's `tool_call` event; core exposes it to the executor through the run frame. Every input is durable state of the run, so:

- a retry of the same logical call, in this process or another, recomputes the same `callKey`, because replay rebuilds the same turn counter;
- a later, deliberate identical write sits at another turn or position, so it gets another `callKey`, across a pause, a restart or another host process.

`currentToolCallId()` cannot serve. It is a process-local counter, `call-${++seq}` (`run-frame.server.ts:230-246`), so a restarted process reissues `call-1`. The architecture delta review showed that with two fresh processes: a later identical write was answered by the earlier approval instead of being asked.

The order then matters, because core mints the `requestId` only after the request, including its `payloadRef`, exists (`hitl.server.ts:398-411`):

1. The executor computes `digest`, the sha256 of the canonical JSON of `(statement, parameters)`, with `parameters.members`, when present, sorted and deduplicated.
2. It **binds** the frozen payload to the `callKey` in a **blocking-payload row**: owner, session, `callKey`, digest, statement and parameters (the declared ids among them), plus, for a directory request, the display member list, encrypted at rest, unique on `(owner, session, callKey)`.
   - If no row exists, it inserts one under a fresh `payloadRef`. For a directory request, this insert path alone first runs the role check and the read-session member lookup, and stores the member list in the row. The row is inserted with `expires_at` equal to the request's expiry, in a table the existing expiry sweep covers (`sweepExpiredHitl`, `app/src/lib/db/hitl.server.ts:626-632`), so it is purged on supersede, expiry and abandonment too.
   - If a row exists with the same digest, it reuses that row's `payloadRef`. A same-call retry therefore never allocates a second row.
   - If a row exists with a different digest, the call is refused: a logical call is never rebound to another statement or another declared set.
   - Two concurrent inserts for one `callKey`: the loser's insert conflicts on the unique key, so it re-reads the winning row, reuses its `payloadRef` when the digests match, and refuses otherwise. One row, one request.
   - Rows are never updated. This needs a new writer: today's only payload writer, `putHitlProposal`, writes non-blocking proposals and refuses unless memory is enabled (`app/src/lib/db/hitl.server.ts:254-258`).
3. It calls `askHuman` with:
   - `kind: 'graph-write'`;
   - `key: ${digest}:${callKey}`. Core's default key hashes only the question, the option ids and the summary (`hitl.server.ts:305-316`), and `askHuman` answers a repeated identity from its journal without asking. Two different statements with the same summary would therefore share one identity, and the second would be approved by replay. The digest makes the key cover everything the decision authorises (F8, `types.ts:1524-1525`); the `callKey` separates deliberate repeats from retries of one call;
   - the `payloadRef`; Reject as the default option; `unattended: 'apply-default'`, never `'park'`; and `expiresInMs` of 24 hours.
4. It branches on the outcome. The executor never writes, and never reports a write it did not see in `resolve`.
   - **Pending:** return `held()`. A same-call retry while pending gets core's existing request back, with the same `requestId` and the same `payloadRef` (`hitl.server.ts:386-393`).
   - **Answered Reject**, by replay or by the unattended rule: return "rejected; nothing was written".
   - **Answered Approve**, which only a retry of the same logical call can meet: return "approved earlier; this call wrote nothing". The write, if any, ran in that request's `resolve`.
   - On an answered outcome with **no request ever pending** (the unattended rule), delete the row this call inserted.

### What the person sees

The request event carries display primitives only (`summary` is "display only, and untrusted", `packages/harness-patterns/types.ts:1535-1536`); the statement is in the payload row behind `payloadRef` (`:1537-1538`). The dialog shows:

1. **The statement and its parameters, losslessly**: monospace text nodes with line breaks and whitespace preserved, parameters as canonical JSON. **Not** `displayText`, which normalises NFKC, strips format characters and collapses whitespace (`app/src/lib/memory/display-text.ts:14-22`): `MATCH (n) // inspect only`, a newline, then `DETACH DELETE n` would display on one line with the delete inside the comment. The request-time refusal of characters that display differently is what makes this rendering the exact text that runs. `displayText` stays for labels.
2. **What it does**, from the `EXPLAIN` plan's operators: creates, merges, property sets and removals, deletes and detach-deletes. A plan with a delete gives Approve the danger tone. There are no counts, because counting needs execution. A request with `touchesDirectory` shows its **member list**: every declared member, by display name and mail, with their current directory values. It appears in the message and in the warning, in the danger tone: **"This may change up to N entries in the staff directory that the privacy filter reads: [the names]. A renamed or deleted member is no longer recognised as a person, so their name can reach web searches in clear. The next directory sync from Entra reverts this."** The list is never truncated: a long one scrolls, with the count first. It names the declared members, which is as far as anything before execution can go; which of them actually change is up to the statement ([The approval dialogs](#the-approval-dialogs-slice-9)).
3. **Which route proposed it, and what this turn read first**: counts by untrusted source ("3 web results, 2 mails"), how many Microsoft 365 items, and how many spans the guard neutralized, all computed by code from the run's `tool_result` events and their `sanitized` summaries. And one fixed line: **"What you approve is readable by every user, on either tier."**
4. **Approve** and **Reject.** Reject is the default and the option the unattended rule picks; Approve carries no unattended flag. So a triggered run or a routine never writes. Reject does not stop the run: the loop continues with "rejected; nothing was written", and the agent says so. **If the write already committed** (an earlier resume wrote it and then failed), the dialog says "already applied" and offers a single Continue. Continue sends the default answer, which `resolve` maps to `alreadyApplied`. The dialog learns that state from the owner-gated read by `payloadRef` (SD-13), which reports whether the marker exists.

**No dry run.** Running the statement in a transaction and rolling it back would give real counts. But it would open a write session before anyone approved, on a statement that may have been composed after reading untrusted content. So `EXPLAIN` stays the preview, and directory changes are listed from the members the agent declares, read in a read session. Nothing a person has not approved ever executes.

**Who may approve (H2, accepted 2026-10-19).** Every user reads the same graph. For v1, any allow-listed user may approve a write proposed in their own conversation, the same boundary every other action uses (SD-15). Revisit with roles under Entra SSO (#119).

### Where the write runs: the host's `resolve`

`resumeHarness` calls the host's `resolve(request, answer)` once per answer, after every check and before re-entry. What it returns is recorded, and sanitized it becomes the held result (`packages/harness-patterns/harness.server.ts:368-391`; SPEC resume step 9). Today the host passes one function, the quarantine delete (`app/src/lib/harness-client/turn.server.ts:973-983`). Slice 8 makes it dispatch on `request.kind`. For `graph-write`:

1. **Load and bind.** Load the payload row by `payloadRef`. Refuse, writing nothing, unless its owner is the resuming principal, its session is this conversation, its `callKey` equals the one in the request's `key`, and the sha256 **recomputed** from its statement and parameters, canonicalised as at raise (the declared ids included), equals the key's digest. Recomputing, rather than trusting the row's stored digest, keeps the binding whatever the writer did. For a directory request it also checks that the answering session holds `write_org_members`.
2. **Check the marker first, on every answer, Reject included.** A marker for this `requestId` means the write already committed: return `{ status: 'written', counters, alreadyApplied: true }` from the marker.
3. **Reject** with no marker: `{ status: 'rejected' }`. Nothing is opened.
4. **Approve**: one write transaction, in this order.
   1. Create the marker `(:_HitlWrite { requestId, digest })`. A **uniqueness constraint on `requestId`** makes a concurrent retry of the same request block and then fail, so retries are serialised before the person's statement runs. The losing retry's uniqueness violation is not reported as `failed`: it re-reads the marker and returns `alreadyApplied`, which is the truth.
   2. Fingerprint the **protected sets**, always and whatever the request carried: every `_HitlWrite` marker, and every `Member` node's existence and its five Entra-sourced properties: `entraId`, `displayName`, `mail`, `department` and `jobTitle` (`roster-ingest.server.ts:218-219`). `syncedAt`, the ingest's own timestamp, is left out, because only a count reads it (`:220, 271-276`). The roster reads only `displayName` and `mail`, but a label-less `MATCH (n) SET n.jobTitle = null` would otherwise change every member unwarned, unbounded and unaudited.
   3. Run the statement as its own query, **with the canonical parameters, the exact bytes that were digested** (so a reordered `members` list that hashes the same cannot change `$members[0]` or `size($members)`), and keep **its** summary counters, separate from the marker's.
   4. Fingerprint the protected sets again and diff. The whole transaction rolls back, returning `{ status: 'refused', reason }`, if:
      - any marker changed: "the statement would change the write records". A warning never lifts this;
      - a member changed and the request carried no warning: "the statement changes directory members, which the approval did not show";
      - a member changed and the principal does not hold `write_org_members`: "changing directory members needs the write_org_members role";
      - a member outside the digest-verified `parameters.members` changed, or a member was created: "the statement changes directory members it did not declare";
      - a member's `entraId` changed: "a directory member's id cannot change".

      This is what catches a broad `MATCH (n) DETACH DELETE n` or a dynamic label, which name no label. A later approved deletion can never erase an earlier marker, and the directory never changes beyond the members the person approved.

   5. Store the statement's counters on the marker; if a member changed, append the audit row, with the declared members and the changed `entraId`s, in the host store; then commit. Return `{ status: 'written', counters }`. A Neo4j error returns `{ status: 'failed', error }`; the run continues, and the agent reports it.

Because procedures are refused before the person is asked, every effect of the statement is inside this transaction, so the marker commits or rolls back with all of it. Neo4j's user-defined functions cannot write, so refusing procedures is enough. APOC triggers stay off: `apoc.trigger.enabled` is not set (`docker-compose.yaml:26-32`). A deployment that enabled them would let a trigger write outside this transaction, so keeping them off is a deployment rule. That is what makes the write exactly-once, as Δ4 requires (a later `resolve` throwing makes the retry call every `resolve` again).

- **The marker holds no user content:** the `requestId`, the digest and the counters. The principal and the time are already on the `hitl_response`. Markers are visible to free-form Cypher reads; that is accepted, and readers can ignore the label.
- **Retention.** The payload row is purged when the request closes, by the existing purge after the save (`turn.server.ts:994-1000`), extended to blocking rows, and by the expiry sweep as a backstop, since `closeHitlRows` and `syncAnswerRows` find rows by `requestId` and this row is found by `payloadRef`. The digest and counters stay on the marker; the principal and time stay in the conversation blob.
- The executor is an app-side module and never a `'use server'` export, because it takes an owner (SD-13). A source-scan pin keeps the request tool's module from opening a write session.

**The host protocol is unchanged**: claim, checked resume, version-conditional save and release (`turn.server.ts:886-907, 985-1041`). Under it:

- concurrent retries of one request write once;
- a failure before commit writes nothing, and the retry writes once;
- a commit followed by a failed conversation save leaves the run `paused` (`turn.server.ts:1032-1046`); the retry finds the marker, writes nothing and reports "already applied", and a later Reject also reports "already applied";
- a statement that would change a marker, a member without the warning or without the role, a member's `entraId`, or a member it did not declare, is rolled back;
- **#624:** the wake precedes `resolve` (`turn.server.ts:965-983`), so a wake failure writes nothing, appends a persistent recoverable error and keeps the run `paused` with the answer retryable. A retry is a fresh press; the client never resends an answer on its own.

Each of these is pinned.

### Resume inside a route (slice 6)

The context already holds what a resume needs (ADR-0009):

- at a pause, the paused child's events are committed together with the loop's (`packages/harness-patterns/patterns/decisionLoop.server.ts:549-566`);
- the loop's earlier records are committed events;
- the resume replaces the held result with its outcome.

What core lacks is patterns that read their own progress back. SPEC resume step 11 re-enters the paused top-level pattern "from its start" (`packages/harness-patterns/SPEC.md:2092-2096`). `decisionLoop` then starts with no records (`decisionLoop.server.ts:402`), and `simpleLoop` starts with an empty turn log (`simpleLoop.server.ts:277`).

Slice 6 completes the existing design rather than adding a mechanism. On re-entry, each pattern on the path to the gate rebuilds its state from its own events in the current run, meaning the events since the latest `user_message` (`hitl.server.ts:1126-1131`). It then continues from the next step without calling a model.

- **The continuation is checked before any side effect.** Today `checkResume` compares only the top-level names and index (`hitl.server.ts:667-683`), and `resumeHarness` calls `resolve` before re-entry (`harness.server.ts:431-448`). The architecture review's probe removed the paused route while keeping the top-level orchestrator, and `resolve` still ran. So each request records a **continuation**: the path of resumable patterns from the top-level pattern to the gate (pattern ids, and the route label and iteration at each `decisionLoop`), with a fingerprint of each one's replay-relevant configuration (route names, allowlists, the gated-name list, history recording). Patterns add themselves to it through the run frame as they nest. `checkResume` validates it against the current composition before **any** `resolve`. An absent, changed or non-resumable continuation takes the existing `chain-changed` terminal path. This extends core's top-level check.
- **`decisionLoop`** rebuilds its records, the latest plan (the #692 planner guard reads exactly these, so the rebuild must restore `latestPlan` and the last record's route), the roster inputs and the withheld ids from its own events. It counts the iterations already run against `maxIterations`, makes **no decide call** for the paused iteration, and re-enters that route with the child data the records reproduce.
- **Per-invocation identity** (architecture review §5, addition 1). A route can run twice in one turn under the same child `patternId`, so each child `pattern_enter` carries its `iteration`. Today it carries only the route and the loop id (`decisionLoop.server.ts:473-477`). A paused child's `pattern_exit` says `paused` rather than `completed` (`:560-562`). The paused iteration still writes no record (`:566`), so no stale "waiting" preview reaches the decision state (addition 2). That iteration's stats and record span both halves; its wall time excludes the wait.
- **`simpleLoop`: one projection for every consumed round.** The turn log is rebuilt from every event a round records:
  - `controller_action`;
  - `tool_call` and `tool_result`, with batches grouped by `batchId`;
  - `loop_recovery`, for a parse or allowlist recovery, which consumes a round and leaves controller feedback but no tool event (`simpleLoop.server.ts:447-466`);
  - the reference expansions each turn carries, which later prior-result annotations read (`:205-216`, `:397-401`). Where a round's events do not yet record them, the slice adds them.

  The turn count and the recovery streak are rebuilt with it, against `maxTurns`. **One projection function builds an entry both live and on replay**, so the two cannot drift. Every one of these events obeys `trackHistory` (e.g. `:440-446`), so construction refuses a gated name under a loop configured not to record them. The held call's entry now carries the outcome, so the next controller call sees "written: 3 nodes created". This path is separate from the prior-results path, so `rememberPriorTurns: false` keeps its meaning.

- **The wrappers in between.**
  - `withReferences` replays its recorded selection (the `reference_attached` event, `with-references.server.ts:293`) instead of calling the selector again.
  - `withInjectionGuard` holds no per-invocation state.
  - `withPseudonymisedInputs` rebuilds its roster and its rewrite from the same events. It rewrites the child's own pre-pause results too, so the resumed controller may see a placeholder where it had seen a local result in clear. That is the safe direction. A directory change during the wait can renumber placeholders, which leaks nothing.
- **Not resumable in v1:** `actorCritic`, `withSandbox`, `parallel` and `routes`. The sandbox is the reason that matters. Its machine can be evicted during the wait, and a rebuilt log that says "wrote `/work/tmp/x.py`" would then point at a file that is gone.
  - Each pattern declares a `resumable` capability.
  - Construction refuses a gated tool name in any allowlist whose path from the root is not resumable all the way down. Gated names are a declared list, starting with the write request.
  - A walk of `children` alone cannot see an `askHuman` inside a tool executor (architecture review §5, addition 3). So the check matches allowlist **names**, found through the walk.

**Pins (layer 1)**, each checked by mutation:

- Resume:
  - After an approval, no earlier tool is dispatched again, and no decide call is made for a finished iteration or the paused one. Mutation: decide again on re-entry.
  - The resumed next-controller input equals that of an uninterrupted control run given the same outcome. (The pre-pause input is the wrong reference: it did not contain the held call.) Mutation: rebuild an empty turn log.
  - A recovery, then a read with a reference expansion, then the pause: after resume the turn log, the counters and the expansion annotations match the control run.
  - A loop with history recording off refuses a gated name at construction.
  - Removing or renaming the paused route while keeping the top-level names ends in `chain-changed` with **zero** `resolve` calls. Mutation: drop the continuation check.
  - A route that ran twice in the turn resumes its second invocation, not its first. Mutation: drop `iteration` from `pattern_enter`.
  - The selector is not called on resume. Mutation: call it.
  - A write request under `withSandbox` or `actorCritic` is refused at construction. Mutation: allow it.
  - `maxIterations` and `maxTurns` count across the pause.
  - A plan made before the pause keeps a guarded planner out of the first resumed decision. Mutation: rebuild the records without `latestPlan`.
- The request:
  - Two different statements with identical summaries raise two requests. Mutation: drop the explicit key.
  - Two identical statements in two calls raise two requests, including when the second call runs in a fresh process after a pause. Mutation: key on `currentToolCallId()`.
  - A same-call retry while pending returns the same `requestId` and `payloadRef`, and leaves one payload row. Mutation: insert before looking the `callKey` up.
  - A second statement under an existing `callKey` is refused, and the row is unchanged. Mutation: update the row.
  - An unattended run gets the rejected outcome, with no `held()`, no write and no orphaned payload row.
  - A write request works with memory switched off.
  - A placeholder, a guard marker, a U+200B, a U+FF21, an unplannable statement, an `apoc.periodic.iterate`, an `apoc.cypher.runWrite`, a `CALL { … } IN TRANSACTIONS` and a fourth request in a turn are each refused before any request is raised. Mutations: drop the procedure check; drop the NFKC and format-character check.
  - An `ABOUT` link to a member commits, with no warning and no directory change. Mutation: treat a mention as a change.
  - A user without `write_org_members`, a routine or trigger run, and the DEV bypass identity each cannot raise a directory request, and no lookup runs. Mutation: check the role only in `resolve`.
  - After the role is revoked and the user signs in again, `resolve` refuses. Mutation: check it only at raise.
  - No write session opens before approval: the source scan keeps the request module free of write sessions, and the member lookup uses a read session. Mutation: open a write session in the request module.
  - A `touchesDirectory` statement without `members`, and one with an unknown `entraId`, are each refused before any request. Mutation: allow the unknown id.
  - A same-call retry looks the members up once and reuses the row. Mutation: look them up on every call.
  - A same-call retry with a changed declared set is refused; a declared set altered in the row fails `resolve`'s digest check; two concurrent inserts leave one row and one request. Mutations: digest `(statement, parameters)` without the canonical `members`; trust the row's display list at execution.
  - A warned change to three declared members, approved by a role holder, commits, with all three in the member list, the dialog and the audit row. Mutations: list only the first; skip the audit.
  - A change to an undeclared member, or a created member, rolls back. Mutation: skip the declared-set check.
  - An unwarned, label-less `SET n.jobTitle` rolls back. Mutation: drop `jobTitle` from the fingerprint.
  - A warned `entraId` change rolls back. Mutation: drop the rule.
  - An unwarned member change, including one through a label-less statement, rolls back. Mutation: drop `Member` from the protected sets.
  - A warned statement that deletes a `_HitlWrite` marker still rolls back. Mutation: skip every protected set when warned.
  - A stored `touchesDirectory` that disagrees with the statement does not lift protection. Mutation: read the flag from the request.
  - Component layer: the directory warning renders, and the member list renders in full in the message and the warning, count first. Mutations: drop the warning; truncate the list.
  - A batch containing a write request is refused before any of its calls is dispatched, including under `multiToolCalls: 'off'`. Mutation: leave the check to the executor.
- The dialog (component layer): the line-comment statement renders on two lines, and a parameter `'A  B'` keeps both spaces. Mutation: render through `displayText`.
- The write: each host outcome listed above, with its own mutation (drop the marker check; drop the uniqueness constraint; drop the protected-set check; check the marker on Approve only).

**Layer 2 (app-path e2e)** drives a scripted turn through the real resume path (`POST /api/events` with `mode: 'resume'`, `app/src/routes/api/events.ts:52-60, 110-116`): a read, a proposed write, the pause, an approval, exactly one write, then the loop continuing to a read-back and an answer that names the counts. Variants: a reject; and a save failure after the commit, retried. The Eval can grade the approve and reject turns by answering through `resumeHarness`.

### The injection angle

A write composed after reading untrusted content is the riskiest thing this agent does, and the person is the control. Five things make that control informed rather than decorative:

- the statement is shown exactly as it will run, and text that would display differently is refused;
- its destructive operations are named from the plan, and procedures, which could hide them, are refused;
- the dialog says what untrusted content the turn read, how much of it the guard neutralized, and that every user will be able to read what is written;
- a statement carrying a guard marker or a placeholder never reaches the dialog, and a run with nobody attending never writes;
- at execution the markers are protected whatever the statement says, and the directory changes only as listed to, and approved by, a holder of `write_org_members`, never in an `entraId`.

What it does not catch: a plausible but harmful statement that the person approves. The dialog turns that into a reading task; it does not guarantee anything.

### The approval dialogs (slice 9)

None of this has a client yet. `HitlDialog` renders memory proposals only (`app/src/components/ark-ui/HitlDialog.tsx:82-84`), and no client code sends a resume. The owner's requirement (2026-10-19): _"We will need to ensure that HITL info is displayed clearly and ergonomically."_ This section is the design; the house rules are the `kg-dtalk-ui` skill and its accessibility checklist.

**One shell, one body per kind.** `HitlDialog` (#589) stays the only confirmation component. It chooses its body by `kind`: today's `memory.confirm`, and the two below, `graph-write` and `private-content-release`. The shell:

- **Ark UI primitives.** `Dialog` (`Root`, `Backdrop`, `Positioner`, `Content`, `Title`, `Description`, `CloseTrigger`); `ScrollArea` for every bounded region; `Collapsible` for expansion; `Checkbox` with its `Label` for per-file inclusion. All of these are already in the app. No native replacements.
- **The layout.** The content is at most `48rem` wide and `90vh` tall, wider than the memory body, because statements are code. Three areas stay fixed and one scrolls:
  - the header (title and expiry);
  - the **compact warning** (one or two sentences with the count) in a sticky band below the header, outside the body's scroller, capped at about a third of the dialog's height so that, at 200% zoom or on a small viewport, it can never cover the statement or a focused control (`focus-not-obscured`);
  - the footer (the actions);
  - the body, which scrolls and holds everything long: the member table, the statement, history and files.
- **One order for every kind:**
  1. the title, a plain question;
  2. the **warning**, if there is one;
  3. a one-line summary with counts;
  4. the details;
  5. what this turn read;
  6. the actions.

  The compact warning stays visible because it sits outside the scroller, not because of its position. `Dialog.Description` references the compact warning and the summary only, so opening the dialog never reads out a whole table.

- **The danger tone** is the `ui-danger` role only, because there is no warning token yet (`kg-dtalk-ui` §4: no new tokens on the proposal table's authority).
  - A warning is a region with a `ui-danger` left border, a `ui-danger/10` fill, the `i-material-symbols-warning-outline` glyph and the visible word "Warning". Hue never carries the meaning alone (`color-not-only`).
  - The danger action is styled the same way (border, text and tint in `ui-danger`), never as `cyber-button`, which is reserved for a safe primary action.
- **Light and dark.** Only `ui-*` roles, so the palette flips and the component does not. Statements and previews sit on `--ui-code-bg`, which both palettes define (`app/uno.config.ts:244, 278`). No `dark:` variants and no literal hexes.
- **Keyboard and screen readers.**
  - Ark's dialog traps focus. **Initial focus goes to the safe action** (Reject / Stay private), never to the danger one, so Enter on open decides nothing harmful.
  - Escape, the close button and the backdrop all close the dialog and **decide nothing**: the request stays pending, as today.
  - Tab order follows visual order. Every control is a `<button>`, an Ark `Checkbox` or an Ark `Collapsible` trigger, which carries `aria-expanded`.
  - Focus rings use `ring="2 transparent focus:ui-accent/40"` (`focus-appearance`), and every target is at least 24×24 px.
  - The member list is a real `<table>`, with a `<caption>` and `scope` headers, so a screen reader can move by row and column.
- **Untrusted text.** Every string that came from content, a model or the graph is rendered as a text node, never as markup. **Every such label also makes format and bidi characters visible** (e.g. `⟨U+202E⟩`) instead of applying them: filenames, which are the checkbox labels, member names, mail, departments and job titles, processor names, history labels and previews. So `invoice⟨U+202E⟩fdp.exe` cannot display as `invoiceexe.pdf`. `displayText` is not used for these, because silently removing a character hides it. A statement cannot contain such characters at all, because the request refuses them.
- **Truncation is visual, never hidden.** A bounded region scrolls, but everything it holds is in the DOM and read in full by a screen reader. Where text is cut, the cut is labelled ("first 2,000 of 18,400 characters"), and expanding fetches the rest through the owner-gated read.
- **Live arrival.** When a request arrives, one `aria-live="polite"` region announces it ("Approval needed: a change to the knowledge graph"), without moving focus (`contextual-live-badge-updates`). Then the transcript card and the inbox entry each offer **Review**, which opens the dialog.

#### `graph-write`

```
┌ Change the knowledge graph? ───────────────────── expires in 23 h ─ [×] ┐
│ ▌⚠ Warning: this may change up to 3 staff-directory entries that the    │ ← sticky
│ ▌ privacy filter reads. The next Entra sync reverts it.                 │   band
├─────────────────────────────────────────────────────────────────────────┤
│ Statement-wide: [sets m.jobTitle]                                       │ ↑
│ ┌ Members this statement may change or delete (3 declared) ─────────┐  │ │
│ │ Name         Mail                  Department  Job title          │  │ │
│ │ Ada Example  ada@example.com       Research    Analyst            │  │ │
│ │ Ben Example  ben@example.com       Research    Lead               │  │ │ body
│ │ Cy Example   cy@example.com        Sales       Advisor            │  │ │ scrolls
│ └─────────────────────────────────────────────────── all rows ──────┘  │ │
│ A renamed or deleted member is no longer recognised as a person, so    │ │
│ their name can reach web searches in clear.                            │ │
│ ┌ Statement, exactly as it will run ────────────────────────────────┐  │ │
│ │ 1  MATCH (m:Member) WHERE m.entraId IN $members                   │  │ │
│ │ 2  SET m.jobTitle = $title                                        │  │ │
│ └───────────────────────────────────────────────────────────────────┘  │ │
│ ┌ Parameters ───────────────────────────────────────────────────────┐  │ │
│ │ { "members": ["…", "…", "…"], "title": "Senior analyst" }         │  │ │
│ └───────────────────────────────────────────────────────────────────┘  │ │
│ Proposed by knowledge-edit. Before proposing it, this turn read:        │ │
│ 3 web results · 2 mails · 1 neutralized instruction.                    │ │
│ What you approve is readable by every user, on either tier.             │ ↓
├─────────────────────────────────────────────────────────────────────────┤
│                                   [ Reject ]  [ ⚠ Approve this change ] │
└─────────────────────────────────────────────────────────────────────────┘
```

- **The order.** The compact directory warning, in the sticky band, only when `touchesDirectory` is set; then the statement-wide operations, the member table, the full warning text, the statement and the parameters, and the provenance.
- **The member table lists the declared members**, which is what both the message and the warning name: "members this statement may change or delete". It shows each one's name, mail, department and job title, i.e. the current values from the read-session lookup. It has **no per-row operation and no affected count**. The plan's operators are statement-wide, so before execution nothing can say which declared member is set, deleted or left alone (a filter such as `AND m.department = $d` may touch only some). The count is the declared count, worded "up to N". An empty declaration says "no directory member may change".
- **One row per verified id.** The table renders one row for each `entraId` in the digest-verified `parameters.members`, filled from the display list by `entraId`. A missing or extra display entry shows as an error row, and Approve stays disabled, so the names the person reads cannot drift from the ids that execute.
- **What the statement does** is shown statement-wide only, as R4 chips with the `SET` targets read from the plan's details (`sets m.jobTitle`, `deletes`, `removes m.department`), with `deletes` in `ui-danger`. The statement below is the authority, as the owner accepted (2026-10-19).
- **The statement** is shown in full, with line numbers, so a soft wrap is never mistaken for a line break, which is the comment-hiding case. It is never collapsed: it is what is approved. Its region scrolls beyond about 20 lines. The parameters follow as canonical JSON.
- **The Approve label names the kind of action without a count**: "Approve this change", or "Approve a change that deletes" when the plan deletes.
- **The "already applied" state** replaces the body with "This change was already written" and its counts, and offers a single **Continue**, which sends the default answer.
- **Without the warning**, the table and the warning are absent; the rest is the same.

#### `private-content-release`

```
┌ Send this conversation to the Anthropic tier? ─── expires in 23 h ─ [×] ┐
│ ▌⚠ Warning                                                              │
│ ▌ This conversation holds content produced on the private tier.         │
│ ▌ Continuing sends it to Anthropic and decisions.example.com, outside   │
│ ▌ the private tier.                                                     │
│ 4 earlier turns · 2 files copied on the private tier                    │
│ ▸ Earlier turns (4)                                                     │
│   Turn 3 · you: "Summarise the Lantern brief"            [Show full]    │
│   Turn 3 · answer: "The brief proposes…" (first 300 of 1,950) [Show]    │
│   …                                                                     │
│ Files                                                                   │
│ ┌──────────────────────────────────────────────────────────────────────┐│
│ │ ☐ Include  lantern-brief.docx · Word · 48 KB · copied 10:14          ││
│ │   Extracted text; the model may read the original file.              ││
│ │   ┌ first 2,000 of 18,400 characters ──────────────────────────┐     ││
│ │   │ Lantern brief. Scope: …                                    │     ││
│ │   └────────────────────────────────────────────────────────────┘     ││
│ │   [ Show full text ]  [ Download original ]                          ││
│ ├──────────────────────────────────────────────────────────────────────┤│
│ │ ☐ Include  budget.xlsx · Excel · 22 KB · copied 10:16                ││
│ │   Sent whole; no text preview.  [ Download original ]                ││
│ ├──────────────────────────────────────────────────────────────────────┤│
│ │ ⊘ notes.pdf: cannot be shown, so it cannot be included.              ││
│ └──────────────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────────────┤
│                     [ Stay private ]  [ ⚠ Send history and 1 file ]     │
└─────────────────────────────────────────────────────────────────────────┘
```

- **The order.** The warning names the processors, computed from configuration. Then the summary counts, then the history, then the files.
- **History.**
  - It is an Ark `Collapsible`, closed by default. Its trigger states the count, so it is never empty or silent.
  - Each turn shows the person's message and the answer, labelled with the turn number. A long entry shows its first 300 characters, with "Show full" expanding it in place.
- **Files.** One card per file.
  - Each card has an Ark `Checkbox`, unchecked by default, whose label is the filename.
  - It shows the type, size and copy time, and the representation notice: "extracted text" for a converted file, "sent whole; no text preview" for a binary.
  - The preview region is labelled with its cut ("first 2,000 of N characters"). **Show full text** expands it in place, through the owner-gated read.
  - **Download original** is a programmatic download anchor, which stays in the tab (`kg-dtalk-ui` §6).
  - A file that cannot be inspected shows ⊘ and the reason, in a card with no checkbox.
- **The actions.** "Stay private" is the safe default and has initial focus. The danger action's label counts what it sends ("Send history and 1 file", or "Send history only"), so the press states exactly what goes.
- **Withdrawal** lives in the Data Stash panel, not in this dialog: a per-file toggle, with the line "a released history cannot be recalled".

**The controller and its states.** The shell stays presentational, as today (`HitlDialog` takes props; `MemoryProposalPrompt` owns selection, busy state and the bound answer). A blocking-request controller is added beside the memory one, and memory's non-blocking answer path is unchanged.

- It reads one discriminated view per request, `{ kind, requestId, … }`, through the owner-gated payload read.
- It answers with `{ [requestId]: { choice, flags } }` only. Core accepts a choice and declared flags, never a principal or a resolution from the browser (`packages/harness-patterns/types.ts:1623-1632`; `hitl.server.ts:565-591`).
- Its states:
  - **loading**: Approve disabled;
  - **read failed**: an error beside the body, Approve never enabled, and a Retry;
  - **submitting**: both actions disabled from the first press until the outcome arrives, as today's `busy` (`HitlDialog.tsx:169, 184`);
  - **bound**: an answer already recorded, shown as such;
  - **expired** and **superseded**: the dialog says so and offers only Close;
  - **already applied**: as above.
- On supersede, on expiry, or on an answer from another tab, an open dialog refreshes through the owner-gated read instead of keeping a live Approve. The server stays the guarantee.
- **Several pending requests.** Core requires every pending request of a run to be answered in one resume. So the controller shows them one after another, collects the answers, and sends a single resume when the last is answered. The transcript card counts them ("2 approvals needed").

**Pins (component layer; browser layer for focus, Escape and layout):**

- The warning renders before the details, and `Dialog.Description` references it.
- Initial focus is on the safe action. Mutation: focus the danger action.
- Escape and the backdrop decide nothing.
- The member table renders every declared row, with a caption and header scopes. Mutation: render only the first rows.
- A statement that sets one declared member and deletes another renders no per-member operation and no count. Mutation: derive a per-row operation.
- Three declared ids with `AND m.department = $department`: the table and the count stay labelled as declared ("may change up to 3"), with no predicted matching subset and no definite affected count. Mutation: present the declaration as the exact affected set or count.
- A display list that drifts from `parameters.members` (a missing, extra or different entry) disables Approve. Mutation: render the display list as stored.
- A filename containing U+202E renders the visible escape. Mutation: render the raw label.
- With 200 members and a 60-line statement, at 200% zoom, the compact warning stays visible and no focused control is covered (browser layer). Mutation: put the warning inside the scroller.
- Both actions are disabled from the first press until the outcome arrives; a superseded request refreshes to Close only.
- The statement keeps its line breaks and numbers its lines. Mutation: render through `displayText`.
- A cut preview states its cut, and **Show full text** fetches the rest.
- An uninspectable file has no checkbox.
- The danger action's label counts the files it sends.
- Neither palette uses a literal hex. The existing `theme-migration` test already fails on a `dark-*` token under `src/components`.

**Also in slice 9:**

- the transcript card for a paused turn, with **Review** and the expiry;
- pending blocking requests in the inbox, beside proposals;
- the client resume over the existing SSE path, sent only on the person's press;
- the owner-gated read of a payload by `payloadRef`: a `'use server'` read, gated like every other one and taking no owner argument (SD-13).

A new message sent while a request waits supersedes it (`continueSession`), and the card says so.

## Data between routes

- **Files** move through the stash: `graph_file_ingest` → stash → `/work/in`, within the same entry since N4. Those are real bytes (security review §5). P4 keeps them real and protects the exits instead ([The file path (P4)](#the-file-path-p4)).
- **Results that are not files.** Under round 1's option (c), as ruled, these reach the sandbox by being materialised into `/work/in/turn/` on entry. This shape narrows (c) to the **handoff**: only the last N route outputs are materialised, the same records the child already sees in `plan_context`, not every tool result of the turn. That settles round 1's "every result, or only referenced ones" question without a `ref:` argument, since routes take no arguments.

  It is **deferred**: neither the file path nor scenarios 15/16 need it. P4's ruling does not enable it. It keeps both review conditions:
  - the materialised files are wiped on entry **and** on exit;
  - promotion skips any `/work/out` file whose hash matches a materialised one.

  Security review §6 asked for an option with no boolean form, so that "on without P4" could not be written; it proposed a pseudonymiser-valued option. P4 now keeps no pseudonymiser on the file path, so the option's form is settled when materialisation is designed. Neither a boolean nor an env var may switch it on.

## Synthesis

The top-level `compactExecution` in `thread` mode reads loop history through `view.fromLastPattern()` (`compactExecution.server.ts:82-83`). Under this shape the last pattern to enter is the last **child**, not `orchestrator`, so synthesis would silently drop to `response` mode. This is round 1's architecture finding 1, which still applies here.

The fix is small and stated as a slice item: `thread` mode honours `viewConfig.fromPatterns` when it is set, instead of `fromLastPattern()`, and is pinned on exactly this nesting. With `fromPatterns: ['orchestrator']`, the synthesizer reads the route-output records, which is the owner's "view on the last N pattern outputs". It does not read the children's internal traces. The records of this turn and the previous one are read (`threadTurns: 2`, #507 W4) so a follow-up keeps what was found; an earlier turn's failed or withheld record is dropped, since nothing would mark it old, and the user's message is read past the scope.

## Preconditions the design owes

- **P1 — Pause and resume.** A resume re-runs the paused top-level pattern from its start (SPEC). Here, that means `decisionLoop` from iteration 1, re-running earlier routes.
  - **Settled by the owner on 2026-10-17:** an approved run continues as if it had not stopped. Slice 6 makes `decisionLoop`, `simpleLoop` and the wrappers between them rebuild their state from their own events in the current run, as [Resume inside a route](#resume-inside-a-route-slice-6) specifies. This completes ADR-0009's resume rather than adding a second mechanism.
  - Until slices 6, 8 and 9 land, the round-1 rule stays: no gated tool inside any route, pinned by allowlist names rather than a `children` walk (architecture review §5.3). Afterwards the pin narrows to "no gated tool under a pattern that is not resumable".
  - No production code pauses today.
- **P2 — The stuck-run reaper.** Its 25-call bound assumes one loop per turn. This shape is up to 6 iterations of up to 15-call children. Arithmetic: 6 × 15 + 6 decisions + 1 synthesis = 97. The architecture review's fix applies unchanged: reap on a dead turn lease, with an age backstop. Ruled A1 in [G12](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323): the age bound is a named constant with its justification beside it.
- **P3 — The injection boundary.** As stated in [the guards section](#where-memory-guards-and-the-sandbox-sit), plus **G13 landed, with its evidence**: no egress from Neo4j, and `file://` closed. [G13](https://github.com/mknw/hames-playground/issues/241#issuecomment-6181475778) replaces the historical [G12 S-a](https://github.com/mknw/hames-playground/issues/507#issuecomment-6143165323) procedure allow-list dependency; free-form Cypher stays. In both compose files, Neo4j must be isolated on its internal network behind the relay, file-URL CSV imports disabled, and APOC file imports off. The G13 implementation PR must carry the specified throwaway-project evidence: public `apoc.load.json` and gateway `apoc.load.jsonParams` POST fail from Neo4j; Redis and Postgres are unreachable; host and gateway Bolt through the relay work; dropping `internal: true` or reconnecting Neo4j to `app-network` makes the egress test fail. These are dependency evidence requirements, not checks run by this docs PR. Historical residual wording: **`LOAD CSV` survives the allow-list**; that network/file-read exposure is closed by G13, rather than left as an allow-list residual. The surviving risk is in `info_ag`: graph rows and untrusted web text share a loop with a model-chosen `fetch` URL or `web_search` query. The guard reduces this risk but cannot stop every paraphrased instruction; Neo4j isolation does not constrain those app-side web calls.
- **P4 — The file path. Ruled by the owner on 2026-10-19**, specified in [The file path (P4)](#the-file-path-p4). It answers `graph-pseudonymisation.md`'s questions for this path:
  - **Q1, the hook:** the exits rather than the bytes;
  - **Q2, the store:** the stash copy unchanged;
  - **Q3, the table:** none;
  - **Q5, a stable pseudonym:** not applicable;
  - plus the private-tier-only tool and the accepted limitation for people named only inside a file's body.

  A tier flip is ruled too (owner, 2026-10-19): before an Anthropic-tier turn sends private-tier content, a confirmation screen shows the data that would go to the Anthropic tier's processors, with a warning ([below](#a-tier-flip-mid-conversation-owner-2026-10-19)). It covers the conversation's history as well as the files (owner, 2026-10-19). The tool's own checks close a live gap in `general` and ship first (slice 5a); `graph_file_ingest` stays out of `general-next` until slice 5b. Materialisation of results that are not files is not part of P4 and stays deferred ([Data between routes](#data-between-routes)).

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
- **Writes (owner, 2026-10-16 and 2026-10-17).** #396 is closed: writes are gated by a person, not prevented by read-only defaults. After an approval the run continues inside the route as if it had not stopped. Designed in [Writes, gated by a person](#writes-gated-by-a-person). On 2026-10-19 the owner accepted H1 (a separate route, named `knowledge-edit` here) and H2 (any allow-listed user approves writes proposed in their own conversation), and limited approval to Neo4j writes. Writes to `Member` nodes are allowed behind a warning (owner, 2026-10-19), with any number of members, each listed in the message and the warning, `entraId` immutable, audited for 12 months, and approval requiring the Entra app role `write_org_members`. Declared members are accepted, displayed "clearly and ergonomically", and creating a `Member` is refused. The rulings are recorded at [#682](https://github.com/mknw/hames-playground/pull/682#issuecomment-6269324396) and on #693.
- **P4 (owner, 2026-10-19), the file path.** It is protected at its exits, not by rewriting bytes; the stash copy is unchanged and no table is kept; the tool runs only on a positively private tier; people named only inside a file's body are an accepted limitation. This settles S-f as G14 reads it. Recorded on [PR #682](https://github.com/mknw/hames-playground/pull/682#issuecomment-6256235215). A tier flip shows a confirmation screen with the data that would be transferred to Anthropic, with a warning ([record](https://github.com/mknw/hames-playground/pull/682#issuecomment-6269324396)). "Anthropic" is read as the Anthropic tier's processors, the decisions endpoint included. It covers the conversation's history as well as the files. Designed in [The file path (P4)](#the-file-path-p4).

The round-1 reviewers' terms (architecture 6068693140, security 6068708025) bind the delta review. Nothing is built before that review converges.

## Later: directed-graph utilities

The owner named a later step: utilities that instantiate loops, agents, harnesses and orchestrators from a directed graph (cycles allowed). `decisionLoop` is the first concrete node type such a graph would need: a node whose outgoing edges are chosen by a decision. The route-output record is the edge payload, and the planner's agent map is the graph rendered as text, so the DG layer should generate that map rather than sit beside a second description of the same agent. Designing the DG layer waits until this agent has run.

## Rollout

Ship as a new agent beside `general` (working id `general-next`). It replaces `general` when:

> **Update, 2026-10-21:** the owner removed `general` before this gate closed (the default agent is still `search`). `general` no longer runs, so criterion 1 is measured against its **recorded** last live results (`app/src/lib/eval-support/general-baseline.ts`), not a paired run; a stored `general` id resolves to `general-next`. Criteria 2 to 5 are unchanged.

1. an eval scenario shows no regression on `general`'s current cases, on the private tier only (owner amendment, 2026-10-15; #507 W4);
2. a synthetic fetch → read back → compute request passes;
3. P2, P3 (G13 landed with its evidence) and P5 (G11 deletion/client migration first) are met;
4. P1 is met, or "no gates in routes" is pinned. A write request enters an allowlist only with slices 6, 8 and 9;
5. the M7 memory opt-in moves with it;
6. until slice 5b lands, `graph_file_ingest` is absent from `general-next` by name and its file path stays off. With 5a and 5b it is present, behind the tool's private-tier and embedder checks and their pins. No turn-results materialisation capability is declared either way.

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
5. **The Graph file path (P4)**, as [specified](#the-file-path-p4), in two parts:
   - **5a, first, before anything else in this doc**: the host-injected private-tier predicate and the `openrouter` refusal in `graph_file_ingest`'s executor. It closes the live gap in `general`, and its pins cover every caller.
   - **5b**: `graph_file_ingest` in `general-next`'s own office list (not the shared `MICROSOFT_365_TOOLS`); the `graph-file` provenance tag and the `privateTier` flag on documents promoted on a private-tier turn; a content digest computed at store time; each turn's recorded tier; the tier in the `office` sandbox id; hydrate and retrieval skipping unreleased copies; the actor prompt and the route description updated; the remaining pins listed there (layer 1); scenarios 15/16 ungated in the Eval.

   N4 is already built (slice 4). **Materialisation** of results that are not files is not part of this slice and stays deferred. When it is designed, its conditions still bind: no boolean or env-var switch (pinned by source scan), wipes on entry and exit, the verbatim-hash promotion block, and a materialiser that never reads `content_sanitized` data (pinned with slice 1's two-event fixture).

6. **Resume inside a route** (P1), in core, as [specified](#resume-inside-a-route-slice-6):
   - the continuation recorded on each request, validated by `checkResume` before any `resolve`, with `chain-changed` on any mismatch;
   - `decisionLoop`, `simpleLoop` and the wrappers between them rebuild their state from their own events in the current run, `simpleLoop` through one projection shared by the live and replay paths and covering recoveries and expansions;
   - `iteration` on each child `pattern_enter`, and `paused` on a paused child's `pattern_exit`;
   - the `resumable` capability and the declared list of gated names; construction refuses a gated name under a pattern that is not resumable or that does not record history; `simpleLoop` refuses a batch containing a gated name before dispatch.

   The pins listed there belong to layer 1; the scripted turns belong to layer 2. SPEC and GUIDE gain nested resume and the new capability, and the slice declares its package version intent.

7. **The web-route pseudonymisation guard ([G14](https://github.com/mknw/hames-playground/issues/507#issuecomment-6191473862)).** `withPseudonymisedInputs` (rewriting the view and the child's plan/handoff data) and the `callTool` outgoing check on a new concatenating `egressChecks` run-frame slot, in core; `decisionLoop` passing the handoff's source payloads as roster input; `AgentDeps.pseudonymiseForWeb` built by the app's `createWebPseudonymiser` from `lib/privacy/`; the `egress-wiring` tripwire **narrowed** to that one import site, not deleted, with Q1–Q3 stated in the commit as in [the section](#pseudonymisation-guard-on-the-web-route). The pins listed there belong to layer 1. On the private tier, slice 3's `info_ag` ships only with this guard in place.
8. **The gated Neo4j write**, after slice 6:
   - the write request tool and its refusals (placeholder, guard marker, characters that display differently, size, an unplannable statement, procedures and `IN TRANSACTIONS`, more than three per turn); the `touchesDirectory` function, recomputed in `resolve`; the always-on directory fingerprint over every ingest-owned property, with immutable `entraId`; the reserved `members` parameter, its read-session lookup on insert, and the declared-set check at execution; the `write_org_members` role read at sign-in and checked at raise, `resolve` and execution; the directory audit row, with `expires_at` and its sweep;
   - the logical `callKey` computed and recorded by `simpleLoop`, the request's explicit key, and the pending / answered branch;
   - the blocking-payload writer (bound to the `callKey`, insert-only, encrypted, not gated on memory, with `expires_at`) and its purge on close;
   - the host's `resolve` dispatching on `request.kind`: the binding checks, the marker checked on every answer, and the write transaction with the marker's uniqueness constraint and the protected-set check;
   - the `knowledge-edit` route (H1), with `multiToolCalls: 'off'`;
   - `write_neo4j_cypher` still withheld and the gateway still read-only, each pinned;
   - the host outcomes listed in [Where the write runs](#where-the-write-runs-the-hosts-resolve), at layers 1 and 2.
9. **The UI for blocking requests**, as designed in [The approval dialogs](#the-approval-dialogs-slice-9), which can be built alongside slice 8: the transcript card with the expiry, the `graph-write` dialog body with the lossless statement, its directory warning and its "already applied" state, the `private-content-release` body, inbox entries, the client resume sent only on a press, and the owner-gated read of the frozen statement. With it lands the `privateContentRelease` gate: the manifest, the release service shared by the gate, `resolve`, hydrate and retrieval, and the versioned `publicTierRelease` record, with the pins in [P4](#a-tier-flip-mid-conversation-owner-2026-10-19). Its UI checks belong to the component and browser layers.

## See also

- #507: the diagnosis, both round-1 reviews, and this round's calls and their rulings (G12).
- #418 G11 (the decisions client) · #419 (memory) · #241 (Neo4j) · #446 (the reaper) · ADR-0005 · ADR-0009
- [`decide-document-context.md`](decide-document-context.md) (what the decide step is told about the conversation's documents; decided design, not built)
- [`sandbox.md`](sandbox.md) · [`graph-pseudonymisation.md`](graph-pseudonymisation.md) · [`packages/harness-patterns/SPEC.md`](../../packages/harness-patterns/SPEC.md)
