/**
 * Support Panel Rail — the collapsed right panel's icons-only strip (#933).
 *
 * When the support panel collapses (the route calls the splitter's
 * `collapsePanel`), this 3rem rail takes its place at the window's right edge,
 * one icon per tab — the same icons the expanded tab strip renders, from the
 * shared metadata in `lib/support-rail.ts`. Clicking an icon expands the panel
 * on that tab.
 *
 * While collapsed, an event landing for a tab blinks that tab's icon softly
 * for one run of the `support-rail-blink` keyframes (`uno.config.ts`); under
 * `prefers-reduced-motion` the pulse is replaced by a static accent dot, the
 * same geometry as the left sidebar's collapsed-rail run dot.
 *
 * The rail is mounted only while collapsed, so its activity counters snapshot
 * the conversation as it stands at collapse time — the backlog never blinks;
 * only what lands from then on does.
 */

import { For, Show, createSignal, createEffect, onCleanup, untrack } from 'solid-js'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import type { GraphElement } from '@hames-ai/agents'
import {
  SUPPORT_BLINK_MS,
  SUPPORT_RAIL_TABS,
  countActivity,
  tabsToBlink,
  type SupportActivity,
  type SupportTabId,
} from '~/lib/support-rail'
import { sawSandboxEntry } from '~/lib/sandbox-blink'
import { SANDBOX_UNAVAILABLE_REASON } from './SupportPanel'

export interface SupportPanelRailProps {
  /** Which conversation is on screen — a switch re-snapshots the counters
   *  instead of blinking for another session's backlog. */
  sessionId: string
  graphElements: GraphElement[]
  contextEvents: ContextEvent[]
  /** Same rule as the Sandbox tab: a definite `false` greys the icon out. */
  sandboxAvailable?: boolean
  /** Expand the panel. With a tab, the panel opens on it; without, it keeps
   *  whatever tab it had selected when it collapsed. */
  onExpand: (tab?: SupportTabId) => void
}

export const SupportPanelRail = (props: SupportPanelRailProps) => {
  // One blink flag per tab. A second event for a tab while it is still
  // blinking does not restart the animation — the timer just extends it, the
  // same rule the sandbox tab's own blink applies.
  const [blinking, setBlinking] = createSignal<Partial<Record<SupportTabId, boolean>>>({})
  const timers = new Map<SupportTabId, ReturnType<typeof setTimeout>>()
  const startBlink = (tab: SupportTabId) => {
    setBlinking((prev) => ({ ...prev, [tab]: true }))
    const existing = timers.get(tab)
    if (existing) clearTimeout(existing)
    timers.set(
      tab,
      setTimeout(() => {
        timers.delete(tab)
        setBlinking((prev) => ({ ...prev, [tab]: false }))
      }, SUPPORT_BLINK_MS),
    )
  }
  onCleanup(() => {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  })

  // Activity watch. Growth-only diffs against the snapshot taken when the rail
  // mounted (or the session switched); a shrink — clearing the graph, a
  // session with fewer events — resets the baseline silently.
  // The mount-time snapshot; the tracked re-reads (and the session-switch
  // reset) live in the effect below.
  // eslint-disable-next-line solid/reactivity
  let prevSid = props.sessionId
  let prev: SupportActivity = untrack(() =>
    countActivity(props.contextEvents ?? [], props.graphElements ?? []),
  )
  createEffect(() => {
    const sid = props.sessionId
    const next = countActivity(props.contextEvents ?? [], props.graphElements ?? [])
    if (sid !== prevSid) {
      prevSid = sid
      prev = next
      return
    }
    const tabs = tabsToBlink(prev, next)
    prev = next
    for (const tab of tabs) startBlink(tab)
  })

  // Sandbox entry — the same signal the expanded tab blinks on, read by the
  // same pure helper with this rail's own seen-set.
  const seenSandboxEntries = new Set<string>()
  createEffect(() => {
    if (!sawSandboxEntry(props.contextEvents ?? [], seenSandboxEntries, Date.now())) return
    startBlink('sandbox')
  })

  const sandboxDisabled = () => props.sandboxAvailable === false

  return (
    <div
      data-testid="support-rail"
      flex="~ col"
      h="full"
      w="3rem"
      shrink="0"
      bg="ui-bg-primary"
      border="l ui-border-primary"
      items="center"
      p="y-2"
      gap="1"
    >
      {/* Expand — keeps the tab the panel had selected when it collapsed. */}
      <button
        onClick={() => props.onExpand()}
        title="Expand panel"
        aria-label="Expand panel"
        data-testid="support-rail-expand"
        p="2"
        rounded="md"
        hover="bg-ui-bg-hover"
        transition="colors"
        text="ui-accent"
        mb="2"
        flex="~"
      >
        <span class="i-material-symbols-chevron-left" w="4" h="4" aria-hidden="true" />
      </button>

      <div flex="~ col" items="center" gap="1" grow="1">
        <For each={SUPPORT_RAIL_TABS}>
          {(tab) => {
            const disabled = () => tab.id === 'sandbox' && sandboxDisabled()
            return (
              <button
                onClick={() => !disabled() && props.onExpand(tab.id)}
                title={disabled() ? SANDBOX_UNAVAILABLE_REASON : `Open ${tab.label} panel`}
                aria-label={`Open ${tab.label} panel`}
                aria-disabled={disabled() ? 'true' : undefined}
                data-testid={`support-rail-${tab.id}`}
                style={{
                  position: 'relative',
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  width: '32px',
                  height: '32px',
                  'border-radius': '0.375rem',
                  cursor: disabled() ? 'not-allowed' : 'pointer',
                  opacity: disabled() ? '0.4' : '1',
                }}
                hover={!disabled() ? 'bg-ui-bg-hover' : undefined}
                transition="colors"
              >
                <span
                  class={blinking()[tab.id] ? tab.iconClass + ' support-rail-blink' : tab.iconClass}
                  aria-hidden="true"
                  style={{
                    width: '16px',
                    height: '16px',
                    color: tab.accent,
                    opacity: disabled() ? '0.4' : '1',
                  }}
                />
                {/* The reduced-motion fallback's static dot (the CSS hides it
                    whenever motion is allowed). The accent is per-tab, so it
                    arrives inline — a dynamic utility class would never be
                    extracted. */}
                <Show when={blinking()[tab.id]}>
                  <span
                    aria-hidden="true"
                    class="support-rail-blink-dot"
                    style={{
                      position: 'absolute',
                      bottom: '2px',
                      right: '2px',
                      width: '6px',
                      height: '6px',
                      'border-radius': '9999px',
                      'background-color': tab.accent,
                    }}
                  />
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}
