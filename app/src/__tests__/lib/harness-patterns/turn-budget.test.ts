/**
 * Loop round budgets (#269).
 *
 * The cap that produced this issue was a call-site literal (`maxTurns: 8` on
 * the `general` agent's executor) read straight into the loop's `for`, with the
 * exhaustion identifiable only by matching the prose of an error message. Three
 * properties are pinned here, in the order they matter:
 *
 *  1. **Resolution** — one rule (`resolveTurnBudget`) decides the budget for the
 *     loop body, for `estimateTurns` (the progress bar's denominator) and for
 *     the exhaustion event. Three readers of the same question, so a test that
 *     only covered the body would let the bar and the event drift.
 *  2. **The clamp**, which is load-bearing rather than hygiene: the stuck-run
 *     reaper derives the longest turn the app may legitimately run from
 *     `SETTINGS_BOUNDS`, so a pattern pinning a budget above the ceiling would
 *     be reaped mid-flight instead of finishing. The last test in this file is
 *     that invariant stated directly.
 *  3. **Visibility** — a loop stopped by its budget records a `recoverable`
 *     error marked `kind: 'budget_exhausted'` carrying the budget itself. The
 *     marker is the point: before it, "truncated by the cap" and "something
 *     threw" were the same event to every reader, separable only by a regex on
 *     an English sentence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockAction, mockCriticResult, mockBAMLClient } from '../../mocks/baml'
import { mockCallTool, mockListTools } from '../../mocks/mcp'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const callToolMock = mockCallTool({
  responses: {
    read_neo4j_cypher: { rows: [] },
    'code-mode': { result: 'ok' },
    Return: { response: 'Done' },
  },
})

vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools(['read_neo4j_cypher', 'code-mode', 'Return']),
}))

vi.mock('../../../../baml_client', () => ({
  b: mockBAMLClient({
    loopActions: [mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{}' })],
    actorActions: [mockAction({ tool_name: 'code-mode', tool_args: '{}' })],
    criticResults: [mockCriticResult({ is_sufficient: false })],
  }),
}))

/** A minimal HarnessContext for `createEventView` — one user message, which is
 *  all either loop reads off the view to build its first prompt. */
const contextWith = (input: string) => ({
  sessionId: 'test',
  createdAt: 0,
  events: [
    { type: 'user_message' as const, ts: 0, patternId: 'harness', data: { content: input } },
  ],
  status: 'running' as const,
  data: {},
  input,
})

/** A controller that NEVER signals completion: no `Return`, no `is_final`. The
 *  only way out of the loop is its round budget, which is what these tests are
 *  here to observe. Counts its own calls so "it really ran N rounds" is checked
 *  against the loop's behaviour and not only against the event it emitted. */
const neverFinishingController = () => {
  const fn = vi.fn().mockResolvedValue({
    action: {
      reasoning: 'still working',
      status: 'working',
      tool_name: 'read_neo4j_cypher',
      tool_args: '{}',
      additional_calls: null,
      is_final: false,
    },
    llmCall: undefined,
  })
  return fn
}

