import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SMALL_GPU_SAMPLE_TTL_MS,
  refreshSmallBoxGpu,
  refreshSmallBoxGpuIfStale,
  resampleSmallBoxGpu,
  resetSmallGpuForTests,
  smallGpuEurPerHour,
  smallGpuFamily,
} from '../../../lib/inference/small-gpu.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

/** Independent full-container arithmetic from the 2026-10-30 Modal list prices. */
const L4_DERIVED = (0.8 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15 * 0.86
const A10_DERIVED = (1.1 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15 * 0.86

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  resetSmallGpuForTests()
  vi.stubEnv('SMALL_LLM_EUR_PER_HOUR', undefined as unknown as string)
  vi.stubEnv('SMALL_LLM_EUR_PER_HOUR_A10', undefined as unknown as string)
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://example.invalid/small/v1')
  vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic-key')
  fetchMock = vi.fn(async () => Response.json({ gpu: 'NVIDIA L4' }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetSmallGpuForTests()
})

async function sampled(gpu: string): Promise<void> {
  fetchMock.mockResolvedValue(Response.json({ gpu }))
  await refreshSmallBoxGpu()
}

describe('the GPU a /status report names', () => {
  it('reads Modal types out of their nvidia-smi spellings', () => {
    expect(smallGpuFamily('NVIDIA L4')).toBe('L4')
    expect(smallGpuFamily('NVIDIA A10G')).toBe('A10')
    expect(smallGpuFamily('nvidia a10g')).toBe('A10')
  })

  it('leaves a type the table does not know unnamed', () => {
    // The digit lookaheads: `A10` must not eat `A100`, `L4` must not eat `L40S`.
    expect(smallGpuFamily('NVIDIA A100')).toBeUndefined()
    expect(smallGpuFamily('NVIDIA L40S')).toBeUndefined()
    // The box's own failure spelling, and anything else it might report.
    expect(smallGpuFamily('unknown (Error)')).toBeUndefined()
    expect(smallGpuFamily('')).toBeUndefined()
  })
})

describe('per-GPU rates (#848)', () => {
  it('an unknown GPU prices at the HIGHEST known rate, never the base', () => {
    // No sample yet: the floor must not understate a box that may be on A10.
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
    expect(smallGpuEurPerHour()).toBeGreaterThan(L4_DERIVED)
  })

  it('prices each sampled family at its own rate', async () => {
    await sampled('NVIDIA L4')
    expect(smallGpuEurPerHour()).toBe(L4_DERIVED)
    resetSmallGpuForTests()
    await sampled('NVIDIA A10G')
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
  })

  it('a reported failure or an unreadable field reads as unknown', async () => {
    await sampled('unknown (Error)')
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
    resetSmallGpuForTests()
    await sampled('')
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
  })

  it('the per-family override wins over the derived ratio', async () => {
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR_A10', '3')
    await sampled('NVIDIA A10G')
    expect(smallGpuEurPerHour()).toBe(3)
    // And it is the top of the fallback ladder too.
    resetSmallGpuForTests()
    expect(smallGpuEurPerHour()).toBe(3)
  })

  it('a garbage override falls back to the derived rate, loudly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR_A10', '0')
    await sampled('NVIDIA A10G')
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SMALL_LLM_EUR_PER_HOUR_A10'))
    warn.mockRestore()
  })

  it('moving the base moves every family with it — the ratios are kept', async () => {
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR', '2')
    await sampled('NVIDIA L4')
    expect(smallGpuEurPerHour()).toBe(2)
    resetSmallGpuForTests()
    await sampled('NVIDIA A10G')
    expect(smallGpuEurPerHour()).toBeCloseTo(2 * (A10_DERIVED / L4_DERIVED), 12)
  })

  it('converts the A10 full-container default at the configured FX rate', async () => {
    vi.stubEnv('EUR_PER_USD', '0.9')
    await sampled('NVIDIA A10G')
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED * (0.9 / 0.86), 12)
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR', '2')
    expect(smallGpuEurPerHour()).toBeCloseTo(2 * (A10_DERIVED / L4_DERIVED), 12)
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR_A10', '3')
    expect(smallGpuEurPerHour()).toBe(3)
  })
})

