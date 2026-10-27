/**
 * The RUN FRAME — one ambient scope per run, holding every slot a run needs.
 *
 * ## What this replaces, and why it is one thing rather than five
 *
 * Until this module there were five independent `AsyncLocalStorage` stores —
 * the injection guard, the scoped tool transports, the runtime config, the live
 * event listener and the inference tier — declared in four modules across two
 * packages, opened by five different functions, at three different
 * granularities (one per pattern, one per run, two per turn from the host app).
 * Five openers means five chances to skip one, and skipping one is on the
 * record: #373 shipped a guard whose efficacy hung on a module side effect in a
 * third package, and it "was present, reported green, emitted one deduped
 * console warning, and neutralized nothing".
 *
 * Duplicating one is worse and was NOT on the record, because the monorepo hid
 * it: on a tarball install two resolved copies of this package are two stores,
 * so `withInjectionGuard` opens a scope on copy A while `callTool` reads copy B
 * and the boundary is silently off with no warning at all. Hence the two halves
 * of decision D4 (issue #374): the cross-package edges became
 * `peerDependencies` (#377), and the store below lives on a `globalThis` symbol
 * so two loaded copies still share ONE frame. The manifest half cannot prove
 * itself — a peer range is a promise about resolution — which is why
 * `run-frame.test.ts` simulates the second copy and asserts the frame survives.
 *
 * ## The interface a consumer sees
 *
 * Zero calls, if they use the harness entry points: `harness(...patterns)`,
 * `continueSession` and `resumeHarness` open the frame themselves (ruling Q17),
 * so a package consumer gets guard construction, transport precedence, budget
 * resolution, live emission and per-call routing without learning that any of
 * it is ambient. One call — `withRunFrame({}, fn)` — if they drive patterns
 * directly from a script or a background job, which is what ruling D3 ("no
 * frame, no run") makes explicit rather than silent.
 *
 * ## Fail closed
 *
 * {@link activeRunFrame} THROWS outside any frame, and `runChain` asks for it
 * before it dispatches the first pattern. That is the fail-closed rule applied
 * to the run itself: a host that forgets the frame gets an error on turn one
 * instead of a run with no guard, no budget and no tier. The readers whose
 * outside-a-frame behaviour is legitimate and unchanged — `callTool` called
 * from a health probe, `activeTransports()` asked by a prompt builder — use
 * {@link currentRunFrame} instead and keep their existing sentinel.
 *
 * ## Nesting, and the one place the per-slot asymmetry lives
 *
 * The slots do NOT merge the same way, and that is deliberate (see
 * {@link amendRunFrame}). Two combinators legitimately scope BELOW a run —
 * `withInjectionGuard(cfg)(pattern)` and `withSandbox(...)` — and both amend the
 * open frame rather than opening one of their own. A second *entry* into a run
 * (a `continueSession` called inside a host's frame) joins the frame that is
 * already open and refuses to bring slots of its own, so the outer run's guard
 * cannot be replaced by an inner call's.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertServerOnImport } from './assert.server'
import { DEFAULT_RUNTIME_CONFIG, type HarnessRuntimeConfig } from './runtime-config'
import type { ActiveInjectionGuard } from './injection-guard'
import type { ToolTransport } from './tool-transport.server'
import type {
  ByTier,
  ContextEvent,
  ContinuationSegment,
  HitlPayloadStore,
  ToolCallResult,
} from './types'

assertServerOnImport()

/** A live-event listener — invoked as events are recorded, not at commit. */
export type LiveEventListener = (event: ContextEvent) => void

/**
 * A per-call client override by role, keyed by an opaque role name.
 *
 * GENERIC BY CONSTRUCTION. Core neither knows the role names nor interprets the
 * bag that comes back: it is handed to whatever inference layer the host wired
 * up, which is the only thing that knows what a "client" is. The shape is the
 * one `@hames-ai/harness-baml`'s `defineInferenceClients` produces and
 * `@hames-ai/agents`'s `AgentDeps.clientOverride` already carries, so the
 * generalisation is proven rather than speculative (issue #374, D1).
 */
export type RunClientOverride = (role: string) => Record<string, unknown> | undefined

/**
 * The inference slot: which tier this run is on, and an optional per-run client
 * override.
 *
 * `tier` is an OPAQUE STRING and stays one. No provider vocabulary lives in
 * core — not the tier names, not the client names, not the role map. The owner's
 * ruling on D1 is that provider specifics stay in the companion package
 * (`@hames-ai/harness-baml`), which reads this slot, narrows the string to its own
 * union and decides what it means. Core's whole contribution is that the value
 * rides the run instead of a module global.
 */
