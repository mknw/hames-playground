# General Agent as a Decision Loop (Plan)

> **Status: design, not built. Round 2.** This replaces round 1's "patternTool inside a `simpleLoop`" core. Round 1 is in git history as `docs/plan/pattern-tools.md`; its two reviews are on [#507](https://github.com/mknw/hames-playground/issues/507). The shape below is the owner's (2026-10-13). This doc says how it works, what each piece sees, and what it still owes. Nothing is dispatched until the owner signs off. The owner calls that remain are on #507, not repeated here.

## The problem, in one paragraph

An agent's topology is fixed when it is built, and today's `general` is `planner → simpleLoop → compactExecution` over every tool. #507 is a request whose plan needed three steps: fetch a file, read it back, then compute over it. `general` could only do the first. It has no way to read the stash and no sandbox, so the plan described an agent that did not exist. The fix is to let one turn move between groups of capabilities, choosing the next group after seeing what the last one produced.

## The shape

```typescript
const doc_ag = withInjectionGuard(DOC_GUARD)(                      // office + data work
  withSandbox({ id: `${sessionId}:office`, rootfs: 'office', egress: 'mcp-only', syncWorkspace: true })(
    actorCritic(actor, critic, MS365_TOOLS, { patternId: 'doc', … }),
  ),
)
const info_ag = withInjectionGuard(INFO_GUARD)(                    // knowledge lookups
  simpleLoop(createLoopControllerAdapter(), [...NEO4J_READ, ...WEB], { patternId: 'info', returnStyle: 'answer' }),
)
const retrieve = retriever({ backends: [redis], patternId: 'retrieve' })   // the Data Stash
const think = planner(createPlannerAdapter(…), PLANNABLE_TOOLS, { patternId: 'think' })

const orchestrator = decisionLoop(
  {
    'office-data': { pattern: doc_ag, description: 'Work on Microsoft 365 files and mail; run code over them' },
    'info-retrieval': { pattern: info_ag, description: 'Look things up in the knowledge graph or on the web' },
    'read-documents': { pattern: retrieve, description: 'Search documents already in this conversation' },
    think: { pattern: think, description: 'Decide the steps before acting' },
  },
  { decide, done: 'Enough has been done to answer', handoff: { lastN: 2 }, maxIterations: 6, patternId: 'orchestrator' },
)

agent = withMemory(deps.memory)([orchestrator, compactExecution({ mode: 'thread', patternId: 'response-synth', viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 } })])
```

There are three differences from the owner's sketch, each argued below:

