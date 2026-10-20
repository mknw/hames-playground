/** #507 cause A: synthetic replays of the rejected run-1 SHAPES, never private
 * transcripts. b.parse and b.request run offline; nothing invokes a provider.
 * MUTATIONS: re-add the Return sentence to ControllerAction.tool_args (with
 * regeneration); remove `as plain prose (not JSON)` from LoopReturnStyle's
 * branches (with regeneration). Source and render pins must turn red.
 * Change ActorController's output type to string and regenerate: all five
 * replay cases must fail (including the positive envelope control).
 */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
}
let b: typeof import('@hames-ai/harness-baml/baml_client').b
beforeAll(async () => {
  b = (await import('@hames-ai/harness-baml/baml_client')).b
})

const ACTION = {
  reasoning: 'Inspect the synthetic input.',
  tool_name: 'sandbox_bash',
  tool_args: JSON.stringify({ command: 'ls /work/in' }),
  is_final: false,
}
const REJECTED = [
  [
    'name/arguments',
    JSON.stringify({ name: ACTION.tool_name, arguments: { command: 'ls /work/in' } }),
  ],
  [
    'tool_calls',
    JSON.stringify({
      tool_calls: [{ name: ACTION.tool_name, arguments: { command: 'ls /work/in' } }],
    }),
  ],
  [
    'tool_call XML',
    '<tool_call>{"name":"sandbox_bash","arguments":{"command":"ls /work/in"}}</tool_call>',
  ],
  ['prose', 'I will inspect the uploaded files with sandbox_bash.'],
]

describe('office actor envelope replay', () => {
  it.each(REJECTED)('still rejects %s', (_shape, output) => {
    expect(() => b.parse.ActorController(output)).toThrow(/missing=3, unparsed=0/)
  })

  it('accepts the exact envelope, including a sequential multi-call', () => {
    const batch = {
      ...ACTION,
      tool_name: 'sandbox_write',
      tool_args: JSON.stringify({ path: '/work/sample.py', content: 'print(42)\n' }),
      additional_calls: [
        { tool_name: 'sandbox_bash', tool_args: '{"command":"python3 /work/sample.py"}' },
      ],
    }
    expect(b.parse.ActorController(JSON.stringify(ACTION))).toMatchObject(ACTION)
    expect(b.parse.ActorController(JSON.stringify(batch))).toMatchObject(batch)
  })
})

it('keeps the shared ControllerAction.tool_args description free of Return', () => {
  const source = readFileSync('../packages/harness-baml/baml_src/types.baml', 'utf8')
  const description = source
    .split('class ControllerAction {')[1]
    .match(/tool_args string @description\("([^\n]+)"\)/)![1]
  expect(description).toContain('Valid JSON object string')
  expect(description).not.toContain('Return')
})

describe.each(['AnthropicSonnet5', 'SelfDeployedQwen'])('Return contract (%s wire)', (client) => {
  it('puts the plain-prose instruction only in the loop prompt', async () => {
    const options = { client, env: ENV }
    const actor = (
      await b.request.ActorController('q', 'i', [], [], null, null, 1, 6, 'sequential', options)
    ).body.text()
    expect(actor).not.toContain('For Return, use plain prose')
    expect(actor).not.toContain('plain prose (not JSON)')
    for (const style of ['summary', 'answer']) {
      const loop = (
        await b.request.LoopController(
          'q',
          'i',
          [],
          [],
          null,
          null,
          null,
          null,
          null,
          style,
          options,
        )
      ).body.text()
      expect(loop).toContain('plain prose (not JSON)')
      expect(loop).toContain(
        'For Return, use plain prose (not JSON), as your instructions describe.',
      )
    }
  })
})
