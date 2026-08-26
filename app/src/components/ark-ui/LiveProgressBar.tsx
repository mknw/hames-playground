/**
 * LiveProgressBar
 *
 * Inline status bar surfaced while a harness chain is in flight. Lives as a
 * trailing slot in `ChatMessages` so it appears where the next assistant
 * bubble will land.
 *
 * Layout:
 *   [pulse dot]  <status text crossfade>
 *   [─────────────────────────────────] linear progress (no fraction text)
 *
 * Bar resolution
 * --------------
 * `max` is fixed for the chain (worst-case projection from the harness).
 * `value` is `currentTurn` mapped through `(currentTurn * max / pathProjection)`
 * so the fill rate adapts to the chosen route while the denominator stays
 * stable — supplied by the consumer.
 *
 * Visibility
 * ----------
 * A short mount delay (`MOUNT_DELAY_MS`) means direct router responses
 * (typically <1s) finish before the bar would have appeared, so the bar
 * never enters for conversational replies.
 *
 * The warming variant
 * -------------------
 * While the turn is waiting on a self-hosted box that is still starting
 * (`warming`), the same mounted shell renders a SPINNER and a counting-down
 * estimate INSTEAD of the bar. The bar's denominator is seeded by the first
 * event of the turn, so without this it would appear at 0/N and sit there for
 * the whole cold start — measured at 146s on 2026-08-26 — which reads as a
 * hung chat rather than as a wait.
 *
 * The two variants share the avatar and the outer row, and the column reserves
 * the same `min-h` in BOTH, so the swap changes what is in the box and never
 * the box: the trailing slot does not resize under the transcript when the
 * answer finally starts. That is also why the variant is a branch in this file
 * rather than a sibling component — a shared geometry that lives in two files
 * is a geometry that drifts.
 */
import { Show, createSignal, createMemo, createEffect, on, onCleanup } from 'solid-js'
import { Progress } from '@ark-ui/solid/progress'
import {
  COLD_START_HEADLINE,
  coldStartAnnouncement,
  coldStartBasisHint,
  coldStartDetail,
} from '~/lib/cold-start-format'
import type { WarmingNotice } from '~/lib/run-registry'

export interface LiveProgressBarProps {
  status: string | null
  /** Cumulative steps completed (1-based when active, 0 before first event). */
  current: number
  /** Refined projection of the chosen path. May shrink as routes resolve. */
  pathProjection: number
  /** Stable bar-resolution: maximum across all branches. */
  maxProjection: number
  /** Whether the bar should be shown. Flipping to true after MOUNT_DELAY_MS
   *  schedules the entry animation; flipping to false plays the exit. */
  visible: boolean
  /** Non-null while the turn waits on a cold self-hosted box. Suppresses the
   *  bar in favour of the spinner for as long as it is set. */
  warming?: WarmingNotice | null
  /** Injectable clock, so the countdown is testable without waiting for it.
   *  Defaults to `Date.now`. */
  now?: () => number
}

const STATUS_FADE_MS = 220
const EXIT_FADE_MS = 360
const FILL_TRANSITION_MS = 420
/** Don't show the bar until the chain has been running this long — direct
 *  router responses complete in <1s and don't deserve a flash of progress UI. */
const MOUNT_DELAY_MS = 350
/** How often the warming estimate is re-rendered. One second is what a
 *  countdown means; nothing else in this component ticks. */
const COUNTDOWN_TICK_MS = 1000

