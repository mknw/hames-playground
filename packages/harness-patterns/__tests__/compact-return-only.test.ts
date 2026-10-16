/**
 * A Return-only controller turn keeps the controller's answer (#610).
 *
 * The failure it closes: a controller that answers without calling a tool emits
 * only `Return`, its text riding in `tool_args`. `compactExecution` drops the
 * terminal `Return` iteration (a tool-using turn's Return is a summary, #149),
 * so a thread holding nothing else left `loopHistory` unset, `simpleLoop` never
 * writes `data.response`, and the synthesizer was handed no turns at all — it
 * answered "tool results were not provided".
 *
 * The text now travels the producer's way: `simpleLoop` records it as
 * `data.returnText` when ITS `Return` ends the loop, `continueSession` clears it,
 * and `compactExecution` reads it only when no tool iteration reached the
 * synthesizer. A read of the thread's `controller_action` events was the first
 * design and was wrong twice (review of #612): an actorCritic `Return` the
 * allowlist refused is also a `controller_action`, and a window wider than one
 * turn reads the previous turn's.
 *
 * Each test names the source mutation that reddens it; every one was run.
 */

import { describe, expect, it } from 'vitest'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import {
  simpleLoop,
  type SimpleLoopData,
} from '@hames-ai/harness-patterns/patterns/simpleLoop.server'
import {
  actorCritic,
  type ActorCriticData,
} from '@hames-ai/harness-patterns/patterns/actorCritic.server'
import { configurePattern, runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createEvent } from '@hames-ai/harness-patterns/context.server'
import { harness, continueSession } from '@hames-ai/harness-patterns/harness.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type {
  CompactExecutionData,
  CompactExecutionInput,
  ControllerAction,
  UnifiedContext,
} from '@hames-ai/harness-patterns/types'

interface Data extends SimpleLoopData, ActorCriticData, CompactExecutionData {
  [key: string]: unknown
}

const act = (tool_name: string, tool_args: string): ControllerAction => ({
  reasoning: '',
  tool_name,
  tool_args,
  status: 'ok',
  is_final: tool_name === 'Return',
})

/** `general`'s own synth config, optionally with a wider turn window. */
const viewOf = (turns = 1) => ({
  fromPatterns: ['harness', 'execute'],
  fromLastNTurns: turns,
})

function synth(seen: CompactExecutionInput[], turns = 1) {
  return compactExecution<Data>({
    mode: 'thread',
    patternId: 'response-synth',
    viewConfig: viewOf(turns),
    synthesize: async (input) => {
      seen.push(input)
      return { value: 'answer' }
    },
  })
}

