/**
 * Keep the private tier warm while the app is open and visible — the browser half.
 *
 * Owner, 2026-11-04: "immediately boot up the GPU on release when someone opens
 * the app. wait for cooldown delay after app is closed."
 *
 * The browser decides only WHEN to ask. Whether to wake, which boxes, how often
 * and whether this user's tier allows it are the server's
 * (`harness-client/preview-header.server.ts`, `keepPrivateTierWarm`), so this
 * module holds no tier logic and no number of its own: the cadence is whatever
 * the last answer's `nextInMs` said, and the idle cap its `idleCapMs`.
 *
 * - **On start, and whenever the page becomes visible**, it asks at once. The
 *   first ask is the app-load wake.
 * - **While visible**, it asks again `nextInMs` after each answer, never while
 *   one is still pending (a cold wake can legitimately take minutes).
 * - **When hidden or closed**, it stops. No ask is sent while hidden; the boxes
 *   then scale down after their configured windows, which is the owner's
 *   "cooldown delay" — nothing here adds a timer of its own.
 * - **When visible but idle** — no pointer, key or focus event for `idleCapMs`
 *   (`PRIVATE_TIER_WARM_IDLE_MINUTES`, FRONT 2026-11-04) — it stops the same
 *   way, and the next interaction asks at once, which wakes the boxes through
 *   the same shared wake. Opening the page and showing it again count as
 *   interactions. An abandoned tab therefore costs at most the idle cap plus
 *   one scale-down window of GPU time.
 * - **`enabled: false`** stops it for the page's life: the setting is off or the
 *   tier is not configured, and neither changes while the page is open.
 * - **A failed ask** (a wake that did not land, a refused gate) stops it until
 *   the page is shown again. Retrying on a timer would keep polling a broken box
 *   for as long as a tab stays open; a turn still wakes the box itself.
 */
import type { KeepWarmAnswer } from './harness-client/preview-header.server'

type VisibilityDoc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
type ActivityTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/** The input that counts as a person being there. `focus` is the window
 *  regaining focus; `focusin` is focus moving inside the page. */
export const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'focus',
  'focusin',
] as const

export interface KeepWarmOptions {
  /** The server action. Injected so the loop is testable without an RPC. */
  ask: () => Promise<KeepWarmAnswer>
  /** Called after an ask that actually reached a box, so the header can re-read
   *  the box state without waiting for its own poll. */
  onWarmed?: () => void
  doc?: VisibilityDoc
  /** Where activity events are heard: the window, which sees the page's
   *  bubbling pointer and key events as well as its own focus. */
  activity?: ActivityTarget
}

/** Start the loop; returns the function that stops it (for `onCleanup`). */
export function startKeepWarm({
  ask,
  onWarmed,
  doc = document,
  activity = window,
}: KeepWarmOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let disabled = false
  let disposed = false
  let idle = false
  let idleCapMs: number | null = null
  let lastActivity = Date.now()

  const visible = () => doc.visibilityState === 'visible'
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const run = async (): Promise<void> => {
    clear()
    if (disposed || disabled || pending || !visible()) return
    if (idleCapMs !== null && Date.now() - lastActivity >= idleCapMs) {
      // Idle: stop asking, and let the next interaction resume.
      idle = true
      return
    }
    pending = true
    try {
      const answer = await ask()
      if (!answer.enabled || answer.nextInMs === null) {
        disabled = true
        return
      }
      idleCapMs = answer.idleCapMs
      if (answer.warmed) onWarmed?.()
      if (!disposed && visible()) timer = setTimeout(() => void run(), answer.nextInMs)
    } catch (err) {
      // No next ask is scheduled: the loop stays stopped until the page is
      // shown again (`onVisibility`), never retrying a broken box on a timer.
      console.warn(
        '[keep-warm] the private tier could not be kept warm; stopping until the page is shown again:',
        err,
      )
    } finally {
      pending = false
    }
  }

  // Hiding needs no handler of its own: a timer that fires while hidden finds
  // `run` refusing, and showing the page again asks at once.
  const onVisibility = () => {
    if (!visible()) return
    lastActivity = Date.now()
    idle = false
    void run()
  }

  // Cheap on every event (a timestamp); it asks only when the cap had stopped
  // the loop, so a moving pointer is not a request stream.
  const onActivity = () => {
    lastActivity = Date.now()
    if (!idle) return
    idle = false
    void run()
  }

  doc.addEventListener('visibilitychange', onVisibility)
  for (const type of ACTIVITY_EVENTS) activity.addEventListener(type, onActivity, { passive: true })
  void run()
  return () => {
    disposed = true
    clear()
    doc.removeEventListener('visibilitychange', onVisibility)
    for (const type of ACTIVITY_EVENTS) activity.removeEventListener(type, onActivity)
  }
}
