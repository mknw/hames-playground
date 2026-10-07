// @vitest-environment node
/**
 * The verdicts `smoke-embed.ts` renders on an embedder's answer (#419 M8).
 *
 * The script itself needs a live box; what is pinned here is the judgement it
 * makes, against hand-made responses, so a loosened check cannot pass quietly.
 * Importing it fires no request (the entry-point guard).
 */
import { describe, expect, it } from 'vitest'
import {
  embeddingProblems,
  MEMORY_EMBEDDING_DIMENSIONS,
  SMOKE_TEXTS,
} from '../../../lib/inference/scripts/smoke-embed'
import { embedderWakeModel } from '../../../lib/inference/memory-wake.server'

const vec = (seed: number, dims = MEMORY_EMBEDDING_DIMENSIONS): number[] =>
  Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1)))

const good = {
  provider: 'local' as const,
  model: embedderWakeModel(),
  dimensions: MEMORY_EMBEDDING_DIMENSIONS,
  vectors: [vec(1), vec(2)],
}

describe('embeddingProblems', () => {
  it('accepts a healthy 1024-dim answer from the model the wake probe names', () => {
    expect(embeddingProblems(good, embedderWakeModel())).toEqual([])
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
    ['a different model', { ...good, model: 'other' }, /wake probe sends/],
  ])('rejects %s', (_label, result, message) => {
    expect(embeddingProblems(result, embedderWakeModel()).join('; ')).toMatch(message)
  })

  it('sends two distinct texts', () => {
    expect(new Set(SMOKE_TEXTS).size).toBe(2)
  })
})
