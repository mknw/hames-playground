// @vitest-environment node
/**
 * The verdicts `smoke-embed.ts` renders on an embedder's answer (#419 M8).
 *
 * The script itself needs a live box; what is pinned here is the judgement it
 * makes, against hand-made responses, so a loosened check cannot pass quietly.
 * Importing it fires no request (the entry-point guard).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  embeddingProblems,
  fetchServedModels,
  MEMORY_EMBEDDING_DIMENSIONS,
  SMOKE_TEXTS,
} from '../../../lib/inference/scripts/smoke-embed'
import { embedderWakeModel } from '../../../lib/inference/memory-wake.server'

const vec = (seed: number, dims = MEMORY_EMBEDDING_DIMENSIONS): number[] =>
  Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1)))

const SERVED = [`/models/${embedderWakeModel()}-Q8_0.gguf`]

const good = {
  provider: 'local' as const,
  model: embedderWakeModel(),
  dimensions: MEMORY_EMBEDDING_DIMENSIONS,
  vectors: [vec(1), vec(2)],
}

describe('embeddingProblems', () => {
  it('accepts a healthy 1024-dim answer from the model the wake probe names', () => {
    expect(embeddingProblems(good, embedderWakeModel(), SERVED)).toEqual([])
  })

  it('the column width is the one memories.server.ts declares', async () => {
    const { readFileSync } = await import('node:fs')
    expect(
      readFileSync(new URL('../../../lib/db/memories.server.ts', import.meta.url), 'utf8'),
    ).toContain(`vector(${MEMORY_EMBEDDING_DIMENSIONS})`)
  })

  it.each([
    ['a wrong width', { ...good, vectors: [vec(1, 768), vec(2, 768)] }, /768 dimensions/],
    ['a missing vector', { ...good, vectors: [vec(1)] }, /1 vectors for 2 texts/],
    ['an all-zero vector', { ...good, vectors: [new Array(1024).fill(0), vec(2)] }, /all zeros/],
    ['a NaN component', { ...good, vectors: [[NaN, ...vec(1).slice(1)], vec(2)] }, /non-finite/],
    ['identical vectors', { ...good, vectors: [vec(1), vec(1)] }, /identically/],
    ['a remote provider', { ...good, provider: 'openrouter' as const }, /expected local/],
  ])('rejects %s', (_label, result, message) => {
    expect(embeddingProblems(result, embedderWakeModel(), SERVED).join('; ')).toMatch(message)
  })

  it('judges the model the SERVER lists, not the name embed() echoes back', () => {
    // result.model is the configured name — a wrong server still "reports" it.
    const wrong = embeddingProblems(good, embedderWakeModel(), ['/models/some-chat-model.gguf'])
    expect(wrong.join('; ')).toMatch(/server serves .*some-chat-model.*wake probe sends/)
    expect(embeddingProblems(good, embedderWakeModel(), [])).toHaveLength(1)
    // an unreadable /models is not a failure (the script says so instead)
    expect(embeddingProblems(good, embedderWakeModel(), null)).toEqual([])
  })

  it('sends two distinct texts', () => {
    expect(new Set(SMOKE_TEXTS).size).toBe(2)
  })
})

describe('fetchServedModels', () => {
  afterEach(() => vi.unstubAllGlobals())
  const answer = (body: unknown, ok = true): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok, json: async () => body })),
    )
  }

  it('reads the OpenAI data[].id and llama-server models[].model/name', async () => {
    answer({ data: [{ id: 'a' }], models: [{ model: 'b', name: 'c' }] })
    expect(await fetchServedModels('http://embedder:8090/v1/')).toEqual(['a', 'b', 'c'])
  })

  it('asks /models under the base URL, with the key when there is one', async () => {
    answer({ data: [] })
    await fetchServedModels('http://embedder:8090/v1', 'k')
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).toBe('http://embedder:8090/v1/models')
    expect(init.headers.Authorization).toBe('Bearer k')
  })

  it('is null — not a throw — when the route fails or is not JSON', async () => {
    answer({}, false)
    expect(await fetchServedModels('http://x/v1')).toBeNull()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    )
    expect(await fetchServedModels('http://x/v1')).toBeNull()
  })
})
