# Patterns as Loop Tools (Plan)

> **Status: design, not built.** The shape below was converged with the owner on 2026-10-08, as the structural answer to [#507](https://github.com/mknw/hames-playground/issues/507). Nothing here is implemented, and no slice is dispatched until the owner signs off. The doc owes an independent review, and the injection-guard section owes a separate security review. Four preconditions ([below](#preconditions-the-design-owes)) are stated as preconditions, not solved here.

This doc covers how an agent gets to choose its own topology inside a turn, the one new core primitive that needs, and what that primitive collides with. It does **not** cover the sandbox's internals ([`sandbox.md`](sandbox.md)), the pseudonymisation core ([`graph-pseudonymisation.md`](graph-pseudonymisation.md)), or memory's own design (#419).

> **Design-conversation note.** Per CLAUDE.md → "Probe before scaffolding", this doc follows a conversation and does not start one. The choices marked _ruled_ were made by the owner. The ones marked _recommended_ are still open.

---

## The problem, mechanically

Today an agent's topology is fixed when `createPatterns(sessionId, deps)` builds it. That build is cached per session (`getOrBuildPatterns`), and `runChain` only walks the array it was given. The model already chooses in three places, and none of them can add a capability during a turn:

- **`router` / `decisionRouter`** pick one branch from a closed set, once.
- **A loop** picks tools from a fixed allowlist.
- **`planner`** writes a plan as prose. It runs nothing.

#507 is the failure that follows. The `general` agent is `planner → simpleLoop → compactExecution` over `tools.all`. It was given a request whose plan needed three steps: fetch a file, read it back, run code over it. The loop could do the first step, because `graph_file_ingest` is in `tools.all`. It could do neither of the others: `general` composes no retriever to read the Data Stash and no sandbox to run code. So the controller correctly returned without doing the work. The planner described a topology the agent did not have.

The fix is not a better planner. It is to let the loop reach the capabilities a plan needs.

## The converged shape

```typescript
// Working id: 'general-next', shipped beside `general` (see Rollout).
withMemory(deps.memory)([
  // top-level array combinator (#419)
  router(ROUTES, { patternId: "router" }), // direct answer, or the loop
  routes({
    loop: simpleLoop(
      createLoopControllerAdapter(),
      [
        ...EXPLICIT_TOOLS, // neo4j / web / graph, incl. graph_file_ingest
        patternTool(
          withSandbox({
            id: `${sessionId}:data`,
            rootfs: "data",
            egress: "mcp-only",
            syncWorkspace: true,
          })(
            actorCritic(actor, critic, [], {
              maxRetries: 6,
              criticCadence: 3,
              multiToolCalls: "sequential",
            }),
          ),
          { name: "run_code", description: "…" /* see contract */ },
        ),
        patternTool(
          retriever({
            backends: [
              /* redis */
            ] /* + query-source option, see contract item 2 */,
          }),
          { name: "read_documents", description: "…" },
        ),
      ],
      { patternId: "execute", maxTurns: 12 },
    ),
  }),
  compactExecution({
    mode: "thread",
    patternId: "response-synth",
    viewConfig: {/* see Synthesis */},
  }),
]);
```

**What stays fixed and what the model chooses.** The set of capabilities is fixed at build time, exactly as today. What the model chooses is _which_ of them run, in _what order_, and _how often_, inside one turn. A synthetic example: "find the Q3 travel-expense spreadsheet in SharePoint and chart spend per month" becomes `graph_files_search → graph_file_ingest → run_code`. The ingested file reaches `/work/in` because `run_code` hydrates when it is entered ([Data handoff](#data-handoff-between-tools)). The result is a chart in `/work/out`, which is promoted to the stash.

**Why this fits the model rather than fighting it:**

- **ADR-0005.** The thing that decides what runs is a `simpleLoop` with an allowlist, which is an existing pattern, not a central orchestrator. Nothing about `baml-agent` comes back.
- **Resume.** The top-level names (`memory-recall`, `router`, `routes`, `response-synth`) never change, so `resumeAt.names` holds and `chain-changed` is never raised by this shape. The open resume risk is a different one ([P1](#p1--pause-and-resume-through-a-child)).
- **Static probes.** `harnessUsesSyncWorkspace`, `harnessHasRedisRetriever`, `harnessUsesMemory` and `harnessDecisionKeys` keep working, provided `patternTool` exposes its pattern as `children` (contract below).

Seen from the other side, a `simpleLoop` holding pattern-tools is **`routes` made repeatable, with arguments the model writes**.

## The one new primitive: `patternTool`

`ToolTransport` cannot carry this. `callTool(name, args)` gets no scope and no view (`tool-transport.server.ts`). A child pattern run behind it would emit events that never reach the context:

- the observability panel would not see them;
- the host could not count them ([P2](#p2--the-stuck-run-reapers-bound));
- `askHuman` could not record a pause.

So the primitive lives in the loop. `simpleLoop`'s `tools` argument widens from `string[]` to `(string | PatternTool)[]`. The allowlist stays one list and one predicate. `actorCritic` gets the same widening later, if wanted. It is not needed for v1.

**Contract.** Each of these is a requirement of the slice, not a suggestion.

1. **Descriptor.** `patternTool(pattern, { name, description, args? })` contributes one `MCPToolDescription` to the catalog the controller is shown. That catalog is the same one the adapter builds from the gateway plus `activeTransports().listTools()` (`baml-adapters.server.ts:900`). `args` defaults to `{ task: string }`.
   - The `name` must not collide with a gateway or transport tool name. That is checked at construction, and a collision throws.
   - The name is also never a namespace the injection guard resolves to by accident ([P3](#p3--the-injection-boundary)).
2. **Input.** The child scope's `data.intent` is the model-written `task`. That is the seam `simpleLoop` (`:381`) and `actorCritic` (`:293`) already read their task from, so neither changes. `data` otherwise inherits from the loop's scope, as `routes` does (`router.server.ts:333`).
   - **The retriever is the exception.** Its docstring says it queries with `data.intent` when present (`retriever.server.ts:27`). The code actually searches with the last `user_message` (`:196-199`) and passes `intent` to backends only as a hint (`:266`).
   - As a tool it would then search the user's whole request rather than the model's query. So S1 adds an explicit query-source option to `retriever` (e.g. `query: 'intent'`), with the default unchanged, and corrects the docstring. The docstring/code disagreement is a finding in its own right.
3. **Scope and view.** The child runs in `createScope(childId, data)` and gets a **synthetic view** of the outer context plus the loop's own in-flight events, the way `chain()` builds one (`chain.server.ts:331-335`).
   - Passing the loop's own view, as `routes` does, is not enough. Nested events reach `ctx.events` only at the top-level commit, so a child given the plain view cannot see the tool results the loop gathered earlier in this same turn. That would break [Data handoff](#data-handoff-between-tools).
4. **Events.** The child's events are pushed into the loop's scope, wrapped in `pattern_enter` / `pattern_exit`, as `routes` does. They keep the child scope's `patternId`, so `viewConfig.fromPatterns` can include or exclude them.
5. **Output.** The loop records one `tool_result` for the call. Its content comes from an `output(childData, childEvents) => string` projection on the `patternTool` config:
   - the child's `Return` payload, for a loop child;
   - the accepted attempt's result, for an `actorCritic` child;
   - the hits with their references, for a retriever.

   The child's full event log never becomes the tool result. The master controller sees a summary, which caps how much its turn log grows. No new LLM call is involved: the projection is plain code, so the tier rule has nothing to route.

6. **Introspection.** The `ConfiguredPattern` that `simpleLoop` returns declares `children` = the patterns of its pattern-tools. Its `estimateTurns` = `maxTurns × max(child.estimateTurns)`. Capabilities are inherited through `children`; `patternTool` itself declares none.
7. **Pause.** The existing `hitlPending()` checks after a single call and after a batch (`simpleLoop.server.ts:793, 1037`) must run after a pattern-tool call too. That is what stops the loop when a child paused. What resume then does is [P1](#p1--pause-and-resume-through-a-child).
8. **Failure.** A child that ends with an `error` event yields a `tool_result` that says so. The master loop can then route around it, or report it. Note: a dispatched call that fails does not count against the consecutive-recovery cap (`loop-recovery.server.ts:161-162`). A failing child is bounded only by `maxTurns`, so `patternTool` takes an optional `maxCalls` per turn, defaulting to 3.

## `withSandbox` stays the grouping (_ruled_)

`withSandbox` is not replaced by `patternTool`. It stays the way to say "these patterns share one machine". A `patternTool` can wrap any `ConfiguredPattern`, so a group is either:

- **one tool over a wrapped chain:** `patternTool(withSandbox(cfg)(chain(coder, reviewer)), …)`;
- **several tools over the same attachment:** two `patternTool(withSandbox({ id: X, … })(…))` entries with the same `id` share one container through the attachment table (ID-addressable; [`sandbox.md` → Attachment model](sandbox.md#attachment-model)).

**Why the sandbox is a tool and not around the master loop.** Wrapping the loop in `withSandbox` would make the sandbox's tools part of the loop's allowlist directly, through `activeTransports()`, with no new primitive. It was rejected for two concrete reasons:

- **Hydration timing.** `withSandbox` hydrates `/work/in` from the stash on **entry** (`with-sandbox.server.ts:656`). Around the loop, entry is before the loop's first turn. A file ingested at turn 2 would never reach `/work/in`. As a tool, every invocation is an entry, so the ingest-then-run order in the example above works with no new code.
- **Boot cost.** `attachments.acquire` runs at entry (`:645`). Around the loop, every turn boots or reattaches a container, including turns that are plain conversation. As a tool, it boots only when the model picks it.

The retriever stays a pattern for the same reason (_ruled_). It keeps the references it already returns with its matches (`retriever.server.ts:110-117`), and `harnessHasRedisRetriever` keeps gating upload auto-ingest. That probe can see it only through contract item 6.

## Data handoff between tools

There are two kinds of data that one tool produces and another needs.

**Files already have a path.** `graph_file_ingest` writes the file to the conversation's stash. The session comes from `getRequestSessionId()`, never from arguments ([`MICROSOFT_GRAPH.md`](../MICROSOFT_GRAPH.md), invariant 3). The sandbox tool's next entry then hydrates it into `/work/in`. `graph_file_ingest` was left out of the Microsoft 365 agent only because no retriever there could read the stash (`MICROSOFT_GRAPH.md:39`). This agent has both a retriever and a sandbox to read it, so it comes back into the allowlist.

**Results that are not files: option (c), materialise on entry (_ruled_).** Mail lists, Cypher rows and fetched pages have no path to the sandbox today. When the sandbox tool is entered, the `tool_result` events the loop has gathered **in this turn** are written into `/work/in/turn/`, one file per result. They are written from the synthetic view in contract item 3.

- **Not persisted.** Nothing is written to the stash, and `/work/in` is never promoted (only `/work/out` is).
- **Cleared.** `/work/in/turn/` is wiped at sandbox entry, before writing, because a container outlives a turn. Without the wipe, last turn's results would still be on disk.
- **Where it lives.** This is a `withSandbox` option (`turnResults: true`), not `patternTool` logic. Only `withSandbox` holds the transport at entry, and the option belongs beside `syncWorkspace`.
- **Why not the alternatives.** (a), inlining the data into the `task` argument, puts large payloads inside a controller output and hits the cap-hit failure CLAUDE.md records. (b), a `stash_put` tool, would make mail bodies and query rows durable in the stash, which creates a new class of data at rest.

**The owner's condition: pseudonymisation must really work on this path.** It is the hardest precondition here, because **pseudonymisation is wired into nothing today**:

- The core in `app/src/lib/privacy/` is built and benchmarked.
- `egress-wiring.test.ts` deliberately fails if any production module imports it before the owner's open questions are decided ([`graph-pseudonymisation.md`](graph-pseudonymisation.md)).

So (c) inherits nothing. It is gated as [P4](#p4--pseudonymisation-on-the-materialisation-path), and the agent ships without `turnResults` until P4 is met.

## The direct-answer route: `router`, not `decisionRouter` (_recommended_)

The existing `router` already answers directly:

- With no tool needed, it writes `route = 'user'` and the reply, and records a `final: true` `assistant_message` (`router.server.ts:182-204`).
- `routes` passes `'user'` through.
- `compactExecution` skips synthesis for it (`compactExecution.server.ts:239`).

It is also the pattern that reads recalled memory. `decisionRouter` (#418, merged as `decisionRouter(routeDescriptions, { decide, policy, conversationalRoute?, … })`) is a cheaper decision on the `decide` role, but it does not fit this route, for two reasons:

- It writes **no reply text**, and it may not name a route `'user'`. The conversational route would therefore cost a synthesizer call.
- It does **not read `memoryContext`**, so a reply that depended on memory would be routed blind.

The accepted Score/noul addendum on #418 keeps `decisionRouter` choice-only and byte-identical. The one effect on a caller is type-level, in S1: `data.decisions` widens to `AnyDecision`. A future swap to `decisionRouter` is therefore not blocked, but it is not chosen.

One existing wrinkle to carry into the slice: `compactExecution` hard-codes `'user'` rather than reading a custom `directResponseRoute`. So this agent keeps the default name.

## Memory

Memory is wired through `withMemory(deps.memory)` around the **top-level** array, and through nothing else. `withMemory` is an array combinator that prepends `memoryRecall`, and it must sit outermost: recall runs before routing (`memoryRecall.server.ts:4-5`). A nested wrapper would break `runChain`'s per-top-level live toggle (`withMemory.server.ts:6-11`). What follows on main:

- **Readers.** Recall writes `scope.data.memoryContext`, which is transient and never persisted. It is read by `router` (BAML `Router(…, memory_context)`) and by `compactExecution` (`Synthesize(…, memory_context)`).
  - The master loop's controller does not read it, and neither do the planner or `decisionRouter` (SPEC.md: "controllers and the planner have no direct memory-block input").
  - Children inherit the key through `data` but do not use it. That is the intended surface, not a gap this design should fill.
- **The #546 setting.** `routerMemory: 'routing-and-replies'` (the default) or `'replies-only'` is set on the `withMemory` config, which is the developer's choice. Nothing here overrides it.
- **The host.** `startTurnMemory` gates the wake on `harnessUsesMemory(patterns)`. `compactAndSave` runs `settleMemory` after the reply. Both read the probe, so the opt-in is exactly the `withMemory` call.
- **M7.** The owner ruled on 2026-10-08 that `general` opts into memory at M7, and no other shipped agent for now. `general-next` therefore composes `withMemory` from the start, so that replacing `general` keeps its memory behaviour. It stays per-user default-off (`memory_enabled`).

## Synthesis reads a view parameter (_ruled_)

There is no new mechanism. `compactExecution`'s `viewConfig` names what it reads:

- `fromPatterns: ['router', 'execute']`, which is the master loop's `tool_result` events, including the pattern-tool summaries;
- `fromLastNTurns: 1`;
- the existing `eventTypes`.

The children's internal events are excluded by `patternId`, so the synthesizer sees what the master controller saw. A child that should be visible to synthesis is added to `fromPatterns` by name. The same parameter is set on the children where relevant, for example an `actorCritic` child whose critic should read only its own attempts.

## Tool allowlist

The allowlist is explicit (`EXPLICIT_TOOLS`), not `tools.all`. Two reasons:

- `tools.all` is what gave #507's loop a tool whose result it could not use.
- An explicit list is what the Microsoft 365 agent already does, and a test pins it.

`graph_file_ingest` is on it, because the agent can now read what it ingests. Which Neo4j tools are on it is decided by the security review ([P3](#p3--the-injection-boundary)), not here.

## Preconditions the design owes

Each of these must be met before the slice it gates ships. None is solved in this doc.

### P1 — Pause and resume through a child

**What happens today.** A resume re-runs the paused top-level pattern **from its start** (SPEC.md: "the paused top-level pattern runs again from its start"; `harness.server.ts:475`). `simpleLoop` keeps its turn log in memory only (`const turns = []`, `:271`). On resume it calls the controller again from turn 0. Its earlier tool calls reach the controller only as previews from prior runs. Test H22 (`hitl-resume.test.ts:681-748`) shows both a gated call and a plain read re-running. The only thing that replays is a person's answer: `askHuman` returns it for a request with the same identity (`hitlReplayKey`).

**What nesting changes.** Nothing new breaks, but the cost multiplies. The master loop re-runs from turn 0, and so does the child. Every earlier tool the controller picks again runs again, including a sandbox's code. The replayed answer is found only if the child's new request has the same identity. The default key hashes the question, the options and the summary, so any of those written by an LLM will ask the person a fresh question.

**What is true in production.** No agent or app code calls `askHuman`, `humanGate` or `confirm` today. P1 is therefore latent, not live.

**Precondition.** v1 ships with no gated tool inside any child. That is stated in the agent and pinned by a test that walks `children` for a declared gate (or, if gates cannot be detected statically, documented as a composition rule). Before any child holds a gated tool, two things must land:

- every gated request inside a child carries an explicit stable `key`;
- `simpleLoop` gains a replay path that rebuilds `turns` from this run's `controller_action` / `tool_result` events instead of calling the controller again.

That replay path is worth having for plain loops too, since H22's re-runs are today's behaviour.

### P2 — The stuck-run reaper's bound

`MAX_SEQUENTIAL_LLM_CALLS = max(maxToolTurns[1], 2 × maxRetries[1]) + CHAIN_OVERHEAD_CALLS`, which is 25 (`conversations.server.ts:819-822`). The comment derives it as "the most sequential LLM calls one turn can make", which assumes one loop per turn. It is not enforced as a counter. It sets the 90-minute `STUCK_RUN_TIMEOUT_MINUTES` that `reapStuckConversations` applies to `updated_at`.

This shape breaks the arithmetic: 12 master turns, each able to call a 15-call child, is 57 or more calls against 25. The derivation's guarantee, that a live turn is never reaped, then no longer holds. With typical call times a real reap is unlikely, but the guarantee is the thing `runtime-config.ts:38-46` calls load-bearing. Two ways out, an owner decision:

- **(i) a liveness write** (_recommended_): bump `updated_at` on each committed top-level pattern, or on each LLM call. The reaper then measures silence, not a derived bound, and no future composition can break it.
- **(ii) a composed bound**: the agent's `estimateTurns` (contract item 6) feeds a per-agent threshold. This is exact, but every new shape must keep the arithmetic right.

### P3 — The injection boundary

The master loop reads untrusted content (web pages, mail, ingested files, sandbox output) and then **writes the next child's task**. So a model-chosen topology can be steered by that content: which capability is mounted, and with what instruction, is downstream of it. The sandbox's `mcp-only` egress makes the sandbox tool a further path. `general` declares no guard today.

The shape that follows from the existing rules:

- one `withInjectionGuard` over the master loop, covering every untrusted namespace;
- unioned with any guard nested inside, never shadowed (SD-1, SD-5, SD-7; sandbox egress SD-20).

But composing it, and choosing the Neo4j tool set given #241, is **security work**. It goes to an independent Opus security review, and this doc does not design it.

### P4 — Pseudonymisation on the materialisation path

(c) ships only when all of the following hold. Each item names the open question in [`graph-pseudonymisation.md`](graph-pseudonymisation.md) that it depends on.

1. **The hook is at the tool transport, before projection (Q1).** The files are written from the raw payload, and the projections drop one of the two identity fields the roster needs (that doc's limitation 3).
2. **The prompt and the files use the same table, stable per conversation (Q5).** Today `buildTable` numbers each payload from scratch. A sandbox joining two materialised files would then treat two different people as `PERSON_1`. Pseudonymising the files but not the prompt buys nothing either: the model has seen the real values and can type them into code.
3. **The table lives outside the container, scoped to the run, with a decided lifetime (Q3).** The table is itself personal data.
4. **What `conversations.context` stores is decided (Q2).** The materialiser reads from the same events.
5. **Re-identification has a decided point, and binary outputs have a decided treatment.** `reverse(text, table)` works on strings, so a CSV can be re-identified at promote time. It cannot re-identify a `.docx` (zipped XML) or a rendered chart: a `PERSON_3` axis label cannot be recovered after rendering. A binary deliverable is either labelled pseudonymised, or re-identified by a trusted unpacking step. Re-identified bytes are never fed back to a model.
6. **Coverage is stated in the agent.** The roster is Graph's own identity fields plus the tenant directory. Plain Cypher rows, web pages and stash documents are not covered, and neither is a person named only in prose who is not in the directory.

**One question this raises for the owner:** does the condition also cover the **file** path? `graph_file_ingest` stores real bytes in the stash, and `hydrateWorkspace` writes them to `/work/in` unchanged. The sandbox agent already does exactly this today.

## Fit with the ADRs

- **ADR-0005** (no orchestrator): satisfied. The decision-maker is an existing loop pattern holding an allowlist. There is no component that composes topologies.
- **ADR-0006** (no rails-style pre/post guard runner): untouched. The guard surface stays `withInjectionGuard`.
- **ADR-0009** (HITL state is events): satisfied by the shape. P1's replay path would extend it ("loop progress is events too"), not depart from it.
- **A new ADR is proposed for the primitive** when implementation is approved. `simpleLoop`'s `tools` contract widening, and "a child pattern is a tool", are the kind of irreversible core decision ADRs record. It supersedes nothing.

## Rollout

Ship as a **new agent beside `general`** (working id `general-next`), so #507's class of request can be compared against `general`'s current behaviour on the same synthetic cases.

**What would make it replace `general`:**

1. **Parity:** on the cases `general` handles today (graph questions, web lookups, plain conversation), no regression in answer quality, turn latency or cost on both tiers. That is measured by an eval scenario added for it, not by inspection.
2. **The #507 class passes:** a synthetic fetch → read back → compute request completes on both tiers.
3. **P2 and P3 are met** (P2's chosen option is in; the security review signed off).
4. **P1** is met, or "no gates in children" is pinned.
5. **(c)** either ships with P4 met, or the agent is explicitly accepted without it.
6. **Memory:** the M7 opt-in moves with it, as `general-next` already composes `withMemory`.

## Implementation slicing (dispatched only after owner approval)

1. **S1 — `patternTool` in core.** Contract items 1–8, unit tests for each, and the mutation that reddens each pin. Includes `children` / `estimateTurns` introspection tests through the existing probes.
2. **S2 — the agent.** `general-next`, with an explicit allowlist, the router, the sandbox tool, the retriever tool, `withMemory`, the synthesizer `viewConfig`, and app-path e2e over the synthetic #507-class case. Gated on P3's review and P2's option.
3. **S3 — `turnResults` on `withSandbox`.** Gated on P4.
4. **S4 — loop replay (P1).** Only when a gated tool is wanted inside a child.

## Open questions for the owner

1. **P2: liveness write (i) or composed bound (ii)?** _Recommended: (i)._ It stops the reaper's correctness depending on every future composition's arithmetic. It blocks S2.
2. **P4: does "pseudonymisation must really work" also cover the file path** (`graph_file_ingest` → stash → `/work/in`)? _Recommended: yes, as the same P4 work._ Otherwise a real-valued file sits beside pseudonymised results in one `/work/in`, and joins across them leak. It blocks S3 at least, and S2 if yes.
3. **P4 depends on `graph-pseudonymisation.md`'s Q1, Q2, Q3 and Q5,** which are already open. This doc adds a concrete consumer and the answers it needs (P4 items 1–4). It does not add new questions.
4. **Planner: omit it in `general-next`, or keep it as `plan_context` to the master loop?** _Recommended: omit for v1._ #507 showed a plan is worth nothing without the capability. On the private tier the planner also runs with no thinking, a cut cap and one retry (CLAUDE.md, the `planner:` entry). Measure with and without it before adding it.

## See also

- [#507](https://github.com/mknw/hames-playground/issues/507) — the diagnosis this answers. [#443](https://github.com/mknw/hames-playground/issues/443) — the same root cause.
- [#206](https://github.com/mknw/hames-playground/issues/206) — the router-over-work-shapes proposal. This doc keeps its intent (reach the capability the work needs) without a branch per work shape.
- [`sandbox.md`](sandbox.md) · [`graph-pseudonymisation.md`](graph-pseudonymisation.md) · [`packages/harness-patterns/SPEC.md`](../../packages/harness-patterns/SPEC.md)
- #418 (typed decisions) · #419 (memory) · #433 / ADR-0009 (HITL) · #446 (stuck-run reaper) · #241 (Neo4j SSRF)
