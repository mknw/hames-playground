# hames — developer guide

How to build a harness out of `@hames-ai/harness-patterns`: the composition model,
how to write your own pattern, the tool-transport seam, what the error surface
guarantees, and how to consume the package. For the complete per-pattern
reference — signatures, configuration, semantics — read
[SPEC.md](./SPEC.md); for what the library is and why, start at the
[front page](./README.md).

Every code sample in this guide is **typecheck-pinned**: the repo's test suite
extracts each snippet from this file and compiles it against the package's real
exports (`guide-docs-pins.test.ts`), so a sample that drifts from the exported
surface fails CI instead of rotting quietly.

Every snippet imports only from `@hames-ai/harness-patterns` — the package ships
TypeScript source and no build step; any bundler or runner that carries TS
(Vite, vinxi, tsx) runs it as-is.

---

## 1. The composition model

One data structure carries everything: the **unified context** (`UnifiedContext`)
— an append-only list of `ContextEvent`s plus a `data` bag. A session _is_ its
serialized context: `serializeContext` turns it into the JSON string you store,
`deserializeContext` turns it back, and `continueSession` picks the conversation
up with new input as if nothing had happened. There is no separate session
store, no second state machine.

Patterns are values of one shape:

```typescript
import { configurePattern } from '@hames-ai/harness-patterns'
import type { ConfiguredPattern, ScopedPattern, PatternScope } from '@hames-ai/harness-patterns'

const myPattern: ScopedPattern<Record<string, unknown>> = async (scope, view) => {
  // read the log through `view`, append events through `scope.events`
  return scope
}

const patterns: ConfiguredPattern<Record<string, unknown>>[] = [
  // combinators and leaves — every one of them is a ConfiguredPattern
  configurePattern('my-pattern', myPattern),
]
```

`ScopedPattern<T>` — a function `(scope: PatternScope<T>, view: EventView) => Promise<PatternScope<T>>` —
is the contract every primitive in the library satisfies, leaf and wrapper
alike. That is what makes composition ordinary TypeScript: `configurePattern`
attaches the config (`patternId`, `viewConfig`, severity — §2), and the
combinators take and return configured patterns.

### Scopes: write in isolation, commit on completion

A pattern never writes the shared log directly. `harness()` (and `chain()`)
hand it a **scope** — its own event buffer and its own view of the log. When
the pattern returns, its events are committed; if it throws, nothing it wrote
lands, and the chain records an `error` event instead (see §4). A step that
fails mid-flight leaves no partial state behind.

### Views: read through a declared slice

The `view` argument is an `EventView` — a query over the log whose slice is
declared once in the pattern's `viewConfig`, not re-argued at every call site:

- `fromPatterns` / `fromLastN` / `fromLast` — which patterns' events are visible
- `eventTypes` / `limit` — narrow by type and size
- `fromLastNTurns` — a rolling window bounded by `user_message` events
- `contentTransforms` — read-time reshaping (`truncateToolResults`,
  `stripThinkBlocks`) that never touches what is stored

The imperative twin is the selector chain: `view.fromLastPattern().ofType('tool_result').get()`
returns the matching events; `.serialize()` renders them to the string an LLM
prompt consumes; `.serializeCompact({ recentTurns: 2 })` degrades older detail
to pointers. A synthesizer sees the route that just ran; a router sees a few
turns and nothing else. Context is budgeted by construction.

### The combinator family

Every combinator takes patterns and returns a pattern, so they nest freely:

| Combinator           | What it does                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `chain` / `harness`  | run patterns in order; `harness` is the top-level entry that stops on irrecoverable error |
| `routes`             | dispatch on `data.route` (set by `router`); pass-through on the `'user'` route            |
| `parallel`           | run patterns concurrently, merge their event sets                                         |
| `withReferences`     | attach the relevant results of earlier turns at pattern ingress, expandable on demand     |
| `withInjectionGuard` | neutralize untrusted tool output before a controller reads it                             |

Resume and continue are the same mechanism: `resumeHarness(serialized, patterns, approved)`
after an approval gate, `continueSession(serialized, patterns, newInput)` for the
next turn of a conversation.

---

## 2. Writing a pattern

A leaf pattern is the type above plus events. Concretely:

```typescript
import { trackEvent, harness, configurePattern } from '@hames-ai/harness-patterns'
import type { PatternScope, EventView } from '@hames-ai/harness-patterns'

async function announce(scope: PatternScope, view: EventView): Promise<PatternScope> {
  const turns = view.ofType('user_message').get().length
  trackEvent(
    scope,
    'assistant_message',
    { content: `saw ${turns} user messages`, final: true },
    true,
  )
  return scope
}

const agent = harness(configurePattern('announce', announce))
```

- **Read** through `view` — the slice your `viewConfig` declared. `get()`
  returns `ContextEvent[]` in log order.
- **Append** with `trackEvent(scope, type, data, trackHistory)`. `trackHistory`
  selects which types the pattern persists (each pattern declares its own
  default — loops track the controller/tool cycle, synthesizers track the final
  message). The optional trailing `llmCall` argument attaches the usage record
  (see §4).
