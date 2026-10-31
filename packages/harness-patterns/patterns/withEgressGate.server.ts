/**
 * The egress gate (boundary guards, slice 4): one check before every outgoing
 * call, on every tier, around whatever pattern it wraps.
 *
 * It installs ONE `egressChecks` entry and ONE `afterToolCall` hook on the run
 * frame, so every `callTool` inside the wrapped pattern is covered, a route that
 * gains an outgoing tool later included, with no declaration. A call is egress
 * unless it is declared local: a namespace in `local` (its arguments reach only
 * systems that already hold the deployment's data) or an exact name in
 * `localTools`. Local-ness is declared, never inferred.
 *
 * ## The order of one outgoing call's check
 *
 *  0. Closed: the turn was closed (`'turn'`), this route was closed by its
 *     tripwire, or the roster is damaged (ruling K) — refused with a fixed text,
 *     no Decide call.
 *  1. Integrity (deterministic, never a tripwire): undecodable encoding, a
 *     format character, a placeholder, a block over the size bound, a fetch
 *     address nobody gave the controller (O21: the user's latest message and
 *     the DATA of `addressSources` results only, matched address for address,
 *     because a result the run computed from its own arguments, a Cypher
 *     `RETURN` or a script's output, would launder any address).
 *  2. The roster's matches become EVIDENCE (`filter`) or a veto (`roster`).
 *  3. `'filter'`: the egress question (`guard.egress`). At or above τe the call
 *     is refused with its category's text: the TRIPWIRE. Below, it goes out,
 *     and a roster match is audited (`egress_audit`).
 *  4. Decide unavailable (`'roster'` mode, a failure after one retry, a
 *     timeout, a state it cannot be asked over): the directory matrix (D5).
 *
 * ## Asking the person (slice 10)
 *
 * With `askPerson`, a Decide refusal and the D5 cells the design gives a person
 * (Decide down on an `empty` or `none` directory, and on a `loaded` one where
 * `loadedDecideDown` says so) raise an `egress-release` request instead of
 * refusing, when the call can pause here (`canPauseHere()`: an attended run, on
 * a whole resumable path) and is not one of a batch (O16). The call is HELD:
 * nothing is sent, its arguments go in the request's payload row, and the loop
 * pauses on the placeholder. On re-entry the loop dispatches the same call
 * again under the same call key (O15), and this check answers from the
 * recorded decision without asking Decide again: Accept sends exactly that
 * call, once, audited `allowedBy: 'person'`; Refuse is the tripwire it would
 * have been; Refuse all similar actions closes every route's outgoing calls
 * for the turn; Interrupt is a `stopsRun` option, so the resume stops before
 * anything is re-entered. Unattended, on a path that cannot pause, or inside a
 * batch, the person cell takes its "nobody to ask" default, Refuse.
 *
 * ## The tripwire (ruling M)
 *
 * A refusal on Decide's answer or in a D5 cell is a tripwire. Each route's
 * refusals are counted per turn, and refusal `N + 1` closes the route for the
 * rest of the turn (`maxOutgoingRetriesPostTripwire`, N, default 0: the first
 * closes it). Every later outgoing call of a closed route is refused with no
 * Decide call. A route is the run frame's `route` slot, which `decisionLoop`
 * writes around each child from its own route key; a call outside any route
 * shares one bucket. The count, the closed routes and the turn-wide closure are
 * DERIVED from the turn's recorded `egress_refused` events, never held in this
 * invocation alone: a resume re-runs the wrapper, and a count held in its
 * closure would reset at every pause. A route's checks run one at a time, in the
 * order the calls arrive (batch order), so a tripwire is seen by the next call
 * of the same batch; the calls that pass still run concurrently.
 *
 * ## Failure policy, stated
 *
 * A Decide FAILURE is retried once inside the same budget; a TIMEOUT is not
 * (the budget is spent). Both leave the call to the directory matrix and are
 * counted on the turn's `warning`. A roster source that throws (a damaged
 * identity field, or any host failure) DAMAGES the gate: every outgoing call
 * is refused for the rest of the invocation, and the result that carried the
 * damage is delivered, because the gate guards what leaves. A check that
 * throws is refused by `callTool` with its fixed text.
 *
 * Every text the controller reads is one of `EGRESS_TEXTS`, none interpolated:
 * the feedback never quotes the request.
 */
