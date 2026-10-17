/**
 * #419 M2 — the store step's seams against what is already on main.
 *
 * Core declares `MemoryExtractFn` and `MemoryKind` structurally and the other
 * packages declare their own twins (a companion package cannot import core's
 * server module, and core cannot import the app). These assertions are the
 * compile-time half of `seam-contract`: if either side drifts, `pnpm typecheck`
 * fails HERE, at the line that names both. The runtime `it` exists so the file
 * is a test and not dead weight.
 *
 * Mutation: add a field to `ExtractedMemory` in `memory.baml` (and regenerate)
 * or widen `MemoryKind` in `memories.server.ts` — typecheck goes red.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { createMemoryExtractAdapter } from '@hames-ai/harness-baml'
import type { MemoryExtractFn, MemoryKind as CoreKind } from '@hames-ai/harness-patterns/types'
import type { MemoryKind as DbKind } from '~/lib/db/memories.server'

// harness-baml's adapter IS a MemoryExtractFn.
const _extract: MemoryExtractFn = createMemoryExtractAdapter()

// The app's database kind and core's kind are the same closed set, both ways.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _kinds: Equal<CoreKind, DbKind> = true

describe('memory store seams', () => {
  it('the baml extractor adapter satisfies core’s MemoryExtractFn; the kind sets agree', () => {
    expect(typeof _extract).toBe('function')
    expect(_kinds).toBe(true)
  })
})
