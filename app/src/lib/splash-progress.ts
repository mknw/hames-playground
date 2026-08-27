/**
 * The boot splash's copy and its arithmetic — client-safe, and pure apart from
 * the one clock documented below.
 *
 * Split out of `AppLoadingSplash.tsx` for the reason `cold-start-format.ts` is
 * split out of the notice that renders it: the interesting claims here are
 * about NUMBERS ("the fill never reaches 100", "a remount inside the gap keeps
 * the wait"), and a claim about a number is cheaper to pin as a function call
 * than as a rendered component.
 *
 * ## Why there is a clock in here at all
 *
 * The post-login wait is TWO waits behind two different gates, and before #295
 * only the first had anything on screen (see `app.tsx`'s root `<Suspense>`).
 * With both gates now showing this splash, the component MOUNTS TWICE in one
 * page load — `AuthProvider`'s `<Show>` unmounts it at the instant the root
 * `<Suspense>` mounts it — and a per-mount clock would send the bar backwards
 * in the middle of one continuous wait. That backwards jump is a smaller
 * version of the same complaint the fix is for, so the elapsed time is held
 * here, ACROSS mounts, rather than in component state.
 */

/**
 * The rotating status lines, in order.
 *
 * Deliberately about the app's own furniture (the graph, conversations, agents,
 * tools) and nothing else: this screen is the first thing a new user sees, and
 * it is the one surface where a joke cannot be qualified by context. Harmless
 * and theme-agnostic is a requirement, not a preference.
 *
 * The last one is written to be the one a long wait sits on — see
 * {@link splashLine}, which clamps rather than cycling, because a list that
 * loops reads as a stall the second time round.
 */
export const SPLASH_LINES = [
  'waking the graph…',
  'counting your conversations…',
  'teaching the agents your name…',
  'warming up the tool belt…',
  'untangling a few edges…',
  'reticulating knowledge splines…',
  'asking the nodes to stand in line…',
  'looking for the good answers first…',
  'almost there…',
] as const

/** How long each line stays up. */
export const SPLASH_LINE_MS = 1800

/**
 * The fill's time constant, in the exponential below.
 *
 * Chosen against the wait this screen actually covers rather than as a round
 * number: the measured post-login window is ~350 ms (warm dev server) to ~4 s
 * (the owner's report on the preview), and 2 600 ms puts the bar at 13 % after
 * 350 ms, 32 % after 1 s and 71 % after 3 s — i.e. visibly moving across the
 * whole range instead of crawling at one end of it.
 */
export const SPLASH_FILL_TAU_MS = 2600

/**
 * The ceiling the fill approaches and never reaches.
 *
 * This is the honesty constraint, and it is a requirement: the wait's real
 * length is UNKNOWABLE from inside the splash (it is a dynamic `import()` plus
 * an RPC), so a bar that reached 100 % would be claiming to know. A bar sitting
 * full while the screen stays put reads as a hung app — strictly worse than the
 * blank screen it replaced, because it looks like a promise being broken. The
 * bar completes by DISAPPEARING: the splash unmounts when the thing it was
 * waiting for arrives.
 */
export const SPLASH_FILL_CEILING = 92

/**
 * A floor, so the first painted frame carries a visible sliver.
 *
 * The server-rendered frame is at elapsed 0, where the exponential is exactly
 * 0, and a zero-width range is indistinguishable from a bar that is broken.
 */
export const SPLASH_FILL_FLOOR = 3

/**
 * How long the splash may be OFF SCREEN and still be the same wait when it
 * comes back.
 *
 * Six times the splash's own tick: the handful of milliseconds between
 * `AuthProvider`'s unmount and the root `<Suspense>`'s mount is continuous,
 * while a suspension seconds later is a new wait — which is the reading a user
 * would give it too.
 */
export const SPLASH_CONTINUITY_GAP_MS = 600

/** How often the splash re-reads the clock. One frame of a bar, not of a video:
 *  the fill transitions in CSS, so this only has to be often enough that the
 *  transition has a new target to move towards. */
export const SPLASH_TICK_MS = 100

// ---------------------------------------------------------------------------
// The cross-mount clock
// ---------------------------------------------------------------------------

let startedAt: number | null = null
/** How many splashes are on screen. Never above 1 in the app — the two gates
 *  are nested and mutually exclusive — but counted rather than assumed, so an
 *  overlapping mount cannot orphan the idle mark. */
let mounted = 0
/** When the last splash left the screen, or null while one is up. */
let idleSince: number | null = null

/**
 * Tell the clock a splash has appeared, continuing the current wait if one was
 * on screen recently enough.
 *
 * THE GAP IS MEASURED BETWEEN UNMOUNT AND REMOUNT, deliberately, and not
 * between two reads of the clock. A read-interval heuristic was the first
 * version and it had a bug a test found: browsers throttle `setInterval` in a
 * background tab to about once a second, so a user who tabbed away mid-load and
 * came back would have tripped the gap and watched the bar restart. What ends a
 * wait is the splash going away, which is an event this module can be told
 * about, so it is told rather than inferred.
 *
 * Called from `onMount`, which does not run during SSR — so no request can
 * mutate module state that the next request would inherit.
 */
export function splashMounted(now: number): void {
  mounted += 1
  const staleGap = idleSince !== null && now - idleSince > SPLASH_CONTINUITY_GAP_MS
  if (startedAt === null || staleGap) startedAt = now
  idleSince = null
}

/** Tell the clock a splash has left the screen. */
export function splashUnmounted(now: number): void {
  mounted = Math.max(0, mounted - 1)
  if (mounted === 0) idleSince = now
}

/**
 * Milliseconds since the current wait began — pure, and 0 before any splash has
 * mounted.
 *
 * `now` is a parameter rather than a `Date.now()` call so the whole progression
 * is testable without waiting for it, the same reason `LiveProgressBar` takes an
 * injectable `now`.
 */
export function splashElapsedMs(now: number): number {
  return startedAt === null ? 0 : Math.max(0, now - startedAt)
}

/** Forget everything. For tests — in the app a wait ends by the splash
 *  unmounting and staying gone for longer than the gap. */
export function resetSplashClock(): void {
  startedAt = null
  mounted = 0
  idleSince = null
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/** The line to show at `elapsedMs`. Clamps at the last entry; see
 *  {@link SPLASH_LINES}. */
export function splashLine(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPLASH_LINE_MS)
  return SPLASH_LINES[Math.min(index, SPLASH_LINES.length - 1)]
}

/**
 * The fill percentage at `elapsedMs` — an exponential approach to
 * {@link SPLASH_FILL_CEILING} that is mathematically incapable of reaching it.
 */
export function splashPercent(elapsedMs: number): number {
  const elapsed = Math.max(0, elapsedMs)
  const approach = SPLASH_FILL_CEILING * (1 - Math.exp(-elapsed / SPLASH_FILL_TAU_MS))
  return Math.max(SPLASH_FILL_FLOOR, Math.min(SPLASH_FILL_CEILING, Math.round(approach)))
}
