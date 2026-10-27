/** G14's input half (K5): a web route reads rewritten copies, never a stored
 *  table or a reverse mapping. The host supplies the roster policy; core owns
 *  the scope. What LEAVES is not this wrapper's: every outgoing call is judged by
 *  `withEgressGate` (boundary guards, slice 4), which took this wrapper's
 *  outgoing check and its refusal of web calls. */
import { assertServerOnImport } from '../assert.server'
import { trackEvent } from '../context.server'
import { currentRunFrame, effectiveTier } from '../run-frame.server'
import { resumableStep, wrapperResumable } from '../resume.server'
import type {
  ConfiguredPattern,
  EventView,
  PatternScope,
  UnifiedContext,
  UserMessageEventData,
  WarningEventData,
} from '../types'
import type { PlannerData } from './planner.server'
import { createEventView } from './event-view.server'

assertServerOnImport()

/** Internal child-data channel, never rendered by an adapter. decisionLoop
 *  attaches it only when the subtree declares pseudonymisedInputs. */
export const WEB_ROSTER_INPUT = 'webRosterInput'
export interface WebRosterInput {
  readonly payloads: readonly unknown[]
  /** Code-built route/status/stats lines, with no result bodies. */
  readonly steps: string
}

/** One invocation's host-built substitution, with no table exposed to core. */
export interface WebPseudonymisation {
  apply<T>(value: T): T
  /** Withhold only residual string bodies, retaining provenance fences. */
  redact<T>(value: T): T
  /** The roster's literal predicate over any value: feedback when a residual
   *  identity remains, without rejecting the host's own placeholders. */
  checkLiterals(value: unknown): string | void
}

export type PseudonymiseForWeb = (
  payloads: readonly unknown[],
  latestUserMessage: string,
) => Promise<WebPseudonymisation>

/** Why the host's roster could not be built, as far as the host knows it. */
export type RosterUnavailableReason = 'directory-empty' | 'directory-unreadable' | 'roster-damaged'

/** Why the privacy filter was unavailable, as the `web_privacy` warning's
 *  `detail.reason` names it: no `pseudonymise` supplied, a host
 *  {@link RosterUnavailable}, or any other failure. */
export type WebPrivacyUnavailableReason =
  'not-configured' | RosterUnavailableReason | 'filter-failed'

/**
 * What a host's `pseudonymise` (or roster source) throws when it knows WHY the
 * roster cannot be built. The wrapper keeps only `reason`, and only when it is
 * one of the three; it never reads the message or the name of any error.
 */
export class RosterUnavailable extends Error {
  readonly reason: RosterUnavailableReason
  constructor(reason: RosterUnavailableReason) {
    super(`the roster is unavailable: ${reason}`)
    this.name = 'RosterUnavailable'
    this.reason = reason
  }
}

const ROSTER_REASONS: ReadonlySet<string> = new Set([
  'directory-empty',
  'directory-unreadable',
  'roster-damaged',
] satisfies RosterUnavailableReason[])

export function withPseudonymisedInputs(config: { pseudonymise?: PseudonymiseForWeb }) {
  return <T extends PlannerData & Record<string, unknown>>(
    pattern: ConfiguredPattern<T>,
  ): ConfiguredPattern<T> => {
    // Its roster and its rewrite are rebuilt each invocation from the view and
    // the child data the loop reproduces, so a resume passes straight through
    // it (slice 6).
    const resumable = wrapperResumable('withPseudonymisedInputs', pattern)
    return {
      ...pattern,
      children: [pattern],
      capabilities: { ...pattern.capabilities, pseudonymisedInputs: true, resumable },
      fn: (scope, view) =>
        resumableStep('withPseudonymisedInputs', resumable, () => filtered(scope, view)),
    }
    async function filtered(scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> {
      const ctx = (view as unknown as { ctx: UnifiedContext }).ctx
      const latestUser = ctx.events.findLast((e) => e.type === 'user_message')
      const input = scope.data[WEB_ROSTER_INPUT] as WebRosterInput | undefined
      let rewritten: UnifiedContext | undefined
      let filter: WebPseudonymisation | undefined
      let reason: WebPrivacyUnavailableReason = 'not-configured'
      // The ONE tier rule: the registered tier module's answer (an absent or
      // empty frame tier is the host's default, a present but unrecognised one is
      // the self-deployed tier, refused when unreachable; routing reads the same); the
      // raw slot only when core runs with no tier interpreter registered.
      const explicitAnthropic =
        (effectiveTier() ?? currentRunFrame()?.inference?.tier) === 'anthropic'
      try {
        if (!explicitAnthropic && config.pseudonymise) {
          filter = await config.pseudonymise(
            [
              ...ctx.events.filter((e) => e.type === 'tool_result').map((e) => e.data),
              ...(input?.payloads ?? []),
            ],
            latestUser ? (latestUser.data as UserMessageEventData).content : '',
          )
          const visible = view.get()
          const visibleRefs = new Set(visible)
          const visibleIds = new Set(visible.flatMap((e) => (e.id ? [e.id] : [])))
          const rewrite = <V>(value: V): V => {
            const copy = filter!.apply(value)
            return filter!.redact(copy)
          }
          // Rewrite the backing context, not just the configured view: both
          // fromAll() and unfiltered() expansion must see the same copies.
          rewritten = {
            ...ctx,
            events: ctx.events
              .filter(
                (e) =>
                  e === latestUser ||
                  visibleRefs.has(e) ||
                  (e.id !== undefined && visibleIds.has(e.id)),
              )
              .map((e) => (e === latestUser ? e : { ...e, data: rewrite(e.data) })),
          }
          const data = { ...scope.data }
          delete data[WEB_ROSTER_INPUT]
          scope.data = rewrite(data)
        }
      } catch (error) {
        // A host error can contain identity literals. Only the fixed warning
        // below is recorded, with a reason from a fixed set: no exception text
        // (message or name) reaches a model or the store.
        filter = undefined
        rewritten = undefined
        reason =
          error instanceof RosterUnavailable && ROSTER_REASONS.has(error.reason)
            ? error.reason
            : 'filter-failed'
      } finally {
        // Every path, including explicit Anthropic and a throwing host. Never
        // move this after inner dispatch: the payloads may be excluded siblings.
        delete scope.data[WEB_ROSTER_INPUT]
      }
      if (explicitAnthropic) return pattern.fn(scope, view)

      if (!filter || !rewritten) {
        // What the child would have read, counted before it is replaced: the
        // earlier events of its view and its inherited data fields.
        const events = view.get().filter((e) => e !== latestUser).length
        const fields = Object.values(scope.data).filter((v) => v !== undefined).length
        scope.data = { handoff: input?.steps || undefined } as T
        // Withhold earlier content, including summaries and expansion payloads.
        // Calls are NOT refused here: the egress gate judges every outgoing call.
        rewritten = { ...ctx, events: latestUser ? [latestUser] : [] }
        trackEvent(
          scope,
          'warning',
          {
            task: 'web_privacy',
            message: 'earlier results withheld: privacy filter unavailable',
            fallback: 'This step ran without earlier results.',
            detail: { reason, events, fields },
          } satisfies WarningEventData,
          true,
        )
      }
      const childView = createEventView(rewritten, pattern.config.viewConfig, scope.id)
      return pattern.fn(scope, childView)
    }
  }
}
