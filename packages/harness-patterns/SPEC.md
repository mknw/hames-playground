# hames — API reference and design spec

The complete reference for `hames`, the functional, composable framework for
agentic tool execution: types, per-pattern semantics, the `EventView` query API,
the two configuration axes, and the event→BAML type mapping. For what the library
is and why it is shaped this way, start at the front page —
[`README.md`](./README.md).

> **Licence:** this directory — and only this directory — is
> [MIT](./LICENSE) (Copyright (c) 2026 Michael Accetto). It is the `hames`
> library. The playground that surrounds it is licensed separately, under
> PolyForm Noncommercial 1.0.0; see the repository root `LICENSE`.
>
> **Status:** the extraction happened. This directory IS the package —
> `@hames-ai/harness-patterns`, version 0.1.0, independently versioned, with its
> own `package.json`, `exports` map and `files` allowlist. It is unpublished as
> of this writing: `pnpm publish` is the remaining step, not a remaining
> refactor. It lives inside the hames playground monorepo, which stays both its
> consumer and its proving ground — the app and the ready-made agents take it
> as a workspace dependency (`"@hames-ai/harness-patterns": "workspace:*"`), so
> the tree this spec describes is the tree they run against, with no build step
> between.
>
> Library boundary rules — they are what keep the package shippable, and each
> one is pinned:
>
> 1. The package MUST NOT import from its host or from a companion package:
>    no `app/src`, no `~/` alias, no relative climb into `app/`. Pinned by
>    `app/src/__tests__/lib/harness-patterns/zero-app-imports.test.ts`, which
>    scans raw source text (a type-only import is erased before a tarball
>    exists, so only a text scan sees it) across this package, `@hames-ai/agents`,
>    `@hames-ai/connectors` and `@hames-ai/sandbox`, co-located tests included.
> 2. Pattern primitives are framework-neutral — no SolidJS, no UI types — and
>    core owns its own wire types: no `baml_client` import may come back here,
>    pinned by `core-types-source-scan.test.ts`. The BAML leaf lives in the
>    companion package `@hames-ai/harness-baml`.
> 3. Anything that depends on runtime settings goes through the run frame's
>    `config` slot (`run-frame.server.ts`, read by `runtimeConfig()`), not
>    function parameters.
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
  - [parallel()](#parallelpatterns)
  - [withReferences()](#withreferencespattern-config)
  - [compactExecution()](#compactexecutionconfig)
  - [compactIntent()](#compactintentconfig)
  - [planner()](#plannerplanfn-tools-config)
  - [retriever()](#retrieverconfig)
  - [withInjectionGuard()](#withinjectionguardconfigpattern)
  - [router()](#routerroutedescriptions-config)
  - [routes()](#routespatternmap-config)
  - [typedDecision() and decisionRouter()](#decisions-typeddecision-418)
  - [memoryRecall()](#memory-recall-memoryrecall-419)
  - [settleMemory()](#memory-store-settlememory-419)
  - [judge()](#judgeevaluator-config)
  - [chain()](#chainctx-patterns-onevent)
  - [harness()](#harnesspatterns)
  - [continueSession()](#continuesessionserialized-patterns-newinput)
- [Human in the loop](#human-in-the-loop)
  - [askHuman()](#askhumanrequest)
  - [resumeHarness()](#resumeharnessserialized-patterns-answers-opts)
  - [humanGate() and confirm()](#humangate-and-confirm)
  - [Supersede and expiry](#supersede-and-expiry)
  - [Properties (P1–P6)](#properties-p1p6)
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

**Key Principle**: patterns take adapter factories (`createLoopControllerAdapter` and friends, from the `@hames-ai/harness-baml` companion package), which wrap the generated BAML functions and adapt their positional call order. A raw BAML function does not satisfy a pattern's controller contract. Since Lane A6 (#225) the six non-controller LLM calls (`Planner`, `Router`, `CompactIntent`, `RetrieveQuery`, `ResultDescribe(+Batch)`) are REQUIRED config on their patterns, supplied by one `bamlPatterns()` factory — see "The LLM seam" below.

## Core Concepts

```typescript
// Adapter factories from `@hames-ai/harness-baml` — the only thing you pass to
// a pattern's controller/actor/critic slots. They adapt the BAML call order
// and return { action, llmCall }; a raw bound BAML function
// (e.g. b.LoopController.bind(b)) does NOT satisfy the contract and fails
// typecheck — do not pass one to a pattern.
//
// The tool list rides the SEAM (L14, #225 Lane B3): `ControllerInput.tools`
// is the loop's allowlist, declared once — there is no factory-captured copy,
// and the seven domain controller factories that used to hold one
// (createNeo4jController, createWebSearchController, …) are deleted.
const controller = createLoopControllerAdapter()
simpleLoop(controller, tools.neo4j ?? [], { patternId: 'neo4j-query', schema })

const actor = createActorControllerAdapter(tools.all)
const critic = createCriticAdapter()
actorCritic(actor, critic, tools.all, { patternId: 'actor-loop' })

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
  | 'approval_request' // @deprecated legacy (#433) — superseded by hitl_request; readHitl() never reads it
  | 'approval_response' // @deprecated legacy (#433) — superseded by hitl_response; readHitl() never reads it
  | 'error'
  | 'reference_attached' // withReferences — selector decision (observability)
  | 'intent_compacted' // compactIntent — rewritten brief (observability)
  | 'plan_created' // planner — upfront plan (observability; the plan itself travels on scope.data)
  | 'content_sanitized' // withInjectionGuard — untrusted content neutralized (observability + audit)
  | 'warning' // a side task (title, summaries, intent/query rewrite, reference pick, sandbox skills mount) failed; the turn ran on a fallback (#420)
  | 'loop_recovery' // simpleLoop / actorCritic fed one failure back to the model and continued on its budget (#437)
  | 'hitl_request' // a person is asked to decide (#433) — core writes it; readHitl() derives state from it
  | 'hitl_response' // the decision on one hitl_request (#433) — core writes it
  | 'decision_made' // one typed decision the policy layer evaluated (#418) — metadata only; the state's SIZE rides, never its text

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
  children?: ConfiguredPattern<T>[] // combinators expose what they wrap
  injectionGuard?: { namespaces: string[]; tools: string[] } // withInjectionGuard's declared boundary
  capabilities?: PatternCapabilities // what the pattern declares about itself
}

// What a pattern declares for a host to read WITHOUT running it. Core owns the
// type; other packages fill fields in. Introspection only — execution never
// reads it — and NOT part of `config`, so a wrapper that declares one stays
// config-transparent (the same charter `children` and `injectionGuard` have).
interface PatternCapabilities {
  retrievalBackends?: readonly string[] // declared by `retriever`: the backends it will query
  workspaceSync?: boolean // declared by a wrapper that gives its subtree a durable workspace
  decisionKeys?: readonly string[] // declared by a deciding pattern (#418): the DecisionSpec keys whose calibration a host can feed
  calibratedDecisionKeys?: readonly string[] // the subset of decisionKeys whose policy sets requireCalibrated (#418 T6): read by harnessCalibratedDecisionKeys
  memory?: true // declared by memoryRecall (#419): read by harnessUsesMemory, the opt-in probe for the memory wake and store
}
```

`capabilities` is ONE typed field rather than the ad-hoc config keys it replaced
(`backendKinds`, `sandboxSyncWorkspace`). Those rode between packages as
strings: the declaring side widened `PatternConfig` with a cast and the reading
probe widened it back with a second, independent one, so renaming either
compiled on both sides and silently turned the capability off — the upload
auto-ingest gate or the Shell's `/work/in` hydration would simply stop firing,
with nothing red anywhere. A capability named in a type core owns is a compile
error in every package that names it. Adding one means adding a field here;
that friction is the point — a cross-package fact should be declared once, in
the type, not agreed by convention at two call sites that never see each other.
The probes are in `pattern-capabilities.ts`.

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

// After a pause → resume with the person's answers (see "Human in the loop")
const resumed = await resumeHarness(serialized, patterns, { [requestId]: 'approve' })
```

## API Reference

### `Tools()`

Fetch MCP tools and group by server namespace. The namespace map is REQUIRED
(owner ruling B-iii): `Tools()` with no map is how `tools.web` disappears
silently on the day a catalog moves, so the map is an argument, not an option —
pre-1.0, strict→lenient later is free, lenient→strict is breaking.

```typescript
const tools = await Tools({ namespaces: mcpNamespace }) // mcpNamespace: the app's catalog
const tools = ToolsFrom(descriptions, { namespaces: mcpNamespace }) // options optional here
tools.neo4j // ['read_neo4j_cypher', 'get_neo4j_schema'] — never 'write_neo4j_cypher' (below)
tools.web // ['search', 'fetch', 'fetch_content']
tools.graph // app-side, per-user (see below)
tools.all // all tool names
```

**Three namespace phases feed `inferServer`**, in this order and no other:

1. **Registered transports' `namespaceFor`** — a process transport may declare
   its own grouping (today: the app-side tools, whose `graph_*` names would
   mis-bucket under any name heuristic).
2. **Registered resolvers** — `registerToolNamespaces(r)`, the deployment's
   explicit tool→namespace catalog. The app registers one at boot, from
   `app-tools/mcp-catalog.ts`; core carries no catalog, because which tool
   names exist is the deployment's fact, not the library's (#225 L5).
3. **The heuristic** — verb-prefix stripping and separator splitting. It stays
   in core deliberately: deployment-independent, and what makes `Tools()`
   useful with no registration at all.

The resolver seam is ONE shared value: `withInjectionGuard`'s `isUntrusted`
resolves namespaces through the same `inferServer`, so the grouping and the
trust boundary can never disagree. The guard **refuses to build** when a
declared namespace cannot be verified (#242 item 4): a namespace that is not
even a fixed point of `inferServer` is refused outright, and a fixed point
that no name in the catalog the agent built (passed as `catalog: tools.all`,
REQUIRED whenever namespaces are declared) is PRODUCED for is refused too —
the signature of a registration that never ran, the failure mode the package
split shipped to external consumers. The one exception carries provenance: a
catalog built while the gateway was unreachable (`isDegradedToolSurface`,
#278 F1) is amputated by outage, not by misregistration, and only warns
(deduped) — no untrusted tool can be reached through it anyway. A guard that
declares neither namespaces nor tools is refused as well; the deliberate
"this agent trusts everything" line is an explicit `namespaces: []`.

**Three dispatch phases, and the order is the containment invariant.**
`callTool()` routes a tool name to whichever transport owns it, in this order
and no other:

1. **Scoped transports** — the run frame's `transports` slot, innermost first:
   filled when the frame is opened, or prepended below it by
   `amendRunFrame({ transports: [t] }, fn)`. Today's one is the in-VM sandbox,
   which `withSandbox` registers this way.
2. **Process transports** — supplied by `registerTransport(t)`, in registration
   order. Today's one is the app-side in-process tools.
3. **The MCP gateway** — the terminal fallback, and deliberately NOT a
   transport: it cannot answer `ownsTool` without a round-trip, so as a
   registrant it would say "yes" to everything.

> Any tool name owned by a transport in the run frame's `transports` slot is
> dispatched there, in innermost-first order, before any process-registered
> transport and before the gateway. No value a registrant can pass — and no
> registration order — can invert that.

That is carried by the SHAPE of the seam: two structurally different ways to
supply a transport, two consultation phases, and **no `priority` field on
either**. A rank would make containment a
runtime value any registrant could set. Adding one is a containment change, not
a refactor. `transport-precedence.test.ts` pins the order on colliding names.

Nesting **shadows** — a name two scopes own goes to the inner one — which is the
opposite of `withInjectionGuard`, which unions. Both are right: two nested
sandboxes both own `sandbox_bash` and a union has no answer, while a nested
guard is a second reviewer whose strictness must survive.

A transport may also carry `promptContext` — text it asks the model to be shown
beside the request (today the sandbox's skills index). Like `namespaceFor` it is
never a routing input. `activeTransportContext()` joins the scoped transports'
contexts, innermost first, and the BAML adapters render the result in the
request's `user`-role CONTEXT block: never inside the tool catalog, where a line
of data would read as a tool definition, and never in the system message, where
text a different author wrote would sit beside the deployment's own
instructions. A transport delimits and escapes its own text.

App-side tools exist for calls that carry a per-user credential resolved
server-side — the gateway executes every user's calls as one shared principal,
so it cannot express per-user identity. They are declared via `registerAppTool()`
in `lib/app-tools/`, which registers ONE `ToolTransport` for all of them, and are
advertised by `listTools()` alongside gateway tools so patterns and agents treat
them identically. Scoped transports are NOT in that catalog — `Tools()` caches
once per session, so a per-run transport could never be in it consistently; the
model sees them through the adapters' per-call tool list. See
[`docs/MICROSOFT_GRAPH.md`](../../docs/MICROSOFT_GRAPH.md).

The gateway's OWN management tools are never in that catalog: `listTools()`
drops `mcp-find`, `mcp-add`, `mcp-remove`, `mcp-exec`, `mcp-config-set`,
`code-mode` and the rest of the gateway's `dynamic-tools` feature, and warns
once if the gateway lists them (#412, #420). They reconfigure the gateway
rather than do work, and agents misread them: `mcp-exec` as a shell, `mcp-add`'s
"added 0 tools" as a success.

`write_neo4j_cypher` is never in that catalog either, whatever the gateway
lists, and `listTools()` warns once when it does (#403). Agents are read-only
against Neo4j, `general` included: the one writer is the memory hook (#419),
through the app. The list (`AGENT_WITHHELD_TOOLS`, asked through
`isAgentWithheldTool`, which also sees through a gateway prefix and a server
namespace prefix) is enforced twice: `listTools()` drops it, and every loop's
allowlist check (`simpleLoop` and `actorCritic`, singular and batched) refuses
it, so no loop allowlist holds it — not a hand-written one, and not one widened
by `dynamicToolAllowlist` or `dynamicToolPattern`. `callTool` is not touched,
so a write the app issues by name is left alone. The list lives in core for
now, beside the management-tool list; moving it to a host-registered list is an
open follow-up, due before the next release. The repository's gateway config also ships `read_only: true`,
which keeps the server from offering the tool at all.

The same list withholds the `database-server` tools (`query_database`,
`execute_sql`, `list_tables`, `describe_table`, `connect_to_database`,
`get_connection_examples`, `get_current_database_info`) in both places, with a
drop warning of its own (#412). No agent reaches Postgres: the server ran SQL
against the host app's own database. The repository's gateway catalog no longer
defines it, and the list is what keeps a catalog that regains it from handing
it to an agent.

### `simpleLoop(controller, tools, config?)`

ReAct-style decide-execute loop. Calls BAML controller directly. A turn is
usually one tool call, but the controller may emit a **multi-call turn**
(`additional_calls`) — see `multiToolCalls` below.

```typescript
simpleLoop(createLoopControllerAdapter(), tools.neo4j ?? [], {
  patternId: 'neo4j-query',
  schema,
})

interface SimpleLoopConfig extends PatternConfig {
  schema?: string // Injected as context to controller
  maxTurns?: number // Round budget. Default: settings.maxToolTurns (8). See below.
  rememberPriorTurns?: boolean // Include prior tool results (default: true)
  priorTurnCount?: number // How many prior user turns (default: 3)
  includeFailedResults?: boolean // Include failed tool results in prior context (default: false)
  fewShots?: FewShot[] // Domain-specific examples rendered into the LoopController prompt
  onToolResult?: OnToolResult // Enrich/transform tool results before they're committed (see "Hooks" below)
  resultOmit?: Record<string, string[]> // Per-tool fields hidden from the controller turn log (see below)
  multiToolCalls?: 'parallel' | 'sequential' | 'off' // Multi-call turns (default: 'parallel'; see below)
  returnStyle?: 'summary' | 'answer' // What the terminal `Return` carries (default: 'summary'; see below)
  maxConsecutiveRecoveries?: number // Unusable answers in a row the loop feeds back before the next one is fatal (default: 1; see "One failure does not end the loop")
}

interface FewShot {
  user: string // Example user request
  reasoning: string // Reasoning the agent followed
  tool: string // Tool name selected
  args: string // JSON-encoded tool arguments
}

**Round budgets — `maxTurns`, and what it does NOT count.**

The budget is **controller round-trips, not tool calls**. Under the default
`multiToolCalls: 'parallel'` one round can carry up to `MAX_PARALLEL_TOOL_CALLS`
(4) calls, so the same `maxTurns: 12` is 12 tool calls for a strictly sequential
loop and up to ~48 for a batching one. That asymmetry is deliberate: what a loop
runs out of is chances to THINK, and a batch is one decision. Size the number
against the plan's shape (how many decisions), never against the tool count.

Two values can supply it, and one rule picks between them
(`resolveTurnBudget`, `lib/settings.ts` — read by the loop body, by
`estimateTurns`, and by the exhaustion event, so the three cannot disagree):

- **The pattern's own `maxTurns` wins over `settings.maxToolTurns`**, in both
  directions. A loop pinning a small budget means it and a user's slider may not
  widen it; a loop pinning a large one keeps it while the slider sits at the
  default. The consequence is that the slider is **inert for a pinned loop** —
  which is why the exhaustion hint names whichever of the two actually bound
  (`budgetHint`). Before #269 it always named the setting, on the one agent
  where that advice did nothing.
- **A declared budget is clamped to `SETTINGS_BOUNDS`** (`[1, 15]` for
  `maxToolTurns`), which a call-site literal otherwise bypasses. Load-bearing,
  not hygiene: the stuck-run reaper derives the longest turn the app may
  legitimately run from that ceiling (`MAX_SEQUENTIAL_LLM_CALLS`,
  `lib/db/conversations.server.ts`), so an agent pinning `maxTurns: 40` would
  not raise the threshold — it would make an honest turn outlast it and be
  reaped mid-flight. Raising a budget past the ceiling is therefore a deliberate
  edit to the bound (and so to the reaper), never a side effect of one agent's
  config. The floor matters too: a declared `0` used to run zero rounds and
  record nothing at all.

**Exhaustion is a truncation, and says so.** Reaching the budget without
`Return`/`is_final` records a `recoverable` error event carrying
`kind: 'budget_exhausted'` and `maxTurns` — a marker, not a sentence to match,
so the observability panel badges it ("stopped by round budget", turn rendered
as `7 / 8`) and a test can pin it without depending on wording. `actorCritic`
stamps the identical pair when `maxRetries` runs out. Nothing failed in either
case: the completed rounds are preserved on scope and the `compactExecution`
answers from them (#83).

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
See `packages/agents/agents/neo4j-fewshots.server.ts` for a worked example
verified against the live Neo4j MCP. The loop filters the list by its allowlist
before the controller sees it (#401): a shot whose `tool` the loop would refuse
is dropped, because a model that copies it names a tool outside the allowlist and
the loop spends a round on "Tool not allowed" (it ended the loop there before
#437). Shots of `Return` and `expandPreviousResult`
always stay. So the shipped Neo4j set, whose upsert example uses
`write_neo4j_cypher`, shows a read-only loop only its two reads.

**Hooks: `onToolResult`** (closes #7). Called between `callTool()` and the
`tool_result` event being committed, so the hook can enrich or transform the tool's
output before downstream patterns and the UI see it. Returning `{ data }` replaces
`result.data`; returning `void` leaves it unchanged. Failures are non-fatal — the
loop logs an `error` event with severity `recoverable` and proceeds with the
original result.

```typescript
// Host code: `enrichNeo4jResult` is the app's, not the package's.
import { enrichNeo4jResult } from './neo4j-enricher.server'

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

Each advertised mode also DEMONSTRATES one batched action in its own branch of
`LoopMultiCalls`/`ActorMultiCalls` — parallel shows independent lookups,
sequential the write-then-run chain — in the same JSON envelope the turn log and
`ctx.output_format` ask for. #248 was a model that wanted the affordance and,
finding it described but never shown, invented a YAML `additional_calls:` list
for it. `'off'` renders no branch, so it shows nothing either.

The whole batch records as ONE `LoopTurn` (so `maxTurns` counts turns, not
calls): the assistant history replays `additional_calls` exactly as emitted,
and `tool_result.result` is an index-keyed map — `{"1": {tool, result}, "2":
{tool, __error}, ...}` (the `expandPreviousResult` multi-ref shape). Per
sub-call, one `tool_call`/`tool_result` event pair is tracked with a shared
`batchId`, so observability, the compactExecution and graph extraction keep full
per-tool fidelity. Partial failure → the loop continues (the controller retries
just the failures); ALL sub-calls failed → the loop continues too, recorded as a
`loop_recovery` (see "One failure does not end the loop" below). `Return` and
`expandPreviousResult` are singular-only — inside a batch they get a per-call
error.

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
6. A recoverable failure is fed back as the round's result and the loop continues (next section). A fatal one — a controller that never answered, or an unclassified throw — ends the loop with its partial results; it is tracked as an `error` event and read by downstream patterns via `view.hasErrors()` / `view.lastError()`, scoped by ViewConfig (so it naturally expires with the view window)
7. After the response reaches the user, `compactBulkData()` runs in the background: it summarizes the turn's `tool_result` events with the describe-tier client and stores each summary on its event. These summaries appear as `PriorResult.summary` on subsequent turns. See [Batched bulk-data compaction](#batched-bulk-data-compaction) for how N results become one call.

**One failure does not end the loop (#437 slice 1, #425 C1/C2).** Both loops
feed a recoverable failure back to the model as that round's (or attempt's)
result and continue on their remaining budget. The failure costs the round —
the budget still bounds the loop — and a model that never recovers is stopped by
it, with the usual `kind: 'budget_exhausted'` marker, or sooner by the
consecutive-recovery cap below.

| Failure                                                     | Before             | Now, both loops                                                         |
| ----------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| a tool call returns `success: false`                        | ended `simpleLoop` | the turn already carries the error; continue                            |
| every call of a multi-call turn failed                      | ended `simpleLoop` | the per-call errors are in the turn; continue                           |
| a tool name off the allowlist                               | ended `simpleLoop` | a turn with the refusal as its ERROR; never dispatched; continue        |
| `tool_args` that do not parse (or were cut off)             | ended `simpleLoop` | a turn with the error — cut-off-aware, with the append advice; continue |
| the controller/actor ANSWER would not parse (`recoverable`) | ended both loops   | a turn with no tool call and the feedback as its ERROR; continue        |

What the model is told about an answer that would not parse depends on why
(`unparseableOutputFeedback`). A cut-off at the output cap is told to answer
SMALLER, with the append advice, and is not shown its own oversized text; an
empty completion is told it was empty. Any other parse failure gets a bounded
excerpt of the parser's message (≤ 300 characters, which field was missing) and
a bounded HEAD of its own previous response (≤ 400 characters), labelled as its
own. The turn log cannot show that response: no action was ever parsed out of
it, so the round's assistant message replays an empty action, and before this
the model read a diagnosis of an answer it could not see — a brace-less
`key: value` envelope, the documented case, is visible only in the raw text.
Nothing from outside the run enters the prompt this way: the excerpt is the
model's own output from the round before, and any tool content it quotes was
already in that round's prompt, in the form the turn log carried it.

What stays **fatal**, deliberately:

- **The gateway-outage refusal** (#276) before the loop starts — no round can
  bring the tools back.
- **An LLM call that never answered**, and anything the implementation did not
  classify. Recoverability is read off `LLMCallError.recoverable`, which only
  the implementation sets (the BAML adapters: for `BamlValidationError`, the
  same test their one corrective retry uses). It is never inferred from a
  message, so a transport error, a timeout, an abort, or a plain `Error` from a
  custom controller ends the loop as before — the model never answered, and the
  next call would most likely fail the same way.
- **A `callTool` that throws**, e.g. the deterministic sanitizer — singular,
  or in a multi-call turn whose calls all failed (the executor marks a thrown
  sub-call `threw`, and `simpleLoop` keeps the fatal break for such a batch).
  Its throw policy is an open owner decision (#206 D1) that this does not
  take, so the batch behaviour is exactly what it was before #437: a batch in
  which another call succeeded continues past a throw, as it always has.
- **A critic that throws** (`actorCritic`). The critic is the loop's sole exit
  authority; whether its own parse failure should be survivable is a separate
  decision.

**The consecutive-recovery cap** (`maxConsecutiveRecoveries`, default `1`, on
both loops' configs; #450 review §3, owner decision 2026-10-03). The budget
alone let a model that keeps producing unusable answers spend every round on
them, and on the self-hosted tier a cut-off round is two full-cap generations
(the answer and the adapter's corrective retry, up to ~5 min). So:

- **What counts**: a round (attempt) whose ANSWER the loop cannot use — it would
  not parse (`unparseable_output`), its `tool_args` would not parse
  (`invalid_tool_args`), it named a tool off the allowlist
  (`tool_not_allowed`), or it was a multi-call turn of which no call was
  dispatched (every call refused or unparseable at the precheck, or skipped
  behind one; recorded as `batch_failed`, which changes its label, not its
  defect).
- **What resets it**: any round that dispatches a tool, whatever the tool then
  returns. A tool that ran and failed is never counted — fail, fix, fail is how
  a sandbox actor debugs. A round that does neither leaves the count where it
  was: an `expandPreviousResult`, a well-formed action that dispatches nothing.
- **What happens at the cap**: the option counts RECOVERIES, the way `maxTurns`
  counts what it permits. Up to `maxConsecutiveRecoveries` unusable answers in
  a row are fed back; the next one is not. It is
  fatal exactly as that failure was before #437 — an `error` with the failure's
  own message, the pattern's `errorSeverity` (`recoverable` for both loops, so
  the synthesizer still answers from the completed rounds, #83) and the failed
  answer's `llmCall` — marked `kind: 'recovery_exhausted'` (in place of
  `llm_call`) with `maxConsecutiveRecoveries` beside it and a hint naming the
  lever. So the default stops a loop on its second unusable answer in a row,
  after one recovery.
- **The knob**: `0` permits no recovery, so the first unusable answer is fatal
  (`simpleLoop`'s pre-#437 behaviour); `Infinity` leaves only the budget;
  values below `0` are clamped to `0`.
- **`actorCritic` differences**: a refused tool and unparseable `tool_args`
  never ended that loop before #437 (they always went back through
  `previousAttempts`), so for those two the cap is the first fatal path that
  loop has — two in a row now end it. That binds the two sandbox agents
  (`maxRetries: 6`): two consecutive unusable answers now stop them at attempt
  2, where they used to spend all 6. And a refusal against a tool surface that
  resolved to NOTHING — no static names, an empty `dynamicToolAllowlist()`, no
  scoped transport, no `dynamicToolPattern` — neither counts nor resets: the
  actor had no valid name to choose, and that shape is a gateway symptom, not
  an answer defect. It is still fed back and recorded as `tool_not_allowed`.

Each recovery records one **`loop_recovery`** event (`LoopRecoveryEventData`:
`failure`, the verbatim `error`, `tool?`, `turn`, `maxTurns`), carrying the
failed call's `llmCall` when the model's answer is the defect — for an
unparseable answer it is the only record of what the model said. It is
deliberately **not** an `error`: `settleTurn`, `runChain`'s stop rule,
`view.hasErrors()` and the chat's error bubble all read `error` as a statement
about the turn, and a failure the loop routed around is not one (#235). It is
always committed and renders metadata-only into LLM-facing serializations. The
synthesizer still sees a failed call: `compactExecution`'s thread mode now
reports a failed singular call as `{ __error }`, the shape batches already use,
instead of a successful `null`.

### `actorCritic(actor, critic, tools, config?)`

Generate-evaluate loop with retry: the actor proposes a tool call, the loop
executes it, and the critic decides whether to stop or feed the result back.

```typescript
actorCritic(createActorControllerAdapter(tools.all), createCriticAdapter(), tools.all, {
  patternId: 'actor-loop',
  maxRetries: 3,
})

interface ActorCriticConfig extends PatternConfig {
  maxRetries?: number // Attempt budget. Default: settings.maxRetries (3).
  // Resolved and clamped exactly like simpleLoop's `maxTurns` — see
  // "Round budgets" under simpleLoop — and its exhaustion carries the same
  // `kind: 'budget_exhausted'` marker.
  onToolResult?: OnToolResult // Same shape + semantics as in SimpleLoopConfig
  criticCadence?: number // Default: 1 (critic every turn). See below.
  multiToolCalls?: 'parallel' | 'sequential' | 'off' // Same semantics as simpleLoop's (see above);
  // a batch records as ONE Attempt whose result is the combined map
  // the critic evaluates. Sandbox agents use 'sequential'.
  maxConsecutiveRecoveries?: number // Default: 1. simpleLoop's cap, counted in attempts
  // (see "One failure does not end the loop" under simpleLoop).
}
```

**How it works:**

1. Actor generates script/action
2. Execute via MCP
3. Critic evaluates result
4. Retry with feedback if insufficient
5. Exit when sufficient or max retries

A failed tool call, a refused tool name, unparseable `tool_args` and — since
#437 — an actor answer that would not parse all go back to the actor through
`previousAttempts` and cost one attempt; each records a `loop_recovery`, and the
last three are subject to the consecutive-recovery cap. The
fatal set is `simpleLoop`'s, plus a critic that throws (see "One failure does
not end the loop" under `simpleLoop`), with one difference this does not
change: a multi-call attempt has always continued when its calls threw, so
that is still recorded as a `batch_failed` recovery rather than ending the
loop — only a singular `callTool` throw is fatal here. A refusal against an empty allowlist is
recorded too: it used to be suppressed because, as an `error`, it flooded the
synthesizer's view, and a `loop_recovery` reaches no such reader.

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
parallel<SimpleLoopData & Record<string, unknown>>([
  simpleLoop(createLoopControllerAdapter(), tools.web ?? [], {
    patternId: 'web-search',
  }),
  simpleLoop(createLoopControllerAdapter(), tools.neo4j ?? [], {
    patternId: 'kg-lookup',
    schema,
  }),
])
```

**How it works:**

1. Each branch gets an isolated child scope (`events: []`, same `data`)
2. All branches run concurrently via `Promise.allSettled`
3. Fulfilled branches: events wrapped with `pattern_enter` / `pattern_exit` markers, then merged into parent scope
4. Rejected branches: tracked as `error` events, don't block other branches

### `withInjectionGuard(config)(pattern)`

Neutralize prompt injection carried in **untrusted tool-result content** before
it reaches any LLM-visible surface. Defensive, opt-in per agent.

```typescript
withInjectionGuard({ namespaces: ['web'], catalog: tools.all })(
  simpleLoop(webController, tools.web, { patternId: 'web-search' }),
)

interface InjectionGuardConfig extends InjectionGuardOptions {
  namespaces?: string[] // inferServer() names treated as UNTRUSTED
  catalog?: string[] // REQUIRED when namespaces is non-empty — pass tools.all (#242 item 4)
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
the shape of [`withSandbox`](../../docs/plan/sandbox.md), not a chain step:
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
   exists. Opt in with `tools: ['retriever']` — an exact-name declaration
   (#242 item 4): `'retriever'` is this pattern's own sanitize key, never a
   namespace any tool name infers to, so a namespace declaration for it is
   unverifiable and the guard refuses it.

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
`createInjectionScreen()` (in `harness-baml`) is the BAML-backed one, on the cheap
`DescribeAnthropic` client. It has its OWN `screen` role in
`harness-baml/clients.server.ts` rather than riding `describe`, so re-pointing summarization
at a cheaper model can never silently re-point prompt-injection screening with
it (SA-M5). The guard calls it **only for content the
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
- a **`content_sanitized`** event lands in the timeline (an orange shield in the
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
`capabilities` follows the same rule, and for the same reason: `withSandbox`
once cloned the wrapped config to carry a `sandboxSyncWorkspace` key, which
broke transparency for exactly the agents that use durable workspaces. It now
declares `capabilities.workspaceSync` beside `children`, and the inner
`config` is passed through by identity.

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

| Agent           | Untrusted namespaces                         | Not guarded             |
| --------------- | -------------------------------------------- | ----------------------- |
| `search`        | `web` (that route only)                      | `neo4j` — our own graph |
| `microsoft-365` | `graph`                                      | —                       |
| `retriever`     | `web` (namespace) + `retriever` (exact name) | `neo4j`                 |

### `withReferences(pattern, config)`

Wrap a pattern so that on entry, an LLM-driven selector picks relevant prior
`tool_result` events from the visible event stream and attaches them to the
inner pattern's `priorResults` channel via `scope.data.attachedRefs`. The
adapter merges these into BAML's `turns_previous_runs` argument — **zero
controller-prompt changes**. `config` is REQUIRED: the `selector`
implementation is REQUIRED config (Lane A6 seam) — core hosts no default, so
the composition root supplies `bamlPatterns().selector` (or its own
deterministic policy for tests and evals).

```typescript
withReferences(simpleLoop(createLoopControllerAdapter(tools.neo4j), tools.neo4j, { schema }), {
  scope: 'global',
  maxRefs: 5,
  selector: baml.selector,
})
```

**Config:**

| Field      | Type                 | Default    | Notes                                                                                                                   |
| ---------- | -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `scope`    | `'self' \| 'global'` | `'global'` | `'self'` = only the wrapper's own `patternId`.                                                                          |
| `source`   | `string \| string[]` | —          | Explicit `patternId` allow-list. Overrides `scope`.                                                                     |
| `maxRefs`  | `number`             | `5`        | Cap on attached refs after selection.                                                                                   |
| `selector` | `SelectorFn`         | REQUIRED   | The BAML-backed one (`bamlPatterns().selector`), or a deterministic policy for tests, evals, or deterministic policies. |

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
// Search agent migration (excerpt from agents/search.server.ts)
const routesPattern = routes<SessionData>({
  neo4j: withReferences(neo4jPattern, { scope: 'global', selector: baml.selector }),
  web_search: withReferences(webPattern, { scope: 'global', selector: baml.selector }),
})
```

### `compactExecution(config)`

Synthesizes final response from previous pattern's output using BAML `CreateToolResponse`.
`synthesize` is REQUIRED config (Lane A6 seam): core hosts no default, so the
composition root supplies `bamlPatterns().synthesize` — or its own
implementation, which must return `{ value }`.

```typescript
compactExecution({ mode: 'thread', patternId: 'response-synth', synthesize: baml.synthesize })

// Three modes
compactExecution({ mode: 'message', synthesize: baml.synthesize }) // Receives only response string
compactExecution({ mode: 'response', synthesize: baml.synthesize }) // Receives { data, response } object
compactExecution({ mode: 'thread', synthesize: baml.synthesize }) // Receives full loop history

// Custom synthesis function
compactExecution({
  mode: 'response',
  synthesize: async (input) => ({ value: `Found: ${input.response}` }),
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
  compactExecution({ mode: 'thread', synthesize: baml.synthesize }),
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
> Part E of [#83](https://github.com/mknw/hames-playground/issues/83) (the
> `compact*` naming unification) is a deferred follow-up.

### `planner(planFn, tools, config?)`

Produces a natural-language plan ONCE, before any tool runs, and hands it to
the next pattern in the chain. The planner does not execute tools — it reasons
about them. `planFn` is REQUIRED (Lane A6 seam): pass `bamlPatterns().planner(tools)`
from `harness-baml` — the same tool list the pattern gets.

```typescript
chain(
  planner(baml.planner(tools.all), tools.all),
  simpleLoop(controller, tools.all),
  compactExecution({ mode: 'thread', synthesize: baml.synthesize }),
)

interface PlannerConfig extends PatternConfig {
  schema?: string // Extra context (e.g. neo4j schema) — mirrors simpleLoop's
  maxPlanChars?: number // Cap on the plan text handed downstream (default 2000)
}
```

**Why.** A `simpleLoop` controller re-derives its high-level approach on every
turn. With a diverse tool surface (`tools.all` spanning `neo4j-cypher` +
`memory` + `web_search` + `context7`) that re-derivation is both the
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
resets only `hasError` / `errorMessage` / `response` / `approved`, and
`serializeContext` is a plain `JSON.stringify`). A path that returned the scope
untouched would hand turn 2's executor turn 1's plan — for a different question,
under wording that tells it to prefer the plan over its own judgement.

**One-shot.** Replanning on failure is out of scope: a failed step is handled by
`simpleLoop`'s own error path. `n_steps` is exposed on `scope.data.plan` as a
soft hint (steps are not tool calls) — it does not clamp `maxTurns`.

> `planner` and `router` solve different problems and compose: router is cheap
> one-of-N intent classification; planner is strategic decomposition before
> execution. `chain(router(...), routes({ x: chain(planner(...), simpleLoop(...)) }))`
> is valid. The `general` agent
> (`packages/agents/agents/general.server.ts`) demonstrates the flat
> planner → simpleLoop → compactExecution chain alongside the router-based `search`.

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

Framework-pure: the concrete backends live in this package's `retriever/` behind
the explicit `./retriever` subpath, opt-in like the stash (core-absorb PR-2 —
`createRedisBackend` is live; `createSupabaseBackend` is a deferred stub). The
pattern declares `capabilities.retrievalBackends` (see
[`ConfiguredPattern`](#core-types)) so `harnessHasRedisRetriever`
(pattern-capabilities) can gate the Data Stash's auto-ingest-on-upload. **Best-effort / `recoverable`**: on total failure it
leaves `matches` empty and the compactExecution answers from the rest of context.

**Untrusted by default in practice.** Stash chunks come from INGESTED DOCUMENTS
(uploads, and ms-graph files via `graph_file_ingest`), so a poisoned document
reaches the final response as a retrieved chunk. Retriever hits never pass through
`callTool`, so the pattern sanitizes its own hits at write-time via the active
[`withInjectionGuard`](#withinjectionguardconfigpattern) — opt in with
`tools: ['retriever']`, an exact-name declaration (`'retriever'` is the
pattern's own sanitize key, never a namespace any tool name infers to —
#242 item 4). Only `content` and `source` are scanned; `docId`,
`chunkIndex` and the offsets stay byte-exact so the inline file viewer still
opens at the right place.

> See [`docs/DATA_STASH.md → Harness-aware ingest`](../../docs/DATA_STASH.md)
> for the upload-side gate and the `redis` / `supabase` backends.

### `router(routeDescriptions, config)`

Classifies intent via BAML and sets `scope.data.route`. The first half of the router/routes pair.
`config` is REQUIRED: the `route` implementation is REQUIRED config (Lane A6
seam) — core hosts no default, so the composition root supplies
`bamlPatterns().router`.

- **Tool needed** → `data.route = <toolName>`, `data.intent`, `data.routerResponse`; tracks optional `assistant_message`
- **Conversational** → `data.route = 'user'` (the `DIRECT_RESPONSE_ROUTE` sentinel), `data.response = responseText`; tracks `assistant_message` directly; downstream `compactExecution()` skips BAML

`data.intent` is a **self-contained** statement of what the user wants, not an
echo of the latest message: the router sees the last `routerTurnWindow` turns
and the prompt's INTENT FORMULATION rules make it expand back-references
("try again", "the second one", "now in TypeScript") into the nouns they refer
to ([#53](https://github.com/mknw/hames-playground/issues/53)). This matters
because `routes()` passes `data.intent` — and nothing else from the
conversation — to the dispatched pattern's controller. The router-less
equivalent is [`compactIntent()`](#compactintentconfig).

```typescript
router(
  {
    neo4j: 'Database queries and graph operations',
    web_search: 'Web lookups and information retrieval',
  },
  { route: baml.router },
)

// Custom direct-response sentinel:
router({ neo4j: '...' }, { route: baml.router, directResponseRoute: 'conversational' })
```

```typescript
interface RouterConfig extends PatternConfig {
  /** REQUIRED: the routing implementation (Lane A6 seam) — the composition
   *  root supplies `bamlPatterns().router` (routeMessageOp). */
  route: RouteFn
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

Sequential composition of patterns within a UnifiedContext. Optional `onEvent` callback is invoked for each newly committed event (used by SSE streaming). `runChain(ctx, patterns, onEvent?, { startAt })` starts at a top-level index — how `resumeHarness` re-enters a paused pattern; an index outside the chain throws.

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
  duration_ms: number
  context: UnifiedContext<T>
  serialized: string // JSON for session persistence
} & (
  | { status: 'paused'; pending: readonly HitlRequestEventData[] } // non-optional [F18]
  | { status: 'running' | 'done' | 'error' }
)
```

A union on status [F18]: `pending` is non-optional when the run paused, so the
consumer of a paused result reads every waiting request straight off it and
never reaches for `!`:

```typescript
if (r.status === 'paused') return { ask: r.pending }
```

### `continueSession(serialized, patterns, newInput)`

Continue a session with new user input.

```typescript
const continued = await continueSession(serializedContext, patterns, 'Follow-up question')
```

It first SUPERSEDES whatever the previous run still waits on (see
[Supersede and expiry](#supersede-and-expiry)), then resets the per-turn fields
on `ctx.data` — `hasError`, `errorMessage` and `response`, plus `approved`, the
legacy-blob scrub kept until 1.0 (#433 F9) — and keeps everything else.

## Human in the loop

A run can stop to ask a person, and an answer continues it (#433). A request
and its answer are two events in the context, `hitl_request` and
`hitl_response`, and nothing else: no decision rides `ctx.data`, and no store
outside the context decides a resume (ADR-0009). `readHitl(ctx)` is the one
reader that turns those events into state — what the current run waits on
(`pending`) and the answers it holds (the replay journal). A pause ENDS the
turn; nothing waits in process, so a restart, a closed tab or a second
instance changes nothing.

The life of one decision:

1. A pattern body or a tool executor calls `askHuman(request)`. It replays a
   decision this run already holds, applies the unattended rule when nobody is
   there, or raises the request and returns `pending`; a gated executor then
   returns `held(outcome)` instead of the content.
2. The owning `runChain` commits the request and ends the run `paused`.
3. The host stores the blob, shows the question, and collects an answer.
4. `resumeHarness(serialized, patterns, answers, opts)` checks the answers
   against what the run waits on, records them, substitutes each held result
   with its outcome, and re-enters the paused top-level pattern — whose gate
   now replays the answer instead of asking.
5. Or the person sends a new message instead, and `continueSession`
   SUPERSEDES what was waiting; or nobody answers in time, and `expireHitl`
   closes it.

### `askHuman(request)`

Ask a person to decide, from inside a run: a pattern body, or a tool executor
that holds no scope (#433, slice S2).

```typescript
const ask = await askHuman({
  kind: 'provenance', // opaque to core; no ':'
  question: 'Use this external file?',
  options: PROVENANCE_OPTIONS, // ≥ 2, unique ids, array order is display order
  defaultOption: 'sanitize',
  summary: { domain, filename, size }, // display only; never rendered into a prompt
})
if (ask.status === 'pending') return held(ask) // the placeholder, never the content
```

**Validation at raise.** An invalid request throws `HitlRequestError`, because
it is a wiring bug: fewer than two options; duplicate option ids; a default
that is missing or unavailable; an unknown `unattended` value; `'stop'` with no
`stopsRun` option; duplicate flag ids on one option; a `required` flag on an
option the unattended rule may pick; a `kind` containing `:`. `askHuman` also
throws outside a run frame, in a frame with no `hitl` slot, and where no
`runChain` owns a HITL run.

**The steps, in order.**

1. Validate. The key is stored as `${kind}:${key}`; the default `key` is the
   sha256 of the question, the option-id set and the summary.
2. Find the run. The frame's `hitl` slot must be set, and a `runChain` must own
   a HITL run in this async context.
3. **Replay.** A decision this run holds for the same kind, key and option-id
   set is returned, and nothing is written. Its choice must be an available
   option of the request it answered AND of the newly raised one.
4. **Deduplicate** by that same full identity. This covers a request in this
   run's buffer and one an earlier attempt of the run committed and left
   waiting. A waiting request is not raised again, and the run still pauses
   for it.
5. Otherwise a new request: a `crypto.randomUUID()` id, `resumeAt` (the
   top-level index and every top-level pattern name) and the run's opaque tier.
6. **Unattended** (`attended` is not exactly `true`), unless the rule is
   `'park'`: `resolveUnattended` decides, and the request and an `unattended`
   response are recorded. If the choice has `stopsRun`, or the rule found no
   option it may pick, the owning `runChain` ends the run `done` at the next
   boundary with a fixed response, and nothing is re-entered.
7. **Attended** (and `'park'`): the request is recorded, emitted live whatever
   the pattern's `liveEvents` says, and `askHuman` returns `pending`.

**`resolveUnattended(request)`.** It never picks an option without
`unattended: true` (P4).

| Rule            | Picks                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apply-default` | the default if the rule may pick it, else the first available option it may pick; with none, `choice: null` and the run stops |
| `stop`          | the first available `stopsRun` option the rule may pick; with none, the run still stops and the record holds `choice: null`   |
| `park`          | nothing: the request waits for a person                                                                                       |

**The pause.** Only the `runChain` that owns the HITL run pauses. After every
pattern, including one that threw, it commits the run's HITL events straight
into `ctx.events`, never through a scope: `commitEvents` and `chain()` drop
every `hitl_*` event a scope carries. Then a request still waiting ends the
run `paused`. The paused pattern's events are committed and its data is not,
so re-entry starts from the data it started from. `error` wins over a pending
request, and a stop wins over a pause.

**The stop checks.** `hitlPending()` is true while a request waits or a rule
has stopped the run. `simpleLoop` checks after a single call and after a batch;
`actorCritic` does too, before the critic is asked; a sequential `runBatch`
skips the calls after one that waits; `chain()` runs no further child. None
records an error. `parallel` has no check of its own: every branch finishes,
and the pause happens after.

**The run frame's `hitl` slot is a frozen `{ attended }` and nothing else.**
`harness()`, `continueSession()` and `resumeHarness()` supply
`{ attended: true }` when they open the frame, and nothing when they join a
host's. `amendRunFrame` passes the slot by reference and refuses a second one
below an open one. The per-run bookkeeping (the owning context, the position,
the buffer, what waits, the stop) is **not** on the frame (#477 F1, F2). It is
in an async-context store of its own, on the run frame's `Symbol.for` two-copy
idiom. The `runChain` that finds the slot set and no HITL run open in its async
context opens one; a nested `runChain` sees it open and claims nothing. So no
accessor that reaches the frame can write the record or suppress a pause, and
two runs started concurrently in one host frame each get their own
bookkeeping.

**The store is reachable by its key, and still cannot write the record (S3).**
Naming the `Symbol.for` key reaches the run's bookkeeping — the price of the
two-copy idiom. So nothing on it is a way to write the record: its identity
fields are non-writable, it hands out a COPY of the owning context's events
and never the live log, and the owner commits from its buffer only what
`askHuman` could have written there — a blocking request at the owner's own
top-level index, tier and run, and an `unattended` response only in an
unattended run, equal to what `resolveUnattended` picks. Anything else is
dropped with a warning, and `askHuman` reads the buffer through the same rule,
so a forged answer is never replayed before the commit drops it. What the key
still reaches is the stop: clearing the waiting set suppresses a pause, which
forges no answer — the executor already withheld the content, and the request
is still pending in the record.

### `resumeHarness(serialized, patterns, answers, opts?)`

Resume a paused run with the answers to the requests it waits on (#433, slice
S3). This replaces the boolean `resumeHarness(serialized, patterns, approved)`,
which bound an answer to no request.

```typescript
const resumed = await resumeHarness(serialized, patterns, answers, {
  principal: user.id, // stamped by the host from its session, never the client
  resolve: applyChoice, // the host's side effect for one answer
})
// answers: { [requestId]: choiceId } or { [requestId]: { choice, flags } }
```

`answers` maps each waiting `requestId` to an option id, or to
`{ choice, flags }`. Nothing else is read from it: there is no principal and no
resolution in an answer, so a client body passed straight through can choose
only what a person chooses [F4].

**Steps 1–6 only check.** The first that fails throws a `HitlAnswerError`
whose `code` names it — before anything is recorded and before `resolve` runs,
so the blob is untouched and still resumable with a correct answer.

| Step | Check                                                                                 | `code`               |
| ---- | ------------------------------------------------------------------------------------- | -------------------- |
| 1    | the context is `paused`                                                               | `not-paused`         |
| 2    | it waits on something: `readHitl(ctx).pending`, the current run's unanswered requests | `no-pending`         |
| 2b   | no waiting request is past its `expiresAt` [F5]                                       | `expired`            |
| 2c   | every waiting request was raised on the tier this resume runs on [C1]                 | `tier-changed`       |
| 3    | every answer names a waiting request — checked against `pending`, never the journal   | `unknown-request`    |
| 4    | every waiting request is answered, in this one call                                   | `missing-answer`     |
| 5    | the choice is an option of THAT request event                                         | `invalid-choice`     |
| 5    | that option is available                                                              | `unavailable-option` |
| 5    | its flags are that option's flags, and booleans                                       | `invalid-flag`       |
| 5    | every `required` flag is set `true` by the answer itself (a default does not confirm) | `required-flag`      |
| 6    | the top-level pattern names equal the request's `resumeAt.names`, the whole list [m4] | `chain-changed`      |

**Then, in order.**

7. `opts.resolve(request, { choice, flags })`, once per answer, in the order the
   run raised the requests, inside the run frame (so a model call in it takes
   the run's tier, P5). **It must be idempotent per `requestId`** [Δ4]: if a
   later `resolve` throws, nothing is recorded and the resume fails, the blob
   is still paused, and a retry calls every `resolve` again. Key the effect on
   `request.requestId` and the retry never repeats it. A `resolve` that throws
   is rethrown UNCHANGED — not as a `HitlAnswerError` — and nothing is
   recorded; the host decides what the row does.
8. One `hitl_response` per answer: `by: 'person'`, `principal` from
   `opts.principal`, `resolution` what `resolve` returned, and `flags`: the
   option's defaults overlaid with what the answer sent. A `required` flag must
   be set `true` by the answer itself (step 5); a default of `true` does not
   confirm.
9. Each held `tool_result` of the run becomes its outcome — `resolution`, or
   `"The user chose: <label>."` without one — **after `sanitizeUntrusted`**
   (namespace `hitl`), and is marked `heldBy`. A resolution is host output
   about content that may be hostile, and this is the one path by which it
   reaches a model (P3). **The step deletes the event's `summary`** [Δ2]: a
   summary is what compaction wrote about the placeholder, and both compaction
   (which skips a summarized result) and the loops' prior-results preview
   (which prefers one) would otherwise keep serving "waiting for a decision" to
   the re-entered controller and to every later turn. For the same reason,
   `compactBulkData` never summarizes a held result. When the sanitizer finds
   something, the result carries only the redacted summary (counts and rule
   ids); no `content_sanitized` event is emitted, so no verbatim span enters
   the blob (SD-3). A held result is identified by the **UUID v4 inside** its
   `requestId`, not by an exact match, so a placeholder that the injection
   guard's LLM screen fenced is still substituted (#481 F1).
10. A chosen option with `stopsRun` ends the run `done`, with the response
    `Stopped at your request (<kind>).`, and re-enters nothing.
11. Otherwise `runChain(…, { startAt: resumeAt.index })`: the patterns before it
    are skipped (their events and data are already in the context), and the
    paused top-level pattern runs again from its start. A gate it reaches
    replays its answer from the journal. The run may pause again at a new gate,
    by the same path.

Before step 10, the **legacy-blob scrub** deletes `ctx.data.approved`, as
`continueSession` does; both stay until 1.0 [F9]. A 0.1.x paused blob holds no
`hitl_request`, so it cannot be resumed (`no-pending`): `continue()` it.

The `hitl_response` events a resume or a supersede appends are **not emitted
live**: their wire shape belongs to the host's resume stream (#433 S7/S8).

### humanGate() and confirm()

The gate patterns (#433 S4): the custom case first, the one-call preset over
it.

```typescript
const gate = humanGate<PlanData, 'approve' | 'reject'>({
  request: (view, data) => decideWhatToAsk(data) ?? null, // null asks nothing
  onAnswer: (answer, data) => ({ ...data, decided: answer.choice }),
})

const agent = harness(
  planner,
  confirm<PlanData>({ question: (d) => `Run this plan? ${d.plan.summary}`, key: 'plan' }),
  executeLoop,
)
```

`humanGate({ request, onAnswer })` is a leaf pattern. `request(view, data)`
builds the `HitlRequest` — the full surface: kind, options with their flags and
`unattended`/`stopsRun`/`unavailable` marks, the default, a summary, a
`payloadRef`, a rule and an expiry — or returns `null` to pass through without
asking. When `askHuman` answers (a replayed decision, or the unattended rule's
pick), `onAnswer` runs once per DECISION — on the run that raised it, and
again on the re-entry after a resume, where the replayed answer is the
person's — with the shape the record holds (`HitlResponseEventData`, without
the host's `principal` and `resolution`, which a pattern never sees) and its
return value becomes the pattern's data. To read a decision in a LATER turn
instead, give the request an explicit `key` and call
`answerOf(view, kind, key)`.

`confirm(config)` presets it: two options, **in display order Approve first,
Reject second** — deliberately the opposite of §7's default-first pattern, a
recorded decision (#433, amendment of 6003928300), so a future "harmonization"
with §7 has to argue past it — with **Approve** never picked without a person
(P4), and **Reject** the default, the unattended choice, and by default a
`stopsRun` option, so a rejection ends the run (`Stopped at your
request (confirm).` after a resume; the unattended rule's pick ends it `done`
at the boundary with a fixed response). `onReject: 'continue'` keeps `stopsRun`
off the option, so a rejection lets the chain run past the gate. `unattended:
'park'` makes an unattended run wait instead of deciding. `approveLabel`,
`rejectLabel` and `summary(data)` are display only; `question` may be computed
from the data; `key` should be given when a later turn will read the decision
with `answerOf(view, 'confirm', key)`. Every other config field passes through
to the pattern (`patternId`, `viewConfig`, …).

**Bound forms.** The runner `harness(...)` returns carries the agent's own
patterns: `agent.resume(serialized, answers, opts?)` and
`agent.continue(serialized, input, onEvent?, frame?)` — the same calls as
`resumeHarness` / `continueSession`, without the patterns argument, so a
resume can only be made on the agent the pause belongs to. The `Harness<T>`
interface carries `harness()`'s own generic bound
(`T extends HarnessData & Record<string, unknown>`, the same bound
`resumeHarness` declares) rather than the sketch's bare `T`, so the interface
and the factory cannot drift apart (#433, amendment of 6003928300). The
standalone functions remain for hosts that hold the pattern array themselves.

### Supersede and expiry

**A new message supersedes the run that was waiting** (D11).
`continueSession` first records `{ choice: null, by: 'superseded' }` for every
request the run still waits on, and substitutes their held results with
`The user did not answer; nothing was kept.` — before its reset and before the
new `user_message`, so the closing events belong to the run they close. The new
run starts with an empty journal: its window starts at the new message.

**`expireHitl(serialized, now)`** closes what nobody answered in time. Expiry
is lazy — the host calls it when it next reads the conversation, and after a
resume refused as `expired` — and both use one predicate (`now >= expiresAt`),
so a request a resume refused as expired is one `expireHitl` closes. Every
request past due with no response gets `{ choice: null, by: 'expired' }`: a
blocking one the current run waits on, and a non-blocking proposal wherever it
sits in the log [m6]. Held results are substituted with
`Nobody answered in time; nothing was kept.`. When a blocking request expired
while the run was paused, the run ends `done` with a fixed response and
re-enters nothing, and the run's **other** pending requests are closed
`{ choice: null, by: 'superseded' }` (#481 F2): answers are all-or-nothing, so
once one has expired the rest cannot be answered either, and a finished run
never lists a pending request. It returns the new blob with the `expired` and
`superseded` ids, or `null` when nothing was due.

Superseding and expiring never choose for the person (P4): both record
`choice: null`, and neither re-enters a pattern.

### Properties (P1–P6)

**P1 · Pause binding.** An answer resumes only the pause it was issued for. It
is accepted only when it names a blocking request pending in the CURRENT run,
not expired, raised on the same tier, with an available option of that request
event as its choice — and when every pending request is answered in the same
call. Acceptance appends a `hitl_response`, so presenting the same answer again
is refused: a replay, a double submit, an answer to pause A while the run
waits at B, and an answer from an earlier run all fail step 3. Within a run,
replay is bound by kind, key and option-id set [F8]. Preconditions, which the
host owns:

- **(a)** the blob is server-held, owner-scoped state, never accepted from a
  client — `deserializeContext` is a bare `JSON.parse`;
- **(b)** request ids are unique: `crypto.randomUUID()`;
- **(c)** the request that carries an answer is authorized by the host: a
  `POST`, owner-scoped, gated before any resource is touched, same-origin;
- **(d)** single use against a CONCURRENT resume of the same blob is a version
  claim, not a status claim: save a resume's result only if the stored blob is
  still the version that was loaded, and make every context write conditional
  on it. Core resumes a string; two resumes of one string both run.

**P2 · Content is withheld while held.** While a request is pending, the tool
result is a `HeldResult`; a loop that ignored the stop check would still never
see the content.

**P3 · HITL payloads stay out of prompts.** `formatEventData` renders both
events metadata only — never `question`, `summary`, `options`, `principal`,
`flags` or `resolution`. A resolution reaches a model only through the
substituted, sanitized `tool_result`.

**P4 · Nothing is chosen for a person.** An option without `unattended: true`
is never picked by the rule, by expiry or by supersession; expiry and
supersession record `choice: null` and never re-enter.

**P5 · The tier, scoped.** `resolve` runs inside the run frame, so a model call
it makes through the host's per-call client override takes the run's tier, and
a resume onto a different tier is refused (`tier-changed`). An embedding
provider is not a model call through that override, and is outside this
property.

**P6 · Only core writes HITL events.** `createEvent` and `trackEvent` refuse
both types; `commitEvents` and `chain()` drop every one a scope carries;
`EventView.get()` never hands out the live log; HITL events are deep-frozen
when minted and when deserialized; and the run's bookkeeping store admits only
what `askHuman` could have written. `readHitl` reads only `hitl_*` events, so a
legacy `approval_response { approved: true }` answers nothing.

## Decisions (typedDecision, #418)

Probability-typed decisions over a closed label set, in three layers: the
**raw seam** (`DecideFn` → `DecideResult`) — one call, one distribution, no
policy, frozen against the merged `classifierFromDecide` consumer, which must
be handed the raw seam and never a policy-applying wrapper (D7); the **policy
layer** (`patterns/typedDecision.server.ts`) — applies a `DecisionPolicy`,
records `decision_made`, never throws; and the **transports** behind the raw
seam (a logprob readout on the private tier, Jev on the Anthropic tier, an
operator-named verbalized secondary — #418 T3/T4/T5).

T1 carries the TYPES (`DecisionSpec` / `DecisionSetSpec` with `mode`,
`DecisionMethod` incl. `'jev'`, `AbstainReason` incl. `'method-mismatch'`,
`DecisionPolicy` with `thresholdMethod`, `DecisionCalibrationEntry`,
`DecideFn` / `DecideAllFn`, `MAX_DECISION_LABELS` = 20) and the PURE scoring
half; T2 adds the awaited wrapper (`evaluateDecision` / `decide` /
`decideFields`), the `typedDecision` chain step and `decisionRouter`; the
transports are harness-baml and app slices (T3–T5).

The pure policy math, unit-pinned:

- `sumLabelMass(top, labels)` — the logprob readout's letter-variant summing:
  every top-k token trimmed to the letter it names (`'B'`, `' B'`, `'(B'`),
  summed as probability mass, with `coverage` = the matched mass (the leftover
  is `1 − coverage`).
- `calibrateLabelMass(mass, entry)` — the host-fed calibration entry applied
  in log space (temperature ÷, bias +, softmax). A malformed entry degrades to
  the identity; it never throws. Jev takes fitted cuts only: harness-baml's
  `configureDecisionCalibration` throws on temperature or bias for a
  `JEV_CLIENTS` member, even identity values (G7).
- `normalizeLabelMass(mass, labels)` — a distribution over the spec's labels:
  unseen label 0, sum 1.
- `preCallAbstain({ policy, state, method })` — the F3 pre-call gate:
  `'no-state'` on an empty state; `'uncalibrated'` when `requireCalibrated`
  and the resolved client's method is KNOWINGLY non-calibratable (a verbalized
  secondary). Calibratable methods and unknown ones are called — the post-call
  `calibrated` check is the honest gate there.
- `resolveDecisionCuts(policy, entry, method)` — the F2 threshold resolution:
  the applied calibration entry's own cuts win; otherwise the policy's apply
  only when the serving method equals `policy.thresholdMethod ?? 'logprob'`;
  otherwise the cut is a mismatch → the decision abstains
  `'method-mismatch'` rather than applying a threshold tuned on another
  distribution.
- `scoreDecision(input)` — the pure half of `evaluateDecision`: abstain in the
  order `no-state` → `error` → `uncalibrated` → `low-coverage` →
  `method-mismatch` → `low-confidence` → `low-margin`; on every abstain or
  error the label is `policy.fallback` (REQUIRED, D8) and `top` is the argmax
  (`null` only with no distribution at all); `margin = p₁ − p₂`,
  `confidence = (K·p_max − 1)/(K − 1)`.

#### The awaited wrapper

```typescript
interface DecisionCall<L> {
  decide: DecideFn // the raw seam
  spec: DecisionSpec<L>
  state: string // only its LENGTH is ever recorded
  policy: DecisionPolicy<L>
  shadow?: true
}

evaluateDecision(call): Promise<{ decision; event; llmCall?; error? }> // scope-free, never throws
decide(scope, call, opts?): Promise<Decision<L>> // + records, never throws
decideFields(scope, call, opts?): Promise<{ [K in keyof F]: Decision<F[K]> }>
```

`evaluateDecision` asks the transport what it will serve, calls the raw seam
and scores the outcome with `scoreDecision`. It NEVER throws: a seam that
throws, one that returns junk (not an object, no `probs`, no usable mass) and a
pre-call refusal are all an **abstained decision whose `label` is
`policy.fallback`**, and a throw or an unusable readout also yields an `error`
(`kind: 'llm_call'` when the throw carried an `LLMCallError`'s record). A
readout with ANY entry that is not a finite non-negative number is unusable as
a whole (`reason: 'error'`) — it is never renormalised over the entries that
survive, which would invent certainty from a corrupt distribution. The thrown
message is **redacted of the call's `state` and capped at 500 characters**
before it enters the `error` event, because a transport that echoes its request
would otherwise copy the state into an event that is JSON-dumped into LLM-facing
views (SD-3); the state survives only in `llmCall.variables`.

`decide` is `evaluateDecision` + the recording: exactly ONE `decision_made`
(`opts.trackHistory`, default `'decision_made'`; `decision.eventId` is the
recorded event's id) and, on failure, ONE `error` (`opts.errorSeverity`,
default `'recoverable'` — a failed decision always has a verdict, so the
CONSUMER knows whether the turn can proceed on it). The call record
(`llmCall`) rides exactly ONE event, so its cost is counted once: the `error`
event when the call threw with a record, `decision_made` otherwise. Use
`evaluateDecision` where there is a context and no scope (the post-response
position).

**`DecideFn.serving` — the adapter's contract.** The raw seam carries two
facts `evaluateDecision` needs and the call alone cannot tell it, so a
transport MAY expose them:

```typescript
serving?: (key: string) => { method?: DecisionMethod; calibration?: DecisionCalibrationEntry }
```

- `method` is the method of the client the call WILL be served from, resolved
  per call from the spec key. It is what lets the F3 gate abstain a
  `requireCalibrated` decision on a knowingly verbalized client **before** the
  call (zero LLM calls).
- `calibration` is the host-fed entry for (serving client, `key`). Its
  `minConfidence` / `minMargin` WIN over the policy's static thresholds (F2).
- **Absent `serving` removes only the pre-call shortcut, never a check.** The
  method then comes from the result's own `method`, so the post-call
  `'method-mismatch'` and `'uncalibrated'` abstentions still fire. A `serving`
  that throws is treated as absent.

The T3/T4 adapters fill it. `DecideAllFn` carries the same member.

#### `decideFields`

The owner's "ONE call, SEVERAL typed fields". The provider decides how the set
is served:

| How         | When                                                                 | Calls                                                                                               |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `decideAll` | `decideAll` is supplied and either fields mode or Jev serves the set | ONE request; each field a typed question                                                            |
| joint       | `set.mode === 'joint'` on other transports                           | ONE `decide` pass over the label **product** (ids `'a \| b \| c'`), marginalised back to each field |
| per field   | otherwise                                                            | one `decide` pass per field, **sequential**, with a byte-identical state                            |

Jev is detected through `decide.serving(set.key).method === 'jev'` (G1/G8),
never a client name. Its joint mode is treated as fields before validation,
so the product-size limit does not apply. With `decideAll`, all questions
share one request; without it, each field uses `decide` separately.

The state prefix is byte-identical across the per-field passes, so the backend's
prefix cache serves every pass after the first. A field whose pre-call gate
refuses it is left out of the set call. `decideFields` records ONE
`decision_made` PER FIELD — each has its own key, policy and calibration and
must be independently attributable — and ONE `error` for a set-wide failure.
`decision_made` is excluded from the progress bar's step count (app slice T6),
so a four-field set does not add four steps.

`assertDecisionSetSpec(set)` throws for a `mode: 'joint'` set whose label
product exceeds `MAX_DECISION_LABELS` (a joint pass reads the product's mass
from one top-k window). It is a programmer error, so it throws — call it where
the set is declared to fail at construction; `decideFields` calls it first
after resolving Jev to fields mode, before any call. The standalone guard
has no serving report, so it also refuses wide Jev joint sets that
`decideFields` serves as fields.

#### `typedDecision(config)`

```typescript
interface TypedDecisionConfig<L> extends PatternConfig {
  decide: DecideFn // REQUIRED — `bamlPatterns().decide` (T3), or your own
  spec: DecisionSpec<L>
  policy: DecisionPolicy<L> // `fallback` must be one of the labels (checked at construction)
  state?: (view: EventView, data) => string
}
interface TypedDecisionData {
  decisions?: Record<string, Decision>
}
```

A chain step that asks one closed question and writes the verdict to
`scope.data.decisions[spec.key]`. It generates no text and never throws.
**`data.decisions[spec.key]` is overwritten on EVERY exit** — success, a failed
call, an empty state, a throwing `state` builder — because `scope.data`
survives the turn boundary and a verdict left in place would be last turn's
(the router and planner clear their outputs for the same reason). Other keys
are left alone.

The default `state` is the window's user messages plus FINAL assistant
messages (the router's intermediate status lines are not part of the
conversation), think-blocks stripped, oldest dropped to fit
`decide.limits().contextWindow` (16 384 when the transport reports none).
Tool results are opt-in — pass your own `state`: an assistant reply can echo
untrusted tool content. The default view mirrors `router`'s
(`fromLastNTurns: routerTurnWindow`) and narrows to messages; **when you pass a
`state` and no `viewConfig`, the narrowing is dropped** (the turn window stays)
so your builder can see `tool_result` events. It declares
`capabilities.decisionKeys: [spec.key]`.

Defaults (all three maps carry an entry for the type): `commitStrategy:
'always'`, `trackHistory: 'decision_made'`, `errorSeverity: 'recoverable'`,
`estimateTurns: () => 1`.

#### `decisionRouter(routeDescriptions, config)`

```typescript
interface DecisionRouterConfig extends PatternConfig {
  decide: DecideFn // REQUIRED
  policy: DecisionPolicy<string> // `fallback` names the ROUTE taken on abstain / failure
  conversationalRoute?: { name: string; description: string } // an ORDINARY route key
  preserveIntent?: boolean // default false: clear data.intent
  shadow?: boolean // record, set nothing
}
```

The decision-typed sibling of `router()`: the routes (plus
`conversationalRoute`) are the labels of one decision under the key `route`,
and the verdict becomes `data.route`; pair it with `routes()`. It produces the
ROUTE only — not the reply and not a rewritten `intent` — so compose
`compactIntent` first (with `preserveIntent: true`) and dispatch the
conversational route to a pass-through that the final `compactExecution`
answers.

- It **never sets `DIRECT_RESPONSE_ROUTE`**: a decision has no reply text to
  pass through, so that sentinel would end the turn empty. A route named like
  it is refused at construction, as are duplicate route names and a
  `policy.fallback` that is no route.
- `routes()` never sees an undefined route: every verdict is a label (the
  fallback is required). A non-failure abstain (low confidence, …) continues on
  the fallback route.
- **Failure parity with `router`**: the default `errorSeverity` is
  `irrecoverable`. A FAILED decision (`reason: 'error'`) clears `data.route` and
  `data.intent` and ends the turn where it happened.
  `errorSeverity: 'recoverable'` instead continues on `policy.fallback`.
- A state that cannot be built is a failure like any other: routing is cleared
  (non-shadow), the abstained `no-state` verdict is written and one `error`
  is recorded at the pattern's severity (shadow records only).
- `preserveIntent: false` clears `data.intent` so a conversation migrated from
  `router()` cannot carry the old router's intent into the next loop.
- `shadow: true` records the decision (`decision_made.shadow = true`) and sets
  **nothing** — not `route`, `intent` or `data.decisions` — so it can run
  beside `router()` to measure agreement. A shadow failure is always
  `recoverable`, whatever `errorSeverity` says: it can never end a turn.

Defaults: `commitStrategy: 'always'`, `trackHistory: 'decision_made'`,
`errorSeverity: 'irrecoverable'`, `estimateTurns: () => 1`.

The `decision_made` event is in `ALWAYS_COMMIT_TYPES` and renders METADATA
ONLY into LLM-facing serializations (`key: label (p, margin)` plus the abstain
reason — the `state` never enters the event; it survives only in the
transport's `llmCall.variables`). `PatternCapabilities.decisionKeys` +
`harnessDecisionKeys(patterns)` make the declared decision surface readable
without running the harness. `calibratedDecisionKeys` +
`harnessCalibratedDecisionKeys(patterns)` name the subset whose policy sets
`requireCalibrated` — the keys that abstain on every call until a calibration
entry exists — and are what a host's per-tier calibration probe warns about
(#418 T6; `typedDecision` and `decisionRouter` declare it, and only when the
policy requires it).
`getEventPreview` renders `decision_made` as `key: label`, or
`key: abstained (reason) → fallback`; never the question or the state.

## Memory recall (memoryRecall, #419)

The recall half of `withMemory`: a chain step that runs BEFORE routing and, when
the user's message plausibly depends on what the system remembers about them,
attaches the few best-matching memories to the turn. It generates no text.

```typescript
harness(
  memoryRecall({ store, decide, embed, owner, visibleTiers, awaitWake }),
  router(),
  routes({/* … */}),
  compactExecution(),
)
```

It is shaped after `retriever`: `commitStrategy: 'always'`, `errorSeverity:
'recoverable'`, `estimateTurns: () => 0`, its backends injected. **Core stays
generic** — no database, no network, no embedder, no provider vocabulary (a tier
is an opaque string, the run frame's own rule). Everything the host owns arrives
through five REQUIRED seams:

| Config                        | What it is                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store: MemoryStore`          | `count(tiers)` and `candidates({ embedding, embedSpace?, tiers })`. **No method takes an owner**: the host binds the turn's owner into the store it hands in. The recall query is EXACT — every active row of the owner in the visible tiers, each with its cosine distance, no `ORDER BY`/`LIMIT` — because BM25's document frequencies are computed over exactly that corpus. |
| `decide: DecideFn`            | #418's RAW seam. The step applies its own `DecisionPolicy` through `evaluateDecision`; hand it `bamlPatterns().decide`, never a policy-applying wrapper.                                                                                                                                                                                                                        |
| `embed: MemoryQueryEmbedder`  | `query(text)`, plus an optional `spaceId`. A row from another space is refused (`skipped: 'error'`), never ranked on.                                                                                                                                                                                                                                                           |
| `owner: () => string \| null` | From the host's request context, never an argument. `null` → `skipped: 'no-user'`.                                                                                                                                                                                                                                                                                              |
| `visibleTiers(turnTier)`      | Which stored tiers a turn of this tier may read. The rule lives where the tier vocabulary does (the app: `anthropic` sees `anthropic`; `verda` sees both). **Fail closed** for an unknown tier.                                                                                                                                                                                 |

Optional: `awaitWake` (below), `tier` (default: the run frame's `inference.tier`),
`limits` (the responder's window, for the 5% ceiling) and `settings`.

### The pipeline

1. **Clear** `data.memories` and `data.memoryContext` — FIRST, before anything
   can fail. `scope.data` survives the turn boundary, so a failure that returned
   it untouched would hand the NEXT turn this turn's memories (pin
   `per-turn-clear`).
2. **Owner** (`no-user`) → **switch** (`settings.enabled`, `disabled`) → **count**
   in the turn's tiers (0 → `empty`, with no gate and no embedding paid) →
   **query** (the latest user message; none → `no-query`).
3. **Gate, search and wake run concurrently** under one deadline,
   `gate.timeoutMs` (default 1500 ms), so the turn pays the slowest of the three
   and not their sum. The gate asks `memory.recall` (`retrieve | skip`, fallback
   `skip`) over the latest user message and the previous FINAL assistant message
   — **never memory content**.
4. **Rank** (`rankMemories`, `memory-ranking.server.ts`): NFKC tokenizer
   over `\p{L}`/`\p{N}` runs with identifiers kept whole (beside their parts) and
   small EN/NL/FR stopword lists, no stemming; BM25 (k1 1.2, b 0.75; Lucene's
   non-negative idf) over the user's own rows; cosine similarity `s_v = 1 −
distance`; the **floors BEFORE fusion** — a row survives a channel only if
   `s_v ≥ τ_v`, or it shares a non-stopword query term of length ≥ 3 with
   `idf ≥ τ_idf`; **RRF** (k = 60) over each channel's surviving ranked list,
   ties on `s_v`, then `last_seen_at`, then id. RRF is rank-only, so a fused score
   cannot reject garbage: floored AFTER fusion, rejected rows would take rank
   positions from the survivors (pin `bm25-rrf-floors`).
5. **Cap**: `maxMemories` (default 5) then `maxMemoryTokens` (default 400 via
   `estimateTokens`, hard-capped at 5% of `limits().contextWindow`). The block
   stops at the first row that does not fit — it never skips to a smaller,
   lower-ranked one.
6. **Attach** only when the gate's verdict `label` is `retrieve`. The verdict is
   the policy's: an abstain, an error, a timeout and an out-of-set answer all
   land on the fallback, so none attaches (pin `gate-policy`) — read `label`,
   never `top`.

`data.memories` is `RecalledMemory[]` (`{ id, kind, tier, content }`) and
`data.memoryContext` the formatted block (`- [kind] content`, one line per
memory, no ids) that a responder renders in its run-static part. Two patterns
consume it (#419 M5a): `compactExecution` copies a non-blank `data.memoryContext`
into `CompactExecutionInput.memoryContext` (the key is ABSENT when nothing was
recalled), and `router` (unless `routerMemory: 'replies-only'`) hands it to `route` as a trailing fourth argument,
`RouteExtra { memoryContext? }`, again only when non-blank — so a `route` written
before `RouteExtra` sees the three-argument call it always saw. Neither renders
anything itself: the BAML adapters pass the block to the trailing `memory_context`
parameter, escaped (see the DATA fence below).

### The gate's thresholds are method-scoped (#418 F2)

`gate.minConfidence` (default 0.5) and `gate.minMargin` (default 0.25) are
fitted on `gate.thresholdMethod` (default `logprob`) and handed to the policy as
its static cuts. On a read from another method (Jev on the Anthropic tier) they
are NOT applied: the calibration entry `decide.serving(key)` reports for that
client carries its own cuts, which win, and with no entry the gate abstains
`method-mismatch` and attaches nothing. The step applies **no threshold of its
own** on top of the policy's — a second static `margin ≥ minMargin` is exactly
the logprob-fitted cut applied to a Jev read (pin `recall-threshold-method`).
Every default in this section — those, `τ_v` (0.5), `τ_idf` (0.5), the 1500 ms
budget — is an unmeasured placeholder; layer 4's `memory-recall-relevance`
calibrates them.

### The joint memory wake

`awaitWake?: (budgetMs) => Promise<'awake' | 'skipped'>` is structurally the
app's `awaitMemoryWake` (`lib/inference/memory-wake.server.ts`, #419 M13): the
host binds it as it is and core imports no app code. The step passes it the
gate's own budget and runs it concurrently with the gate and the search. If the
wake reports `skipped`, or has not landed when the deadline fires, nothing is
attached and the event records `skipped: 'waking'`; the wake itself keeps
running, so the post-reply store and the next turn benefit. A deadline that
fires with the wake already `awake` is `skipped: 'timeout'`. The wake is
STARTED by the host before the chain's first pattern, and only for an agent that
opted in — `harnessUsesMemory(patterns)` (below) is that probe.

### It never stops what follows it

Every failure — a throwing store or embedder, a gate that errors, an expired
deadline, a rejecting wake, a throwing switch or owner resolver — ends in
`memories = []` and a RETURN. Nothing is rethrown and **no `error` event is
recorded**: an `error` is a statement about the turn (the synthesizer apologises
for one, `settleTurn` fails an empty turn on one), and an unavailable memory is
not one. Nor is it a `warning` — that renders a chat bubble, and the user sees
nothing. The thrown error is `console.warn`ed, and the event records only its
CLASS (`errorKind`): a message can quote what it was reading (pin
`recall-never-skips-downstream`).

### The `memory_recalled` event

One per turn, from every exit: `{ attached, considered, survivors, tier?,
tokens, skipped?, gate?, wake?, errorKind? }`. **IDS ONLY** — `attached` lists
memory ids and nothing in the payload is memory content; `formatEventData`
renders it from `skipped`/`attached.length` alone, so a field added later cannot
reach an LLM-facing serialization by the JSON dump (pin `event-hygiene`). The
gate's outcome rides in `gate` (label, probs, margin, confidence, abstained,
reason, method, calibrated, `stateChars`); recall records **no separate
`decision_made`**, and the gate's `llmCall` rides this event so its cost is
counted once.

### Memory text never rides the persisted blob (review F1)

`data.memories` / `data.memoryContext` hold decrypted memory text, and `ctx.data`
is part of the serialized session. `serializeContext` therefore drops
`TRANSIENT_DATA_KEYS` (`memories`, `memoryContext`) unless the run is `paused`
(a resume re-enters from the blob, so a paused blob keeps the block — short-lived,
but the same plaintext). Without it Forget and retention would never reach the
conversation blob or the nightly dump (pin `memory-not-in-blob`).

### Cost, and what is unrecordable

The gate's `llmCall` rides the `memory_recalled` event on the success path AND
on a deadline that fires after the gate answered (pins `recall-gate-cost`). A gate
that finishes after the event is written is unrecordable without a late mutation.

### Notes

- With ONE stored memory the lexical channel cannot fire (`idf(1,1) = 0.288 <
τ_idf 0.5`): such users get semantic-only recall. M11 calibrates τ_idf.
- `MemoryQueryEmbedder.spaceId` is REQUIRED, and the store is told `embedSpace`; a
  mismatch throws `MemoryEmbeddingSpaceMismatch` (a string compare, since
  `assertSameSpace` takes space objects, not ids).
- The recalled block carries no provenance fence: the responder's template fences it (`router.baml:72`, `compact-execution.baml:55`).

### `withMemory(cfg)(patterns)` and `memoryStoreConfig(cfg)` (#419 M5a)

```typescript
const patterns = withMemory<AgentData>(deps.memory)([router(...), routes({...}), compactExecution(...)])
// after the reply, from the host's compactAndSave continuation:
await settleMemory(ctx, memoryStoreConfig(deps.memory), { conversationId })
```

`withMemory` returns `[memoryRecall(cfg), ...patterns]` — an array combinator, not a
wrapper (a wrapper would break `runChain`'s per-top-level-pattern live toggle and
irrecoverable-error stop, and memory must reach two responders). The caller's
patterns come back as the SAME objects with the default. With `'replies-only'`,
each top-level function is wrapped at ingress (the config stays identical), so
a resume that skips recall still withholds memory from routing. It is the whole opt-in: it adds
`capabilities.memory`, which `harnessUsesMemory` reads.

`MemoryConfig` is ONE object for both halves. `store` is `MemoryStore &
MemoryWriteStore` (no shared member; no method takes an owner); `decide`,
`extract`, `embed`, `owner`, `visibleTiers` and **`enabled`** are required.
`enabled` is the user's switch and is required here, unlike on a bare
`memoryRecall` (where absent means on): D11 makes memory off until enabled, and
`memoryStoreConfig` hands the SAME function to the store half (where absent means
off), so recall and store cannot disagree about it. `recall` / `settle` carry each
half's tunables.

`routerMemory?: RouterMemory` is the developer's choice on this same wiring:

- `'routing-and-replies'` (default, option a) preserves today's router arguments
  and rendered prompt. The router may use recalled memory when writing `intent`.
  A tool route's task can carry facts from earlier conversations into tool
  arguments, for example a web-search query or a fetch. This includes tool egress
  even when model calls stay on private infrastructure.
- `'replies-only'` (option c) leaves the recalled block off every router prompt,
  including nested routers. Memory reaches only reply-writing steps:
  `compactExecution` and its `synthesize` path still receive it. The router's
  direct conversational answer has no recalled memory, and its direct-response
  route still skips synthesis. The current recalled block therefore cannot shape
  a tool route's intent or tool arguments through routing. It is a per-turn boundary, not a guarantee that remembered facts never reach a tool: a fact the reply states becomes conversation history, and on a later turn the router sees that history and may put the fact into `intent`, and so into tool arguments (#548).

Unknown values throw at the wiring boundary (`withMemory` and
`memoryStoreConfig`); they never silently fall back. `RouterMemory` is the exported
string-literal union of those two values. The choice is written on turn data by
the prepended recall step, so callers need no extra router plumbing and the
original pattern configs stay identical. This amends #419 D13 / decision 6:
controllers and the planner have no direct memory-block input, but option (a)
can carry memory indirectly through intent. Option (b), router memory for direct
answers only with no copying into intent or route, is deferred (#544).

This controls injection of the recalled block on the current turn. User text,
ordinary conversation history (including earlier replies), and custom patterns
that explicitly read `data.memories` are outside that boundary.

Spec §1's `policy` is carried per half (`recall.gate`, `settle.gate`). M3 adds `compact` and `retention` as OPTIONAL fields (absent: no compaction, and the D21 default retention), so a composition root written now keeps compiling.

### The DATA fence (harness-baml, #419 M5a)

`memory.baml`'s prompts, the `memory_context` blocks and `decide.baml`'s `state` put
text between `---BEGIN DATA---` and `---END DATA---`. The assistant's reply, which is
composed from tool results, is among that text: it is in the extractor's window and in
the store and recall gates' state. So `harness-baml`'s adapters pass every fenced
string through `escapeDataFence`. It rewrites each `BEGIN DATA` / `END DATA`, however it
is spelled (see `data-fence.ts`), to `BEGIN (data marker removed)` /
`END (data marker removed)`, and returns text without one unchanged. A verbatim
`evidence` span therefore stays verbatim, and an evidence span that overlaps a marker
in the user's own message fails closed. This is not the security control: acceptance
and the sanitizer are.

### `harnessUsesMemory(patterns)`

`PatternCapabilities.memory` is declared by `memoryRecall`; `harnessUsesMemory`
walks the (nested) graph for it. It is the ONE opt-in probe a host gates the
memory wake and the post-reply store on, so an agent that never opted in never
wakes the memory boxes.

## Memory store (settleMemory, #419)

The store half of persistent memory. After the reply, decide whether the turn
contains something worth remembering about the user and, if so, write it. **This
function writes persistent user data**, so every uncertain path ends in "store
nothing" — each is named below and pinned in `__tests__/memory-store.test.ts`.

```typescript
const report = await settleMemory(ctx, {
  store, // MemoryWriteStore — the transactional write seam, bound to the owner
  decide, // the RAW DecideFn (this step applies its own policy)
  decideAll, // optional one-request provider (Jev)
  extract, // MemoryExtractFn — the `describe`-role call
  embed, // MemoryEmbedder — query side AND documents(texts)
  owner, // () => string | null — from the host's request context
  tier, // () => string | undefined — default: the run frame's inference.tier
  awaitWake, // MemoryWakeWait — the app's awaitMemoryWake, as-is
  settings, // enabled (REQUIRED to write — absent stores nothing, D11), gate cuts, thresholds, softLimit, routineKinds, …
})
```

### Where it runs — and why its events are not lost (review F1)

`settleMemory` is a plain async function (the `compactBulkData` shape), not a
chain step. The host starts it **from inside its post-turn continuation**
(`compactAndSave`), which already holds the request context and the run frame,
and **awaits it there**, so every `memory_written` is in `ctx.events` **before
that continuation's `saveSession`**: one version-conditional save carries the
turn's events and the memory references together. It writes into `ctx.events`
directly and never through `trackEvent`, so `memory_written` can never reach a
live listener — which is to say the transcript. It **never throws** and never
touches the conversation row: a failure is a `console.warn` line (the reason,
never the user's words) and a returned `skipped` reason.

### The pipeline, and every fail-closed path

| #   | Step                                                                                                                                                                                                                                         | Stops with                                                           | Pin                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| 1   | owner (`null`/`''`), the user's switch (off or unreadable), the tier to stamp (none), the turn (`error`/`paused`), a question/answer pair (no `final` answer), the user message's event id (none — a retry could not be recognised)          | `no-user` `disabled` `no-tier` `turn-failed` `no-pair` `no-event-id` | `fail-closed`             |
| 2   | the joint wake, `wakeBudgetMs` (default 180 s): `'skipped'` or a rejection                                                                                                                                                                   | `waking` — and nothing is sent to a public provider instead          | `fail-closed`             |
| 3   | ONE `decideFields` over the window: `sensitive`, `target`, `confirm`, `kind`, each `requireCalibrated`, each with the gate cuts. Fallbacks fail closed: `sensitive → 'sensitive'`, `target → 'none'`, `confirm → 'ask'`, `kind → 'episodic'` | an abstained, failed or uncalibrated read lands on a fallback        | `seam-contract`           |
| 4   | `sensitive` (or its fallback); `target: none`                                                                                                                                                                                                | `sensitive` `gate`                                                   | `seam-contract`           |
| 5   | `resolveStoreRoute`: an org target ALWAYS asks (F2); a personal target skips the question only for a routine kind (default episodic/semantic/preference; `trait` always asks)                                                                | —                                                                    | `org-graph-forces-ask`    |
| 5′  | **pre-M12**: an org target has no writer. **pre-M6**: `ask` has no confirmation mechanism                                                                                                                                                    | `org-no-writer` `no-confirmation` — store nothing and log (F4)       | `pre-m6-no-store`         |
| 6   | extract (≤ `maxPerTurn`, default 3, read in order)                                                                                                                                                                                           | `extract-error` `no-candidates`                                      | `acceptance-rules`        |
| 7   | embed (`documents`): a throw, a wrong count, a non-finite or ragged vector, an empty `spaceId`                                                                                                                                               | `error`                                                              | `fail-closed`             |
| 8   | one transaction PER candidate (below)                                                                                                                                                                                                        | `failed` / `duplicates` in the report                                | `idempotency-transaction` |

The step-3 `decision_made` events are recorded on the context (one per field —
metadata and `stateChars` only, never the state), so "why was nothing stored" is
answerable from the blob. **An abstained kind stores `episodic`**: when the
`kind` field abstained, the extractor's claim of a longer-lived kind is not
trusted, and uncertainty fails toward the one kind with a retention expiry.

### Input isolation and the evidence rule (D9)

The window is the turn's last `user_message` plus the `assistant_message` with
`final: true` after it (`storeWindowTurns` adds earlier pairs). `tool_call`,
`tool_result`, `controller_action`, non-final assistant text and `llmCall`
records are **never read** (pin `input-isolation`). Because the final reply is
itself composed from tool results, excluding tool records alone is not enough:
**every memory's `evidence` must be a verbatim span of the CURRENT user
message** — assistant text and earlier turns resolve references, never source.

### Deterministic acceptance (`acceptCandidate`, pure)

Each rule drops the candidate and names itself; nothing is repaired. In order:
`kind` in the closed set · `shape` (one non-empty line, ≤ 280 characters) ·
`evidence-length` (≥ 8 characters after NFKC) · `evidence-verbatim` ·
`identifier-closure` (every URL, email, @handle, 3+-digit number and capitalised
name — only `the user they their this that a an it` may open a sentence
unchecked; any other sentence-initial capital is checked like every other —
occurs as a whole
token in a user message of the window) · `sanitizer` (`sanitizeUntrusted` reports
zero findings on `content`, because a memory is replayed into a later prompt).
`report.rejected` counts drops by rule id. A route that skipped confirmation on
the gate's kind also drops a candidate whose own kind must ask (`not-routine`).

### Dedupe, merge and idempotency (F9)

Per candidate, in ONE transaction that the host holds under the owner's advisory
lock (`MemoryWriteStore.transaction` — it MUST roll back on a throw):

0. Re-read `settings.enabled()` after acquiring the owner lock, inside EACH candidate's transaction and before its first write. False throws to roll that candidate back and reports `skipped: 'disabled'` (#552); the entry check alone cannot cover a switch-off during wake/extract/embed.
1. `nearest` memory of the same owner, tier and embedding space.
2. **Same kind and cosine ≥ `dupSimilarity` (0.92)** → reinforce. **Related
   (≥ `relatedSimilarity`, 0.75) preference or trait** → the `memory.merge`
   question `same | update | distinct`, bounded by `mergeTimeoutMs` and
   **`requireCalibrated: true`**; uncalibrated, abstain, a refused or thrown
   call, timeout or `distinct` → insert (both memories kept, never merged). Episodes and facts only reinforce or insert;
   kinds and tiers never merge.
3. Insert/reinforce/update **and the `memory_sources` row in the same
   transaction.** `addSource` returning `{ inserted: false, memoryId }` is the primary-key
   conflict on `(owner, eventId, ordinal)` (`ON CONFLICT DO NOTHING RETURNING`; a
   bare INSERT would abort the transaction): the transaction is rolled back, so a retry of
   the same event is a no-op (the reinforce is undone with it), and a crash can
   leave neither a memory without its source nor a source without its memory.
   `ordinal` is the candidate's index in the extractor's output.

The merge question runs INSIDE the transaction (it must see the lock's world),
which is why it has its own deadline. The thresholds are unmeasured placeholders
for layer 4.

### Erasure semantics (owner decision (b), M2 and M3 together)

**M7 precondition (#552, SD-10/SD-11):** both the "turn off" and "forget all" RPCs must flip the user's memory switch off **BEFORE** deleting. Forget-all uses the memory pool and the same owner advisory transaction lock (`pg_advisory_xact_lock(hashtextextended('memories:' || $1, 0))`) and `lock_timeout` as candidate writes. A `55P03` must reach the RPC as a retryable failure, never success. In-flight commits before the erase are deleted; candidates acquiring the lock afterwards re-read the disabled switch and write nothing.

Three rules, decided once for storing and for compaction:

1. **A source row is never dropped because the text moved on.** An `update`
   replaces the memory's `content`, `evidence` and vector in place (same
   `memoryId`) and keeps EVERY `memory_sources` row, including rows that no longer
   support the new text. `MemoryWriteTx` has no way to remove one, and a host's
   `update` must not delete any. **Compaction (M3) inherits the rule**: when
   it writes a merged memory it moves every member's source rows to it, **keeps
   all of them**, and deletes only the members themselves (the cascade must
   never take the moved rows with it). It does not prune the rows whose
   member text the summary dropped.
2. **Deleting a conversation removes every memory that ever drew on it:** every
   memory with ANY `memory_sources` row in that conversation, current or stale,
   dies together with its sources, not only memories left with no source. This
   errs toward erasing more, deliberately; it is what rule 1 buys. The delete
   itself is host-side (#531, `memories.server.ts`, called from both conversation deletes in one transaction): core records the
   `conversationId` on every row it writes (insert, reinforce and update alike),
   and the SQL pin for the cascade lives with that delete. This supersedes #419 decision 11 and D18 ("delete any memory left with no source" / "an orphaned memory"): implemented as worded there, deleting the conversation an `update` drew on would leave the memory alive through a stale row while it quotes that conversation verbatim.
3. **`evidence` names its event.** `MemoryInsertRow` and `update`'s `next` carry
   `evidenceEventId` — the `user_message` event id the stored `evidence` is a
   span of — and the host stores it on the memory row beside the text,
   replacing both together on `update`. Today it always equals the turn's user
   event (evidence is verbatim from the CURRENT message, D9); M3's merged
   memory takes the evidence AND the `evidenceEventId` of the member whose
   span it keeps. The field is required in the type, so a writer that omits it does not compile.

The merge question's fail-safe is part of the same decision: a merge destroys
the older text, so `memory.merge` needs a calibrated read, and every way of not
getting one lands on `distinct`, which inserts. Its static cuts carry no
`thresholdMethod` (they never inherit `settings.gate`'s), so they apply only to
a logprob read: on either tier, only a calibration entry fitted for (serving
client, `memory.merge`) lets `update` or `same` through. Until one exists the
question abstains every time — `uncalibrated` on the private tier's logprob
client, `method-mismatch` on Jev, the Anthropic tier's client, whose read is
calibrated by its own `confidence` claim (D8/D19) but whose cuts are not fitted
— and only the near-duplicate (≥ `dupSimilarity`) reinforce remains. Jev is
still called, and billed, for each such question; only a verbalized client is
refused before the call. Pins: `erasure-semantics`, `evidence-event-id`,
`merge-fails-to-keep-both`.

### The `memory_written` event

One per memory written, recorded after its commit:
`{ memoryId, kind, tier, eventId, ordinal, action }` — **never the content, nor a
hash of it** (#541). `formatEventData` renders it from `action` and
`kind` alone (pin `event-hygiene`). The extractor's `llmCall` rides the first one **redacted**:
`functionName`, `usage`, `metrics`, `durationMs`, `provider`, `clientName` only —
`variables`, `promptTemplate`, `rawInput`, `rawOutput` and `parsedOutput` are the
candidates and the window, i.e. the memory's text, and never reach the blob. A
call that produced nothing has no event to ride and is not recorded.

**Residual (host save).** "One save carries both" holds only if that save lands.
The host's trailing save (`saveTrailingPass`) is refused while a newer turn holds
the conversation, and `settleMemory` may sit in that continuation for the wake
budget plus extract, embed and merge time: a user who replies in that window
commits memories and loses their `memory_written` events. A retry repairs the
reference — on a conflict it re-records the event (`action: 'reinforced'`, its `kind`
from a `read`) when the context has none for `(eventId, ordinal)` — but nothing
replays a turn on its own. The mechanism (wait for the claim to release, or
reconcile `memory_sources` against events on load) is M5's, and M5 cannot land
without an interleaving pin for it.

`report.compactionDue` is true when the owner's count reaches `softLimit` (300);
compaction itself is the next slice.

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
view.get() // ContextEvent[] — always a new array, never the live log (#433)
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

`compactBulkData()` (in `compactBulkData.server.ts`, called by the consumer once
its response has been sent — in this repo by `harness-client/turn.server.ts`,
after the SSE stream closes on the interactive path and after the run completes on
the triggered one) folds the turn's results into **one
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

A **held** result (`result.held === true`, a gated tool's placeholder while a
person decides) is never summarized (#433 Δ2): a summary of "waiting for a
decision" would outlive the outcome a resume substitutes, because every later
view prefers a summary to the result.

A result left without a summary keeps its raw output, which every later view
already falls back to. When a describe call **threw** and at least one result
went without, the pass also records ONE `warning` event for the turn
(`task: 'result_summaries'`, #420) before persisting — a blank answer records
nothing, because a thin answer is not an outage. Both describe ops throw on a
failed call for exactly this reason; until #420 they returned `''` / an empty
map, which made a summarizer that was down look like one with nothing to say.

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

Three orthogonal configuration axes:

| Axis               | Controls                        | Options                                         |
| ------------------ | ------------------------------- | ----------------------------------------------- |
| **commitStrategy** | _When_ to commit                | `'always'`, `'on-success'`, `'last'`, `'never'` |
| **trackHistory**   | _What types_ to track           | `true`, `false`, `EventType`, or `EventType[]`  |
| **errorSeverity**  | Whether a failure ends the turn | `'recoverable'`, `'irrecoverable'`              |

```typescript
interface PatternConfig {
  patternId?: string
  commitStrategy?: CommitStrategy
  trackHistory?: TrackHistory
  errorSeverity?: 'recoverable' | 'irrecoverable'
  viewConfig?: ViewConfig
}
```

### errorSeverity — the chain gate

Patterns do not throw on failure; they record an `error` event and return. So
`runChain` decides what a recorded failure means, and `errorSeverity` is that
decision:

- **`recoverable`** — the chain continues. The failure cost something (a turn
  budget, a plan, a set of matches) but the patterns after it can still produce
  an honest answer. A `simpleLoop` that exhausts `maxTurns` is the canonical
  case: it records a recoverable error — marked `kind: 'budget_exhausted'`, see
  "Round budgets" — and the `compactExecution` answers from the partial
  results.
- **`irrecoverable`** — the chain stops at that pattern. `ctx.status` becomes
  `'error'`, `ctx.error` carries the message, and the pattern's own error event
  is what the user sees (no second event is pushed, so the transcript shows one
  error bubble rather than two). Everything after it is skipped, because the
  alternative is a downstream synthesizer composing a confident answer out of
  an execution that produced nothing.

Two levels, and the finer one wins:

| Where                                                                   | Classifies                                                | Read when                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| `PatternConfig.errorSeverity` (default: `DEFAULT_ERROR_SEVERITY[type]`) | the PATTERN — can this kind of pattern usually self-heal? | the event carries no severity        |
| `ErrorEventData.severity`                                               | this FAILURE                                              | always, and it overrides the pattern |

The event level exists because a pattern that is recoverable in general can hit
something it cannot come back from. Two do today, and they are the same
shape — _this run produced nothing for a later pattern to work with_:

- `simpleLoop` / `actorCritic` handed a **collapsed tool surface** (the gateway
  is unreachable, so the pattern lost the tools it would have had). No further
  iteration can bring them back. See `gateway-health.server.ts` — and note the
  guard fires on an amputated list as well as an empty one, because `listTools`
  degrades to the app-side tools rather than to `[]`.
- `parallel` when **no branch survived**, and when the fan-out itself throws.
  The default is right while one branch came back — the survivors are what the
  rest of the chain is for — and says nothing about zero.

In every case the classification is stamped on the EVENT rather than moved to
the pattern default, because only the failure knows which of the two it is.

Severity also drives presentation — `errorBubble` paints `recoverable` as a
warning and everything else as an error — and the gate only ever considers
events that were actually COMMITTED, so an error the transcript does not show
cannot stop the chain silently. `commitStrategy: 'never'` therefore opts a
pattern out of the gate.

**Every pattern type in the package has a `DEFAULT_ERROR_SEVERITY` entry.** The
fallback for an unknown (`configurePattern`) name is `'recoverable'`: we know
nothing about a pattern we have never seen, and the rule is to gate only when
the turn genuinely cannot continue.

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
    route: baml.router,
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
- `errorSeverity`: `irrecoverable` for `compactExecution`, `router`, `routes` and
  `chain` — the four whose failure leaves nothing for a later pattern to work
  with; `recoverable` for every other type. The per-type rationale is on
  `DEFAULT_ERROR_SEVERITY` in `types.ts`, one comment per entry.

## Event → BAML Type Mapping

Each BAML function receives a projection of the UnifiedContext event stream,
transformed into prompt-friendly types. The table below shows which harness
`EventType` values feed into which BAML input types for each pattern.

### Harness EventType → BAML Input Type

| Harness `EventType`  | Event Payload (TS)                                                                                                                                                                          | BAML Type                                               | Consumed By                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `tool_call`          | `ToolCallEventData` (`callId?`, `batchId?`, `tool`, `args`)                                                                                                                                 | `ToolCall`                                              | `LoopTurn.tool_call`, `Attempt.action`                                      |
| `tool_result`        | `ToolResultEventData` (`callId?`, `batchId?`, `tool`, `result`, `success`, `error?`, `summary?`, `hidden?`, `archived?`, `sanitized?`, `heldBy?`)                                           | `ToolResult`                                            | `LoopTurn.tool_result`, `Attempt.result/error`, `PriorResult`               |
| `controller_action`  | `ControllerActionEventData`                                                                                                                                                                 | _(embedded in `LoopTurn.reasoning`)_                    | simpleLoop, actorCritic                                                     |
| `critic_result`      | `CriticResultEventData`                                                                                                                                                                     | _(embedded in `Attempt.feedback`)_                      | actorCritic                                                                 |
| `user_message`       | `UserMessageEventData`                                                                                                                                                                      | `Message { role, content }`                             | router (history)                                                            |
| `assistant_message`  | `AssistantMessageEventData`                                                                                                                                                                 | `Message { role, content }`                             | router (history)                                                            |
| `pattern_enter`      | `PatternEnterEventData`                                                                                                                                                                     | _(not sent to BAML)_                                    | `chain` + wrapper patterns: `parallel`, `withReferences`                    |
| `pattern_exit`       | `PatternExitEventData`                                                                                                                                                                      | _(not sent to BAML)_                                    | `chain` + wrapper patterns: `parallel`, `withReferences`                    |
| `approval_request`   | _(legacy payload; its type was removed in #433 S3)_                                                                                                                                         | _(metadata only: `legacy approval event`)_              | legacy (#433): superseded by `hitl_request`, not an answer                  |
| `approval_response`  | _(legacy payload; its type was removed in #433 S3)_                                                                                                                                         | _(metadata only: `legacy approval event`)_              | legacy (#433): superseded by `hitl_response`, not an answer                 |
| `hitl_request`       | `HitlRequestEventData`                                                                                                                                                                      | _(metadata only — kind and request id)_                 | `readHitl()` / `answerOf()` (#433)                                          |
| `hitl_response`      | `HitlResponseEventData`                                                                                                                                                                     | _(metadata only — kind, choice and who decided)_        | `readHitl()` / `answerOf()` (#433)                                          |
| `error`              | `ErrorEventData`                                                                                                                                                                            | _(read via `view.hasErrors()`)_                         | compactExecution (error context), harness error handling                    |
| `reference_attached` | `ReferenceAttachedEventData`                                                                                                                                                                | _(not sent to BAML)_                                    | withReferences only (observability)                                         |
| `intent_compacted`   | `IntentCompactedEventData`                                                                                                                                                                  | _(not sent to BAML)_                                    | compactIntent only (observability)                                          |
| `plan_created`       | `PlanCreatedEventData`                                                                                                                                                                      | _(the plan reaches BAML as `plan_context` / `context`)_ | planner only; loops read `scope.data.plan`, not the event                   |
| `content_sanitized`  | `ContentSanitizedEventData`                                                                                                                                                                 | _(metadata only — NEVER the verbatim spans)_            | withInjectionGuard only (observability + human audit)                       |
| `loop_recovery`      | `LoopRecoveryEventData` (`failure`, `error`, `tool?`, `turn`, `maxTurns`)                                                                                                                   | _(metadata only — the turn log carries the feedback)_   | simpleLoop / actorCritic only (observability)                               |
| `decision_made`      | `DecisionMadeEventData` (`key`, `labels`, `probs`, `label`, `top`, `margin`, `confidence`, `abstained`, `reason?`, `policy`, `method?`, `calibrated`, `coverage?`, `stateChars`, `shadow?`) | _(metadata only — the state's SIZE, never the text)_    | typedDecision / decisionRouter (#418); consumers read `data.decisions[key]` |
| `memory_recalled`    | `MemoryRecalledEventData` (`attached` ids, `considered`, `survivors`, `tier?`, `tokens`, `skipped?`, `gate?`, `wake?`, `errorKind?`)                                                        | _(metadata only — IDS, never memory content)_           | memoryRecall (#419); consumers read `data.memories` / `data.memoryContext`  |

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

> **Raw LLM output on a failed call**: an `error` event whose failure is
> attributable to an LLM call carries `ErrorEventData.kind: 'llm_call'` (the
> field's other values: `budget_exhausted` marks a loop truncated by its round
> budget — nothing failed there, so no call data is attached — and
> `recovery_exhausted` marks a loop ended by its consecutive-recovery cap, which
> carries the failed call exactly as `llm_call` does) and the
> full `ContextEvent.llmCall` — crucially `rawOutput`, the only record of what
> the model actually said. Two families qualify and both must attach it:
>
> 1. **the call failed** (BamlValidationError, fallback exhausted, network).
>    The adapters wrap the throw as `LLMCallError` carrying
>    `extractFailureLLMCallData(collector, …)`, and the catching pattern
>    re-attaches it. Any BAML call site that throws BARE loses the collector —
>    that is what `wrapAsLLMCallError` is exported for.
> 2. **the call succeeded and its CONTENT is the defect** — a tool name off the
>    allowlist, `tool_args` that are unparseable or were cut off at the output
>    cap. The pattern already holds that turn's `llmCall`; it must carry it onto
>    the error event, because the error message quotes the args while only the
>    raw response shows where the response went wrong.
>
> Without this the panel renders "Output not captured" over a response that WAS
> captured, and the most common class of agent failure is undebuggable from the
> UI (#225 owner review).
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
router() calls the REQUIRED `route` seam → BAML-backed intent classifier
(the composition root passes `bamlPatterns().router` — routeMessageOp)

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
  createLoopControllerAdapter,
  createActorControllerAdapter,
  createCriticAdapter,
  type ConfiguredPattern,
} from '../harness-patterns'
// Patterns are data-type invariant: composing heterogeneous patterns under
// `harness()` requires pinning the SAME data type on every pattern (the real
// call sites all pin `SessionData` — see agents/search.server.ts).
import type { SessionData } from './session.server'

async function getSchema(): Promise<string> {
  const result = await callTool('get_neo4j_schema', {})
  return result.success ? JSON.stringify(result.data) : ''
}

async function createPatterns(): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools({ namespaces: mcpNamespace })
  const schema = await getSchema()

  // Use adapter factories (preferred over b.bind()); L14 — the tool list
  // appears once, at the loop, and rides the seam as ControllerInput.tools.
  const neo4jPattern = simpleLoop<SessionData>(createLoopControllerAdapter(), tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema,
  })

  const webPattern = simpleLoop<SessionData>(createLoopControllerAdapter(), tools.web ?? [], {
    patternId: 'web-search',
  })

  const routerPattern = router<SessionData>({
    neo4j: 'Database queries and graph operations',
    web_search: 'Web lookups and information retrieval',
  })

  const routesPattern = routes<SessionData>({
    neo4j: neo4jPattern,
    web_search: webPattern,
  })

  const responseSynth = compactExecution<SessionData>({
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
packages/harness-patterns/               # CORE — zero baml_client / @boundaryml/baml references (Lane A6 pin)
├── index.ts                # Public exports (no BAML-side symbols — those moved to harness-baml)
├── types.ts                # Core types (UnifiedContext, PatternScope, RouterConfig, DIRECT_RESPONSE_ROUTE, the seam callables ControllerFn/PlannerFn/CompactIntentFn/… )
├── context.server.ts       # Context factory, createEvent(), generateId()
├── tools.server.ts         # Tools({ namespaces }) — groups MCP tools by namespace; the map is REQUIRED (ruling B-iii); inferServer consults transports' namespaceFor → registered resolvers (registerToolNamespaces) → heuristic; NO catalog in core — the 86-entry map lives in app-tools/mcp-catalog.ts and registers at boot
├── run-frame.server.ts     # THE run frame — one ALS scope per run holding all six slots (guard / transports / config / live / inference / hitl — the last a frozen `{ attended }`), on a globalThis symbol so two loaded copies share one store (#374 D4). withRunFrame() opens or joins, amendRunFrame() scopes below a run and is the ONE place the per-slot merge asymmetry lives (transports prepend, hitl passes by reference and is refused below an open one, the rest replace), activeRunFrame() THROWS outside a frame and currentRunFrame() is the soft read
├── harness.server.ts       # harness() (a bound runner: agent.resume / agent.continue carry its own patterns, S4), resumeHarness(serialized, patterns, answers, { principal, resolve }), continueSession() — each OPENS the run frame (ruling Q17/D5) with a `{ attended: true }` hitl slot unless the frame says otherwise, or joins the host's and adds nothing; resumeHarness binds every answer to a request the run waits on before anything runs, continueSession supersedes what waits; HarnessResultScoped is a union on status — `pending` is non-optional when paused [F18]
├── hitl.server.ts          # Human in the loop (#433): readHitl() / answerOf() read the hitl_* events; askHuman() raises (or replays, or applies resolveUnattended()) into the run's HITL bookkeeping — an async-context store of its own on a Symbol.for holder, opened by the owning runChain, never on the frame (#477) — held() is a gated executor's placeholder, hitlPending() is the loops' stop check; the owning runChain commits from the buffer only what askHuman could have written, straight into the context, and pauses. S3: checkResume() is the pause binding (HitlAnswerError), recordAnswers() / supersedeHitl() / expireHitl() close requests and substitute held results through sanitizeUntrusted. S4: humanGate() / confirm() are the gate patterns — the custom case and the one-call preset over askHuman
├── tool-transport.server.ts # ToolTransport + registerTransport() (process, consulted after every scoped one) / activeTransports() (reads the run frame's `transports` slot); the difference between the two ways to supply one IS the containment invariant — there is no priority field and no argument that could express one
├── mcp-client.server.ts    # callTool(), listTools(); dispatches across THREE phases — scoped transports (innermost first) → process transports (registration order) → MCP gateway (terminal fallback, not a transport); leases one of N pooled gateway connections per call (`MCP_GATEWAY_POOL_SIZE`, default 4) so the reconnect-once retry rebuilds only the failing connection (issue #120); demotes `"<ToolName> Error:"` text results to `success:false` (issue #50); aggregates multi-text-block results into an array (single block stays scalar) so multi-value tools like Redis `smembers`/`lrange` don't drop all but the first element; drops the gateway's own management tools (`mcp-find`, `mcp-add`, `mcp-exec`, …) from the catalog (#412, #420), and `write_neo4j_cypher` and the `database-server` tools, which no agent holds (#403, #412)
├── agent-withheld-tools.ts # AGENT_WITHHELD_TOOLS + isAgentWithheldTool() — the tools no agent may hold (#403: `write_neo4j_cypher`; #412: the `database-server` tools), each with the decision and server-side switch its drop warning names (withholdingFor()), seen through a gateway or server-namespace prefix; read by listTools() (the catalog) and by simpleLoop/actorCritic (every allowlist check), never by callTool
├── compactBulkData.server.ts # compactBulkData(ctx, onPersist, { describe, describeBatch }) — the two describe fns are REQUIRED config (Lane A6); never summarizes a held result (#433 Δ2)
├── parallel-tools.server.ts # runBatch() + combineOutcomes() — multi-call turn executor (parallel/serial modes, stop-on-failure, index-keyed combined map)
├── loop-recovery.server.ts # The two loops' shared recovery rule (#437): isRecoverableLLMFailure(), the feedback texts, the consecutive-recovery cap (recoveryStreak()), trackLoopRecovery()
├── token-budget.server.ts  # trimToFit(), estimateTokens() — rolling context window (getContextWindow moved to harness-baml/clients.server with the model tables)
├── injection-guard.ts      # Deterministic prompt-injection sanitizer (pure): rule corpus, neutralization, spotlight fence, LLM-screen folding
│                           # (the guard's ALS scope was its own module until #374; it is now the run frame's `guard` slot, and `ActiveInjectionGuard` lives in injection-guard.ts beside the sanitizer it describes. Opposite nesting rule to transports — it UNIONS, see SD-5; read by callTool + retriever)
├── json-repair.ts          # Lenient JSON parser for LLM output (unquoted keys, trailing commas, BAML-stringified single-key objects with comma-rich values). No step is super-linear (#461, #463), and the lenient regex chain refuses input over 16 384 chars: it throws, never truncates
├── assert.server.ts        # Server-only guards
└── patterns/               # The pattern factories — a directory OF THIS package, exported as @hames-ai/harness-patterns/patterns
    ├── index.ts
    ├── router.server.ts        # router() + routes() — intent classification + dispatch
    ├── simpleLoop.server.ts    # ReAct loop; emits callId (+ batchId on multi-call turns) on tool_call/tool_result; resolveRefs(); config-driven cross-turn memory
    ├── actorCritic.server.ts   # Generate-evaluate loop; emits callId (+ batchId) on tool pairs
    ├── judge.server.ts         # Evaluation pattern for quality gates
    ├── parallel.server.ts      # Concurrent branches; wraps each branch with pattern_enter/exit
    ├── withInjectionGuard.server.ts # ALS wrapper attaching the injection guard; emits content_sanitized
    ├── with-references.server.ts    # withReferences() — hands a pattern the relevant results of earlier turns
    ├── chain.server.ts         # Sequential composition; accepts onEvent? for SSE streaming
    ├── compactExecution.server.ts   # Final response synthesis; skips BAML for DIRECT_RESPONSE_ROUTE
    ├── compactIntent.server.ts # Rewrites latest message → scope.data.intent for router-less actors; emits intent_compacted
    ├── planner.server.ts       # Upfront decomposition → scope.data.plan (+ formatPlanContext, read by both loop patterns); emits plan_created
    ├── retriever.server.ts     # retriever() — vector-store search as a pattern
    ├── typedDecision.server.ts # #418: the decision policy layer — the PURE half (sumLabelMass / calibrateLabelMass / normalizeLabelMass, preCallAbstain (F3), resolveDecisionCuts (F2), scoreDecision), the awaited wrapper (evaluateDecision / decide / decideFields) and the typedDecision / decisionRouter patterns
    ├── withMemory.server.ts    # #419 M5a: withMemory() + memoryStoreConfig() — one config and switch for both halves
    ├── memoryRecall.server.ts  # #419: memoryRecall() — the recall step (gate ∥ search ∥ wake, BM25 + cosine, floors before RRF, tier filter, per-turn clear, memory_recalled). The pure ranking half is ../memory-ranking.server.ts
    └── event-view.server.ts    # EventViewImpl (fluent query API, serializeCompact)

packages/harness-baml/                   # The BAML companion PACKAGE (Lane A6) — EVERYTHING that touches baml_client lives here
├── index.ts                # Public exports (bamlPatterns, adapter factories, routeMessageOp, client/role maps)
├── baml-patterns.server.ts # bamlPatterns() — the one factory for the eight REQUIRED injected fns (planner, router, compactIntent, retrieveQuery, describe, describeBatch, synthesize, selector) + adapters
├── defaults.server.ts      # defaultSynthesize (→ bamlPatterns().synthesize) + defaultSelector (→ bamlPatterns().selector) — the composition-root implementations, not pattern defaults
├── baml-adapters.server.ts # Adapter factories: createLoopControllerAdapter (tool list rides ControllerInput.tools — L14), createActorControllerAdapter, createCriticAdapter, createPlannerAdapter, describeToolResultOp, describeToolResultsBatchOp, createInjectionScreen
├── clients.server.ts       # The role → client maps (CLIENT_BY_ROLE / VERDA_CLIENT_BY_ROLE), clientOverrideFor, limitsFor, the tier (the run frame's `inference` slot) — moved byte-for-byte from core (Lane A6/A-i)
├── data-fence.ts           # #419 M5a: escapeDataFence() — neutralise known DATA marker spellings before rendering
├── routing.server.ts       # routeMessageOp — the router seam's composition-root implementation (`bamlPatterns().router`) (with limits())
├── baml-version-check.server.ts # Boot-time staleness warning for baml_client (#154)
├── consumer-clients.server.ts   # defineInferenceClients() / activateConsumerClients() — the bring-your-own-model seam
├── baml_src/               # THE one BAML corpus in the repo (role chains, leaf clients, prompts)
└── baml_client/            # Generated from baml_src/ and COMMITTED — never hand-edited, never regenerated implicitly
```

Both trees are abridged to the files this spec refers to; `patterns/` is a
directory of the CORE package, not of the BAML companion. The live self-hosted
endpoint checks (`smoke-verda.ts`, `smoke-verda-load.ts`) are the HOST's, not
either package's — they live in `app/src/lib/inference/scripts/`.

## Design Principles

1. **Adapters wrap BAML functions** - Pass adapter factories to patterns; they adapt the generated functions' positional call order (a raw BAML function does not satisfy a pattern's controller contract)
2. **Patterns extract params** - Patterns pull data from context and call BAML
3. **Config injects metadata** - Optional config for things like schema injection
4. **Server-only enforcement** - `.server.ts` files with runtime guards
5. **Session persistence** - Full context serializable for multi-turn conversations
