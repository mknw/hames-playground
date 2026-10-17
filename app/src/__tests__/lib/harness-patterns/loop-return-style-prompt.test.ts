/**
 * #615: under the default `returnStyle: 'summary'` the controller's `Return` is
 * "NOT the user-facing answer", yet a Return-only turn (no tool called) has no
 * tool result for the synthesizer to compose from, and #612 hands that Return
 * text on as the answer. The summary branch of `LoopReturnStyle` therefore asks
 * for the COMPLETE answer when no tool ran. Pinned on the RENDERED prompt,
 * offline via `b.request.*` (no socket), on both wire formats: the Anthropic
 * client the chain declares and the self-hosted one the private tier routes to.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { ToolDescription } from '@hames-ai/harness-baml/baml_client'

const ENV = {
  VERDA_INFERENCE_ENDPOINT: 'https://example.invalid/deployment/v1',
  VERDA_INFERENCE_API_KEY: 'offline-render-test',
  SMALL_LLM_BASE_URL: 'https://example.invalid/small/v1',
  SMALL_LLM_API_KEY: 'offline-render-test',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'offline-render-test',
}
const CLIENTS = {
  anthropic: { client: 'AnthropicSonnet5', env: ENV },
  verda: { client: 'VerdaQwen', env: ENV },
}
const TOOLS: ToolDescription[] = [
  { name: 'search', description: 'Search', args_schema: '{"query":"string"}' },
]

type BamlRequest = (typeof import('@hames-ai/harness-baml/baml_client'))['b']['request']
let request: BamlRequest

beforeAll(async () => {
  request = (await import('@hames-ai/harness-baml/baml_client')).b.request
})

const render = async (style: string | null, which: keyof typeof CLIENTS) => {
  const req = await request.LoopController(
    'q',
    'i',
    TOOLS,
    [],
    null,
    null,
    null,
    null,
    null,
    style,
    CLIENTS[which],
  )
  return JSON.stringify(req.body.json())
}

describe.each(['anthropic', 'verda'] as const)('LoopReturnStyle render (%s wire)', (which) => {
  it('summary: asks for the complete answer when no tool was called', async () => {
    const text = await render('summary', which)
    expect(text).toContain('if you have called no tool in this task')
    expect(text).toContain('put the COMPLETE answer in')
    // The #149 rule is intact for a turn that did call a tool.
    expect(text).toContain('BRIEF completion summary')
  })

  it('null style renders the same default as summary', async () => {
    expect(await render(null, which)).toBe(await render('summary', which))
  })

  it('answer style is unchanged: no summary wording, no exception clause', async () => {
    const text = await render('answer', which)
    expect(text).not.toContain('BRIEF completion summary')
    expect(text).not.toContain('called no tool in this task')
    expect(text).toContain('put the complete answer in tool_args')
  })
})
