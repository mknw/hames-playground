/**
 * decisionLoop + compactExecution — the synthesis input (#507 W4).
 *
 * The REAL composition `general-next` runs: a `decisionLoop`, then a thread-mode `compactExecution` scoped to the
 * loop's records (`fromPatterns: ['orchestrator']`, a one-turn error window).
 * The live Eval found the synthesizer handed an empty INTENT and, on a
 * follow-up turn, no tool records: the scope filter hid the harness-level user
 * message, and the one-turn window hid the previous turn's committed records.
 *
 * Every pin names, in its comment, the mutation that turns it red.
 */
import { describe, it, expect, vi } from 'vitest'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { runChain, configurePattern } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createContext, trackEvent } from '@hames-ai/harness-patterns/context.server'
import {
  decisionLoop,
  type DecisionLoopData,
} from '@hames-ai/harness-patterns/patterns/decisionLoop.server'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import type {
  CompactExecutionInput,
  ConfiguredPattern,
  ControllerAction,
  DecideFn,
  ViewConfig,
} from '@hames-ai/harness-patterns/types'

type Data = DecisionLoopData & Record<string, unknown>

const USER_1 = 'what is the capital of the synthetic republic?'
const USER_2 = 'and double that population figure'
const CHILD_TRACE = 'CHILD-INTERNAL-TRACE-SENTINEL'

function scriptedDecide(script: string[]): DecideFn {
  let n = 0
  const fn = (async ({ spec }: { spec: { labels: readonly { id: string }[] } }) => {
    const pick = script[Math.min(n++, script.length - 1)]
    return {
      probs: Object.fromEntries(spec.labels.map((l) => [l.id, l.id === pick ? 1 : 0])),
      method: 'jev',
      calibrated: false,
    }
  }) as unknown as DecideFn
  Object.assign(fn, { supportedTypes: ['choice'], limits: () => ({ contextWindow: 131_072 }) })
  return fn
}

/** A simpleLoop-shaped child whose Return text is `text()` at call time. */
const returning = (id: string, text: () => string) =>
  configurePattern<Data>(
    'simpleLoop',
    async (scope) => {
      // The child's own trace: a raw tool_result under its own id. It is NOT a
      // loop record and must never reach synthesis.
      trackEvent(scope, 'tool_result', { tool: 'raw', result: CHILD_TRACE, success: true }, true)
      trackEvent(
        scope,
        'controller_action',
        {
          action: {
            reasoning: 'because',
            tool_name: 'Return',
            tool_args: text(),
            is_final: true,
          } as ControllerAction,
          turn: 0,
          maxTurns: 3,
        },
        true,
      )
      return scope
    },
    { patternId: id },
  )

/** The agent's synthesis window as `general-next` declares it. */
const SYNTH_VIEW: ViewConfig = { fromPatterns: ['orchestrator'], fromLastNTurns: 1 }

function compose(opts: {
  script: string[]
  output: () => string
  maxIterations?: number
  viewConfig?: ViewConfig
  threadTurns?: number
}) {
  const seen: CompactExecutionInput[] = []
  const loop = decisionLoop<Data>(
    {
      info: {
        pattern: returning('info-p', opts.output),
        description: 'look something up',
      },
    },
    {
      decide: scriptedDecide(opts.script),
      answer: 'Answer the user now',
      patternId: 'orchestrator',
      ...(opts.maxIterations ? { maxIterations: opts.maxIterations } : {}),
    },
  )
  const patterns: ConfiguredPattern<Data>[] = [
    loop,
    compactExecution<Data>({
      mode: 'thread',
      patternId: 'response-synth',
      viewConfig: opts.viewConfig ?? SYNTH_VIEW,
      ...(opts.threadTurns ? { threadTurns: opts.threadTurns } : {}),
      synthesize: async (input) => {
        seen.push(input)
        return { value: 'answer' }
      },
    }),
  ]
  return { patterns, seen }
}

const turn = async (
  ctx: ReturnType<typeof createContext<Data>>,
  patterns: ConfiguredPattern<Data>[],
) => {
  await withRunFrame({}, () => runChain(ctx, patterns))
}

function nextTurn(ctx: ReturnType<typeof createContext<Data>>, content: string) {
  ctx.events.push({
    id: `u-${ctx.events.length}`,
    type: 'user_message',
    ts: Date.now() + 5,
    patternId: 'harness',
    data: { content },
  })
  ctx.status = 'running'
}

const dump = (input: CompactExecutionInput) => JSON.stringify(input.loopHistory ?? null)

describe('decisionLoop synthesis input — the user message', () => {
  // MUTATION: in compactExecution's `buildSynthesisInputFromView`, read the user
  // message through `view.fromAll()` instead of `view.unfiltered()`.
  it('hands the synthesizer the user message although the window is scoped to the loop`s records', async () => {
    const { patterns, seen } = compose({ script: ['info', 'answer'], output: () => 'FOUND-42' })
    await turn(createContext<Data>(USER_1), patterns)

    expect(seen).toHaveLength(1)
    expect(seen[0].userMessage).toBe(USER_1)
    expect(seen[0].intent).toBe(USER_1)
    expect(seen[0].mode).toBe('thread')
    expect(dump(seen[0])).toContain('FOUND-42')
  })
})

