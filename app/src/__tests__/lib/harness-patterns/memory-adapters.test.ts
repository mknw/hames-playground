/**
 * The two memory adapters (#419 M9): `createMemoryExtractAdapter` and
 * `createMemoryCompactAdapter`.
 *
 * What is pinned here is what the BAML-level pins cannot see: that the adapter
 * hands BAML the argument list in the generated order, that the options bag it
 * builds carries the `describe` role's per-call client on a private-tier turn
 * (so the user's words land on the 4B and never on a public provider), that the
 * model's output reaches core UNFILTERED (acceptance is core's job, and a
 * candidate dropped here is one it can never log), and that a failure after
 * reaching the model throws `LLMCallError` rather than returning an empty batch
 * that would read as "nothing worth remembering".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const extract = vi.fn()
const compact = vi.fn()
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: { ExtractMemory: extract, CompactMemories: compact },
}))
// The adapters import the client relatively; the alias above and the relative
// path resolve to the same module id, so one mock covers both.

vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'raw',
      usage: { inputTokens: 40, outputTokens: 12 },
      calls: [{ httpRequest: { body: { messages: [] } }, provider: 'x', clientName: 'x' }],
    }
    constructor(public readonly name?: string) {}
  }
  class BamlValidationError extends Error {}
  return { Collector: MockCollector, BamlValidationError }
})

const ENV_KEYS = [
  'USE_VERDA_INFERENCE',
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
  'SMALL_LLM_BASE_URL',
] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  vi.clearAllMocks()
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function load() {
  vi.resetModules()
  await import('../../../lib/inference/config.server')
  return await import('@hames-ai/harness-baml/baml-patterns.server')
}

const MEMBERS = [
  { content: 'likes tea', evidence: 'I like tea', last_seen: '2026-10-01' },
  { content: 'likes green tea', evidence: 'green tea, always', last_seen: '2026-10-05' },
]

describe('createMemoryExtractAdapter', () => {
  it('calls ExtractMemory in generated argument order and returns the batch UNFILTERED', async () => {
    // An out-of-set kind and a too-long line: both must reach core's
    // acceptance, which drops them WITH a logged rule id.
    const batch = [
      { kind: 'mood', content: 'x'.repeat(400), evidence: 'short' },
      { kind: 'preference', content: 'prefers metric units', evidence: 'I prefer metric units' },
    ]
    extract.mockResolvedValue(batch)
    const { createMemoryExtractAdapter } = await load()
    const res = await createMemoryExtractAdapter()({
      kindHint: 'preference',
      window: 'USER: hi',
      latestUser: 'I prefer metric units',
    })
    expect(extract.mock.calls[0].slice(0, 3)).toEqual([
      'preference',
      'USER: hi',
      'I prefer metric units',
    ])
    expect(res.value).toBe(batch)
    expect(res.call).toBeDefined()
  })

  it('puts the collector in the bag and, on a private-tier turn, the describe client', async () => {
    extract.mockResolvedValue([])
    process.env.USE_VERDA_INFERENCE = '1'
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
    process.env.VERDA_INFERENCE_API_KEY = 'k'
    process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
    const { createMemoryExtractAdapter } = await load()
    await createMemoryExtractAdapter()({ kindHint: 'k', window: 'w', latestUser: 'u' })
    const bag = extract.mock.calls[0][3] as { collector?: unknown; client?: string }
    expect(bag.collector).toBeDefined()
    expect(bag.client).toBe('LocalQwenSmall')
  })

  it('leaves the Anthropic tier on its declared chain (no client override)', async () => {
    extract.mockResolvedValue([])
    const { createMemoryExtractAdapter } = await load()
    await createMemoryExtractAdapter()({ kindHint: 'k', window: 'w', latestUser: 'u' })
    const bag = extract.mock.calls[0][3] as { client?: string }
    expect(bag.client).toBeUndefined()
  })

  it('throws LLMCallError on a failure, never an empty batch', async () => {
    extract.mockRejectedValue(new Error('boom'))
    const { createMemoryExtractAdapter } = await load()
    await expect(
      createMemoryExtractAdapter()({ kindHint: 'k', window: 'w', latestUser: 'u' }),
    ).rejects.toMatchObject({ name: 'LLMCallError' })
  })
})

describe('createMemoryCompactAdapter', () => {
  it('calls CompactMemories in generated argument order and returns the line as written', async () => {
    const merged = { content: 'likes green tea', evidence: 'green tea, always' }
    compact.mockResolvedValue(merged)
    const { createMemoryCompactAdapter } = await load()
    const res = await createMemoryCompactAdapter()({ kind: 'preference', members: MEMBERS })
    expect(compact.mock.calls[0][0]).toBe('preference')
    expect(compact.mock.calls[0][1]).toEqual(MEMBERS)
    expect(res.value).toBe(merged)
  })

  it('rides the describe client on a private-tier turn', async () => {
    compact.mockResolvedValue({ content: 'c', evidence: 'e' })
    process.env.USE_VERDA_INFERENCE = '1'
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
    process.env.VERDA_INFERENCE_API_KEY = 'k'
    process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
    const { createMemoryCompactAdapter } = await load()
    await createMemoryCompactAdapter()({ kind: 'preference', members: MEMBERS })
    expect((compact.mock.calls[0][2] as { client?: string }).client).toBe('LocalQwenSmall')
  })

  it('throws LLMCallError on a failure', async () => {
    compact.mockRejectedValue(new Error('boom'))
    const { createMemoryCompactAdapter } = await load()
    await expect(
      createMemoryCompactAdapter()({ kind: 'preference', members: MEMBERS }),
    ).rejects.toMatchObject({ name: 'LLMCallError' })
  })
})