export interface InferenceSlot {
  /** Opaque host tier name. Core never interprets or validates it. */
  readonly tier?: string
  /** Per-run override, consulted by the inference layer ahead of its own map. */
  readonly clientOverride?: RunClientOverride
}

/** Pre-dispatch check, above every transport. A reason denies the call with a
 *  recoverable tool failure; every enclosing check still runs. A check must
 *  return feedback without quoting private arguments. */
export type EgressCheck = (call: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}) => string | void | Promise<string | void>

/** One stash document write, as an observer sees it: which conversation's stash
 *  and which document. Never the content. */
export interface StashWrite {
  readonly sessionId: string
  readonly documentId: string
  /** The `callTool` invocation the write happened inside ({@link currentToolCallId}),
   *  or undefined for a write made outside any tool call. This is how a scope
   *  attributes a write to the call that made it rather than to "whatever
   *  call finishes next". */
  readonly callId?: string
}

/** Told, synchronously, that core's `storeDocument` persisted a document. A
 *  throw is swallowed by the caller: observing a write must never fail it. */
export type StashWriteObserver = (write: StashWrite) => void

/** Runs in `callTool` after a call has been dispatched and guarded, and may
 *  replace its result by returning one (#507 N4: `withSandbox` turns a call
 *  whose stored document could not be restored into a failure). Returning
 *  nothing leaves the result unchanged. A throw is the hook's own bug and
 *  propagates, so a hook that must degrade has to catch for itself. */
export type AfterToolCallHook = (
  call: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> },
  result: ToolCallResult,
) => Promise<ToolCallResult | void>

/** What a caller SUPPLIES when opening or amending a frame. Every slot is
 *  optional; an absent slot means "this run has none", not "use a default". */
export interface RunFrame {
  /** The active injection guard. Built by the caller — `createInjectionGuard`
   *  already ORs the enclosing guard's coverage into its own, and answers each
   *  tool's sanitizer options from the guard that declares it, see
   *  {@link amendRunFrame}. */
  guard?: ActiveInjectionGuard
  /** Transports scoped to this run, innermost first. */
  transports?: readonly ToolTransport[]
  /** Budgets and truncation limits every pattern reads at execution time. */
  config?: HarnessRuntimeConfig
  /** Where events go as they happen. */
  live?: LiveEventListener
  /** Which tier this run's model calls take. */
  inference?: InferenceSlot
  /** Whether a person is there to answer `askHuman` (#433). Supplied by the
   *  host's amend around its MAIN run only, never below it — a sidecar (a title
   *  agent, a detached compaction) has none, so it can never pause the user's
   *  turn. `harness()` and its two siblings default it to `{ attended: true }`
   *  when they OPEN the frame, and only then. */
  hitl?: { readonly attended: boolean }
  /** Observers of stash document writes made inside this scope. */
  stashWriteObservers?: readonly StashWriteObserver[]
  /** Hooks run after every tool call dispatched inside this scope. */
  afterToolCall?: readonly AfterToolCallHook[]
  /** Checks run before any tool dispatch in this scope. */
  egressChecks?: readonly EgressCheck[]
  /** Which route of a `decisionLoop` this scope runs, as the loop names it (its
   *  route key). Code-written by the loop around each child, never by content:
   *  the egress gate counts its refusals per route by this label, and records
   *  it on each refusal event so the count survives a pause. */
  route?: string
  /** The resumable patterns this code runs inside, outermost first (slice 6).
   *  Each one supplies the path with its own segment appended; `askHuman`
   *  records it on the request. */
  continuation?: readonly ContinuationSegment[]
  /** Set while a resume re-enters a paused invocation (slice 6): the rest of
   *  the recorded path below the pattern that set it, and the events that
   *  invocation recorded before its pause. `null` clears it for a child that is
   *  not on the path. */
  resume?: ResumeSlot | null
  /** Gated tool names declared above this code; unions with the enclosing. */
  gatedTools?: readonly string[]
  /** The logical identity of the tool call this code runs inside
   *  (decision-loop-agent slice 8), set by `simpleLoop` around each dispatch. */
  callKey?: string
  /** The host's store for blocking requests' payloads, bound to this run's
   *  owner and conversation (slice 8). Supplied by the host around its main
   *  run, beside `hitl`. */
  hitlPayloads?: HitlPayloadStore
}

