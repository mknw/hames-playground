/**
 * `errorSeverity` decides whether the chain keeps going (#273 D-d).
 *
 * Before this, severity fed presentation only — `errorBubble` paints
 * `recoverable` as a warning and everything else as an error — so a pattern
 * could record a failure it could not come back from and the chain would run
 * straight past it: the next pattern executed against a missing result and the
 * `compactExecution` at the end composed an answer out of the hole. The tests
 * here are about the control flow, in both directions, because a gate that
 * fires too eagerly is as wrong as one that never fires: a warning from an
 * output rail must not end a turn.
 *
 * The last case is a source scan rather than a behaviour test. The map is now
 * load-bearing, and its dangerous shape is an OMISSION — a new pattern type
 * with no entry inherits a default it never declared, which is exactly how
 * `guardrail` came to be classified chain-fatal.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import { runChain, configurePattern } from '../../../lib/harness-patterns/patterns/chain.server'
import { createContext, trackEvent } from '../../../lib/harness-patterns/context.server'
import { DEFAULT_ERROR_SEVERITY } from '../../../lib/harness-patterns/types'
import type { ErrorEventData, PatternConfig } from '../../../lib/harness-patterns/types'

type Data = Record<string, unknown>

/**
 * A pattern that records one `error` event and returns normally — the shape
 * every pattern in this package uses for a failure (they catch internally
 * rather than throwing, which is why the chain never saw these at all).
 */
function failing(
  name: string,
  data: ErrorEventData,
  config?: PatternConfig,
): ReturnType<typeof configurePattern<Data>> {
  return configurePattern<Data>(
    name,
    async (scope) => {
      trackEvent(scope, 'error', data, true)
      return scope
    },
    { patternId: name, ...config },
  )
}

/** A pattern that records that it ran. */
function marker(name: string, ran: string[]): ReturnType<typeof configurePattern<Data>> {
  return configurePattern<Data>(
    name,
    async (scope) => {
      ran.push(name)
      return scope
    },
    { patternId: name },
  )
}

describe('an irrecoverable error stops the chain', () => {
  it('does not run the patterns after it, and says why on the context', async () => {
    const ran: string[] = []
    const ctx = createContext<Data>('how many nodes are in the graph?')

    await runChain(ctx, [
      failing('exec', { error: 'tools unavailable', severity: 'irrecoverable' }),
      marker('synth', ran),
    ])

    // The synthesizer is the pattern this protects the user from: it would have
    // answered the question from an execution that produced nothing.
    expect(ran).toEqual([])
    expect(ctx.status).toBe('error')
    expect(ctx.error).toBe('tools unavailable')
  })

  it('adds no second error event', async () => {
    const ctx = createContext<Data>('q')

    await runChain(ctx, [failing('exec', { error: 'boom', severity: 'irrecoverable' })])

    // `setError` would push one, doubling the error bubble in the transcript
    // and in every replay of it — the pattern's own event already carries the
    // LLM-call detail the observability drill-down needs.
    const errors = ctx.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0].data as ErrorEventData).error).toBe('boom')
  })

  it('still closes the failing pattern with its pattern_exit', async () => {
    const ctx = createContext<Data>('q')

    await runChain(ctx, [failing('exec', { error: 'boom', severity: 'irrecoverable' })])

    // The gate sets the status and lets the loop's own guard stop the next
    // iteration, so the lifecycle events of the pattern that failed are intact
    // — a missing `pattern_exit` would leave every consumer that pairs them
    // (the progress bar, the observability timeline) reading an open pattern.
    const types = ctx.events.map((e) => e.type)
    expect(types).toContain('pattern_enter')
    expect(types).toContain('pattern_exit')
  })
})

