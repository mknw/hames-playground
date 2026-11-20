/**
 * Keep the self-deployed GPUs running until switched off — the server half of
 * #1047's admin switch.
 *
 * The keep-warm machinery that already exists (`wake.server.ts`, "KEEP WARM
 * WHILE OPEN") is driven by a BROWSER: the page asks on load and every
 * `keepWarmIntervalMs()` while it is open, visible and being used, and stops
 * the moment it is hidden, closed or left idle. That is the designed shape of
 * a page-driven feature. The owner's demo needs the other thing — a switch
 * that keeps the boxes up with NO browser attached at all — and the one
 * mechanism that can do it is a process-side timer, because a timer is the
 * only thing in the server that acts when nobody asks.
 *
 * ## It is the same wake, not a second one — and since #1057, only the fallback
 *
 * **With Modal control available** (`MODAL_CONTROL_BASE`/`MODAL_CONTROL_TOKEN`
 * set) the tick asserts `min_containers=1` per kept box through the control
 * sidecar (`modal-control.server.ts`) and sends NO request to either box: the
 * autoscaler is what holds them up, and a request would be a GPU-second billed
 * for nothing. The per-tick assertion is deliberate — the autoscaler override
 * survives until the Modal app is redeployed, and a redeploy resets it to the
 * app's own static value, so the demo's box would otherwise silently scale
 * down on the next deploy. `switch off` asserts `0` from the panel action
 * (`gpu-admin.server.ts`) through {@link driveModalSwitch}; if Modal does not
 * CONFIRM `min_containers=0` the loop retries the release (see "OFF is a promise
 * the loop keeps" below).
 *
 * **Without it** every tick calls `ensurePrivateTierAwake({ keepWarm: true })`
 * — the SAME entry point a turn, the header button and the open-page keep-warm
 * use — so it inherits, rather than re-implements, every property that module
 * documents: the in-flight dedupe (a tick during a turn's cold-start poll
 * JOINS it instead of queueing a second one on a single-replica box), the warm
 * clocks and their short-circuits (a tick on a box this process saw answer
 * inside the keep-warm fraction costs nothing), and the cold-start recording
 * gates (a loop tick never enters the estimate's history as a reading it is
 * not). Reusing the browser's cadence numbers (`KEEP_WARM_FRACTION`, the
 * `*_SCALEDOWN_SECONDS` windows) also means the loop pings at exactly the rate
 * that keeps each box from scaling down, and an operator tuning a window tunes
 * every driver at once.
 *
 * ## Where the state lives, and why the tick re-reads it
 *
 * The switch itself lives in Postgres (`db/gpu-state.server.ts`) —
 * deployment-global, so it survives a reload, a closed tab, another browser
 * and another app instance. The tick re-reads the ROW on every tick rather
 * than caching it: a flip from any browser, any process, any admin lands
 * within one tick, and "off" stops the pings from every instance without a
 * broadcast channel. The cost of that freshness is one single-row indexed
 * read per tick on a table that also serves the admin page — negligible
 * beside the strip's own polling.
 *
 * ## The multi-instance caveat, inherited not invented
 *
 * Each app process runs its own loop, exactly as each runs its own wake poll
 * (`wake.server.ts`, "What it holds, and where"): two instances of the app
 * both honouring an ON switch each ping at their own cadence, so a box is
 * touched at up to twice the rate one instance would touch it. Every ping is
 * the wake's own cheapest request (a 1-token completion on the 27B, a
 * `GET /health` on the 4B), and the alternative — electing one leader
 * instance — is coordination machinery the preview deployment has one of
 * everything else to avoid. When off, every instance stops within one tick,
 * and the boxes scale down after their own windows: today's behaviour.
 *
 * ## OFF is a promise the loop keeps, and ON/OFF never race (#1057 review)
 *
 * Two defects the first cut had, both silent. (1) `setGpuState(false)` was
 * written and THEN the autoscaler call was made once; if the sidecar was down or
 * slow, `min_containers` stayed 1 while the panel read OFF — a billed box with
 * a switch claiming otherwise, and nothing retried. (2) A tick that had read ON
 * could land its `1` after the panel's `0`. So: the panel's flip and every tick
 * run under ONE per-process lock ({@link withSwitchLock}), a flip writes the
 * switch and asserts the autoscaler inside it, and a tick reads the switch
 * INSIDE it — so a tick either sees the flip or has finished before it. Across
 * two app instances a lock cannot help, so a tick that asserted `1` re-reads the
 * switch and, if it went OFF meanwhile, takes its own `1` back. A release Modal
 * does not CONFIRM (`min_containers` reported as 0) is registered as pending
 * and retried every tick, with a bounded exponential backoff
 * ({@link releaseBackoffMs}: 30s doubling to a 5 min cap), until it is — a
 * pending release is per process, like every clock on this route, so a restart
 * between a failed release and its retry forgets it; the next panel OFF (or a
 * `ops.py release`) is the recovery for that.
 *
 * ## A confirmed OFF is re-asserted (#1060 round 2)
 *
 * The app gives up on a sidecar call at 15 s; the sidecar's SDK call may not.
 * An ON the app abandoned can therefore land at Modal AFTER the owner's OFF was
 * confirmed — `min_containers=1` under a switch that reads OFF, a billed box
 * with nothing retrying (and "stop now" cannot recover it: Modal restarts the
 * container). So a tick that reads OFF also re-sends `0` per kept box every
 * {@link OFF_REASSERT_MS} (the release backoff's cap) and CONFIRMS Modal's
 * reported value; a failure is registered as a pending release like any other.
 * The sidecar orders its own `/autoscaler` calls per box too (`control_sidecar.py`),
 * so the two layers cover the same race from both ends. Cost: one idempotent
 * control call per box per five minutes while OFF — and an `ops.py prewarm` run
 * by hand under an OFF switch is released within that window.
 *
 * ## What a failed tick does
 *
 * A tick whose wake fails (box down, endpoint misconfigured, database
 * unreachable) is swallowed and logged ONCE per state change rather than
 * every tick, so a broken box does not bury the log — and the switch stays
 * ON. There is no silent auto-off (the owner's explicit call for the demo:
 * the panel says what it is doing, and a failing box is reported by the
 * admin page's live state, not by the switch quietly reverting itself).
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { largeOnOpenRouter } from '@hames-ai/harness-baml/inference-env.server'
import { getGpuState, setGpuState } from '../db/gpu-state.server'
import {
  modalBoxProbe,
  modalControlConfigured,
  noteModalBootEnded,
  noteModalBootRequested,
  probeModalBoxes,
  setModalBoxMinContainers,
  type ModalBox,
} from './modal-control.server'
import { ensurePrivateTierAwake, wakeEnvMs } from './wake.server'

assertServerOnImport()

/**
 * How often the loop wakes up to re-read the switch — NOT how often it pings
 * a box. A tick on an ON switch calls `ensurePrivateTierAwake({ keepWarm:
 * true })`, whose own freshness check (answered within `KEEP_WARM_FRACTION` of
 * the idle window) decides whether a request leaves the process at all. So a
 * 30s tick with the shipped 300s windows pings each box roughly every 100s,
 * and the tick interval only bounds two things: how quickly a flipped switch
 * is noticed by a process that did not flip it, and how stale an idle
 * (switch-off) loop's one indexed read is.
 *
 * Overridable with `GPU_KEEP_TICK_MS` through the wake's own `wakeEnvMs`
 * parser, so a garbage value is refused with a warning rather than honoured —
 * a zero here would be a loop that never re-reads the switch, i.e. an OFF
 * switch that keeps pinging until the process dies.
 */