import { assertServerOnImport } from '../assert.server'
import { createHash } from 'node:crypto'
import { createEvent, redactCall } from '../context.server'
import {
  addressesIn,
  carriesUrlQuery,
  destinationHosts,
  EGRESS_SMALL_BLOCK_CHARS,
  EGRESS_SPAN_CAP,
  EGRESS_TEXTS,
  EGRESS_USER_CAP,
  EGRESS_WARNING_TASK,
  EGRESS_WARNINGS,
  egressToolLabel,
  GUARD_EGRESS,
  GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE,
  GUARD_EGRESS_THRESHOLD,
  GUARD_EGRESS_TIMEOUT_MS,
  readOutgoing,
  renderEgressState,
  type OutgoingRequest,
} from '../egress-gate.server'
import { isDegradedToolSurface } from '../gateway-health.server'
import { emitLive } from '../live-event-context.server'
import {
  askHumanHolding,
  canPauseHere,
  canonicalJson,
  held as held_,
  recordedHolding,
} from '../hitl.server'
import {
  amendRunFrame,
  currentRunFrame,
  resolveByTier,
  type EgressVerdict,
} from '../run-frame.server'
import { resumableStep, wrapperResumable } from '../resume.server'
import { inferServer } from '../tools.server'
import type {
  ByTier,
  ConfiguredPattern,
  ContextEvent,
  DecideFn,
  EgressAuditEventData,
  EgressProbabilities,
  EgressRefusedEventData,
  EventType,
  HitlOption,
  PatternScope,
  ToolCallResult,
  ToolResultEventData,
  UnifiedContext,
  UserMessageEventData,
  WarningEventData,
  WarningTask,
} from '../types'
import { evaluateDecision } from './typedDecision.server'

assertServerOnImport()

/** How the host found the company directory (G14 D4, declared in code). */
export type EgressDirectoryStatus = 'loaded' | 'empty' | 'unreadable' | 'none'

/** The host's roster for one invocation: the directory plus the labelled
 *  identities of the results it was handed. */
export interface EgressRoster {
  /**
   * The spans of `texts` that name an identity the roster holds, AS THEY OCCUR
   * in the text, in order. Never a directory record: only text the request
   * already carries. A form the user's latest message names is exempt.
   */
  match(texts: readonly string[]): string[]
  /** Extend the roster from a local result. Throws when a labelled identity
   *  field was neutralised (the roster would no longer know that person). */
  observe(data: unknown): void
}

/** The host's roster source (`createEgressRoster` in the app). Rejects when an
 *  identity field of `payloads` was neutralised: the gate is then damaged. */
export type EgressRosterSource = (
  payloads: readonly unknown[],
  latestUserMessage: string,
) => Promise<{ readonly directory: EgressDirectoryStatus; readonly roster: EgressRoster }>

/** `'filter'`: Decide decides and a roster match is evidence (ruling A).
 *  `'roster'`: a roster match vetoes on its own and no model is asked. */
export type EgressMode = 'filter' | 'roster'

export interface EgressGateConfig {
  /** Namespaces whose arguments reach only systems that already hold the
   *  deployment's data (its own services, its own tenant), never a third party
   *  that does not. Network locality is not the test. Every other call is
   *  egress. Verified against `catalog`. */
  readonly local: readonly string[]
  /** Exact local tool names (the sandbox's in-VM tools on a box with no
   *  network). A name that is in `catalog` refuses construction: a gateway tool
   *  is local only through its namespace. */
  readonly localTools?: readonly string[]
  /** The tool names the wrapped pattern was built from (`tools.all`). */
  readonly catalog: readonly string[]
  /** Tools whose addresses must have been given (O21): every string argument
   *  that carries an http(s) address or sits under a `url` key must, whole, be
   *  an address found in the user's latest message or in the data of an
   *  `addressSources` result, and so must every address inside it. Each must
   *  be in `catalog`. */
  readonly fetchTools?: readonly string[]
  /** Namespaces whose results' DATA gives the controller addresses (O21).
   *  Required with `fetchTools`: only tools that return content they did not
   *  compute from their arguments belong here (a web page, a library doc, a
   *  mail), never a query engine or a code box, whose output the controller
   *  can make say any address. A result's error text never counts. Verified
   *  against `catalog` like `local`. */
  readonly addressSources?: readonly string[]
  /** The host's roster. Without one the directory is `'none'` and nothing matches. */
  readonly roster?: EgressRosterSource
  /** The egress question's seam (`createDecideAdapter()`). Serves `choice`. */
  readonly decide?: DecideFn
  /** Per tier. Default `'filter'` with a `decide`, else `'roster'`. */
  readonly mode?: ByTier<EgressMode>
  /** τe. Default {@link GUARD_EGRESS_THRESHOLD}. */
  readonly threshold?: number
  /** The egress question's whole budget, retry included. Default
   *  {@link GUARD_EGRESS_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** N (ruling M): refusals a route admits after its first before it closes.
   *  Default {@link GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE} (0): the first
   *  refusal closes the route for the turn. */
  readonly maxOutgoingRetriesPostTripwire?: number
  /** Ruling U: with Decide down on a loaded directory, `'by-shape'` (default)
   *  refuses a call with a URL query or a decoded block over
   *  {@link EGRESS_SMALL_BLOCK_CHARS} and leaves any other to the roster;
   *  `'ask'` refuses every such call. (Each refusal is a person cell: with
   *  `askPerson`, asked where the call can pause.) */
  readonly loadedDecideDown?: 'by-shape' | 'ask'
  /** Ask the person (an `egress-release` request) in the cells that name one,
   *  where the call can pause; elsewhere those cells refuse. Default false.
   *  While on, every outgoing name of `catalog` is a gated name, so a
   *  composition that offers one on a path that cannot resume refuses
   *  construction (slice 10). */
  readonly askPerson?: boolean
}

