import { describe, expect, it } from 'vitest'
import {
  normalizeStoredInferenceTier,
  normalizeStoredContextTiers,
} from '../../../lib/inference/tier-value'

describe('stored tier compatibility', () => {
  it.each(['verda', 'self_deployed'])('reads %s as the same self-deployed tier', (tier) => {
    expect(normalizeStoredInferenceTier(tier)).toBe('self_deployed')
  })
  it('never reclassifies public or unknown tiers as private', () => {
    expect(normalizeStoredInferenceTier('anthropic')).toBe('anthropic')
    for (const value of ['SELF_DEPLOYED', 'private', 'typo', '', null, undefined, 0, {}])
      expect(normalizeStoredInferenceTier(value)).toBeNull()
  })
  it('projects only known turn metadata, leaving original input and content untouched', () => {
    const original = {
      status: 'paused',
      input: 'verda',
      data: { memories: [{ tier: 'verda', content: 'verda' }], arbitrary: { tier: 'verda' } },
      events: [
        ...['hitl_request', 'memory_recalled', 'memory_written'].map((type) => ({
          type,
          data: { tier: 'verda', content: 'verda' },
        })),
        { type: 'tool_result', data: { tier: 'verda', content: 'verda' } },
        { type: 'hitl_request', data: { tier: 'anthropic' } },
        { type: 'hitl_request', data: { tier: 'unknown' } },
      ],
    }
    const raw = JSON.stringify(original)
    const projected = JSON.parse(normalizeStoredContextTiers(raw))
    expect(original.events[0].data.tier).toBe('verda')
    expect(projected.input).toBe('verda')
    expect(projected.data.memories).toEqual([{ tier: 'self_deployed', content: 'verda' }])
    expect(projected.data.arbitrary.tier).toBe('verda')
    expect(
      projected.events
        .slice(0, 3)
        .every(
          (e: { data: { tier: string; content: string } }) =>
            e.data.tier === 'self_deployed' && e.data.content === 'verda',
        ),
    ).toBe(true)
    expect(projected.events.slice(3).map((e: { data: { tier: string } }) => e.data.tier)).toEqual([
      'verda',
      'anthropic',
      'unknown',
    ])
    expect(normalizeStoredContextTiers(JSON.stringify(projected))).toBe(JSON.stringify(projected))
  })
})
