/**
 * The Eval's synthetic per-user memory is owner-scoped like the host's store.
 * Mutation (synthetic-memory.ts `mine`): drop the `.filter((r) => r.owner === id)` so every
 * owner reads every row — "never another owner's rows" and "count" go red.
 * Mutation: delete the `if (!id) throw` — "refuses with no owner" goes red.
 */
import { describe, expect, it } from 'vitest'
import {
  createSyntheticMemory,
  EVAL_OTHER_OWNER,
  EVAL_OWNER,
} from '../../../lib/eval-support/synthetic-memory'

const query = { embedding: [1, 0], tiers: ['self_deployed'] }

describe('synthetic per-user memory', () => {
  it('serves the owner their own memory, and only that', async () => {
    const memory = createSyntheticMemory(() => EVAL_OWNER)
    expect(await memory.store.count(['self_deployed'])).toBe(1)
    const rows = await memory.store.candidates(query)
    expect(rows.map((r) => r.content).join(' ')).toContain('LANTERN-2')
    expect(rows.map((r) => r.content).join(' ')).not.toContain('KESTREL-5')
  })
  it('never returns another owner’s rows', async () => {
    const memory = createSyntheticMemory(() => EVAL_OTHER_OWNER)
    const rows = await memory.store.candidates(query)
    expect(rows.map((r) => r.content).join(' ')).toContain('KESTREL-5')
    expect(rows.map((r) => r.content).join(' ')).not.toContain('LANTERN-2')
  })
  it('resolves the owner on every call', async () => {
    let who: string = EVAL_OWNER
    const memory = createSyntheticMemory(() => who)
    expect((await memory.store.candidates(query))[0].content).toContain('LANTERN-2')
    who = EVAL_OTHER_OWNER
    expect((await memory.store.candidates(query))[0].content).toContain('KESTREL-5')
  })
  it('refuses with no owner', async () => {
    const memory = createSyntheticMemory(() => null)
    await expect(memory.store.count(['self_deployed'])).rejects.toThrow(/owner/)
    await expect(memory.store.candidates(query)).rejects.toThrow(/owner/)
  })
  it('is read-only', async () => {
    const memory = createSyntheticMemory(() => EVAL_OWNER)
    await expect(memory.store.transaction(async () => undefined as never)).rejects.toThrow(
      /read-only/,
    )
  })
})
