/**
 * WarmPool unit tests.
 *
 * Hermetic — the backend is a vi.fn() fake; no Docker or MCP SDK involved.
 * Covers acquire (hit / miss), release (park / cap-full / reset-fail),
 * evictIdle, shutdown, and prewarm.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { WarmPool } from '../../../lib/sandbox/warm-pool.server'
import type { ComputeBackend, RootfsId, RuntimeConfig, VMHandle, HealthStatus, McpTransport } from '../../../lib/sandbox/types'

// ---- backend fake --------------------------------------------------------

let bootCount = 0
function makeHandle(rootfs: RootfsId = 'base', bootedAt = Date.now()): VMHandle {
  bootCount += 1
  return {
    id: `sbx-${bootCount.toString().padStart(4, '0')}`,
    backend: 'docker',
    rootfs,
    bootedAt,
    native: { containerId: `c-${bootCount}`, runtime: {} },
  }
}

function makeBackend(overrides: Partial<ComputeBackend> = {}): ComputeBackend {
  const backend: ComputeBackend = {
    kind: 'docker',
    boot: vi.fn(async (rootfs: RootfsId, _runtime: RuntimeConfig) => makeHandle(rootfs)),
    destroy: vi.fn(async (_vm: VMHandle) => undefined),
    reset: vi.fn(async (vm: VMHandle) => {
      // Mimic real reset: bootedAt advances.
      ;(vm as { bootedAt: number }).bootedAt = Date.now()
    }),
    connectMcp: vi.fn(async (_vm: VMHandle): Promise<McpTransport> => {
      throw new Error('not used in warm-pool tests')
    }),
    health: vi.fn(async (_vm: VMHandle): Promise<HealthStatus> => ({ state: 'healthy' })),
    reapOrphans: vi.fn(async () => 0),
    ...overrides,
  }
  return backend
}

beforeEach(() => {
  bootCount = 0
})

// ---- tests ---------------------------------------------------------------

describe('WarmPool.acquire', () => {
  it('cold-boots when the pool is empty', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const vm = await pool.acquire('base', {})
    expect(vm.rootfs).toBe('base')
    expect(backend.boot).toHaveBeenCalledTimes(1)
    expect(pool.size()).toBe(0)
  })

  it('returns a parked VM without calling boot', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const first = await pool.acquire('base', {})
    await pool.release(first)
    expect(pool.size('base')).toBe(1)

    vi.mocked(backend.boot).mockClear()
    const second = await pool.acquire('base', {})
    expect(backend.boot).not.toHaveBeenCalled()
    expect(second.id).toBe(first.id)
    expect(pool.size('base')).toBe(0)
  })

  it('passes through cold-boot for unknown rootfs flavors', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const vm = await pool.acquire('python-heavy', {})
    expect(vm.rootfs).toBe('python-heavy')
    expect(backend.boot).toHaveBeenCalledWith('python-heavy', {})
  })
})

describe('WarmPool.release', () => {
  it('calls backend.reset then parks the VM', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const vm = await pool.acquire('base', {})
    await pool.release(vm)

    expect(backend.reset).toHaveBeenCalledWith(vm)
    expect(backend.destroy).not.toHaveBeenCalled()
    expect(pool.size('base')).toBe(1)
  })

  it('destroys instead of parking when the pool is at cap', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })

    const a = await pool.acquire('base', {})
    const b = await pool.acquire('base', {})
    await pool.release(a)
    expect(pool.size('base')).toBe(1)
    await pool.release(b)
    expect(pool.size('base')).toBe(1)
    expect(backend.destroy).toHaveBeenCalledTimes(1)
    expect(backend.destroy).toHaveBeenCalledWith(b)
  })

  it('destroys when caps is missing for the flavor (defaults to 0)', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: {}, idleEvictMs: 60_000 })

    const vm = await pool.acquire('base', {})
    await pool.release(vm)
    expect(backend.reset).toHaveBeenCalledTimes(1)
    expect(backend.destroy).toHaveBeenCalledWith(vm)
    expect(pool.size()).toBe(0)
  })

  it('destroys (does not park) when reset throws', async () => {
    const backend = makeBackend({
      reset: vi.fn(async () => {
        throw new Error('engine unreachable')
      }),
    })
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const vm = await pool.acquire('base', {})
    await expect(pool.release(vm)).resolves.toBeUndefined()
    expect(backend.destroy).toHaveBeenCalledWith(vm)
    expect(pool.size()).toBe(0)
  })
})

describe('WarmPool.evictIdle', () => {
  it('destroys VMs parked past the threshold, leaves fresh ones', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeBackend()
      const pool = new WarmPool(backend, { caps: { base: 4 }, idleEvictMs: 10_000 })
      const t0 = 1_000_000
      vi.setSystemTime(t0)
      const v1 = await pool.acquire('base', {})
      await pool.release(v1)
      vi.setSystemTime(t0 + 20_000)
      // Bypass acquire (which would return v1) and cold-boot v2 directly,
      // then park it via release at this later timestamp.
      const v2 = await backend.boot('base', {})
      await pool.release(v2)
      expect(pool.size('base')).toBe(2)

      // At t0 + 25_000: v1 is 25s old (evicted), v2 is 5s old (kept).
      await pool.evictIdle(t0 + 25_000)
      expect(pool.size('base')).toBe(1)
      expect(backend.destroy).toHaveBeenCalledTimes(1)
      expect(backend.destroy).toHaveBeenCalledWith(v1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a no-op when nothing is idle', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const vm = await pool.acquire('base', {})
    await pool.release(vm)

    await pool.evictIdle(Date.now())
    expect(backend.destroy).not.toHaveBeenCalled()
    expect(pool.size('base')).toBe(1)
  })
})

describe('WarmPool.prewarm', () => {
  it('boots N VMs into the pool, capped by caps[rootfs]', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    await pool.prewarm('base', 5, {})
    // Capped at 2.
    expect(backend.boot).toHaveBeenCalledTimes(2)
    expect(pool.size('base')).toBe(2)
  })

  it('does nothing when the pool is already at cap', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })

    const vm = await pool.acquire('base', {})
    await pool.release(vm)
    expect(pool.size('base')).toBe(1)

    vi.mocked(backend.boot).mockClear()
    await pool.prewarm('base', 5, {})
    expect(backend.boot).not.toHaveBeenCalled()
    expect(pool.size('base')).toBe(1)
  })

  it('tolerates boot failures (parks the survivors)', async () => {
    let n = 0
    const backend = makeBackend({
      boot: vi.fn(async (rootfs: RootfsId) => {
        n += 1
        if (n === 2) throw new Error('boot failed')
        return makeHandle(rootfs)
      }),
    })
    const pool = new WarmPool(backend, { caps: { base: 3 }, idleEvictMs: 60_000 })
    await pool.prewarm('base', 3, {})
    expect(backend.boot).toHaveBeenCalledTimes(3)
    expect(pool.size('base')).toBe(2)
  })
})

describe('WarmPool.shutdown', () => {
  it('destroys every parked VM across all flavors', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2, other: 1 }, idleEvictMs: 60_000 })

    const a = await pool.acquire('base', {})
    const b = await pool.acquire('base', {})
    const c = await pool.acquire('other', {})
    await pool.release(a)
    await pool.release(b)
    await pool.release(c)
    expect(pool.size()).toBe(3)

    await pool.shutdown()
    expect(backend.destroy).toHaveBeenCalledTimes(3)
    expect(pool.size()).toBe(0)
  })

  it('handles destroy failures during shutdown without throwing', async () => {
    const backend = makeBackend({
      destroy: vi.fn(async () => {
        throw new Error('engine gone')
      }),
    })
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const vm = await pool.acquire('base', {})
    await pool.release(vm)
    await expect(pool.shutdown()).resolves.toBeUndefined()
    expect(pool.size()).toBe(0)
  })
})

describe('WarmPool.size', () => {
  it('reports per-flavor and total depth', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2, other: 1 }, idleEvictMs: 60_000 })

    const a = await pool.acquire('base', {})
    const b = await pool.acquire('other', {})
    await pool.release(a)
    await pool.release(b)
    expect(pool.size('base')).toBe(1)
    expect(pool.size('other')).toBe(1)
    expect(pool.size()).toBe(2)
    expect(pool.size('missing')).toBe(0)
  })
})
