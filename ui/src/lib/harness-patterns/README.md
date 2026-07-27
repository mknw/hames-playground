# Harness Patterns

Functional, composable framework for agentic tool execution.

> **Status:** this directory is the **testbed** for the harness-patterns
> library. The kg-agent repo serves as both consumer and proving ground —
> the library is intended to be extracted as a standalone npm package once
> the core API has been validated across enough use cases (the agents under
> `harness-client/examples/`).
>
> Library boundary rules — keep them strict so extraction stays cheap:
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
  - [synthesizer()](#synthesizerconfig)
  - [compactIntent()](#compactintentconfig)
  - [retriever()](#retrieverconfig)
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
- [OpenTelemetry](#opentelemetry)
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
actorCritic(actor, critic, tools.all, { patternId: 'code-mode' })

// Alternative: pass BAML functions directly (bind to preserve 'this' context)
simpleLoop(b.Neo4jController.bind(b), tools.neo4j, { schema })
actorCritic(b.CodeModeController.bind(b), b.CodeModeCritic.bind(b), tools.all)

// Router is two composable patterns: classify → dispatch
router({ neo4j: 'Description', web: 'Description' }),
routes({ neo4j: pattern1, web: pattern2 })

// Harness chains patterns and executes them
harness(router(...), routes(...), synthesizer({ mode: 'thread' }))
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
  events: ContextEvent[]      // Full event stream
  status: CtxStatus           // 'running' | 'paused' | 'done' | 'error'
  error?: string
  data: T                     // Accumulated pattern data
  input: string               // Current user input
}

// Events tagged with pattern origin
interface ContextEvent {
  id?: string             // Auto-generated unique ID (e.g. 'ev-a1b2c3')
  type: EventType
  ts: number
  patternId: string
  data: unknown           // Typed per EventType (see Event → BAML Type Mapping)
}

// Tool event data includes optional callId for pairing call↔result in the UI
interface ToolCallEventData   { callId?: string; tool: string; args: unknown }
interface ToolResultEventData { callId?: string; tool: string; result: unknown; success: boolean; error?: string }

type EventType =
  | 'user_message' | 'assistant_message'
  | 'tool_call' | 'tool_result'
  | 'controller_action' | 'critic_result'
  | 'pattern_enter' | 'pattern_exit'
  | 'approval_request' | 'approval_response'
  | 'error'
  | 'reference_attached'   // withReferences — selector decision (observability)
  | 'intent_compacted'     // compactIntent — rewritten brief (observability)

// Isolated workspace for each pattern
interface PatternScope<T> {
  id: string
  events: ContextEvent[]      // Local events (not yet committed)
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
  reasoning: string      // Chain-of-thought
  tool_name: string      // Tool to call. simpleLoop: `'Return'` exits the loop. actorCritic: actor's `'Return'` is ignored — the critic alone owns termination.
  tool_args: string      // JSON payload
  status: string         // User-facing message
  is_final: boolean      // simpleLoop: exits the loop. actorCritic: cannot exit (critic owns that), but is an advisory *critic trigger* — see criticCadence.
}

// Critic result for actor-critic pattern
interface CriticResult {
  is_sufficient: boolean
  explanation: string
  suggested_approach?: string
}

// Compact reference to a tool result from a prior turn (for cross-turn memory)
interface PriorResult {
  ref_id: string        // Event ID — LLM passes as ref:<ref_id> in tool args
  tool: string          // Tool that produced the result
  summary: string       // LLM-generated summary or truncated preview
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
store(result.serialized)  // JSON string of full context

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
tools.neo4j  // ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema']
tools.web    // ['search', 'fetch', 'fetch_content']
tools.all    // all tool names
```

### `simpleLoop(controller, tools, config?)`

ReAct-style decide-execute loop. Calls BAML controller directly.

```typescript
simpleLoop(b.Neo4jController.bind(b), tools.neo4j, {
  patternId: 'neo4j-query',
  schema,
  maxTurns: 5
})

interface SimpleLoopConfig extends PatternConfig {
  schema?: string              // Injected as context to controller
  maxTurns?: number            // Default: 5
  rememberPriorTurns?: boolean // Include prior tool results (default: true)
  priorTurnCount?: number      // How many prior user turns (default: 3)
  includeFailedResults?: boolean // Include failed tool results in prior context (default: false)
  fewShots?: FewShot[]         // Domain-specific examples rendered into the LoopController prompt
  onToolResult?: OnToolResult  // Enrich/transform tool results before they're committed (see "Hooks" below)
}

interface FewShot {
  user: string         // Example user request
  reasoning: string    // Reasoning the agent followed
  tool: string         // Tool name selected
  args: string         // JSON-encoded tool arguments
}

type OnToolResult = (
  toolName: string,
  result: { success: boolean; data: unknown; error?: string },
  context: { callId?: string; args: unknown }
) => Promise<{ data?: unknown } | void> | { data?: unknown } | void
```

**Few-shot examples.** `fewShots` is a per-pattern config knob that injects an `EXAMPLES`
block into the controller prompt. Best for routes with a narrow tool surface where the
LLM benefits from seeing the canonical query shape (e.g., parameterized Cypher with
`MERGE` semantics, bulk `UNWIND` patterns, idiomatic `toLower()` substring search).
Keep the list short (3-5) — the prompt grows with every shot and is sent on every turn.
See `ui/src/lib/harness-client/examples/neo4j-fewshots.server.ts` for a worked example
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

The `enrichNeo4jResult` recipe (`ui/src/lib/harness-client/neo4j-enricher.server.ts`)
walks the tool's returned rows for `name` strings, fetches a 1-hop neighborhood
directly via the `neo4j-driver` singleton, and emits an enriched payload of shape
`{ rows, _neighborhood: { rows }, _touched: [...names] }`. The graph extractor
recognizes that shape, dedups across the rows + neighborhood, and tags each
node whose name is in `_touched` with `data.touched = true` so the Neo4j panel
can highlight what the agent actually queried (vs. surrounding context).
The same hook is also wired into `actorCritic`.

**How it works:**
1. Extract params from context: `input`, `intent`, `previous_results`, `turn`
2. Call BAML controller with extracted params (+ optional schema)
3. Execute returned tool via MCP
4. Loop until `is_final` or max turns
5. Prior tool results from earlier turns are passed as `turns_previous_runs: PriorResult[]` — a structured array separate from the current task's `turns`. The LLM can reference them with `ref:<ref_id>` in tool args; `resolveRefs()` auto-expands before MCP execution. Controlled by `rememberPriorTurns` (default: true) and `priorTurnCount` (default: 3).
6. Controller errors are caught per-iteration — loop exits gracefully with partial results; errors are tracked as events and read by downstream patterns via `view.hasErrors()` / `view.lastError()`, scoped by ViewConfig (so they naturally expire with the view window)
7. After the response reaches the user, `scheduleSummarization()` runs in the background: it summarizes each `tool_result` with a lightweight model (`DescribeFallback`) and stores the summary on the event. These summaries appear as `PriorResult.summary` on subsequent turns.

### `actorCritic(actor, critic, tools, config?)`

Generate-evaluate loop with retry. For code mode workflows.

```typescript
actorCritic(b.CodeModeController.bind(b), b.CodeModeCritic.bind(b), tools.all, {
  patternId: 'code-mode',
  maxRetries: 3
})

interface ActorCriticConfig extends PatternConfig {
  maxRetries?: number             // Default: 3
  onToolResult?: OnToolResult     // Same shape + semantics as in SimpleLoopConfig
  criticCadence?: number          // Default: 1 (critic every turn). See below.
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
*sole* exit authority — can wrongly accept the written-but-unrun script as "done"
(observed live: a report loop exited with no `.docx` because the critic judged the
generator script before it ran). With `criticCadence: N` the actor free-runs and
the critic evaluates only (a) every Nth successful turn, (b) when the actor sets
`is_final: true` ("I think I'm done" — it still can't exit by itself; the critic
verifies), and (c) on the final attempt. This is the composable "actor free-runs,
judge gates exit" shape without a second pattern. `is_final` is thus an advisory
critic *trigger* here, never an exit. With `N > 1`, `maxRetries` bounds actor
turns (tool steps), not critic calls; values `< 1` are clamped to `1` so the
critic can never be disabled.

### `parallel(...patterns)`

Execute multiple patterns concurrently via `Promise.allSettled`, then merge results.

```typescript
parallel(
  simpleLoop(b.WebSearchController.bind(b), tools.web ?? [], { patternId: 'web-search' }),
  simpleLoop(b.Neo4jController.bind(b), tools.neo4j ?? [], { patternId: 'kg-lookup', schema })
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

### `hook(pattern, config)`

Wrap a pattern as a lifecycle hook. Optionally runs in the background without blocking the main chain.

```typescript
interface HookConfig extends PatternConfig {
  trigger: 'session_close' | 'error' | 'approval_timeout' | 'custom'
  background?: boolean  // fire-and-forget via queueMicrotask
}

const distillHook = hook(distillChain, {
  patternId: 'session-close-hook',
  trigger: 'session_close',
  background: true
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
withReferences(
  simpleLoop(b.Neo4jController.bind(b), tools.neo4j, { schema }),
  { scope: 'global', maxRefs: 5 }
)
```

**Config:**

| Field | Type | Default | Notes |
|---|---|---|---|
| `scope` | `'self' \| 'global'` | `'global'` | `'self'` = only the wrapper's own `patternId`. |
| `source` | `string \| string[]` | — | Explicit `patternId` allow-list. Overrides `scope`. |
| `maxRefs` | `number` | `5` | Cap on attached refs after selection. |
| `selector` | `SelectorFn` | LLM-driven (`b.ReferenceSelector`) | Override for tests, evals, or deterministic policies. |

**Skip optimizations** — the selector is bypassed when:
- the eligible stash is empty → `skipped: 'empty'`, no refs attached
- there is exactly one candidate → `skipped: 'single'`, attached unconditionally
- a cache hit on `(intent_hash, stash_snapshot_hash)` → `skipped: 'cached'`, prior decision reused

Each entry exit emits a `reference_attached` event with `{ candidates, selected, reasoning, skipped? }` for observability.

**Composes with `expandPreviousResult`.** The wrapper attaches *compact* refs (summary only). Inside the loop, the controller can either:
- pass `ref:<ref_id>` as a tool argument — the system inlines the full data into that tool's args before dispatch, **or**
- call the synthetic `expandPreviousResult` tool (auto-injected by simpleLoop when prior results are present) with `tool_args = ref:<ref_id>` to load the full content into a turn record.

Either path records an `expansions[]` entry on the `LoopTurn`; the compact ref entry then renders `(expanded in turn N)` so the controller doesn't redundantly re-expand.

```typescript
// Default agent migration (excerpt from examples/default.server.ts)
const routesPattern = routes<SessionData>({
  neo4j:       withReferences(neo4jPattern,       { scope: 'global' }),
  web_search:  withReferences(webPattern,         { scope: 'global' }),
  code_mode:   withReferences(codePattern,        { scope: 'global' })
})
```

### `synthesizer(config)`

Synthesizes final response from previous pattern's output using BAML `CreateToolResponse`.

```typescript
synthesizer({ mode: 'thread', patternId: 'response-synth' })

// Three modes
synthesizer({ mode: 'message' })   // Receives only response string
synthesizer({ mode: 'response' })  // Receives { data, response } object
synthesizer({ mode: 'thread' })    // Receives full loop history

// Custom synthesis function
synthesizer({
  mode: 'response',
  synthesize: async (input) => `Found: ${input.response}`
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
  synthesizer({ mode: 'thread' }),
)

type CompactIntentConfig = PatternConfig
```

**How it works:**
1. Reads recent message history from its view (default `viewConfig`:
   `{ fromLast: false, fromLastNTurns: 5, eventTypes: ['user_message', 'assistant_message'] }`,
   think-blocks stripped — mirrors `router`).
2. Splits into the latest user message + prior history, then calls BAML
   `CompactIntent` on the cheap `DescribeAnthropic` client (one call per chain
   invocation) to resolve back-references (*"try again"*, *"I can't find the
   file"*) into a standalone instruction.
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

### `retriever(config)`

A low-latency alternative to a tool-calling `simpleLoop`: instead of an LLM loop
deciding which DB tool to call (often >30s for a Neo4j loop), the retriever forms
ONE query from context and fans it out to one or more injected **backends**,
returning normalized matches-with-references for a downstream `synthesizer`.

```typescript
// Raw user message is the query; rewritten only when the turn has history.
retriever({ backends: [redisBackend], k: 5, generateQuery: true })

interface RetrieverConfig extends PatternConfig {
  backends: RetrieverBackend[]   // injected DB sources (app-side)
  k?: number                     // max hits, default 5
  generateQuery?: boolean        // RetrieveQuery rewrite, ONLY when history exists
  turnWindow?: number            // no-LLM: widen the query to the last N user turns
}
interface RetrieverBackend {
  name: string
  type: 'vector' | 'keyword' | 'graph' | 'web'   // only 'vector' backends embed
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
   (`tool: 'retriever'`) — the same channel `synthesizer` reads via
   `view.fromLastPattern()`.

Framework-pure: concrete backends live app-side (`ui/src/lib/retriever/` —
`createRedisBackend` is live; `createSupabaseBackend` is a deferred stub). The
resolved config carries a `backendKinds: string[]` marker so
`harnessHasRedisRetriever` (pattern-capabilities) can gate the Data Stash's
auto-ingest-on-upload. **Best-effort / `recoverable`**: on total failure it
leaves `matches` empty and the synthesizer answers from the rest of context.

> See [`docs/DATA_STASH.md → Harness-aware ingest`](../../../../docs/DATA_STASH.md)
> for the upload-side gate and the `redis` / `supabase` backends.

### `router(routeDescriptions, config?)`

Classifies intent via BAML and sets `scope.data.route`. The first half of the router/routes pair.

- **Tool needed** → `data.route = <toolName>`, `data.intent`, `data.routerResponse`; tracks optional `assistant_message`
- **Conversational** → `data.route = 'user'` (the `DIRECT_RESPONSE_ROUTE` sentinel), `data.response = responseText`; tracks `assistant_message` directly; downstream `synthesizer()` skips BAML

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
  directResponseRoute?: string  // Default: 'user'
}
```

### `routes(patternMap, config?)`

Dispatches to the sub-pattern matching `scope.data.route`. The second half of the router/routes pair.

- `data.route === undefined` → **throws** (programming error — `routes()` must follow `router()`)
- `data.route === 'user'` → **pass-through** (conversational; synthesizer also skips BAML)
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
  directResponseRoute?: string  // Default: 'user' — must match paired router()
}
```

### `judge(evaluator, config?)`

Evaluation pattern that scores or classifies pattern output. Used for quality gates.

```typescript
judge(evaluatorFn, {
  patternId: 'quality-check',
  threshold: 0.7
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
const agent = harness(routerPattern, synthesizerPattern)
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
  serialized: string  // JSON for session persistence
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
view.fromLastPattern()       // Excludes self when selfPatternId is set
view.fromLastNPatterns(2)    // Excludes self when selfPatternId is set
view.fromAll()

// Type selectors
view.ofType('tool_result')
view.ofTypes(['tool_call', 'tool_result'])
view.tools()      // Shorthand: tool_call + tool_result
view.messages()   // Shorthand: user_message + assistant_message
view.actions()    // Shorthand: controller_action

// Quantity selectors
view.last(5)
view.first(3)
view.since(timestamp)
view.fromLastNTurns(3)   // Rolling window: last 3 user turns

// Execution
view.get()        // ContextEvent[]
view.serialize()  // XML format for LLM
view.serializeCompact({ recentTurns: 1 })  // Compact pointers for older results, full for recent
view.exists()     // boolean
view.count()      // number
```

**Compact serialization**: `serializeCompact()` renders older `tool_result` events as compact pointers. If an LLM-generated summary exists (via `scheduleSummarization()`), it replaces the raw preview:
```xml
<tool_result id="ev-abc123" tool="search" compact="true">
Returned 247 results including... (12,847 chars). Use ref:ev-abc123 to access full data.
</tool_result>
```
Events within the last `recentTurns` user turns are rendered in full. Hidden or archived events (`ToolResultEventData.hidden` / `.archived`) are excluded from compact output. The LLM can use `ref:<eventId>` in tool args; `resolveRefs()` in simpleLoop auto-expands them before MCP execution (also skips hidden/archived events).

**Data Stash**: `ToolResultEventData` supports three visibility fields:
- `summary?: string` — LLM-generated summary (populated async by `scheduleSummarization()`)
- `hidden?: boolean` — excluded from LLM context, shown grayed-out in UI
- `archived?: boolean` — excluded from LLM context, moved to Archived section in UI

These are mutated post-commit via `enrichToolResult(ctx, eventId, { summary?, hidden?, archived? })`. The UI manages hide/archive via `POST /api/stash`.

## Configuration System

Two orthogonal configuration axes:

| Axis | Controls | Options |
|------|----------|---------|
| **commitStrategy** | *When* to commit | `'always'`, `'on-success'`, `'last'`, `'never'` |
| **trackHistory** | *What types* to track | `true`, `false`, `EventType`, or `EventType[]` |

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
  fromPatterns?: string[]            // Specific pattern IDs to read from
  fromLastN?: number                 // Last N patterns
  fromLast?: boolean                 // Only previous pattern (default: true)
  eventTypes?: EventType[]           // Filter by event type
  limit?: number                     // Max events to include
  fromLastNTurns?: number            // Rolling window: last N user turns
  contentTransforms?: ContentTransform[]  // Read-time transforms applied in get()/serialize()
}
```

| Option | Effect | Example |
|--------|--------|---------|
| `fromLast: true` | See only the previous pattern's events | Default behavior |
| `fromPatterns: ['neo4j']` | See events from specific pattern(s) | Cross-pattern queries |
| `fromLastN: 3` | See events from last 3 patterns | Broader context |
| `fromLastNTurns: 5` | Rolling window over last 5 user turns | Multi-turn history |
| `eventTypes: ['tool_result']` | Filter to specific event types | Focus on results |
| `limit: 10` | Cap number of events returned | Limit context size |
| `contentTransforms: [fn]` | Read-time event transformations (never mutates `ctx.events`) | Strip think blocks, truncate results |

**ContentTransform** is `(event: ContextEvent) => ContextEvent`. Built-in transforms in `content-transforms.ts`:
- `stripThinkBlocks` — removes `<think>...</think>` reasoning from assistant messages (router uses this by default)
- `truncateToolResults(maxChars)` — factory that truncates long tool results to N chars

A "turn" is defined by a `user_message` event. `fromLastNTurns` slices the event stream at the Nth-to-last `user_message` boundary. It is applied *before* type filters so that boundary detection works regardless of which `eventTypes` are selected.

> **Note:** `since(ts)` is available on the fluent API (`view.since(timestamp)`) but is not a ViewConfig option.

```typescript
// Example: synthesizer needs to see tool results from neo4j pattern
synthesizer({
  mode: 'thread',
  viewConfig: { fromPatterns: ['neo4j-query'], eventTypes: ['tool_result'] }
})

// Example: router with cross-turn message history (3-turn window)
router({ neo4j: 'Database queries' }, {
  viewConfig: { fromLast: false, fromLastNTurns: 3, eventTypes: ['user_message', 'assistant_message'] }
})
```

**Defaults by pattern:**
- `router`: `viewConfig: { fromLast: false, fromLastNTurns: 5, eventTypes: ['user_message', 'assistant_message'] }`
- `simpleLoop`: `trackHistory: 'tool_result'`, `commitStrategy: 'on-success'`
- `actorCritic`: `trackHistory: 'tool_result'`, `commitStrategy: 'on-success'`
- `synthesizer`: `trackHistory: 'assistant_message'`, `commitStrategy: 'always'`
- `compactIntent`: `trackHistory: 'intent_compacted'`, `commitStrategy: 'always'`, default `viewConfig` of last 5 message turns

## Event → BAML Type Mapping

Each BAML function receives a projection of the UnifiedContext event stream,
transformed into prompt-friendly types. The table below shows which harness
`EventType` values feed into which BAML input types for each pattern.

### Harness EventType → BAML Input Type

| Harness `EventType` | Event Payload (TS) | BAML Type | Consumed By |
|---|---|---|---|
| `tool_call` | `ToolCallEventData` (`callId?`, `tool`, `args`) | `ToolCall` | `LoopTurn.tool_call`, `Attempt.action` |
| `tool_result` | `ToolResultEventData` (`callId?`, `tool`, `result`, `success`, `error?`, `summary?`, `hidden?`, `archived?`) | `ToolResult` | `LoopTurn.tool_result`, `Attempt.result/error`, `PriorResult` |
| `controller_action` | `ControllerActionEventData` | _(embedded in `LoopTurn.reasoning`)_ | simpleLoop, actorCritic |
| `critic_result` | `CriticResultEventData` | _(embedded in `Attempt.feedback`)_ | actorCritic |
| `user_message` | `UserMessageEventData` | `Message { role, content }` | router (history) |
| `assistant_message` | `AssistantMessageEventData` | `Message { role, content }` | router (history) |
| `pattern_enter` | `PatternEnterEventData` | _(not sent to BAML)_ | `chain` + wrapper patterns: `parallel`, `hook`, `guardrail` |
| `pattern_exit` | `PatternExitEventData` | _(not sent to BAML)_ | `chain` + wrapper patterns: `parallel`, `hook`, `guardrail` |
| `approval_request` | `ApprovalRequestEventData` | _(not sent to BAML)_ | (reserved — no active emitter) |
| `approval_response` | `ApprovalResponseEventData` | _(not sent to BAML)_ | (reserved — no active emitter) |
| `error` | `ErrorEventData` | _(read via `view.hasErrors()`)_ | synthesizer (error context), harness error handling |
| `reference_attached` | `ReferenceAttachedEventData` | _(not sent to BAML)_ | withReferences only (observability) |
| `intent_compacted` | `IntentCompactedEventData` | _(not sent to BAML)_ | compactIntent only (observability) |

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

BAML Return → ControllerAction:
  reasoning : string    → stored as controller_action event
  tool_name : string    → drives tool_call event
  tool_args : string    → passed to MCP callTool()
  status    : string    → user-facing status
  is_final  : bool      → terminates loop
```

#### actorCritic → `ActorController` + `Critic`

```
Events read (ViewConfig default: fromLast, trackHistory: 'tool_result')
├── controller_action  ──► Attempt.action (full ControllerAction)
├── tool_result        ──► Attempt.result / Attempt.error
└── critic_result      ──► Attempt.feedback

BAML Inputs (ActorController):
  user_message : string           ← ctx.input
  intent       : string           ← extracted from routing or ctx.input
  tools        : ToolDescription[]← MCP listTools()
  attempts     : Attempt[]        ← assembled from scope events per attempt

BAML Return → ControllerAction (same shape as simpleLoop; the actor cannot exit — `tool_name: 'Return'` is rejected and `is_final` only *triggers* a critic check under `criticCadence`. Exit is the critic's call.)

BAML Inputs (Critic):
  intent   : string      ← same intent
  attempts : Attempt[]   ← same assembled attempts

BAML Return → CriticResult:
  is_sufficient      : bool    → sole termination signal; true exits the retry loop
  explanation        : string  → logged
  suggested_approach : string? → forwarded as next Attempt.feedback
```

#### synthesizer → `Synthesize`

```
Events read (ViewConfig: typically fromPatterns or fromLast)
├── tool_call    ──► LoopTurn.tool_call
├── tool_result  ──► LoopTurn.tool_result
└── error        ──► hasError / errorMessage (via view.hasErrors() / view.lastError())

BAML Inputs:
  user_message : string       ← ctx.input
  intent       : string       ← from data or ctx.input
  turns        : LoopTurn[]   ← assembled from preceding pattern events
  hasError     : boolean      ← view.hasErrors() — scoped by synthesizer's ViewConfig
  errorMessage : string?      ← view.lastError() — naturally expires with view window

BAML Return → string (assistant response text)
  → stored as assistant_message event
```

> **Error scoping**: The synthesizer reads error state from EventView, not from the data stash.
> This means errors are scoped by the synthesizer's `ViewConfig` (e.g. `fromLastNTurns: 1`) and
> naturally expire — they don't persist across turns via serialization.

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
  → routes() passes through; synthesizer() skips BAML

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
  synthesizer,
  Tools,
  callTool,
  createNeo4jController,
  createWebSearchController,
  createActorControllerAdapter,
  createCriticAdapter
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
  const actor = createActorControllerAdapter(tools.all)
  const critic = createCriticAdapter()

  const neo4jPattern = simpleLoop(neo4jController, tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema
  })

  const webPattern = simpleLoop(webController, tools.web ?? [], {
    patternId: 'web-search'
  })

  const codePattern = actorCritic(actor, critic, tools.all, {
    patternId: 'code-mode'
  })

  const routerPattern = router({
    neo4j: 'Database queries and graph operations',
    web_search: 'Web lookups and information retrieval',
    code_mode: 'Multi-tool script composition'
  })

  const routesPattern = routes({
    neo4j: neo4jPattern,
    web_search: webPattern,
    code_mode: codePattern
  })

  const responseSynth = synthesizer({
    mode: 'thread',
    patternId: 'response-synth'
  })

  return [routerPattern, routesPattern, responseSynth]
}

// Usage
const patterns = await createPatterns()
const agent = harness(...patterns)
const result = await agent('Show me all Person nodes', 'session-123')
```

## OpenTelemetry

All patterns include built-in OTel tracing with `CompactSpanExporter`:

```
[router] → neo4j (intent: "Query graph data")
[simpleLoop] neo4j-query ✓ (1234ms)
  [tool] read_neo4j_cypher ✓ (456ms)
[harness] Session cl-3 completed in 1500ms
```

Span names:
- `harness.run` - Top-level span
- `harness.resume` - Resume from paused state
- `harness.continue` - Continue session with new input
- `router` - Intent classification
- `pattern.simpleLoop` - Decide-execute loop
- `pattern.actorCritic` - Generate-evaluate loop
- `pattern.chain` - Sequential composition
- `pattern.synthesizer` - Response synthesis
- `controller` / `actor` / `critic` - BAML function calls
- `tool.call` - MCP tool execution

## File Structure

```
harness-patterns/
├── index.ts                # Public exports
├── types.ts                # Core types (UnifiedContext, PatternScope, RouterConfig, DIRECT_RESPONSE_ROUTE, etc.)
├── context.server.ts       # Context factory, createEvent(), generateId()
├── tools.server.ts         # Tools() — groups MCP tools by namespace
├── harness.server.ts       # harness(), resumeHarness(), continueSession() — all accept onEvent? callback
├── routing.server.ts       # BAML router integration (routeMessageOp)
├── mcp-client.server.ts    # callTool(), listTools(); demotes `"<ToolName> Error:"` text results to `success:false` (issue #50); aggregates multi-text-block results into an array (single block stays scalar) so multi-value tools like Redis `smembers`/`lrange` don't drop all but the first element
├── baml-adapters.server.ts # Adapter factories: createLoopControllerAdapter, createNeo4jController, createActorControllerAdapter, createCriticAdapter, describeToolResultOp, etc.
├── summarize.server.ts     # scheduleSummarization() — background tool result summarization via DescribeFallback
├── token-budget.server.ts  # trimToFit(), getContextWindow(), estimateTokens() — rolling context window
├── json-repair.ts          # Lenient JSON parser for LLM output (unquoted keys, trailing commas, BAML-stringified single-key objects with comma-rich values)
├── assert.server.ts        # Server-only guards
└── patterns/
    ├── index.ts
    ├── router.server.ts        # router() + routes() — intent classification + dispatch
    ├── simpleLoop.server.ts    # ReAct loop; emits callId on tool_call/tool_result; resolveRefs(); config-driven cross-turn memory
    ├── actorCritic.server.ts   # Generate-evaluate loop; emits callId on tool pairs
    ├── judge.server.ts         # Evaluation pattern for quality gates
    ├── parallel.server.ts      # Concurrent branches; wraps each branch with pattern_enter/exit
    ├── guardrail.server.ts     # Rail validation; wraps inner events with pattern_enter/exit
    ├── hook.server.ts          # Lifecycle hook; wraps inner events with pattern_enter/exit
    ├── chain.server.ts         # Sequential composition; accepts onEvent? for SSE streaming
    ├── synthesizer.server.ts   # Final response synthesis; skips BAML for DIRECT_RESPONSE_ROUTE
    ├── compactIntent.server.ts # Rewrites latest message → scope.data.intent for router-less actors; emits intent_compacted
    └── event-view.server.ts    # EventViewImpl (fluent query API, serializeCompact)
```

## Design Principles

1. **BAML functions are first-class** - Pass them directly to patterns (use `.bind()`)
2. **Patterns extract params** - Patterns pull data from context and call BAML
3. **Config injects metadata** - Optional config for things like schema injection
4. **OTel is built-in** - Tracing in patterns, not in adapters
5. **Server-only enforcement** - `.server.ts` files with runtime guards
6. **Session persistence** - Full context serializable for multi-turn conversations