export const LiveProgressBar = (props: LiveProgressBarProps) => {
  const [shownStatus, setShownStatus] = createSignal<string | null>(null)
  const [previousStatus, setPreviousStatus] = createSignal<string | null>(null)
  const [mounted, setMounted] = createSignal(false)
  const [entering, setEntering] = createSignal(false)
  /** Ticked once a second, and only while a notice is up — a chat with no cold
   *  start pays no timer at all. */
  const [now, setNow] = createSignal(Date.now())

  let exitTimer: number | undefined
  let mountTimer: number | undefined
  let statusTimer: number | undefined

  onCleanup(() => {
    if (exitTimer !== undefined) clearTimeout(exitTimer)
    if (mountTimer !== undefined) clearTimeout(mountTimer)
    if (statusTimer !== undefined) clearTimeout(statusTimer)
  })

  // Crossfade when the status string changes.
  createEffect(
    on(
      () => props.status,
      (next, prev) => {
        if (next === prev) return
        if (statusTimer !== undefined) clearTimeout(statusTimer)
        setPreviousStatus((prev as string | null | undefined) ?? null)
        setShownStatus(next)
        statusTimer = window.setTimeout(() => {
          setPreviousStatus(null)
          statusTimer = undefined
        }, STATUS_FADE_MS)
      },
    ),
  )

  // Mount/unmount with delays:
  //  - On `visible: true`, wait MOUNT_DELAY_MS before mounting (skips short
  //    direct-response chains entirely).
  //  - On `visible: false`, run the exit transition then unmount.
  createEffect(
    on(
      () => props.visible,
      (next) => {
        if (mountTimer !== undefined) {
          clearTimeout(mountTimer)
          mountTimer = undefined
        }
        if (exitTimer !== undefined) {
          clearTimeout(exitTimer)
          exitTimer = undefined
        }
        if (next) {
          mountTimer = window.setTimeout(() => {
            mountTimer = undefined
            setMounted(true)
            requestAnimationFrame(() => setEntering(true))
          }, MOUNT_DELAY_MS)
        } else {
          if (!mounted()) return
          setEntering(false)
          exitTimer = window.setTimeout(() => {
            setMounted(false)
            exitTimer = undefined
          }, EXIT_FADE_MS)
        }
      },
    ),
  )

  // The countdown's own clock. Armed only while a notice is up, and torn down
  // with it — the estimate is the one thing in this component that changes
  // without an event arriving.
  createEffect(
    on(
      () => !!props.warming,
      (warming) => {
        if (!warming) return
        setNow((props.now ?? Date.now)())
        const tick = setInterval(() => setNow((props.now ?? Date.now)()), COUNTDOWN_TICK_MS)
        onCleanup(() => clearInterval(tick))
      },
    ),
  )

  /** Elapsed since the frame landed, measured entirely in this browser's clock —
   *  see `WarmingNotice.receivedAt`. */
  const elapsedMs = createMemo(() => {
    const notice = props.warming
    return notice ? Math.max(0, now() - notice.receivedAt) : 0
  })

  const max = createMemo(() => Math.max(1, props.maxProjection))
  const value = createMemo(() => {
    if (!props.visible) return max()
    const path = Math.max(1, props.pathProjection || max())
    const scaled = (props.current * max()) / path
    return Math.max(0, Math.min(max(), Math.round(scaled)))
  })
  const percent = createMemo(() => Math.max(0, Math.min(100, (value() / max()) * 100)))

  return (
    <Show when={mounted()}>
      <div
        flex="~"
        gap="3"
        data-role="assistant"
        data-progress=""
        style={{
          opacity: entering() ? 1 : 0,
          transform: entering() ? 'translateY(0)' : 'translateY(4px)',
          transition: `opacity ${EXIT_FADE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), transform ${EXIT_FADE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        {/* Avatar — matches assistant message layout */}
        <div
          flex="~ shrink-0"
          w="8"
          h="8"
          rounded="full"
          items="center"
          justify="center"
          text="white xs"
          font="medium"
          bg="cyber-800"
          border="~ ui-accent/30"
        >
          AI
        </div>

        {/* The shared shell. `min-h="10"` (2.5rem) is written as a literal
            because UnoCSS extracts attributify utilities from literal
            `attr="value"` text — a constant read at runtime emits no CSS and
            the reservation would silently not exist. It is the height of the
            TALLER variant (the warming one: headline, gap, detail), so the
            progress variant centres inside it and the trailing slot does not
            resize when the notice gives way to the bar. */}
        <div
          flex="~ col 1"
          justify="center"
          min-h="10"
          style={{ 'min-width': 0 }}
          data-testid="progress-shell"
        >
          <Show
            when={props.warming}
            fallback={
              <Progress.Root value={value()} min={0} max={max()} flex="~ col gap-1.5">
                {/* Status row: pulse + crossfading status text */}
                <div flex="~ items-center gap-2" h="4" style={{ position: 'relative' }}>
                  <div
                    w="1.5"
                    h="1.5"
                    rounded="full"
                    bg="ui-accent"
                    class="animate-pulse"
                    style={{ 'flex-shrink': 0 }}
                  />
                  <div flex="~ 1" style={{ position: 'relative', 'min-width': 0 }}>
                    <Show when={previousStatus()}>
                      <Progress.Label
                        text="xs ui-text-tertiary"
                        truncate=""
                        style={{
                          position: 'absolute',
                          inset: 0,
                          opacity: 0,
                          transition: `opacity ${STATUS_FADE_MS}ms ease`,
                          'pointer-events': 'none',
                        }}
                      >
                        {previousStatus()}
                      </Progress.Label>
                    </Show>
                    <Progress.Label
                      text="xs ui-text-secondary"
                      truncate=""
                      style={{
                        display: 'block',
                        opacity: shownStatus() ? 1 : 0,
                        transition: `opacity ${STATUS_FADE_MS}ms ease`,
                      }}
                    >
                      {shownStatus() ?? '\u00a0'}
                    </Progress.Label>
                  </div>
                </div>

                {/* Linear bar — no fraction text shown alongside */}
                <Progress.Track
                  style={{
                    height: '3px',
                    'background-color': 'rgb(58, 58, 74)',
                    'border-radius': '9999px',
                    overflow: 'hidden',
                  }}
                >
                  <Progress.Range
                    style={{
                      height: '100%',
                      width: `${percent()}%`,
                      'background-image':
                        'linear-gradient(90deg, rgba(0,255,255,0.85), rgba(157,0,255,0.85))',
                      'box-shadow': '0 0 8px rgba(0,255,255,0.45)',
                      transition: `width ${FILL_TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
                    }}
                  />
                </Progress.Track>
              </Progress.Root>
            }
          >
            {(notice) => (
              <div flex="~ col gap-1.5" data-testid="cold-start-notice">
                {/* Headline: spinner + the state, in fixed words. Both the
                    glyph and the detail below are aria-hidden — the whole
                    notice is announced ONCE by the live region at the end,
                    because a region carrying the countdown would interrupt a
                    listener every second for two minutes. */}
                <div flex="~ items-center gap-2" h="4">
                  <span
                    class="cold-start-spin i-material-symbols-autorenew"
                    w="3.5"
                    h="3.5"
                    text="ui-accent"
                    style={{ 'flex-shrink': 0 }}
                    aria-hidden="true"
                  />
                  <span text="xs ui-text-secondary" truncate="" aria-hidden="true">
                    {COLD_START_HEADLINE}
                  </span>
                </div>
                {/* `ui-text-secondary`, not tertiary: this is the only line in
                    the notice carrying information — the countdown — and
                    `A11Y-CHECKLIST.md`'s `color-contrast` row names
                    `#71717a` (the tertiary token's dark value) as a muted
                    LABEL colour, not a text colour. It measures ≈4.06:1 on
                    `#0a0a0f` and ≈3.83:1 on `#12121a` against a 4.5:1 floor;
                    secondary (`#a1a1aa`) is ≈7.7:1, and is what the headline
                    a line above already uses. */}
                <span
                  text="xs ui-text-secondary"
                  truncate=""
                  title={coldStartBasisHint(notice().basis, notice().samples)}
                  aria-hidden="true"
                >
                  {coldStartDetail(notice().estimateMs, elapsedMs())}
                </span>
                {/* Announced once, when the wait starts: the phrase is derived
                    from the estimate the frame carried, which does not change
                    for the life of the notice. Same shape as the header
                    strip's warm indicator. */}
                <span sr-only aria-live="polite">
                  {coldStartAnnouncement(notice().estimateMs)}
                </span>
              </div>
            )}
          </Show>
        </div>
      </div>
    </Show>
  )
}
