/**
 * LLM request-body parsing — the provider-shape normalisation behind the
 * prompt drill-down.
 *
 * Both shapes this app sends matter: OpenAI-compatible bodies (system prompt as
 * `messages[0]`, string content) and Anthropic's (top-level `system`, content as
 * typed block arrays). Getting the second wrong is what blinded the primary
 * debug surface on the dev-default client chain (SA-H11).
 */
import { describe, it, expect } from 'vitest'
import {
  flattenContent,
  formatParamValue,
  hasSystemContent,
  parsePromptBody,
} from '~/lib/observability/prompt-parse'

describe('flattenContent', () => {
  it('passes a plain string through and renders nullish content as empty', () => {
    expect(flattenContent('hello')).toBe('hello')
    expect(flattenContent(null)).toBe('')
    expect(flattenContent(undefined)).toBe('')
  })

  it('concatenates Anthropic text blocks with a blank line between them', () => {
    expect(
      flattenContent([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\n\nsecond')
  })

  it('labels a non-text block by type instead of dropping it', () => {
    const out = flattenContent([{ type: 'tool_use', name: 'json_get', input: { name: 'k' } }])
    expect(out.startsWith('[tool_use]\n')).toBe(true)
    expect(out).toContain('"json_get"')
  })

  it('labels a typeless block generically', () => {
    expect(flattenContent([{ foo: 1 }]).startsWith('[block]\n')).toBe(true)
  })

  it('keeps bare strings inside a block array', () => {
    expect(flattenContent(['a', 'b'])).toBe('a\n\nb')
  })

  it('serialises a null entry and a non-array object rather than throwing', () => {
    expect(flattenContent([null])).toBe('null')
    expect(flattenContent({ shape: 'unexpected' })).toBe('{\n  "shape": "unexpected"\n}')
  })
})

describe('hasSystemContent', () => {
  it('accepts a non-blank string and a non-empty block array', () => {
    expect(hasSystemContent('you are a router')).toBe(true)
    expect(hasSystemContent([{ type: 'text', text: 'x' }])).toBe(true)
  })

  it('rejects blank, empty and absent values', () => {
    expect(hasSystemContent('   ')).toBe(false)
    expect(hasSystemContent([])).toBe(false)
    expect(hasSystemContent(undefined)).toBe(false)
    expect(hasSystemContent({ text: 'x' })).toBe(false)
  })
})

describe('parsePromptBody', () => {
  it('parses the OpenAI shape into per-role messages plus a params bar', () => {
    const parsed = parsePromptBody(
      JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' },
        ],
      }),
    )
    expect(parsed).toEqual({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
      model: 'gpt-4o',
      params: { temperature: 0.2 },
    })
  })

  it('lifts a top-level Anthropic system prompt into a leading system message', () => {
    const parsed = parsePromptBody(
      JSON.stringify({
        model: 'claude-sonnet-5',
        system: 'you are a router',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    )
    expect(parsed!.messages).toEqual([
      { role: 'system', content: 'you are a router' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('lifts a system prompt supplied as text blocks', () => {
    const parsed = parsePromptBody(
      JSON.stringify({
        system: [{ type: 'text', text: 'block system' }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(parsed!.messages[0]).toEqual({ role: 'system', content: 'block system' })
  })

  it('keeps a malformed system field out of the params bar and out of the messages', () => {
    const parsed = parsePromptBody(
      JSON.stringify({ system: '  ', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(parsed!.messages).toHaveLength(1)
    expect(parsed!.params).not.toHaveProperty('system')
  })

  it('labels a message with no role', () => {
    const parsed = parsePromptBody(JSON.stringify({ messages: [{ content: 'orphan' }] }))
    expect(parsed!.messages[0].role).toBe('unknown')
  })

  it('returns null for anything that is not a body with a messages array', () => {
    expect(parsePromptBody('not json at all')).toBeNull()
    expect(parsePromptBody(JSON.stringify({ prompt: 'no messages' }))).toBeNull()
    expect(parsePromptBody(JSON.stringify(['a', 'b']))).toBeNull()
    expect(parsePromptBody('null')).toBeNull()
  })
})

describe('formatParamValue', () => {
  it('stringifies primitives and objects onto one line', () => {
    expect(formatParamValue(0.2)).toBe('0.2')
    expect(formatParamValue(true)).toBe('true')
    expect(formatParamValue(null)).toBe('null')
    expect(formatParamValue({ a: 1 })).toBe('{"a":1}')
  })

  it('caps an oversized value with an ellipsis instead of pushing the bar out', () => {
    const out = formatParamValue('v'.repeat(200))
    expect(out).toHaveLength(161)
    expect(out.endsWith('…')).toBe(true)
  })

  it('leaves a value at the cap untouched', () => {
    expect(formatParamValue('v'.repeat(160))).toHaveLength(160)
  })
})