describe('a recoverable error does not', () => {
  it('lets the rest of the chain answer from partial results', async () => {
    const ran: string[] = []
    const ctx = createContext<Data>('q')

    await runChain(ctx, [
      failing('loop', { error: 'max turns reached', severity: 'recoverable' }),
      marker('synth', ran),
    ])

    // A loop that exhausts `maxTurns` records a recoverable error and the
    // synthesizer answers from what it did get (#83). Gating that would report
    // every partial answer as a failure.
    expect(ran).toEqual(['synth'])
    expect(ctx.status).toBe('running')
    expect(ctx.error).toBeUndefined()
  })

  it('treats an output-rail warning as the warning it is', async () => {
    const ran: string[] = []
    const ctx = createContext<Data>('q')

    // `guardrail` records an `error` event for `action: 'warn'` BY DESIGN, and
    // carries no severity on it — so the pattern default decides. Until this
    // change `guardrail` had no entry in the map and inherited
    // `'irrecoverable'`, which would have made a warning end the turn.
    await runChain(ctx, [
      // The name is the pattern TYPE `resolveConfig` looks up, so this reads
      // the real `guardrail` entry rather than the fallback.
      failing('guardrail', { error: "Output rail 'pii' warning: 2 matches" }),
      marker('synth', ran),
    ])

    expect(DEFAULT_ERROR_SEVERITY.guardrail).toBe('recoverable')
    expect(ran).toEqual(['synth'])
    expect(ctx.status).toBe('running')
  })
})

describe('the event outranks the pattern', () => {
  it('gates a recoverable pattern when the failure itself says it cannot recover', async () => {
    const ran: string[] = []
    const ctx = createContext<Data>('q')

    // The #276 case: `simpleLoop` is `recoverable` as a pattern — it usually
    // self-heals on the next iteration — but no iteration can put a collapsed
    // tool surface back, so that failure stamps its own severity.
    const loop = configurePattern<Data>(
      'simpleLoop',
      async (scope) => {
        trackEvent(
          scope,
          'error',
          { error: 'Tools unavailable: the MCP gateway…', severity: 'irrecoverable' },
          true,
        )
        return scope
      },
      { patternId: 'loop' },
    )

    await runChain(ctx, [loop, marker('synth', ran)])

    expect(DEFAULT_ERROR_SEVERITY.simpleLoop).toBe('recoverable')
    expect(ran).toEqual([])
    expect(ctx.status).toBe('error')
  })

  it('spares an irrecoverable pattern when the failure says it can', async () => {
    const ran: string[] = []
    const ctx = createContext<Data>('q')

    await runChain(ctx, [
      failing('router', { error: 'retrying', severity: 'recoverable' }, { patternId: 'router' }),
      marker('next', ran),
    ])

    expect(ran).toEqual(['next'])
    expect(ctx.status).toBe('running')
  })
})

describe('an unknown pattern type', () => {
  it('is recoverable, so a custom pattern cannot end turns it never used to', async () => {
    const ran: string[] = []
    const ctx = createContext<Data>('q')

    // `configurePattern` accepts any name, and this one is in no map. The
    // fallback used to be `'irrecoverable'`, which was cosmetic while nothing
    // read severity for control flow and would have become "the first error a
    // custom pattern logs kills the turn" the moment something did.
    await runChain(ctx, [
      failing('my-custom-step', { error: 'a note about something' }),
      marker('synth', ran),
    ])

    expect(DEFAULT_ERROR_SEVERITY['my-custom-step']).toBeUndefined()
    expect(ran).toEqual(['synth'])
    expect(ctx.status).toBe('running')
  })
})

describe('the classification map', () => {
  it('has an entry for every pattern type in the package', async () => {
    const dir = resolve(process.cwd(), 'src/lib/harness-patterns/patterns')
    const declared = new Set<string>()
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith('.ts')) continue
      const source = await readFile(join(dir, entry), 'utf8')
      for (const match of source.matchAll(/resolveConfig\('([A-Za-z-]+)'/g)) {
        declared.add(match[1])
      }
    }

    // Sanity: the scan found the tree, so an empty diff below means "complete",
    // not "scanned nothing".
    expect(declared.size).toBeGreaterThan(10)

    const missing = [...declared].filter((type) => !(type in DEFAULT_ERROR_SEVERITY)).sort()
    expect(missing).toEqual([])
  })
})