/** A real simpleLoop whose controller replays `script` (one action per turn). */
function scripted(script: Array<ControllerAction | Error>) {
  let i = 0
  return simpleLoop<Data>(
    async () => {
      const next = script[Math.min(i++, script.length - 1)]
      if (next instanceof Error) throw next
      return { action: next, llmCall: undefined }
    },
    ['lookup'],
    { patternId: 'execute', maxTurns: 3 },
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

describe('compactExecution — a Return-only turn', () => {
  // THE reproduction, through the real simpleLoop. Mutation 1: delete the
  // `returnText` write in simpleLoop's Return exit (or the `returnOnlyText`
  // read in compactExecution) → `response` is undefined.
  it('hands the controller’s Return text to the synthesizer as the response', async () => {
    const seen: CompactExecutionInput[] = []
    await withRunFrame({}, () =>
      runChain(ctxOf('double that'), [scripted([act('Return', 'Twice 42 is 84.')]), synth(seen)]),
    )
    expect(seen[0].loopHistory).toBeUndefined()
    expect(seen[0].response).toBe('Twice 42 is 84.')
  })

  // Mutation 2: drop the `!input.loopHistory` guard (always use the text) → a
  // tool-using turn's Return SUMMARY becomes the response and the synthesizer
  // stops being the single author over the full tool results (#149).
  it('a turn that DID call a tool keeps dropping the Return summary', async () => {
    const seen: CompactExecutionInput[] = []
    const callsTool = configurePattern<Data>(
      'tool-turn',
      async (scope) => {
        scope.events.push(
          createEvent('controller_action', scope.id, { action: act('lookup', '{}') }),
          createEvent('tool_result', scope.id, {
            tool: 'lookup',
            result: { n: 42 },
            success: true,
          }),
          createEvent('controller_action', scope.id, { action: act('Return', 'Found it.') }),
        )
        scope.data = { ...scope.data, returnText: 'Found it.' }
        return scope
      },
      { patternId: 'execute' },
    )
    await withRunFrame({}, () => runChain(ctxOf('q'), [callsTool, synth(seen)]))
    expect(seen[0].loopHistory?.iterations.map((i) => i.action.tool_name)).toEqual(['lookup'])
    expect(seen[0].response).toBeUndefined()
  })

  // Review finding 1. An actor that only ever proposes `Return`: the allowlist
  // refuses it, the critic never sees it, and it must not become the answer.
  // Mutation: read the thread's `controller_action` events for a `Return` (the
  // first design) → `response` is the refused text.
  it('an actorCritic Return that was refused and never reviewed is not the answer', async () => {
    const seen: CompactExecutionInput[] = []
    const actor = async () => ({
      action: act('Return', 'FABRICATED: report saved to /out/r.docx'),
      llmCall: undefined,
    })
    const critic = async () => ({
      result: { is_sufficient: true, explanation: 'ok' },
      llmCall: undefined,
    })
    const pattern = actorCritic<Data>(actor, critic, ['lookup'], {
      patternId: 'execute',
      maxRetries: 3,
    })
    await withRunFrame({}, () => runChain(ctxOf('q'), [pattern, synth(seen)]))
    expect(seen[0].response).toBeUndefined()
  })

  // Review finding 2. A window wider than one turn: turn 1 was Return-only,
  // turn 2's controller throws (no Return of its own). Turn 1's text must not
  // answer turn 2. Mutation: the `findLast` over the thread's events (first
  // design, window-wide) → 'OLD ANSWER'.
  it('a previous turn’s Return does not answer this turn, under a two-turn window', async () => {
    const seen: CompactExecutionInput[] = []
    const build = (script: Array<ControllerAction | Error>) => [scripted(script), synth(seen, 2)]
    const first = await withRunFrame({}, () =>
      harness<Data>(...build([act('Return', 'OLD ANSWER')]))('first'),
    )
    expect(seen[0].response).toBe('OLD ANSWER')
    await withRunFrame({}, () =>
      continueSession<Data>(first.serialized, build([new Error('boom')]), 'second'),
    )
    expect(seen[1].response).toBeUndefined()
  })

  // The same, for a turn in which NO loop runs at all (nothing to clear the
  // key but `continueSession`). Mutation: delete `delete …returnText` in
  // `continueSession` → `response` is 'OLD ANSWER'.
  it('continueSession clears the key: a turn with no loop is not answered by the last one', async () => {
    const seen: CompactExecutionInput[] = []
    const first = await withRunFrame({}, () =>
      harness<Data>(scripted([act('Return', 'OLD ANSWER')]), synth(seen, 2))('first'),
    )
    expect(seen[0].response).toBe('OLD ANSWER')
    await withRunFrame({}, () =>
      continueSession<Data>(first.serialized, [synth(seen, 2)], 'second'),
    )
    expect(seen[1].response).toBeUndefined()
  })

  // Same, without the harness: a loop that ends WITHOUT a Return clears the
  // key itself (an earlier loop in the same turn). Mutation: delete the
  // start-of-loop clear in simpleLoop → 'EARLIER LOOP' answers.
  it('a loop that ends without a Return does not inherit an earlier loop’s text', async () => {
    const seen: CompactExecutionInput[] = []
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [
        scripted([act('Return', 'EARLIER LOOP')]),
        simpleLoop<Data>(
          async () => {
            throw new Error('boom')
          },
          ['lookup'],
          { patternId: 'execute', maxTurns: 3 },
        ),
        synth(seen),
      ]),
    )
    expect(seen[0].response).toBeUndefined()
  })

  // Mutation: drop the `data.response ??` precedence → upstream response is
  // overwritten by the Return text.
  it('an explicit data.response still wins', async () => {
    const seen: CompactExecutionInput[] = []
    const setter = configurePattern<Data>(
      'setter',
      async (scope) => {
        scope.data = { ...scope.data, response: 'from upstream' }
        return scope
      },
      { patternId: 'setter' },
    )
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [scripted([act('Return', 'controller text')]), setter, synth(seen)]),
    )
    expect(seen[0].response).toBe('from upstream')
  })

  // Mutation: drop the `.trim()` emptiness check → whitespace reaches the
  // synthesizer as a response.
  it('an empty Return leaves the input as it was', async () => {
    const seen: CompactExecutionInput[] = []
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [scripted([act('Return', '  ')]), synth(seen)]),
    )
    expect(seen[0].response).toBeUndefined()
  })
})
