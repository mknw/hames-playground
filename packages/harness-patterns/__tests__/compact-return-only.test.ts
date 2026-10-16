/**
 * A Return-only controller turn keeps the controller's answer.
 *
 * The failure it closes: a controller that answers without calling a tool emits
 * only `Return`, its text riding in `tool_args`. `compactExecution` drops the
 * terminal `Return` iteration (a tool-using turn's Return is a summary, #149),
 * so a thread holding nothing else left `loopHistory` unset, `data.response`
 * is never written by `simpleLoop`, and the synthesizer was handed no turns at
 * all — it answered "tool results were not provided".
 *
 * Each test names the source mutation that reddens it; every one was run.
 */

import { describe, expect, it } from 'vitest'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import { configurePattern, runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createEvent } from '@hames-ai/harness-patterns/context.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type {
  CompactExecutionInput,
  ConfiguredPattern,
  UnifiedContext,
} from '@hames-ai/harness-patterns/types'

type Data = Record<string, unknown>

type Step = {
  tool: string
  args?: string
  result?: unknown
  ok?: boolean
  /** An action that ends the loop WITHOUT a tool_result (is_final on a non-Return). */
  final?: boolean
}

/** A loop that records the given steps the way `simpleLoop` does: a
 *  controller_action each, a tool_result for every step except `Return`. */
function loop(patternId: string, steps: Step[]): ConfiguredPattern<Data> {
  return configurePattern<Data>(
    'loop',
    async (scope) => {
      for (const s of steps) {
        scope.events.push(
          createEvent('controller_action', scope.id, {
            action: {
              reasoning: '',
              tool_name: s.tool,
              tool_args: s.args ?? '{}',
              status: 'ok',
              is_final: s.tool === 'Return' || s.final === true,
            },
          }),
        )
        if (s.tool !== 'Return' && !s.final) {
          scope.events.push(
            createEvent('tool_result', scope.id, {
              tool: s.tool,
              result: s.result ?? null,
              success: s.ok ?? true,
            }),
          )
        }
      }
      return scope
    },
    { patternId },
  )
}

function ctxOf(input: string): UnifiedContext<Data> {
  const ctx: UnifiedContext<Data> = {
    sessionId: 's',
    createdAt: Date.now(),
    events: [],
    status: 'running',
    data: {},
    input,
  }
  ctx.events.push(createEvent('user_message', 'harness', { content: input }))
  return ctx
}

// `general`'s own synth config.
const GENERAL_VIEW = {
  fromPatterns: ['harness', 'execute'],
  fromLastNTurns: 1,
}

async function synthInput(steps: Step[]) {
  const seen: CompactExecutionInput[] = []
  const pattern = compactExecution<Data>({
    mode: 'thread',
    patternId: 'response-synth',
    viewConfig: GENERAL_VIEW,
    synthesize: async (input) => {
      seen.push(input)
      return { value: 'answer' }
    },
  })
  await withRunFrame({}, () => runChain(ctxOf('double that'), [loop('execute', steps), pattern]))
  return seen[0]
}

describe('compactExecution — a Return-only turn', () => {
  // THE reproduction. Mutation 1: delete the `returnOnlyText` block in the
  // thread case (the pre-fix code) → `response` is undefined.
  it('hands the controller’s Return text to the synthesizer as the response', async () => {
    const input = await synthInput([{ tool: 'Return', args: 'Twice 42 is 84.' }])
    expect(input.loopHistory).toBeUndefined()
    expect(input.response).toBe('Twice 42 is 84.')
  })

  // Mutation 2: drop the `real.length === 0` guard (always use the Return
  // text) → a tool-using turn's Return SUMMARY becomes the response, and the
  // synthesizer stops being the single author over the full tool results.
  it('a turn that DID call a tool keeps dropping the Return summary (#149)', async () => {
    const input = await synthInput([
      { tool: 'lookup', result: { n: 42 } },
      { tool: 'Return', args: 'Found it.' },
    ])
    expect(input.loopHistory?.iterations.map((i) => i.action.tool_name)).toEqual(['lookup'])
    expect(input.response).toBeUndefined()
  })

  // Mutation 3: `view.unfiltered()` for the named-pattern thread read (no turn
  // bound) → turn 1's Return text is read on a turn that had no Return of its
  // own, and answers it.
  it('a previous turn’s Return does not answer this turn', async () => {
    const seen: CompactExecutionInput[] = []
    const pattern = compactExecution<Data>({
      mode: 'thread',
      patternId: 'response-synth',
      viewConfig: GENERAL_VIEW,
      synthesize: async (input) => {
        seen.push(input)
        return { value: 'answer' }
      },
    })
    const ctx = ctxOf('first')
    await withRunFrame({}, async () => {
      await runChain(ctx, [loop('execute', [{ tool: 'Return', args: 'old answer' }])])
      ctx.events.push(createEvent('user_message', 'harness', { content: 'second' }))
      await runChain(ctx, [loop('execute', [{ tool: 'x', final: true }]), pattern])
    })
    expect(seen[0].response).toBeUndefined()
  })

  // Mutation 4: drop the `data.response ??` precedence → a response a previous
  // pattern already produced is overwritten by the Return text.
  it('an explicit data.response still wins', async () => {
    const seen: CompactExecutionInput[] = []
    const pattern = compactExecution<Data>({
      mode: 'thread',
      patternId: 'response-synth',
      viewConfig: GENERAL_VIEW,
      synthesize: async (input) => {
        seen.push(input)
        return { value: 'answer' }
      },
    })
    const setter = configurePattern<Data>(
      'setter',
      async (scope) => {
        scope.data = { ...scope.data, response: 'from upstream' }
        return scope
      },
      { patternId: 'setter' },
    )
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [
        loop('execute', [{ tool: 'Return', args: 'controller text' }]),
        setter,
        pattern,
      ]),
    )
    expect(seen[0].response).toBe('from upstream')
  })

  // Mutation 5: drop the `.trim()` emptiness check → an empty Return reaches
  // the synthesizer as an empty-string response (still falsy downstream, but
  // the input stops being byte-identical to before).
  it('an empty Return leaves the input as it was', async () => {
    const input = await synthInput([{ tool: 'Return', args: '  ' }])
    expect(input.response).toBeUndefined()
  })

  // Mutation 6: match any `is_final` action instead of `tool_name === 'Return'`
  // → a final action naming a real tool contributes its ARGUMENTS as an answer.
  it('only a Return carries an answer; a final action’s tool arguments do not', async () => {
    const input = await synthInput([
      { tool: 'write_cypher', args: '{"query":"MATCH (n)"}', final: true },
    ])
    expect(input.response).toBeUndefined()
  })
})