/** The request kind of the egress prompt. */
export const EGRESS_RELEASE_KIND = 'egress-release'
export const EGRESS_BATCH_RELEASE_KIND = 'egress-batch-release'

/** The egress prompt's four buttons, in the owner's order (ruling M). Only
 *  Refuse may be picked unattended (ruling T), and it is the default (ruling X);
 *  Interrupt ends the turn. */
export const EGRESS_RELEASE_OPTIONS = [
  { id: 'refuse', label: 'Refuse', unattended: true },
  { id: 'accept', label: 'Accept', tone: 'danger' },
  { id: 'refuse-all', label: 'Refuse all similar actions' },
  { id: 'interrupt', label: 'Interrupt', stopsRun: true },
] as const satisfies readonly HitlOption[]

/** What the controller reads while the call waits for the person. */
export const EGRESS_HELD_NOTE =
  "This request is waiting for the user's decision before it is sent. Do not retry it; stop."

/** A prepared batch member whose identity changed is never rechecked as a fresh call. */
export const EGRESS_BATCH_MISMATCH =
  'Refused: the saved batch decision no longer matches this request. Nothing was sent.'

/** The state's nonce source under the test runner; never a config field, so a
 *  library caller cannot ship a fence whose code it chose. */
let testNonceSource: (() => string) | undefined

/** Fix the egress state's nonce for a test (`undefined` restores the random
 *  draw). Refused, and never read, outside the test runner. */
export function setEgressNonceSourceForTests(draw: (() => string) | undefined): void {
  if (!process.env.VITEST) {
    throw new Error('[withEgressGate] the nonce source can be fixed only under the test runner.')
  }
  testNonceSource = draw
}

const MODES: ReadonlySet<string> = new Set(['filter', 'roster'])
const DIRECTORY_STATUSES: ReadonlySet<string> = new Set(['loaded', 'empty', 'unreadable', 'none'])

/** The bucket of a call outside any `decisionLoop` route. */
const NO_ROUTE = null

/** User-facing hints for the gate's warnings. Never model-visible: a warning
 *  is serialized as `task: message` only. */
const WARNING_FALLBACKS = {
  damagedRoster: 'Further outside requests were refused.',
  directoryMissing: 'Outside requests were still checked.',
  directoryUnreadable: 'Outside requests were still checked, and refused when they could not be.',
  checkDegraded:
    'Requests that could not be checked were refused, or sent after a name check only.',
} as const

/** What the turn's recorded refusals say: each route's count, the closed
 *  routes, and whether the whole turn's egress is closed. */
export interface EgressClosures {
  readonly counts: Map<string | null, number>
  readonly closedRoutes: Set<string | null>
  turnClosed: boolean
}

/**
 * Derive the closures from a turn's events (everything after its last
 * `user_message`). The ONE reader, so a resumed invocation continues the count
 * the paused one left. A new user message starts at nothing.
 */
export function egressClosures(events: readonly ContextEvent[]): EgressClosures {
  const start = events.findLastIndex((e) => e.type === 'user_message')
  const closures: EgressClosures = { counts: new Map(), closedRoutes: new Set(), turnClosed: false }
  for (const e of events.slice(start + 1)) {
    if (e.type !== 'egress_refused') continue
    const d = e.data as Partial<EgressRefusedEventData> | undefined
    const route = typeof d?.route === 'string' ? d.route : NO_ROUTE
    closures.counts.set(route, (closures.counts.get(route) ?? 0) + 1)
    if (d?.closes === 'route') closures.closedRoutes.add(route)
    if (d?.closes === 'turn') closures.turnClosed = true
  }
  return closures
}

/** Whether this turn already recorded its directory warning (everything after
 *  the last `user_message`, the slice `egressClosures` reads): a resume re-runs
 *  the gate, and the turn warns once. */
function directoryWarned(events: readonly ContextEvent[]): boolean {
  const start = events.findLastIndex((e) => e.type === 'user_message')
  return events.slice(start + 1).some((e) => {
    const d = e.data as Partial<WarningEventData> | undefined
    return (
      e.type === 'warning' &&
      d?.task === EGRESS_WARNING_TASK &&
      (d.message === EGRESS_WARNINGS.directoryMissing ||
        d.message === EGRESS_WARNINGS.directoryUnreadable)
    )
  })
}

/** Every string a value carries (leaves and keys), for the given-address corpus. */
function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 64) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out, depth + 1)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k)
      stringsOf(v, out, depth + 1)
    }
  }
  return out
}

/** Declared values a `ByTier` setting can take on any tier. */
function tierValues<T>(value: ByTier<T>): T[] {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'default')
    ? Object.values(value as Record<string, T>)
    : [value as T]
}

const warnedNamespaces = new Set<string>()

/**
 * Refuse names that would read like a declaration and match nothing (#242 item
 * 4's rule). Checked when the gate RUNS, as the injection guard checks its
 * namespaces, because `inferServer` answers from the tool registrations of the
 * run, not of the module that built the pattern.
 */
