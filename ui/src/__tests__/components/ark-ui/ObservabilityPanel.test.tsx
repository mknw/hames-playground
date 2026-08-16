/**
 * ObservabilityPanel — the Context manager timeline.
 *
 * Three behaviours carry the panel and are what these tests pin:
 *
 *  1. The summary bar's fold over `event.metrics` (#122) — session token and
 *     cost accounting, including the legacy fallback to `llmCall.usage` for
 *     events recorded before metrics existed.
 *  2. Timeline construction — a `tool_call` and its `tool_result` merge into a
 *     single row by `callId`; pattern enter/exit become dividers; everything
 *     else lands in the Interface or Tools lane.
 *  3. The drill-down — clicking a row opens the detail overlay, which picks a
 *     renderer per event type and, for LLM-backed events, a Prompt/Output tab
 *     pair over the captured BAML template, variables and rendered messages.
 *
 * Everything is driven through the rendered DOM; the helpers only locate rows
 * and read text, so the assertions stay on what an operator would see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import type { ContextEvent, EventMetrics, LLMCallData } from '~/lib/harness-patterns'

const { ObservabilityPanel } = await import('../../../components/ark-ui/ObservabilityPanel')

const tick = () => new Promise((r) => setTimeout(r, 30))

let seq = 0
const ev = (
  type: ContextEvent['type'],
  data: unknown,
  extra: Partial<ContextEvent> = {},
): ContextEvent => ({ type, ts: ++seq, patternId: 'neo4j-query', data, ...extra })

const metrics = (m: Partial<EventMetrics> = {}): EventMetrics => ({
  inputUncachedTokens: 1000,
  inputCacheReadTokens: 0,
  inputCacheWriteTokens: 0,
  outputTokens: 200,
  attempts: 1,
  ...m,
})

/** Every clickable timeline row, in render order. */
const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('div[cursor="pointer"][w="full"]'),
]

/** The drill-down overlay, scoped to one rendered panel. */
const detailIn = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>('div')].find(
    (d) => d.style.position === 'absolute' && d.style.zIndex === '50',
  )
const detail = () => detailIn(document)

beforeEach(() => {
  seq = 0
})