- **Carry data** on `scope.data` — it is typed by your pattern's data generic
  (`SimpleLoopData`, `RouterData`, … are the library's; your pattern declares
  its own). Downstream patterns read it only if your composition says so; data
  flows through the log, not through hidden channels.

### The wrapper discipline

A **wrapper** — `withReferences`, the router's dispatch — runs a child pattern
inside a **child scope** so the child's events are delimited by `pattern_enter` /
`pattern_exit` and can be committed or discarded as a unit. There is no public
helper for this yet (a `runChild` is planned); today you mirror the three
in-tree wrappers, of which `patterns/with-references.server.ts` is the
reference:

```typescript
import { createScope, createEvent } from '@hames-ai/harness-patterns'
import type { ConfiguredPattern, PatternScope, EventView } from '@hames-ai/harness-patterns'

function wrapChild(child: ConfiguredPattern<Record<string, unknown>>) {
  return async (scope: PatternScope, view: EventView): Promise<PatternScope> => {
    const childScope = createScope(child.config.patternId ?? child.name, scope.data)
    const result = await child.fn(childScope, view)
    scope.events.push(
      createEvent('pattern_enter', child.name, { pattern: child.name }),
      ...result.events,
      createEvent('pattern_exit', child.name, { status: 'completed' }),
    )
    scope.data = result.data
    return scope
  }
}
```

The two rules the wrappers enforce, stated as invariants:

1. **The child sees a fresh scope, not yours.** Its events are yours to
   promote or drop; it cannot write your buffer mid-flight.
2. **A failure in the child is recorded on your scope** as an `error` event —
   it does not erase what the child already committed under its own scope id.

### Configuration

`PatternConfig` is the shared axis — `patternId` (explicit id for referencing
later), `commitStrategy`, `trackHistory`, `viewConfig`, `errorSeverity`
(§4), and `liveEvents` (stream events to the harness `onEvent` listener as they
happen instead of buffering until commit). Per-pattern configuration
(`SimpleLoopConfig.maxTurns`, `RouterConfig.directResponseRoute`, …) extends it;
the full field list per pattern is in [SPEC.md](./SPEC.md).

`estimateTurns()` on a configured pattern projects how many turns the pattern
will produce (wrappers delegate to their children). `harness()` stamps the
estimate on the opening `user_message` so a progress UI can size itself before
the first event — the library exposes the primitive, your UI decides what to
paint.

One typing rule to know before you compose loops with `harness()`: the data
generic must extend `HarnessData` **and** carry an index signature — that is
what lets wrappers write `scope.data` generically. The concrete shape is in
§3's gateway example (`interface WebData extends HarnessData, SimpleLoopData
{ [key: string]: unknown }`).

---

## 3. Tool transports

A **transport** is anything that owns some tool names and can run them. The
seam has four members and no rank:

```typescript
import { registerTransport, amendRunFrame, activeTransports } from '@hames-ai/harness-patterns'
import type { ToolTransport } from '@hames-ai/harness-patterns'

const myBackend = {
  run: async (name: string, args: Record<string, unknown>) => ({
    success: true,
    data: 'ok',
  }),
  describe: async () => [],
}

const mine: ToolTransport = {
  id: 'my-sandbox',
  ownsTool: (name) => name.startsWith('sandbox_'),
  callTool: (name, args) => myBackend.run(name, args),
  listTools: () => myBackend.describe(),
}

// PROCESS-wide: consulted only after every scoped transport.
const unregister = registerTransport(mine)

// SCOPED: consulted FIRST, innermost-first, for the duration of one call.
// The run frame's `transports` slot — supplied when the frame is opened, or
// amended below it like this (which is what `withSandbox` does).
await amendRunFrame({ transports: [mine] }, async () => {
  /* any dispatch inside this call reaches `mine` first */
})
```

Two properties are the design, not accidents:

- **Two ways to supply, and the difference is the invariant.** The run frame's
  `transports` slot is bounded by one run (or by one `amendRunFrame` below it);
  `registerTransport` is a module-level list. Any tool name owned by a _scoped_
  transport is dispatched there before any process-registered transport and
  before the gateway — there is deliberately **no `priority` field**, so
  containment cannot be inverted by a value or an import order.
- **Nested transports shadow; the injection guard unions.** Two nested
  transport scopes resolve a name they both own to the inner one — two
  sandboxes are two machines, and only an order answers "which machine". Two
  nested `withInjectionGuard`s union instead, because a nested guard is a second
  reviewer of the same content and the strictest reading must win. The
  inconsistency is deliberate; do not "fix" it, and both rules are stated in one
  place — `amendRunFrame` in `run-frame.server.ts`.

### The gateway tools

`Tools()` is the MCP-gateway transport the package ships. It returns a
`ToolSet` grouped by namespace (`tools.web`, `tools.neo4j`, …; `tools.all` is
everything):

```typescript
import { Tools, simpleLoop, harness } from '@hames-ai/harness-patterns'
import type { ControllerFn, SimpleLoopData } from '@hames-ai/harness-patterns'
import type { HarnessData } from '@hames-ai/harness-patterns/harness.server'

interface WebData extends HarnessData, SimpleLoopData {
  [key: string]: unknown
}