/** What a resumed invocation is handed (slice 6). */
export interface ResumeSlot {
  /** The path below the pattern that set the slot; its first segment is the
   *  pattern that should take it. */
  readonly continuation: readonly ContinuationSegment[]
  /** The events the paused invocation recorded, in order, outcomes substituted. */
  readonly events: readonly ContextEvent[]
}

/** The live slot as the emitters see it: the listener plus the per-run
 *  bookkeeping that stops `runChain`'s commit-time emission double-delivering.
 *  Mutable on purpose — `setLivePatternEnabled` toggles it per pattern. */
export interface LiveEventSlot {
  readonly listener: LiveEventListener
  readonly emittedIds: Set<string>
  enabled: boolean
}

/** The frame as its readers see it — built once by {@link withRunFrame}. */
export interface ActiveRunFrame {
  readonly guard?: ActiveInjectionGuard
  /** Never undefined: an empty frozen array outside any scoped transport, so
   *  the per-tool-call read allocates nothing. */
  readonly transports: readonly ToolTransport[]
  /** Never undefined: the library defaults when the host supplied none. */
  readonly config: HarnessRuntimeConfig
  readonly live?: LiveEventSlot
  readonly inference?: InferenceSlot
  /** Frozen, and nothing but `attended` (#477 F1). The run's HITL bookkeeping
   *  is not here: it is in a store of its own that the owning `runChain`
   *  opens (`hitl.server.ts`), so nothing that can read the frame can write
   *  the record or suppress a pause. */
  readonly hitl?: { readonly attended: boolean }
  /** Never undefined: an empty frozen array outside any observing scope. */
  readonly stashWriteObservers: readonly StashWriteObserver[]
  /** Never undefined, innermost first. */
  readonly afterToolCall: readonly AfterToolCallHook[]
  /** Never undefined; innermost first, without dropping outer checks. */
  readonly egressChecks: readonly EgressCheck[]
  /** The innermost `decisionLoop` route this code runs inside, if any. */
  readonly route?: string
  /** Never undefined: an empty frozen array outside any resumable pattern. */
  readonly continuation: readonly ContinuationSegment[]
  readonly resume?: ResumeSlot
  /** Never undefined: an empty frozen array where nothing declares one. */
  readonly gatedTools: readonly string[]
  readonly callKey?: string
  readonly hitlPayloads?: HitlPayloadStore
}

const NO_HOOKS: readonly never[] = Object.freeze([])
const NO_TRANSPORTS: readonly ToolTransport[] = Object.freeze([])

/**
 * The store, on a `globalThis` symbol — the second half of ruling D4.
 *
 * `Symbol.for` is the repo's existing idiom for process-wide singletons that
 * must survive both HMR and a duplicated module instance
 * (`Symbol.for('hames-app.large-wake')`). The failure it prevents is not
 * hypothetical for a published package: `peerDependencies` ASK the installer for
 * one copy, and an installer that gives two produces a silently guardless run
 * rather than an error. Here two copies find the same store, so the frame one
 * copy opened is the frame the other reads.
 *
 * Do not replace this with a module-level `const store = new AsyncLocalStorage()`.
 * That is the mutation `run-frame.test.ts`'s two-copies pin exists to redden.
 */
const STORE_KEY: unique symbol = Symbol.for('hames.harness-patterns.run-frame') as never
type StoreHolder = { store: AsyncLocalStorage<ActiveRunFrame> }
const globalStore = globalThis as unknown as Record<symbol, StoreHolder | undefined>
const holder: StoreHolder = (globalStore[STORE_KEY] ??= {
  store: new AsyncLocalStorage<ActiveRunFrame>(),
})
const store = holder.store

/**
 * The ONE TIER RULE's seam (boundary guards, slice 9).
 *
 * "Which tier is this run on" has two readers that used to disagree: routing
 * (an absent or empty frame tier takes the host's default; a present but
 * unrecognised one is the self-deployed tier, refused when unreachable) and the
 * guards (the raw string). Core cannot settle it, because core interprets no
 * tier string — so the companion that does, `@hames-ai/harness-baml`'s tier
 * module, REGISTERS its answer here and every core reader asks
 * {@link effectiveTier} instead of the raw slot.
 *
 * On a `globalThis` symbol for the same reason as the frame: two loaded copies
 * of this package must see one registration.
 */
