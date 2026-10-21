/**
 * compactExecution `thread` mode honours `viewConfig.fromPatterns` (#507 S2).
 *
 * The failure it closes: `thread` mode read its history through
 * `view.fromLastPattern()`. In the nested shape — a wrapper (`orchestrator`)
 * whose child patterns run under fresh nested views — the last pattern to
 * ENTER is the last child, not the wrapper, so the read selected the child's
 * internal trace. With `viewConfig.fromPatterns: ['orchestrator']` the view's
 * own scope filter and `fromLastPattern()`'s filter AND together to nothing,
 * and the synthesizer silently dropped to `response` mode with no history.
 *
 * Each test names the source mutation that reddens it; every one was run.
 */

import { describe, expect, it } from 'vitest'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import { configurePattern, runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import { createEvent, createScope } from '@hames-ai/harness-patterns/context.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type {
  CompactExecutionInput,
  ConfiguredPattern,
  ContextEvent,
  UnifiedContext,
} from '@hames-ai/harness-patterns/types'

type Data = Record<string, unknown>

/** A leaf that leaves a controller_action + tool_result pair tagged with its own id. */
function leaf(patternId: string, tool: string, result: unknown): ConfiguredPattern<Data> {
  return configurePattern<Data>(
    'leaf',
    async (scope) => {
      scope.events.push(
        createEvent('controller_action', scope.id, {
          action: {
            reasoning: '',
            tool_name: tool,
            tool_args: '{}',
            status: 'ok',
            is_final: false,
          },
        }),
        createEvent('tool_result', scope.id, { tool, result, success: true }),
      )
      return scope
    },
    { patternId },
  )
}

/**
 * A wrapper in the shape `decisionLoop` will have: each child runs in a child
 * scope under a fresh nested view (the way `chain` does it), then the wrapper
 * records ONE route-output record per child under its OWN id.
 */