function refuseUnverifiableNames(config: EgressGateConfig): void {
  const degraded = isDegradedToolSurface(config.catalog)
  const verify = (field: 'local' | 'addressSources', ns: string, meaning: string): void => {
    const canonical = inferServer(ns)
    if (canonical !== ns) {
      throw new Error(
        `[withEgressGate] ${field} namespace '${ns}' can never match a tool: inferServer('${ns}') ` +
          `is '${canonical}'. Declare '${canonical}'` +
          (field === 'local' ? ', or list exact names under `localTools`.' : '.'),
      )
    }
    if (!config.catalog.some((tool) => inferServer(tool) === ns)) {
      if (degraded) {
        if (!warnedNamespaces.has(`${field}:${ns}`)) {
          warnedNamespaces.add(`${field}:${ns}`)
          console.warn(
            `[withEgressGate] ${field} namespace '${ns}' matches no tool in a catalog built ` +
              `while the gateway was unreachable; it cannot be verified this turn.`,
          )
        }
        return
      }
      throw new Error(
        `[withEgressGate] ${field} namespace '${ns}' matches no tool in the catalog ` +
          `(${config.catalog.length} names), so it ${meaning}.`,
      )
    }
  }
  for (const ns of config.local) verify('local', ns, 'declares nothing local')
  for (const ns of config.addressSources ?? []) verify('addressSources', ns, 'gives no address')
  for (const name of config.localTools ?? []) {
    if (config.catalog.includes(name)) {
      throw new Error(
        `[withEgressGate] '${name}' is a catalog tool, so it cannot be local by name: a ` +
          `gateway tool is local only through its namespace.`,
      )
    }
  }
  for (const name of config.fetchTools ?? []) {
    if (!config.catalog.includes(name) && !degraded) {
      throw new Error(
        `[withEgressGate] fetch tool '${name}' is not in the catalog, so the address rule ` +
          `would apply to nothing.`,
      )
    }
  }
}

/** Refuse settings that would read like a gate and check nothing they say
 *  they check. TypeScript catches a literal typo; this catches a cast, a
 *  JavaScript caller and a value read from configuration. */
function refuseUnreadableSettings(config: EgressGateConfig): void {
  const { mode } = config
  if (typeof mode === 'object' && mode !== null && !Object.hasOwn(mode, 'default')) {
    throw new Error(`[withEgressGate] the per-tier mode has no \`default\`.`)
  }
  const modes = mode === undefined ? [] : tierValues(mode)
  const unknown = modes.find((m) => !MODES.has(m as string))
  if (unknown !== undefined) {
    throw new Error(`[withEgressGate] mode ${JSON.stringify(unknown)} is not 'filter' or 'roster'.`)
  }
  if (!config.decide && modes.includes('filter')) {
    throw new Error(`[withEgressGate] 'filter' mode asks Decide, and no \`decide\` was passed.`)
  }
  if (config.decide && !(config.decide.supportedTypes ?? ['choice']).includes('choice')) {
    throw new Error(`[withEgressGate] the decide seam does not serve 'choice' questions.`)
  }
  const threshold = config.threshold ?? GUARD_EGRESS_THRESHOLD
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`[withEgressGate] threshold must be in [0, 1], got ${threshold}`)
  }
  const timeoutMs = config.timeoutMs ?? GUARD_EGRESS_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`[withEgressGate] timeoutMs must be an integer >= 1, got ${timeoutMs}`)
  }
  const n = config.maxOutgoingRetriesPostTripwire ?? GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `[withEgressGate] maxOutgoingRetriesPostTripwire must be an integer >= 0, got ${n}`,
    )
  }
  const down = config.loadedDecideDown ?? 'by-shape'
  if (down !== 'by-shape' && down !== 'ask') {
    throw new Error(`[withEgressGate] loadedDecideDown must be 'by-shape' or 'ask'.`)
  }
  // Fail closed: with no declared sources, every result (a Cypher RETURN, a
  // script's output) would give the controller any address it wrote there.
  if (config.fetchTools?.length && !Array.isArray(config.addressSources)) {
    throw new Error(
      `[withEgressGate] \`fetchTools\` needs \`addressSources\`: the namespaces whose results ` +
        `give the controller addresses.`,
    )
  }
}

/** What the operator learns about a roster failure: the error's class name,
 *  reduced like a tool name, never its message (which can carry an identity).
 *  Never empty, because an empty cause would read as "not damaged". */
function damageCause(error: unknown): string {
  const name = error instanceof Error && typeof error.name === 'string' ? error.name : ''
  return name ? egressToolLabel(name) : typeof error
}

// What may close a given address in running text (a sentence's full stop, a
// Markdown link's parenthesis) and is not part of it. Stripped from the GIVEN
// side only, so the request's own address is still compared whole.
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/

/** What a person would be asked to release: exactly this call, readably, and
 *  the roster's matches in it. The decision AUTHORIZES the tool and its
 *  arguments alone, so a re-entry finds it whatever else is shown. */
