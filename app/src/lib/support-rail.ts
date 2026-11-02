/**
 * The collapsed support-panel rail (#933) — client-safe, pure.
 *
 * The right panel collapses the way the left sidebar already does (#60): to a
 * 3rem icons-only rail, one icon per tab. While collapsed, an event that lands
 * for a tab blinks that tab's icon softly for one run of the keyframes —
 * {@link SUPPORT_BLINK_MS}, mirrored by the duration in `uno.config.ts`
 * (`uno-theme.test.ts` pins the pair, as it does the sandbox tab's).
 *
 * The tab metadata here is the rail's single source, and the icons MUST stay
 * the ones the expanded tabs render — `support-rail.test.ts` scans
 * `SupportPanel.tsx` and fails if a rail icon drifts from its trigger's.
 */
// @unocss-include — icon class literals in a .ts file are outside UnoCSS's
// default scan set; this marker plus the content.filesystem entry in
// uno.config.ts is what emits their CSS.
import type { ContextEvent } from '@hames-ai/harness-patterns'

/** One tab of the support panel, by its Ark Tabs value. */
export type SupportTabId = 'neo4j-graph' | 'memory' | 'stats' | 'data' | 'sandbox'

/** How long a rail icon carries the blink class: one run of the keyframes,
 *  mirrored by the animation duration in `uno.config.ts`. */
export const SUPPORT_BLINK_MS = 1_200

export interface SupportTabMeta {
  id: SupportTabId
  label: string
  /** The icon utility class — the same one the tab trigger renders. */
  iconClass: string
  /** The tab's accent, as rendered by its active trigger. Literal hexes where
   *  the trigger itself uses one (Context manager, Data, Sandbox), so the rail
   *  and the tab cannot disagree; the theme-token rule keeps them honest. */
  accent: string
}

/** Rail order = tab-strip order. */
export const SUPPORT_RAIL_TABS: readonly SupportTabMeta[] = [
  {
    id: 'neo4j-graph',
    label: 'Neo4j',
    iconClass: 'i-material-symbols-database-outline',
    accent: 'var(--ui-accent)',
  },
  {
    id: 'memory',
    label: 'Memory',
    iconClass: 'i-material-symbols-psychology-outline',
    accent: 'var(--ui-accent)',
  },
  {
    id: 'stats',
    label: 'Context manager',
    iconClass: 'i-material-symbols-analytics-outline',
    accent: '#f59e0b',
  },
  {
    id: 'data',
    label: 'Data',
    iconClass: 'i-material-symbols-dataset-outline',
    accent: '#22d3ee',
  },
  {
    id: 'sandbox',
    label: 'Sandbox',
    iconClass: 'i-material-symbols-terminal',
    accent: '#10b981',
  },
]

// ---------------------------------------------------------------------------
// Collapsed/expanded persistence
// ---------------------------------------------------------------------------

/** The collapsed/expanded choice is per BROWSER, not per user: localStorage,
 *  never the profile. Both halves try/catch — a private-browsing quota error
 *  or an SSR render with no `localStorage` must not break the panel. */
export const SUPPORT_COLLAPSE_KEY = 'support-panel.collapsed'

/** Absent key = expanded, the today behaviour. */
export function loadSupportCollapsePref(): boolean {
  try {
    return localStorage.getItem(SUPPORT_COLLAPSE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveSupportCollapsePref(collapsed: boolean): void {
  try {
    localStorage.setItem(SUPPORT_COLLAPSE_KEY, String(collapsed))
  } catch {
    // Storage refused (private mode, SSR) — the choice just does not persist.
  }
}

// ---------------------------------------------------------------------------
// Which tabs have fresh activity
// ---------------------------------------------------------------------------

/** Per-tab activity counters, snapshotted when the rail mounts and diffed as
 *  the conversation moves. Count-based on purpose (see `tabsToBlink`): the
 *  route hands the panel whole arrays, and a length is the only thing both
 *  sources share without interpreting their payloads. */
export interface SupportActivity {
  /** Any context event — the Context manager tab's signal. */
  events: number
  /** Graph elements — the Neo4j tab's signal. */
  graphElements: number
  /** `tool_result` events — the Data tab's signal (its documents arrive as
   *  tool results). */
  toolResults: number
  /** `memory_written` events — the Memory tab's signal (#419: the store step
   *  emits one per written or reinforced memory). */
  memoryWrites: number
}

export function countActivity(
  events: readonly ContextEvent[],
  graphElements: readonly unknown[],
): SupportActivity {
  let toolResults = 0
  let memoryWrites = 0
  for (const e of events) {
    if (e.type === 'tool_result') toolResults++
    if (e.type === 'memory_written') memoryWrites++
  }
  return {
    events: events.length,
    graphElements: graphElements.length,
    toolResults,
    memoryWrites,
  }
}

/** The tabs whose counters GREW between two snapshots. Growth only, never
 *  shrink: clearing the graph or the events is the user's own act, visible in
 *  the panel the moment it expands, not something to announce. A new event
 *  blinks Context manager always and its source tab as well — a tool result
 *  is both a context event and a Data document. */
export function tabsToBlink(prev: SupportActivity, next: SupportActivity): SupportTabId[] {
  const tabs: SupportTabId[] = []
  if (next.graphElements > prev.graphElements) tabs.push('neo4j-graph')
  if (next.memoryWrites > prev.memoryWrites) tabs.push('memory')
  if (next.events > prev.events) tabs.push('stats')
  if (next.toolResults > prev.toolResults) tabs.push('data')
  return tabs
}
