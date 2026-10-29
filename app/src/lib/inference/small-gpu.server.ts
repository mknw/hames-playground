/**
 * The small box's served GPU and its EUR/hour — Server Only.
 *
 * Since #782 the small Modal box takes an ordered GPU fallback list
 * (`HAMES_MODAL_GPU`, e.g. `L4,A10`): one app, one URL, and whichever type had
 * capacity serves. Each type bills at its own hourly rate (#848), so the time
 * basis has to follow the GPU actually served rather than one rate for the box
 * — a call served on the dearer fallback otherwise renders a floor lower than
 * it really cost.
 *
 * ## How the app knows, cheaply
 *
 * Nothing on a completion's wire names the GPU, so the answer is a SAMPLE, not
 * a per-call read. The box's `/status` (a static JSON file the supervisor
 * writes once the box is ready — "reading it never touches a model",
 * `deploy/modal/Caddyfile`) reports `gpu`, read from `nvidia-smi` fresh in every
 * container, and it sits on the public route list beside `/health`, which the
 * small wake already reaches at the same root URL. A GPU can only change when
 * the container dies and a new one starts, which is exactly the event a wake
 * exists to detect, so the sample is refreshed twice and never per step:
 *
 *  1. when the small wake lands (`poll()`'s success path calls
 *     `refreshSmallBoxGpu()` through the wake's `onUp` hook) — a container that
 *     just came up has a fresh `gpu` waiting in `/status`;
 *  2. at most once per {@link SMALL_GPU_SAMPLE_TTL_MS} from the sync pricing
 *     read, bounding the one staleness a wake cannot see: another actor (a
 *     second app instance, `measure.py`) keeping a NEW container alive while
 *     this process's warm clock is still valid. The TTL is one configured
 *     scale-down window (`SMALL_LLM_SCALEDOWN_SECONDS`, 300s default) — within
 *     it the same container must still be serving, so its GPU cannot have
 *     changed except by a crash, and past it this process's own next call wakes
 *     and re-samples anyway.
 *
 * The sample FAILS OPEN into the pricing rule the owner set for #848: a GPU
 * this table cannot name (no sample yet, the read failed, a host without
 * `/status`, or a type the table does not know) prices at the HIGHEST known
 * rate, never the base — the rendered figure is a floor (`≥`) and a floor must
 * not understate. A type the table does not know is also why a new entry in the
 * deployment's fallback list must add its family here (the deploy README says
 * the two move together).
 *
 * ## The rates
 *
 * `SMALL_LLM_EUR_PER_HOUR` stays the L4 rate (default €1.54/h) — it is also the
 * base every other family's default is derived from, so an operator who moves
 * the base keeps the ratios. The A10 default is that base scaled by the GPU
 * list-price ratio from the owner's 2026-10-27 quote (L4 $0.80/h, A10 $1.10/h,
 * L40S $1.95/h): 1.10 / 0.80 = ×1.375, ≈ €2.12/h at today's base. The L40S
 * family is deliberately NOT in the table yet — no deployment lists it, and
 * adding it would raise the unknown-GPU fallback to its ×2.44 rate; add it with
 * `ratio: 1.95 / 0.80` the day a deploy lists it. A per-family override var
 * (`SMALL_LLM_EUR_PER_HOUR_A10`) wins over the derived figure, read per call in
 * the same rule as every rate in `cost-rates.server.ts`.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { positiveRate, smallLlmEurPerHour } from '../cost-rates.server'

assertServerOnImport()

/** The GPU families the small box can land on today, and how their list rates
 *  relate to the L4's. Match is against the upper-cased `nvidia-smi` name, so
 *  Modal's `A10` is matched in its hardware spelling (`NVIDIA A10G`), and the
 *  digit lookaheads keep `A10` out of `A100` and `L4` out of `L40S`. */
interface SmallGpuFamily {
  family: 'L4' | 'A10'
  match: RegExp
  /** The family's list rate over the L4's, from the owner's 2026-10-27 quote. */
  ratio: number
  /** Per-family override var. L4 has none: `SMALL_LLM_EUR_PER_HOUR` IS its rate. */
  override?: string
}

const SMALL_GPU_FAMILIES: readonly SmallGpuFamily[] = [
  { family: 'L4', match: /(?<![0-9A-Z])L4(?![0-9])/, ratio: 1 },
  {
    family: 'A10',
    match: /(?<![0-9A-Z])A10(?![0-9])/,
    ratio: 1.1 / 0.8,
    override: 'SMALL_LLM_EUR_PER_HOUR_A10',
  },
]

/** How long a `/status` sample prices calls before the next read refreshes it —
 *  one configured scale-down window (see the module docstring). Not an env var:
 *  it is a staleness bound on a fact only a container change can alter, not a
 *  rate an operator would tune. */
export const SMALL_GPU_SAMPLE_TTL_MS = 300_000

/** Bounded like every other probe this route makes: Node's `fetch` has no
 *  default timeout, and an unbounded one hangs the read that kicked it. */