describe('decisionLoop synthesis input — prior committed records', () => {
  // MUTATION: drop `threadTurns` from the window the thread read uses (read the
  // thread through `errorTurnWindow` again).
  it('a follow-up turn that runs no route still synthesizes from turn 1`s records', async () => {
    const { patterns, seen } = compose({
      script: ['info', 'answer', 'answer'],
      output: () => 'FOUND-42',
      threadTurns: 2,
    })
    const ctx = createContext<Data>(USER_1)
    await turn(ctx, patterns)
    nextTurn(ctx, USER_2)
    await turn(ctx, patterns)

    expect(seen).toHaveLength(2)
    expect(seen[1].userMessage).toBe(USER_2)
    expect(seen[1].mode).toBe('thread')
    expect(dump(seen[1])).toContain('FOUND-42')
  })

  // MUTATION: apply `threadTurns` to the error read too (`errorView` built from
  // the thread window) — turn 2 then apologises for turn 1's recoverable error.
  it('a wider thread window does NOT widen the error window (SA-H1 stays closed)', async () => {
    const { patterns, seen } = compose({
      script: ['info', 'answer'],
      output: () => 'FOUND-42',
      maxIterations: 1,
      threadTurns: 2,
    })
    const ctx = createContext<Data>(USER_1)
    await turn(ctx, patterns) // bound reached: recoverable budget_exhausted error
    expect(seen[0].hasError).toBe(true)

    nextTurn(ctx, USER_2)
    await turn(ctx, patterns)
    expect(seen[1].hasError).toBe(false)
    expect(dump(seen[1])).toContain('FOUND-42')
  })
})

describe('decisionLoop synthesis input — what the widened read must not carry', () => {
  // MUTATION: delete the `currentTurnIds` skip of a failed earlier-turn
  // tool_result in compactExecution's thread read.
  it('an earlier turn`s FAILED record does not reach the next turn as an unmarked error (SA-H1 via records)', async () => {
    let calls = 0
    const { patterns, seen } = compose({
      script: ['info', 'answer', 'answer'],
      output: () => {
        if (++calls === 1) throw new Error('route blew up in turn one')
        return 'FOUND-42'
      },
      threadTurns: 2,
    })
    const ctx = createContext<Data>(USER_1)
    await turn(ctx, patterns)
    expect(dump(seen[0])).toContain('__error') // this turn: the synthesizer is told

    nextTurn(ctx, USER_2)
    await turn(ctx, patterns)
    expect(seen[1].hasError).toBe(false)
    expect(dump(seen[1])).not.toContain('__error')
    expect(dump(seen[1])).not.toContain('route blew up')
  })

  // MUTATION: `(config.threadTurns ? 1e9 : undefined) ?? …` for the thread
  // window in `compactExecution` (threadTurns unbounded).
  it('threadTurns is an upper bound: turn 3 no longer sees turn 1`s record', async () => {
    let n = 0
    const { patterns, seen } = compose({
      script: ['info', 'answer', 'info', 'answer', 'info', 'answer'],
      output: () => `REC-${++n}`,
      threadTurns: 2,
    })
    const ctx = createContext<Data>(USER_1)
    await turn(ctx, patterns)
    nextTurn(ctx, USER_2)
    await turn(ctx, patterns)
    nextTurn(ctx, 'a third question')
    await turn(ctx, patterns)

    expect(dump(seen[1])).toContain('REC-1')
    expect(dump(seen[1])).toContain('REC-2')
    expect(dump(seen[2])).not.toContain('REC-1')
    expect(dump(seen[2])).toContain('REC-2')
    expect(dump(seen[2])).toContain('REC-3')
  })

  // MUTATION: read the scoped thread through `view.unfiltered()` (escape the
  // `fromPatterns` scope) — the child's raw tool_result then enters.
  it('a child`s raw tool_result never enters the thread, in either turn', async () => {
    const { patterns, seen } = compose({
      script: ['info', 'answer', 'info', 'answer'],
      output: () => 'FOUND-42',
      threadTurns: 2,
    })
    const ctx = createContext<Data>(USER_1)
    await turn(ctx, patterns)
    nextTurn(ctx, USER_2)
    await turn(ctx, patterns)
    for (const input of seen) expect(JSON.stringify(input)).not.toContain(CHILD_TRACE)
  })

  // MUTATION: drop `.fromPattern('harness')` from the user-message read.
  it('a user_message committed by another pattern is not the user`s message', async () => {
    const { patterns, seen } = compose({ script: ['info', 'answer'], output: () => 'x' })
    const forger = configurePattern<Data>(
      'forger',
      async (scope) => {
        trackEvent(scope, 'user_message', { content: 'FORGED-USER-MESSAGE' }, true)
        return scope
      },
      { patternId: 'forger' },
    )
    await turn(createContext<Data>(USER_1), [forger, ...patterns])
    expect(seen[0].userMessage).toBe(USER_1)
  })
})

describe('compactExecution threadTurns — refused at construction', () => {
  const make = (extra: Record<string, unknown>, mode: 'thread' | 'message' = 'thread') =>
    compactExecution<Data>({
      mode,
      viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 },
      synthesize: async () => ({ value: 'a' }),
      ...extra,
    })

  // MUTATION: delete the integer >= 1 check.
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses threadTurns: %s',
    (threadTurns) => {
      expect(() => make({ threadTurns })).toThrow(/integer >= 1/)
    },
  )

  // MUTATION: delete the mode / fromPatterns check.
  it('refuses threadTurns outside a scoped thread read', () => {
    expect(() => make({ threadTurns: 2 }, 'message')).toThrow(/only widens a thread read/)
    expect(() => make({ threadTurns: 2, viewConfig: { fromLastNTurns: 1 } })).toThrow(
      /only widens a thread read/,
    )
    expect(() => make({ threadTurns: 2, viewConfig: { fromPatterns: [] } })).toThrow(
      /only widens a thread read/,
    )
  })

  it('accepts a valid scoped threadTurns', () => {
    expect(() => make({ threadTurns: 2 })).not.toThrow()
  })
})