const EFFECTIVE_TIER_KEY: unique symbol = Symbol.for(
  'hames.harness-patterns.effective-tier',
) as never
type EffectiveTierHolder = { read?: () => string }
const tierGlobal = globalThis as unknown as Record<symbol, EffectiveTierHolder | undefined>
const effectiveTierHolder: EffectiveTierHolder = (tierGlobal[EFFECTIVE_TIER_KEY] ??= {})

/** Register the function that answers {@link effectiveTier}; `undefined`
 *  unregisters. Called by the tier module that interprets tier strings, at its
 *  load. The last registration wins. */
export function registerEffectiveTier(read: (() => string) | undefined): void {
  effectiveTierHolder.read = read
}

/**
 * The tier this run is on, as the registered tier module answers it, or
 * `undefined` when none is registered (core used without a tier interpreter —
 * nothing routes, so there is no tier to name and the caller keeps its own
 * default). Core never inspects the string. A registered reader that refuses
 * (a restricted deployment) throws, and the throw propagates: a guard that
 * cannot learn the tier must not guess it.
 */
export function effectiveTier(): string | undefined {
  return effectiveTierHolder.read?.()
}

/**
 * A {@link ByTier} setting's value on the tier this call is on. A map's key for
 * {@link effectiveTier}'s answer when it has one, else its `default`; a bare
 * value as it is. With a tier module registered, an absent tier is whatever that
 * module answers (its host's default, or its own fallback with no host policy),
 * never `default` by omission. Only with nothing registered, where nothing
 * routes, is there no tier and `default` applies. A reader that refuses throws,
 * and so does this: a setting that cannot learn its tier must not guess it.
 */
export function resolveByTier<T>(value: ByTier<T>): T {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'default')) {
    return value as T
  }
  const map = value as { readonly default: T; readonly [tier: string]: T }
  const tier = effectiveTier()
  return tier !== undefined && Object.hasOwn(map, tier) ? map[tier] : map.default
}

/** Which slots a caller actually supplied — an explicit `undefined` is not a
 *  slot, so `{ guard: maybeGuard }` with nothing to put there still joins. */
function suppliedSlots(frame: RunFrame): string[] {
  return (Object.keys(frame) as (keyof RunFrame)[]).filter((k) => frame[k] !== undefined)
}

/**
 * Per-invocation identity of a `callTool` call, on its own ALS (also on a
 * `globalThis` symbol, for the same two-copies reason as the frame). `callTool`
 * opens one around each call; `storeDocument` reads it to say which call a write
 * belongs to, and `afterToolCall` hooks receive it, so a scope can tie a write
 * to ITS call's hook instead of a scope-wide flag (#599 review F3).
 */
const CALL_KEY: unique symbol = Symbol.for('hames.harness-patterns.tool-call-id') as never
type CallHolder = { store: AsyncLocalStorage<string>; seq: number }
const callGlobal = globalThis as unknown as Record<symbol, CallHolder | undefined>
const callHolder: CallHolder = (callGlobal[CALL_KEY] ??= {
  store: new AsyncLocalStorage<string>(),
  seq: 0,
})

/** Run `fn` as one tool-call invocation with a fresh id. */
export function withToolCallId<T>(fn: (id: string) => Promise<T>): Promise<T> {
  const id = `call-${++callHolder.seq}`
  return callHolder.store.run(id, () => fn(id))
}

/** The id of the `callTool` invocation this code runs inside, if any. */
export function currentToolCallId(): string | undefined {
  return callHolder.store.getStore()
}

/** A fresh hitl slot: frozen, with `attended` as its only key. `attended` is a
 *  POSITIVE claim: only `true` makes a person the one who decides. */
function hitlSlot(supplied: { readonly attended: boolean }): { readonly attended: boolean } {
  return Object.freeze({ attended: supplied.attended === true })
}