- the retriever is its own route rather than a tool inside `info_ag` (see [Routes](#routes-and-how-tools-are-grouped));
- `doc_ag` takes the sketch's second form (see [Sandbox](#where-memory-guards-and-the-sandbox-sit));
- `skip_to_synthesizer` is a terminal choice, `done`, not a route that runs the synthesizer (see [Done](#done)).

## The new piece: `decisionLoop`

This is the one new pattern. It is a loop over `routes` in which a **decisions model** picks the next route each time round. One iteration:

1. **Build the state** (below) and ask one `choice` question: "Which step should run next?" The options are the route names plus `done`, each with its description. The model answers one label, with its probability. It submits no arguments.
2. **If `done`**, stop. The top-level synthesizer runs next.
3. **Otherwise run that route's pattern** in a child scope, given the task described below.
4. **Record what the route produced** as a route output (below), then go to 1.

The decision is a plain `choice` through the existing `decide()` path. It reuses `decisionRouter`'s machinery (`typedDecision.server.ts:1452-1540`): labels from route descriptions, one `decision_made` event per decision, and `data.decisions[key]`. What is new is only the loop around it and a custom `state`.

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
1. info-retrieval — done
2. think — done
3. read-documents — failed: no documents matched

Latest results (most recent last):
[think] Plan: 1) find the spreadsheet … 2) …
[read-documents] failed: no documents matched. Reason: …
```

- **The conversation window** is `routerTurnWindow` turns, the same as `decisionRouter`'s default.
- **"This turn so far"** lists **every** iteration of this turn in one line each: route and status. This is what lets the model see that it is going round in circles.
- **"Latest results"** shows the **last N** route outputs in full (result + reasoning, below).
- **Trimming.** The whole block is trimmed oldest-first to the decide window, as the default state is.
- **What is left out.** The route descriptions are not in the state: they are the question's options. Memory is not in the state either (see [Memory](#where-memory-guards-and-the-sandbox-sit)).

Route outputs are untrusted: they carry what the agents read on the web or in mail. They enter the state only as **sanitized** text (see [When a route fails and other boundaries](#untrusted-content-on-the-way-up)), fenced by the guard's spotlight.

### What a route's agent receives as its task

The router passes no arguments, so a child gets:

- **its instruction: the user's latest message.** `decisionLoop` leaves `data.intent` unset, so `simpleLoop` and `actorCritic` fall back to the last user message, as they already do (`simpleLoop.server.ts:381`, `actorCritic.server.ts:293`). The retriever already searches with that message.
- **its context: the existing `plan_context` channel.** `decisionLoop` writes the child's `data.plan` as two blocks: the latest `think` plan, if there is one, and the last N route outputs. `simpleLoop` and `actorCritic` already render `data.plan` as the controller's `plan_context` (`simpleLoop.server.ts:322`, `actorCritic.server.ts:139`; planner contract `planner.server.ts:20-29`). So no BAML signature changes.

The child's `data` is built fresh: the plan block plus what the child pattern needs. It **excludes** `memories` and `memoryContext` (security review §4). **Nothing the child writes to `data` flows back** (architecture review §2). Only the route output does.

### "Last N route outputs", and where N lives

N is `handoff.lastN` on `decisionLoop`'s config, default 2. It counts **iterations of this loop in this turn**, not patterns. The existing `ViewConfig.fromLastN` counts distinct pattern ids (`event-view.server.ts:84-90, 433-441`), so a route that ran twice would count once, which is the wrong meaning here. `decisionLoop` therefore reads its own route-output records, not a view.

The same N serves both readers: the decisions model's "Latest results", and the next child's handoff block.

### What a route returns: result + reasoning

Each iteration records one **route output**: `{ route, status: 'done' | 'failed', result, reasoning }`. It is built by code from the child's committed events, not by a model call. So there is no new LLM role, and the tier rule has nothing to route.

| Route kind        | `result`                                                                                                                                                   | `reasoning`                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `simpleLoop`      | its final `Return` text, with `returnStyle: 'answer'`. The default `'summary'` returns one line like "Task complete" (architecture review §2)              | the `Return` action's `reasoning`                                |
| `actorCritic`     | the accepted attempt's `tool_result`, the one written to `data.result` on acceptance (`actorCritic.server.ts:245-249`). `actorCritic` has no `returnStyle` | the actor's `reasoning` on that action plus the critic's verdict |
| `retriever`       | the matches' titles and short excerpts, with references kept                                                                                               | "searched N documents, M matches"                                |
| `planner` (think) | the plan text                                                                                                                                              | none                                                             |

`result` is capped (e.g. 2,000 characters, with the excess replaced by a marker). Each route kind has a default extractor, so a developer writes none. The record is stored as a `controller_action` / `tool_result` pair under the loop's own `patternId`. That is the shape `compactExecution`'s thread mode already reads, so synthesis needs no new event type (see [Synthesis](#synthesis)).

### Done

`done` is a choice option, not a route. It runs nothing: the loop ends and the top-level `compactExecution` answers.

This differs from the sketch's `skip_to_synthesizer: synthesizer(…)` route, because a synthesizer both inside the loop and after it would answer twice. A conversational message ("thanks!") is one `done` decision followed by synthesis: two calls, the first a one-token decision.

### The `think` route

`think` is the existing `planner`. It reads the conversation and the handoff, and writes `data.plan` (`planner.server.ts`). It produces text only and runs no tool. Its plan appears in the next state and in every following child's `plan_context`, until a later `think` replaces it.

That is how "thinking the next step" is a route: the decisions model chooses to think when the next step is unclear, and pays for the planner call only then.

### When a route fails

A child that ends with an `error` event, or that throws (for example a sandbox that fails to boot), is caught by `decisionLoop`. It is recorded as `status: 'failed'` with the error text as `result`. The loop then continues, and the decisions model sees the failure in "This turn so far" and in "Latest results".

The child's own `error` events stay inside its `pattern_enter`/`pattern_exit`, but they are recorded as `recoverable` in the merged copy. Without that, `runChain`'s stop rule would end the whole turn on a child's `irrecoverable` error (architecture review §2a).

| Situation                                                | Behaviour                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A route fails                                            | Recorded as failed. The loop decides again.                                                                                                                                                                                                                            |
| `maxIterations` reached (default 6)                      | The loop stops as if `done`. The synthesizer answers from what exists and says the work is partial.                                                                                                                                                                    |
| The decide call itself fails                             | On the **first** iteration, the turn ends with a visible error: nothing ran, so synthesizing would silently answer without the agent's tools. On a later iteration, the loop stops as if `done`, and the error is recorded for the synthesizer. Owner call N3 on #507. |
| The decide transport is unconfigured on the private tier | Refused per #418 G11, and treated like the first-iteration case: a visible error, never a fall-back.                                                                                                                                                                   |

## Routes, and how tools are grouped

- **`read-documents` is its own route** rather than a tool inside `info_ag`. The retriever is a pattern, not an MCP tool. Putting it in `simpleLoop`'s tool list would need round 1's `patternTool` primitive. The redis server's `search_redis_documents` cannot stand in for it: it is not scoped to the conversation, so the model could name another conversation's keys (the same reason `graph_file_ingest` takes its session from the request). As a route it needs nothing new, and `harnessHasRedisRetriever` still finds it through `children`.
- **`info_ag` holds Neo4j reads and web tools.** That grouping is the owner's. It puts untrusted web text and a Cypher tool in one loop, which is #241's exposure (owner call S-a on #507).
- **`doc_ag` holds the Microsoft 365 tools, inside a sandbox.** `graph_file_ingest` is in its allowlist, because this agent can read what it ingests.

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
- **One guard around `orchestrator`**, the union of the three, so route outputs can be sanitized at the loop level. Nested guards union and never shadow, so the inner guards stay as the local declaration of each agent's sources.
- **S2's pin** walks every name each route can call, and asserts that each is untrusted or on a short trusted list with a reason.

**Sandbox.** `doc_ag` is `withInjectionGuard(withSandbox(actorCritic(…)))`, the sketch's second form. The first form, `actorCritic({ tools: [sandbox, ms-365] })`, cannot be written today: a sandbox's tools exist only inside a `withSandbox` scope. `withSandbox` stays the grouping that shares one machine (owner, round 1).

**One gap inside `doc_ag`.** `withSandbox` hydrates `/work/in` once, on entry, before the actor runs (`with-sandbox.server.ts:665`, then `:703`). A file the actor ingests with `graph_file_ingest` during the same run is in the stash but **not** on disk, until the route is entered again. There are three fixes, in order of preference:

1. `withSandbox` re-hydrates after any tool call in its scope that stored a stash document. This is code-driven, needs no model step, and reuses `hydrateWorkspace`'s diff.
2. The decisions model runs `office-data` twice.
3. A separate ingest route.

Recommend (1). This is owner call N4 on #507.

### Untrusted content on the way up

A route output never passes the `callTool` chokepoint. `decisionLoop` records it directly, and it then reaches two places: the decisions model's state and the next child's `plan_context`, which is an instruction-adjacent slot. So `decisionLoop` passes each `result` and `reasoning` through `currentRunFrame()?.guard?.sanitize(…)` before recording it, under the orchestrator-level guard. It builds them only from the child's committed (already sanitized) events, never from a file or a transport read. A pin feeds a known injection string through a child, and expects a neutralized record plus a `content_sanitized` event.

`spotlight: 'always'` on that guard fences everything handed up (owner call S-c on #507).

## Data between routes

- **Files** move through the stash: `graph_file_ingest` → stash → `/work/in` on `doc_ag`'s next entry, or within one entry once the re-hydrate fix above lands. Those are real bytes (security review §5).
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
- **P2 — The stuck-run reaper.** Its 25-call bound assumes one loop per turn. This shape is up to 6 iterations of up to 15-call children. Arithmetic: 6 × 15 + 6 decisions + 1 synthesis = 97. The architecture review's fix applies unchanged: reap on a dead turn lease, with an age backstop. This is owner call A1.
- **P3 — The injection boundary.** As stated in [the guards section](#where-memory-guards-and-the-sandbox-sit), plus #241: `info_ag` holds web text and Cypher together. This is owner call S-a.
- **P4 — Pseudonymisation** on the materialisation path, unchanged from round 1. It depends on `graph-pseudonymisation.md`'s Q1, Q2, Q3 and Q5. The file path carries real bytes too, which is owner call S-f.
- **P5 — The decisions model on the private tier.** Per #418 G11, private-tier decisions go to a separately configured systemone URL (the self-hosted shim another lane serves), and are refused when it is unset. Until it is served, this agent works on the Anthropic tier only, and shows a visible error on the private tier.

## Later: directed-graph utilities

The owner named a later step: utilities that instantiate loops, agents, harnesses and orchestrators from a directed graph (cycles allowed). `decisionLoop` is the first concrete node type such a graph would need: a node whose outgoing edges are chosen by a decision. The route-output record is the edge payload. Designing the DG layer waits until this agent has run.

## Rollout

Ship as a new agent beside `general` (working id `general-next`). It replaces `general` when:

1. an eval scenario shows no regression on `general`'s current cases, on both tiers;
2. a synthetic fetch → read back → compute request passes;
3. P2, P3 and P5 are met;
4. P1 is met, or "no gates in routes" is pinned;
5. the M7 memory opt-in moves with it.

## Slices (dispatched only after owner approval)

1. **`decisionLoop` in core**, which includes:
   - the iteration;
   - the custom state;
   - the route-output record and per-kind extractors;
   - sanitizing on the way up;
   - failure capture and severity downgrade;
   - `maxIterations`;
   - `children` and `estimateTurns`, the latter meaning iterations, not N × child.
2. **`compactExecution` `thread` mode** reads `fromPatterns`, pinned on the nested shape.
3. **The agent**: `general-next`, its guards, and the walk pin, with an app-path e2e over the synthetic case. Gated on P2, P3 and P5.
4. **`withSandbox` re-hydrate on stash write** (call N4).
5. **Materialisation**, gated on P4.
6. **Resume from route records** (P1), only when a gate is wanted inside a route.

## See also

- #507: the diagnosis, both round-1 reviews, and this round's owner calls.
- #418 G11 (the decisions client) · #419 (memory) · #241 (Neo4j) · #446 (the reaper) · ADR-0005 · ADR-0009
- [`sandbox.md`](sandbox.md) · [`graph-pseudonymisation.md`](graph-pseudonymisation.md) · [`packages/harness-patterns/SPEC.md`](../../packages/harness-patterns/SPEC.md)