function wrapper(patternId: string, children: ConfiguredPattern<Data>[]): ConfiguredPattern<Data> {
  return configurePattern<Data>(
    'wrapper',
    async (scope, view) => {
      const outerCtx = (view as unknown as { ctx: UnifiedContext }).ctx
      for (const child of children) {
        const subId = child.config.patternId!
        scope.events.push(createEvent('pattern_enter', subId, { pattern: child.name }))
        const synthetic: UnifiedContext = {
          ...outerCtx,
          events: [...outerCtx.events, ...scope.events] as ContextEvent[],
        }
        const childScope = createScope<Data>(subId, scope.data)
        const result = await child.fn(childScope, createEventView(synthetic, undefined, subId))
        scope.events.push(...result.events)
        scope.events.push(createEvent('pattern_exit', subId, { status: 'completed' }))
        scope.events.push(
          createEvent('controller_action', patternId, {
            action: {
              reasoning: '',
              tool_name: `route:${subId}`,
              tool_args: '',
              status: 'ok',
              is_final: false,
            },
          }),
          createEvent('tool_result', patternId, {
            tool: `route:${subId}`,
            result: `output of ${subId}`,
            success: true,
          }),
        )
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

function capture(viewConfig?: import('@hames-ai/harness-patterns/types').ViewConfig) {
  const seen: CompactExecutionInput[] = []
  const pattern = compactExecution<Data>({
    mode: 'thread',
    patternId: 'response-synth',
    viewConfig,
    synthesize: async (input) => {
      seen.push(input)
      return { value: 'answer' }
    },
  })
  return { seen, pattern }
}

const tools = (input: CompactExecutionInput) =>
  input.loopHistory?.iterations.map((it) => it.action.tool_name)

describe('compactExecution thread mode — fromPatterns', () => {
  // THE reproduction. Mutation 1: in `buildSynthesisInputFromView`'s thread
  // case, `const threadView = view.fromLastPattern()` unconditionally (the
  // pre-fix code) → the last pattern is the child `doc`, which the view's
  // `fromPatterns` scope excludes, so `loopHistory` is undefined and `mode`
  // drops to 'response'. Mutation 2: `const threadView = view.unfiltered()` →
  // the children's internal traces (`child_trace_*`) join the thread.
  it('nested shape: reads the wrapper’s route-output records, not the children’s traces', async () => {
    const { seen, pattern } = capture({ fromPatterns: ['orchestrator'], fromLastNTurns: 1 })
    const orchestrator = wrapper('orchestrator', [
      leaf('info', 'child_trace_a', 'a'),
      leaf('doc', 'child_trace_b', 'b'),
    ])
    await withRunFrame({}, () => runChain(ctxOf('q'), [orchestrator, pattern]))

    expect(seen).toHaveLength(1)
    expect(seen[0].mode).toBe('thread')
    // Both records, in order, and nothing from the children's internal traces.
    expect(tools(seen[0])).toEqual(['route:info', 'route:doc'])
  })

  // The turn window the caller declared still applies. Mutation 3:
  // `const threadView = scopedToPatterns ? view.unfiltered().fromPatterns(['orchestrator']) : …`
  // (honours the ids, drops the rest of the config) → turn 1's record leaks.
  it('keeps the caller’s fromLastNTurns window: a previous turn’s records do not leak', async () => {
    const { seen, pattern } = capture({ fromPatterns: ['orchestrator'], fromLastNTurns: 1 })
    const ctx = ctxOf('first question')
    await withRunFrame({}, async () => {
      await runChain(ctx, [wrapper('orchestrator', [leaf('info', 'x', 1)])])
      ctx.events.push(createEvent('user_message', 'harness', { content: 'second question' }))
      const second = wrapper('orchestrator', [leaf('doc', 'y', 2)])
      await runChain(ctx, [second, pattern])
    })

    expect(tools(seen[0])).toEqual(['route:doc'])
  })

  // Review finding 1: no `fromLastNTurns` declared (SPEC's own example shape).
  // Mutation 5: the pre-round-1 `scopedToPatterns ? view : …` (no turn bound) →
  // turn 1's call joins the thread (`['turn1_call', 'turn2_call']`).
  it('fromPatterns with no fromLastNTurns still bounds the thread to the current turn', async () => {
    const { seen, pattern } = capture({ fromPatterns: ['loop'] })
    const ctx = ctxOf('first question')
    await withRunFrame({}, async () => {
      await runChain(ctx, [leaf('loop', 'turn1_call', 1)])
      ctx.events.push(createEvent('user_message', 'harness', { content: 'second question' }))
      await runChain(ctx, [leaf('loop', 'turn2_call', 2), pattern])
    })

    expect(tools(seen[0])).toEqual(['turn2_call'])
  })

  // Review finding 2: the removed `general` agent's viewConfig, kept as a fixture.
  // A HITL resume re-enters the paused pattern with NO new user_message, so
  // `execute` runs twice in one turn; the thread now reads BOTH executions
  // (pre-fix: only the last). Mutation 1 (`view.fromLastPattern()`) → only
  // `['post_resume']`.
  it('general\u2019s viewConfig: every execution of `execute` within the turn is read (HITL resume)', async () => {
    const { seen, pattern } = capture({
      fromPatterns: ['harness', 'execute'],
      fromLastNTurns: 1,
      eventTypes: ['user_message', 'controller_action', 'tool_call', 'tool_result', 'error'],
    })
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [
        leaf('execute', 'pre_pause', 1),
        leaf('execute', 'post_resume', 2),
        pattern,
      ]),
    )

    expect(tools(seen[0])).toEqual(['pre_pause', 'post_resume'])
  })

  // The flat shape keeps its meaning: with no `fromPatterns`, `thread` reads the
  // last pattern to enter only. `fromLast: false` leaves the bare view
  // unfiltered, so only `fromLastPattern()` narrows it. Mutation 4:
  // `const threadView = view` unconditionally → both loops are read
  // (`['one', 'two']`).
  it('without fromPatterns, thread still reads only the last pattern entered', async () => {
    const { seen, pattern } = capture({ fromLast: false })
    await withRunFrame({}, () =>
      runChain(ctxOf('q'), [leaf('first', 'one', 1), leaf('second', 'two', 2), pattern]),
    )

    expect(tools(seen[0])).toEqual(['two'])
  })
})
