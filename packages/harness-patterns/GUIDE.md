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
| `routes`             | dispatch on `data.route` (set by `router` or `decisionRouter`); pass-through on `'user'`  |
| `parallel`           | run patterns concurrently, merge their event sets                                         |
| `withReferences`     | attach the relevant results of earlier turns at pattern ingress, expandable on demand     |
| `withInjectionGuard` | neutralize untrusted tool output before a controller reads it                             |

Resume and continue are the same mechanism, in two shapes:
`resumeHarness(serialized, patterns, answers, opts)` after a run paused to ask a
person, `continueSession(serialized, patterns, newInput)` for the next turn of a
conversation — or the bound `agent.resume(...)` / `agent.continue(...)` on the
runner, which carry the agent's own patterns. An answer is keyed by the
`requestId` it answers and resumes only that pause; a new message instead
supersedes whatever was waiting, so an answer never outlives its run. See SPEC's
[Human in the loop](SPEC.md#human-in-the-loop), and "Asking a human" below for
the whole loop a host writes.

### Deciding with probabilities

`typedDecision` asks ONE closed question and returns a probability for every
permitted label, with `margin`, `confidence` and an explicit abstain. It writes
no text. Hand it the raw decision seam (`bamlPatterns().decide`) and a policy;
`fallback` is required, because the verdict is what a consumer acts on and a
failed decision must still have one:

```typescript
import { typedDecision } from '@hames-ai/harness-patterns'
import type { DecideFn } from '@hames-ai/harness-patterns'

declare const baml: { decide: DecideFn } // bamlPatterns() in a real host

typedDecision({
  decide: baml.decide,
  spec: {
    key: 'memory.recall',
    question: 'Does answering the latest message need anything remembered about this user?',
    labels: [
      { id: 'skip', description: 'no — this conversation is enough' },
      { id: 'recall', description: 'yes — it depends on something from before' },
    ],
  },
  policy: { fallback: 'skip', minConfidence: 0.6 },
})
// → scope.data.decisions['memory.recall'].label — act on THIS, never on `top`
```

It never throws and always overwrites its key, failures included. Outside a
pattern, `decide(scope, call)` is the same decision recorded on a scope you
hold, `evaluateDecision(call)` is it with no scope at all, and
`decideFields(scope, { decide, set, state, policy })` answers several typed
fields over one state, one `decision_made` per field.

`decisionRouter` is `router()`'s sibling built on it: the routes are the
labels, the verdict becomes `data.route`, and `policy.fallback` names the route
taken when the decision abstains. Put `compactIntent` in front (it writes the
intent the router no longer does) and pass `preserveIntent: true`, or the
router clears that intent; give conversational turns an ordinary route
key (`conversationalRoute`) that `routes()` dispatches to a pass-through, and
run it with `shadow: true` beside your existing `router()` to measure agreement
before swapping. See SPEC's [Decisions](SPEC.md#decisions-typeddecision-418).

### Recalling what the user told us

`memoryRecall` is the recall half of persistent memory: a chain step that runs
first and, when the latest message plausibly depends on something the user said
before, sets `data.memories` and a formatted `data.memoryContext` for the
responder. Core hosts no database or embedder — you inject a `MemoryStore`
bound to the turn's owner, the raw decision seam, a query embedder and the rule
for which tiers a turn may read:

```typescript
import { memoryRecall, harnessUsesMemory } from '@hames-ai/harness-patterns'
import type { DecideFn, MemoryQueryEmbedder, MemoryStore } from '@hames-ai/harness-patterns'

declare const store: MemoryStore // the host's database, already bound to the owner
declare const decide: DecideFn // bamlPatterns().decide
declare const embed: MemoryQueryEmbedder
declare const currentUser: () => string | null

const recall = memoryRecall({
  store,
  decide,
  embed,
  owner: currentUser,
  // fail closed: an unknown tier reads the narrowest set
  visibleTiers: (tier) => (tier === 'private' ? ['private', 'public'] : ['public']),
})

harnessUsesMemory([recall]) // true — gate the memory wake and the post-reply store on this
```

It never throws and never stops what follows it: a down store, a gate that
abstains or a wake that has not landed all end in "attach nothing", recorded as
a `memory_recalled` event of ids and a reason — never the memories themselves.
A turn's memories are cleared on every exit, so a skipped turn never inherits
the last one's. The user sees nothing either way. See SPEC's
[Memory recall](SPEC.md#memory-recall-memoryrecall-419).

### Writing what the user told us

`settleMemory` is the store half: call it from your post-turn continuation,
**await it, then save the context**, so the `memory_written` events it records
are in the one save. It decides from the question/answer pair whether anything
is worth keeping, extracts at most three candidates from the user's own words,
runs them through deterministic acceptance (verbatim evidence, identifier
closure, the injection sanitizer), and writes each in a transaction of your
`MemoryWriteStore`. It never throws; it fails closed — an abstained, uncalibrated
or sensitive read, a read that needs a confirmation your host cannot yet ask, an
organisational-graph target, a failed wake: all store nothing and say why.

```typescript
import { settleMemory, harnessUsesMemory } from '@hames-ai/harness-patterns'
import type { MemoryStoreConfig } from '@hames-ai/harness-patterns'

declare const memory: MemoryStoreConfig // store, decide, extract, embed, owner, …
declare const patterns: Parameters<typeof harnessUsesMemory>[0]
declare const ctx: Parameters<typeof settleMemory>[0]
declare function saveSession(ctx: unknown): Promise<void> // your host's save

// in the continuation that runs after the answer was sent:
if (harnessUsesMemory(patterns)) {
  const report = await settleMemory(ctx, memory) // never throws
  // report.written, report.skipped, report.compactionDue …
}
await saveSession(ctx) // the events are already in ctx.events
```

Your `MemoryWriteStore.transaction(fn)` must open one transaction, take the
owner's advisory lock inside it, and **roll back and rethrow if `fn` throws** —
that rollback is what makes a retry a no-op. See SPEC's
[Memory store](SPEC.md#memory-store-settlememory-419).

### Asking a human

A run can stop to ask the person watching it, and an answer continues it. The
common case is one call — the `confirm` preset at a chain boundary; the custom
case is `humanGate({ request, onAnswer })`, and inside a tool executor it is
`askHuman(request)` plus `held(outcome)` (SPEC's
[Human in the loop](SPEC.md#human-in-the-loop) section holds the full contract:
what a request may say, the unattended rule, and every way an answer can fail
to bind, enumerated by `HitlAnswerError.code`).

The whole loop a host writes is two requests. A paused result is a union on
status: when the status is `'paused'`, `pending` is non-optional and lists
every decision the run waits on — no `!`, no separate reader:

```typescript
import { harness, confirm } from '@hames-ai/harness-patterns'
import type { ConfiguredPattern, HarnessData, HitlAnswers } from '@hames-ai/harness-patterns'

interface PlanData extends HarnessData {
  [key: string]: unknown
  plan?: { summary: string }
}

declare const planner: ConfiguredPattern<PlanData>
declare const executeLoop: ConfiguredPattern<PlanData>
declare const db: {
  save(id: string, userId: string, blob: string): Promise<void>
  load(id: string, userId: string): Promise<{ blob: string; version: number }>
  saveIf(id: string, userId: string, blob: string, version: number): Promise<boolean>
}
declare function choicesFromForm(): HitlAnswers
declare function conflict(): Error

// The gate is one pattern between the others: Reject is the default and the
// unattended choice and stops the run; Approve needs a person, always.
const agent = harness(
  planner,
  confirm<PlanData>({ question: (d) => `Run this plan? ${d.plan?.summary ?? ''}`, key: 'plan' }),
  executeLoop,
)

// POST /chat
async function chat(id: string, userId: string, message: string) {
  const r = await agent(message)
  await db.save(id, userId, r.serialized) // server-held, owner-scoped (P1a)
  if (r.status === 'paused') return { ask: r.pending } // every pending request
  return { answer: r.response }
}

// POST /answer: same-origin, owner checked (P1c); the client sends choice ids only
async function answer(id: string, userId: string) {
  const { blob, version } = await db.load(id, userId)
  const next = await agent.resume(blob, choicesFromForm()) // { [requestId]: choiceId }
  if (!(await db.saveIf(id, userId, next.serialized, version))) throw conflict() // one answer wins (P1d)
  return { answer: next.response }
}
```

Inside a tool executor — a gated executor withholds the content while the
decision waits, and the placeholder is what the loop sees:

```typescript
import { askHuman, held } from '@hames-ai/harness-patterns'
import type { HeldResult, HitlOption } from '@hames-ai/harness-patterns'

const PROVENANCE_OPTIONS: readonly HitlOption<'sanitize' | 'remove' | 'stop' | 'continue'>[] = [
  { id: 'sanitize', label: 'Sanitize', unattended: true },
  { id: 'remove', label: 'Remove', unattended: true },
  { id: 'stop', label: 'Stop the run', unattended: true, stopsRun: true },
  { id: 'continue', label: 'Continue normally' },
]

declare const domain: string
declare const filename: string
declare const size: number

declare function payloadRef(): string | undefined

async function ingest(): Promise<{ stored: true } | HeldResult> {
  const outcome = await askHuman({
    kind: 'provenance',
    question: 'Use this external file?',
    options: PROVENANCE_OPTIONS,
    defaultOption: 'sanitize',
    summary: { domain, filename, size },
    ...(payloadRef() !== undefined ? { payloadRef: payloadRef() } : {}),
  })
  // Withhold: the run pauses at the boundary, and the placeholder is what a
  // loop sees. On 'answered', keep going — the decision is in the outcome.
  if (outcome.status === 'pending') return held(outcome)
  return { stored: true }
}
```

See the runner's `agent.resume` / `agent.continue` for the bound forms of the
two calls above, and `answerOf(view, kind, key)` to read a decision in a later
turn (give the request an explicit `key` when you will look it up).

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
  `rawOutput`: the only record of what the model actually said**. An
  implementation that knows the model ANSWERED and the answer would not parse
  constructs it with `{ recoverable: true }` (the BAML adapters do, for
  `BamlValidationError`). The tool loops then feed the failure back to the
  model — with a bounded head of `rawOutput` itself, labelled as the model's
  own previous response, unless the answer was cut off at the output cap or
  empty — and continue on their budget, recording a `loop_recovery` event with
  the record attached; an unflagged `LLMCallError` — or any other throw — still
  ends the loop with an `error` event, because "the model never answered" is
  not something another round fixes. A consumer rendering errors to a user
  should surface `llmCall.rawOutput` — the model's own words are the debugging
  artifact.
- **A failure a loop routed around is not an error.** `simpleLoop` and
  `actorCritic` survive a failed tool call, a refused tool name and unparseable
  `tool_args` the same way, and record each as a `loop_recovery`, never as an
  `error`: every `error` reader (the turn's outcome, the chain's stop rule,
  `view.hasErrors()`) reads it as a statement about the turn. An unusable
  ANSWER (unparseable, unparseable `tool_args`, a refused tool, a multi-call
  turn that dispatched nothing) is fed back at most `maxConsecutiveRecoveries`
  times in a row with no tool dispatched between them (default 1): the next one
  ends the loop as an `error` marked `kind: 'recovery_exhausted'`, so by
  default a loop stops on its second unusable answer in a row. A tool that ran
  and failed never counts toward it. See SPEC, "One failure does not end the
  loop".
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
| `./*`        | any package file by path (deep imports, e.g. `@hames-ai/harness-patterns/tool-transport.server`)        |

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
