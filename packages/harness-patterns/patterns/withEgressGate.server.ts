/**
 * Per-tool outgoing gate. Every non-local call passes through closures, step 1
 * integrity, and the given-address fetch rule before its selected name matcher
 * and Decide setting. An active Decide outage refuses with a fixed error event;
 * shadow questions run after transport and never affect the call.
 */
import { assertServerOnImport } from '../assert.server'
import { randomUUID } from 'node:crypto'
import { createEvent, redactCall } from '../context.server'
import {
  destinationHosts,
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
} from '../egress-gate.server'
import { isDegradedToolSurface } from '../gateway-health.server'
import { emitLive } from '../live-event-context.server'
import {
  askHumanHolding,
  authorizationDigest,
  batchRowAcceptedInRun,
  canPauseHere,
  held as held_,
  recordedHolding,
} from '../hitl.server'
import {
  amendRunFrame,
  currentRunFrame,
  effectiveTier,
  type EgressRefusal,
  type EgressVerdict,
} from '../run-frame.server'
import { resumableStep, wrapperResumable } from '../resume.server'
import { inferServer } from '../tools.server'
import { egressArgumentSpans, interpretUrlSpans } from '../url-seam'
import type {
  ConfiguredPattern,
  ContextEvent,
  DecisionMadeEventData,
  DecideFn,
  EgressAuditEventData,
  EgressBlockedEventData,
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

export interface EgressDetectors {
  readonly nameMatch: 'off' | 'evidence' | 'refuse'
  readonly decide: 'off' | 'on' | 'shadow'
}

export interface EgressDetectorConfig {
  readonly default: EgressDetectors
  readonly tools?: Readonly<Record<string, EgressDetectors>>
  readonly tags?: Readonly<Record<string, EgressDetectors>>
}

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
  /** Exact tool overrides tag, which overrides default. */
  readonly detectors?: EgressDetectorConfig
  /** Host-built, name-keyed catalog metadata. */
  readonly toolTags?: Readonly<Record<string, readonly string[]>>
  /** τe. Default {@link GUARD_EGRESS_THRESHOLD}. */
  readonly threshold?: number
  /** The egress question's whole budget, retry included. Default
   *  {@link GUARD_EGRESS_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** N (ruling M): refusals a route admits after its first before it closes.
   *  Default {@link GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE} (0): the first
   *  refusal closes the route for the turn. */
  readonly maxOutgoingRetriesPostTripwire?: number
  /** Ask the person after an active Decide refusal where the call can pause.
   *  Elsewhere it refuses. Default false.
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

export const EGRESS_OWNER_REFUSED = 'REFUSED by the owner. '
export const EGRESS_OWNER_REFUSED_ALL = 'REFUSED by the owner (all similar actions this turn). '

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

const NAME_MATCHES: ReadonlySet<string> = new Set(['off', 'evidence', 'refuse'])
const DECIDE_MODES: ReadonlySet<string> = new Set(['off', 'on', 'shadow'])
const DIRECTORY_STATUSES: ReadonlySet<string> = new Set(['loaded', 'empty', 'unreadable', 'none'])

/** The bucket of a call outside any `decisionLoop` route. */
const NO_ROUTE = null

/** User-facing hints for the gate's warnings. Never model-visible: a warning
 *  is serialized as `task: message` only. */
const WARNING_FALLBACKS = {
  damagedRoster: 'Further outside requests were refused.',
  directoryMissing: 'Outside requests were still checked.',
  directoryUnreadable: 'Outside requests were still checked, and refused when they could not be.',
  checkDegraded: 'Requests whose active check was unavailable were refused.',
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

function resolveDetectors(config: EgressGateConfig, isLocal: (name: string) => boolean) {
  const fallback: EgressDetectors = config.decide
    ? { nameMatch: 'evidence', decide: 'on' }
    : { nameMatch: 'refuse', decide: 'off' }
  const declared = config.detectors ?? { default: fallback }
  const validate = (value: EgressDetectors, selector: string): void => {
    if (!value || !NAME_MATCHES.has(value.nameMatch) || !DECIDE_MODES.has(value.decide))
      throw new Error(`[withEgressGate] invalid detectors for ${selector}`)
    if (value.decide !== 'off' && !config.decide)
      throw new Error(`[withEgressGate] ${selector} asks Decide, and no \`decide\` was passed.`)
  }
  validate(declared.default, 'default')
  const catalog = new Set(config.catalog)
  const degraded = isDegradedToolSurface(config.catalog)
  for (const name of Object.keys(config.toolTags ?? {}))
    if (!catalog.has(name)) {
      if (degraded)
        console.warn(
          `[withEgressGate] toolTags name '${name}' cannot be verified in a degraded catalog.`,
        )
      else throw new Error(`[withEgressGate] toolTags name '${name}' is absent from catalog.`)
    }
  const resolved = new Map<string, EgressDetectors>()
  const tags = new Map<string, EgressDetectors>()
  for (const [tag, value] of Object.entries(declared.tags ?? {})) {
    validate(value, `tag:${tag}`)
    const names = config.catalog.filter((name) =>
      tag === 'egress' ? !isLocal(name) : config.toolTags?.[name]?.includes(tag),
    )
    if (!names.length) {
      if (degraded)
        console.warn(`[withEgressGate] tag:${tag} cannot be verified in a degraded catalog.`)
      else throw new Error(`[withEgressGate] tag:${tag} selects no catalog tool.`)
    }
    for (const name of names) {
      if (isLocal(name))
        throw new Error(`[withEgressGate] tag:${tag} selects local tool '${name}'.`)
      const earlier = tags.get(name)
      if (earlier && (earlier.nameMatch !== value.nameMatch || earlier.decide !== value.decide))
        throw new Error(`[withEgressGate] conflicting tag detectors for '${name}'.`)
      tags.set(name, value)
    }
  }
  for (const [name, value] of Object.entries(declared.tools ?? {})) {
    validate(value, name)
    if (isLocal(name)) throw new Error(`[withEgressGate] '${name}' is local.`)
    if (!catalog.has(name)) {
      if (degraded)
        console.warn(`[withEgressGate] tool '${name}' cannot be verified in a degraded catalog.`)
      else throw new Error(`[withEgressGate] unknown tool '${name}'.`)
    }
    resolved.set(name, value)
  }
  for (const [name, value] of tags) if (!resolved.has(name)) resolved.set(name, value)
  for (const name of config.catalog) {
    if (isLocal(name)) continue
    const value = resolved.get(name) ?? declared.default
    if (value.decide !== 'on' && value.nameMatch !== 'refuse')
      console.warn(`[withEgressGate] outgoing tool '${name}' has no active detector.`)
  }
  return { resolved, fallback: declared.default }
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

/** Every address span the seam's egress argument scan finds in `text` (slice
 *  3: `docs/plan/url-interpretation-seam.md`). The given-address corpus
 *  consumes the seam's spans, whose `raw` is the original spelling, never a
 *  canonical rewrite — so neither side of the comparison canonicalizes. The
 *  same spans `addressesIn` projects to strings; this keeps the span contract
 *  as the corpus's address source, as slice 2 did for `destinationHosts`. */
const addressSpans = (text: string) => interpretUrlSpans(text, egressArgumentSpans(text)).spans

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
}

/** A recorded event whose live delivery failed; never retain the listener's error. */
class EgressLiveEmissionError extends Error {
  constructor(readonly eventType: EventType) {
    super('egress live event listener failed')
  }
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
  const addressSources = new Set(config.addressSources ?? [])
  const isLocal = (name: string): boolean => localTools.has(name) || local.has(inferServer(name))
  const detectors = resolveDetectors(config, isLocal)
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
        try {
          emitLive(event)
        } catch {
          // The record exists even when its live listener fails. Keep the
          // listener's exception (which may contain request data) out of view.
          throw new EgressLiveEmissionError(type)
        }
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
      // The addresses the controller was given (O21), each as the seam's
      // argument scan finds it: the user's latest message and the data of every
      // `addressSources` result in the context, extended by this invocation's.
      const given = new Set<string>()
      const give = (text: string): void => {
        for (const span of addressSpans(text)) {
          given.add(span.raw)
          given.add(span.raw.replace(TRAILING_PUNCTUATION, ''))
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
      const pendingLocalResults: unknown[] = []
      let rosterLoad: Promise<void> | undefined
      const ensureRoster = async (): Promise<void> => {
        if (!config.roster) return
        rosterLoad ??= (async () => {
          try {
            // The roster exempts what the user wrote; Decide is shown only the
            // first EGRESS_USER_CAP characters, so only those exempt.
            const built = await config.roster!(results, latestUser.slice(0, EGRESS_USER_CAP))
            // An answer outside the four is a host bug: refuse rather than guess.
            directory = DIRECTORY_STATUSES.has(built.directory) ? built.directory : 'unreadable'
            roster = built.roster
            for (const data of pendingLocalResults) roster.observe(data)
            pendingLocalResults.length = 0
          } catch (error) {
            // The rejection can carry an identity: its name is kept for the
            // operator, never its message.
            damaged = damageCause(error)
          }
          if (damaged) warn('damagedRoster', { cause: damaged })
        })()
        await rosterLoad
      }
      // An empty or unreadable directory is announced at the turn's FIRST
      // OUTGOING check (in `check`), not here: its fallback says outside
      // requests were still checked, which is false on a turn that makes none.
      // Read from the turn's events, so a resumed invocation stays quiet; set
      // when it fires, because this invocation's record is not in them yet.
      let directoryAnnounced = directoryWarned(ctx.events)

      const degraded: Degraded = { timeouts: 0, failures: 0 }
      const queues = new Map<string | null, Promise<unknown>>()
      const shadows: Array<{ state: string; tool: string; callId: string }> = []
      const lastUserIndex = ctx.events.findLastIndex((e) => e.type === 'user_message')
      let degradedCatalogWarned = ctx.events.slice(lastUserIndex + 1).some((e) => {
        const warning = e.data as Partial<WarningEventData> | undefined
        return (
          e.type === 'warning' &&
          warning?.task === EGRESS_WARNING_TASK &&
          warning.message === EGRESS_WARNINGS.checkDegraded
        )
      })
      const recordShadowAbstained = (
        tool: string,
        callId: string,
        skipReason: NonNullable<DecisionMadeEventData['skipReason']>,
      ): void =>
        record('decision_made', {
          key: GUARD_EGRESS.key,
          question: GUARD_EGRESS.question,
          labels: GUARD_EGRESS.labels.map(({ id, description }) => ({ id, description })),
          probs: {},
          label: null,
          top: null,
          margin: 0,
          abstained: true,
          reason: 'error',
          calibrated: false,
          stateChars: 0,
          shadow: true,
          tool,
          callId,
          skipReason,
        } satisfies DecisionMadeEventData)

      const askEgress = async (
        state: string,
        shadow?: { tool: string; callId: string },
        waitMs = timeoutMs,
      ): Promise<EgressAnswer> => {
        const decide = config.decide!
        const abort = new AbortController()
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            abort.abort()
            reject(new Error(`the egress question timed out after ${waitMs} ms`))
          }, waitMs)
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
        let shadowEvent: DecisionMadeEventData | undefined
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const evaluated = await evaluateDecision({
              decide: bounded,
              spec: GUARD_EGRESS,
              state,
              signal: abort.signal,
            })
            const p = evaluated.decision.probs as Partial<Record<string, number>>
            const event = shadow
              ? ({
                  ...evaluated.event,
                  shadow: true,
                  tool: shadow.tool,
                  callId: shadow.callId,
                  ...(!evaluated.decision.abstained && {
                    wouldRefuse: 1 - (p.nothing_private ?? 0) >= threshold,
                    wouldCategory: (p.company ?? 0) > (p.personal ?? 0) ? 'company' : 'personal',
                  }),
                } satisfies DecisionMadeEventData)
              : evaluated.event
            if (shadow) shadowEvent = event
            else
              record(
                'decision_made',
                event,
                currentRunFrame()?.batchPhase === 'preflight' ? undefined : evaluated.llmCall,
              )
            if (!evaluated.decision.abstained) {
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
          if (shadowEvent) record('decision_made', shadowEvent)
        }
      }

      const check = async (call: { name: string; args: Readonly<Record<string, unknown>> }) => {
        const route = currentRunFrame()?.route ?? NO_ROUTE
        const tool = egressToolLabel(call.name)
        const callId = currentRunFrame()?.callKey ?? randomUUID()
        const block = (rule: EgressBlockedEventData['rule'], feedback: string): EgressRefusal => {
          record('egress_blocked', { tool, route, rule } satisfies EgressBlockedEventData)
          return { kind: 'refuse', rule, feedback }
        }

        /** A tripwire: count it, close the route past N, record it, and answer
         *  with the text for whether this refusal closed the route. */
        const tripwire = (
          cause: 'decide' | 'unchecked',
          category?: 'personal' | 'company',
        ): EgressRefusal => {
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
          let feedback: string
          if (cause === 'unchecked') {
            feedback = closes ? EGRESS_TEXTS.uncheckedClosing : EGRESS_TEXTS.uncheckedOpen
          } else if (category === 'company') {
            feedback = closes ? EGRESS_TEXTS.companyClosing : EGRESS_TEXTS.companyOpen
          } else {
            feedback = closes ? EGRESS_TEXTS.personalClosing : EGRESS_TEXTS.personalOpen
          }
          return { kind: 'refuse', rule: cause, feedback }
        }

        /** The person's decision on this call: the button they pressed, or the
         *  unattended rule's pick, which is Refuse. An owner's answer prefixes
         *  the feedback, never the record. */
        const decided = (choice: string, held: Held, byOwner = false): EgressVerdict => {
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
            return {
              kind: 'refuse',
              rule: held.cause,
              feedback: (byOwner ? EGRESS_OWNER_REFUSED_ALL : '') + EGRESS_TEXTS.turnClosed,
            }
          }
          // Refuse, and anything else: the tripwire this refusal would have been.
          const refusal = tripwire(held.cause, held.category)
          return byOwner
            ? { ...refusal, feedback: EGRESS_OWNER_REFUSED + refusal.feedback }
            : refusal
        }

        /** A cell that names the person: ask, where the call can pause and is
         *  not one of a batch (O16); anywhere else, refuse. */
        const person = async (held: Held): Promise<EgressVerdict> => {
          if (!config.askPerson || !canPauseHere()) {
            return tripwire(held.cause, held.category)
          }
          if (currentRunFrame()?.batchPhase === 'preflight') {
            return {
              kind: 'batch-hold',
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
            return {
              kind: 'hold',
              held: { ...held_(outcome, EGRESS_HELD_NOTE), redispatch: true },
            }
          }
          // No choice (an unattended rule that decided nothing) refuses.
          return decided(outcome.choice ?? 'refuse', held, outcome.by === 'person')
        }

        const unavailable = (): EgressVerdict => {
          record('error', {
            kind: 'egress_decide_unavailable',
            severity: 'irrecoverable',
            error: 'An outside request was refused because its safety check was unavailable.',
            hint: 'Try again later.',
          })
          return tripwire('unchecked')
        }

        const decideOne = async (): Promise<EgressVerdict> => {
          const frame = currentRunFrame()
          if (frame?.batchPhase === 'execute') {
            const prepared = frame.batchPrepared
            const digest = authorizationDigest({ tool: call.name, args: call.args })
            if (
              !prepared ||
              prepared.callKey !== frame.callKey ||
              prepared.digest !== digest ||
              prepared.route !== route ||
              !prepared.batchPlanKey ||
              prepared.batchPlanKey !== frame.batchPlanKey ||
              (prepared.decision === 'accept' &&
                (!prepared.requestId ||
                  !batchRowAcceptedInRun(
                    prepared.requestId,
                    EGRESS_BATCH_RELEASE_KIND,
                    prepared.callKey,
                    prepared.batchPlanKey,
                  )))
            )
              return block('check-failed', EGRESS_BATCH_MISMATCH)
            if (closures.turnClosed) return block('turn-closed', EGRESS_TEXTS.turnClosed)
            if (closures.closedRoutes.has(route))
              return block('route-closed', EGRESS_TEXTS.routeClosed)
            if (prepared.decision === 'refuse') {
              const refusal = tripwire(prepared.cause ?? 'unchecked', prepared.category)
              return prepared.byOwner
                ? { ...refusal, feedback: EGRESS_OWNER_REFUSED + refusal.feedback }
                : refusal
            }
            if (
              prepared.decision === 'accept' ||
              (prepared.decision === 'pass' && prepared.auditByDecide)
            ) {
              const allowedBy = prepared.decision === 'accept' ? 'person' : 'decide'
              return {
                kind: 'audit',
                record: () =>
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
          if (closures.turnClosed) return block('turn-closed', EGRESS_TEXTS.turnClosed)
          if (closures.closedRoutes.has(route))
            return block('route-closed', EGRESS_TEXTS.routeClosed)
          const read = readOutgoing(call.args)
          if (!read.ok) return block(read.rule, read.feedback)
          const request = read.request
          if (fetchTools.has(call.name)) {
            // A leaf that carries an address, or sits under a `url` key (in an
            // array too), must BE a given address, and so must each address in
            // it: a prefix of given text, or a given address with text after
            // it, is not one. Only what a URL parser strips at the ends (C0
            // controls and space) is stripped here: `trim()` also strips
            // Unicode spaces a parser keeps, and those would carry data.
            const ungiven = request.raw.some(({ key, value }) => {
              const addresses = addressSpans(value)
              if (addresses.length === 0 && key?.toLowerCase() !== 'url') return false
              const bare = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
              return !given.has(bare) || addresses.some((span) => !given.has(span.raw))
            })
            if (ungiven) return block('fetch-address', EGRESS_TEXTS.fetchAddress)
          }

          const verified = config.catalog.includes(call.name)
          const detector = verified
            ? (detectors.resolved.get(call.name) ?? detectors.fallback)
            : detectors.fallback
          if (
            isDegradedToolSurface(config.catalog) &&
            !verified &&
            detector.decide !== 'on' &&
            detector.nameMatch !== 'refuse'
          ) {
            if (!degradedCatalogWarned) {
              degradedCatalogWarned = true
              warn('checkDegraded')
            }
            return block('check-failed', EGRESS_TEXTS.uncheckedOpen)
          }
          if (detector.nameMatch !== 'off') {
            await ensureRoster()
            if ((directory === 'empty' || directory === 'unreadable') && !directoryAnnounced) {
              directoryAnnounced = true
              console.warn(
                `[withEgressGate] the company directory is ${directory}: outgoing requests are ` +
                  `checked without it this turn.`,
              )
              warn(directory === 'empty' ? 'directoryMissing' : 'directoryUnreadable')
            }
          }
          if (detector.nameMatch !== 'off' && damaged)
            return block('damaged-roster', EGRESS_TEXTS.damagedRoster)
          const spans = detector.nameMatch !== 'off' && roster ? roster.match(request.texts) : []
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
                prior.by === 'person',
              )
            }
          }
          const veto = detector.nameMatch === 'refuse' && spans.length > 0
          if (detector.decide === 'shadow') {
            if (veto && (effectiveTier() ?? currentRunFrame()?.inference?.tier) === 'anthropic') {
              recordShadowAbstained(tool, callId, 'anthropic-veto')
            } else {
              try {
                shadows.push({
                  state: renderEgressState(
                    {
                      tool: call.name,
                      hosts,
                      spans,
                      latestUserMessage: latestUser,
                      lines: request.lines,
                    },
                    { drawNonce: process.env.VITEST ? testNonceSource : undefined },
                  ),
                  tool,
                  callId,
                })
              } catch {
                recordShadowAbstained(tool, callId, 'unaskable')
              }
            }
          }
          if (veto) return block('name-match', EGRESS_TEXTS.roster)
          if (detector.decide !== 'on') return undefined

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
            return unavailable()
          }
          const answer = await askEgress(state)
          if (answer.kind !== 'answered') {
            if (answer.kind === 'timeout') degraded.timeouts++
            else degraded.failures++
            return unavailable()
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
            return { kind: 'batch-pass' }
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

      const egressCheck = async (call: {
        name: string
        args: Readonly<Record<string, unknown>>
      }): Promise<EgressVerdict> => {
        try {
          if (isLocal(call.name)) return undefined
          return await check(call)
        } catch (error) {
          if (!(error instanceof EgressLiveEmissionError && error.eventType === 'egress_blocked')) {
            record('egress_blocked', {
              tool: egressToolLabel(call.name),
              route: currentRunFrame()?.route ?? NO_ROUTE,
              rule: 'check-failed',
            } satisfies EgressBlockedEventData)
          }
          throw new Error('egress check failed')
        }
      }

      const observe = async (
        call: { readonly name: string },
        result: ToolCallResult,
      ): Promise<undefined> => {
        // Data only: an error string can quote the arguments that caused it.
        if (givesAddresses(call.name)) for (const text of stringsOf(result.data)) give(text)
        if (!rosterLoad && isLocal(call.name)) {
          pendingLocalResults.push(result.data)
          return undefined
        }
        if (rosterLoad) await rosterLoad
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
        // Transport has already finished; measurement cannot hold an outgoing call.
        const deadline = Date.now() + timeoutMs
        while (shadows.length > 0) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) break
          const next = shadows.shift()!
          try {
            await askEgress(next.state, next, remaining)
          } catch {
            recordShadowAbstained(next.tool, next.callId, 'failed')
          }
        }
        for (const pending of shadows) recordShadowAbstained(pending.tool, pending.callId, 'queued')
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
