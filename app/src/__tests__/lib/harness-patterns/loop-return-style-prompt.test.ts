/**
 * #615: under the default `returnStyle: 'summary'` the controller's `Return` is
 * "NOT the user-facing answer", yet a Return-only turn (no tool called) has no
 * tool result for the synthesizer to compose from, and #612 hands that Return
 * text on as the answer. The summary branch of `LoopReturnStyle` therefore asks
 * for the COMPLETE answer when no tool ran. Pinned on the RENDERED prompt,
 * offline via `b.request.*` (no socket), on both wire formats: a leaf of the
 * Anthropic chain `ControllerAnthropic` (the NoThink one) and the self-hosted
 * client the private tier routes to. The clause is asserted per BLOCK — the
 * cached system head, and the tier-1 tool catalog — because a whole-body match
 * cannot see it move into the volatile tail (re-sent uncached every turn, #122).
 * Widened by the #621 review to the union of #612 (no call) and #620 (all calls
 * failed).
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
  anthropic: { client: 'AnthropicSonnet5NoThink', env: ENV },
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

type Msg = { role: string; content: string | { text?: string }[] }
type Body = { system?: { text?: string }[]; messages: Msg[] }
const text = (c: Msg['content']) =>
  typeof c === 'string' ? c : c.map((p) => p.text ?? '').join('\n')

/** The static head: Anthropic's top-level `system`, or VerdaQwen's leading system message. */
const flat = (t: string) => t.replace(/\s+/g, ' ')
const systemText = (b: Body) =>
  flat(b.system ? b.system.map((p) => p.text ?? '').join('\n') : text(b.messages[0].content))
/** Everything after the head (tier 1 catalog, history, volatile tail). */
const restText = (b: Body) =>
  b.messages
    .slice(b.system ? 0 : 1)
    .map((m) => text(m.content))
    .join('\n')

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
  return req.body.json() as Body
}

const CLAUSE = 'if no tool call in this task has returned a result'
const CATALOG =
  '- Return: Signal task completion (tool_args = brief completion summary, or the complete answer if no tool returned a result)'

describe.each(['anthropic', 'verda'] as const)('LoopReturnStyle render (%s wire)', (which) => {
  it('summary: the SYSTEM block asks for the complete answer when no tool returned a result', async () => {
    const b = await render('summary', which)
    expect(systemText(b)).toContain(CLAUSE)
    expect(systemText(b)).toContain('you called none, or every call failed')
    expect(systemText(b)).toContain('if a call failed, say briefly what failed')
    expect(systemText(b)).toContain('BRIEF completion summary')
    // Not in the volatile tail or the catalog: that would be re-sent uncached.
    expect(restText(b)).not.toContain(CLAUSE)
  })

  it('summary: the tier-1 tool catalog agrees with the system block', async () => {
    expect(restText(await render('summary', which))).toContain(CATALOG)
  })

  it('null style renders the same default as summary', async () => {
    expect(await render(null, which)).toEqual(await render('summary', which))
  })

  it('answer style is unchanged: no summary wording, no exception clause anywhere', async () => {
    const b = await render('answer', which)
    const all = systemText(b) + restText(b)
    expect(all).not.toContain('BRIEF completion summary')
    expect(all).not.toContain('returned a result')
    expect(systemText(b)).toContain('put the complete answer in tool_args')
  })
})