function build(frame: RunFrame): ActiveRunFrame {
  return {
    guard: frame.guard,
    transports: frame.transports ?? NO_TRANSPORTS,
    config: frame.config ?? DEFAULT_RUNTIME_CONFIG,
    live: frame.live
      ? { listener: frame.live, emittedIds: new Set<string>(), enabled: false }
      : undefined,
    inference: frame.inference,
    hitl: frame.hitl ? hitlSlot(frame.hitl) : undefined,
    stashWriteObservers: frame.stashWriteObservers
      ? Object.freeze([...frame.stashWriteObservers])
      : NO_HOOKS,
    afterToolCall: frame.afterToolCall ? Object.freeze([...frame.afterToolCall]) : NO_HOOKS,
    egressChecks: frame.egressChecks ? Object.freeze([...frame.egressChecks]) : NO_HOOKS,
    route: frame.route,
    continuation: frame.continuation ? Object.freeze([...frame.continuation]) : NO_HOOKS,
    resume: frame.resume ?? undefined,
    gatedTools: frame.gatedTools ? Object.freeze([...frame.gatedTools]) : NO_HOOKS,
    callKey: frame.callKey,
    hitlPayloads: frame.hitlPayloads,
  }
}

/**
 * Open the run frame for `fn`, or join the one that is already open.
 *
 * The three harness entry points call this (ruling Q17 / D5 — the runner
 * `harness(...patterns)` returns opens it, so there is no new entry point and
 * no rename). A host driving patterns directly calls it itself; `{}` is a valid
 * frame and gives every slot its default.
 *
 * NESTED ENTRY JOINS AND BRINGS NOTHING. A second entry inside an open frame
 * runs `fn` in the SAME frame — no second `store.run`, so the outer run's guard
 * is still what `callTool` reads — and REFUSES if it supplies any slot, because
 * a slot supplied there would silently replace the enclosing run's. A
 * combinator that legitimately scopes below a run uses {@link amendRunFrame},
 * whose per-slot merge rules are the point of the distinction.
 */
export function withRunFrame<T>(frame: RunFrame, fn: () => Promise<T>): Promise<T> {
  const open = store.getStore()
  if (open) {
    const supplied = suppliedSlots(frame)
    if (supplied.length > 0) {
      return Promise.reject(
        new Error(
          `withRunFrame: a run frame is already open and this nested entry supplied ` +
            `${supplied.join(', ')}. A nested entry joins the open frame and brings no slots — ` +
            `supply them where the frame is opened, or use amendRunFrame() if you mean to ` +
            `scope below the run.`,
        ),
      )
    }
    return fn()
  }
  return store.run(build(frame), fn)
}

/**
 * Scope a PARTIAL frame below the open run — the seam the two sub-run
 * combinators use (`withInjectionGuard(cfg)(pattern)` and `withSandbox(...)`).
 *
 * THE PER-SLOT MERGE RULES ARE NOT UNIFORM, and this is the only place that
 * asymmetry lives. It used to live in two modules' docstrings, which is how a
 * reader learned each rule only by going to look for it:
 *
 *   - `transports` PREPEND. Innermost first, outer scopes still reachable. Two
 *     nested sandboxes both own `sandbox_bash`; a union has no answer to "which
 *     machine" and an order has a deterministic one. See
 *     `tool-transport.server.ts` for the containment invariant this carries.
 *   - `guard` REPLACES — and that is the coverage rule, not its opposite. The
 *     widening happens one level up, at construction: `createInjectionGuard`
 *     reads the enclosing guard and ORs its `isUntrusted` into its own, so the
 *     value arriving here ALREADY covers everything inner and outer declare
 *     (SD-5: an inner wrapper can only widen coverage, never remove it). The
 *     OPTIONS do not merge: each guard sanitizes the tools it declares with its
 *     own options and hands any other tool to the enclosing guard
 *     (`ActiveInjectionGuard.optionsFor`), so a nested guard can neither weaken
 *     nor inherit another guard's `disableRules`, `spotlight`, `rules` or
 *     `screen`. Merging again here would be a second, redundant merge on a value
 *     that already answers both questions. Do not "simplify" this by making the
 *     guard slot prepend like transports: the two rules are deliberately
 *     different, a nested guard being a second reviewer of the same content
 *     where a nested sandbox is a different machine.
 *   - `hitl` passes BY REFERENCE (#433, F7). The slot is the run's, not the
 *     subtree's: `withInjectionGuard` and `withSandbox` amend the frame around
 *     the very patterns whose tool executors call `askHuman`, so a slot
 *     dropped here would leave every guarded or sandboxed gate unable to ask.
 *     A partial may SUPPLY one only where the frame has none — the host's
 *     amend around its main run — and is refused below an open one. The slot
 *     is a frozen `{ attended }` and nothing else: the run's bookkeeping is in
 *     a store of its own (`hitl.server.ts`, #477 F1), opened per run.
 *   - `stashWriteObservers` and `afterToolCall` CONCATENATE, innermost first,
 *     like transports (#507 N4). Every observer hears a write and every hook
 *     sees a call: an inner scope adds to what the enclosing ones do and can
 *     never switch an outer one off.
 *   - `egressChecks` CONCATENATE, innermost first, like transports. Every
 *     check runs; any denial denies, so an inner scope cannot remove one.
 *   - `route` REPLACES, like everything else: a nested `decisionLoop`'s child
 *     runs under its own route's label, and leaving it restores the outer one.
 *   - `continuation` REPLACES: a resumable pattern supplies the whole path, the
 *     enclosing one plus its own segment (`resume.server.ts`).
 *   - `resume` REPLACES, and `null` clears it: a pattern on a resumed path
 *     hands its child the rest of the path, and any other child none.
 *   - `gatedTools` UNION: a name declared gated above stays gated below.
 *   - `callKey` and `hitlPayloads` REPLACE.
 *   - everything else REPLACES for the duration.
 *
 * Refuses outside a frame, by way of {@link activeRunFrame}: something that
 * scopes below a run needs a run.
 */
