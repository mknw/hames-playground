/**
 * Chain Pattern
 *
 * Composes multiple patterns into a single sequence.
 */

import { assertServerOnImport } from '../assert.server'
import { activeRunFrame } from '../run-frame.server'
import type {
  UnifiedContext,
  ContextEvent,
  ConfiguredPattern,
  PatternConfig,
  ErrorEventData,
} from '../types'
import {
  createScope,
  commitEvents,
  enterPattern,
  exitPattern,
  resolveConfig,
  setError,
  createEvent,
  dropHitl,
} from '../context.server'
import {
  commitHitlBuffer,
  hitlHalt,
  hitlPending,
  positionHitlRun,
  unattendedStopMessage,
  withHitlRun,
  type HitlRun,
} from '../hitl.server'
import { setLivePatternEnabled, wasEmittedLive } from '../live-event-context.server'
import { createEventView } from './event-view.server'

assertServerOnImport()

/**
 * Execute configured patterns in sequence with proper scope lifecycle.
 *
 * For each pattern:
 * 1. Creates isolated PatternScope
 * 2. Creates EventView based on pattern's viewConfig
 * 3. Adds pattern_enter event
 * 4. Executes pattern function
 * 5. Commits events based on commitStrategy
 * 6. Stops the chain if that pattern reported an irrecoverable error
 * 7. Adds pattern_exit event
 * 8. Passes data forward
 *
 * PAUSES FOR A PERSON, but only in the chain that OWNS a HITL run (#433, F7):
 * the `runChain` that finds the frame's `hitl` slot set and no HITL run open
 * in its async context opens one, in a store of its own rather than on the
 * frame (#477 F1, F2). After every pattern, one that threw included, it
 * commits the run's buffer of HITL events straight into `ctx.events` (never
 * through the scope filter,
 * which drops every HITL event). Then, unless the pattern failed (`error`
 * wins, m2), a request still waiting ends the run `paused` WITHOUT forwarding
 * the paused pattern's data — re-entry starts from the data it started from
 * the first time, so no pattern has to be safe to re-run over its own
 * half-written state (F10) — and an unattended choice that stops the run ends
 * it `done`. A `runChain` nested inside one of the owner's patterns neither
 * commits nor pauses: the owner does, at its own boundary.
 *
 * REFUSES OUTSIDE A RUN FRAME. This is where "no frame, no run" (ruling D3,
 * issue #374) is enforced, and it is one line because there is now one frame
 * rather than five stores: a chain that starts without one would run with no
 * injection guard, the library's budgets instead of the host's, no live
 * emission and whatever tier the inference layer defaults to — four silent
 * degradations, none of which errors, which is the failure class #373
 * documented ("present, reported green, and neutralized nothing"). The three
 * harness entry points open the frame themselves, so a consumer using them
 * never meets this; a host driving `runChain` directly opens `withRunFrame({})`.
 *
 * The check is HERE rather than in `callTool` or `activeTransports` on purpose.
 * Those are asked the same questions outside a run — a gateway health probe, a
 * prompt builder sizing a tool surface — where the answer is legitimate and
 * unchanged. A RUN is the thing that must not happen frameless.
 *
 * `opts.startAt` is where a RESUME re-enters (#433 S3): the patterns before it
 * are skipped — their events are already in `ctx.events` and their data in
 * `ctx.data`, which at a pause holds the paused pattern's INPUT (F10) — and
 * the paused top-level pattern runs again from its own beginning. A gate it
 * reaches again replays the answer from the run's journal instead of asking.
 * An index outside the chain throws: a resume checks the chain first
 * (`chain-changed`), so only a direct caller can get here with one.
 *
 * @param ctx - UnifiedContext to execute in
 * @param patterns - ConfiguredPatterns to execute in sequence
 * @param onEvent - called for each newly committed event
 * @param opts - `startAt`: the top-level index to start from (default 0)
 * @returns Updated UnifiedContext
 *
 * @example
 * const agent = harness(neo4jLoop, webLoop, synth)
 * // harness uses runChain internally
 */
export async function runChain<T extends Record<string, unknown>>(
  ctx: UnifiedContext<T>,
  patterns: ConfiguredPattern<T>[],
  onEvent?: (event: ContextEvent) => void,
  opts?: { readonly startAt?: number },
): Promise<UnifiedContext<T>> {
  activeRunFrame()

  const startAt = opts?.startAt ?? 0
  if (!Number.isInteger(startAt) || startAt < 0 || (startAt > 0 && startAt >= patterns.length)) {
    throw new RangeError(`runChain: startAt ${startAt} is not a top-level index of this chain`)
  }

  if (patterns.length === 0) {
    return ctx
  }

  // `hitl` is undefined unless THIS chain owns a HITL run (#433, F7; #477).
  return withHitlRun(ctx, (hitl) => runPatterns(ctx, patterns, onEvent, hitl, startAt))
}