interface EgressPayload {
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  readonly lines: readonly string[]
  readonly hosts: readonly string[]
  readonly spans: readonly string[]
}

/** What an egress release authorizes: exactly this tool with these arguments. */
const authorizedBy = (p: EgressPayload) => ({ tool: p.tool, args: p.args })

/** A call a person cell is about: why it was stopped, and what they see. */
interface Held {
  readonly cause: 'decide' | 'unchecked'
  readonly category?: 'personal' | 'company'
  readonly payload: EgressPayload
  readonly spans: readonly string[]
}

/** What one ask of the egress question came to. */
type EgressAnswer =
  | { readonly kind: 'answered'; readonly probs: EgressProbabilities }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed' }

/** Per-turn counts of a degraded check, reported on the turn's warning. */
interface Degraded {
  timeouts: number
  failures: number
  /** Calls that went out on the roster alone (a loaded directory, Decide down). */
  rosterOnly: number
  /** Calls stopped for want of Decide: a person cell, asked or refused. */
  refusedUnchecked: number
}

/**
 * Wrap a pattern so every outgoing call inside it is judged before it leaves.
 *
 * @example
 * withEgressGate({
 *   local: ['neo4j'],
 *   catalog: tools.all,
 *   decide: createDecideAdapter(),
 *   roster: deps.egressRoster,
 * })(decisionLoop(routes, config))
 */