// The controller callable is yours to bring (see the LLM seam — it re-homes
// into the harness-baml companion). A hand-rolled one is legal and is how
// you unit-test a loop without a model:
const scripted: ControllerFn = async (input) => ({
  action: { reasoning: 'done', tool_name: '', tool_args: '', is_final: true },
})

// `namespaces` is REQUIRED: the deployment's tool→namespace map, passed
// explicitly. A missing map is how `tools.web` disappears silently on the
// day a catalog moves.
const tools = await Tools({
  namespaces: (toolName) => (toolName.startsWith('web_') ? 'web' : undefined),
})

const agent = harness(simpleLoop<WebData>(scripted, tools.web ?? [], { patternId: 'web-loop' }))
```

`ToolsFrom(descriptions, options?)` groups a tool list you already hold — tests
and static inventories; the production path is `Tools()`.
`registerToolNamespaces(map)` sets the process-wide default the **injection
guard** consults; the explicit `namespaces` argument is what **grouping**
consults. Both exist so a missing catalog is loud, not silent — and the guard
is louder still: it **refuses** a declared namespace it cannot verify (#242
item 4). When you wrap a pattern, pass `catalog: tools.all`; the guard walks
that catalog at construction and throws if no tool name in it resolves to a
namespace you declared — the signature of a missing registration. An agent
with no untrusted namespaces says so explicitly: `namespaces: []`.

What a transport is then _allowed_ to do — a sandbox's capabilities, network
profile, workspace paths — is that transport's business and is unchanged by the
seam; the seam only decides _which_ transport a name reaches. And the injection
guard sits above all of it: every dispatch path returns through `callTool`,
including the controller's turn log, which the loops build from the raw result
rather than from the event stream.

---

## 4. The error surface

Errors are **events in the log**, not exceptions that escape. Every pattern
catches internally and commits an `error` event carrying the message; the chain
stops when one is irrecoverable.

- **Severity is a per-pattern config.** `errorSeverity: 'recoverable' |
'irrecoverable'` (default varies by pattern — the loops default recoverable
  so a bad model response can be retried within the turn budget). A chain
  stops at the first irrecoverable `error` event; recoverable ones degrade the
  affected step and the rest of the composition still runs.
- **LLM parse failures are recoverable and carry the raw output.** When the
  controller (or any injected LLM callable) fails to produce a parseable
  response, the failure surfaces as `LLMCallError` — a typed error whose
  `llmCall` field is the `LLMCallRecord` of the failed call, **including
  `rawOutput`: the only record of what the model actually said**. The pattern
  catches it, commits the error event with the record attached, and lets the
  loop retry. A consumer rendering errors to a user should surface
  `llmCall.rawOutput` — the model's own words are the debugging artifact.
- **Usage rides the same record.** Every injected LLM call may attach its
  `LLMCallRecord` (tokens, timing, cost basis); the error path re-attaches it
  so a failed call still counts.

```typescript
import { LLMCallError } from '@hames-ai/harness-patterns'

function explain(err: unknown): string {
  if (err instanceof LLMCallError) {
    // `rawOutput` is the model's verbatim output — show it, don't paraphrase it.
    return err.llmCall.rawOutput ? `model said: ${err.llmCall.rawOutput}` : err.message
  }
  return err instanceof Error ? err.message : String(err)
}
```

There is no broader typed error hierarchy yet: `LLMCallError` is the one typed
class, everything else is an `error` event with a severity. Map severities and
messages onto your own UI copy rather than matching exception text.

---

## 5. Consuming the package

`@hames-ai/harness-patterns` is a workspace package: the app (or any member of the
same pnpm workspace) declares `"@hames-ai/harness-patterns": "workspace:*"` and
pnpm resolves it to the live TypeScript source — editing a file in the package
is indistinguishable from editing app code; HMR picks it up with no build step
and no publish loop.

The exports map:

| Subpath      | Contents                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `.`          | the barrel: patterns, combinators, the context/context-event API, `Tools()`, transports, `LLMCallError` |
| `./patterns` | the pattern factories on their own (`router`, `simpleLoop`, `actorCritic`, …)                           |
| `./guard`    | the injection guard's deterministic sanitizer, import-free on its own                                   |
| `./*`        | any package file by path (deep imports, e.g. `@hames-ai/harness-patterns/tool-transport.server`)           |

The package publishes to npm (`pnpm publish`, which rewrites `workspace:`
specifiers at pack time); inside this workspace the app and the Docker image
consume it by path. The CI `pack smoke` (`scripts/pack-smoke.sh`) is the
proof that the tarball a consumer installs actually works: it `pnpm pack`s
the package, installs the tarball into a scratch project, and asserts that
`./guard` behaves and that every entry evaluates — the entries being DERIVED,
from the app's own imports and from this package's `exports` map (its `./*`
pattern expanded against the packed tarball's file list), never from a list
typed into the probe. An external developer installs it the ordinary way and brings
their own model adapter for the six config-injected functions — the core
ships no LLM defaults, by design; see the companion module's guide for the
LLM seam (§3 of the plan's guide skeleton re-homes there).
