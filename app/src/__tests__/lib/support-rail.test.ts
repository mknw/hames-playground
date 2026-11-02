/**
 * `lib/support-rail.ts` — the collapsed support panel's pure half (#933).
 *
 * Covered here: the per-browser collapse preference (localStorage, both
 * halves guarded), the activity counters and the growth-only tab diff, and
 * two pins that keep the rail honest with the code it mirrors — the rail's
 * icons must be the ones the expanded tab strip renders (scanned from
 * `SupportPanel.tsx` source), and `SUPPORT_BLINK_MS` must mirror the
 * `support-rail-blink` keyframe duration in `uno.config.ts` (the same pair
 * `uno-theme.test.ts` pins for the sandbox tab).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import {
  SUPPORT_BLINK_MS,
  SUPPORT_COLLAPSE_KEY,
  SUPPORT_RAIL_TABS,
  countActivity,
  loadSupportCollapsePref,
  saveSupportCollapsePref,
  tabsToBlink,
} from '~/lib/support-rail'

const event = (over: Partial<ContextEvent>): ContextEvent => ({
  type: 'tool_result',
  ts: 0,
  patternId: 'p',
  data: {},
  ...over,
})

beforeEach(() => {
  localStorage.clear()
})

describe('collapse preference — per browser, guarded', () => {
  it('reads expanded when nothing was ever saved', () => {
    expect(localStorage.getItem(SUPPORT_COLLAPSE_KEY)).toBeNull()
    expect(loadSupportCollapsePref()).toBe(false)
  })

  it('round-trips the choice', () => {
    saveSupportCollapsePref(true)
    expect(localStorage.getItem(SUPPORT_COLLAPSE_KEY)).toBe('true')
    expect(loadSupportCollapsePref()).toBe(true)
    saveSupportCollapsePref(false)
    expect(loadSupportCollapsePref()).toBe(false)
  })

  it('fails closed to expanded when storage refuses to read', () => {
    const getItem = vi.fn(() => {
      throw new Error('denied')
    })
    vi.stubGlobal('localStorage', { getItem, setItem: vi.fn() })
    expect(loadSupportCollapsePref()).toBe(false)
  })

  it('swallows a refused write instead of breaking the toggle', () => {
    const setItem = vi.fn(() => {
      throw new Error('quota')
    })
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem })
    expect(() => saveSupportCollapsePref(true)).not.toThrow()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })
})

describe('activity counters and the growth-only diff', () => {
  it('counts events, tool results, memory writes and graph elements', () => {
    const activity = countActivity(
      [
        event({ type: 'tool_result' }),
        event({ type: 'tool_result' }),
        event({ type: 'memory_written' }),
        event({ type: 'user_message' }),
      ],
      [{}, {}, {}],
    )
    expect(activity).toEqual({
      events: 4,
      toolResults: 2,
      memoryWrites: 1,
      graphElements: 3,
    })
  })

  it('blinks a tab only for growth — never for a shrink', () => {
    const before = { events: 4, toolResults: 2, memoryWrites: 1, graphElements: 3 }
    // Cleared graph and cleared events: the user's own act, not an
    // announcement.
    expect(
      tabsToBlink(before, { events: 0, toolResults: 0, memoryWrites: 0, graphElements: 0 }),
    ).toEqual([])
  })

  it('maps each counter to its tab, overlapping where the event is both', () => {
    const before = { events: 1, toolResults: 0, memoryWrites: 0, graphElements: 0 }
    const after = { events: 2, toolResults: 1, memoryWrites: 0, graphElements: 0 }
    // A tool result is both a context event (Context manager) and a Data
    // document (Data), so both tabs blink.
    expect(tabsToBlink(before, after)).toEqual(['stats', 'data'])
  })

  it('blinks Neo4j on new graph elements and Memory on a memory write', () => {
    const before = { events: 0, toolResults: 0, memoryWrites: 0, graphElements: 0 }
    expect(
      tabsToBlink(before, { events: 0, toolResults: 0, memoryWrites: 1, graphElements: 2 }),
    ).toEqual(['neo4j-graph', 'memory'])
  })

  it('no growth, no blink', () => {
    const same = { events: 3, toolResults: 1, memoryWrites: 1, graphElements: 2 }
    expect(tabsToBlink(same, { ...same })).toEqual([])
  })
})

describe('the rail stays honest with the panel it stands in for', () => {
  const panelSource = readFileSync(
    join(__dirname, '..', '..', 'components', 'ark-ui', 'SupportPanel.tsx'),
    'utf8',
  )

  /** The icon class the expanded tab trigger for `tabId` renders. Scans
   *  forward from the trigger's `value="…"` to the next icon class or the
   *  trigger's closing tag. */
  const triggerIcon = (tabId: string): string | null => {
    const start = panelSource.indexOf(`value="${tabId}"`)
    expect(start, `SupportPanel.tsx has a Tabs.Trigger for ${tabId}`).toBeGreaterThan(-1)
    const window = panelSource.slice(start, panelSource.indexOf('</Tabs.Trigger>', start))
    const match = window.match(/i-material-symbols-[a-z0-9-]+/)
    return match ? match[0] : null
  }

  it('uses the same icon as each expanded tab trigger', () => {
    for (const tab of SUPPORT_RAIL_TABS) {
      expect(triggerIcon(tab.id), `rail icon for ${tab.id}`).toBe(tab.iconClass)
    }
  })

  it('covers every tab the panel has', () => {
    // Trigger open tags wrap, so collect the value that follows each
    // <Tabs.Trigger rather than matching both on one line.
    const values: string[] = []
    let at = panelSource.indexOf('<Tabs.Trigger')
    while (at !== -1) {
      const value = panelSource.slice(at, at + 120).match(/value="([a-z0-9-]+)"/)
      if (value) values.push(value[1])
      at = panelSource.indexOf('<Tabs.Trigger', at + 1)
    }
    expect([...SUPPORT_RAIL_TABS.map((t) => t.id)].sort()).toEqual(values.sort())
  })

  it('mirrors the keyframe duration it promises', () => {
    const unoConfig = readFileSync(join(__dirname, '..', '..', '..', 'uno.config.ts'), 'utf8')
    expect(unoConfig).toContain(`support-rail-blink ${(SUPPORT_BLINK_MS / 1000).toFixed(1)}s`)
    // The reduced-motion fallback is part of the contract: a static accent
    // dot instead of the pulse.
    const block = unoConfig.slice(unoConfig.indexOf('support-rail-blink'))
    expect(block).toContain('.support-rail-blink-dot')
    expect(block).toContain('prefers-reduced-motion: reduce')
  })
})