describe('ObservabilityPanel — summary bar', () => {
  it('reports a full success rate and no clear button for an empty session', () => {
    const { container, getByText } = render(() => <ObservabilityPanel events={[]} />)

    expect(container.textContent).toContain('100%')
    expect(getByText('No events yet')).toBeTruthy()
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Clear',
    )
  })

  it('derives the success rate from tool results and counts errors separately', () => {
    const events = [
      ev('tool_result', { tool: 'a', success: true, result: {} }),
      ev('tool_result', { tool: 'b', success: true, result: {} }),
      ev('tool_result', { tool: 'c', success: false, error: 'boom' }),
      ev('error', { error: 'exploded' }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    expect(container.textContent).toContain('67%')
    expect(container.textContent).toContain('Errors:')
  })

  it('hides the error counter when nothing failed', () => {
    const { container } = render(() => (
      <ObservabilityPanel events={[ev('tool_result', { tool: 'a', success: true, result: {} })]} />
    ))
    expect(container.textContent).not.toContain('Errors:')
  })

  it('folds per-event metrics into session token totals, abbreviating thousands', () => {
    const events = [
      ev(
        'controller_action',
        { action: { tool_name: 'x' } },
        { metrics: metrics({ inputUncachedTokens: 12_500, outputTokens: 400 }) },
      ),
      ev(
        'controller_action',
        { action: { tool_name: 'y' } },
        { metrics: metrics({ inputUncachedTokens: 12_500, outputTokens: 300 }) },
      ),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    expect(container.textContent).toContain('25.0k')
    expect(container.textContent).toContain('700')
  })

  it('breaks out cache reads and writes and the cached share of input', () => {
    const events = [
      ev(
        'controller_action',
        { action: { tool_name: 'x' } },
        {
          metrics: metrics({
            inputUncachedTokens: 1000,
            inputCacheReadTokens: 3000,
            inputCacheWriteTokens: 0,
          }),
        },
      ),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    expect(container.textContent).toContain('Cached:')
    expect(container.textContent).toContain('75%')
    expect(container.textContent).toContain('+3.0k⚡')
  })

  it('shows cost and the caching saving when the events are priced', () => {
    const events = [
      ev(
        'controller_action',
        { action: { tool_name: 'x' } },
        { metrics: metrics({ costUsd: 0.25, noCacheUsd: 0.5 }) },
      ),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    expect(container.textContent).toContain('$0.25')
    expect(container.textContent).toContain('−50%')
  })

  it('keeps sub-cent costs at four decimals', () => {
    const events = [
      ev(
        'controller_action',
        { action: { tool_name: 'x' } },
        { metrics: metrics({ costUsd: 0.0123 }) },
      ),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)
    expect(container.textContent).toContain('$0.0123')
  })

  it('surfaces retries when a step needed more API calls than steps', () => {
    const events = [
      ev(
        'controller_action',
        { action: { tool_name: 'x' } },
        { metrics: metrics({ attempts: 3 }) },
      ),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    expect(container.textContent).toContain('Retries:')
    expect(container.textContent).toContain('+2')
  })

  it('falls back to llmCall.usage for events recorded before metrics existed', () => {
    const events = [
      ev(
        'assistant_message',
        { content: 'hi' },
        {
          llmCall: {
            functionName: 'Synthesize',
            variables: {},
            usage: {
              inputTokens: 2000,
              outputTokens: 500,
              cachedInputTokens: 0,
              totalTokens: 2500,
            },
          },
        },
      ),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    expect(container.textContent).toContain('2.0k')
    expect(container.textContent).toContain('500')
    // No pricing is inferred from a legacy usage block.
    expect(container.textContent).not.toContain('Cost:')
  })

  it('shows no token row at all when nothing called an LLM', () => {
    const { container } = render(() => (
      <ObservabilityPanel events={[ev('user_message', { content: 'hi' })]} />
    ))
    expect(container.textContent).not.toContain('Out:')
  })

  it('forwards the Clear button to the owner', () => {
    const onClear = vi.fn()
    const { getByText } = render(() => (
      <ObservabilityPanel events={[ev('user_message', { content: 'hi' })]} onClear={onClear} />
    ))

    fireEvent.click(getByText('Clear'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('ObservabilityPanel — timeline construction', () => {
  it('sorts events oldest-first regardless of arrival order', () => {
    const late = ev('user_message', { content: 'second' })
    const early = { ...ev('user_message', { content: 'first' }), ts: 0 }
    const { container } = render(() => <ObservabilityPanel events={[late, early]} />)

    expect(rows(container).map((r) => r.textContent)).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
    ])
  })

  it('merges a tool_call with its result into one row and drops the separate result', () => {
    const events = [
      ev('tool_call', { callId: 'c1', tool: 'read_neo4j_cypher', args: { q: 1 } }),
      ev('tool_result', {
        callId: 'c1',
        tool: 'read_neo4j_cypher',
        success: true,
        result: { rows: [] },
      }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    const texts = rows(container).map((r) => r.textContent)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('read_neo4j_cypher: ok')
  })

  it('marks a merged pair as an error when the result failed', () => {
    const events = [
      ev('tool_call', { callId: 'c1', tool: 'write_neo4j_cypher', args: {} }),
      ev('tool_result', {
        callId: 'c1',
        tool: 'write_neo4j_cypher',
        success: false,
        error: 'nope',
      }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)
    expect(rows(container)[0].textContent).toContain('write_neo4j_cypher: error')
  })

  it('leaves a call and a mismatched result as two separate rows', () => {
    const events = [
      ev('tool_call', { callId: 'c1', tool: 'slow_tool', args: {} }),
      ev('tool_result', { callId: 'other', tool: 'slow_tool', success: true, result: {} }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    const texts = rows(container).map((r) => r.textContent)
    expect(texts).toHaveLength(2)
    // The unpaired call keeps the bare tool-name preview...
    expect(texts[0]).toContain('tool call')
    // ...and the orphan result reports its own outcome.
    expect(texts[1]).toContain('slow_tool: ok')
  })

  it('leaves a callId-less tool_call as a standalone row', () => {
    const { container } = render(() => (
      <ObservabilityPanel events={[ev('tool_call', { tool: 'anon_tool', args: {} })]} />
    ))
    expect(rows(container)[0].textContent).toContain('anon_tool')
  })

  it('renders pattern boundaries as dividers rather than clickable rows', () => {
    const events = [
      ev('pattern_enter', {}, { patternId: 'neo4j-query' }),
      ev('user_message', { content: 'hello' }),
      ev('pattern_exit', {}, { patternId: 'neo4j-query' }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    expect(rows(container)).toHaveLength(1)
    expect(container.textContent).toContain('enter')
    expect(container.textContent).toContain('exit')
    expect(container.textContent).toContain('neo4j-query')
  })

  it('tints events inside a pattern and leaves outside ones untinted', () => {
    const events = [
      ev('user_message', { content: 'outside' }, { patternId: 'harness' }),
      ev('pattern_enter', {}, { patternId: 'neo4j-query' }),
      ev('tool_call', { tool: 'inside', args: {} }),
      ev('pattern_exit', {}, { patternId: 'neo4j-query' }),
      ev('assistant_message', { content: 'after' }, { patternId: 'harness' }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    const tints = rows(container).map((r) => r.parentElement!.parentElement!.style.backgroundColor)
    // outside → transparent, inside the pattern → the pattern's tint, after
    // exit → transparent again (the stack popped).
    expect(tints[0]).toBe('transparent')
    expect(tints[1]).toMatch(/^rgba?\(/)
    expect(tints[2]).toBe('transparent')
  })

  it('splits events across the Interface and Tools lanes', () => {
    const events = [ev('user_message', { content: 'hi' }), ev('tool_call', { tool: 't', args: {} })]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    // Each row is a two-column strip; the occupied column identifies the lane.
    const [userRow, toolRow] = rows(container).map((r) => r.parentElement!)
    expect(userRow.previousElementSibling).toBeNull() // first (interface) column
    expect(toolRow.previousElementSibling).not.toBeNull() // second (tools) column
  })

  it('drops a malformed event with no type instead of throwing', () => {
    const broken = { ts: 1, patternId: 'harness', data: {} } as unknown as ContextEvent
    const { container } = render(() => (
      <ObservabilityPanel events={[broken, ev('user_message', { content: 'ok' })]} />
    ))
    expect(rows(container)).toHaveLength(1)
  })

  it('truncates long message previews on the row', () => {
    const long = 'y'.repeat(90)
    const { container } = render(() => (
      <ObservabilityPanel events={[ev('user_message', { content: long })]} />
    ))
    expect(rows(container)[0].textContent).toContain('y'.repeat(50) + '...')
  })

  it('flags a batched controller action with its extra calls', () => {
    const events = [
      ev('controller_action', {
        action: {
          tool_name: 'first_tool',
          tool_args: '{}',
          additional_calls: [{ tool_name: 'second_tool', tool_args: '{}' }],
        },
      }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)
    expect(rows(container)[0].textContent).toContain('⚡×2 first_tool, second_tool')
  })

  it('previews approval requests, errors and compacted intents on their rows', () => {
    const events = [
      ev('approval_request', { request: { action: 'delete everything' } }),
      ev('error', { error: 'a catastrophic failure happened' }),
      ev('intent_compacted', { intent: 'find the concepts' }),
      ev('critic_result', { verdict: 'ok' }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    const text = rows(container)
      .map((r) => r.textContent)
      .join('|')
    expect(text).toContain('delete everything')
    expect(text).toContain('a catastrophic failure happened')
    expect(text).toContain('find the concepts')
    // critic_result has no preview mapping — the row still renders its type.
    expect(text).toContain('critic result')
  })
})

describe('ObservabilityPanel — detail drill-down', () => {
  const openFirstRow = (container: HTMLElement) => {
    fireEvent.click(rows(container)[0])
    return detail()!
  }

  it('opens and closes the overlay for a plain event', () => {
    const { container, getByText } = render(() => (
      <ObservabilityPanel events={[ev('user_message', { content: 'the whole message body' })]} />
    ))

    const panel = openFirstRow(container)
    expect(panel.textContent).toContain('the whole message body')
    expect(panel.textContent).toContain('user')

    fireEvent.click(getByText('Close'))
    expect(detail()).toBeUndefined()
  })

  it('shows tool name, arguments, status and result for a merged tool pair', () => {
    const events = [
      ev('tool_call', { callId: 'c1', tool: 'read_neo4j_cypher', args: { cypher: 'MATCH (n)' } }),
      ev('tool_result', {
        callId: 'c1',
        tool: 'read_neo4j_cypher',
        success: true,
        result: { rows: [1, 2] },
      }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    const panel = openFirstRow(container)
    expect(panel.textContent).toContain('MATCH (n)')
    expect(panel.textContent).toContain('Success')
    expect(panel.textContent).toContain('"rows"')
  })

  it('reports the error message for a failed tool pair', () => {
    const events = [
      ev('tool_call', { callId: 'c1', tool: 'write_neo4j_cypher', args: {} }),
      ev('tool_result', {
        callId: 'c1',
        tool: 'write_neo4j_cypher',
        success: false,
        error: 'constraint violated',
      }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)
    expect(openFirstRow(container).textContent).toContain('Error: constraint violated')
  })

  it('renders a pending tool pair without a result section', () => {
    const { container } = render(() => (
      <ObservabilityPanel events={[ev('tool_call', { callId: 'c1', tool: 't', args: { a: 1 } })]} />
    ))
    const panel = openFirstRow(container)
    expect(panel.textContent).toContain('Arguments')
    expect(panel.textContent).not.toContain('Status')
  })

  it('renders a standalone tool_result detail', () => {
    const { container } = render(() => (
      <ObservabilityPanel
        events={[
          ev('tool_result', {
            tool: 'search_nodes',
            success: false,
            error: 'timeout',
            result: null,
          }),
        ]}
      />
    ))
    const panel = openFirstRow(container)
    expect(panel.textContent).toContain('search_nodes')
    expect(panel.textContent).toContain('Error: timeout')
  })

  it('renders a controller action with reasoning, batched calls and status', () => {
    const events = [
      ev('controller_action', {
        action: {
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"cypher":"MATCH (n)"}',
          reasoning: 'need the node list first',
          is_final: false,
          status: 'continue',
          additional_calls: [{ tool_name: 'get_neo4j_schema', tool_args: '{}' }],
        },
      }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    const panel = openFirstRow(container)
    expect(panel.textContent).toContain('need the node list first')
    expect(panel.textContent).toContain('Additional calls (same turn)')
    expect(panel.textContent).toContain('get_neo4j_schema')
    expect(panel.textContent).toContain('continue')
    expect(panel.textContent).toContain('No') // is_final
  })

  it('omits the optional action sections when the controller sent none', () => {
    const events = [
      ev('controller_action', { action: { tool_name: 't', tool_args: '{}', is_final: true } }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    const panel = openFirstRow(container)
    expect(panel.textContent).not.toContain('Reasoning')
    expect(panel.textContent).not.toContain('Additional calls')
    expect(panel.textContent).toContain('Yes')
  })

  it('renders an error detail with severity, turn, iteration and hint', () => {
    const events = [
      ev('error', {
        error: 'BamlValidationError: missing status',
        severity: 'irrecoverable',
        turn: 2,
        iteration: 5,
        hint: 'the response was truncated',
      }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    const panel = openFirstRow(container)
    expect(panel.textContent).toContain('BamlValidationError: missing status')
    expect(panel.textContent).toContain('irrecoverable')
    expect(panel.textContent).toContain('Turn')
    expect(panel.textContent).toContain('Iteration')
    expect(panel.textContent).toContain('the response was truncated')
  })

  it('falls back to a raw JSON dump for an event type with no dedicated view', () => {
    const { container } = render(() => (
      <ObservabilityPanel events={[ev('critic_result', { verdict: 'needs work', score: 3 })]} />
    ))
    const panel = openFirstRow(container)
    expect(panel.textContent).toContain('Data')
    expect(panel.textContent).toContain('"needs work"')
  })

  it('keeps the overlay pinned to the row that was clicked', () => {
    const events = [
      ev('user_message', { content: 'first' }),
      ev('user_message', { content: 'second' }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)

    fireEvent.click(rows(container)[1])
    const panel = detail()!
    expect(panel.textContent).toContain('second')
    expect(panel.textContent).not.toContain('first')
  })
})

describe('ObservabilityPanel — LLM call drill-down', () => {
  const llmCall = (over: Partial<LLMCallData> = {}): LLMCallData => ({
    functionName: 'LoopController',
    variables: { question: 'what concepts exist?' },
    promptTemplate: 'You are a controller. {{ question }}',
    rawInput: JSON.stringify({
      model: 'claude-sonnet-5',
      temperature: 0.2,
      stream: true,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'what concepts exist?' },
      ],
    }),
    parsedOutput: { tool_name: 'read_neo4j_cypher' },
    usage: {
      inputTokens: 1200,
      outputTokens: 250,
      cachedInputTokens: 800,
      cacheCreationInputTokens: 400,
      totalTokens: 2650,
    },
    durationMs: 1430,
    ...over,
  })

  const openLLMRow = (call: LLMCallData, extra: Partial<ContextEvent> = {}) => {
    const events = [
      ev(
        'controller_action',
        { action: { tool_name: 'x', tool_args: '{}' } },
        { llmCall: call, ...extra },
      ),
    ]
    const rendered = render(() => <ObservabilityPanel events={events} />)
    fireEvent.click(rows(rendered.container)[0])
    return detailIn(rendered.container)!
  }

  it('badges the event as LLM-backed and shows the usage breakdown', () => {
    const panel = openLLMRow(llmCall())

    expect(panel.textContent).toContain('LLM')
    expect(panel.textContent).toContain('LoopController')
    expect(panel.textContent).toContain('1,200')
    expect(panel.textContent).toContain('Cache read')
    expect(panel.textContent).toContain('800')
    expect(panel.textContent).toContain('Cache write')
    expect(panel.textContent).toContain('1430ms')
  })

  it('hides the cache rows when nothing was cached', () => {
    const panel = openLLMRow(
      llmCall({
        usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, totalTokens: 110 },
      }),
    )
    expect(panel.textContent).not.toContain('Cache read')
    expect(panel.textContent).not.toContain('Cache write')
  })

  it('shows provider, client, attempts and step cost when the metrics carry them', () => {
    const panel = openLLMRow(
      llmCall({
        provider: 'anthropic',
        clientName: 'ControllerAnthropic',
        metrics: metrics({
          attempts: 2,
          costUsd: 0.031,
          noCacheUsd: 0.06,
          rates: { inPerMTok: 3, outPerMTok: 15 },
        }),
      }),
    )

    expect(panel.textContent).toContain('anthropic')
    expect(panel.textContent).toContain('ControllerAnthropic')
    expect(panel.textContent).toContain('Attempts')
    expect(panel.textContent).toContain('$0.0310')
  })

  it('parses the captured request body into per-role messages plus a params bar', () => {
    const panel = openLLMRow(llmCall())

    expect(panel.textContent).toContain('claude-sonnet-5')
    expect(panel.textContent).toContain('temperature')
    // `stream` is deliberately filtered out of the params bar.
    expect(panel.textContent).not.toContain('stream')
    expect(panel.textContent).toContain('2 messages')
    expect(panel.textContent).toContain('be brief')
  })

  it('shows the BAML template and variables in the prompt accordion', () => {
    const panel = openLLMRow(llmCall())
    expect(panel.textContent).toContain('You are a controller. {{ question }}')
    expect(panel.textContent).toContain('1 input')
  })

  it('explains a missing template and a missing request body', () => {
    const panel = openLLMRow(
      llmCall({ promptTemplate: undefined, rawInput: undefined, variables: {} }),
    )

    expect(panel.textContent).toContain('BAML prompt template not captured')
    expect(panel.textContent).toContain('HTTP request body not captured')
    expect(panel.textContent).toContain('No variables passed to this function')
    expect(panel.textContent).toContain('0 inputs')
  })

  it('falls back to the raw body when it is not an OpenAI-shaped payload', () => {
    const panel = openLLMRow(llmCall({ rawInput: 'not json at all' }))
    expect(panel.textContent).toContain('not json at all')
  })

  it('treats a JSON body without a messages array as unparseable', () => {
    const panel = openLLMRow(llmCall({ rawInput: '{"prompt":"legacy completion"}' }))
    // No per-role message cards — the raw body is shown as-is.
    expect(panel.textContent).toContain('{"prompt":"legacy completion"}')
    expect(panel.textContent).not.toContain('0 messages')
  })

  it('serialises a structured message content block', () => {
    const panel = openLLMRow(
      llmCall({
        rawInput: JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'block form' }] }],
        }),
      }),
    )
    expect(panel.textContent).toContain('block form')
    expect(panel.textContent).toContain('1 message')
  })

  it('switches to the Output tab and pretty-prints the parsed result', () => {
    const panel = openLLMRow(llmCall())

    fireEvent.click([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Output')!)
    expect(panel.textContent).toContain('"read_neo4j_cypher"')
    expect(panel.textContent).not.toContain('You are a controller')
  })

  it('shows a string output verbatim and reports an uncaptured one', () => {
    const stringPanel = openLLMRow(llmCall({ parsedOutput: 'plain text answer' }))
    fireEvent.click(
      [...stringPanel.querySelectorAll('button')].find((b) => b.textContent === 'Output')!,
    )
    expect(stringPanel.textContent).toContain('plain text answer')

    const emptyPanel = openLLMRow(llmCall({ parsedOutput: undefined }))
    fireEvent.click(
      [...emptyPanel.querySelectorAll('button')].find((b) => b.textContent === 'Output')!,
    )
    expect(emptyPanel.textContent).toContain('Output not captured')
  })

  it('does not duplicate the message body under the LLM tabs for a message event', () => {
    const events = [
      ev(
        'assistant_message',
        { content: 'the synthesised answer' },
        { llmCall: llmCall({ functionName: 'Synthesize' }) },
      ),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)
    fireEvent.click(rows(container)[0])

    const panel = detail()!
    expect(panel.textContent).toContain('Synthesize')
    // The MessageDetail block (Role/Content) is suppressed in favour of the tabs.
    expect(panel.textContent).not.toContain('Role')
  })

  it('shows the LLM badge on a merged tool pair whose call carried an LLM step', () => {
    const events = [
      ev('tool_call', { callId: 'c1', tool: 't', args: {} }, { llmCall: llmCall() }),
      ev('tool_result', { callId: 'c1', tool: 't', success: true, result: {} }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)
    fireEvent.click(rows(container)[0])

    expect(detail()!.textContent).toContain('LoopController')
  })
})

describe('ObservabilityPanel — save session', () => {
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL

  afterEach(() => {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    delete (window as Record<string, unknown>).showSaveFilePicker
    vi.restoreAllMocks()
  })

  const clickSave = async (container: HTMLElement) => {
    const trigger = container.querySelector<HTMLElement>('[data-part="trigger"]')!
    fireEvent.click(trigger)
    await tick()
  }

  it('offers no save affordance for an empty session', () => {
    const { container } = render(() => <ObservabilityPanel events={[]} />)
    expect(container.querySelector('[data-part="trigger"]')).toBeNull()
  })

  it('falls back to a download anchor when the file picker is unavailable', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    URL.revokeObjectURL = vi.fn()
    const clicks: HTMLAnchorElement[] = []
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = create(tag)
      if (tag === 'a') {
        const anchor = el as HTMLAnchorElement
        anchor.click = () => clicks.push(anchor)
      }
      return el
    })

    const { container } = render(() => (
      <ObservabilityPanel events={[ev('user_message', { content: 'hi' })]} />
    ))
    await clickSave(container)

    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(clicks).toHaveLength(1)
    expect(clicks[0].download).toMatch(/^context-session-\d{4}-\d{2}-\d{2}\.json$/)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake')
  })

  it('names the file after the session and writes the whole context through the picker', async () => {
    const written: string[] = []
    const writable = {
      write: vi.fn(async (s: string) => void written.push(s)),
      close: vi.fn(async () => {}),
    }
    const picker = vi.fn(async () => ({ createWritable: async () => writable }))
    ;(window as Record<string, unknown>).showSaveFilePicker = picker

    const events = [ev('user_message', { content: 'hi' })]
    const context = {
      sessionId: 'sess-42',
      createdAt: 0,
      events,
      status: 'running' as const,
      data: {},
      input: 'hi',
    }
    const { container } = render(() => <ObservabilityPanel events={events} context={context} />)
    await clickSave(container)

    expect(picker.mock.calls[0][0]).toMatchObject({
      suggestedName: expect.stringContaining('context-sess-42-'),
    })
    expect(JSON.parse(written[0]).sessionId).toBe('sess-42')
    expect(writable.close).toHaveBeenCalledOnce()
  })

  it('stays quiet when the user cancels the save dialog', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    ;(window as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => {
      throw abort
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { container } = render(() => (
      <ObservabilityPanel events={[ev('user_message', { content: 'hi' })]} />
    ))
    await clickSave(container)

    expect(consoleError).not.toHaveBeenCalled()
  })

  it('logs a genuine save failure', async () => {
    ;(window as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => {
      throw new Error('disk full')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { container } = render(() => (
      <ObservabilityPanel events={[ev('user_message', { content: 'hi' })]} />
    ))
    await clickSave(container)

    expect(consoleError).toHaveBeenCalledWith('Save failed', expect.any(Error))
  })
})

describe('ObservabilityPanel — live updates', () => {
  it('grows the timeline and the totals as events stream in', () => {
    const [events, setEvents] = createSignal<ContextEvent[]>([
      ev('user_message', { content: 'hi' }),
    ])
    const { container } = render(() => <ObservabilityPanel events={events()} />)

    expect(rows(container)).toHaveLength(1)

    setEvents([
      ...events(),
      ev('tool_call', { callId: 'c1', tool: 'read_neo4j_cypher', args: {} }),
      ev('tool_result', { callId: 'c1', tool: 'read_neo4j_cypher', success: true, result: {} }),
    ])

    expect(rows(container)).toHaveLength(2)
    expect(container.textContent).toContain('read_neo4j_cypher: ok')
  })
})
