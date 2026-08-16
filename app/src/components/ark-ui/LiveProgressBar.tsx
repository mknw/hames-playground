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
 */
import { Show, createSignal, createMemo, createEffect, on, onCleanup } from 'solid-js'
import { Progress } from '@ark-ui/solid/progress'

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
}

const STATUS_FADE_MS = 220
const EXIT_FADE_MS = 360
const FILL_TRANSITION_MS = 420
/** Don't show the bar until the chain has been running this long — direct
 *  router responses complete in <1s and don't deserve a flash of progress UI. */
const MOUNT_DELAY_MS = 350

export const LiveProgressBar = (props: LiveProgressBarProps) => {
  const [shownStatus, setShownStatus] = createSignal<string | null>(null)
  const [previousStatus, setPreviousStatus] = createSignal<string | null>(null)
  const [mounted, setMounted] = createSignal(false)
  const [entering, setEntering] = createSignal(false)

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
      }
    )
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
      }
    )
  )

  const max = createMemo(() => Math.max(1, props.maxProjection))
  const value = createMemo(() => {
    if (!props.visible) return max()
    const path = Math.max(1, props.pathProjection || max())
    const scaled = (props.current * max()) / path
    return Math.max(0, Math.min(max(), Math.round(scaled)))
  })
  const percent = createMemo(() =>
    Math.max(0, Math.min(100, (value() / max()) * 100))
  )

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
          border="~ neon-cyan/30"
        >
          AI
        </div>

        <div flex="~ col 1" style={{ 'min-width': 0 }}>
          <Progress.Root value={value()} min={0} max={max()} flex="~ col gap-1.5">
            {/* Status row: pulse + crossfading status text */}
            <div flex="~ items-center gap-2" h="4" style={{ position: 'relative' }}>
              <div
                w="1.5"
                h="1.5"
                rounded="full"
                bg="neon-cyan"
                class="animate-pulse"
                style={{ 'flex-shrink': 0 }}
              />
              <div flex="~ 1" style={{ position: 'relative', 'min-width': 0 }}>
                <Show when={previousStatus()}>
                  <Progress.Label
                    text="xs dark-text-tertiary"
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
                  text="xs dark-text-secondary"
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
        </div>
      </div>
    </Show>
  )
}
