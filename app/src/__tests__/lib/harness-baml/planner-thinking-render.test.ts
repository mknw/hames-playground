/** #625 S3: offline render pins; no provider connection. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import { DEFAULT_LARGE_LLM_MODEL } from '@hames-ai/harness-baml/inference-env.server'
import {
  PRIVATE_TIER_CLIENTS,
  THINKING_CLIENTS,
  SELF_DEPLOYED_CLIENT_BY_ROLE,
} from '@hames-ai/harness-baml/clients.server'
import {
  CLIENT_MAX_OUTPUT_TOKENS,
  MODEL_CONTEXT_WINDOWS,
  PROVIDER_COST_CLIENTS,
  TIME_PRICED_CLIENTS,
} from '../../../lib/settings'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const env = {
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'synthetic-key',
  // The id is env-overridable; the render resolves the DEFAULT — the same
  // resolution production's unset path takes.
  LARGE_LLM_MODEL: DEFAULT_LARGE_LLM_MODEL,
}
const opts = { client: 'LargeQwenThink', env }
const tools = [
  { name: 'search', description: 'Synthetic search', args_schema: '{"query":"string"}' },
]

describe('dormant Planner thinking twin', () => {
  it('enables thinking with its own model-card sampling on the same endpoint, without caching', async () => {
    const req = await b.request.PlannerThinking('q', 'i', tools, 'schema', opts)
    expect(req.url).toBe('https://example.invalid/v1/chat/completions')
    const body = req.body.json() as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'Qwen/Qwen3.8-27B-FP8',
      chat_template_kwargs: { enable_thinking: true },
      max_tokens: 4096,
      temperature: 1,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      repetition_penalty: 1,
    })
    expect(req.body.text()).not.toContain('cache_control')
    expect(req.body.text()).not.toContain('reasoning: string')
    expect(b.parse.PlannerThinking('{"plan":"1. search","n_steps":1}')).toEqual({
      plan: '1. search',
      n_steps: 1,
    })
  })

  it.each([null, '', 'Synthetic schema\nwith "quotes"'])(
    'shares exact request bytes except reasoning guidance and schema (context %j)',
    async (context) => {
      const original = (
        await b.request.Planner('Find "sample"\nfile', 'Find sample', tools, context, opts)
      ).body.text()
      const twin = (
        await b.request.PlannerThinking('Find "sample"\nfile', 'Find sample', tools, context, opts)
      ).body.text()
      // Exact edits, not whitespace/JSON normalization: everything else must match.
      const expected = original
        .replace(', and never more than a short paragraph of reasoning', '')
        .replace('  // Why this approach was chosen\\n  reasoning: string,\\n', '')
      expect(expected).not.toBe(original)
      expect(twin).toBe(expected)
    },
  )

  it('keeps the app-path fake inventory and response complete without importing that suite', () => {
    const classifier = readFileSync(
      path.resolve(process.cwd(), 'e2e/lib/baml-functions.ts'),
      'utf8',
    )
    const markers = classifier.split('const MARKERS = [')[1].split('] as const')[0]
    const names = [...markers.matchAll(/\[\s*'(\w+)',/g)].map((match) => match[1]).sort()
    const declared = Object.getOwnPropertyNames(Object.getPrototypeOf(b.request))
      .filter((name) => name !== 'constructor')
      .sort()
    expect(names).toEqual(declared)
    const fake = readFileSync(path.resolve(process.cwd(), 'e2e/lib/fake-llm.ts'), 'utf8')
    expect(fake).toContain("case 'PlannerThinking':")
    expect(fake).toContain("fn === 'PlannerThinking'")
  })

  it('pins its provisional cap/timeout coupling separately and never changes the tier map', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), '../packages/harness-baml/baml_src/large-client.baml'),
      'utf8',
    )
    const block = source.split('client<llm> LargeQwenThink {')[1]
    expect(block).toBeDefined()
    const cap = Number(block.match(/max_tokens\s+(\d+)/)?.[1])
    const timeout = Number(block.match(/request_timeout_ms\s+(\d+)/)?.[1])
    expect([cap, timeout]).toEqual([4096, 180_000])
    expect(timeout - (cap / 26) * 1000).toBeGreaterThanOrEqual(10_000)
    expect(source).toContain('PROVISIONAL / UNMEASURED')
    expect(CLIENT_MAX_OUTPUT_TOKENS.LargeQwenThink).toBe(cap)
    expect(MODEL_CONTEXT_WINDOWS.LargeQwenThink).toBe(MODEL_CONTEXT_WINDOWS.LargeQwen)
    // The thinking twin follows its twin's PRICING basis: both 27B leaves are
    // provider-priced since the OpenRouter eval (see PROVIDER_COST_CLIENTS).
    expect(PROVIDER_COST_CLIENTS.has('LargeQwenThink')).toBe(true)
    expect(Object.hasOwn(TIME_PRICED_CLIENTS, 'LargeQwenThink')).toBe(false)
    expect(PRIVATE_TIER_CLIENTS.has('LargeQwenThink')).toBe(true)
    expect([...THINKING_CLIENTS]).toEqual(['LargeQwenThink'])
    expect(Object.values(SELF_DEPLOYED_CLIENT_BY_ROLE)).not.toContain('LargeQwenThink')
    expect(SELF_DEPLOYED_CLIENT_BY_ROLE.planner).toBe('LargeQwen')
  })
})
