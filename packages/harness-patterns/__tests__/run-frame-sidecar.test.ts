/**
 * A SIDECAR RUN MUST NOT INHERIT THE MAIN RUN'S LISTENER.
 *
 * The `live` slot is the one slot whose scope is a RUN rather than a turn, and
 * this file is why. A nested harness entry joins the open frame and is handed
 * the enclosing listener — deliberately, because that is what lets a host open
 * its own frame and call `continueSession` bare (see
 * `docs/tutorials/hosting-the-harness.md` §4). The cost is that a host which
 * starts a SECOND run inside the same frame — a title generator, a background
 * summarizer, anything whose contract is that it fails quietly — hands that run
 * a wire straight to the user's transcript.
 *
 * That shipped in PR #382's first head and was caught in review: this repo's
 * app put the SSE writer in the TURN frame, the first-turn title agent ran
 * inside it after `done` and before the stream closed, and a failed title
 * generation — documented as "no retry, no error event" — became an inline
 * error bubble. Measured: the sidecar received `['user_message', 'error']`
 * where `main` received nothing.
 *
 * So the rule is a property of the SLOT, and it is pinned here at the mechanism
 * rather than only at the app's wiring (which `turn.test.ts` pins separately):
 * a listener amended around one run reaches that run and nothing started
 * outside it, while `config` and `inference` — which ARE turn properties —
 * still reach both.
 *
 * MUTATION: move the `live` slot from the `amendRunFrame` back up into the
 * enclosing `withRunFrame` bag (the shape the first head shipped) → the sidecar
 * expectations below go red and the leak is named by event type.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../assert.server', () => ({ assertServerOnImport: vi.fn() }))

import { harness } from '../harness.server'
import { withRunFrame, amendRunFrame } from '../run-frame.server'
import { runtimeConfig } from '../runtime-config.server'
import { currentRunFrame } from '../run-frame.server'
import { DEFAULT_RUNTIME_CONFIG } from '../runtime-config'
import type { ContextEvent, ConfiguredPattern } from '../types'

type Data = { response?: string } & Record<string, unknown>

/** A one-step pattern that emits through the normal commit path. `liveEvents`
 *  is what the app's own loop patterns set, so this is the real emission route
 *  and not a hand-rolled call to `emitLive`. */
function probePattern(onRun?: () => void): ConfiguredPattern<Data> {
  return {
    name: 'probe',
    config: { patternId: 'probe', liveEvents: true },
    fn: async (scope) => {
      onRun?.()
      scope.data = { ...scope.data, response: 'done' }
      return scope
    },
  } as ConfiguredPattern<Data>
}

describe('a run started outside the listener’s scope does not stream', () => {
  it('the main run streams; a sidecar started in the same turn streams nothing', async () => {
    const main: string[] = []
    const listener = (e: ContextEvent) => main.push(e.type)

    let sidecarSaw: ContextEvent[] | 'not-run' = 'not-run'

    await withRunFrame({ config: { ...DEFAULT_RUNTIME_CONFIG, maxToolTurns: 3 } }, async () => {
      // The MAIN run: the listener is amended around it, exactly as
      // `runAndSave` does.
      await amendRunFrame({ live: listener }, () =>
        harness<Data>(probePattern())('go', 'sess-main'),
      )

      // The SIDECAR: a second `harness()` in the same turn, started AFTER the
      // main run returned. It brings no listener of its own — the title agent
      // does not either.
      const seen: ContextEvent[] = []
      await harness<Data>(
        probePattern(() => {
          // Whatever this run emits must go nowhere: assert on the slot it
          // would emit through.
          const slot = currentRunFrame()?.live
          if (slot) seen.push({ type: 'leaked' } as unknown as ContextEvent)
        }),
      )('title', 'sess-sidecar')
      sidecarSaw = seen
    })

    expect(main.length).toBeGreaterThan(0)
    expect(sidecarSaw).toEqual([])
  })

  it('what the sidecar KEEPS is the turn: config and inference reach it', async () => {
    // The other half, and the reason the fix is "scope the listener" rather
    // than "stop nesting": SA-M13 is about the turn's settings and tier
    // surviving into work the turn starts and does not await. They must.
    let seen: { maxToolTurns?: number; tier?: string } = {}

    await withRunFrame(
      {
        config: { ...DEFAULT_RUNTIME_CONFIG, maxToolTurns: 2 },
        inference: { tier: 'a-private-tier' },
      },
      async () => {
        await amendRunFrame({ live: () => {} }, () =>
          harness<Data>(probePattern())('go', 'sess-main'),
        )
        await harness<Data>(
          probePattern(() => {
            seen = {
              maxToolTurns: runtimeConfig().maxToolTurns,
              tier: currentRunFrame()?.inference?.tier,
            }
          }),
        )('title', 'sess-sidecar')
      },
    )

    expect(seen.maxToolTurns).toBe(2)
    expect(seen.tier).toBe('a-private-tier')
  })

  it('a nested entry inside the listener’s own scope still inherits it', async () => {
    // The affordance the rule above must not break: a host that opens the frame
    // itself and calls an entry point bare still streams. This is the shape the
    // tutorial documents and the shape `runAndSave` relies on.
    const seen: string[] = []
    await withRunFrame({}, () =>
      amendRunFrame({ live: (e: ContextEvent) => seen.push(e.type) }, () =>
        harness<Data>(probePattern())('go', 'sess-1'),
      ),
    )
    expect(seen).toContain('user_message')
  })
})