const SMALL_GPU_SAMPLE_TIMEOUT_MS = 5_000

/** Classify one `nvidia-smi` GPU name (the `/status` `gpu` field) into a family
 *  the table prices, or `undefined` when the box reported something it does not
 *  name — including its own `unknown (<error class>)` spelling. */
export function smallGpuFamily(report: string): 'L4' | 'A10' | undefined {
  const name = report.toUpperCase()
  return SMALL_GPU_FAMILIES.find((entry) => entry.match.test(name))?.family
}

function rateFor(entry: SmallGpuFamily): number {
  const base = smallLlmEurPerHour()
  if (entry.override === undefined) return base * entry.ratio
  return positiveRate(entry.override, process.env[entry.override], base * entry.ratio)
}

interface SmallGpuSample {
  family: 'L4' | 'A10' | undefined
  sampledAt: number
}
interface SmallGpuState {
  sample: SmallGpuSample | undefined
  refreshing: Promise<void> | undefined
}

/** Process-local, the same compromise as the wake's warm clock (a second app
 *  instance samples on its own; the consequence is a duplicated `GET /status`
 *  per TTL window, not a wrong answer). */
const KEY = Symbol.for('hames-app.small-gpu-v1')
const state = ((globalThis as typeof globalThis & { [KEY]?: SmallGpuState })[KEY] ??= {
  sample: undefined,
  refreshing: undefined,
} as SmallGpuState)

/** EUR/hour the small box's time-priced calls bill at: the rate of the GPU the
 *  box actually served, from the cached `/status` sample. Synchronous by seam —
 *  the cost pricing readers are sync — so a stale sample is refreshed in the
 *  background and prices the calls AFTER it lands, never the one being read.
 *  Unknown prices at the highest known rate (module docstring). */
export function smallGpuEurPerHour(): number {
  const sample = state.sample
  if (sample === undefined || Date.now() - sample.sampledAt >= SMALL_GPU_SAMPLE_TTL_MS) {
    void refreshSmallBoxGpu()
  }
  const family = state.sample?.family
  if (family !== undefined) {
    const entry = SMALL_GPU_FAMILIES.find((candidate) => candidate.family === family)
    if (entry) return rateFor(entry)
  }
  return Math.max(...SMALL_GPU_FAMILIES.map(rateFor))
}

/** Read `/status` once and cache which GPU it names. Deduped (concurrent
 *  callers share one read), never throws, never prices: a failure keeps whatever
 *  the previous sample knew and only advances the clock, so a host without
 *  `/status` pays one bounded failed GET per TTL window rather than one per
 *  priced call. Exported for the wake's `onUp` hook and for tests. */
export function refreshSmallBoxGpu(): Promise<void> {
  if (state.refreshing) return state.refreshing
  const refreshing = sampleOnce().finally(() => {
    if (state.refreshing === refreshing) state.refreshing = undefined
  })
  state.refreshing = refreshing
  return refreshing
}

async function sampleOnce(): Promise<void> {
  // The same root the small wake health-polls: `SMALL_LLM_BASE_URL` with its
  // `/v1` suffix stripped (the assert requires the suffix when the tier is on).
  const base = (process.env.SMALL_LLM_BASE_URL ?? '').replace(/\/v1\/?$/, '')
  if (base === '') {
    // No endpoint configured — nothing to ask, and no reason to retry per read.
    mark(undefined)
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SMALL_GPU_SAMPLE_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/status`, {
      headers: process.env.SMALL_LLM_API_KEY
        ? { Authorization: `Bearer ${process.env.SMALL_LLM_API_KEY}` }
        : {},
      signal: controller.signal,
    })
    if (!res.ok) {
      // Drain, so a bounded body cannot hold the socket — the wake's rule.
      await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}`)
    }
    const body = (await res.json()) as { gpu?: unknown }
    mark(smallGpuFamily(typeof body.gpu === 'string' ? body.gpu : ''))
  } catch {
    mark(state.sample?.family)
  } finally {
    clearTimeout(timer)
  }
}

function mark(family: 'L4' | 'A10' | undefined): void {
  state.sample = { family, sampledAt: Date.now() }
}

/** Test seam: drop the cached sample and the in-flight read. The `globalThis`
 *  symbol survives between test files in one worker, so a suite that sampled
 *  must not price another suite's expectations. */
export function resetSmallGpuForTests(): void {
  state.sample = undefined
  state.refreshing = undefined
}

/** Test seam: plant a sample without I/O, so a suite exercising the pricing
 *  seam stays hermetic AND deterministic — a suite that never stubs `fetch`
 *  would otherwise pay one bounded background read per TTL window, and a suite
 *  that counts its requests would count this one. */
export function seedSmallGpuForTests(
  family: 'L4' | 'A10' | undefined,
  sampledAt: number = Date.now(),
): void {
  state.sample = { family, sampledAt }
  state.refreshing = undefined
}