export const DEFAULT_GPU_KEEP_TICK_MS = 30_000

/** `GPU_KEEP_TICK_MS`, or {@link DEFAULT_GPU_KEEP_TICK_MS}. */
export function gpuKeepTickMs(): number {
  return wakeEnvMs('GPU_KEEP_TICK_MS', DEFAULT_GPU_KEEP_TICK_MS)
}

/** The armed loop, parked on `globalThis` for the same reason the routine
 *  scheduler's timer is: a Vite HMR reload re-evaluates a changed module with
 *  fresh module state, so a module-scoped handle would leak one interval per
 *  edit while the guard stopped guarding. */
const ARMED_KEY = Symbol.for('hames-app.gpu-keep-running')

interface ArmedLoop {
  timer: ReturnType<typeof setInterval>
  /** A failed DB read still owes a previously observed OFF its re-assertion.
   *  Unknown or last-ON never starts a control call during an outage. */
  lastKnownOn: boolean | null
  /** The failure string last logged, so a persistently failing tick logs once
   *  per CAUSE rather than once per tick. */
  lastFailure: string | null
}

type LoopGlobal = typeof globalThis & { [ARMED_KEY]?: ArmedLoop }

/**
 * Arm the loop. Idempotent — a second call (an HMR reload, a test) is a no-op
 * rather than a second timer. Armed from `src/middleware.ts`, which is
 * imported once when the server handler graph loads: the whole point is that
 * the loop runs with no browser attached, so it must not depend on any route
 * being opened. The timer is `unref()`'d so it never holds the process open on
 * its own.
 */
