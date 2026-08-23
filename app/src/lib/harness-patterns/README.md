# Harness Patterns

Functional, composable framework for agentic tool execution.

> **Status:** this directory is the **testbed** for the harness-patterns
> library. The kg-agent repo serves as both consumer and proving ground —
> the library is intended to be extracted as a standalone npm package once
> the core API has been validated across enough use cases (the agents under
> `harness-client/agents/`).
>
> Library boundary rules — keep them strict so extraction stays cheap:
>
> 1. `harness-patterns/` MUST NOT import from `harness-client/`, `components/`,
>    or any other consumer.
> 2. Pattern primitives are framework-neutral — no SolidJS, no UI types.
> 3. Anything that depends on runtime settings goes through
>    `settings-context.server.ts` (AsyncLocalStorage), not function
>    parameters.
> 4. UI display logic (e.g. `useChainProgress`) lives in the consumer, not
>    here. The library exposes neutral primitives like
>    `ConfiguredPattern.estimateTurns` that consumers can build on.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Core Concepts](#core-concepts)
- [UnifiedContext Architecture](#unifiedcontext-architecture)
  - [Core Types](#core-types)
  - [BAML Types](#baml-types)
- [Context Flow](#context-flow)
  - [Key Insight: Scope Isolation](#key-insight-scope-isolation)
  - [Session Persistence](#session-persistence)
- [API Reference](#api-reference)
  - [Tools()](#tools)
  - [simpleLoop()](#simpleloopcontroller-tools-config)
  - [actorCritic()](#actorcriticactor-critic-tools-config)
  - [withReferences()](#withreferencespattern-config)
  - [compactExecution()](#compactexecutionconfig)
  - [compactIntent()](#compactintentconfig)
  - [planner()](#plannertools-config)
  - [retriever()](#retrieverconfig)
  - [withInjectionGuard()](#withinjectionguardconfigpattern)
  - [router()](#routerroutedescriptions-config)
  - [routes()](#routespatternmap-config)
  - [chain()](#chainctx-patterns)
  - [harness()](#harnesspatterns)
  - [resumeHarness()](#resumeharnessserialized-patterns-approved)
  - [continueSession()](#continuesessionserialized-patterns-newinput)
- [EventView Query API](#eventview-query-api)
- [Configuration System](#configuration-system)
  - [ViewConfig Options](#viewconfig-options)
- [Event → BAML Type Mapping](#event--baml-type-mapping)
  - [Harness EventType → BAML Input Type](#harness-eventtype--baml-input-type)
  - [Per-Pattern: Events Read → BAML Inputs → BAML Return](#per-pattern-events-read--baml-inputs--baml-return)
  - [Conversion Reference](#conversion-reference)
- [Full Example](#full-example)
- [File Structure](#file-structure)
- [Design Principles](#design-principles)

## Architecture Overview

```
BAML Functions ──┐
                 ├──► Patterns ──► Router ──► Harness ──► Agent
MCP Tools ───────┘
```

**Key Principle**: BAML functions are passed directly to patterns. No intermediate wrappers needed.

## Core Concepts

```typescript
// Preferred: use adapter factories from baml-adapters.server.ts
const controller = createNeo4jController(tools.neo4j ?? [])
simpleLoop(controller, tools.neo4j ?? [], { patternId: 'neo4j-query', schema })

const actor = createActorControllerAdapter(tools.all)
const critic = createCriticAdapter()
actorCritic(actor, critic, tools.all, { patternId: 'actor-loop' })

// Alternative: pass BAML functions directly (bind to preserve 'this' context)
simpleLoop(b.Neo4jController.bind(b), tools.neo4j, { schema })
actorCritic(b.ActorController.bind(b), b.Critic.bind(b), tools.all)

// Router is two composable patterns: classify → dispatch
router({ neo4j: 'Description', web: 'Description' }),
routes({ neo4j: pattern1, web: pattern2 })

// Harness chains patterns and executes them
harness(router(...), routes(...), compactExecution({ mode: 'thread' }))
```

## UnifiedContext Architecture

The framework uses **UnifiedContext** as the single source of truth for session state:

- **Session Persistence** - Serialize/deserialize full session state
- **Pattern Isolation** - Each pattern works in isolated scope, commits on completion
- **Flexible Event Querying** - Select events by pattern, type, recency via `EventView`

### Core Types

```typescript
// Source of truth for session state
interface UnifiedContext<T> {
  sessionId: string
  createdAt: number
  events: ContextEvent[] // Full event stream
  status: CtxStatus // 'running' | 'paused' | 'done' | 'error'
  error?: string
  data: T // Accumulated pattern data
  input: string // Current user input
}

// Events tagged with pattern origin
interface ContextEvent {
  id?: string // Auto-generated unique ID (e.g. 'ev-a1b2c3')
  type: EventType
  ts: number
  patternId: string
  data: unknown // Typed per EventType (see Event → BAML Type Mapping)
}

// Tool event data includes optional callId for pairing call↔result in the UI
interface ToolCallEventData {
  callId?: string
  tool: string
  args: unknown
}
interface ToolResultEventData {
  callId?: string
  tool: string
  result: unknown
  success: boolean
  error?: string
}

type EventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'controller_action'
  | 'critic_result'
  | 'pattern_enter'
  | 'pattern_exit'
  | 'approval_request'
  | 'approval_response'
  | 'error'
  | 'reference_attached' // withReferences — selector decision (observability)
  | 'intent_compacted' // compactIntent — rewritten brief (observability)
  | 'plan_created' // planner — upfront plan (observability; the plan itself travels on scope.data)
  | 'content_sanitized' // withInjectionGuard — untrusted content neutralized (observability + audit)

// Isolated workspace for each pattern
interface PatternScope<T> {
  id: string
  events: ContextEvent[] // Local events (not yet committed)
  data: T
  startTime: number
}

// Pattern function signature
type ScopedPattern<T> = (scope: PatternScope<T>, view: EventView) => Promise<PatternScope<T>>

// ConfiguredPattern wraps pattern with metadata
interface ConfiguredPattern<T> {
  name: string
  fn: ScopedPattern<T>
  config: ResolvedConfig
}
```

### BAML Types

```typescript
// Controller output (standardized across all BAML controllers)
interface ControllerAction {
  reasoning: string // Chain-of-thought
  tool_name: string // Tool to call. simpleLoop: `'Return'` exits the loop. actorCritic: actor's `'Return'` is ignored — the critic alone owns termination.
  tool_args: string // JSON payload
  additional_calls?: ToolCallRequest[] // Calls 2..N of a multi-call turn ({tool_name, tool_args} each).
  // Executed per the pattern's `multiToolCalls` mode: 'parallel' (default,
  // concurrent, ≤ MAX_PARALLEL_TOOL_CALLS in flight) | 'sequential' (in order,
  // stop-on-failure) | 'off' (no prompt affordance; tolerated batches run serially).
  // Singular-only actions: Return, expandPreviousResult.
  status?: string // User-facing message. Optional (#144) — omittable on the terminal turn, where nothing is in progress.
  is_final?: boolean // simpleLoop: exits the loop. actorCritic: cannot exit (critic owns that), but is an advisory *critic trigger* — see criticCadence.
  // Optional (#159), DEFAULT FALSE: the patterns normalise an absent value to `false` via
  // `normalizeControllerAction()` before anything reads it, so absence can never end a loop or
  // claim finality — `tool_name: 'Return'` stays the independent terminal signal.
}

// Critic result for actor-critic pattern
interface CriticResult {
  is_sufficient: boolean
  explanation: string
  suggested_approach?: string
}

// Compact reference to a tool result from a prior turn (for cross-turn memory)
interface PriorResult {
  ref_id: string // Event ID — LLM passes as ref:<ref_id> in tool args
  tool: string // Tool that produced the result
  summary: string // LLM-generated summary or truncated preview
}
```

## Context Flow

How UnifiedContext flows through the system:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           UnifiedContext                                 │
│  sessionId, createdAt, status, input, data: T, events: ContextEvent[]  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  harness(pattern1, pattern2, ...)                                       │
│    1. createContext(input, initialData, sessionId)                      │
│    2. Adds 'user_message' event                                         │
│    3. Calls chain(ctx, patterns)                                        │
│    4. Adds 'assistant_message' event on done                            │
│    5. Returns { response, context, serialized }                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  chain(ctx, patterns)  ─── for each pattern:                            │
│                                                                         │
│    ┌──────────────────────────────────────────────────────────────┐    │
│    │  1. createScope(patternId, data)  ← isolated workspace        │    │
│    │  2. createEventView(ctx, viewConfig, patternId)  ← scope-aware │    │
│    │  3. enterPattern() → adds 'pattern_enter' event               │    │
│    │  4. pattern.fn(scope, view) → pattern writes to scope.events  │    │
│    │  5. commitEvents(ctx, scope, strategy) → merge to ctx.events  │    │
│    │     (lifecycle events always committed; strategy applies to    │    │
│    │      content events only)                                      │    │
│    │  6. exitPattern() → adds 'pattern_exit' event                 │    │
│    │  7. currentData = scope.data  ← forward data to next pattern  │    │
│    └──────────────────────────────────────────────────────────────┘    │
│                                                                         │
│    Stops early if ctx.status !== 'running'                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Insight: Scope Isolation

**Patterns write to scope, never directly to context.** This enables:

- **Rollback on error** - If a pattern fails, its events aren't committed
- **Configurable commit strategies** - Control when/what gets persisted
- **Clean separation** - Each pattern has its own workspace

**Lifecycle events** (`pattern_enter`, `pattern_exit`) are always committed to ctx regardless of commitStrategy. Only content events (tool_call, tool_result, etc.) are subject to strategy filtering.

**Sub-pattern delegation**: `routes()` creates a child scope for dispatched sub-patterns, ensuring events are tagged with the sub-pattern's ID (not the routes wrapper). This is critical for `fromLastPattern()` to correctly resolve the preceding pattern.

### Session Persistence

The entire event stream persists, enabling multi-turn conversations:

```typescript
// End of turn → serialize
const result = await agent('query')
store(result.serialized) // JSON string of full context

// Next turn → continue
const continued = await continueSession(serialized, patterns, 'follow-up')

// After approval → resume
const resumed = await resumeHarness(serialized, patterns, true)
```

## API Reference

### `Tools()`

Fetch MCP tools and group by server namespace.

```typescript
const tools = await Tools()
tools.neo4j // ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema']
tools.web // ['search', 'fetch', 'fetch_content']
tools.graph // app-side, per-user (see below)
tools.all // all tool names
```

**Three transports.** `callTool()` routes a tool name to whichever transport
owns it: the **sandbox** (in-VM, when a `withSandbox` scope is active), an
**app-side** in-process tool, or the **MCP gateway** (the default). App-side
tools exist for calls that carry a per-user credential resolved server-side —
the gateway executes every user's calls as one shared principal, so it cannot
express per-user identity. They are registered via `registerAppTool()` in
`lib/app-tools/` and advertised by `listTools()` alongside gateway tools, so
patterns and agents treat them identically. See
[`docs/MICROSOFT_GRAPH.md`](../../../../docs/MICROSOFT_GRAPH.md).

### `simpleLoop(controller, tools, config?)`

ReAct-style decide-execute loop. Calls BAML controller directly. A turn is
usually one tool call, but the controller may emit a **multi-call turn**
(`additional_calls`) — see `multiToolCalls` below.

```typescript
simpleLoop(b.Neo4jController.bind(b), tools.neo4j, {
  patternId: 'neo4j-query',
  schema,
  maxTurns: 5,
})

interface SimpleLoopConfig extends PatternConfig {
  schema?: string // Injected as context to controller
  maxTurns?: number // Default: 5
  rememberPriorTurns?: boolean // Include prior tool results (default: true)
  priorTurnCount?: number // How many prior user turns (default: 3)
  includeFailedResults?: boolean // Include failed tool results in prior context (default: false)
  fewShots?: FewShot[] // Domain-specific examples rendered into the LoopController prompt
  onToolResult?: OnToolResult // Enrich/transform tool results before they're committed (see "Hooks" below)
  resultOmit?: Record<string, string[]> // Per-tool fields hidden from the controller turn log (see below)
  multiToolCalls?: 'parallel' | 'sequential' | 'off' // Multi-call turns (default: 'parallel'; see below)
  returnStyle?: 'summary' | 'answer' // What the terminal `Return` carries (default: 'summary'; see below)
}

interface FewShot {
  user: string // Example user request
  reasoning: string // Reasoning the agent followed
  tool: string // Tool name selected
  args: string // JSON-encoded tool arguments
}

type OnToolResult = (
  toolName: string,
  result: { success: boolean; data: unknown; error?: string },
  context: { callId?: string; args: unknown },
) => Promise<{ data?: unknown } | void> | { data?: unknown } | void
```

**Few-shot examples.** `fewShots` is a per-pattern config knob that injects an `EXAMPLES`
block into the controller prompt. Best for routes with a narrow tool surface where the
LLM benefits from seeing the canonical query shape (e.g., parameterized Cypher with
`MERGE` semantics, bulk `UNWIND` patterns, idiomatic `toLower()` substring search).
Keep the list short (3-5) — the prompt grows with every shot and is sent on every turn.
See `app/src/lib/harness-client/agents/neo4j-fewshots.server.ts` for a worked example
verified against the live Neo4j MCP.

**Hooks: `onToolResult`** (closes #7). Called between `callTool()` and the
`tool_result` event being committed, so the hook can enrich or transform the tool's
output before downstream patterns and the UI see it. Returning `{ data }` replaces
`result.data`; returning `void` leaves it unchanged. Failures are non-fatal — the
loop logs an `error` event with severity `recoverable` and proceeds with the
original result.

```typescript
import { enrichNeo4jResult } from '../harness-client/neo4j-enricher.server'

simpleLoop(neo4jController, tools.neo4j, {
  patternId: 'neo4j-query',
  fewShots: NEO4J_FEW_SHOTS_DEFAULT,
  onToolResult: enrichNeo4jResult,
})
```

The `enrichNeo4jResult` recipe (`app/src/lib/harness-client/neo4j-enricher.server.ts`)
walks the tool's returned rows for `name` strings, fetches a 1-hop neighborhood
directly via the `neo4j-driver` singleton, and emits an enriched payload of shape
`{ rows, _neighborhood: { rows }, _touched: [...names] }`. The graph extractor
recognizes that shape, dedups across the rows + neighborhood, and tags each
node whose name is in `_touched` with `data.touched = true` so the Neo4j panel
can highlight what the agent actually queried (vs. surrounding context).
The same hook is also wired into `actorCritic`.

**Compact controller view: `resultOmit`.** A per-tool omit-list applied to the
CONTROLLER TURN LOG only — the named fields are deleted (recursively, at every
object level including array elements) from the result the loop LLM reads. The
`tool_result` event keeps the full result, so the compactExecution, citation
extractors and session persistence are untouched. Use it for fields only the
final answer needs — e.g. the Microsoft 365 agent drops `webUrl` (519 chars per
Loop hit) from file-tool results while its compactExecution still renders the links:

```typescript
simpleLoop(controller, graphTools, {
  patternId: 'microsoft-365',
  resultOmit: { graph_files_search: ['webUrl'], graph_files_list: ['webUrl'] },
})
```

Also applied when `expandPreviousResult` replays a prior result, keyed by that
result's _origin_ tool. NOT applied to `ref:` substitution into real tool args —
those are actual tool inputs, and the args record must stay faithful to the call
that was made.

**Multi-call turns: `multiToolCalls`.** The controller may put calls 2..N of a
turn in `ControllerAction.additional_calls` (call 1 stays in
`tool_name`/`tool_args`), collapsing M independent lookups from M×(controller
LLM call + tool call) into ONE controller call. Three modes:

- `'parallel'` (default) — the prompt advertises _independent_ calls; the loop
  runs them concurrently (≤ `MAX_PARALLEL_TOOL_CALLS` = 4 in flight). A failed
  sub-call reports per-call; the others still run.
- `'sequential'` — advertised, but calls run strictly in order: a later call
  sees earlier calls' _side effects_ (files, state), never their _outputs_. The
  first failure skips the rest of the batch (`__skipped`). For linear
  effect-chains — the sandbox agents use this.
- `'off'` — no prompt affordance. The schema field is shared by every agent, so
  an un-advertised batch can still arrive; it is tolerated and executed
  serially, never punished.

The whole batch records as ONE `LoopTurn` (so `maxTurns` counts turns, not
calls): the assistant history replays `additional_calls` exactly as emitted,
and `tool_result.result` is an index-keyed map — `{"1": {tool, result}, "2":
{tool, __error}, ...}` (the `expandPreviousResult` multi-ref shape). Per
sub-call, one `tool_call`/`tool_result` event pair is tracked with a shared
`batchId`, so observability, the compactExecution and graph extraction keep full
per-tool fidelity. Partial failure → the loop continues (the controller retries
just the failures); ALL sub-calls failed → the usual recoverable-error break
path. `Return` and `expandPreviousResult` are singular-only — inside a batch
they get a per-call error.

**Who writes the final answer: `returnStyle`** (#149). The loop's terminal
`Return` prose never reaches the user. It does travel to `Synthesize` —
`compactExecution` maps the terminal iteration to `tool_call.args` and
fabricates a `tool_result` for it (result `null`), so that turn renders as
`Tool: Return / Result: null` — but the template renders `tool_result.tool` /
`.result` only and **never `tool_call.args`**, which is the single guard to
preserve if the template ever grows a call-args section (issue #149 §2). So the
downstream `compactExecution` composes the user-facing answer from the tool
results either way. Measured on a 5-turn web-search run, composing it in the
loop as well cost **2,134 output tokens and ~22s** (the run's most expensive
turn) for a text nothing read.

- `'summary'` (default) — the prompt asks for a one-or-two-sentence completion
  summary: the cheapest text that still terminates the loop.
- `'answer'` — the pre-#149 wording ("put the complete answer in tool_args").
  **Prompt-only**: the loop still sets no `data.response`, so a downstream
  `compactExecution` remains the author. For a loop whose Return prose is itself
  the deliverable — e.g. a custom `synthesize` that reads
  `loopHistory.iterations[].action`. Making the loop's answer _suppress_
  synthesis is #149 Option B and is deliberately not built.

The default is safe because `compactExecution` is the better-informed author in
every shipped chain: it reads results at full fidelity (no `maxResultChars`
clip, no `resultOmit` projection — `microsoft-365` hides `webUrl` from its
controller _because_ the compactExecution renders the links), across patterns,
with `view.hasErrors()` for honest error reporting and the FIDELITY /
no-fabricated-URL rules. The style is agent-static, so it renders inside the
cached prompt head (system block + tier 1) at no per-turn cost.

**How it works:**

1. Extract params from context: `input`, `intent`, `previous_results`, `turn`
2. Call BAML controller with extracted params (+ optional schema)
3. Execute returned tool via MCP
4. Loop until `is_final` or max turns
5. Prior tool results from earlier turns are passed as `turns_previous_runs: PriorResult[]` — a structured array separate from the current task's `turns`. The LLM can reference them with `ref:<ref_id>` in tool args; `resolveRefs()` auto-expands before MCP execution. Controlled by `rememberPriorTurns` (default: true) and `priorTurnCount` (default: 3).
6. Controller errors are caught per-iteration — loop exits gracefully with partial results; errors are tracked as events and read by downstream patterns via `view.hasErrors()` / `view.lastError()`, scoped by ViewConfig (so they naturally expire with the view window)
7. After the response reaches the user, `compactBulkData()` runs in the background: it summarizes the turn's `tool_result` events with the describe-tier client and stores each summary on its event. These summaries appear as `PriorResult.summary` on subsequent turns. See [Batched bulk-data compaction](#batched-bulk-data-compaction) for how N results become one call.

### `actorCritic(actor, critic, tools, config?)`

Generate-evaluate loop with retry: the actor proposes a tool call, the loop
executes it, and the critic decides whether to stop or feed the result back.

```typescript
actorCritic(b.ActorController.bind(b), b.Critic.bind(b), tools.all, {
  patternId: 'actor-loop',
  maxRetries: 3,
})

interface ActorCriticConfig extends PatternConfig {
  maxRetries?: number // Default: 3
  onToolResult?: OnToolResult // Same shape + semantics as in SimpleLoopConfig
  criticCadence?: number // Default: 1 (critic every turn). See below.
  multiToolCalls?: 'parallel' | 'sequential' | 'off' // Same semantics as simpleLoop's (see above);
  // a batch records as ONE Attempt whose result is the combined map
  // the critic evaluates. Sandbox agents use 'sequential'.
}
```

**How it works:**

1. Actor generates script/action
2. Execute via MCP
3. Critic evaluates result
4. Retry with feedback if insufficient
5. Exit when sufficient or max retries

**`criticCadence` — let the actor free-run a multi-step sequence.** By default
(`1`) the critic runs after every successful turn. This interrupts multi-step
deliverables mid-plan: the actor writes a script, and the critic — the loop's
_sole_ exit authority — can wrongly accept the written-but-unrun script as "done"
(observed live: a report loop exited with no `.docx` because the critic judged the
generator script before it ran). With `criticCadence: N` the actor free-runs and
the critic evaluates only (a) every Nth successful turn, (b) when the actor sets
`is_final: true` ("I think I'm done" — it still can't exit by itself; the critic
verifies), and (c) on the final attempt. This is the composable "actor free-runs,
judge gates exit" shape without a second pattern. `is_final` is thus an advisory
critic _trigger_ here, never an exit. With `N > 1`, `maxRetries` bounds actor
turns (tool steps), not critic calls; values `< 1` are clamped to `1` so the
critic can never be disabled.

### `parallel(...patterns)`

Execute multiple patterns concurrently via `Promise.allSettled`, then merge results.

```typescript
parallel(
  simpleLoop(b.WebSearchController.bind(b), tools.web ?? [], { patternId: 'web-search' }),
  simpleLoop(b.Neo4jController.bind(b), tools.neo4j ?? [], { patternId: 'kg-lookup', schema }),
)
```

**How it works:**

1. Each branch gets an isolated child scope (`events: []`, same `data`)
2. All branches run concurrently via `Promise.allSettled`
3. Fulfilled branches: events wrapped with `pattern_enter` / `pattern_exit` markers, then merged into parent scope
4. Rejected branches: tracked as `error` events, don't block other branches

### `guardrail(pattern, config)`

Wrap a pattern with validation rails (input → execution → output) and optional circuit breaker.

```typescript
interface GuardrailConfig extends PatternConfig {
  rails: Rail[]
  circuitBreaker?: { maxFailures: number; windowMs: number; cooldownMs: number }
}
```

**How it works:**

1. Input rails run before the pattern — can block or redact the input
2. The inner pattern executes; its events are wrapped with `pattern_enter` / `pattern_exit`
3. Output rails run after — can warn, retry, or block on bad results
4. Circuit breaker (redis-backed) trips after N failures in a rolling time window

**Two caveats before you reach for it** (they are why `withInjectionGuard` is a
separate primitive rather than a rail): rails declared `phase: 'execution'` are
never dispatched — only `'input'` and `'output'` are filtered and run, so the
shipped `pathAllowlistRail` is dead code — and input rails read
`scope.data.input`, which nothing in the framework populates, so `piiScanRail`
always scans `''`.

### `withInjectionGuard(config)(pattern)`

Neutralize prompt injection carried in **untrusted tool-result content** before
it reaches any LLM-visible surface. Defensive, opt-in per agent.

```typescript
withInjectionGuard({ namespaces: ['web'] })(
  simpleLoop(webController, tools.web, { patternId: 'web-search' }),
)

interface InjectionGuardConfig extends InjectionGuardOptions {
  namespaces?: string[] // inferServer() names treated as UNTRUSTED
  tools?: string[] // explicit per-tool opt-in, added to namespaces
  spotlight?: 'on-detection' | 'always' | 'off' // default 'on-detection'
  screen?: InjectionScreen // optional LLM second opinion; OFF by default
  rules?: InjectionRule[] // extra rules appended to the corpus
  disableRules?: string[] // corpus rule ids to switch off
}
```

**Threat model.** `tool_result` content from an untrusted source (web search, a
fetched page, a SharePoint/ms-graph document, a retrieved Data Stash chunk) that
carries text addressed to the model: "ignore previous instructions", a forged
`system:` turn, tool-call steering, "do not tell the user", hidden text in a
document, or a crafted URL that exfiltrates data when the answer is rendered.
**Out of scope:** user-typed input (the user is the principal, so it is trusted),
auth, and sandbox network egress (#116).

**Where it hooks — two paths, one guard.** It is an AsyncLocalStorage wrapper in
the shape of [`withSandbox`](../../../../docs/plan/sandbox.md), not a chain step:
a chain step runs before or after the loop, so it could only ever see content the
controller has already read. Enforcement therefore happens where untrusted
content is produced:

1. **`callTool` (primary)** — the outermost layer of `mcp-client.callTool`, so it
   covers all three transports (gateway, app-side, sandbox in-VM) and every
   pattern. Critically it also covers the **controller turn log**, which
   `simpleLoop` / `actorCritic` build from `result.data` and NOT from the event
   stream — a guard hooked at `trackEvent` time would sanitize the stored event
   and still feed the raw injection to the controller on that same turn.
2. **`retriever` (second path)** — a retriever calls its injected backends
   directly and emits its own `tool_result`, so retrieved chunks never reach
   `callTool`. It sanitizes its hits at write-time through the same guard
   (`sanitizeHits`), before `scope.data.matches` is set and before the event
   exists. Opt in with `namespaces: ['retriever']`.

Both the `data` and the `error` channel are sanitized at the chokepoint:
`demoteErrorString` turns a SUCCESSFUL result whose text starts with `Error:`
into `{ success: false, error: <that text> }`, so for an untrusted tool the error
field can carry fetched page content — and it reaches an LLM via the controller
turn log, `formatEventData`'s `"<tool> ERROR: …"` and `view.lastError()`.

Nothing in between (`chain`, `router`, `routes`, `parallel`, `withReferences`)
needs to be guard-aware. Nesting **unions**: an inner wrapper ORs the enclosing
guard's `isUntrusted`, so it can only widen coverage — shadowing would let a
narrow inner wrapper silently remove an outer one's protection.

**Event ordering caveat.** The guard emits into the wrapper's own scope, so when
it wraps a scope-forking pattern (`routes`, `parallel` — 2 of the 4 wired
agents) a `content_sanitized` event lands in `ctx.events` _before_ the child's
`pattern_enter` and before the `tool_result` it annotates. Timestamps are
correct and the ObservabilityPanel sorts by `ts`, so the timeline reads right;
only a positional reader of `ctx.events` would see the skew, and no LLM-facing
serializer depends on this event's position.

**Detection + neutralization.** Deterministic first, and **the default path
contains no LLM call**: a classifier in front of every tool result is itself
injectable, costs a call and seconds of latency per result, and cannot be pinned
by a unit test. Layers, in order (`injection-guard.ts`):

| Layer             | Action                                                                                                             | Lossless? |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | --------- |
| `sentinel-escape` | Strips the guard's own fence chars from content — so data can never forge a marker or close the fence. Runs FIRST. | yes       |
| hidden-text       | Removes zero-width, bidi-override and U+E0000 tag characters                                                       | yes       |
| instruction       | Replaces each matched span with `⟦neutralized:<rule>#n⟧`                                                           | no        |
| exfil-url         | Defangs auto-loading images / remote-resource tags / data-bearing URLs to inert backticked literals                | no        |
| spotlight         | Fences the result and labels its provenance ("data, never instructions")                                           | no        |

Detection alone is useless — a flagged-but-forwarded injection still reaches the
model — so **every finding rewrites the text**. The hidden-text strip covers the
zero-width, bidi and U+E0000 blocks plus the soft hyphen; it deliberately does
**not** strip variation selectors (`FE00`–`FE0F`) — they are combining marks, so
a character class holding them is a `no-misleading-character-class` error, and
removing them would mangle ordinary emoji for no gain, since they modify a
visible glyph rather than hide text. The instruction rules match across line
breaks, because extracted document text hard-wraps.

#### Backtracking discipline (measured, not asserted)

A sanitizer its own input can DoS is not a control. The catastrophic shape is
**two variable-length runs separated only by an optional token** — the engine
then tries every way of splitting the input between them, which is quadratic.
Two rules shipped with it: `exfil-html-tag`'s `\s*\/?\s*`, and
`instruction-turn-spoof`'s `^[ \t]*#{0,3}[ \t]*`, which took **30s of
synchronous CPU on a 200k-space line** — one fetched page, one hung Node
process. So **every variable-length run with anything after it in the pattern is
bounded**: whitespace to `{0,8}`/`{1,8}`, free text to `{0,40}`–`{0,2000}`.

Exactly two quantifiers are left unbounded, both **terminal** — nothing follows
them, so a greedy run has nothing to backtrack _for_ and it is provably linear:
`exfil-instruction`'s trailing `[^\s)<>"']+` and `exfil-data-url`'s trailing
`[A-Za-z0-9+/=_-]{64,}`, each consuming a URL to its end. Bounding those would
only truncate the match and leave a live URL tail outside the marker.

Worst case per rule over `{200k spaces, 200k tabs, 200k of the rule's own
trigger, trigger + 200k spaces, trigger + 200k tabs, a bare-whitespace line
inside a page}`, `test()` + `replace()`, Node 22 / M-series:

| Rule                                                                                                 | Before   | After   |
| ---------------------------------------------------------------------------------------------------- | -------- | ------- |
| `instruction-turn-spoof`                                                                             | 30,332   | **0.5** |
| `exfil-auto-image`                                                                                   | 71.3     | 71.3    |
| `exfil-data-url`                                                                                     | 41.8     | 41.8    |
| `instruction-override`                                                                               | 6.2      | 6.2     |
| `sentinel-escape`                                                                                    | 4.5      | 4.5     |
| `instruction-prompt-extraction`                                                                      | 2.9      | 2.9     |
| `hidden-invisible`                                                                                   | 1.7      | 1.7     |
| `hidden-tag-chars`                                                                                   | 1.2      | 1.2     |
| `exfil-html-tag`                                                                                     | 1.0      | 1.0     |
| `instruction-new-directive` · `-role-reassign` · `-secrecy` · `-tool-steering` · `exfil-instruction` | ≤0.5     | ≤0.5    |
| **whole corpus, worst shape per rule**                                                               | >120,000 | **133** |

`exfil-auto-image` and `exfil-data-url` are the slowest survivors at ~70ms and
~42ms, and both are strictly **linear** (doubling the input doubles the time:
9.4 → 18.4 → 37.8 → 73.6ms across 50k → 400k) — many cheap bounded matches, not
backtracking. `injection-guard-redos.test.ts` re-runs this whole grid on every
rule under a hard **2s total budget**, so the corpus is bounded by test rather
than by claim: a new rule with an unbounded interior run fails CI. The same test
covers `createInjectionScreen`'s prompt de-fencing regex, whose `-{2,}\s*` pair
was the same shape (100k hyphens → 10.1s) and which additionally ran on the
**full** payload before `maxChars` truncation; it now truncates first and anchors
on the keyword rather than the hyphen run, which also closes an evasion (the old
pattern required ≥2 hyphens, so an undecorated `BEGIN UNTRUSTED CONTENT` slipped
through while still reading as a fence to the screening model).

**Clean content is byte-identical** — the same reference comes back, and
`spotlight` defaults to `'on-detection'` for exactly that reason: the
overwhelmingly common case must cost zero tokens and carry zero mangling risk.
`spotlight: 'always'` fences unconditionally for agents that want it.

> **`neutralized` is not a synonym for "detected".** `spotlight: 'always'` makes
> the LLM-visible content differ from the source on _every_ result — it was
> fenced — so `SanitizeReport.neutralized` is true even when the corpus found
> nothing. Read **`findings.length`** for "did we detect something?". Conflating
> the two was a live fail-open: the guard gated the LLM screen on `neutralized`,
> which silently switched the screen off entirely for the agents that asked for
> the strictest spotlight, and emitted a `findings: []` `content_sanitized` event
> on every single tool result. A fence-only result now returns its fenced content
> with **no** event and **no** `sanitized` annotation (the fence states its own
> provenance in the text; a finding-less event only buries the real ones), and
> callers test `data === input` — not `summary` presence — for "did it change?".

**Optional LLM screen (off by default).** `screen` takes an `InjectionScreen`;
`createInjectionScreen()` (baml-adapters) is the BAML-backed one, on the cheap
`DescribeAnthropic` client — in BOTH routing modes: the `screen` role is pinned
in `clients.server.ts` (like the planner) and never follows `describe` onto the
mixed `DescribeFallback` chain, whose first leaf is the weakest model in the
repo (SA-M5). The guard calls it **only for content the
deterministic layer passed clean** — i.e. gated on `findings.length === 0`, see
the note above — so the two layers divide labour: regexes catch known phrasings,
the screen catches novel ones. A verbatim span it quotes is neutralized like a
regex match; a span it paraphrased (matching nothing) still forces the fence, so
a verdict never degrades to silence. A screen that throws is non-fatal — the
deterministic verdict stands and the outage is recorded on the event (the one
case where a finding-less `content_sanitized` is still emitted, because a
silently degraded second layer must be visible).

**On detection: neutralize + annotate + emit, never silently drop.**

- `result.data` / the retrieved chunk carries the neutralized text
- `ToolResultEventData.sanitized` annotates the affected result with a
  **`SanitizeSummary`** — counts, rule ids and the `content_sanitized` event id,
  never the spans. That split is load-bearing: `judge` does
  `JSON.stringify(event.data)` over `tool_result` events and its chosen candidate
  becomes `scope.data.response`, which `compactExecution` puts into the
  `Synthesize` prompt — a full report there would turn a neutralized mid-loop
  injection into a synthesizer-stage one
- a **`content_sanitized`** event lands in the timeline (orange 🛡️ in the
  ObservabilityPanel, with a per-finding detail view), and is in
  `ALWAYS_COMMIT_TYPES` so a later failure cannot discard the proof a control
  fired

**The verbatim-span invariant.** Neutralization is destructive at source: the
event store holds the sanitized text, because the store IS LLM-visible via `ref:`
expansion, `serializeCompact()` and `compactExecution` — keeping the raw text there
would leave the hole open. The removed spans survive **only** in
`findings[].match` on the `content_sanitized` event, which is human-visible in
the panel and rendered into **no** LLM-facing serialization: `formatEventData`
has an explicit `content_sanitized` case emitting metadata only, precisely
because its `default:` branch JSON-dumps whole payloads and would otherwise hand
the injection straight back to a model. Anything attached to a `tool_result` is
redacted by type (`SanitizeSummary`), which is what keeps `judge` and any future
whole-payload serializer safe by construction. Pinned by
`injection-guard-composition.test.ts`, which sweeps `serialize()`, both
`serializeCompact()` branches, `judge`'s projection and the committed stream, and
asserts the span occurs exactly once.

**Config transparency.** The wrapper spreads `...pattern`, so the inner
pattern's `config` (commitStrategy, trackHistory, viewConfig, `estimateTurns`)
governs everything unchanged and the inner pattern runs in the SAME scope — no
extra lifecycle events, no change to `view.fromLastPattern()`. On a clean run
there is no observable difference at all. `children` is exposed, so static
introspection (`harnessHasRedisRetriever`, `harnessUsesSyncWorkspace`) still sees through it,
and the declared trust boundary is readable off
`ConfiguredPattern.injectionGuard` (`{ namespaces, tools }`) — a sibling field,
NOT part of `config`, so config identity is preserved. That field is what lets a
test assert an agent's namespace list instead of merely that a wrapper exists.

**Nesting only ever tightens.** Guards nest through AsyncLocalStorage, and
`createInjectionGuard` reads the enclosing guard at construction to take the
**strictest** of every dimension — never to shadow it. Unioning the namespaces
alone was not enough: once an inner guard widens the boundary, it is the inner
guard's config that sanitizes the outer guard's namespaces too, so an inner
`disableRules` re-opened a hole for tools the inner wrapper never mentioned.

| Dimension            | Nesting rule                                  | Why                                                                                      |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `namespaces`/`tools` | union (OR of `isUntrusted`)                   | a narrow inner wrapper must not drop the outer one's coverage for its whole subtree      |
| `disableRules`       | **intersection** — off only if _both_ agreed  | it is one agent's false-positive escape hatch, not a licence over the enclosing boundary |
| `rules`              | union, deduped by id                          | extra detection is always safe to inherit                                                |
| `spotlight`          | strictest (`always` > `on-detection` > `off`) | an inner default must not remove a fence the outer wrapper asked for                     |
| `screen`             | kept if _either_ has one (inner wins if both) | a nested guard cannot remove a paid-for second layer                                     |

Per-**call** `overrides` still win, because they are a local decision by a known
call site (the retriever passes `spotlight: 'off'` for a filename, where a
multi-line fence would break the citation label and the docId match) rather than
an agent-level config that could silently weaken a boundary it does not own.
There is deliberately no way to ask for narrowing.

**Wired agents** (their untrusted namespaces are declared at each agent
definition, deliberately not in a shared default):

| Agent                   | Untrusted namespaces        | Not guarded             |
| ----------------------- | --------------------------- | ----------------------- |
| `default`               | `web` (that route only)     | `neo4j` — our own graph |
| `microsoft-365`         | `graph`                     | —                       |
| `multi-source-research` | `web`, `github`, `context7` | —                       |
| `retriever`             | `web`, `retriever`          | `neo4j`                 |

> Compare [`guardrail()`](#guardrailpattern-config): that pattern's output rails
> run only AFTER the inner pattern completes, and a `RailResult` can block, warn
> or retry but never REWRITE content — so it cannot stop injection mid-loop.
> The two compose; they solve different problems.

### `hook(pattern, config)`

Wrap a pattern as a lifecycle hook. Optionally runs in the background without blocking the main chain.

```typescript
interface HookConfig extends PatternConfig {
  trigger: 'session_close' | 'error' | 'approval_timeout' | 'custom'
  background?: boolean // fire-and-forget via queueMicrotask
}

const distillHook = hook(distillChain, {
  patternId: 'session-close-hook',
  trigger: 'session_close',
  background: true,
})
```

**How it works:**

- `background: true` — schedules the inner pattern via `queueMicrotask` and returns immediately
- `background: false` (default) — runs synchronously; inner events are wrapped with `pattern_enter` / `pattern_exit`

### `withReferences(pattern, config?)`

Wrap a pattern so that on entry, an LLM-driven selector picks relevant prior
`tool_result` events from the visible event stream and attaches them to the
inner pattern's `priorResults` channel via `scope.data.attachedRefs`. The
adapter merges these into BAML's `turns_previous_runs` argument — **zero
controller-prompt changes**.

```typescript
withReferences(simpleLoop(b.Neo4jController.bind(b), tools.neo4j, { schema }), {
  scope: 'global',
  maxRefs: 5,
})
```

**Config:**

| Field      | Type                 | Default                            | Notes                                                 |
| ---------- | -------------------- | ---------------------------------- | ----------------------------------------------------- |
| `scope`    | `'self' \| 'global'` | `'global'`                         | `'self'` = only the wrapper's own `patternId`.        |
| `source`   | `string \| string[]` | —                                  | Explicit `patternId` allow-list. Overrides `scope`.   |
| `maxRefs`  | `number`             | `5`                                | Cap on attached refs after selection.                 |
| `selector` | `SelectorFn`         | LLM-driven (`b.ReferenceSelector`) | Override for tests, evals, or deterministic policies. |

**Skip optimizations** — the selector is bypassed when:

- the eligible stash is empty → `skipped: 'empty'`, no refs attached
- there is exactly one candidate → `skipped: 'single'`, attached unconditionally
- a cache hit on `(intent_hash, stash_snapshot_hash)` → `skipped: 'cached'`, prior decision reused

Each entry exit emits a `reference_attached` event with `{ candidates, selected, reasoning, skipped? }` for observability.

**Composes with `expandPreviousResult`.** The wrapper attaches _compact_ refs (summary only). Inside the loop, the controller can either:

- pass `ref:<ref_id>` as a tool argument — the system inlines the full data into that tool's args before dispatch, **or**
- call the synthetic `expandPreviousResult` tool (auto-injected by simpleLoop when prior results are present) with `tool_args = ref:<ref_id>` to load the full content into a turn record.

Either path records an `expansions[]` entry on the `LoopTurn`; the compact ref entry then renders `(expanded in turn N)` so the controller doesn't redundantly re-expand.

```typescript
// Default agent migration (excerpt from agents/default.server.ts)
const routesPattern = routes<SessionData>({
  neo4j: withReferences(neo4jPattern, { scope: 'global' }),
  web_search: withReferences(webPattern, { scope: 'global' }),
})
```

### `compactExecution(config)`

Synthesizes final response from previous pattern's output using BAML `CreateToolResponse`.

```typescript
compactExecution({ mode: 'thread', patternId: 'response-synth' })

// Three modes
compactExecution({ mode: 'message' }) // Receives only response string
compactExecution({ mode: 'response' }) // Receives { data, response } object
compactExecution({ mode: 'thread' }) // Receives full loop history

// Custom synthesis function
compactExecution({
  mode: 'response',
  synthesize: async (input) => `Found: ${input.response}`,
})
```

### `compactIntent(config?)`

Rewrites the latest user message into a self-contained `scope.data.intent` brief
before a router-less actor runs. The chain-based counterpart to `router` (which
sets `data.intent` as a side-effect of classification) — `compactIntent` strips
the classification, leaving only the rewrite. Writes the same carrier
`actorCritic` / `simpleLoop` already read (`scope.data.intent ?? userContent`),
so there is **no controller-prompt change**.

```typescript
chain(
  compactIntent({ viewConfig: { fromLastNTurns: 5 } }),
  withSandbox({ id: sessionId })(actorCritic(actor, critic, [], { … })),
  compactExecution({ mode: 'thread' }),
)

type CompactIntentConfig = PatternConfig
```

**How it works:**

1. Reads recent message history from its view (default `viewConfig`:
   `{ fromLast: false, fromLastNTurns: 5, eventTypes: ['user_message', 'assistant_message'] }`,
   think-blocks stripped — mirrors `router`).
2. Splits into the latest user message + prior history, then calls BAML
   `CompactIntent` on the cheap `DescribeAnthropic` client (one call per chain
   invocation) to resolve back-references (_"try again"_, _"I can't find the
   file"_) into a standalone instruction.
3. Writes `scope.data.intent`; emits an `intent_compacted` event carrying the
   LLM call for observability (mirrors `withReferences`' `reference_attached`).

**Skip / safety:**

- **Turn 1 (no history):** skips the LLM call, passes the message through
  unchanged (`skipped: 'no-history'`).
- **Backward-safe:** on any failure it leaves `intent` unset, so the actor falls
  back to the raw user message — never fatal.

> Use it upstream of a router-less actor (e.g. the Sandbox · Session agent).
> Agents that already route don't need it — `router` fills `data.intent` itself.
> Part E of [#83](https://github.com/mknw/harness-playground/issues/83) (the
> `compact*` naming unification) is a deferred follow-up.

### `planner(tools, config?)`

Produces a natural-language plan ONCE, before any tool runs, and hands it to
the next pattern in the chain. The planner does not execute tools — it reasons
about them.

```typescript
chain(planner(tools.all), simpleLoop(controller, tools.all), compactExecution({ mode: 'thread' }))

interface PlannerConfig extends PatternConfig {
  schema?: string // Extra context (e.g. neo4j schema) — mirrors simpleLoop's
  maxPlanChars?: number // Cap on the plan text handed downstream (default 2000)
}
```

**Why.** A `simpleLoop` controller re-derives its high-level approach on every
turn. With a diverse tool surface (`tools.all` spanning `neo4j-cypher` +
`database` + `web_search` + `context7`) that re-derivation is both the
expensive part of the prompt and the part most prone to greedy, locally
coherent sequences ("search the web again" when turn 1 already pulled the
docs). The planner pays for strategy once.

**When it earns its cost:** a diverse tool surface, multi-step tasks where the
strategy is non-obvious, long-running agents where a wasted turn is expensive.
**When it doesn't:** single-namespace queries (`router` → `simpleLoop` is
enough) and conversational replies (the router's `DIRECT_RESPONSE_ROUTE`
already short-circuits).

**How the plan reaches the next pattern.** Two channels, no BAML signature
changes:

1. **`scope.data.plan: PlanResult`** — the chain forwards `scope.data` to the
   next pattern as its `currentData`. `simpleLoop` and `actorCritic` read it,
   render it with `formatPlanContext()`, and pass the string to their
   controller adapter as the **trailing optional `planContext` argument**.
   (`planContext` is appended, never inserted: the generated BAML functions
   take arguments positionally — see `warnIfCollectorEmpty`.)

   From there the two loops differ, and the difference is prompt caching:

   - **`simpleLoop`** passes it as its own BAML parameter, `plan_context`,
     which `LoopController` renders in **tier 2** (run-static: plan · intent ·
     instructions · prior results). It must NOT ride `context`: `context` is
     tier 1, the agent-static prefix holding the tool catalog and the graph
     schema, so a per-question plan in there turns every tool-catalog cache
     read into a cache write (#122).
   - **`actorCritic`** merges it into `context` ahead of `contextPrefix`.
     Safe there: `ActorController`'s single marker already ends on the
     run-specific USER REQUEST and fires only on attempt 1, so the plan is
     constant for everything that re-reads that prefix.

   ```
   PLAN (from previous step — follow it unless a result contradicts it):
   <reasoning>
   Steps:
   <plan>
   ```

2. **`plan_created` event** — carries the plan, the tool count and a
   `truncated` flag for the observability panel and any downstream consumer
   (`view.ofType('plan_created')`). A dedicated event type, NOT
   `controller_action`: that payload is a real `ControllerAction`, and the
   compactExecution's thread mode renders every `controller_action` in view as a
   tool iteration — a synthetic one would show a tool call that never happened.

**Defaults:** `commitStrategy: 'always'` (the plan survives a downstream error),
`trackHistory: 'plan_created'`, `errorSeverity: 'recoverable'`, and a
`viewConfig` of the last 2 message turns (same shape as `router`, so a
multi-turn intent shift is visible).

**Best-effort.** On any failure the pattern CLEARS `scope.data.plan` and tracks
an `error` event; the downstream loop then runs exactly as it does without a
planner — never fatal. An empty or whitespace-only plan counts as a failure: it
injects nothing downstream, so reporting it as a success would show a planned
run that is really unplanned. When the context holds no user message the
pattern emits `plan_created` with `skipped: 'no-message'` instead — a visible
skip rather than silence, mirroring `intent_compacted.skipped`.

**Clearing matters.** `scope.data` survives the turn boundary (the harness
resets only `hasError` / `errorMessage` / `response`, and `serializeContext` is
a plain `JSON.stringify`). A path that returned the scope untouched would hand
turn 2's executor turn 1's plan — for a different question, under wording that
tells it to prefer the plan over its own judgement.

**One-shot.** Replanning on failure is out of scope: a failed step is handled by
`simpleLoop`'s own error path. `n_steps` is exposed on `scope.data.plan` as a
soft hint (steps are not tool calls) — it does not clamp `maxTurns`.

> `planner` and `router` solve different problems and compose: router is cheap
> one-of-N intent classification; planner is strategic decomposition before
> execution. `chain(router(...), routes({ x: chain(planner(...), simpleLoop(...)) }))`
> is valid. The `general` agent
> (`harness-client/agents/general.server.ts`) demonstrates the flat
> planner → simpleLoop → compactExecution chain alongside the router-based `default`.

### `retriever(config)`

A low-latency alternative to a tool-calling `simpleLoop`: instead of an LLM loop
deciding which DB tool to call (often >30s for a Neo4j loop), the retriever forms
ONE query from context and fans it out to one or more injected **backends**,
returning normalized matches-with-references for a downstream `compactExecution`.

```typescript
// Raw user message is the query; rewritten only when the turn has history.
retriever({ backends: [redisBackend], k: 5, generateQuery: true })

interface RetrieverConfig extends PatternConfig {
  backends: RetrieverBackend[] // injected DB sources (app-side)
  k?: number // max hits, default 5
  generateQuery?: boolean // RetrieveQuery rewrite, ONLY when history exists
  turnWindow?: number // no-LLM: widen the query to the last N user turns
}
interface RetrieverBackend {
  name: string
  type: 'vector' | 'keyword' | 'graph' | 'web' // only 'vector' backends embed
  search(q: { text: string; intent?: string }, opts: { k: number }): Promise<RetrievalHit[]>
}
```

**How it works:**

1. **Query**: the user's **raw last message** by default (their own words embed
   best). `generateQuery: true` rewrites it via a cheap `RetrieveQuery` (Haiku)
   call **only when the turn has history** — resolving "more on that" / "those
   sections" into a self-contained query; turn 1 is searched verbatim.
   `turnWindow: N` is a no-LLM alternative (concatenate the last N user turns).
2. **Fan-out**: `Promise.all` over the backends. A failing backend yields `[]`
   plus an `error` event (per-backend isolation) — one bad source never sinks
   the retrieval. A failed `RetrieveQuery` falls back to the raw message.
3. **Merge**: flatten, sort closest-first (`score` ascending; un-scored last),
   cap at `k`. Writes `scope.data.matches` and emits a `tool_result`
   (`tool: 'retriever'`) — the same channel `compactExecution` reads via
   `view.fromLastPattern()`.

Framework-pure: concrete backends live app-side (`app/src/lib/retriever/` —
`createRedisBackend` is live; `createSupabaseBackend` is a deferred stub). The
resolved config carries a `backendKinds: string[]` marker so
`harnessHasRedisRetriever` (pattern-capabilities) can gate the Data Stash's
auto-ingest-on-upload. **Best-effort / `recoverable`**: on total failure it
leaves `matches` empty and the compactExecution answers from the rest of context.

**Untrusted by default in practice.** Stash chunks come from INGESTED DOCUMENTS
(uploads, and ms-graph files via `graph_file_ingest`), so a poisoned document
reaches the final response as a retrieved chunk. Retriever hits never pass through
`callTool`, so the pattern sanitizes its own hits at write-time via the active
[`withInjectionGuard`](#withinjectionguardconfigpattern) — opt in with
`namespaces: ['retriever']`. Only `content` and `source` are scanned; `docId`,
`chunkIndex` and the offsets stay byte-exact so the inline file viewer still
opens at the right place.

> See [`docs/DATA_STASH.md → Harness-aware ingest`](../../../../docs/DATA_STASH.md)
> for the upload-side gate and the `redis` / `supabase` backends.

### `router(routeDescriptions, config?)`

Classifies intent via BAML and sets `scope.data.route`. The first half of the router/routes pair.

- **Tool needed** → `data.route = <toolName>`, `data.intent`, `data.routerResponse`; tracks optional `assistant_message`
- **Conversational** → `data.route = 'user'` (the `DIRECT_RESPONSE_ROUTE` sentinel), `data.response = responseText`; tracks `assistant_message` directly; downstream `compactExecution()` skips BAML

`data.intent` is a **self-contained** statement of what the user wants, not an
echo of the latest message: the router sees the last `routerTurnWindow` turns
and the prompt's INTENT FORMULATION rules make it expand back-references
("try again", "the second one", "now in TypeScript") into the nouns they refer
to ([#53](https://github.com/mknw/harness-playground/issues/53)). This matters
because `routes()` passes `data.intent` — and nothing else from the
conversation — to the dispatched pattern's controller. The router-less
equivalent is [`compactIntent()`](#compactintentconfig).

```typescript
router({
  neo4j: 'Database queries and graph operations',
  web_search: 'Web lookups and information retrieval',
})

// Custom direct-response sentinel:
router({ neo4j: '...' }, { directResponseRoute: 'conversational' })
```

```typescript
interface RouterConfig extends PatternConfig {
  directResponseRoute?: string // Default: 'user'
}
```

### `routes(patternMap, config?)`

Dispatches to the sub-pattern matching `scope.data.route`. The second half of the router/routes pair.

- `data.route === undefined` → **throws** (programming error — `routes()` must follow `router()`)
- `data.route === 'user'` → **pass-through** (conversational; compactExecution also skips BAML)
- `data.route` found in map → dispatches with `pattern_enter/exit` wrapping
- `data.route` not in map → tracks `error` event, pass-through

```typescript
routes({
  neo4j: neo4jPattern,
  web_search: webPattern,
})

// Must match router's directResponseRoute if overridden:
routes({ neo4j: neo4jPattern }, { directResponseRoute: 'conversational' })
```

```typescript
interface RoutesConfig extends PatternConfig {
  directResponseRoute?: string // Default: 'user' — must match paired router()
}
```

### `judge(evaluator, config?)`

Evaluation pattern that scores or classifies pattern output. Used for quality gates.

```typescript
judge(evaluatorFn, {
  patternId: 'quality-check',
  threshold: 0.7,
})
```

**How it works:**

1. Receives output from preceding pattern via EventView
2. Calls evaluator function to score/classify
3. Sets `data.judgment` with result
4. Can be used in actor-critic loops or standalone quality gates

### `chain(ctx, patterns, onEvent?)`

Sequential composition of patterns within a UnifiedContext. Optional `onEvent` callback is invoked for each newly committed event (used by SSE streaming).

```typescript
await chain(ctx, [pattern1, pattern2, pattern3])

// With streaming callback
await chain(ctx, patterns, (event) => {
  stream.write(`data: ${JSON.stringify(event)}\n\n`)
})
```

### `harness(...patterns)`

Compose patterns into a callable agent. Accepts optional `onEvent` callback for real-time event streaming.

```typescript
const agent = harness(routerPattern, compactExecutionPattern)
const result = await agent('Show me all Person nodes', sessionId)

// With SSE streaming
const result = await agent('query', sessionId, undefined, (event) => {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
})

interface HarnessResultScoped<T> {
  response: string
  data: T
  status: 'running' | 'paused' | 'done' | 'error'
  duration_ms: number
  context: UnifiedContext<T>
  serialized: string // JSON for session persistence
}
```

### `resumeHarness(serialized, patterns, approved)`

Resume a paused harness after approval/rejection.

```typescript
const resumed = await resumeHarness(serializedContext, patterns, true)
```

### `continueSession(serialized, patterns, newInput)`

Continue a session with new user input.

```typescript
const continued = await continueSession(serializedContext, patterns, 'Follow-up question')
```

## EventView Query API

Fluent API for filtering events from UnifiedContext:

```typescript
// createEventView accepts an optional selfPatternId (3rd arg) to exclude
// the current pattern from fromLastPattern() / fromLastNPatterns() resolution.
// runChain passes this automatically.
const view = createEventView(ctx, viewConfig, selfPatternId)

// Pattern selectors
view.fromPattern('neo4j-query')
view.fromPatterns(['neo4j-query', 'web-enrich'])
view.fromLastPattern() // Excludes self when selfPatternId is set
view.fromLastNPatterns(2) // Excludes self when selfPatternId is set
view.fromAll()

// Type selectors
view.ofType('tool_result')
view.ofTypes(['tool_call', 'tool_result'])
view.tools() // Shorthand: tool_call + tool_result
view.messages() // Shorthand: user_message + assistant_message
view.actions() // Shorthand: controller_action

// Quantity selectors
view.last(5)
view.first(3)
view.since(timestamp)
view.fromLastNTurns(3) // Rolling window: last 3 user turns

// Execution
view.get() // ContextEvent[]
view.serialize() // XML format for LLM
view.serializeCompact({ recentTurns: 1 }) // Compact pointers for older results, full for recent
view.exists() // boolean
view.count() // number
```

**Compact serialization**: `serializeCompact()` renders older `tool_result` events as compact pointers. If an LLM-generated summary exists (via `compactBulkData()`), it replaces the raw preview:

```xml
<tool_result id="ev-abc123" tool="search" compact="true">
Returned 247 results including... (12,847 chars). Use ref:ev-abc123 to access full data.
</tool_result>
```

Events within the last `recentTurns` user turns are rendered in full. Hidden or archived events (`ToolResultEventData.hidden` / `.archived`) are excluded from compact output. The LLM can use `ref:<eventId>` in tool args; `resolveRefs()` in simpleLoop auto-expands them before MCP execution (also skips hidden/archived events).

**Data Stash**: `ToolResultEventData` supports three visibility fields:

- `summary?: string` — LLM-generated summary (populated async by `compactBulkData()`)
- `hidden?: boolean` — excluded from LLM context, shown grayed-out in UI
- `archived?: boolean` — excluded from LLM context, moved to Archived section in UI

These are mutated post-commit via `enrichToolResult(ctx, eventId, { summary?, hidden?, archived? })`. The UI manages hide/archive via `POST /api/stash`.

### Batched bulk-data compaction

`compactBulkData()` (in `compactBulkData.server.ts`, called by `/api/events` once
the SSE response has been sent) folds the turn's results into **one
`ResultDescribeBatch` call per `MAX_BATCH_ITEMS` (8) results** instead of one
`ResultDescribe` call each (#83 Part E). Batches also respect an input budget of
25% of the describe client's context window, so a raised `maxResultForSummary`
splits them further rather than overflowing.

The split back out is by **echoed id**, never by list position or string
splitting: each item carries a batch-local label (`"1"`, `"2"`, …), the model
returns `{ id, summary }` pairs, and `describeToolResultsBatchOp()` maps them
back — discarding ids that were never requested, so a hallucinated label cannot
attach a summary to the wrong tool result.

Partial failure is graded, and every rung costs at most one extra call per
affected item:

| what happened                      | what compactBulkData does                                               |
| ---------------------------------- | ----------------------------------------------------------------------- |
| the batch call threw               | logs a warning, falls back to a per-item `ResultDescribe` for each item |
| the model dropped an id            | per-item call for that item only                                        |
| the model answered blank for an id | per-item call for that item only                                        |
| only one item needed a summary     | skips the batch prompt entirely — single-item path                      |

**Measured (live, `RUN_EVALS=1`, see `src/__tests__/bench/describe-batch-bench.test.ts`):**
the reliable win is request count; the token win scales inversely with payload
size, and wall clock regresses because the per-item arm already ran concurrently
while a batch generates N summaries inside one response. This is post-response
background work, so requests and tokens are what matter.

| shape                                | calls | input tokens | total tokens | wall clock  |
| ------------------------------------ | ----- | ------------ | ------------ | ----------- |
| 6 large results (payload-dominated)  | 6 → 1 | −2.1%        | +0.5%        | 2.4s → 5.2s |
| 8 small results (overhead-dominated) | 8 → 1 | −16.9%       | −9.7%        | 1.4s → 2.6s |

## Configuration System

Two orthogonal configuration axes:

| Axis               | Controls              | Options                                         |
| ------------------ | --------------------- | ----------------------------------------------- |
| **commitStrategy** | _When_ to commit      | `'always'`, `'on-success'`, `'last'`, `'never'` |
| **trackHistory**   | _What types_ to track | `true`, `false`, `EventType`, or `EventType[]`  |

```typescript
interface PatternConfig {
  patternId?: string
  commitStrategy?: CommitStrategy
  trackHistory?: TrackHistory
  viewConfig?: ViewConfig
}
```

### ViewConfig Options

Controls what events a pattern can "see" via its EventView:

```typescript
interface ViewConfig {
  fromPatterns?: string[] // Specific pattern IDs to read from
  fromLastN?: number // Last N patterns
  fromLast?: boolean // Only previous pattern (default: true)
  eventTypes?: EventType[] // Filter by event type
  limit?: number // Max events to include
  fromLastNTurns?: number // Rolling window: last N user turns
  contentTransforms?: ContentTransform[] // Read-time transforms applied in get()/serialize()
}
```

| Option                        | Effect                                                       | Example                              |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| `fromLast: true`              | See only the previous pattern's events                       | Default behavior                     |
| `fromPatterns: ['neo4j']`     | See events from specific pattern(s)                          | Cross-pattern queries                |
| `fromLastN: 3`                | See events from last 3 patterns                              | Broader context                      |
| `fromLastNTurns: 5`           | Rolling window over last 5 user turns                        | Multi-turn history                   |
| `eventTypes: ['tool_result']` | Filter to specific event types                               | Focus on results                     |
| `limit: 10`                   | Cap number of events returned                                | Limit context size                   |
| `contentTransforms: [fn]`     | Read-time event transformations (never mutates `ctx.events`) | Strip think blocks, truncate results |

**ContentTransform** is `(event: ContextEvent) => ContextEvent`. Built-in transforms in `content-transforms.ts`:

- `stripThinkBlocks` — removes `<think>...</think>` reasoning from assistant messages (router uses this by default)
- `truncateToolResults(maxChars)` — factory that truncates long tool results to N chars

A "turn" is defined by a `user_message` event. `fromLastNTurns` slices the event stream at the Nth-to-last `user_message` boundary. It is applied _before_ type filters so that boundary detection works regardless of which `eventTypes` are selected.

> **Note:** `since(ts)` is available on the fluent API (`view.since(timestamp)`) but is not a ViewConfig option.

```typescript
// Example: compactExecution needs to see tool results from neo4j pattern
compactExecution({
  mode: 'thread',
  viewConfig: { fromPatterns: ['neo4j-query'], eventTypes: ['tool_result'] },
})

// Example: router with cross-turn message history (3-turn window)
router(
  { neo4j: 'Database queries' },
  {
    viewConfig: {
      fromLast: false,
      fromLastNTurns: 3,
      eventTypes: ['user_message', 'assistant_message'],
    },
  },
)
```

**Defaults by pattern:**

- `router`: `viewConfig: { fromLast: false, fromLastNTurns: 5, eventTypes: ['user_message', 'assistant_message'] }`
- `simpleLoop`: `trackHistory: 'tool_result'`, `commitStrategy: 'on-success'`
- `actorCritic`: `trackHistory: 'tool_result'`, `commitStrategy: 'on-success'`
- `compactExecution`: `trackHistory: 'assistant_message'`, `commitStrategy: 'always'`
- `compactIntent`: `trackHistory: 'intent_compacted'`, `commitStrategy: 'always'`, default `viewConfig` of last 5 message turns
- `planner`: `trackHistory: 'plan_created'`, `commitStrategy: 'always'`, default `viewConfig` of last 2 message turns

## Event → BAML Type Mapping

Each BAML function receives a projection of the UnifiedContext event stream,
transformed into prompt-friendly types. The table below shows which harness
`EventType` values feed into which BAML input types for each pattern.

### Harness EventType → BAML Input Type

| Harness `EventType`  | Event Payload (TS)                                                                                                                     | BAML Type                                               | Consumed By                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `tool_call`          | `ToolCallEventData` (`callId?`, `batchId?`, `tool`, `args`)                                                                            | `ToolCall`                                              | `LoopTurn.tool_call`, `Attempt.action`                        |
| `tool_result`        | `ToolResultEventData` (`callId?`, `batchId?`, `tool`, `result`, `success`, `error?`, `summary?`, `hidden?`, `archived?`, `sanitized?`) | `ToolResult`                                            | `LoopTurn.tool_result`, `Attempt.result/error`, `PriorResult` |
| `controller_action`  | `ControllerActionEventData`                                                                                                            | _(embedded in `LoopTurn.reasoning`)_                    | simpleLoop, actorCritic                                       |
| `critic_result`      | `CriticResultEventData`                                                                                                                | _(embedded in `Attempt.feedback`)_                      | actorCritic                                                   |
| `user_message`       | `UserMessageEventData`                                                                                                                 | `Message { role, content }`                             | router (history)                                              |
| `assistant_message`  | `AssistantMessageEventData`                                                                                                            | `Message { role, content }`                             | router (history)                                              |
| `pattern_enter`      | `PatternEnterEventData`                                                                                                                | _(not sent to BAML)_                                    | `chain` + wrapper patterns: `parallel`, `hook`, `guardrail`   |
| `pattern_exit`       | `PatternExitEventData`                                                                                                                 | _(not sent to BAML)_                                    | `chain` + wrapper patterns: `parallel`, `hook`, `guardrail`   |
| `approval_request`   | `ApprovalRequestEventData`                                                                                                             | _(not sent to BAML)_                                    | (reserved — no active emitter)                                |
| `approval_response`  | `ApprovalResponseEventData`                                                                                                            | _(not sent to BAML)_                                    | (reserved — no active emitter)                                |
| `error`              | `ErrorEventData`                                                                                                                       | _(read via `view.hasErrors()`)_                         | compactExecution (error context), harness error handling      |
| `reference_attached` | `ReferenceAttachedEventData`                                                                                                           | _(not sent to BAML)_                                    | withReferences only (observability)                           |
| `intent_compacted`   | `IntentCompactedEventData`                                                                                                             | _(not sent to BAML)_                                    | compactIntent only (observability)                            |
| `plan_created`       | `PlanCreatedEventData`                                                                                                                 | _(the plan reaches BAML as `plan_context` / `context`)_ | planner only; loops read `scope.data.plan`, not the event     |
| `content_sanitized`  | `ContentSanitizedEventData`                                                                                                            | _(metadata only — NEVER the verbatim spans)_            | withInjectionGuard only (observability + human audit)         |

### Per-Pattern: Events Read → BAML Inputs → BAML Return

#### simpleLoop → `LoopController`

```
Events read (ViewConfig default: fromLast, trackHistory: 'tool_result')
├── controller_action  ──► LoopTurn.reasoning
├── tool_call          ──► LoopTurn.tool_call { tool, args }
└── tool_result        ──► LoopTurn.tool_result { tool, result, success, error }

BAML Inputs:
  user_message          : string           ← ctx.input
  intent                : string           ← extracted from routing or ctx.input
  tools                 : ToolDescription[]← MCP listTools() → { name, description, args_schema }
  turns                 : LoopTurn[]       ← current task turns (assembled from scope events)
  context               : string?          ← optional (e.g. neo4j schema)
  turns_previous_runs   : PriorResult[]?   ← prior turns (from viewConfig, default: last 3 turns)
  multi_call_mode       : string?          ← "parallel" | "sequential" | null, from config.multiToolCalls
                                             ('off' → null: no affordance rendered)
  plan_context          : string?          ← formatted plan from an upstream `planner` (#27)
  return_style          : string?          ← "summary" | "answer", from config.returnStyle
                                             (null renders as "summary": brief terminal Return)

BAML Return → ControllerAction:
  reasoning        : string             → stored as controller_action event
  tool_name        : string             → drives tool_call event
  tool_args        : string             → passed to MCP callTool()
  additional_calls : ToolCallRequest[]? → multi-call turn: one tool_call/tool_result event PAIR per
                                          sub-call (shared batchId), ONE LoopTurn whose result is an
                                          index-keyed map ({tool, result} | {tool, __error} |
                                          {tool, __skipped}). Partial failure → loop continues;
                                          ALL sub-calls failed → recoverable-error break path.
  status           : string?            → user-facing status
  is_final         : bool?              → terminates loop; absent is normalised to false
```

#### actorCritic → `ActorController` + `Critic`

```
Events read (ViewConfig default: fromLast, trackHistory: 'tool_result')
├── controller_action  ──► Attempt.action (full ControllerAction)
├── tool_result        ──► Attempt.result / Attempt.error
└── critic_result      ──► Attempt.feedback

BAML Inputs (ActorController):
  user_message    : string           ← ctx.input
  intent          : string           ← extracted from routing or ctx.input
  tools           : ToolDescription[]← MCP listTools()
  attempts        : Attempt[]        ← assembled from scope events per attempt
  multi_call_mode : string?          ← "parallel" | "sequential" | null, from config.multiToolCalls

BAML Return → ControllerAction (same shape as simpleLoop, incl. `additional_calls` — a multi-call
attempt records as ONE Attempt whose `result` is the index-keyed combined map the critic evaluates;
the actor cannot exit — `tool_name: 'Return'` is rejected and `is_final` only *triggers* a critic
check under `criticCadence`. Exit is the critic's call.)

BAML Inputs (Critic):
  intent   : string      ← same intent
  attempts : Attempt[]   ← same assembled attempts

BAML Return → CriticResult:
  is_sufficient      : bool    → sole termination signal; true exits the retry loop
  explanation        : string  → logged
  suggested_approach : string? → forwarded as next Attempt.feedback
```

#### compactExecution → `Synthesize`

```
Events read (ViewConfig: typically fromPatterns or fromLast)
├── tool_call    ──► LoopTurn.tool_call
├── tool_result  ──► LoopTurn.tool_result
└── error        ──► hasError / errorMessage (via view.hasErrors() / view.lastError())

BAML Inputs:
  user_message : string       ← ctx.input
  intent       : string       ← from data or ctx.input
  turns        : LoopTurn[]   ← assembled from preceding pattern events
  hasError     : boolean      ← view.hasErrors() — scoped by compactExecution's ViewConfig
  errorMessage : string?      ← view.lastError() — naturally expires with view window

BAML Return → string (assistant response text)
  → stored as assistant_message event
```

> **Error scoping**: The compactExecution reads error state from EventView, not from the data stash,
> so errors expire with the view instead of being carried forward by hand.
> The read is bounded to the CURRENT TURN by default — `viewConfig.fromLastNTurns` when the
> caller declared one, else 1. A pattern scope alone is not a turn scope: a loop keeps the
> same `patternId` every turn and `ctx.events` persist across `continueSession`, so reading
> errors off the bare view made one failed turn apologise on every turn after it.

#### compactIntent → `CompactIntent`

```
Events read (ViewConfig default: fromLastNTurns: 5, messages only)
├── user_message       ──► latest (last user_message) + history (Message[])
└── assistant_message  ──► history (Message[])

BAML Inputs:
  history : Message[]   ← prior turns' user/assistant messages
  latest  : string      ← current user_message content

BAML Return → string (the rewritten brief)
  → written to scope.data.intent
  → stored as an intent_compacted event (with the LLM call)

Turn 1 (no history): LLM call skipped, latest passes through unchanged.
```

#### planner → `Planner`

```
Events read (ViewConfig default: fromLastNTurns: 2, messages only; the
user_message itself is read via fromAll() so a narrow view can't hide it)
└── user_message  ──► user_message + intent (data.intent ?? latest message)

BAML Inputs:
  user_message : string            ← latest user_message content
  intent       : string            ← scope.data.intent ?? user_message
  tools        : ToolDescription[] ← the DOWNSTREAM executor's tool surface
                                     (+ active withSandbox in-VM tools)
  context      : string?           ← config.schema

BAML Return → PlanResult:
  reasoning : string  → rendered into the plan block
  plan      : string  → capped at config.maxPlanChars (default 2000)
  n_steps   : int     → soft hint on scope.data.plan; never clamps maxTurns
  → written to scope.data.plan
  → stored as a plan_created event (with the LLM call + the RESOLVED tool count)
  → downstream: formatPlanContext(plan) → controller `planContext`
                → simpleLoop: BAML `plan_context` (tier 2, run-static prefix)
                → actorCritic: merged into BAML `context`
```

#### router() + routes()

```
router() calls routeMessageOp() → BAML-backed intent classifier

BAML Inputs:
  message : string         ← most recent user_message content
  history : Message[]      ← from viewConfig (default: last 5 turns)
  routes  : RouteOption[]  ← { name, description } from routeDescriptions

BAML Return:
  intent           : string  → forwarded to routed sub-pattern
  tool_call_needed : bool    → selects code path
  tool_name        : string? → route key for routes() dispatch
  response_text    : string  → direct response text or routing status

Two code paths:

Conversational (tool_call_needed = false):
  → assistant_message event tracked with response_text
  → data.route = 'user' (DIRECT_RESPONSE_ROUTE), data.response = response_text
  → routes() passes through; compactExecution() skips BAML

Tool needed (tool_call_needed = true):
  → data.route = tool_name, data.intent, data.routerResponse
  → optional assistant_message if status text present
  → routes() dispatches to patternMap[tool_name] with pattern_enter/exit
```

### Conversion Reference

The pattern implementation must convert between harness events and BAML types.
Here are the field mappings:

```typescript
// ContextEvent (tool_call) → BAML ToolCall
{ tool: (event.data as ToolCallEventData).tool,
  args: JSON.stringify((event.data as ToolCallEventData).args) }

// ContextEvent (tool_result) → BAML ToolResult
{ tool:    (event.data as ToolResultEventData).tool,
  result:  JSON.stringify((event.data as ToolResultEventData).result),
  success: (event.data as ToolResultEventData).success,
  error:   (event.data as ToolResultEventData).error ?? null }

// Multi-call turns: the N events of one batch share a `batchId`; the batch's
// LoopTurn/Attempt keeps call 1 in tool_call and calls 2..N in
// additional_calls (ToolCallRequest[]: { tool_name, tool_args }), with the
// combined index-keyed map as its single tool_result.result string.

// MCPToolDescription → BAML ToolDescription
{ name:        mcp.name,
  description: mcp.description ?? '',
  args_schema: mcp.inputSchema ? JSON.stringify(mcp.inputSchema) : null }

// ContextEvent (user/assistant_message) → BAML Message
{ role:    event.type === 'user_message' ? 'user' : 'assistant',
  content: (event.data as UserMessageEventData | AssistantMessageEventData).content }
```

## Full Example

```typescript
import {
  harness,
  router,
  routes,
  simpleLoop,
  actorCritic,
  compactExecution,
  Tools,
  callTool,
  createNeo4jController,
  createWebSearchController,
  createActorControllerAdapter,
  createCriticAdapter,
} from '../harness-patterns'

async function getSchema(): Promise<string> {
  const result = await callTool('get_neo4j_schema', {})
  return result.success ? JSON.stringify(result.data) : ''
}

async function createPatterns() {
  const tools = await Tools()
  const schema = await getSchema()

  // Use adapter factories (preferred over b.bind())
  const neo4jController = createNeo4jController(tools.neo4j ?? [])
  const webController = createWebSearchController(tools.web ?? [])

  const neo4jPattern = simpleLoop(neo4jController, tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema,
  })

  const webPattern = simpleLoop(webController, tools.web ?? [], {
    patternId: 'web-search',
  })

  const routerPattern = router({
    neo4j: 'Database queries and graph operations',
    web_search: 'Web lookups and information retrieval',
  })

  const routesPattern = routes({
    neo4j: neo4jPattern,
    web_search: webPattern,
  })

  const responseSynth = compactExecution({
    mode: 'thread',
    patternId: 'response-synth',
  })

  return [routerPattern, routesPattern, responseSynth]
}

// Usage
const patterns = await createPatterns()
const agent = harness(...patterns)
const result = await agent('Show me all Person nodes', 'session-123')
```

## File Structure

```
harness-patterns/
├── index.ts                # Public exports
├── types.ts                # Core types (UnifiedContext, PatternScope, RouterConfig, DIRECT_RESPONSE_ROUTE, etc.)
├── context.server.ts       # Context factory, createEvent(), generateId()
├── tools.server.ts         # Tools() — groups MCP tools by namespace
├── harness.server.ts       # harness(), resumeHarness(), continueSession() — all accept onEvent? callback
├── routing.server.ts       # BAML router integration (routeMessageOp)
├── mcp-client.server.ts    # callTool(), listTools(); dispatches across THREE tool transports — sandbox (in-VM) → app-side in-process → MCP gateway; leases one of N pooled gateway connections per call (`MCP_GATEWAY_POOL_SIZE`, default 4) so the reconnect-once retry rebuilds only the failing connection (issue #120); demotes `"<ToolName> Error:"` text results to `success:false` (issue #50); aggregates multi-text-block results into an array (single block stays scalar) so multi-value tools like Redis `smembers`/`lrange` don't drop all but the first element
├── baml-adapters.server.ts # Adapter factories: createLoopControllerAdapter, createNeo4jController, createActorControllerAdapter, createCriticAdapter, createPlannerAdapter, describeToolResultOp, describeToolResultsBatchOp, etc.
├── compactBulkData.server.ts # compactBulkData() — background tool result summarization via the describe-tier client
├── parallel-tools.server.ts # runBatch() + combineOutcomes() — multi-call turn executor (parallel/serial modes, stop-on-failure, index-keyed combined map)
├── token-budget.server.ts  # trimToFit(), getContextWindow(), estimateTokens() — rolling context window
├── injection-guard.ts      # Deterministic prompt-injection sanitizer (pure): rule corpus, neutralization, spotlight fence, LLM-screen folding
├── injection-guard-scope.server.ts # ALS scope carrying the active guard (mirrors sandbox/scope.server.ts); read by callTool + retriever
├── json-repair.ts          # Lenient JSON parser for LLM output (unquoted keys, trailing commas, BAML-stringified single-key objects with comma-rich values)
├── assert.server.ts        # Server-only guards
└── patterns/
    ├── index.ts
    ├── router.server.ts        # router() + routes() — intent classification + dispatch
    ├── simpleLoop.server.ts    # ReAct loop; emits callId (+ batchId on multi-call turns) on tool_call/tool_result; resolveRefs(); config-driven cross-turn memory
    ├── actorCritic.server.ts   # Generate-evaluate loop; emits callId (+ batchId) on tool pairs
    ├── judge.server.ts         # Evaluation pattern for quality gates
    ├── parallel.server.ts      # Concurrent branches; wraps each branch with pattern_enter/exit
    ├── guardrail.server.ts     # Rail validation; wraps inner events with pattern_enter/exit (NB: phase:'execution' rails are never dispatched)
    ├── withInjectionGuard.server.ts # ALS wrapper attaching the injection guard; emits content_sanitized
    ├── hook.server.ts          # Lifecycle hook; wraps inner events with pattern_enter/exit
    ├── chain.server.ts         # Sequential composition; accepts onEvent? for SSE streaming
    ├── compactExecution.server.ts   # Final response synthesis; skips BAML for DIRECT_RESPONSE_ROUTE
    ├── compactIntent.server.ts # Rewrites latest message → scope.data.intent for router-less actors; emits intent_compacted
    ├── planner.server.ts       # Upfront decomposition → scope.data.plan (+ formatPlanContext, read by both loop patterns); emits plan_created
    └── event-view.server.ts    # EventViewImpl (fluent query API, serializeCompact)
```

## Design Principles

1. **BAML functions are first-class** - Pass them directly to patterns (use `.bind()`)
2. **Patterns extract params** - Patterns pull data from context and call BAML
3. **Config injects metadata** - Optional config for things like schema injection
4. **Server-only enforcement** - `.server.ts` files with runtime guards
5. **Session persistence** - Full context serializable for multi-turn conversations
