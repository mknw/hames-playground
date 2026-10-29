import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SMALL_GPU_SAMPLE_TTL_MS,
  refreshSmallBoxGpu,
  resetSmallGpuForTests,
  smallGpuEurPerHour,
  smallGpuFamily,
} from '../../../lib/inference/small-gpu.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

/** 1.54 (the L4 default) × the owner's 2026-10-27 quote ratio 1.10/0.80. */
const A10_DERIVED = 1.54 * (1.1 / 0.8)

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
    expect(smallGpuEurPerHour()).toBeGreaterThan(1.54)
  })

  it('prices each sampled family at its own rate', async () => {
    await sampled('NVIDIA L4')
    expect(smallGpuEurPerHour()).toBe(1.54)
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
    expect(smallGpuEurPerHour()).toBeCloseTo(2 * (1.1 / 0.8), 12)
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

  it('a failed read keeps what the previous sample knew', async () => {
    await sampled('NVIDIA L4')
    fetchMock.mockResolvedValue(new Response('gone', { status: 404 }))
    await refreshSmallBoxGpu()
    expect(smallGpuEurPerHour()).toBe(1.54)
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

  it('a fresh sample prices without re-reading; a stale one refreshes once', async () => {
    await sampled('NVIDIA L4')
    expect(smallGpuEurPerHour()).toBe(1.54)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SMALL_GPU_SAMPLE_TTL_MS - 1)
    expect(smallGpuEurPerHour()).toBe(1.54)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Past the TTL the sync read still prices on the sample it HAS and kicks
    // exactly one background read; the new rate prices the calls after it lands.
    fetchMock.mockResolvedValue(Response.json({ gpu: 'NVIDIA A10G' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(smallGpuEurPerHour()).toBe(1.54)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(smallGpuEurPerHour()).toBeCloseTo(A10_DERIVED, 12)
  })

  it('an unanswered read is bounded and leaves the previous knowledge', async () => {
    await sampled('NVIDIA L4')
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        // Never settles on its own; the sample's own abort ends it, as the
        // wake's `stalled` helper models the same thing.
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        }),
    )
    await vi.advanceTimersByTimeAsync(SMALL_GPU_SAMPLE_TTL_MS + 1)
    smallGpuEurPerHour() // kicks the stale refresh
    await vi.advanceTimersByTimeAsync(5_000) // the sample's own timeout
    expect(smallGpuEurPerHour()).toBe(1.54)
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
