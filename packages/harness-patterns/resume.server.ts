/**
 * Resume inside a route (decision-loop-agent.md, slice 6): the runtime half.
 *
 * A pause ends the turn with the paused pattern's events committed. Before this
 * slice a resume re-entered the paused TOP-LEVEL pattern from its start, so a
 * `decisionLoop` began with no records and a `simpleLoop` with an empty turn
 * log: the run did not continue, it started again. Now each pattern on the path
 * from the top-level pattern to the gate declares itself resumable
 * (`capabilities.resumable`), and:
 *
 * - **While it runs**, it appends its segment to the run frame's
 *   `continuation` ({@link onPath}); `askHuman` records the path on the request.
 * - **Before any side effect of a resume**, `checkResume` follows the recorded
 *   path through the current composition (`followContinuation`,
 *   `pattern-capabilities.ts`): a changed, removed or non-resumable step is
 *   `chain-changed`, and no `resolve` runs.
 * - **On re-entry**, `runChain` hands the top-level pattern the path and the
 *   events its paused invocation recorded (the run frame's `resume` slot). Each
 *   pattern takes its own segment ({@link takeResume}), rebuilds its state from
 *   those events without calling a model, and hands the rest of the path to the
 *   child it paused in. Every other child runs with no resume at all.
 *
 * A pattern keeps its normal view on re-entry. Its pre-pause events reach it
 * as the replay, so the readers that would count them twice — a resumed route's
 * own view, a loop's prior-results window — leave them out; readers that must
 * see them (the egress gate's tripwire count, its roster) still do.
 */
import { createHash } from 'node:crypto'
import { assertServerOnImport } from './assert.server'
import { amendRunFrame, currentRunFrame, type ResumeSlot } from './run-frame.server'
import type {
  ConfiguredPattern,
  ContextEvent,
  ContinuationSegment,
  PatternEnterEventData,
  ResumableCapability,
} from './types'

assertServerOnImport()

/** sha256 over a pattern's kind, its `patternId` and the configuration its
 *  replay depends on, as canonical JSON. */
export function resumableFingerprint(
  kind: string,
  patternId: string | undefined,
  config: unknown = null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, patternId ?? null, config]))
    .digest('hex')
}

/** The capability of a single-child wrapper that holds no replay state: its
 *  fingerprint is its kind and id, and its inner pattern is the next step. */
export function wrapperResumable(kind: string, inner: ConfiguredPattern<any>): ResumableCapability {
  return {
    fingerprint: resumableFingerprint(kind, inner.config.patternId),
    next: () => inner,
  }
}

/** What a resumable pattern receives when the run re-enters a pause through it. */
export interface TakenResume {
  /** Its own recorded segment (a `decisionLoop`'s carries the route and iteration). */
  readonly segment: ContinuationSegment
  /** The events its paused invocation recorded, outcomes substituted. */
  readonly events: readonly ContextEvent[]
  /** The path below it. */
  readonly rest: readonly ContinuationSegment[]
}

/** The resume meant for the pattern with this fingerprint, or undefined when
 *  this invocation is not re-entering a pause. */
export function takeResume(fingerprint: string): TakenResume | undefined {
  const slot = currentRunFrame()?.resume
  const head = slot?.continuation[0]
  if (!slot || !head || head.fingerprint !== fingerprint) return undefined
  return { segment: head, events: slot.events, rest: slot.continuation.slice(1) }
}

/** The slot a child on the resumed path is handed: the rest of the path, and
 *  the same events (each pattern reads its own out of them). */
export function childResume(taken: TakenResume | undefined): ResumeSlot | undefined {
  return taken && taken.rest.length > 0
    ? { continuation: taken.rest, events: taken.events }
    : undefined
}

/**
 * Run `fn` as one step of the path: `segment` joins the continuation a request
 * raised below records, and the code below sees `resume` (or none at all).
 * Outside a run frame `fn` runs plain: a pattern driven directly cannot pause.
 */
export function onPath<T>(
  segment: ContinuationSegment,
  resume: ResumeSlot | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const frame = currentRunFrame()
  if (!frame) return fn()
  return amendRunFrame(
    { continuation: [...frame.continuation, segment], resume: resume ?? null },
    fn,
  )
}

/** A stateless wrapper's whole share of the mechanism: take its resume, and
 *  run its inner pattern as the next step of the path. */
export function resumableStep<T>(
  kind: string,
  capability: ResumableCapability,
  fn: () => Promise<T>,
): Promise<T> {
  const taken = takeResume(capability.fingerprint)
  return onPath({ pattern: kind, fingerprint: capability.fingerprint }, childResume(taken), fn)
}

/**
 * The contents of every bracket `isOwn` accepts, in order: the events between
 * a `pattern_enter` and the `pattern_exit` that closes it. A bracket can nest
 * one under the SAME `patternId` (a `decisionLoop` route and the
 * `withReferences` inside it both bracket under the route's id), so brackets
 * of the open id are counted, not matched by the first exit.
 */
export function bracketContents(
  events: readonly ContextEvent[],
  isOwn: (enter: ContextEvent & { data: PatternEnterEventData }) => boolean,
): ContextEvent[] {
  const contents: ContextEvent[] = []
  let open: string | undefined
  let depth = 0
  for (const e of events) {
    if (open === undefined) {
      if (
        e.type === 'pattern_enter' &&
        isOwn(e as ContextEvent & { data: PatternEnterEventData })
      ) {
        open = e.patternId
        depth = 1
      }
      continue
    }
    if (e.patternId === open && e.type === 'pattern_enter') depth++
    if (e.patternId === open && e.type === 'pattern_exit' && --depth === 0) {
      open = undefined
      continue
    }
    contents.push(e)
  }
  return contents
}

/** The events of the current run: everything after the last `user_message`. */
export function currentRunEvents(events: readonly ContextEvent[]): readonly ContextEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') return events.slice(i + 1)
  }
  return events
}
