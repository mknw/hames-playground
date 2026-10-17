/**
 * The thinking-trace extraction primitive (#625 S1): `thinkingFrom` and
 * `splitAtLastThinkClose` in `@hames-ai/harness-baml/thinking-trace`.
 *
 * The fixtures are the response shapes recorded offline for #625 §2, through
 * the committed `baml_client` against a loopback mock: A1–A6 (an
 * OpenAI-compatible server with a reasoning parser), B1–B3 (one with no
 * parser, trace in `content`) and C1–C2 (Anthropic). All text is synthetic.
 * `B2-twice` is not a recorded body. It is B2 with a trace that mentions the
 * closing tag, the one shape on which "first `</think>`" and "last" disagree.
 *
 * Verified by mutation, each run on this branch and each turning this file RED
 * (results in the PR body):
 *   1. drop `reasoning` from the OpenAI field list → A2 (and the empty-field
 *      case) red; drop `reasoning_content` → A1, A3, A5, A6 (and the
 *      empty-field case) red
 *   2. cut at the FIRST `</think>` (`indexOf`) → B2-twice red
 *   3. accept an empty Anthropic thinking string as a trace → C1 (and the
 *      joined-blocks case) red
 */
import { describe, it, expect } from 'vitest'
import {
  thinkingFrom,
  splitAtLastThinkClose,
  type ThinkingSourceCall,
} from '@hames-ai/harness-baml/thinking-trace'

const ACTION_JSON = JSON.stringify({
  reasoning: 'content-side reasoning',
  tool_name: 'search',
  tool_args: '{"query":"x"}',
  status: 'Searching',
  is_final: false,
})
const DRAFT_JSON = JSON.stringify({
  reasoning: 'draft',
  tool_name: 'DRAFT_TOOL',
  tool_args: '{"query":"x"}',
  status: 'Searching',
  is_final: false,
})
const PLAN_JSON = JSON.stringify({
  reasoning: 'content-side plan reasoning',
  plan: '1. search',
  n_steps: 1,
})

