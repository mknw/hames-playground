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
 * exists to detect, so the sample is refreshed twice and never per step — and
 * NEVER from the pricing read itself:
 *
 *  1. when the small wake lands (`poll()`'s success path calls
 *     `resampleSmallBoxGpu()` through the wake's `onUp` hook) — a container
 *     that just came up has a fresh `gpu` waiting in `/status`, and the old
 *     sample may name the dead container's GPU;
 *  2. at most once per {@link SMALL_GPU_SAMPLE_TTL_MS} when a small call has
 *     just completed (`refreshSmallBoxGpuIfStale()`, called from the usage
 *     recorder beside `noteSmallCallCompleted`), bounding the one staleness a
 *     wake cannot see: another actor (a second app instance, `measure.py`)
 *     keeping a NEW container alive while this process's warm clock is still
 *     valid.
 *
 * BOTH refresh sites are ones that have just proven the box UP, and that is
 * the whole point: `/status` sits beside `/health` on the same Caddy route
 * list, and a valid-token request to a scaled-to-zero box starts a GPU
 * container. A read fired from a step on ANY tier — the pricing seam serves
 * every client, Anthropic included — could therefore wake and bill the box
 * the step does not even need, and keep it billed. The pricing read is
 * accordingly PURE: it prices from the cached sample or the highest known
 * rate, and touches no network.
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
 * `SMALL_LLM_EUR_PER_HOUR` stays the L4 rate and base for other families. The
 * A10 default scales that base by the ratio of FULL Modal container costs
 * (GPU + 2 cores + 24 GiB, broad eu), not the GPU-only 1.375 ratio. This
 * preserves the existing rule that a changed L4 override moves the A10 default.
 * The source prices and both box shapes live in `modal-pricing.ts`. L40S is
 * deliberately absent until a deployment can serve it. A per-family override
 * (`SMALL_LLM_EUR_PER_HOUR_A10`) wins over the derived figure, read per call.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { positiveRate, smallLlmEurPerHour } from '../cost-rates.server'
import { modalDefaultUsdPerHour } from '../modal-pricing'

assertServerOnImport()

/** The GPU families the small box can land on today, and how their list rates
 *  relate to the L4's. Match is against the upper-cased `nvidia-smi` name, so
 *  Modal's `A10` is matched in its hardware spelling (`NVIDIA A10G`), and the
 *  digit lookaheads keep `A10` out of `A100` and `L4` out of `L40S`. */
interface SmallGpuFamily {
  family: 'L4' | 'A10'
  match: RegExp
  /** The family's full container rate over the L4's. */
  box: 'smallL4' | 'smallA10'
  /** Per-family override var. L4 has none: `SMALL_LLM_EUR_PER_HOUR` IS its rate. */
  override?: string
}

const SMALL_GPU_FAMILIES: readonly SmallGpuFamily[] = [
  { family: 'L4', match: /(?<![0-9A-Z])L4(?![0-9])/, box: 'smallL4' },
  {
    family: 'A10',
    match: /(?<![0-9A-Z])A10(?![0-9])/,
    box: 'smallA10',
    override: 'SMALL_LLM_EUR_PER_HOUR_A10',
  },
]

/** How long a `/status` sample prices calls before the next refresh may fire
 *  (`refreshSmallBoxGpuIfStale`). A hard-coded 300s, chosen to match the
 *  DEFAULT scale-down window (`SMALL_LLM_SCALEDOWN_SECONDS`) rather than
 *  derived from it: it is a staleness bound on a fact only a container change
 *  can alter, not a rate an operator would tune, and a changed idle window
 *  must not silently change the sampling cadence. */
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
  const derived = base * (modalDefaultUsdPerHour(entry.box) / modalDefaultUsdPerHour('smallL4'))
  if (entry.override === undefined) return derived
  return positiveRate(entry.override, process.env[entry.override], derived)
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

/** The served GPU family and its EUR/hour in ONE synchronous read of the cached
 * sample — a report can then state the basis of the very figure the pricing
 * read returned, without two reads straddling a TTL expiry. Synchronous by
 * seam AND pure by threat model — the cost pricing readers are sync and this
 * read runs on EVERY tier's step, so it must never start a network call that
 * could wake the box (`refreshSmallBoxGpuIfStale` is the only TTL-bounded
 * kick, and only from a site that has just proven the box up). A missing,
 * stale or unreadable sample prices at the HIGHEST known rate and names NO
 * family — never the previous container's family, never the base: the
 * rendered figure is a floor (`≥`) and a floor must not understate
 * (module docstring). */
export interface SmallGpuServed {
  family: 'L4' | 'A10' | undefined
  eurPerHour: number
}

export function smallGpuServed(): SmallGpuServed {
  const highest = () => Math.max(...SMALL_GPU_FAMILIES.map(rateFor))
  const sample = state.sample
  if (sample === undefined || Date.now() - sample.sampledAt >= SMALL_GPU_SAMPLE_TTL_MS) {
    return { family: undefined, eurPerHour: highest() }
  }
  const entry = SMALL_GPU_FAMILIES.find((candidate) => candidate.family === sample.family)
  return entry
    ? { family: entry.family, eurPerHour: rateFor(entry) }
    : { family: undefined, eurPerHour: highest() }
}

/** EUR/hour the small box's time-priced calls bill at: the rate of the GPU the
 * box actually served, from the cached `/status` sample — `smallGpuServed()`
 * without the family half. */
export function smallGpuEurPerHour(): number {
  return smallGpuServed().eurPerHour
}

/** Read `/status` once and cache which GPU it names. Deduped (concurrent
 *  callers share one read), never throws, never prices: a failure records
 *  UNKNOWN so nothing prices on the previous read's stale knowledge (the
 *  floor rule above), and a host without `/status` pays one bounded failed
 *  GET per refresh rather than one per priced call. Fire this only from a
 *  site that has just proven the box up — the wake's `onUp` and the usage
 *  recorder's small-call site are the two. */
export function refreshSmallBoxGpu(): Promise<void> {
  if (state.refreshing) return state.refreshing
  const refreshing = sampleOnce().finally(() => {
    if (state.refreshing === refreshing) state.refreshing = undefined
  })
  state.refreshing = refreshing
  return refreshing
}
/** Kick a `/status` refresh when the cached sample is missing or past its TTL.
 *  The TTL-bounded refresh site for a caller that has just proven the box UP
 *  (the usage recorder, beside `noteSmallCallCompleted`) — never the pricing
 *  read, which must stay pure. */
export function refreshSmallBoxGpuIfStale(): void {
  const sample = state.sample
  if (sample === undefined || Date.now() - sample.sampledAt >= SMALL_GPU_SAMPLE_TTL_MS) {
    void refreshSmallBoxGpu()
  }
}

/** The box just (re)started, so its GPU may differ: drop the cached sample
 *  SYNCHRONOUSLY — nothing may price on the dead container's GPU while the
 *  re-read is in flight — then kick the refresh. The wake's `onUp` site. */
export function resampleSmallBoxGpu(): void {
  state.sample = undefined
  void refreshSmallBoxGpu()
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
    // A failed read (timeout, 4xx/5xx, unreadable body) records UNKNOWN, not
    // the previous sample: the box may have come back on a different GPU
    // family, and a floor priced on the old one can understate. The failed
    // read costs nothing; the highest rate is the honest answer until the
    // next successful read.
    mark(undefined)
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
