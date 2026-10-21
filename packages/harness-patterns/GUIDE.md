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
  (`compactExecution`'s `thread` mode reads every execution of the `fromPatterns`
  you name within the turn window, and otherwise the last pattern to enter — name
  the wrapper when its children run in nested views; a name absent from the run
  gives no history and synthesis drops to `response` mode; `threadTurns` widens
  only that read, e.g. to keep the previous turn's records on a follow-up)
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

| Combinator                | What it does                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `chain` / `harness`       | run patterns in order; `harness` is the top-level entry that stops on irrecoverable error |
| `routes`                  | dispatch on `data.route` (set by `router` or `decisionRouter`); pass-through on `'user'`  |
| `parallel`                | run patterns concurrently, merge their event sets                                         |
| `withReferences`          | attach the relevant results of earlier turns at pattern ingress, expandable on demand     |
| `withPseudonymisedInputs` | rewrite the web route's earlier inputs and check outgoing web arguments                   |
| `withInjectionGuard`      | neutralize untrusted tool output before a controller reads it                             |
| `decisionLoop`            | loop over routes, a decisions model choosing the next one each time, until `answer`       |

Resume and continue are the same mechanism, in two shapes:
`resumeHarness(serialized, patterns, answers, opts)` after a run paused to ask a
person, `continueSession(serialized, patterns, newInput)` for the next turn of a
conversation — or the bound `agent.resume(...)` / `agent.continue(...)` on the
runner, which carry the agent's own patterns. An answer is keyed by the
`requestId` it answers and resumes only that pause; a new message instead
supersedes whatever was waiting, so an answer never outlives its run. See SPEC's
[Human in the loop](SPEC.md#human-in-the-loop), and "Asking a human" below for
the whole loop a host writes.

### Moving between groups of capabilities within one turn

`routes` fixes the branch before anything runs. `decisionLoop` lets one turn
move between groups of capabilities, choosing the next group after seeing what
the last one produced: a loop over a route table in which the systemone `decide`
seam answers one `choice` question — "Which step should run next?" — until it
picks `answer` (which runs nothing; a `compactExecution` after the loop writes the
reply) or `maxIterations` (default `DECISION_LOOP_MAX_ITERATIONS`, 6) is reached.

```typescript
import {
  decisionLoop,
  simpleLoop,
  planner,
  withInjectionGuard,
  DECISION_LOOP_OUTPUT_KEY,
  type DecideFn,
  type PlanCallResult,
} from '@hames-ai/harness-patterns'
import type { ControllerFn } from '@hames-ai/harness-patterns/types'

type Data = Record<string, unknown>
declare const decide: DecideFn
declare const controller: ControllerFn
declare const planFn: (user: string, intent: string, context?: string) => Promise<PlanCallResult>

const orchestrator = withInjectionGuard({
  tools: [DECISION_LOOP_OUTPUT_KEY],
  spotlight: 'always',
})(
  decisionLoop<Data>(
    {
      lookup: {
        pattern: simpleLoop(controller, ['search'], { patternId: 'info', returnStyle: 'answer' }),
        description: 'Look things up',
      },
      think: {
        pattern: planner(planFn, ['search'], { patternId: 'think' }),
        description: 'Decide the steps before acting',
      },
    },
    { decide, answer: 'Answer the user now', patternId: 'orchestrator' },
  ),
)
```

Three things to know. A route's result is built by code from its committed
events and is **untrusted**: it is capped, then passed through the enclosing
guard under the fixed key `decision_loop_output`, so declare that key in the
guard's `tools` (undeclared, the guard is a no-op for it) and a screen that
cannot run withholds the output instead of waving it through. A planner route
may explicitly set `screenOutput: false` to skip that model second opinion only
on its successful plan record (failed records remain screened):
imperative model-authored plans can otherwise be mistaken for instructions.
The option is refused on non-planner routes and defaults to screened, including
for planners. It preserves deterministic sanitization, provenance fencing and
findings on the plan; child tool results and retrieved text stay screened. A child sees only
what it is allowed to (`siblingResults`, default none) and starts with fresh
data, never `memories`. And a decision that is not a decision — an error, an
abstention, a state that would not build — never dispatches a route. A `planner`
route is offered at most once per run of the loop: not straight after itself, and
not once a plan exists; `allowReplan: true` on the route opts out. See SPEC's
[decisionLoop](SPEC.md#decisionlooproutes-config-507).

A host can also tell the decisions model which documents the conversation holds,
through `documents` on the loop's config: a per-run source that returns the
visible total and, only when the host decides that run may reveal them, a list
of names. Core renders it into the state (capped, each name sanitised
deterministically, an unreadable list shown as unknown, never as none) but never
reads a tier itself. See SPEC's [decisionLoop](SPEC.md#decisionlooproutes-config-507).

A planner caps the reasoning handed to downstream executors with
`maxReasoningChars` (default 2000), alongside the existing `maxPlanChars` for
plan text. Its `plan_created` event and LLM call record retain the full trace.
A `PlannerFn` may call its optional fourth `onRetry(failedCall)` argument before
a same-endpoint retry; the pattern records a warning even if that retry fails.
See SPEC's [planner](SPEC.md#plannerplanfn-tools-config) for the full contract.

### Protecting the web route's earlier inputs

Place `withPseudonymisedInputs({ pseudonymise: hostFilter })` directly around
`withReferences`. It rewrites both the reference view (previews and expansion)
and all inherited child data, preserving the latest user message. Rewritten
copies are limited to the child's visible events and post-checked per string;
residual bodies become `[withheld: private identity]` (per leaf inside a JSON
body) and provenance fences stay intact. A roster identity the screen already neutralized fails the filter closed for the rest of the conversation. Only an
explicit `'anthropic'` run passes through. Supply a host `PseudonymiseForWeb`
that builds a per-invocation rewrite, selective redaction, literal post-check, local-result observer
and outgoing-argument check; no host privacy
module or table is imported into core. `decisionLoop` gives the wrapper roster
input from every earlier iteration, even beyond the handoff window, without
widening its sibling visibility. That temporary input is removed before the
inner pattern runs.

Missing or failed host wiring withholds earlier results and refuses web calls,
recording a warning while allowing the child to continue on the user's message
and internal reads. The app host requires a readable, non-empty directory;
declare `{ directory: 'none' }` in code only for deployments without one. Its
table is never stored or reversed. See SPEC's
[G14 boundary](SPEC.md#withpseudonymisedinputsconfigpattern-507-g14) for the
failure policy and remaining literal-matching limits.

Outgoing checks use the `egressChecks` run-frame slot. It concatenates on nested
`amendRunFrame`, innermost first: every check runs and any denial stops dispatch
as a failed tool call, so an inner scope cannot switch off an outer check.
Only the declared local `neo4j` and `memory` namespaces are exempt (`context7` is outbound and checked). A scoped `afterToolCall`
hook extends outgoing literals from identities discovered by local reads;
an update failure withholds the result and refuses further outgoing calls.

The reference application registers `general-next` as a selectable candidate
beside `general` (#507 S3), built in `packages/agents/agents/general-next.server.ts`.
It combines four routes: an office sandbox with Microsoft 365, Neo4j/web
lookups (plus `context7` library docs and the memory graph's read tools), the conversation's Redis retriever, and planning. The web route uses
the host-supplied G14 pseudonymiser around `withReferences`; missing private
configuration withholds earlier content and refuses web calls. The outer
injection guard always fences route outputs and enables the screen. Only its
`think` planner sets `screenOutput: false`, keeping deterministic checks and
fencing while avoiding a model-screen call on its own plan. Memory
is optional and reaches synthesis alone. `graph_file_ingest` is in general-next's own office list only when the host enables it; the executor refuses unless the host predicate positively allows it (the app: raw private run frame, `INFERENCE_TIERS=private`, no OpenRouter embedder). Turn-results materialisation stays disabled. The rollout still requires live
acceptance evidence; registration does not change the default agent.

### Deciding with probabilities

`typedDecision` asks a typed systemone question and records the endpoint's
probabilities untouched. Use `choice` for unordered options, `score` for ordered
levels and `noul` for whether a statement holds. Include “none of these” as a
choice option when it is a valid answer.

```typescript
import { defineChoice, typedDecision } from '@hames-ai/harness-patterns'
import type { DecideFn } from '@hames-ai/harness-patterns'

declare const decide: DecideFn // createDecideAdapter() in a host
const route = defineChoice({
  key: 'route',
  question: 'Which route answers this message?',
  labels: [
    { id: 'chat', description: 'Answer directly.' },
    { id: 'search', description: 'Search for evidence.' },
  ],
})
typedDecision({ decide, spec: route })
```

`readDecision(data, spec)` reads a typed result by key. Choice exposes `label`,
score exposes `level`, `value` and `expected`, and noul exposes `holds` and
`pTrue`. Handle a failed result before acting on its verdict.

Outside a pattern, `evaluateDecision` evaluates without a scope, `decide`
records on a scope, and `decideFields` answers the fields of a
`defineDecisionSet`, recording one `decision_made` per field. Pass
`createDecideAllAdapter()` for a set in one request.

`decisionRouter` writes the selected route to `data.route`. Put `compactIntent`
in front and pass `preserveIntent: true` when routing needs that intent.
`conversationalRoute` is an ordinary route key; `shadow: true` records a decision
without changing the route. Request failures follow the pattern's error severity.

The Anthropic tier records `JevDecide` and uses `JEV_DECISIONS_URL` plus
`JEV_DECISIONS_API_KEY`. The private tier records `PrivateSystemOne` and uses
`SMALL_LLM_DECISIONS_URL` (the full URL ending in `/v1/systemone`) plus
`SMALL_LLM_API_KEY`. An unset private URL refuses the call; there is no public
fallback. The private client is time-priced at `SMALL_LLM_EUR_PER_HOUR`.
See SPEC's [Decisions](SPEC.md#decisions-typeddecision-418).

### Recalling what the user told us

```typescript
import { withMemory, memoryStoreConfig, settleMemory } from '@hames-ai/harness-patterns'
import type { ConfiguredPattern, MemoryConfig, UnifiedContext } from '@hames-ai/harness-patterns'

type AgentData = Record<string, unknown>
declare const deps: { memory: MemoryConfig }
declare const chain: ConfiguredPattern<AgentData>[] // the host's router, routes and compactExecution

declare const ctx: UnifiedContext<AgentData>
declare const conversationId: string

const patterns = withMemory<AgentData>({ ...deps.memory, routerMemory: 'replies-only' })(chain)
// after the reply, from the host's compactAndSave continuation:
await settleMemory(ctx, memoryStoreConfig(deps.memory), { conversationId })
```

`enabled` is required, and both halves read the same function. Settle re-reads it inside every candidate transaction after the owner lock; false rolls the candidate back and reports `skipped: 'disabled'`. **M7 precondition (#552):** the "turn off" and "forget all" RPCs must commit the switch-off (`user_prefs.memory_enabled = false`) in its own transaction BEFORE calling the erase (`deleteAllMemoriesForUser`). An uncommitted flip is invisible to a candidate on another connection; do not wrap the erase in the flip transaction. Any erase rejection (`55P03`, a memory-pool connect timeout or `40P01`) means "not erased": leave the switch off and report the retryable failure, never success. Later writers, including M3 compaction, must re-read the switch and their inputs inside the owner-lock transaction. Forget-all must use the memory pool, the same owner advisory transaction lock and lock timeout; propagate `55P03` as a retryable failure, never success.

Choose `routerMemory` on this wiring: `'routing-and-replies'` is the default and
preserves existing calls. The router sees recalled memory and may put it into
`intent`: a tool route's task can carry facts from earlier conversations into tool
arguments, for example a web-search query or a fetch, even with private model
inference. `'replies-only'`, shown above, withholds the recalled block from every
router, including nested routers, while `compactExecution` / `synthesize` still
receive it for reply writing. Direct conversational router replies have no memory
and still skip synthesis. It is a per-turn boundary, not a guarantee that remembered facts never reach a tool: a fact the reply states becomes conversation history, and on a later turn the router sees that history and may put the fact into `intent`, and so into tool arguments (#548). Unknown values throw at construction. The exported
`RouterMemory` union names both choices; no extra router configuration is needed.
Controllers and the planner get no direct memory block; with the default they can
receive its facts indirectly through intent (#419 D13 / decision 6, amended by
#535). This setting controls the current recalled block; it does not remove facts
from user text or previous replies in ordinary conversation history, or constrain
custom patterns that explicitly read the memory data bag. Option (b), direct
answers with memory but no copying into intent or route, is deferred (#544).

Gate the post-reply call on `harnessUsesMemory(patterns)`, the same probe that gates the memory wake, so an agent that did not opt in stores nothing. **Await `settleMemory`, then save the context**: the `memory_written` events it records ride that one save. It never throws and it fails closed: a failed or sensitive read, a confirmation your host cannot ask (no `confirm` seam), an organisational-graph target or a failed wake all store nothing and say why. Recall never throws either and never stops what follows it; its block is cleared on every turn. Your `MemoryWriteStore.transaction(fn)` must open one transaction, take the owner's advisory lock inside it, and **roll back and rethrow if `fn` throws**: that rollback is what makes a retry a no-op. See SPEC's [Memory recall](SPEC.md#memory-recall-memoryrecall-419) and [Memory store](SPEC.md#memory-store-settlememory-419).

**Asking the person before a memory is saved.** Give `MemoryConfig` a `confirm` seam (`{ hold(input) }`) and a turn the gate marks `ask` stops storing nothing: it prepares the memories (with their vectors and a read-only dedupe preview), records a non-blocking `memory.confirm` proposal in the context and hands the payload to `hold`, keyed by the proposal's request id. The proposal carries counts, never the text. When the person answers, your host calls `answerProposal(ctx, { [requestId]: { choice: 'save', flags } }, { principal })` (core binds the answer to that open proposal and refuses anything the request did not offer), then `applyMemoryProposal(ctx, { store, embedSpace, enabled }, { payload, selected })` (it writes only the flagged items, refuses an item whose target memory changed since the preview, and is a no-op on a retry), then saves the context **once**, conditional on the version you read. Write the memories before the save: a refused save is then a retry, never a double write or a lost choice. The organisational-graph target is never proposed or written by this path. See SPEC's [Proposals](SPEC.md#proposals-proposetohuman-and-answerproposal-433-s11) and [Confirmation](SPEC.md#confirmation-prepare-propose-apply-419-m6--433-s11).

### Optional memory maintenance

Add `compact: { compact: summarize, store: compactionStore, assertTier }` to
`MemoryConfig` to opt into M3. `memoryCompactionConfig(cfg)` returns the derived
maintenance config, or `undefined` without that opt-in. After settle reports
`compactionDue` (including a refused full-store insertion), await `compactMemory(ctx, derived)` before the same context save.
Core adds no app calls or timer. The host's owner-bound compaction store must
use the same advisory lock, memory pool and lock timeout as settle and erasure,
roll back on any throw, move all member provenance before deleting members,
and return exact move/deletion counts. Expiry commits in a short transaction;
each cluster's inference runs outside every transaction, then a short merge
transaction re-reads the switch and all members (including their source set).
Changed members are kept. Each merge commits independently and publishes its
events after commit; a final short transaction handles fresh-count eviction.
The switch is also re-read before every cluster, including after `keep`, and
after a merge verdict before summarization. A cluster kept because its members
changed still records the decision and redacted call, without a write event.
`assertTier` must refuse unknown or unavailable tiers before inference; no
fallback is allowed. For the later app wiring slice, wrap the reachability check:

```typescript
// Supplied by the app from @hames-ai/harness-baml/clients.server:
declare const assertInferenceTier: (tier: 'anthropic' | 'verda') => void

const assertTier = (tier: string) => {
  if (tier !== 'anthropic' && tier !== 'verda') throw new TypeError('unknown memory tier')
  assertInferenceTier(tier)
}
```

Passing `assertInferenceTier` bare does not reject unknown strings. Core tiers
are opaque; this positive allowlist is a binding host requirement, not app wiring
supplied by M3. The summarizer is tier-routed, company-run only on the private
tier. The default unmeasured `maxClusterSize: 8` keeps oversize clusters whole
and unmerged, without splitting or calling a model. The cluster timeout stops
waiting; it cannot abort in-flight calls or attach their late usage to context.

Retention lives at `cfg.retention`, per kind in days after last sighting: episodic
180 by default, the other kinds `null` (persist). For example,
`{ episodic: 90, preference: 365, trait: null }`. Compaction keeps the newest
last-seen date, so it cannot restart the retention clock. A refused, failed or unavailable decision keeps all members. Compaction follows
the store step under G11: it uses the endpoint verdict through `evaluateDecision`
on the `jev`-only seam, without calibration or threshold policy. `keep` is the
first option, so an exact merge/keep tie keeps both rows. Only episodes may be evicted at the hard
cap, even when episodic retention is `null`. Settle refuses an insertion with
`full` and `compactionDue: true` if its host cannot reclaim episodic space; it
continues later candidates, so
existing reinforces/updates do not consume capacity. The optional transaction
method `evictOldestEpisodes(n)` is the host capability for that reclamation.

For the daily retry/expiry pass, supply an async iterable of `MemorySweepJob`s
(context, config, persist) to `sweepMemories`, or start its opt-in daily timer
with `startMemorySweep(jobsSupplier)` and retain the returned stop function.
The timer runs once at startup (zero delay), then daily after each completion;
it unrefs itself and never overlaps sweeps. Hosts enumerate enabled
owners, supply fresh owner-bound seams, and persist each context after its pass.
See SPEC's [Memory compaction](SPEC.md#memory-compaction-419-m3) for transaction,
acceptance, event and fail-closed contracts.

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

**Two more slots concatenate** (#507 N4): `stashWriteObservers` (told when core's
`storeDocument` has durably stored a document) and `afterToolCall` (run by
`callTool` after a call is dispatched and guarded, may replace the result, which is then guarded again; hooks get a private copy). You
rarely supply them yourself; `withSandbox({ syncWorkspace: true })` does, to
copy a document a tool stores mid-run into `/work/in`.

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