/** An OpenAI-compatible chat completion carrying `message`. */
function openai(message: Record<string, unknown>) {
  return {
    id: 'chatcmpl-synthetic',
    object: 'chat.completion',
    created: 0,
    model: 'synthetic-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }
}

/** An Anthropic Messages response carrying `content` blocks. */
function anthropic(content: Record<string, unknown>[]) {
  return {
    id: 'msg-synthetic',
    type: 'message',
    role: 'assistant',
    model: 'synthetic-model',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  }
}

/** A collector-call stub: the raw body behind `httpResponse.body.json()`. */
const call = (body: unknown): ThinkingSourceCall => ({
  httpResponse: { body: { json: () => body } },
})

describe('thinkingFrom: OpenAI-compatible server WITH a reasoning parser', () => {
  it('A1: reads `reasoning_content`', () => {
    const body = openai({ content: ACTION_JSON, reasoning_content: 'PARSER-SIDE THINKING' })
    expect(thinkingFrom(call(body))).toEqual({
      kind: 'trace',
      text: 'PARSER-SIDE THINKING',
      source: 'reasoning_content',
    })
  })

  it('A2: reads `reasoning`, the other field name', () => {
    const body = openai({ content: ACTION_JSON, reasoning: 'PARSER-SIDE THINKING' })
    expect(thinkingFrom(call(body))).toEqual({
      kind: 'trace',
      text: 'PARSER-SIDE THINKING',
      source: 'reasoning',
    })
  })

  it('A3: reads the Planner trace the same way', () => {
    const body = openai({ content: PLAN_JSON, reasoning_content: 'PARSER-SIDE PLAN THINKING' })
    expect(thinkingFrom(call(body))).toEqual({
      kind: 'trace',
      text: 'PARSER-SIDE PLAN THINKING',
      source: 'reasoning_content',
    })
  })

  it('A4: thinking off, `reasoning_content: null` → no trace', () => {
    const body = openai({ content: ACTION_JSON, reasoning_content: null })
    expect(thinkingFrom(call(body))).toEqual({ kind: 'absent', reason: 'no-trace' })
  })

  it.each([
    ['A5', ''],
    ['A6', null],
  ])('%s: a parser mis-split returns the trace verbatim (content %j)', (_case, content) => {
    // The whole answer was filed under the reasoning field. The extractor's job
    // is to report what the server sent; deciding that this is a mis-split
    // (empty content, an answer inside the trace) is the caller's.
    const text = `thinking... ${ACTION_JSON}`
    expect(thinkingFrom(call(openai({ content, reasoning_content: text })))).toEqual({
      kind: 'trace',
      text,
      source: 'reasoning_content',
    })
  })

  it('a present but empty or whitespace-only field is `empty-trace`, not a trace', () => {
    expect(thinkingFrom(call(openai({ content: ACTION_JSON, reasoning_content: '' })))).toEqual({
      kind: 'absent',
      reason: 'empty-trace',
    })
    expect(thinkingFrom(call(openai({ content: ACTION_JSON, reasoning: ' \n ' })))).toEqual({
      kind: 'absent',
      reason: 'empty-trace',
    })
  })

  it('a non-string reasoning value is not read as a trace', () => {
    const body = openai({ content: ACTION_JSON, reasoning: { effort: 'high' } })
    expect(thinkingFrom(call(body))).toEqual({ kind: 'absent', reason: 'no-trace' })
  })

  it('a body with no usable first choice is `no-trace`', () => {
    expect(thinkingFrom(call({ choices: [] }))).toEqual({ kind: 'absent', reason: 'no-trace' })
    expect(thinkingFrom(call({ choices: [{ index: 0 }] }))).toEqual({
      kind: 'absent',
      reason: 'no-trace',
    })
  })
})

describe('OpenAI-compatible server with NO reasoning parser (trace in `content`)', () => {
  const B1 = `We need to search for x first.\n</think>\n\n${ACTION_JSON}`
  const B2 = `Maybe: ${DRAFT_JSON}\nNo, better to search.\n</think>\n\n${ACTION_JSON}`
  const B2_TWICE = `Maybe: ${DRAFT_JSON}\nI must not write </think> before deciding.\nNo, better to search.\n</think>\n\n${ACTION_JSON}`
  const B3 = 'The user wants a summary. Let me write one.\n</think>\n\nThree rows matched.'

  it('thinkingFrom reports no trace: there is no field to read', () => {
    for (const content of [B1, B2, B3]) {
      expect(thinkingFrom(call(openai({ content })))).toEqual({
        kind: 'absent',
        reason: 'no-trace',
      })
    }
  })

  it('B1: the split separates the trace from the answer', () => {
    expect(splitAtLastThinkClose(B1)).toEqual({
      closed: true,
      head: 'We need to search for x first.',
      tail: ACTION_JSON,
    })
  })

  it('B2: the drafted action stays in the head; only the final action is in the tail', () => {
    const split = splitAtLastThinkClose(B2)
    expect(split).toEqual({
      closed: true,
      head: `Maybe: ${DRAFT_JSON}\nNo, better to search.`,
      tail: ACTION_JSON,
    })
  })

  it('B2-twice: cuts at the LAST `</think>`, so a mention of the tag in the trace cannot expose the draft', () => {
    const split = splitAtLastThinkClose(B2_TWICE)
    expect(split.closed).toBe(true)
    expect(split.tail).toBe(ACTION_JSON)
    expect(split.tail).not.toContain('DRAFT_TOOL')
  })

  it('B3: a string answer comes back without the trace', () => {
    expect(splitAtLastThinkClose(B3)).toEqual({
      closed: true,
      head: 'The user wants a summary. Let me write one.',
      tail: 'Three rows matched.',
    })
  })
})

describe('splitAtLastThinkClose: edges', () => {
  it('no `</think>` → not closed, raw returned unchanged', () => {
    expect(splitAtLastThinkClose(ACTION_JSON)).toEqual({ closed: false, tail: ACTION_JSON })
    expect(splitAtLastThinkClose('')).toEqual({ closed: false, tail: '' })
  })

  it('an echoed opening `<think>` is not part of the trace', () => {
    expect(splitAtLastThinkClose(`<think>\nplan it\n</think>\n${ACTION_JSON}`)).toEqual({
      closed: true,
      head: 'plan it',
      tail: ACTION_JSON,
    })
  })

  it('an empty trace is an empty head, never an invented one', () => {
    expect(splitAtLastThinkClose(`</think>\n\n${ACTION_JSON}`)).toEqual({
      closed: true,
      head: '',
      tail: ACTION_JSON,
    })
    expect(splitAtLastThinkClose(`<think>\n\n</think>${ACTION_JSON}`)).toEqual({
      closed: true,
      head: '',
      tail: ACTION_JSON,
    })
  })
})

describe('thinkingFrom: Anthropic', () => {
  it('C1: an EMPTY thinking block (the default display) is `empty-trace`, not a trace', () => {
    const body = anthropic([
      { type: 'thinking', thinking: '', signature: 'synthetic-signature' },
      { type: 'text', text: ACTION_JSON },
    ])
    expect(thinkingFrom(call(body))).toEqual({ kind: 'absent', reason: 'empty-trace' })
  })

  it('C2: a thinking block with text is the trace', () => {
    const body = anthropic([
      { type: 'thinking', thinking: 'ANTHROPIC-SIDE THINKING', signature: 'synthetic-signature' },
      { type: 'text', text: ACTION_JSON },
    ])
    expect(thinkingFrom(call(body))).toEqual({
      kind: 'trace',
      text: 'ANTHROPIC-SIDE THINKING',
      source: 'anthropic_thinking',
    })
  })

  it('several thinking blocks are joined; empty ones are skipped', () => {
    const body = anthropic([
      { type: 'thinking', thinking: 'first', signature: 's1' },
      { type: 'thinking', thinking: '', signature: 's2' },
      { type: 'thinking', thinking: 'second', signature: 's3' },
      { type: 'text', text: ACTION_JSON },
    ])
    expect(thinkingFrom(call(body))).toEqual({
      kind: 'trace',
      text: 'first\n\nsecond',
      source: 'anthropic_thinking',
    })
  })

  it('no thinking block, or only a redacted one, is `no-trace`', () => {
    expect(thinkingFrom(call(anthropic([{ type: 'text', text: ACTION_JSON }])))).toEqual({
      kind: 'absent',
      reason: 'no-trace',
    })
    const redacted = anthropic([
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: ACTION_JSON },
    ])
    expect(thinkingFrom(call(redacted))).toEqual({ kind: 'absent', reason: 'no-trace' })
  })
})