export function startGpuKeepRunningLoop(intervalMs: number = gpuKeepTickMs()): void {
  const g = globalThis as LoopGlobal
  if (g[ARMED_KEY]) return
  const loop: ArmedLoop = {
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    lastKnownOn: null,
    lastFailure: null,
  }
  loop.timer = setInterval(() => {
    void tick(loop)
  }, intervalMs)
  loop.timer.unref?.()
  g[ARMED_KEY] = loop
  console.log(
    `[gpu-keep] loop armed (tick every ${Math.round(intervalMs / 1000)}s, switch re-read per tick)`,
  )
  // The boot tick, for the case a timer cannot cover: a server RESTARTED under
  // an on switch — the boxes may have scaled down while the process was gone,
  // and the whole point of the switch is that nobody has to open a page for
  // them to be brought back. Fire-and-forget like the scheduler's boot sweep:
  // arming happens at module load, where a database that is not up yet must
  // degrade to a logged failure and the next tick, never to a failed boot.
  void tick(loop)
}

// ============================================================================
// The switch lock, and the release that must be confirmed
// ============================================================================

const LOCK_KEY = Symbol.for('hames-app.gpu-switch-lock')
type LockGlobal = typeof globalThis & { [LOCK_KEY]?: Promise<unknown> }

/** Run `fn` after every earlier holder has finished — the per-process mutex a
 *  panel flip and a loop tick share. A rejection releases it like a result. */
export function withSwitchLock<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as LockGlobal
  const run = (g[LOCK_KEY] ?? Promise.resolve()).then(fn, fn)
  g[LOCK_KEY] = run.catch(() => undefined)
  return run
}

/** First retry of an unconfirmed release, and the cap the backoff doubles to. */
export const RELEASE_BACKOFF_BASE_MS = 30_000
export const RELEASE_BACKOFF_MAX_MS = 300_000

/** How long to wait before the `attempts`-th retry (1-based): 30s, 60s, 120s,
 *  240s, then 300s for ever — bounded, so a long outage is retried at a steady
 *  low rate rather than at an ever-growing gap nobody would wait out. */
