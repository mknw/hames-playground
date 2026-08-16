/**
 * useChainProgress tests — verifies the seeded-projection model.
 *
 *  - `user_message.chainTurnEstimate` seeds maxProjection / pathProjection
 *    once and never grows the seed.
 *  - currentTurn advances on controller_action, assistant_message, and leaf
 *    pattern_exit.
 *  - finish() snaps currentTurn to maxProjection (smooth fill to 100%).
 *  - Without a seed, the legacy pending+flush+wrapper-discard heuristic
 *    grows pathProjection from arriving pattern_enter events.
 */

import { describe, it, expect } from 'vitest'
import { createRoot } from 'solid-js'
import { createChainProgress } from '../../../components/ark-ui/useChainProgress'
import type { ContextEvent } from '~/lib/harness-patterns'

const ev = (
  type: ContextEvent['type'],
  patternId: string,
  data: unknown = {},
  id?: string,
): ContextEvent => ({
  id: id ?? `ev-${Math.random().toString(36).slice(2, 7)}`,
  type,
  ts: Date.now(),
  patternId,
  data,
})

describe('createChainProgress', () => {
  it('starts empty', () => {
    createRoot(() => {
      const p = createChainProgress()
      expect(p.snapshot()).toEqual({
        currentTurn: 0,
        maxProjection: 0,
        pathProjection: 0,
        status: null,
        done: false,
      })
    })
  })

  it('seeds projections from user_message.chainTurnEstimate and never grows them', () => {
    createRoot(() => {
      const p = createChainProgress()
      p.ingest(ev('user_message', 'harness', { content: 'hi', chainTurnEstimate: 7 }))
      expect(p.snapshot().maxProjection).toBe(7)
      expect(p.snapshot().pathProjection).toBe(7)

      // Subsequent pattern_enters and content events do NOT inflate the seed
      p.ingest(ev('pattern_enter', 'router', { pattern: 'router' }))
      p.ingest(ev('assistant_message', 'router', { content: 'Routing…' }))
      p.ingest(ev('pattern_enter', 'routes', { pattern: 'routes' }))
      p.ingest(ev('pattern_enter', 'inner', { pattern: 'simpleLoop' }))
      p.ingest(
        ev('controller_action', 'inner', {
          action: { status: 's' },
          turn: 0,
          maxTurns: 5,
        }),
      )
      expect(p.snapshot().maxProjection).toBe(7)
      expect(p.snapshot().pathProjection).toBe(7)
    })
  })

  it('default-agent stream: 1/7 → 7/7, current advances per event', () => {
    createRoot(() => {
      const p = createChainProgress()
      p.ingest(ev('user_message', 'harness', { content: 'hi', chainTurnEstimate: 7 }))

      // 1) router
      p.ingest(ev('pattern_enter', 'router', { pattern: 'router' }))
      p.ingest(ev('assistant_message', 'router', { content: 'Routing to neo4j…' }))
      expect(p.snapshot().currentTurn).toBe(1)
      expect(p.snapshot().status).toBe('Routing to neo4j…')

      p.ingest(ev('pattern_exit', 'router'))

      // 2) routes(neo4j-query, ...) — wrapper events still arrive but seeded mode ignores them
      p.ingest(ev('pattern_enter', 'routes', { pattern: 'routes(...)' }))
      p.ingest(ev('pattern_enter', 'neo4j-query', { pattern: 'simpleLoop' }))

      for (let i = 0; i < 5; i++) {
        p.ingest(
          ev('controller_action', 'neo4j-query', {
            action: { status: `Step ${i + 1}` },
            turn: i,
            maxTurns: 5,
          }),
        )
      }
      // 1 (router) + 5 (loop) = 6
      expect(p.snapshot().currentTurn).toBe(6)
      expect(p.snapshot().status).toBe('Step 5')

      p.ingest(ev('pattern_exit', 'neo4j-query'))
      p.ingest(ev('pattern_exit', 'routes'))

      // 3) synthesizer
      p.ingest(ev('pattern_enter', 'response-synth', { pattern: 'synthesizer' }))
      p.ingest(ev('assistant_message', 'response-synth', { content: 'Done.' }))
      expect(p.snapshot().currentTurn).toBe(7)
      expect(p.snapshot().maxProjection).toBe(7)
    })
  })

  it('finish() snaps currentTurn up to maxProjection so the bar reaches 100%', () => {
    createRoot(() => {
      const p = createChainProgress()
      p.ingest(ev('user_message', 'harness', { content: 'hi', chainTurnEstimate: 7 }))

      // Short conversational chain — only router fires before completion
      p.ingest(ev('pattern_enter', 'router', { pattern: 'router' }))
      p.ingest(ev('assistant_message', 'router', { content: 'Hi there.' }))
      expect(p.snapshot().currentTurn).toBe(1)

      p.finish()
      expect(p.snapshot().done).toBe(true)
      expect(p.snapshot().currentTurn).toBe(7)
    })
  })

  it('does not double-advance on repeated assistant_messages from same pattern', () => {
    createRoot(() => {
      const p = createChainProgress()
      p.ingest(ev('user_message', 'harness', { content: 'hi', chainTurnEstimate: 3 }))
      p.ingest(ev('pattern_enter', 'router', { pattern: 'router' }))
      p.ingest(ev('assistant_message', 'router', { content: 'first' }))
      p.ingest(ev('assistant_message', 'router', { content: 'second' }))
      expect(p.snapshot().currentTurn).toBe(1)
      expect(p.snapshot().status).toBe('second')
    })
  })

  it('general-agent stream: plan_created advances the bar to its own estimate', () => {
    createRoot(() => {
      const p = createChainProgress()
      // planner(1) + simpleLoop(8) + synth(1) — the planner emits neither a
      // controller_action nor an assistant_message, so without a plan_created
      // advance the bar can only ever reach 9 of its own 10.
      p.ingest(ev('user_message', 'harness', { content: 'hi', chainTurnEstimate: 10 }))

      p.ingest(ev('pattern_enter', 'plan', { pattern: 'planner' }))
      p.ingest(ev('plan_created', 'plan', { plan: { plan: '1. Look.', n_steps: 1 }, toolCount: 4 }))
      expect(p.snapshot().currentTurn).toBe(1)

      p.ingest(ev('pattern_enter', 'execute', { pattern: 'simpleLoop', maxTurns: 8 }))
      for (let i = 0; i < 8; i++) {
        p.ingest(
          ev('controller_action', 'execute', { action: { status: `turn ${i}` }, maxTurns: 8 }),
        )
      }
      p.ingest(ev('assistant_message', 'response-synth', { content: 'Here you go.' }))

      expect(p.snapshot().currentTurn).toBe(10)
      expect(p.snapshot().maxProjection).toBe(10)
    })
  })

  it('advances once per planner, even if plan_created repeats', () => {
    createRoot(() => {
      const p = createChainProgress()
      p.ingest(ev('user_message', 'harness', { content: 'hi', chainTurnEstimate: 4 }))
      p.ingest(ev('plan_created', 'plan', { plan: { plan: '1. Look.', n_steps: 1 }, toolCount: 4 }))
      p.ingest(ev('plan_created', 'plan', { plan: { plan: '1. Look.', n_steps: 1 }, toolCount: 4 }))
      expect(p.snapshot().currentTurn).toBe(1)
    })
  })

  it('advances on a skipped plan too — the pattern still ran', () => {
    createRoot(() => {
      const p = createChainProgress()
      p.ingest(ev('user_message', 'harness', { content: 'hi', chainTurnEstimate: 4 }))
      p.ingest(ev('plan_created', 'plan', { toolCount: 4, skipped: 'no-message' }))
      expect(p.snapshot().currentTurn).toBe(1)
      // Nothing was planned, so nothing to announce.
      expect(p.snapshot().status).toBeNull()
    })
  })

  it('reset clears all state', () => {
    createRoot(() => {
      const p = createChainProgress()
      p.ingest(ev('user_message', 'harness', { content: 'hi', chainTurnEstimate: 5 }))
      p.ingest(ev('assistant_message', 'router', { content: 'hi' }))
      expect(p.snapshot().currentTurn).toBe(1)
      p.reset()
      expect(p.snapshot()).toEqual({
        currentTurn: 0,
        maxProjection: 0,
        pathProjection: 0,
        status: null,
        done: false,
      })
    })
  })

  describe('per-session isolation (#47)', () => {
    it('two controllers ingest independently — switching active session does not bleed state', () => {
      createRoot(() => {
        // Models the route-level registry: one controller per sessionId.
        // Streaming events for session A must not affect session B's bar.
        const a = createChainProgress()
        const b = createChainProgress()

        a.ingest(ev('user_message', 'harness', { content: 'A', chainTurnEstimate: 5 }))
        a.ingest(ev('pattern_enter', 'a-loop', { pattern: 'simpleLoop', maxTurns: 5 }))
        a.ingest(
          ev('controller_action', 'a-loop', {
            action: { status: 'a step 1' },
            turn: 0,
            maxTurns: 5,
          }),
        )
        a.ingest(
          ev('controller_action', 'a-loop', {
            action: { status: 'a step 2' },
            turn: 1,
            maxTurns: 5,
          }),
        )

        // B receives nothing — it's idle.
        expect(b.snapshot()).toEqual({
          currentTurn: 0,
          maxProjection: 0,
          pathProjection: 0,
          status: null,
          done: false,
        })

        // A has advanced and carries its own status.
        expect(a.snapshot().currentTurn).toBe(2)
        expect(a.snapshot().maxProjection).toBe(5)
        expect(a.snapshot().status).toBe('a step 2')

        // Now B starts its own run — A's still-in-flight state is untouched.
        b.ingest(ev('user_message', 'harness', { content: 'B', chainTurnEstimate: 2 }))
        b.ingest(
          ev('controller_action', 'b-router', {
            action: { status: 'b step 1' },
            turn: 0,
            maxTurns: 2,
          }),
        )
        expect(b.snapshot().status).toBe('b step 1')
        expect(a.snapshot().status).toBe('a step 2')
        expect(a.snapshot().currentTurn).toBe(2)
      })
    })
  })

  describe('fallback (no seed)', () => {
    it('grows pathProjection from pattern_enter events', () => {
      createRoot(() => {
        const p = createChainProgress()
        // No user_message → no seed, fallback path is used
        p.ingest(ev('pattern_enter', 'router', { pattern: 'router' }))
        p.ingest(ev('assistant_message', 'router', { content: 'hi' }))
        expect(p.snapshot().pathProjection).toBe(1)
        expect(p.snapshot().currentTurn).toBe(1)
      })
    })

    it('discards a wrapper pattern_enter immediately followed by a child enter', () => {
      createRoot(() => {
        const p = createChainProgress()
        p.ingest(ev('pattern_enter', 'wrapper', { pattern: 'guardrail' }))
        p.ingest(ev('pattern_enter', 'inner', { pattern: 'simpleLoop', maxTurns: 3 }))
        p.ingest(
          ev('controller_action', 'inner', { action: { status: 's' }, turn: 0, maxTurns: 3 }),
        )
        // Wrapper discarded; only inner's 3 contributes
        expect(p.snapshot().pathProjection).toBe(3)
        expect(p.snapshot().currentTurn).toBe(1)
      })
    })
  })
})
