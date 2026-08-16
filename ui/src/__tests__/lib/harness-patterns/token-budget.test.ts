/**
 * Prompt-budget estimation and history trimming (`token-budget.server.ts`).
 *
 * The loop leans on this to keep a turn log inside a small-window model's
 * context: the estimate is deliberately conservative, an unknown client falls
 * back to a 16K window, and trimming drops the OLDEST entries while always
 * keeping at least the newest one (a prompt with no history at all is useless).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import {
  estimateTokens,
  getContextWindow,
  trimToFit,
} from '../../../lib/harness-patterns/token-budget.server'
import { MODEL_CONTEXT_WINDOWS } from '../../../lib/settings'

const joined = (items: string[]) => items.join('')

describe('estimateTokens', () => {
  it('counts roughly one token per four characters, rounding up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})

describe('getContextWindow', () => {
  it('returns the declared window for a known client', () => {
    const [name, window] = Object.entries(MODEL_CONTEXT_WINDOWS)[0]

    expect(getContextWindow(name)).toBe(window)
  })

  it('falls back to 16K for an unknown or unnamed client', () => {
    expect(getContextWindow('SomeClientWeNeverDeclared')).toBe(16_384)
    expect(getContextWindow(undefined)).toBe(16_384)
  })
})

describe('trimToFit', () => {
  it('keeps everything when the prompt already fits', () => {
    const items = ['a', 'b', 'c']

    expect(trimToFit(items, joined, 0, 100_000)).toBe(items)
  })

  it('drops the oldest entries until the prompt fits', () => {
    // 4 chars/token: each item is 1000 tokens; budget is 8192-4096 = 4096.
    const items = ['1', '2', '3', '4', '5', '6'].map((n) => n.repeat(4000))

    const kept = trimToFit(items, joined, 0, 8192)

    expect(kept.length).toBeLessThan(items.length)
    // The newest entries survive; the trim eats from the front.
    expect(kept[kept.length - 1]).toBe(items[items.length - 1])
    expect(estimateTokens(joined(kept))).toBeLessThanOrEqual(4096)
  })

  it('counts the fixed prompt overhead against the same budget', () => {
    const items = ['a'.repeat(4000), 'b'.repeat(4000)]

    const withoutBase = trimToFit(items, joined, 0, 12_288)
    const withBase = trimToFit(items, joined, 28_000, 12_288)

    expect(withoutBase).toHaveLength(2)
    expect(withBase).toHaveLength(1)
  })

  it('keeps the newest entry even when it alone busts the budget', () => {
    const items = ['old', 'x'.repeat(100_000)]

    const kept = trimToFit(items, joined, 0, 8192)

    expect(kept).toEqual([items[1]])
  })

  it('gives up rather than trimming when the window leaves no room for output', () => {
    const items = ['a'.repeat(100_000), 'b']

    expect(trimToFit(items, joined, 0, 4096)).toBe(items)
  })

  it('never mutates the caller’s array', () => {
    const items = ['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(4000)]

    trimToFit(items, joined, 0, 8192)

    expect(items).toHaveLength(3)
  })
})
