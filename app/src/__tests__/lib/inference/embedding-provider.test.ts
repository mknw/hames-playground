/**
 * Ruling W (boundary guards, slice 4): the retriever's query reaches the
 * embedder without the egress gate, so boot refuses an embedding provider that
 * is neither `local` nor declared trusted IN CODE, and the file-ingest
 * capability and the ingest tool read the same predicate.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import {
  embeddingProviderPassesEgress,
  TRUSTED_EMBEDDING_PROVIDERS,
} from '@hames-ai/harness-patterns/stash/embeddings.server'
import { assertEmbeddingProviderAllowed } from '../../../lib/inference/tier-config.server'

afterEach(() => vi.unstubAllEnvs())

describe('the trusted-embedder predicate', () => {
  // MUTATION: accept any provider (return true), or the outside one
  // (`provider !== 'unknown'`): `openrouter` or `other` passes.
  it('passes local and unset; refuses openrouter, an unregistered value and an empty one', () => {
    expect(embeddingProviderPassesEgress(undefined)).toBe(true)
    expect(embeddingProviderPassesEgress('local')).toBe(true)
    for (const provider of ['openrouter', 'other', '', 'LOCAL'])
      expect(embeddingProviderPassesEgress(provider), provider).toBe(false)
  })

  it('a provider declared trusted passes; none is declared today', () => {
    expect(embeddingProviderPassesEgress('acme', new Set(['acme']))).toBe(true)
    expect([...TRUSTED_EMBEDDING_PROVIDERS]).toEqual([])
  })
})

describe('the boot check', () => {
  // MUTATION: drop the refusal from `assertEmbeddingProviderAllowed`, or read
  // the trusted set from an environment variable.
  it('refuses an outside or unregistered provider; an env var cannot declare one trusted', () => {
    for (const provider of ['openrouter', 'other']) {
      vi.stubEnv('EMBEDDINGS_PROVIDER', provider)
      vi.stubEnv('EMBEDDINGS_TRUSTED_PROVIDERS', provider)
      vi.stubEnv('TRUSTED_EMBEDDING_PROVIDERS', provider)
      expect(() => assertEmbeddingProviderAllowed(), provider).toThrow(/EMBEDDINGS_PROVIDER/)
    }
    vi.stubEnv('EMBEDDINGS_PROVIDER', 'local')
    expect(() => assertEmbeddingProviderAllowed()).not.toThrow()
  })

  // MUTATION: delete the `assertEmbeddingProviderAllowed()` call from the
  // middleware: a deployment boots with the outside embedder.
  it('runs at server boot, beside the inference check', () => {
    const middleware = readFileSync(join(__dirname, '../../../middleware.ts'), 'utf8')
    expect(middleware).toMatch(/^assertEmbeddingProviderAllowed\(\)$/m)
  })
})
