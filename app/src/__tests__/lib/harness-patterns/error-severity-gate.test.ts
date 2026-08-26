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

describe('a gated turn does not poison the next one', () => {
  it('lets the following turn run, and its patterns with it', async () => {
    // Insurance on a property two separate mechanisms currently happen to
    // guarantee (F7 on #278): `continueSession` resets `ctx.status` and clears
    // `ctx.error`, AND `firstIrrecoverable` scans only from this pattern's
    // commit offset. Either one alone would do it, so nothing fails if one of
    // them quietly stops — and the failure mode would be a conversation that is
    // permanently wedged after one irrecoverable error, with every later turn
    // ending before its first pattern.
    const { continueSession } = await import('../../../lib/harness-patterns/harness.server')
    const ran: string[] = []
    const ctx = createContext<Data>('q')

    await runChain(ctx, [
      failing('router', { error: 'no route' }, { patternId: 'router' }),
      marker('never', ran),
    ])
    expect(ctx.status).toBe('error')
    expect(ran).toEqual([])

    const { serializeContext } = await import('../../../lib/harness-patterns/context.server')
    const next = await continueSession(
      serializeContext(ctx) as any,
      [marker('synth', ran)] as any,
      'q2',
    )

    expect(ran).toEqual(['synth'])
    expect(next.context.status).not.toBe('error')
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
  /**
   * Every entry, by value, in one table (F2 on #278).
   *
   * The source scan below pins that each pattern type HAS an entry; nothing
   * pinned what the entry SAID, and the map is the load-bearing half now. The
   * mutations that went green against the full 3972-test suite:
   * `compactExecution → recoverable`; all four chain-fatal types → recoverable,
   * i.e. the gate switched off entirely; and the five best-effort types →
   * irrecoverable, i.e. a warning ending every turn. Only `guardrail` and
   * `simpleLoop` were asserted at all, and only in one direction, because two
   * behaviour tests happened to name them.
   *
   * The rule each value answers is the owner's, stated on the map itself:
   *
   *   **can this turn still produce an honest answer after this failure?**
   *
   * Yes → `recoverable`. No → `irrecoverable`, because the alternative is a
   * downstream synthesizer composing a confident answer out of nothing. The
   * table is exhaustive in BOTH directions on purpose — a new type added to
   * neither list fails here as well as in the scan, and a value flipped in
   * either direction fails here rather than shipping as a silent policy change.
   *
   * Same shape as `client-output-caps.test.ts`'s mirror check, and for the same
   * reason: the dangerous edit is one that reads like a tidy-up.
   */
  const IRRECOVERABLE = [
    // Each of these leaves NOTHING for a later pattern to work with.
    'compactExecution', // it IS the answer; a failure means there is nothing to show
    'router', // clears data.route, and routes() then throws one pattern later
    'routes', // "the router named a route I do not have" — nothing ran
    'chain', // the chain itself failed
  ] as const

  const RECOVERABLE = [
    'simpleLoop', // self-heals next iteration, or returns partial results (#83)
    'actorCritic', // same
    'compactIntent', // leaves intent unset; the actor falls back to the raw message
    'planner', // clears the plan; the loop runs unplanned
    'retriever', // empty matches; the compactExecution answers from the rest
    'guardrail', // a `warn` rail records an `error` event BY DESIGN
    'judge', // advisory ranking; "no candidates" is a normal outcome
    'parallel', // per-branch; the surviving branches are what the chain is for
    'hook', // costs the side effect, never the answer
    'withReferences', // the inner pattern ran without curated prior results
  ] as const

  it.each(IRRECOVERABLE)('classifies %s as irrecoverable — it leaves nothing behind', (type) => {
    expect(DEFAULT_ERROR_SEVERITY[type]).toBe('irrecoverable')
  })

  it.each(RECOVERABLE)('classifies %s as recoverable — the turn can still answer', (type) => {
    expect(DEFAULT_ERROR_SEVERITY[type]).toBe('recoverable')
  })

  it('has no entry the table above does not account for', () => {
    // Exhaustive, so a new pattern type cannot be added to the map with an
    // unreviewed value: it has to be argued into one of the two lists.
    expect(Object.keys(DEFAULT_ERROR_SEVERITY).sort()).toEqual(
      [...IRRECOVERABLE, ...RECOVERABLE].slice().sort(),
    )
  })

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
