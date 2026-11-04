// @vitest-environment node
/**
 * V9's member matcher (slice 4). Synthetic names only.
 *
 * Pins, each with the mutation that reddens it:
 *  - a full name, an address or its local part names a member (mutation: drop
 *    the whole-name forms);
 *  - a bare given or family name names a member only when capitalised
 *    (mutation: match parts case-insensitively → "will" drops a fact);
 *  - an unreadable directory fails closed (mutation: return `() => false`).
 */
import { describe, it, expect, vi } from 'vitest'

const load = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/org-graph/roster-source.server', () => ({
  loadDirectoryRoster: () => load(),
}))

import { loadMemberMentions, memberMentions } from '../../../lib/org-graph/member-mentions.server'

const ROSTER = [
  { displayName: 'Tamsin Orrin', mail: 'tamsin.orrin@example.test' },
  { displayName: 'Will Mark', mail: 'w.mark@example.test' },
]

describe('memberMentions', () => {
  const names = memberMentions(ROSTER)

  it('finds a full name, an address and an address’s local part, in any case', () => {
    expect(names('Tamsin Orrin decided to cut the budget')).toBe(true)
    expect(names('tamsin orrin decided')).toBe(true)
    expect(names('ask tamsin.orrin@example.test')).toBe(true)
    expect(names('ask w.mark about it')).toBe(true)
  })

  it('finds a bare given or family name only when it is written capitalised', () => {
    expect(names('Orrin approved the plan')).toBe(true)
    expect(names('Will approved the plan')).toBe(true)
    expect(names('we will cut the budget and mark it done')).toBe(false)
    expect(names('The Osprey budget is 40,000 euro')).toBe(false)
  })

  it('does not match inside a longer word', () => {
    expect(names('Tamsinesque prose')).toBe(false)
  })
})

describe('loadMemberMentions', () => {
  it('fails closed when the directory cannot be read', async () => {
    load.mockRejectedValueOnce(new Error('graph down'))
    const names = await loadMemberMentions()
    expect(names('The Osprey budget is 40,000 euro')).toBe(true)
  })

  it('reads the directory once into a matcher', async () => {
    load.mockResolvedValueOnce(ROSTER)
    const names = await loadMemberMentions()
    expect(names('Tamsin Orrin')).toBe(true)
    expect(names('nobody')).toBe(false)
  })
})