describe('thinkingFrom: a response it cannot read', () => {
  it('no call, no response or no body is `no-response`', () => {
    expect(thinkingFrom(undefined)).toEqual({ kind: 'absent', reason: 'no-response' })
    expect(thinkingFrom({})).toEqual({ kind: 'absent', reason: 'no-response' })
    expect(thinkingFrom({ httpResponse: null })).toEqual({ kind: 'absent', reason: 'no-response' })
    expect(thinkingFrom({ httpResponse: { body: {} } })).toEqual({
      kind: 'absent',
      reason: 'no-response',
    })
  })

  it('a body whose `json()` throws, or is not an object, is `unreadable-body`', () => {
    const throwing: ThinkingSourceCall = {
      httpResponse: {
        body: {
          json: () => {
            throw new Error('not JSON')
          },
        },
      },
    }
    expect(thinkingFrom(throwing)).toEqual({ kind: 'absent', reason: 'unreadable-body' })
    expect(thinkingFrom(call('plain text'))).toEqual({ kind: 'absent', reason: 'unreadable-body' })
    expect(thinkingFrom(call(null))).toEqual({ kind: 'absent', reason: 'unreadable-body' })
  })

  it('a JSON object of neither shape is `unrecognised-shape`', () => {
    expect(thinkingFrom(call({ output: 'x' }))).toEqual({
      kind: 'absent',
      reason: 'unrecognised-shape',
    })
  })
})
