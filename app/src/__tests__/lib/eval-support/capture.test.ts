/** #507: the opt-in trace capture. Synthetic events only; nothing here reaches a model. */
import { describe, it, expect } from 'vitest'
import type { ContextEvent, LLMCallData } from '@hames-ai/harness-patterns'
import type { ConversationTrace } from '../../../lib/eval-support/conversation'
import {
  CAPTURE_ENV,
  CAPTURE_OUTPUT_MAX_CHARS,
  CaptureLog,
  captureEnabled,
  captureTrace,
} from '../../../lib/eval-support/capture'

const call = (functionName: string, rawInput?: string, rawOutput?: string): LLMCallData => ({
  functionName,
  variables: {},
  ...(rawInput !== undefined && { rawInput }),
  ...(rawOutput !== undefined && { rawOutput }),
})
const event = (
  type: string,
  data: unknown,
  llmCall?: LLMCallData,
  patternId = 'orchestrator',
): ContextEvent => ({ type, data, patternId, ts: 0, ...(llmCall && { llmCall }) }) as ContextEvent
const trace = (...turns: ContextEvent[][]): ConversationTrace => ({
  turns: turns.map((events) => ({ response: 'r', status: 'running', events })),
  tools: [],
  artifacts: [],
  indexed: [],
  retrievals: [],
})

const request = JSON.stringify({
  model: 'm',
  state:
    'Conversation (recent turns):\nUser: synthetic question\n\nThis turn so far:\n(nothing yet)',
  questions: {
    next_step: {
      type: 'choice',
      instructions: 'Which step should run next?',
      criteria: { 'read-documents': 'Search documents', answer: 'Answer now' },
    },
  },
})
const decision = (label: string | null, extra: Record<string, unknown> = {}, sent = request) =>
  event(
    'decision_made',
    {
      key: 'next_step',
      question: 'Which step should run next?',
      labels: [
        { id: 'read-documents', description: 'from the event' },
        { id: 'answer', description: 'from the event' },
      ],
      probs: { 'read-documents': 0.25, answer: 0.75 },
      label,
      top: 'answer',
      margin: 0.5,
      abstained: label === null,
      ...extra,
    },
    call('Decide', sent, '{"answers":{}}'),
  )

describe('captureEnabled', () => {
  it('is off by default and for anything but the exact value 1', () => {
    expect(captureEnabled({})).toBe(false)
    for (const value of ['', '0', 'false', 'true', 'yes', ' 1'])
      expect(captureEnabled({ [CAPTURE_ENV]: value })).toBe(false)
    expect(captureEnabled({ [CAPTURE_ENV]: '1' })).toBe(true)
  })
})

describe('captureTrace decisions', () => {
  it('records the request as sent, the choice and the endpoint probabilities, in order per turn', () => {
    const { decisions } = captureTrace(
      trace([decision('answer'), decision('read-documents')], [decision('answer')]),
      false,
    )
    expect(decisions.map((d) => [d.turn, d.decision, d.choice])).toEqual([
      [0, 1, 'answer'],
      [0, 2, 'read-documents'],
      [1, 1, 'answer'],
    ])
    expect(decisions[0]).toMatchObject({
      instructions: 'Which step should run next?',
      // The sent criteria win over the event's labels.
      criteria: { 'read-documents': 'Search documents', answer: 'Answer now' },
      state: expect.stringContaining('User: synthetic question'),
      probs: { 'read-documents': 0.25, answer: 0.75 },
      top: 'answer',
      margin: 0.5,
      abstained: false,
      rawOutput: '{"answers":{}}',
    })
  })

  it('keeps an abstention and a shadow flag, and falls back to the event labels without a request', () => {
    const { decisions } = captureTrace(
      trace([
        decision(null, { shadow: true }, 'not json'),
        event('decision_made', { key: 'next_step', label: 'answer', labels: [] }),
      ]),
      false,
    )
    expect(decisions[0]).toMatchObject({
      choice: null,
      abstained: true,
      shadow: true,
      state: '',
      criteria: { 'read-documents': 'from the event', answer: 'from the event' },
    })
    expect(decisions[1]).toMatchObject({ choice: 'answer', criteria: {}, instructions: '' })
  })
})