export function releaseBackoffMs(attempts: number): number {
  return Math.min(RELEASE_BACKOFF_MAX_MS, RELEASE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

const PENDING_KEY = Symbol.for('hames-app.gpu-pending-release')
interface PendingRelease {
  attempts: number
  nextAt: number
  lastReason: string | null
}
type PendingGlobal = typeof globalThis & {
  [PENDING_KEY]?: Partial<Record<ModalBox, PendingRelease>>
}
function pendingReleases(): Partial<Record<ModalBox, PendingRelease>> {
  const g = globalThis as PendingGlobal
  return (g[PENDING_KEY] ??= {})
}

/** The boxes whose release (`min_containers=0`) Modal has not confirmed. */
export function pendingReleaseBoxes(): ModalBox[] {
  return Object.keys(pendingReleases()) as ModalBox[]
}

const OFF_ASSERT_KEY = Symbol.for('hames-app.gpu-off-asserted')
type OffAssertGlobal = typeof globalThis & { [OFF_ASSERT_KEY]?: Partial<Record<ModalBox, number>> }
function offAsserted(): Partial<Record<ModalBox, number>> {
  const g = globalThis as OffAssertGlobal
  return (g[OFF_ASSERT_KEY] ??= {})
}
/** Record that Modal just CONFIRMED `0` for a box: the next re-assertion under
 *  an OFF switch is due {@link OFF_REASSERT_MS} from now. */
function noteOffAsserted(box: ModalBox): void {
  offAsserted()[box] = Date.now()
}

/** How often a tick that reads the switch OFF re-sends `min_containers=0` per
 *  box even when nothing is pending — the release backoff's own cap, so an OFF
 *  switch costs one idempotent control call per box per five minutes. */
export const OFF_REASSERT_MS = RELEASE_BACKOFF_MAX_MS

/** Test-only reset of the pending ledger. */
export function resetPendingReleases(): void {
  delete (globalThis as PendingGlobal)[PENDING_KEY]
  delete (globalThis as OffAssertGlobal)[OFF_ASSERT_KEY]
}

/** Assert `min_containers=0` on one box and CONFIRM it: an answer that is not
 *  `ok` with Modal reporting 0 is a failure. Never throws. */
async function releaseConfirmed(box: ModalBox): Promise<string | null> {
  const answer = await setModalBoxMinContainers(box, 0)
  if (!answer.ok) return answer.reason ?? 'the control sidecar refused'
  if (answer.minContainers !== 0) {
    return `Modal answered min_containers=${String(answer.minContainers)}, not 0`
  }
  return null
}

/** Record a release that did not confirm, to be retried by the loop. */
function registerPendingRelease(box: ModalBox, reason: string): void {
  const pending = pendingReleases()
  const attempts = (pending[box]?.attempts ?? 0) + 1
  pending[box] = { attempts, nextAt: Date.now() + releaseBackoffMs(attempts), lastReason: reason }
}

/**
 * The panel's flip through Modal's autoscaler — the whole of it under the
 * switch lock: the switch is written, then each kept box is driven. `on` stamps
 * the boot clock (so a boot that never gets a container is named NOT STARTING)
 * and asserts `min_containers=1`; `off` ends the clock and asserts `0`
 * CONFIRMED — a box whose release
 * is not confirmed is left pending for the loop. Returns the first box that
 * failed (the panel throws it), or `null`.
 */
export function driveModalSwitch(
  on: boolean,
  boxes: ModalBox[],
): Promise<{ box: ModalBox; reason: string | null; doing: 'boot' | 'release' } | null> {
  return withSwitchLock(async () => {
    await setGpuState(on)
    let failure: { box: ModalBox; reason: string | null; doing: 'boot' | 'release' } | null = null
    for (const box of boxes) {
      if (on) {
        delete pendingReleases()[box]
        noteModalBootRequested(box, Date.now(), 'switch')
        const answer = await setModalBoxMinContainers(box, 1)
        if (!answer.ok && !failure) failure = { box, reason: answer.reason, doing: 'boot' }
      } else {
        noteModalBootEnded(box, 'switch')
        const reason = await releaseConfirmed(box)
        if (reason === null) {
          delete pendingReleases()[box]
          noteOffAsserted(box)
        } else {
          registerPendingRelease(box, reason)
          failure ??= { box, reason, doing: 'release' }
        }
      }
    }
    return failure
  })
}

/** Retry the releases that are due. Called by a tick that read the switch OFF,
 *  under the lock. */
async function retryPendingReleases(loop: ArmedLoop): Promise<void> {
  const pending = pendingReleases()
  for (const box of pendingReleaseBoxes()) {
    const entry = pending[box]
    if (!entry || Date.now() < entry.nextAt) continue
    const reason = await releaseConfirmed(box)
    if (reason === null) {
      delete pending[box]
      noteOffAsserted(box)
      console.log(`[gpu-keep] Modal confirmed min_containers=0 for the ${box} box`)
      continue
    }
    entry.attempts += 1
    entry.nextAt = Date.now() + releaseBackoffMs(entry.attempts)
    entry.lastReason = reason
    logFailure(loop, `releasing the ${box} box`, new Error(reason))
  }
}

/** Under an OFF switch, re-send `min_containers=0` per kept box at
 *  {@link OFF_REASSERT_MS} and CONFIRM Modal's reported value, whether or not a
 *  release is pending. A confirmed OFF is not final on its own: an ON the app
 *  gave up on (its 15 s bound) can still be running inside the sidecar and land
 *  AFTER the `0` (#1060 review round 2) — a billed box under a switch that reads
 *  OFF, with nothing retrying. The same call also covers a restart that forgot
 *  a pending release. A box with a release already pending is the retry's. */
async function reassertOff(loop: ArmedLoop): Promise<void> {
  for (const box of keptBoxes()) {
    if (pendingReleases()[box]) continue
    const last = offAsserted()[box]
    if (last !== undefined && Date.now() - last < OFF_REASSERT_MS) continue
    const reason = await releaseConfirmed(box)
    if (reason === null) {
      noteOffAsserted(box)
      continue
    }
    registerPendingRelease(box, reason)
    logFailure(loop, `re-asserting OFF on the ${box} box`, new Error(reason))
  }
}

/** The boxes this loop keeps up: the 4B always, the 27B only while it is one
 *  of ours (`LARGE_LLM_ROUTE=openrouter` puts it on a public per-token API,
 *  which the wake skips for the same reason). */
function keptBoxes(): ModalBox[] {
  return largeOnOpenRouter() ? ['small'] : ['large', 'small']
}

/** One wake-up: re-read the switch, and if it is on, hold the boxes up —
 *  through Modal's autoscaler where the control route exists, through the one
 *  shared wake otherwise. Never throws — a timer callback that rejects is an
 *  unhandled rejection away from taking the process down. The Modal route runs
 *  under the switch lock (read the switch INSIDE it), so a flip and a tick never
 *  interleave; the pings fallback has no such race to close (a ping cannot undo
 *  an OFF). */
async function tick(loop: ArmedLoop): Promise<void> {
  if (!modalControlConfigured()) return tickPings(loop)
  try {
    await withSwitchLock(() => tickUnderLock(loop))
  } catch (err) {
    logFailure(loop, 'keeping the boxes up', err)
  }
}

async function tickUnderLock(loop: ArmedLoop): Promise<void> {
  let on: boolean
  try {
    on = (await getGpuState()).keepRunning
    loop.lastKnownOn = on
  } catch (err) {
    logFailure(loop, 'reading the switch', err)
    if (loop.lastKnownOn !== false) return
    on = false
  }
  if (!on) {
    // OFF: the switch may have just flipped, so the "one log per cause" latch
    // resets — the next failure, whenever it comes, is a new cause. A release
    // Modal never confirmed is still owed, though.
    if (loop.lastFailure !== null && pendingReleaseBoxes().length === 0) loop.lastFailure = null
    await retryPendingReleases(loop)
    await reassertOff(loop)
    return
  }
  // The autoscaler route: assert min_containers=1 per kept box, sending no
  // request to either. Not idempotence for its own sake — a Modal redeploy
  // resets the override to the app's static value, and the next tick is what
  // brings the demo's box back before anyone notices.
  const probe = await probeModalBoxes()
  for (const box of keptBoxes()) {
    delete pendingReleases()[box]
    // No container yet: THIS is a boot asked for and not answered — the clock
    // the panel's NOT STARTING reads. (Unreadable counts for nothing.)
    const seen = modalBoxProbe(probe, box)
    if (seen.ok && seen.containerCount === 0) noteModalBootRequested(box, Date.now(), 'switch')
    const answer = await setModalBoxMinContainers(box, 1)
    if (!answer.ok) throw new Error(answer.reason ?? 'the control sidecar refused')
  }
  // Across two app instances the lock cannot serialise a flip on the OTHER one
  // against this tick, so take the `1` back if the switch went OFF while it
  // was in flight.
  let still: boolean
  try {
    still = (await getGpuState()).keepRunning
    loop.lastKnownOn = still
  } catch {
    still = true // unreadable: the next tick re-reads; never act on a guess
  }
  if (!still) {
    for (const box of keptBoxes()) {
      noteModalBootEnded(box, 'switch')
      const reason = await releaseConfirmed(box)
      if (reason !== null) registerPendingRelease(box, reason)
      else noteOffAsserted(box)
    }
    return
  }
  if (loop.lastFailure !== null) {
    loop.lastFailure = null
    console.log('[gpu-keep] the boxes are held up again; keep-running resumes quietly')
  }
}

/** The fallback tick: keep-warm pings through the one shared wake. */
async function tickPings(loop: ArmedLoop): Promise<void> {
  let on: boolean
  try {
    on = (await getGpuState()).keepRunning
  } catch (err) {
    logFailure(loop, 'reading the switch', err)
    return
  }
  if (!on) {
    if (loop.lastFailure !== null) loop.lastFailure = null
    return
  }
  try {
    await ensurePrivateTierAwake({ keepWarm: true })
    if (loop.lastFailure !== null) {
      loop.lastFailure = null
      console.log('[gpu-keep] the boxes are held up again; keep-running resumes quietly')
    }
  } catch (err) {
    logFailure(loop, 'keeping the boxes up', err)
  }
}

/** A failure that repeats every tick is one cause, not a log line per tick —
 *  the loop runs forever, and a failing box would bury everything else. */
function logFailure(loop: ArmedLoop, doing: string, err: unknown): void {
  const said = err instanceof Error ? err.message : String(err)
  if (loop.lastFailure === said) return
  loop.lastFailure = said
  console.warn(
    `[gpu-keep] ${doing} failed (${said}); the switch is left as it is, and the next tick retries`,
  )
}

/** Test seam: disarm the loop, so a suite that started it does not leave a
 *  timer firing between tests. The exported starter's idempotence makes the
 *  NEXT `startGpuKeepRunningLoop()` arm a fresh one. */
export function stopGpuKeepRunningLoop(): void {
  const g = globalThis as LoopGlobal
  const loop = g[ARMED_KEY]
  if (!loop) return
  clearInterval(loop.timer)
  delete g[ARMED_KEY]
}