export function amendRunFrame<T>(partial: RunFrame, fn: () => Promise<T>): Promise<T> {
  let open: ActiveRunFrame
  try {
    open = activeRunFrame()
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  if (partial.hitl && open.hitl) {
    return Promise.reject(
      new Error(
        'amendRunFrame: this run already carries a hitl slot. Only the host supplies it, once, ' +
          'around its main run; below that the slot passes by reference (#433).',
      ),
    )
  }
  const amended: ActiveRunFrame = {
    guard: partial.guard ?? open.guard,
    transports: partial.transports
      ? Object.freeze([...partial.transports, ...open.transports])
      : open.transports,
    config: partial.config ?? open.config,
    live: partial.live
      ? { listener: partial.live, emittedIds: new Set<string>(), enabled: false }
      : open.live,
    inference: partial.inference ?? open.inference,
    hitl: partial.hitl ? hitlSlot(partial.hitl) : open.hitl,
    stashWriteObservers: partial.stashWriteObservers
      ? Object.freeze([...partial.stashWriteObservers, ...open.stashWriteObservers])
      : open.stashWriteObservers,
    afterToolCall: partial.afterToolCall
      ? Object.freeze([...partial.afterToolCall, ...open.afterToolCall])
      : open.afterToolCall,
    egressChecks: partial.egressChecks
      ? Object.freeze([...partial.egressChecks, ...open.egressChecks])
      : open.egressChecks,
    route: partial.route ?? open.route,
    continuation: partial.continuation
      ? Object.freeze([...partial.continuation])
      : open.continuation,
    resume: partial.resume === null ? undefined : (partial.resume ?? open.resume),
    gatedTools: partial.gatedTools
      ? Object.freeze([...new Set([...open.gatedTools, ...partial.gatedTools])])
      : open.gatedTools,
    callKey: partial.callKey ?? open.callKey,
    hitlPayloads: partial.hitlPayloads ?? open.hitlPayloads,
  }
  return store.run(amended, fn)
}

/**
 * The open run frame. THROWS outside one.
 *
 * This is the refusal ruling D3 asks for, and the mutation `run-frame.test.ts`
 * removes to prove the pin discriminates: without it a chain runs with no
 * guard, the library's budgets instead of the host's, and whatever tier the
 * inference layer defaults to — all three silently, which is exactly the
 * failure class #373 documented.
 */
export function activeRunFrame(): ActiveRunFrame {
  const frame = store.getStore()
  if (!frame) {
    throw new Error(
      'No run frame is open. A harness run must be opened with withRunFrame() — the harness ' +
        'entry points (harness(...patterns), continueSession, resumeHarness) do this for you; ' +
        'a script or background job that drives patterns directly must call withRunFrame({}, fn) ' +
        'itself. Running without one would mean no guard, no host budgets and no tier, silently.',
    )
  }
  return frame
}

/**
 * The open run frame, or `undefined` outside one.
 *
 * For the readers whose outside-a-frame behaviour is legitimate and must not
 * change: `callTool` reached from a health probe or a tool-catalog refresh,
 * `activeTransports()` asked by a prompt builder, `emitLive` from anywhere. They
 * keep the sentinel they always had; the refusal belongs at the run boundary,
 * which is where a run actually starts.
 */
export function currentRunFrame(): ActiveRunFrame | undefined {
  return store.getStore()
}