describe('captureTrace controller and actor calls', () => {
  const failing = call('LoopController', 'prompt', '{"tool_name":"x"')
  const fine = call('ActorController', 'prompt', '{"tool_name":"Return"}')
  const events = [
    event('error', { error: 'missing is_final' }, failing, 'info'),
    event('controller_action', {}, fine, 'doc'),
    event('controller_action', {}, call('Synthesize', 'p', 'answer'), 'response-synth'),
  ]

  it('records error calls always and every controller/actor call only for a failing scenario', () => {
    expect(captureTrace(trace(events), false).controllerCalls).toEqual([
      {
        turn: 0,
        patternId: 'info',
        functionName: 'LoopController',
        outcome: 'error',
        error: 'missing is_final',
        rawOutput: '{"tool_name":"x"',
      },
    ])
    const all = captureTrace(trace(events), true).controllerCalls
    expect(all.map((c) => [c.functionName, c.outcome])).toEqual([
      ['LoopController', 'error'],
      ['ActorController', 'completion'],
    ])
  })

  // The loops record a recoverable unparseable/refused/invalid-args answer as `loop_recovery`, not
  // `error`, so a capture keyed on `error` alone is blind to the failures it exists to show.
  // MUTATION: restore `event.type === 'error'` alone as `isError` in capture.ts: red.
  it('records a loop_recovery as a recovery row even for a passing scenario', () => {
    const recovery = event(
      'loop_recovery',
      { failure: 'unparseable', error: 'missing is_final', turn: 0, maxTurns: 6 },
      call('LoopController', 'prompt', 'tool_name: Return'),
      'info',
    )
    const mixed = trace([recovery, event('controller_action', {}, fine, 'doc')])
    expect(captureTrace(mixed, false).controllerCalls).toEqual([
      {
        turn: 0,
        patternId: 'info',
        functionName: 'LoopController',
        outcome: 'recovery',
        error: 'missing is_final',
        rawOutput: 'tool_name: Return',
      },
    ])
    // A failing scenario keeps the label too: the recovery is not relabelled a completion.
    expect(captureTrace(mixed, true).controllerCalls.map((c) => c.outcome)).toEqual([
      'recovery',
      'completion',
    ])
  })

  it('never records the prompt, and caps a runaway completion', () => {
    const long = 'x'.repeat(CAPTURE_OUTPUT_MAX_CHARS + 50)
    const [captured] = captureTrace(
      trace([event('error', { error: 'e' }, call('LoopController', 'PROMPT', long))]),
      false,
    ).controllerCalls
    expect(JSON.stringify(captured)).not.toContain('PROMPT')
    expect(captured.rawOutput).toHaveLength(
      CAPTURE_OUTPUT_MAX_CHARS + '…[truncated, 50 more characters]'.length,
    )
  })
})

describe('captureTrace decision output cap', () => {
  // MUTATION: drop `cap()` from the decision's rawOutput in capture.ts: red.
  it('caps a runaway Decide response body like a controller completion', () => {
    const long = 'x'.repeat(CAPTURE_OUTPUT_MAX_CHARS + 1)
    const runaway = event(
      'decision_made',
      { key: 'next_step', label: 'answer' },
      call('Decide', request, long),
    )
    const [captured] = captureTrace(trace([runaway]), false).decisions
    expect(captured.rawOutput).toHaveLength(
      CAPTURE_OUTPUT_MAX_CHARS + '…[truncated, 1 more characters]'.length,
    )
    expect(captured.rawOutput).toContain('…[truncated, 1 more characters]')
  })
})

