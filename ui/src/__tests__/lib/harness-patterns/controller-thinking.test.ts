/**
 * Thinking configuration per controller (#139).
 *
 * These models run extended thinking by default and do not expose the trace, so
 * whether it is on is a decision we make, not a default we inherit. Measured on
 * captured controller prompts (12 prompts × 6 samples × 2 variants): with
 * thinking on, 2 of 72 calls ended the turn having produced only thinking and no
 * text, median output tokens were 438 vs 249, and the loop re-queried when it
 * already held the answer. simpleLoop's controller therefore disables it; the
 * actor keeps it, because that corpus contained no actor prompts at all.
 *
 * Asserted on the rendered HTTP body — the only place the decision is visible.
 */
import { describe, it, expect, beforeAll } from 'vitest'

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'offline-render-test'

type Body = { thinking?: { type?: string }; model?: string }

let b: typeof import('../../../../baml_client').b

beforeAll(async () => {
  b = (await import('../../../../baml_client')).b
})

const TOOLS = [{ name: 'search', description: 'Search', args_schema: '{"query":"string"}' }]

describe('controller thinking configuration', () => {
  it('LoopController disables thinking', async () => {
    const req = await b.request.LoopController('x', 'x', TOOLS, [], null, null, null)
    expect((req.body.json() as Body).thinking).toEqual({ type: 'disabled' })
  })

  it('ActorController keeps thinking (its own chain, unmeasured)', async () => {
    const req = await b.request.ActorController('x', 'x', TOOLS, [], null, null, 1, 5)
    expect((req.body.json() as Body).thinking).toBeUndefined()
  })

  it("the no-think variants keep their twins' caps and pricing", async () => {
    // A missing caps entry makes llmCallHitOutputCap() blind, silently disabling
    // the truncation retry; a missing pricing entry reports cost as unknown.
    const { CLIENT_MAX_OUTPUT_TOKENS, CLIENT_PRICING, MODEL_CONTEXT_WINDOWS } = await import('../../../lib/settings')
    expect(CLIENT_MAX_OUTPUT_TOKENS.AnthropicSonnet5NoThink).toBe(CLIENT_MAX_OUTPUT_TOKENS.AnthropicSonnet5)
    expect(CLIENT_MAX_OUTPUT_TOKENS.AnthropicSonnet46NoThink).toBe(CLIENT_MAX_OUTPUT_TOKENS.AnthropicSonnet46)
    expect(CLIENT_PRICING.AnthropicSonnet5NoThink).toEqual(CLIENT_PRICING.AnthropicSonnet5)
    expect(CLIENT_PRICING.AnthropicSonnet46NoThink).toEqual(CLIENT_PRICING.AnthropicSonnet46)
    expect(MODEL_CONTEXT_WINDOWS.ActorAnthropic).toBe(MODEL_CONTEXT_WINDOWS.ControllerAnthropic)
  })

  it('thinking does not disturb the cache markers (#122)', async () => {
    const req = await b.request.LoopController('x', 'x', TOOLS, [], 'CTX', null, null)
    const body = req.body.json() as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }
    const marked = body.messages.flatMap((m) => m.content).filter((c) => c.cache_control)
    expect(marked.length).toBeGreaterThan(0)
  })
})
