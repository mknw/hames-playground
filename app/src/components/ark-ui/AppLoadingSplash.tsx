/**
 * AppLoadingSplash — the full-screen boot state, and the app's answer to
 * "nothing is on screen yet".
 *
 * ## The bug this exists for (#295)
 *
 * Post-login the app rendered a spinner "briefly" and then a WHITE SCREEN for
 * 3–4 seconds. Those are two different waits behind two different gates:
 *
 *   1. `AuthProvider`'s `<Show>` — the session read. It had this screen's
 *      ancestor (a spinner) as its fallback, which is why the wait was visible.
 *   2. `app.tsx`'s root `<Suspense>` — the route's lazy `import()` plus
 *      `AgentSelector`'s `getAgentList()` resource. It had NO FALLBACK, so
 *      everything inside it rendered as nothing.
 *
 * Gate 1's fallback unmounts at the instant gate 2 starts, which is why the
 * spinner appeared to be "superseded by" the blank: it was handing over to a
 * boundary with nothing in it. Measured with a paint timeline, both halves
 * reproduce on every load and only the duration varies.
 *
 * So this component is mounted by BOTH gates, and the fix is structural: there
 * is no longer a state on the post-login path that renders as bare white.
 *
 * ## Mounted twice, one continuous wait
 *
 * Because the two gates hand over, this component mounts twice per page load.
 * Its elapsed clock therefore lives in `lib/splash-progress.ts`, ACROSS mounts
 * — a per-mount clock would walk the bar backwards at the handover, which is a
 * smaller instance of the very complaint being fixed. Everything else here is
 * derived from that one number.
 *
 * ## Accessibility
 *
 * The bar and the rotating line are `aria-hidden`, and one stable phrase is
 * announced by a live region instead. Same decision, for the same reason, as
 * the cold-start notice in `LiveProgressBar`: a live region carrying text that
 * changes every 1.8 s interrupts a listener on every change, and the changing
 * text is flavour — the information is "still loading", which is said once.
 */
import { createSignal, onCleanup, onMount } from 'solid-js'
import { ProgressBar } from './ProgressBar'
import {
  SPLASH_TICK_MS,
  splashElapsedMs,
  splashLine,
  splashMounted,
  splashPercent,
  splashUnmounted,
} from '~/lib/splash-progress'

/** What the live region says, once, for the whole wait. */
export const SPLASH_ANNOUNCEMENT = 'Loading. Please wait.'

export interface AppLoadingSplashProps {
  /** Injectable clock, so the progression is testable without waiting for it.
   *  Defaults to `Date.now`. */
  now?: () => number
}

export const AppLoadingSplash = (props: AppLoadingSplashProps) => {
  // Seeded at 0 rather than from the clock, so the SERVER-rendered frame never
  // touches the module-level clock — module state is shared between requests
  // there, and an SSR read would make one request's splash inherit another's
  // elapsed time. Only the effect below, which does not run during SSR,
  // advances it.
  const [elapsed, setElapsed] = createSignal(0)

  onMount(() => {
    const clock = () => (props.now ?? Date.now)()
    // Tell the shared clock the splash is up. It decides whether this continues
    // the wait the other gate started or begins a new one — the gap it measures
    // is the one between an unmount and this mount, not between two ticks.
    splashMounted(clock())
    setElapsed(splashElapsedMs(clock()))
    const tick = setInterval(() => setElapsed(splashElapsedMs(clock())), SPLASH_TICK_MS)
    onCleanup(() => {
      clearInterval(tick)
      splashUnmounted(clock())
    })
  })

  return (
    <div
      flex="~"
      items="center"
      justify="center"
      min-h="screen"
      bg="ui-bg-primary"
      p="6"
      data-testid="app-loading-splash"
    >
      <div flex="~ col" items="center" gap="4" w="full" max-w="sm">
        <div text="xl ui-text-primary center" font="medium">
          Loading DTalk.ai Knowledge System
        </div>

        {/* The visual story, entirely decorative — see the header. */}
        <div w="full" aria-hidden="true">
          <ProgressBar percent={splashPercent(elapsed())} trackTestId="splash-progress-track">
            {/* The chain bar's own status row, same arrangement: a pulse dot,
                then the line. Keeps the two bars reading as one system. */}
            <div flex="~ items-center gap-2" h="4">
              <div
                w="1.5"
                h="1.5"
                rounded="full"
                bg="ui-accent"
                animate="pulse"
                style={{ 'flex-shrink': 0 }}
              />
              <span text="xs ui-text-secondary" truncate="" data-testid="splash-line">
                {splashLine(elapsed())}
              </span>
            </div>
          </ProgressBar>
        </div>

        <span sr-only aria-live="polite" role="status">
          {SPLASH_ANNOUNCEMENT}
        </span>
      </div>
    </div>
  )
}