describe('captureTrace critic verdicts and synthesis', () => {
  const criticCall = (rawOutput?: string): LLMCallData => ({
    functionName: 'Critic',
    variables: {},
    clientName: 'LargeQwen',
    provider: 'openai-generic',
    ...(rawOutput !== undefined && { rawOutput }),
  })

  it('records every critic verdict — a rejection on a passing scenario included', () => {
    const rejected = event(
      'critic_result',
      {
        result: {
          is_sufficient: false,
          explanation: 'the CSV was never written to /work/out',
          suggested_approach: 'run sandbox_write first',
        },
      },
      criticCall('{"is_sufficient":false}'),
      'doc',
    )
    const accepted = event(
      'critic_result',
      { result: { is_sufficient: true, explanation: 'done' } },
      criticCall(),
      'doc',
    )
    expect(captureTrace(trace([rejected, accepted]), false).criticCalls).toEqual([
      {
        turn: 0,
        patternId: 'doc',
        functionName: 'Critic',
        outcome: 'verdict',
        verdict: false,
        reason: 'the CSV was never written to /work/out',
        suggestedApproach: 'run sandbox_write first',
        client: 'LargeQwen',
        provider: 'openai-generic',
        rawOutput: '{"is_sufficient":false}',
      },
      {
        turn: 0,
        patternId: 'doc',
        functionName: 'Critic',
        outcome: 'verdict',
        verdict: true,
        reason: 'done',
        client: 'LargeQwen',
        provider: 'openai-generic',
      },
    ])
  })

  it('names the reasoning twin, and survives a verdict event without a call record', () => {
    const twin = event(
      'critic_result',
      { result: { is_sufficient: true, explanation: 'ok' } },
      {
        ...criticCall(),
        functionName: 'CriticThinking',
      },
    )
    const bare = event('critic_result', { result: { is_sufficient: true, explanation: 'ok' } })
    const rows = captureTrace(trace([twin, bare]), false).criticCalls
    expect(rows.map((r) => r.functionName)).toEqual(['CriticThinking', 'Critic'])
    expect(rows[1].client).toBeUndefined()
    expect(rows[1].rawOutput).toBeUndefined()
  })

  it('records a failed critic call from its error event, and caps a runaway verdict body', () => {
    const failed = event(
      'error',
      { error: 'BamlValidationError: missing is_sufficient', kind: 'llm_call' },
      { ...criticCall(), functionName: 'CriticThinking' },
      'doc',
    )
    expect(captureTrace(trace([failed]), false).criticCalls).toEqual([
      {
        turn: 0,
        patternId: 'doc',
        functionName: 'CriticThinking',
        outcome: 'error',
        error: 'BamlValidationError: missing is_sufficient',
        verdict: null,
        reason: '',
        client: 'LargeQwen',
        provider: 'openai-generic',
      },
    ])
    const long = 'x'.repeat(CAPTURE_OUTPUT_MAX_CHARS + 1)
    const [capped] = captureTrace(
      trace([
        event(
          'critic_result',
          { result: { is_sufficient: true, explanation: 'ok' } },
          criticCall(long),
        ),
      ]),
      false,
    ).criticCalls
    expect(capped.rawOutput).toContain('…[truncated, 1 more characters]')
  })

  it("records the synthesis, its serving client, and NOT the router's direct answer", () => {
    const routerAnswer = event(
      'assistant_message',
      { content: 'synthetic direct answer', final: true },
      { functionName: 'Router', variables: {}, rawOutput: 'synthetic direct answer' },
    )
    const synthesis = event(
      'assistant_message',
      { content: 'synthetic answer', final: true },
      {
        functionName: 'Synthesize',
        variables: {},
        clientName: 'LargeQwen',
        provider: 'openai-generic',
        rawOutput: 'synthetic answer',
      },
      'response-synth',
    )
    const intermediate = event('assistant_message', { content: 'Let me look into that…' })
    expect(
      captureTrace(trace([routerAnswer, intermediate, synthesis]), false).synthesizeCalls,
    ).toEqual([
      {
        turn: 0,
        patternId: 'response-synth',
        functionName: 'Synthesize',
        outcome: 'completion',
        output: 'synthetic answer',
        client: 'LargeQwen',
        provider: 'openai-generic',
        rawOutput: 'synthetic answer',
      },
    ])
  })

  it('records a failed synthesis from its error event', () => {
    const failed = event(
      'error',
      { error: 'BamlTimeoutError', kind: 'llm_call' },
      { functionName: 'Synthesize', variables: {}, clientName: 'LargeQwen' },
      'response-synth',
    )
    expect(captureTrace(trace([failed]), false).synthesizeCalls).toEqual([
      {
        turn: 0,
        patternId: 'response-synth',
        functionName: 'Synthesize',
        outcome: 'error',
        error: 'BamlTimeoutError',
        client: 'LargeQwen',
      },
    ])
  })

  // MUTATION: drop `cap()` from the synthesis output in capture.ts: red.
  it('caps a runaway synthesis output like a controller completion', () => {
    const long = 'y'.repeat(CAPTURE_OUTPUT_MAX_CHARS + 50)
    const [row] = captureTrace(
      trace([
        event(
          'assistant_message',
          { content: long, final: true },
          { functionName: 'Synthesize', variables: {}, rawOutput: long },
        ),
      ]),
      false,
    ).synthesizeCalls
    expect(row.output).toHaveLength(
      CAPTURE_OUTPUT_MAX_CHARS + '…[truncated, 50 more characters]'.length,
    )
    expect(row.rawOutput).toHaveLength(
      CAPTURE_OUTPUT_MAX_CHARS + '…[truncated, 50 more characters]'.length,
    )
  })
})

describe('CaptureLog', () => {
  it('leaves a row for a scenario that threw, so a missing row never reads as no decisions', () => {
    const log = new CaptureLog()
    log.addError(
      { agent: 'general-next', scenario: '13-two-sources', tier: 'self_deployed' },
      'BamlTimeoutError',
    )
    expect(JSON.parse(JSON.stringify(log)).scenarios).toEqual([
      {
        agent: 'general-next',
        scenario: '13-two-sources',
        tier: 'self_deployed',
        decisions: [],
        controllerCalls: [],
        criticCalls: [],
        synthesizeCalls: [],
        error: 'BamlTimeoutError',
      },
    ])
  })

  it('serialises one entry per scenario under its key, with the synthetic-only note', () => {
    const log = new CaptureLog()
    log.add(
      { agent: 'general-next', scenario: '13-two-sources', tier: 'self_deployed' },
      trace([decision('answer')]),
      true,
    )
    const json = JSON.parse(JSON.stringify(log))
    expect(json.note).toMatch(/synthetic/i)
    expect(json.scenarios).toHaveLength(1)
    expect(json.scenarios[0]).toMatchObject({
      agent: 'general-next',
      scenario: '13-two-sources',
      decisions: [{ choice: 'answer' }],
    })
  })
})