export function withEgressGate(config: EgressGateConfig) {
  refuseUnreadableSettings(config)
  const local = new Set(config.local)
  const localTools = new Set(config.localTools ?? [])
  const fetchTools = new Set(config.fetchTools ?? [])
  const threshold = config.threshold ?? GUARD_EGRESS_THRESHOLD
  const timeoutMs = config.timeoutMs ?? GUARD_EGRESS_TIMEOUT_MS
  const maxRetries = config.maxOutgoingRetriesPostTripwire ?? GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE
  const loadedDecideDown = config.loadedDecideDown ?? 'by-shape'
  const addressSources = new Set(config.addressSources ?? [])
  const isLocal = (name: string): boolean => localTools.has(name) || local.has(inferServer(name))
  const givesAddresses = (tool: unknown): boolean =>
    typeof tool === 'string' && addressSources.has(inferServer(tool))

  return <T>(pattern: ConfiguredPattern<T>): ConfiguredPattern<T> => {
    // Its tripwire count and closures are derived from the turn's recorded
    // refusals, never held here, so a resume passes straight through it
    // (slice 6) and the count continues across the pause.
    const resumable = wrapperResumable('withEgressGate', pattern)
    const fn = (
      scope: PatternScope<T>,
      view: Parameters<typeof pattern.fn>[1],
    ): Promise<PatternScope<T>> =>
      resumableStep('withEgressGate', resumable, () => gated(scope, view))
    const gated = async (
      scope: PatternScope<T>,
      view: Parameters<typeof pattern.fn>[1],
    ): Promise<PatternScope<T>> => {
      refuseUnverifiableNames(config)
      const ctx = (view as unknown as { ctx: UnifiedContext }).ctx
      // Pushed directly, like the injection guard's events: a loop's
      // `trackHistory` would filter a security record out of existence.
      const record = (type: EventType, data: unknown, call?: Parameters<typeof redactCall>[0]) => {
        const event = createEvent(type, scope.id, data, redactCall(call))
        scope.events.push(event)
        emitLive(event)
      }
      const warn = (
        key: keyof typeof EGRESS_WARNINGS,
        detail?: Readonly<Record<string, number | string>>,
      ) =>
        record('warning', {
          task: EGRESS_WARNING_TASK as WarningTask,
          message: EGRESS_WARNINGS[key],
          fallback: WARNING_FALLBACKS[key],
          ...(detail && { detail }),
        } satisfies WarningEventData)

      const latest = ctx.events.findLast((e) => e.type === 'user_message')
      const latestUser = latest ? (latest.data as UserMessageEventData).content : ''
      const resultEvents = ctx.events.filter((e) => e.type === 'tool_result')
      const results = resultEvents.map((e) => e.data)
      const closures = egressClosures(ctx.events)
      const batchRefuseAll = (): void => {
        closures.turnClosed = true
        record('egress_refused', {
          tool: 'batch',
          route: NO_ROUTE,
          cause: 'unchecked',
          closes: 'turn',
        } satisfies EgressRefusedEventData)
      }
      // The addresses the controller was given (O21), each as `addressesIn`
      // finds it: the user's latest message and the data of every
      // `addressSources` result in the context, extended by this invocation's.
      const given = new Set<string>()
      const give = (text: string): void => {
        for (const address of addressesIn(text)) {
          given.add(address)
          given.add(address.replace(TRAILING_PUNCTUATION, ''))
        }
      }
      give(latestUser)
      for (const e of resultEvents) {
        const d = e.data as Partial<ToolResultEventData> | undefined
        if (givesAddresses(d?.tool)) for (const text of stringsOf(d?.result)) give(text)
      }

      let directory: EgressDirectoryStatus = 'none'
      let roster: EgressRoster | undefined
      let damaged: string | undefined
      if (config.roster) {
        try {
          // The roster exempts what the user wrote; Decide is shown only the
          // first EGRESS_USER_CAP characters, so only those exempt.
          const built = await config.roster(results, latestUser.slice(0, EGRESS_USER_CAP))
          // An answer outside the four is a host bug: refuse rather than guess.
          directory = DIRECTORY_STATUSES.has(built.directory) ? built.directory : 'unreadable'
          roster = built.roster
        } catch (error) {
          // The rejection can carry an identity: its name is kept for the
          // operator, never its message.
          damaged = damageCause(error)
        }
      }
      if (damaged) warn('damagedRoster', { cause: damaged })
      // An empty or unreadable directory is announced at the turn's FIRST
      // OUTGOING check (in `check`), not here: its fallback says outside
      // requests were still checked, which is false on a turn that makes none.
      // Read from the turn's events, so a resumed invocation stays quiet; set
      // when it fires, because this invocation's record is not in them yet.
      let directoryAnnounced = directoryWarned(ctx.events)

      const degraded: Degraded = { timeouts: 0, failures: 0, rosterOnly: 0, refusedUnchecked: 0 }
      const queues = new Map<string | null, Promise<unknown>>()

      const askEgress = async (state: string): Promise<EgressAnswer> => {
        const decide = config.decide!
        const abort = new AbortController()
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            abort.abort()
            reject(new Error(`the egress question timed out after ${timeoutMs} ms`))
          }, timeoutMs)
        })
        deadline.catch(() => undefined)
        // The deadline aborts the request; the race bounds the wait even for a
        // seam that ignores the signal. One budget covers both attempts.
        const bounded = ((input) => {
          const asked = decide(input)
          asked.catch(() => undefined)
          return Promise.race([asked, deadline])
        }) as DecideFn
        Object.defineProperty(bounded, 'supportedTypes', { value: decide.supportedTypes })
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const evaluated = await evaluateDecision({
              decide: bounded,
              spec: GUARD_EGRESS,
              state,
              signal: abort.signal,
            })
            record(
              'decision_made',
              evaluated.event,
              currentRunFrame()?.batchPhase === 'preflight' ? undefined : evaluated.llmCall,
            )
            if (!evaluated.decision.abstained) {
              const p = evaluated.decision.probs as Partial<Record<string, number>>
              return {
                kind: 'answered',
                probs: {
                  personal: p.personal ?? 0,
                  company: p.company ?? 0,
                  nothing_private: p.nothing_private ?? 0,
                },
              }
            }
            // A timeout spent the budget: no retry. A failure gets one.
            if (timedOut) return { kind: 'timeout' }
          }
          return { kind: 'failed' }
        } finally {
          clearTimeout(timer)
        }
      }

      const check = async (call: { name: string; args: Readonly<Record<string, unknown>> }) => {
        const route = currentRunFrame()?.route ?? NO_ROUTE
        const tool = egressToolLabel(call.name)

        // `check` sees outgoing calls only (`egressCheck` drops local ones).
        if ((directory === 'empty' || directory === 'unreadable') && !directoryAnnounced) {
          directoryAnnounced = true
          // Loud: a server log line (no content) as well as the turn's warning.
          console.warn(
            `[withEgressGate] the company directory is ${directory}: outgoing requests are ` +
              `checked without it this turn.`,
          )
          warn(directory === 'empty' ? 'directoryMissing' : 'directoryUnreadable')
        }

        /** A tripwire: count it, close the route past N, record it, and answer
         *  with the text for whether this refusal closed the route. */
        const tripwire = (cause: 'decide' | 'unchecked', category?: 'personal' | 'company') => {
          const count = (closures.counts.get(route) ?? 0) + 1
          closures.counts.set(route, count)
          const closes = count > maxRetries
          if (closes) closures.closedRoutes.add(route)
          record('egress_refused', {
            tool,
            route,
            cause,
            ...(category && { category }),
            closes: closes ? 'route' : 'none',
          } satisfies EgressRefusedEventData)
          if (cause === 'unchecked') {
            return closes ? EGRESS_TEXTS.uncheckedClosing : EGRESS_TEXTS.uncheckedOpen
          }
          if (category === 'company') {
            return closes ? EGRESS_TEXTS.companyClosing : EGRESS_TEXTS.companyOpen
          }
          return closes ? EGRESS_TEXTS.personalClosing : EGRESS_TEXTS.personalOpen
        }

        /** The person's decision on this call: the button they pressed, or the
         *  unattended rule's pick, which is Refuse. */
        const decided = (choice: string, held: Held): string | undefined => {
          if (choice === 'accept') {
            record('egress_audit', {
              tool,
              hosts: held.payload.hosts,
              spans: held.spans.map((s) => s.slice(0, EGRESS_SPAN_CAP)),
              allowedBy: 'person',
            } satisfies EgressAuditEventData)
            return undefined
          }
          if (choice === 'refuse-all') {
            closures.counts.set(route, (closures.counts.get(route) ?? 0) + 1)
            closures.turnClosed = true
            record('egress_refused', {
              tool,
              route,
              cause: held.cause,
              ...(held.category && { category: held.category }),
              closes: 'turn',
            } satisfies EgressRefusedEventData)
            return EGRESS_TEXTS.turnClosed
          }
          // Refuse, and anything else: the tripwire this refusal would have been.
          return tripwire(held.cause, held.category)
        }

        /** A cell that names the person: ask, where the call can pause and is
         *  not one of a batch (O16); anywhere else, refuse. */
        const person = async (held: Held): Promise<EgressVerdict> => {
          if (!config.askPerson || !canPauseHere()) {
            return tripwire(held.cause, held.category)
          }
          if (currentRunFrame()?.batchPhase === 'preflight') {
            return {
              batchHeld: {
                cause: held.cause,
                ...(held.category && { category: held.category }),
                route,
                payload: held.payload,
              },
            }
          }
          if (currentRunFrame()?.batch) return tripwire(held.cause, held.category)
          const outcome = await askHumanHolding(
            {
              kind: EGRESS_RELEASE_KIND,
              question: 'Send this request to an outside service?',
              options: EGRESS_RELEASE_OPTIONS,
              defaultOption: 'refuse',
              summary: {
                category: held.category ?? 'unchecked',
                // Whether Refuse closes the route: the helper line says so.
                closes: (closures.counts.get(route) ?? 0) + 1 > maxRetries,
              },
            },
            held.payload,
            authorizedBy(held.payload),
          )
          if (outcome.status === 'rebound') return tripwire(held.cause, held.category)
          if (outcome.status === 'pending') {
            return { held: { ...held_(outcome, EGRESS_HELD_NOTE), redispatch: true } }
          }
          // No choice (an unattended rule that decided nothing) refuses.
          return decided(outcome.choice ?? 'refuse', held)
        }

        /** Decide could not answer for this call: the directory matrix (D5). */
        const unavailable = async (
          why: 'roster-mode' | 'down',
          request: OutgoingRequest,
          unchecked: Held,
        ): Promise<EgressVerdict> => {
          const { spans } = unchecked
          if (directory === 'loaded') {
            if (why === 'roster-mode') return spans.length ? EGRESS_TEXTS.roster : undefined
            const asked =
              loadedDecideDown === 'ask' ||
              carriesUrlQuery(request.texts) ||
              request.block.length > EGRESS_SMALL_BLOCK_CHARS
            if (asked) {
              degraded.refusedUnchecked++
              return person(unchecked)
            }
            if (spans.length) return EGRESS_TEXTS.roster
            degraded.rosterOnly++
            return undefined
          }
          if (directory === 'unreadable') {
            if (why === 'down') degraded.refusedUnchecked++
            return tripwire('unchecked')
          }
          // `empty` or `none`: the payload roster vetoes first, then the person
          // is asked (ruling C).
          if (spans.length) return EGRESS_TEXTS.roster
          if (why === 'down') degraded.refusedUnchecked++
          return person(unchecked)
        }

        const decideOne = async (): Promise<EgressVerdict> => {
          const frame = currentRunFrame()
          if (frame?.batchPhase === 'execute') {
            const prepared = frame.batchPrepared
            const digest = createHash('sha256')
              .update(canonicalJson({ tool: call.name, args: call.args }))
              .digest('hex')
            if (
              !prepared ||
              prepared.callKey !== frame.callKey ||
              prepared.digest !== digest ||
              prepared.route !== route
            )
              return EGRESS_BATCH_MISMATCH
            if (closures.turnClosed) return EGRESS_TEXTS.turnClosed
            if (closures.closedRoutes.has(route)) return EGRESS_TEXTS.routeClosed
            if (prepared.decision === 'refuse')
              return tripwire(prepared.cause ?? 'unchecked', prepared.category)
            if (
              prepared.decision === 'accept' ||
              (prepared.decision === 'pass' && prepared.auditByDecide)
            ) {
              const allowedBy = prepared.decision === 'accept' ? 'person' : 'decide'
              return {
                batchAudit: () =>
                  record('egress_audit', {
                    tool,
                    hosts: [],
                    spans: [],
                    allowedBy,
                  } satisfies EgressAuditEventData),
              }
            }
            return undefined
          }
          if (closures.turnClosed) return EGRESS_TEXTS.turnClosed
          if (closures.closedRoutes.has(route)) return EGRESS_TEXTS.routeClosed
          if (damaged) return EGRESS_TEXTS.damagedRoster

          const read = readOutgoing(call.args)
          if (!read.ok) return read.refusal
          const request = read.request
          if (fetchTools.has(call.name)) {
            // A leaf that carries an address, or sits under a `url` key (in an
            // array too), must BE a given address, and so must each address in
            // it: a prefix of given text, or a given address with text after
            // it, is not one. Only what a URL parser strips at the ends (C0
            // controls and space) is stripped here: `trim()` also strips
            // Unicode spaces a parser keeps, and those would carry data.
            const ungiven = request.raw.some(({ key, value }) => {
              const addresses = addressesIn(value)
              if (addresses.length === 0 && key?.toLowerCase() !== 'url') return false
              const bare = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
              return !given.has(bare) || addresses.some((a) => !given.has(a))
            })
            if (ungiven) return EGRESS_TEXTS.fetchAddress
          }

          const spans = roster ? roster.match(request.texts) : []
          const hosts = destinationHosts(request.texts)
          // What a person would be shown and asked about: exactly this call.
          const payload: EgressPayload = {
            tool: call.name,
            args: call.args,
            lines: request.lines,
            hosts,
            spans: spans.map((s) => s.slice(0, EGRESS_SPAN_CAP)),
          }
          const unchecked: Held = { cause: 'unchecked', payload, spans }
          if (config.askPerson && currentRunFrame()?.batchPhase !== 'preflight') {
            // Re-entered on a call a person decided: their answer, not Decide's.
            const prior = recordedHolding(
              EGRESS_RELEASE_KIND,
              EGRESS_RELEASE_OPTIONS,
              authorizedBy(payload),
            )
            if (prior) {
              const c = prior.summary.category
              return decided(
                prior.choice,
                c === 'personal' || c === 'company'
                  ? { cause: 'decide', category: c, payload, spans }
                  : unchecked,
              )
            }
          }
          const mode = resolveByTier(config.mode ?? (config.decide ? 'filter' : 'roster'))
          if (mode !== 'filter' || !config.decide)
            return unavailable('roster-mode', request, unchecked)

          let state: string
          try {
            state = renderEgressState(
              {
                tool: call.name,
                hosts,
                spans,
                latestUserMessage: latestUser,
                lines: request.lines,
              },
              { drawNonce: process.env.VITEST ? testNonceSource : undefined },
            )
          } catch {
            // A state the question cannot be asked over (over the box's budget,
            // or no nonce to draw): Decide is unavailable for this call.
            degraded.failures++
            return unavailable('down', request, unchecked)
          }
          const answer = await askEgress(state)
          if (answer.kind !== 'answered') {
            if (answer.kind === 'timeout') degraded.timeouts++
            else degraded.failures++
            return unavailable('down', request, unchecked)
          }
          const { probs } = answer
          if (1 - probs.nothing_private >= threshold) {
            // The feedback names the larger private label; a tie names personal.
            return person({
              cause: 'decide',
              category: probs.company > probs.personal ? 'company' : 'personal',
              payload,
              spans,
            })
          }
          if (spans.length && currentRunFrame()?.batchPhase === 'preflight') {
            return { batchPassed: true }
          }
          if (spans.length) {
            record('egress_audit', {
              tool,
              hosts,
              spans: spans.map((s) => s.slice(0, EGRESS_SPAN_CAP)),
              probs,
              allowedBy: 'decide',
            } satisfies EgressAuditEventData)
          }
          return undefined
        }

        // One route's checks run one at a time, in arrival (batch) order.
        const previous = queues.get(route) ?? Promise.resolve()
        const next = previous.then(decideOne)
        queues.set(
          route,
          next.then(
            () => undefined,
            () => undefined,
          ),
        )
        return next
      }

      const egressCheck = (call: { name: string; args: Readonly<Record<string, unknown>> }) =>
        isLocal(call.name) ? undefined : check(call)

      const observe = async (
        call: { readonly name: string },
        result: ToolCallResult,
      ): Promise<undefined> => {
        // Data only: an error string can quote the arguments that caused it.
        if (givesAddresses(call.name)) for (const text of stringsOf(result.data)) give(text)
        if (!roster || damaged || !isLocal(call.name)) return undefined
        try {
          roster.observe(result.data)
        } catch (error) {
          // Delivered, not withheld: the gate guards what leaves, and this
          // result never leaves. Every later outgoing call is refused.
          damaged = damageCause(error)
          warn('damagedRoster', { cause: damaged })
        }
        return undefined
      }

      try {
        return await amendRunFrame(
          {
            egressChecks: [egressCheck],
            afterToolCall: [observe],
            egressBatchEnabled: config.askPerson === true,
            batchRefuseAll,
          },
          () => pattern.fn(scope, view),
        )
      } finally {
        if (degraded.timeouts + degraded.failures > 0) warn('checkDegraded', { ...degraded })
      }
    }

    return {
      ...pattern,
      name: `withEgressGate(${pattern.name})`,
      fn,
      capabilities: {
        ...pattern.capabilities,
        resumable,
        // A call that may pause for a person is offered only where a pause
        // resumes: construction refuses an outgoing name anywhere else.
        ...(config.askPerson
          ? {
              gatedTools: [
                ...(pattern.capabilities?.gatedTools ?? []),
                ...config.catalog.filter((name) => !isLocal(name)),
              ],
            }
          : {}),
      },
      // Static introspection still sees the patterns nested inside the gate.
      children: [pattern],
    }
  }
}