/** The body of {@link runChain}, inside the HITL run it owns (if any). */
async function runPatterns<T extends Record<string, unknown>>(
  ctx: UnifiedContext<T>,
  patterns: ConfiguredPattern<T>[],
  onEvent: ((event: ContextEvent) => void) | undefined,
  hitl: HitlRun | undefined,
  startAt: number,
): Promise<UnifiedContext<T>> {
  const names = patterns.map((p) => p.name)

  try {
    let currentData = ctx.data

    for (let i = startAt; i < patterns.length; i++) {
      const pattern = patterns[i]

      // Stop if status changed from running
      if (ctx.status !== 'running') {
        break
      }

      const patternId = pattern.config.patternId!
      const liveEnabled = pattern.config.liveEvents === true

      // Toggle live emission for this pattern's lifecycle (incl. enter/exit).
      // Inner patterns invoked by wrappers inherit this flag automatically.
      setLivePatternEnabled(liveEnabled)

      // Where a request raised by this pattern will say to resume (m4).
      if (hitl) positionHitlRun(hitl, i, names, patternId)

      // 1. Create isolated scope for this pattern
      const scope = createScope<T>(patternId, currentData)

      // 2. Create view based on pattern's viewConfig (exclude self from fromLastPattern)
      const view = createEventView(ctx, pattern.config.viewConfig, patternId)

      // 3. Add pattern_enter event (fires live if enabled).
      //    Surface known config fields (maxTurns) for UI progress tracking.
      const cfg = pattern.config as PatternConfig & { maxTurns?: number }
      enterPattern(
        ctx,
        patternId,
        pattern.name,
        cfg.maxTurns !== undefined ? { maxTurns: cfg.maxTurns } : undefined,
      )

      try {
        // 4. Execute pattern
        const result = await pattern.fn(scope, view)

        // 5. Commit events based on strategy
        const beforeLen = ctx.events.length
        commitEvents(ctx, result, pattern.config.commitStrategy!)
        // 5a. Then the HITL events the pattern raised — from the run's buffer,
        //     straight in, so no strategy can drop the record of a question,
        //     and checked against where THIS loop is (#433).
        if (hitl) commitHitlBuffer(hitl, ctx, i, names)

        // 5b. Emit newly committed events via callback, skipping any that
        //     were already delivered live (dedup by event id).
        if (onEvent) {
          for (let j = beforeLen; j < ctx.events.length; j++) {
            const ev = ctx.events[j]
            if (!wasEmittedLive(ev)) onEvent(ev)
          }
        }

        // 5c. Stop the chain if this pattern reported a failure it cannot come
        //     back from (#273 D-d). Everything before this read `errorSeverity`
        //     for presentation only, so an irrecoverable error was recorded and
        //     then run past: the next pattern ran on a missing result and the
        //     synthesizer at the end of the chain answered anyway, from a hole.
        const fatal = firstIrrecoverable(ctx, beforeLen, pattern.config.errorSeverity!)
        if (fatal) {
          // NOT `setError()`: the pattern already emitted the `error` event
          // carrying its LLM-call detail, and setError would push a second one
          // — a doubled error bubble in the transcript and in every replay of
          // it (same reasoning as `settleTurn` in harness.server.ts). Only the
          // status and the message are set; the loop's own guard at the top
          // sees `status !== 'running'` and stops, after this pattern's
          // `pattern_exit` below has landed.
          ctx.status = 'error'
          ctx.error = fatal
        }

        // 5d. End the run for a person (#433). Only while it is still running:
        //     an irrecoverable error above wins (m2), and the next turn
        //     supersedes the request.
        const halt = hitl && ctx.status === 'running' ? hitlHalt(hitl) : undefined
        if (halt && 'pause' in halt) {
          // Paused: the pattern's EVENTS are committed, its DATA is not (F10).
          ctx.status = 'paused'
        } else if (halt) {
          // An unattended rule chose to stop: nothing is re-entered.
          ctx.status = 'done'
          currentData = { ...result.data, response: unattendedStopMessage(halt.stop) } as T
        } else {
          // 6. Pass data forward
          currentData = result.data
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // A pattern that asked and then threw still asked: the request is
        // recorded, and `error` wins (m2).
        if (hitl) commitHitlBuffer(hitl, ctx, i, names)
        setError(ctx, msg, patternId)
      }

      // 7. Add pattern_exit event (fires live if enabled)
      exitPattern(ctx, patternId)

      // Reset the toggle so subsequent patterns without `liveEvents` aren't
      // accidentally streamed.
      setLivePatternEnabled(false)
    }

    // Update final data
    ctx.data = currentData

    return ctx
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    setError(ctx, msg, 'chain')
    return ctx
  }
}

/**
 * The message of the first irrecoverable `error` event this pattern committed,
 * or undefined when it committed none.
 *
 * Severity is read from the EVENT first and from the pattern's resolved
 * `errorSeverity` only as a fallback, because those two answer different
 * questions. The pattern-level value classifies the pattern ("can a simpleLoop
 * self-heal?" — usually yes); the event-level one classifies THIS failure, and
 * a pattern that is recoverable in general can still hit something it cannot
 * come back from (a loop handed a collapsed tool surface, #276). Only the
 * failure knows, so when it says, it wins.
 *
 * It looks at COMMITTED events rather than at the pattern's scope, so the gate
 * and the user see the same thing: an error dropped by `commitStrategy` is not
 * in the transcript, and stopping the chain over a failure with no visible
 * cause would leave the person with an empty turn and no reason for it. That
 * makes `commitStrategy: 'never'` a way to opt a pattern out of the gate, which
 * is the same trade the transcript already makes.
 */
function firstIrrecoverable<T>(
  ctx: UnifiedContext<T>,
  from: number,
  patternSeverity: 'recoverable' | 'irrecoverable',
): string | undefined {
  for (let i = from; i < ctx.events.length; i++) {
    const event = ctx.events[i]
    if (event.type !== 'error') continue
    const data = event.data as ErrorEventData | undefined
    if ((data?.severity ?? patternSeverity) !== 'irrecoverable') continue
    return data?.error || 'Pattern reported an irrecoverable error'
  }
  return undefined
}

/**
 * Compose patterns into a single ConfiguredPattern that runs them in sequence.
 *
 * Unlike `runChain` (which takes a UnifiedContext), `chain` is a pattern factory
 * that returns a ConfiguredPattern. This enables composition inside harness() or
 * within other pattern factories like parallel() and routes().
 *
 * @param patterns - ConfiguredPatterns to execute in sequence
 * @returns A single ConfiguredPattern wrapping all sub-patterns
 *
 * @example
 * // Compose router + routes + synth as a single unit inside parallel/routes
 * const routedAgent = chain(
 *   router({ neo4j: 'DB queries', web: 'Web lookups' }),
 *   routes({ neo4j: neo4jPattern, web: webPattern }),
 *   compactExecution({ mode: 'thread' })
 * )
 */
export function chain<T extends Record<string, unknown>>(
  ...patterns: ConfiguredPattern<T>[]
): ConfiguredPattern<T> {
  const resolved = resolveConfig('chain', {})
  return {
    name: `chain(${patterns.map((p) => p.name).join(', ')})`,
    fn: async (scope, view) => {
      // Run each sub-pattern in a fresh child scope so its events get tagged
      // with its OWN patternId (e.g. 'sandbox-loop'), not the outer
      // composition's auto-generated id. Without this, `view.fromLastPattern()`
      // and `ViewConfig.fromLast: true` silently exclude the sub-pattern's
      // events because they filter on `e.patternId === lastPatternId`.
      //
      // We also build a fresh EventView per sub-pattern with the correct
      // `selfPatternId` and a synthetic context that includes events
      // accumulated by previous sub-patterns in this same chain. Without
      // this, a later sub-pattern's `fromLastPattern()` either sees stale
      // ancestry (no view of its sibling's emit) or — worse — selects its
      // OWN patternId as "last" (because the outer view was constructed
      // for the wrapping pattern, not for the synth). Mirrors `runChain`
      // above (chain.server.ts:60-122) and the single-child wrapper
      // (`with-references`).
      const outerCtx = (view as unknown as { ctx: UnifiedContext }).ctx
      let currentData = scope.data
      for (const pattern of patterns) {
        const subId = pattern.config.patternId ?? pattern.name
        scope.events.push(createEvent('pattern_enter', subId, { pattern: pattern.name }))
        // Synthetic ctx: original events + everything this chain has
        // accumulated so far (including the pattern_enter just pushed).
        // Read-only view — events array is freshly composed each iteration.
        const syntheticCtx: UnifiedContext = {
          ...outerCtx,
          events: [...outerCtx.events, ...scope.events] as ContextEvent[],
        }
        const subView = createEventView(syntheticCtx, pattern.config.viewConfig, subId)
        const childScope = createScope<T>(subId, currentData)
        const result = await pattern.fn(childScope, subView)
        // Drop every hitl_* event HERE, not only at the final commit: the next
        // sub-pattern's view is built from these events, so a forged answer
        // merged now would be read before anything commits (#433, F6).
        scope.events.push(...dropHitl(result.events))
        scope.events.push(createEvent('pattern_exit', subId, { status: 'completed' }))
        currentData = result.data
        // The stop check between children (#433): no sibling runs while a
        // decision is pending. The owning runChain pauses after this pattern.
        if (hitlPending()) break
      }
      scope.data = currentData
      return scope
    },
    config: resolved,
    estimateTurns: (s) => patterns.reduce((sum, p) => sum + (p.estimateTurns?.(s) ?? 1), 0),
    children: patterns,
  }
}

/**
 * Create a ConfiguredPattern from a ScopedPattern function.
 *
 * @param name - Pattern name for tracing
 * @param fn - Scoped pattern function
 * @param config - Pattern configuration
 * @returns ConfiguredPattern ready for chain
 */
export function configurePattern<T extends Record<string, unknown>>(
  name: string,
  fn: ConfiguredPattern<T>['fn'],
  config?: PatternConfig,
): ConfiguredPattern<T> {
  const resolved = resolveConfig(name, config)
  return {
    name,
    fn,
    config: resolved,
  }
}
