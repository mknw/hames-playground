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
 * (`gpu-admin.server.ts`), not from here — this loop only ever re-asserts the
 * switch's ON.
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
import { getGpuState } from '../db/gpu-state.server'
import {
  modalControlConfigured,
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

/** The boxes this loop keeps up: the 4B always, the 27B only while it is one
 *  of ours (`LARGE_LLM_ROUTE=openrouter` puts it on a public per-token API,
 *  which the wake skips for the same reason). */
function keptBoxes(): ModalBox[] {
  return largeOnOpenRouter() ? ['small'] : ['large', 'small']
}

/** One wake-up: re-read the switch, and if it is on, hold the boxes up —
 *  through Modal's autoscaler where the control route exists, through the one
 *  shared wake otherwise. Never throws — a timer callback that rejects is an
 *  unhandled rejection away from taking the process down. */
async function tick(loop: ArmedLoop): Promise<void> {
  let on: boolean
  try {
    on = (await getGpuState()).keepRunning
  } catch (err) {
    logFailure(loop, 'reading the switch', err)
    return
  }
  if (!on) {
    // OFF: the switch may have just flipped, so the "one log per cause" latch
    // resets — the next failure, whenever it comes, is a new cause.
    if (loop.lastFailure !== null) loop.lastFailure = null
    return
  }
  try {
    if (modalControlConfigured()) {
      // The autoscaler route: assert min_containers=1 per kept box, sending
      // no request to either. Not idempotence for its own sake — a Modal
      // redeploy resets the override to the app's static value, and the next
      // tick is what brings the demo's box back before anyone notices.
      for (const box of keptBoxes()) {
        const answer = await setModalBoxMinContainers(box, 1)
        if (!answer.ok) throw new Error(answer.reason ?? 'the control sidecar refused')
      }
    } else {
      // The fallback: keep-warm pings through the one shared wake.
      await ensurePrivateTierAwake({ keepWarm: true })
    }
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