describe('resolveTurnBudget', () => {
  it('falls back to the request setting when the pattern declares nothing', async () => {
    const { resolveTurnBudget, DEFAULT_SETTINGS } = await import('../../../lib/settings')

    expect(resolveTurnBudget('maxToolTurns', undefined, DEFAULT_SETTINGS.maxToolTurns)).toBe(
      DEFAULT_SETTINGS.maxToolTurns,
    )
    expect(resolveTurnBudget('maxRetries', undefined, DEFAULT_SETTINGS.maxRetries)).toBe(
      DEFAULT_SETTINGS.maxRetries,
    )
  })

  it("a pattern's own declaration wins over the setting, in BOTH directions", async () => {
    const { resolveTurnBudget } = await import('../../../lib/settings')

    // Larger — the `general` agent's case: it needs more rounds than the
    // default gives, and gets them without the user touching anything.
    expect(resolveTurnBudget('maxToolTurns', 12, 8)).toBe(12)
    // Smaller — the case a blanket `Math.max` would break: a loop pinning a
    // deliberately short budget (a classifier, a single-shot lookup) means it,
    // and a user's slider does not get to widen it.
    expect(resolveTurnBudget('maxToolTurns', 2, 15)).toBe(2)
  })

  it('clamps a declared budget to SETTINGS_BOUNDS — the path a literal bypasses', async () => {
    const { resolveTurnBudget, SETTINGS_BOUNDS } = await import('../../../lib/settings')
    const [min, max] = SETTINGS_BOUNDS.maxToolTurns

    // Above the ceiling: `sanitizeHarnessSettings` already clamps what a browser
    // sends, but a call-site literal reached the loop unchecked.
    expect(resolveTurnBudget('maxToolTurns', max + 25, 8)).toBe(max)
    // Below the floor. `0` is the interesting one: it ran zero rounds and
    // recorded NOTHING, because the exhaustion event is gated on having
    // completed at least one turn — a silent no-op that read as a clean run.
    expect(resolveTurnBudget('maxToolTurns', 0, 8)).toBe(min)
    expect(resolveTurnBudget('maxToolTurns', -5, 8)).toBe(min)
    // The settings value is clamped on the same path, so a hand-built
    // HarnessSettings (a test, a direct `runWithSettings`) cannot smuggle a
    // budget past the bound either.
    expect(resolveTurnBudget('maxRetries', undefined, 999)).toBe(SETTINGS_BOUNDS.maxRetries[1])
  })

  it('is the rule estimateTurns uses, so the progress bar cannot disagree', async () => {
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { actorCritic } =
      await import('../../../lib/harness-patterns/patterns/actorCritic.server')
    const { DEFAULT_SETTINGS, SETTINGS_BOUNDS } = await import('../../../lib/settings')

    expect(simpleLoop(vi.fn(), [], { patternId: 'a' }).estimateTurns?.(DEFAULT_SETTINGS)).toBe(
      DEFAULT_SETTINGS.maxToolTurns,
    )
    expect(
      simpleLoop(vi.fn(), [], { patternId: 'b', maxTurns: 12 }).estimateTurns?.(DEFAULT_SETTINGS),
    ).toBe(12)
    // The bar's denominator is clamped too — otherwise a pinned-too-high loop
    // would render a fraction out of a number it could never reach.
    expect(
      simpleLoop(vi.fn(), [], { patternId: 'c', maxTurns: 99 }).estimateTurns?.(DEFAULT_SETTINGS),
    ).toBe(SETTINGS_BOUNDS.maxToolTurns[1])
    expect(
      actorCritic(vi.fn(), vi.fn(), [], { patternId: 'd', maxRetries: 4 }).estimateTurns?.(
        DEFAULT_SETTINGS,
      ),
    ).toBe(4)
  })
})

describe('the default round budget', () => {
  it('is 8, and the general agent pins 12 above it (#269 evidence)', async () => {
    const { DEFAULT_SETTINGS, SETTINGS_BOUNDS } = await import('../../../lib/settings')

    // Pinned as a value, not just as a relation, because "the default" is the
    // number the issue was about: raised 5 → 8 after two live runs hit a cap.
    expect(DEFAULT_SETTINGS.maxToolTurns).toBe(8)
    // The `general` executor's 12 has to remain reachable — a bound below it
    // would clamp the very budget the captured run showed was needed.
    expect(SETTINGS_BOUNDS.maxToolTurns[1]).toBeGreaterThanOrEqual(12)
  })
})

