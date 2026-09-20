/**
 * WarmPool unit tests.
 *
 * Hermetic — the backend is a vi.fn() fake; no Docker or MCP SDK involved.
 * Covers acquire (hit / miss), release (park / cap-full / reset-fail),
 * evictIdle, shutdown, prewarm, and the fingerprint-scoped handoff rule
 * (tenantId|rootfs|egress — Lane C, docs/plan/sandbox.md → channel 3).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { WarmPool } from '../../../lib/sandbox/warm-pool.server'
import type {
  ComputeBackend,
  RootfsId,
  RuntimeConfig,
  VMHandle,
  HealthStatus,
  McpTransport,
} from '../../../lib/sandbox/types'

// ---- backend fake --------------------------------------------------------

let bootCount = 0
/** Like the real DockerBackend, the fake records the runtime it booted with
 *  into native.runtime — the fingerprint release parks under comes from the
 *  VM's own record, not from the caller. */
function makeHandle(rootfs: RootfsId = 'base', runtime: RuntimeConfig = {}): VMHandle {
  bootCount += 1
  return {
    id: `sbx-${bootCount.toString().padStart(4, '0')}`,
    backend: 'docker',
    rootfs,
    bootedAt: Date.now(),
    native: { containerId: `c-${bootCount}`, runtime },
  }
}

function makeBackend(overrides: Partial<ComputeBackend> = {}): ComputeBackend {
  const backend: ComputeBackend = {
    kind: 'docker',
    boot: vi.fn(async (rootfs: RootfsId, runtime: RuntimeConfig) => makeHandle(rootfs, runtime)),
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

// ============================================================================
// Fingerprint-scoped handoff (Lane C — docs/plan/sandbox.md → channel 3).
// A pool hit MUST match tenantId|rootfs|egress exactly; a mismatch is a
// pool MISS (cold-boot with the requested runtime), never a silent handover
// of another tenant's posture. `native.runtime` survives reset, so without
// this scoping an mcp-only caller could receive a pypi VM — network
// attached, mounted on another tenant's /cache volume.
// ============================================================================

describe('WarmPool — fingerprint-scoped handoff (Lane C)', () => {
  const T_A = { egress: 'pypi' as const, tenantId: 'tenant-a' }
  const T_B = { egress: 'pypi' as const, tenantId: 'tenant-b' }

  it('MUTATION PIN: two acquires differing only in tenantId do NOT share a pooled VM', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const first = await pool.acquire('base', T_A)
    await pool.release(first) // parks under tenant-a's fingerprint

    // Same rootfs, same egress — ONLY the tenant differs. A hit here would
    // hand tenant-b a VM mounted on tenant-a's /cache volume.
    vi.mocked(backend.boot).mockClear()
    const second = await pool.acquire('base', T_B)

    expect(backend.boot).toHaveBeenCalledTimes(1) // cold-booted, not pooled
    expect(second).not.toBe(first)
    expect(second.id).not.toBe(first.id)
  })

  it('the mismatched VM stays parked for its OWN fingerprint (a miss, not a destroy)', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const first = await pool.acquire('base', T_A)
    await pool.release(first)

    await pool.acquire('base', T_B) // miss for tenant-b → cold-boot
    expect(pool.size('base')).toBe(1) // tenant-a's VM still parked

    // The parked VM is an exact-match hit for ITS OWN fingerprint again.
    vi.mocked(backend.boot).mockClear()
    const again = await pool.acquire('base', T_A)
    expect(backend.boot).not.toHaveBeenCalled()
    expect(again).toBe(first)
  })

  it('a mismatch in egress alone is also a pool miss (egress is an isolation knob)', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const first = await pool.acquire('base', { egress: 'pypi', tenantId: 'tenant-a' })
    await pool.release(first)

    vi.mocked(backend.boot).mockClear()
    const second = await pool.acquire('base', { egress: 'open', tenantId: 'tenant-a' })
    expect(backend.boot).toHaveBeenCalledTimes(1)
    expect(second).not.toBe(first)
  })

  it('an exact match (same tenantId, rootfs, egress) IS a pool hit', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const first = await pool.acquire('base', T_A)
    await pool.release(first)

    vi.mocked(backend.boot).mockClear()
    const second = await pool.acquire('base', T_A)
    expect(backend.boot).not.toHaveBeenCalled()
    expect(second).toBe(first)
  })

  it('the default tenant and an absent tenantId are the SAME fingerprint', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const first = await pool.acquire('base', {})
    await pool.release(first)

    vi.mocked(backend.boot).mockClear()
    const second = await pool.acquire('base', { tenantId: 'default', egress: 'mcp-only' })
    expect(backend.boot).not.toHaveBeenCalled()
    expect(second).toBe(first)
  })

  it('resource caps (cpus/memoryMB) do NOT segment the pool — posture is tenantId|rootfs|egress only', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const first = await pool.acquire('base', { ...T_A, cpus: 1 })
    await pool.release(first)

    vi.mocked(backend.boot).mockClear()
    const second = await pool.acquire('base', { ...T_A, cpus: 4, memoryMB: 1024 })
    expect(backend.boot).not.toHaveBeenCalled()
    expect(second).toBe(first)
  })

  it('prewarm parks under the requested runtime — its own tenants hit, others miss', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    await pool.prewarm('base', 1, T_A)

    vi.mocked(backend.boot).mockClear()
    await pool.acquire('base', T_A)
    expect(backend.boot).not.toHaveBeenCalled()

    await pool.acquire('base', T_B) // not tenant-a's posture → cold-boot
    expect(backend.boot).toHaveBeenCalledTimes(1)
  })

  it('a VM whose handle records NO runtime is un-vouchable: released = destroyed, never parked', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const vm = await pool.acquire('base', T_A)
    delete (vm.native as { runtime?: unknown }).runtime

    await pool.release(vm)
    expect(backend.destroy).toHaveBeenCalledWith(vm)
    expect(pool.size('base')).toBe(0)
  })

  it('reset keeps the VM on its original posture: released-and-reacquired VM still runs its recorded runtime', async () => {
    // The real reset re-boots with native.runtime (the original tenant's
    // posture — Lane A's cold-boot scoping); the fake mimics that by leaving
    // native.runtime untouched. Pin that the recycled VM is handed back ONLY
    // to the fingerprint it actually runs.
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })

    const vm = await pool.acquire('base', T_B)
    await pool.release(vm) // reset ran; posture unchanged (native.runtime)

    // tenant-a asks while tenant-b's VM is parked: miss, no cross-tenant handover
    const other = await pool.acquire('base', T_A)
    expect(other).not.toBe(vm)

    // tenant-b re-acquires: exact match, same VM, same recorded runtime
    vi.mocked(backend.boot).mockClear()
    const again = await pool.acquire('base', T_B)
    expect(again).toBe(vm)
    expect((again.native as { runtime: RuntimeConfig }).runtime).toEqual(T_B)
  })
})
