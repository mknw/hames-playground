/**
 * useChainProgress — derives a progress view from a stream of harness
 * `ContextEvent`s arriving over SSE.
 *
 * Model
 * -----
 * The harness stamps an upfront `chainTurnEstimate` on the initial
 * `user_message` event (a worst-case projection summed across the chain's
 * top-level patterns — `routes` / `parallel` use the longest branch). This
 * hook reads that as the bar's stable denominator for the whole turn — it
 * is never grown by subsequent events.
 *
 * `currentTurn` advances on:
 *   - `controller_action` (per-turn for loops)
 *   - `assistant_message` from a non-final pattern (router, synthesizer)
 *   - leaf `pattern_exit` (no-op leaf advances)
 *
 * Status text is whatever the latest `controller_action.action.status` /
 * `assistant_message` preview / `tool_call` name reports — `LiveProgressBar`
 * crossfades between consecutive values.
 *
 * On `finish()`, `currentTurn` snaps to `maxProjection` so the bar smoothly
 * fills to 100% even if the chosen route was shorter than the worst case.
 *
 * Fallback path: if `chainTurnEstimate` is missing (older sessions or a
 * pattern without `estimateTurns`), the hook grows `pathProjection` from
 * arriving `pattern_enter` events as it did before.
 *
 * Library boundary: pure UI logic — kept out of `harness-patterns/` so the
 * library can be extracted as a standalone npm package without UI deps.
 */
import { createSignal } from 'solid-js'
import type { ContextEvent } from '~/lib/harness-patterns'

export interface ChainProgressSnapshot {
  currentTurn: number
  /** Bar's stable denominator — set once from `chainTurnEstimate`. */
  maxProjection: number
  /** Same as `maxProjection` once the seed arrives; used as the bar value
   *  scale so the fill rate matches the upfront projection. */
  pathProjection: number
  status: string | null
  done: boolean
}

const empty = (): ChainProgressSnapshot => ({
  currentTurn: 0,
  maxProjection: 0,
  pathProjection: 0,
  status: null,
  done: false,
})

const STATUS_MAX_LENGTH = 140

const truncate = (s: string): string =>
  s.length > STATUS_MAX_LENGTH ? `${s.slice(0, STATUS_MAX_LENGTH - 1)}…` : s

const firstLine = (s: string): string => {
  const idx = s.indexOf('\n')
  return idx === -1 ? s : s.slice(0, idx)
}

export interface ChainProgressController {
  snapshot: () => ChainProgressSnapshot
  ingest: (event: ContextEvent) => void
  finish: () => void
  reset: () => void
}

export function createChainProgress(): ChainProgressController {
  const [snapshot, setSnapshot] = createSignal<ChainProgressSnapshot>(empty())

  // Track which patterns we've already advanced for so a stream of
  // assistant_messages from the same pattern doesn't double-count.
  let advancedForPattern: string | null = null
  // Fallback (no seed): a pending pattern_enter is held until the next event
  // tells us whether it was a wrapper (discard) or leaf (commit).
  let pendingEnter: { contribution: number; patternId: string } | null = null
  let seeded = false

  /** Single-shot snapshot mutator — every ingest path applies one update so
   *  Solid only schedules one downstream re-run per event. */
  const update = (
    fn: (prev: ChainProgressSnapshot) => Partial<ChainProgressSnapshot>
  ) => setSnapshot((prev) => ({ ...prev, ...fn(prev) }))

  /** Compute pathProjection delta from a flushed pending enter (fallback path). */
  const flushPending = (
    prev: ChainProgressSnapshot
  ): { pathProjection: number } | null => {
    if (seeded || !pendingEnter) {
      pendingEnter = null
      return null
    }
    const contrib = pendingEnter.contribution
    pendingEnter = null
    return { pathProjection: prev.pathProjection + contrib }
  }

  return {
    snapshot,

    reset() {
      advancedForPattern = null
      pendingEnter = null
      seeded = false
      setSnapshot(empty())
    },

    finish() {
      update((prev) => {
        const flushed = flushPending(prev)
        return {
          ...(flushed ?? {}),
          // Snap current to maxProjection so the bar fills to 100% smoothly.
          currentTurn: prev.maxProjection || (flushed?.pathProjection ?? prev.pathProjection),
          done: true,
        }
      })
    },

    ingest(event) {
      switch (event.type) {
        case 'user_message': {
          const data = event.data as { chainTurnEstimate?: number }
          const est = data.chainTurnEstimate
          if (typeof est === 'number' && est > 0) {
            seeded = true
            update(() => ({ maxProjection: est, pathProjection: est }))
          }
          break
        }

        case 'pattern_enter': {
          if (seeded) break
          const data = event.data as { pattern?: string; maxTurns?: number }
          const contribution =
            typeof data.maxTurns === 'number' && data.maxTurns > 0 ? data.maxTurns : 1
          // Fallback path: replace any pending enter — wrappers
          // (routes, guardrail) emit an enter immediately followed by
          // their child's, and the child's contribution should win.
          pendingEnter = { contribution, patternId: event.patternId }
          advancedForPattern = null
          break
        }

        case 'controller_action': {
          const data = event.data as {
            action?: { status?: string }
            maxTurns?: number
          }
          const status = data.action?.status ? truncate(data.action.status) : null
          update((prev) => {
            const flushed = flushPending(prev)
            const path = flushed?.pathProjection ?? prev.pathProjection
            return {
              currentTurn: Math.min(prev.currentTurn + 1, prev.maxProjection || path),
              pathProjection: path,
              status: status ?? prev.status,
            }
          })
          advancedForPattern = event.patternId
          break
        }

        case 'assistant_message': {
          const content = (event.data as { content?: string }).content ?? ''
          const preview = truncate(firstLine(content.trim()))
          if (advancedForPattern !== event.patternId) {
            update((prev) => {
              const flushed = flushPending(prev)
              const path = flushed?.pathProjection ?? prev.pathProjection
              return {
                currentTurn: Math.min(prev.currentTurn + 1, prev.maxProjection || path),
                pathProjection: path,
                status: preview || prev.status,
              }
            })
            advancedForPattern = event.patternId
          } else if (preview) {
            update(() => ({ status: preview }))
          }
          break
        }

        case 'tool_call': {
          const tool = (event.data as { tool?: string }).tool ?? 'tool'
          update((prev) => {
            const flushed = flushPending(prev)
            return {
              ...(flushed ?? {}),
              status: `Calling ${tool}…`,
            }
          })
          break
        }

        case 'pattern_exit': {
          if (!seeded && pendingEnter && pendingEnter.patternId === event.patternId) {
            update((prev) => {
              const flushed = flushPending(prev)
              const path = flushed?.pathProjection ?? prev.pathProjection
              return {
                currentTurn: Math.min(prev.currentTurn + 1, prev.maxProjection || path),
                pathProjection: path,
              }
            })
          }
          break
        }

        case 'error': {
          const err = (event.data as { error?: string }).error ?? 'error'
          update((prev) => {
            const flushed = flushPending(prev)
            return {
              ...(flushed ?? {}),
              status: truncate(err),
            }
          })
          break
        }

        default:
          break
      }
    },
  }
}
