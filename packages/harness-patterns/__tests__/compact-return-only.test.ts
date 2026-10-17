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
import type { ToolTransport } from '@hames-ai/harness-patterns/tool-transport.server'
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

/**
 * A failed tool call then a `Return` keeps the answer (#614). The failed call is
 * a real iteration, so `loopHistory` stays (the error is the synthesizer's only
 * record of it) and the text rides beside it as `returnText` — never as
 * `response`, which a history-reading synthesizer ignores.
 */
describe('compactExecution — failed tool calls then a Return', () => {
  /** `ok` succeeds, `bad` and `lookup` fail; owns them, so nothing reaches MCP. */
  const okBad: ToolTransport = {
    id: 'ok-bad',
    ownsTool: (n) => n === 'ok' || n === 'bad' || n === 'lookup',
    callTool: async (n) =>
      n === 'ok'
        ? { success: true, data: { n: 1 } }
        : { success: false, data: null, error: 'boom' },
    listTools: async () => [],
  }

  /** A pattern committing one action's events, as simpleLoop records them. */
  const turnOf = (calls: Array<{ success: boolean }>, ret: string | undefined, extra = {}) =>
    configurePattern<Data>(
      'tool-turn',
      async (scope) => {
        for (const c of calls) {
          scope.events.push(
            createEvent('controller_action', scope.id, { action: act('lookup', '{}') }),
            createEvent('tool_result', scope.id, {
              tool: 'lookup',
              result: c.success ? { n: 1 } : null,
              success: c.success,
              ...(c.success ? {} : { error: 'boom' }),
            }),
          )
        }
        if (ret !== undefined) {
          scope.events.push(
            createEvent('controller_action', scope.id, { action: act('Return', ret) }),
          )
        }
        scope.data = { ...scope.data, ...(ret !== undefined ? { returnText: ret } : {}), ...extra }
        return scope
      },
      { patternId: 'execute' },
    )

  // Mutations: (a) never set `input.returnText` → undefined; (b) drop the
  // `!real.some(...)` guard → the next test goes red.
  it('every call failed: the Return text rides beside the error history', async () => {
    const seen: CompactExecutionInput[] = []
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [turnOf([{ success: false }], 'From context: 84.'), synth(seen)]),
    )
    expect(seen[0].loopHistory?.iterations).toHaveLength(1)
    expect(seen[0].returnText).toBe('From context: 84.')
    expect(seen[0].response).toBeUndefined()
  })

  it('a success among the calls keeps the Return a dropped summary', async () => {
    const seen: CompactExecutionInput[] = []
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [
        turnOf([{ success: false }, { success: true }], 'Found it.'),
        synth(seen),
      ]),
    )
    expect(seen[0].loopHistory?.iterations).toHaveLength(2)
    expect(seen[0].returnText).toBeUndefined()
  })

  // Mutation: drop the `data.response === undefined` guard → set.
  it('an explicit data.response still wins', async () => {
    const seen: CompactExecutionInput[] = []
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [
        turnOf([{ success: false }], 'controller text', { response: 'from upstream' }),
        synth(seen),
      ]),
    )
    expect(seen[0].returnText).toBeUndefined()
    expect(seen[0].response).toBe('from upstream')
  })

  // Mutation: drop the `.trim()` check → whitespace is carried.
  it('a blank Return is not carried', async () => {
    const seen: CompactExecutionInput[] = []
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [turnOf([{ success: false }], '  '), synth(seen)]),
    )
    expect(seen[0].returnText).toBeUndefined()
  })

  // A failed call in a loop that never Returned: a previous loop's text (cleared
  // by the second loop's start) must not answer. Hermetic: `lookup` is owned by
  // a failing transport, so nothing reaches the MCP gateway (#614 review, 2).
  // Mutation: stop clearing `returnText` at loop start in simpleLoop →
  // 'EARLIER LOOP' is carried.
  it('an earlier loop’s Return text does not answer a later failed-call loop', async () => {
    const seen: CompactExecutionInput[] = []
    const failingLoop = simpleLoop<Data>(
      async (_c) => ({ action: act('lookup', '{}'), llmCall: undefined }),
      ['lookup'],
      { patternId: 'execute', maxTurns: 1 },
    )
    await withRunFrame({ transports: [okBad] }, () =>
      runChain(ctxOf('bad'), [scripted([act('Return', 'EARLIER LOOP')]), failingLoop, synth(seen)]),
    )
    expect(seen[0].returnText).toBeUndefined()
  })

  // Review finding 1: success counting at the batch and orphan-result sites.
  // Real simpleLoop; `ok` succeeds, `bad` fails.
  const batch = (first: string, second: string): ControllerAction => ({
    ...act(first, '{}'),
    additional_calls: [{ tool_name: second, tool_args: '{}' }],
  })
  const loopThen = (actions: ControllerAction[]) => {
    let i = 0
    return simpleLoop<Data>(
      async () => ({ action: actions[Math.min(i++, actions.length - 1)], llmCall: undefined }),
      ['ok', 'bad'],
      { patternId: 'execute', maxTurns: 4, multiToolCalls: 'parallel' },
    )
  }
  const run1 = async (pattern: ReturnType<typeof loopThen>[]) => {
    const seen: CompactExecutionInput[] = []
    await withRunFrame({ transports: [okBad] }, () =>
      runChain(ctxOf('q'), [...pattern, synth(seen)]),
    )
    return seen[0]
  }

  // Mutation: move `succeeded.add(open)` inside the `openExpected === 1`
  // branch (a batch never counts a success) → returnText is set.
  it('a batch with one good and one failed call keeps the Return a dropped summary', async () => {
    const input = await run1([loopThen([batch('ok', 'bad'), act('Return', 'Found it.')])])
    expect(input.loopHistory?.iterations).toHaveLength(1)
    expect(input.returnText).toBeUndefined()
  })

  // Mutation: `succeeded.add(open)` unconditional → the all-failed batch is
  // read as supported and returnText is undefined.
  it('a batch in which every call failed carries the Return text', async () => {
    const input = await run1([loopThen([batch('bad', 'bad'), act('Return', 'From context.')])])
    expect(input.returnText).toBe('From context.')
  })

  const orphan = (success: boolean) =>
    configurePattern<Data>(
      'orphan',
      async (scope) => {
        scope.events.push(
          createEvent('tool_result', scope.id, {
            tool: 'search',
            result: success ? { hits: 1 } : null,
            success,
            ...(success ? {} : { error: 'boom' }),
          }),
        )
        return scope
      },
      { patternId: 'execute' },
    )

  // Mutations: orphan site "always counts a success" → the failed-orphan test
  // goes red; "never counts one" → the successful-orphan test goes red.
  it('a successful orphan tool_result (retriever shape) keeps the Return dropped', async () => {
    const input = await run1([
      orphan(true),
      loopThen([act('bad', '{}'), act('Return', 'Summary.')]),
    ])
    expect(input.returnText).toBeUndefined()
  })

  it('a failed orphan tool_result does not support the Return', async () => {
    const input = await run1([
      orphan(false),
      loopThen([act('bad', '{}'), act('Return', 'From context.')]),
    ])
    expect(input.returnText).toBe('From context.')
  })

  // Review finding 3 (also closes #612's D2). A two-turn window keeps turn 1's
  // SUCCESSFUL record; turn 2's own calls all fail, then it Returns. The text is
  // turn 2's and must be carried. Mutation: `real.some(succeeded)` without the
  // `mine` check → undefined.
  it('an earlier turn’s success does not hide this turn’s all-failed calls', async () => {
    const seen: CompactExecutionInput[] = []
    const build = (actions: ControllerAction[]) => [loopThen(actions), synth(seen, 2)]
    const first = await withRunFrame({ transports: [okBad] }, () =>
      harness<Data>(...build([act('ok', '{}'), act('Return', 'T1 ANSWER')]))('first'),
    )
    await withRunFrame({ transports: [okBad] }, () =>
      continueSession<Data>(
        first.serialized,
        build([act('bad', '{}'), act('Return', 'T2 ANSWER')]),
        'second',
      ),
    )
    expect(seen[1].returnText).toBe('T2 ANSWER')
    // Turn 1's record is still read; only the Return text is turn 2's.
    expect(seen[1].loopHistory?.iterations.map((i) => i.action.tool_name)).toEqual(['ok', 'bad'])
  })
})