describe('exhaustion is recorded as a truncation, not as a failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('simpleLoop: marks the event, carries the budget, and spends exactly it', async () => {
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns')

    const controller = neverFinishingController()
    const pattern = simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'execute',
      maxTurns: 3,
    })

    const result = await pattern.fn(
      createScope('execute', { intent: 'do the thing' }),
      createEventView(contextWith('do the thing')),
    )

    // The budget bounded the loop, and bounded it at the declared value.
    expect(controller).toHaveBeenCalledTimes(3)

    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    const data = errors[0].data as {
      kind?: string
      severity?: string
      maxTurns?: number
      turn?: number
      hint?: string
    }
    // The marker — what makes this identifiable without reading the sentence.
    expect(data.kind).toBe('budget_exhausted')
    // Recoverable: the completed rounds are the answer's material (#83), so the
    // chain continues to the synthesizer rather than stopping here.
    expect(data.severity).toBe('recoverable')
    // Both halves of "2 of 3" — a turn number alone cannot tell a reader whether
    // the loop stopped early or ran out.
    expect(data.maxTurns).toBe(3)
    expect(data.turn).toBe(2)
  })

  it('simpleLoop: the hint names the lever that actually bound', async () => {
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns')

    const run = async (maxTurns?: number) => {
      const pattern = simpleLoop(neverFinishingController(), ['read_neo4j_cypher', 'Return'], {
        patternId: 'execute',
        ...(maxTurns === undefined ? {} : { maxTurns }),
      })
      const result = await pattern.fn(
        createScope('execute', { intent: 'x' }),
        createEventView(contextWith('x')),
      )
      const err = result.events.find((e) => e.type === 'error')
      return (err?.data as { hint?: string }).hint ?? ''
    }

    // A PINNED loop must not be told to raise the Settings slider: the pin wins
    // over it, so that advice changes nothing. This was the live defect — the
    // agent that hit the cap was pinned, and the hint sent its reader to a
    // control that could not move it.
    const pinned = await run(2)
    expect(pinned).toContain('maxTurns')
    expect(pinned).toContain('execute')
    expect(pinned).not.toMatch(/Raise it in Settings/)

    // An UNPINNED loop rides the setting, so the slider is the right lever.
    const unpinned = await run()
    expect(unpinned).toContain('Settings')
  })

  it('actorCritic: stamps the identical marker when its attempts run out', async () => {
    const { actorCritic } =
      await import('../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns')

    const actor = vi.fn().mockResolvedValue({
      action: {
        reasoning: 'attempt',
        status: 'working',
        tool_name: 'code-mode',
        tool_args: '{}',
        additional_calls: null,
        is_final: false,
      },
      llmCall: undefined,
    })
    // Never satisfied — the critic is the loop's only exit authority, so this
    // runs the attempt budget to the end.
    const critic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: false, explanation: 'no' }),
      llmCall: undefined,
    })

    const pattern = actorCritic(actor, critic, ['code-mode'], {
      patternId: 'actor-loop',
      maxRetries: 2,
    })

    const result = await pattern.fn(
      createScope('actor-loop', {}),
      createEventView(contextWith('run it')),
    )

    expect(actor).toHaveBeenCalledTimes(2)
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    const data = errors[0].data as { kind?: string; maxTurns?: number; iteration?: number }
    // One marker for both loops: a reader (the panel, an eval) asks the same
    // question of a truncated simpleLoop and a truncated actorCritic.
    expect(data.kind).toBe('budget_exhausted')
    expect(data.maxTurns).toBe(2)
    expect(data.iteration).toBe(1)
  })

  it('the BODY spends the clamped budget, not the declared literal', async () => {
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns')
    const { SETTINGS_BOUNDS } = await import('../../../lib/settings')
    const ceiling = SETTINGS_BOUNDS.maxToolTurns[1]

    const controller = neverFinishingController()
    const result = await simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'execute',
      maxTurns: ceiling + 25,
    }).fn(createScope('execute', { intent: 'x' }), createEventView(contextWith('x')))

    // The resolver being clamped is not the same claim as the loop running on
    // the clamped value — this is the half the reaper's derivation rests on.
    expect(controller).toHaveBeenCalledTimes(ceiling)
    const data = result.events.find((e) => e.type === 'error')?.data as { maxTurns?: number }
    expect(data?.maxTurns).toBe(ceiling)
  })

  it('a declared 0 still runs a round and RECORDS its exhaustion', async () => {
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns')

    const controller = neverFinishingController()
    const result = await simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'execute',
      maxTurns: 0,
    }).fn(createScope('execute', { intent: 'x' }), createEventView(contextWith('x')))

    // The floor exists because the exhaustion event is gated on `turns.length >
    // 0`: at a budget of 0 the loop ran nothing and recorded nothing, a silent
    // no-op that read as a clean run. Asserting the floor VALUE against
    // SETTINGS_BOUNDS cannot catch that — lower the bound and the assertion
    // moves with it — so assert the behaviour the floor buys.
    expect(controller).toHaveBeenCalledTimes(1)
    const data = result.events.find((e) => e.type === 'error')?.data as { kind?: string }
    expect(data?.kind).toBe('budget_exhausted')
  })
})

describe('the clamp keeps the stuck-run reaper honest', () => {
  it('no declarable budget can outlive the reaper threshold derived from the bounds', async () => {
    const { resolveTurnBudget, SETTINGS_BOUNDS } = await import('../../../lib/settings')

    // `MAX_SEQUENTIAL_LLM_CALLS` (lib/db/conversations.server.ts) is computed as
    // max(maxToolTurns ceiling, 2 × maxRetries ceiling) + overhead, and
    // `STUCK_RUN_TIMEOUT_MINUTES` follows from it. That derivation is only true
    // if nothing can actually RUN more rounds than the ceiling it reads — which
    // is exactly what an unclamped call-site literal could do. A run that
    // outlasts the threshold is marked `error` while it is still working.
    for (const declared of [16, 40, 1000, Number.MAX_SAFE_INTEGER]) {
      expect(resolveTurnBudget('maxToolTurns', declared, 8)).toBeLessThanOrEqual(
        SETTINGS_BOUNDS.maxToolTurns[1],
      )
      expect(resolveTurnBudget('maxRetries', declared, 3)).toBeLessThanOrEqual(
        SETTINGS_BOUNDS.maxRetries[1],
      )
    }
  })
})