describe('the /status sampler', () => {
  it('asks the box root, not the /v1 base, with the same bearer as the wake', async () => {
    await sampled('NVIDIA L4')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.invalid/small/status',
      expect.objectContaining({
        headers: { Authorization: 'Bearer synthetic-key' },
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('a failed read prices at the HIGHEST known rate, not the previous family', async () => {
    await sampled('NVIDIA L4')
    fetchMock.mockResolvedValue(new Response('gone', { status: 404 }))
    await refreshSmallBoxGpu()
    // The box may have come back on the dearer family; a floor priced on the
    // dead container's L4 can understate, so a failed read records UNKNOWN.
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
  })

  it('no endpoint configured: no fetch, and no retry on every read', async () => {
    vi.stubEnv('SMALL_LLM_BASE_URL', undefined as unknown as string)
    await refreshSmallBoxGpu()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
    await vi.advanceTimersByTimeAsync(SMALL_GPU_SAMPLE_TTL_MS + 1)
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('concurrent refreshes share one read', async () => {
    const first = refreshSmallBoxGpu()
    const second = refreshSmallBoxGpu()
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a fresh sample prices without re-reading; the read NEVER fires a fetch', async () => {
    await sampled('NVIDIA L4')
    expect(smallGpuEurPerHour()).toBe(L4_DERIVED)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SMALL_GPU_SAMPLE_TTL_MS - 1)
    expect(smallGpuEurPerHour()).toBe(L4_DERIVED)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Past the TTL the pricing read stays PURE — it prices at the HIGHEST
    // known rate (the box may have come back on the dearer family; a stale
    // sample must not understate) and touches no network, because a rate read
    // can run on ANY tier's step and a `/status` GET could wake and bill the
    // scaled-to-zero box.
    await vi.advanceTimersByTimeAsync(1)
    fetchMock.mockClear()
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the TTL-bounded refresh fires only from a site that proved the box up', async () => {
    await sampled('NVIDIA L4')
    fetchMock.mockClear()
    refreshSmallBoxGpuIfStale() // fresh sample: no read
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SMALL_GPU_SAMPLE_TTL_MS + 1)
    fetchMock.mockResolvedValue(Response.json({ gpu: 'NVIDIA A10G' }))
    refreshSmallBoxGpuIfStale() // stale: exactly one read, deduped by the sampler
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
  })

  it('resample drops the sample synchronously, before its re-read lands', async () => {
    await sampled('NVIDIA L4')
    // The re-read never lands within the test: until it does, the dead
    // container's L4 must not price — the highest rate is the honest floor.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    resampleSmallBoxGpu()
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
  })

  it('an unanswered read is aborted at its bound and prices the highest rate', async () => {
    await sampled('NVIDIA L4')
    let seenSignal: AbortSignal | undefined
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      seenSignal = init.signal ?? undefined
      // Never settles on its own; the sample's own abort ends it, as the
      // wake's `stalled` helper models the same thing.
      return new Promise<Response>(() => {})
    })
    await vi.advanceTimersByTimeAsync(SMALL_GPU_SAMPLE_TTL_MS + 1)
    refreshSmallBoxGpuIfStale() // the stale refresh; the pricing read no longer kicks it
    await vi.advanceTimersByTimeAsync(5_000) // the sample's own timeout
    // THE BOUND, not just the outcome: this must fail if the abort timer is
    // removed — a read that never ends would otherwise hang the refresh site.
    expect(seenSignal!.aborted).toBe(true)
    // And the aborted read recorded UNKNOWN, not the previous family.
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
  })
})

describe('the pricing seam carries the GPU-aware reader', () => {
  // Source-scan wiring pin, the house style of runner-wiring.test.ts: the
  // registration is module-load code a unit test cannot call twice, so the pin
  // reads the source it lives in.
  const source = readFileSync(
    join(import.meta.dirname, '../../../lib/inference/config.server.ts'),
    'utf8',
  )
  it('registers smallGpuEurPerHour for BOTH small clients', () => {
    expect(source).toContain('SmallQwen: smallGpuEurPerHour')
    expect(source).toContain('PrivateSystemOne: smallGpuEurPerHour')
  })
  it('and no longer the GPU-blind base reader', () => {
    expect(source).not.toContain('SmallQwen: smallLlmEurPerHour')
  })
})
