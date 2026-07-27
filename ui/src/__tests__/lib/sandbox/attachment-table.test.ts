/**
 * AttachmentTable unit tests.
 *
 * Hermetic — vi.fn() backend, real WarmPool. No Docker / no MCP SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { AttachmentTable } from '../../../lib/sandbox/attachment-table.server'
import { WarmPool } from '../../../lib/sandbox/warm-pool.server'
import type {
  ComputeBackend,
  HealthStatus,
  McpTransport,
  RootfsId,
  RuntimeConfig,
  VMHandle,
} from '../../../lib/sandbox/types'

// ---- fakes ---------------------------------------------------------------

let bootCount = 0
function makeHandle(rootfs: RootfsId = 'base'): VMHandle {
  bootCount += 1
  return {
    id: `sbx-${bootCount}`,
    backend: 'docker',
    rootfs,
    bootedAt: Date.now(),
    native: { containerId: `c-${bootCount}`, runtime: {} },
  }
}

interface FakeTransport extends McpTransport {
  closes: number
}

function makeTransport(vmId: string): FakeTransport {
  const t = {
    vmId,
    closes: 0,
    toolNames: async () => [],
    listTools: async () => [],
    ownsTool: () => false,
    callTool: async () => ({ success: true, data: null }),
    close: async function (this: FakeTransport) {
      this.closes += 1
    },
  } as FakeTransport
  return t
}

function makeBackend(overrides: Partial<ComputeBackend> = {}): ComputeBackend {
  const backend: ComputeBackend = {
    kind: 'docker',
    boot: vi.fn(async (rootfs: RootfsId, _runtime: RuntimeConfig) => makeHandle(rootfs)),
    destroy: vi.fn(async () => undefined),
    reset: vi.fn(async (vm: VMHandle) => {
      ;(vm as { bootedAt: number }).bootedAt = Date.now()
    }),
    connectMcp: vi.fn(async (vm: VMHandle) => makeTransport(vm.id)),
    health: vi.fn(async (): Promise<HealthStatus> => ({ state: 'healthy' })),
    reapOrphans: vi.fn(async () => 0),
    ...overrides,
  }
  return backend
}

beforeEach(() => {
  bootCount = 0
})

// ---- tests ---------------------------------------------------------------

describe('AttachmentTable.acquire', () => {
  it('boots through the pool on the first acquire and stores under the id', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const att = await table.acquire('alpha', 'base', {})
    expect(att.id).toBe('alpha')
    expect(att.refCount).toBe(1)
    expect(backend.boot).toHaveBeenCalledTimes(1)
    expect(backend.connectMcp).toHaveBeenCalledTimes(1)
    expect(table.has('alpha')).toBe(true)
  })

  it('returns the same attachment on subsequent acquires (refCount bumped)', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const first = await table.acquire('alpha', 'base', {})
    const second = await table.acquire('alpha', 'base', {})
    expect(second).toBe(first)
    expect(first.refCount).toBe(2)
    expect(backend.boot).toHaveBeenCalledTimes(1)
    expect(backend.connectMcp).toHaveBeenCalledTimes(1)
  })

  it('shares the boot promise between concurrent acquires of the same id', async () => {
    let resolveBoot: (vm: VMHandle) => void = () => {}
    const backend = makeBackend({
      boot: vi.fn(async () => {
        return await new Promise<VMHandle>((resolve) => {
          resolveBoot = resolve
        })
      }),
    })
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const p1 = table.acquire('alpha', 'base', {})
    const p2 = table.acquire('alpha', 'base', {})
    await new Promise((r) => setImmediate(r))
    expect(backend.boot).toHaveBeenCalledTimes(1)

    resolveBoot(makeHandle('base'))
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe(b)
    expect(a.refCount).toBe(2)
  })

  it('isolates attachments under different ids', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const a = await table.acquire('alpha', 'base', {})
    const b = await table.acquire('beta', 'base', {})
    expect(a).not.toBe(b)
    expect(backend.boot).toHaveBeenCalledTimes(2)
    expect(table.size()).toBe(2)
  })
})

describe('AttachmentTable.acquire health-check on reuse (#97 Gap 2)', () => {
  it('health-checks the live entry on reuse and skips reboot when healthy', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const first = await table.acquire('alpha', 'base', {})
    const second = await table.acquire('alpha', 'base', {})

    expect(second).toBe(first)
    expect(first.refCount).toBe(2)
    // Probed exactly once — only the reuse hit checks; the first (miss) boots.
    expect(backend.health).toHaveBeenCalledTimes(1)
    expect(backend.boot).toHaveBeenCalledTimes(1)
    expect(backend.connectMcp).toHaveBeenCalledTimes(1)
  })

  it('evicts a dead entry and reboots a fresh attachment under the same id', async () => {
    const health = vi.fn(async (): Promise<HealthStatus> => ({ state: 'healthy' }))
    const backend = makeBackend({ health })
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const first = await table.acquire('alpha', 'base', {})
    const firstTransport = first.transport as FakeTransport
    const firstVm = first.vm

    // The container dies out from under us (crash / external `docker rm`).
    health.mockResolvedValueOnce({ state: 'gone' })
    const second = await table.acquire('alpha', 'base', {})

    expect(second).not.toBe(first) // a fresh attachment, not the dead one
    expect(second.id).toBe('alpha') // same id
    expect(second.refCount).toBe(1)
    expect(second.isFirstBoot).toBe(true) // re-hydration trigger for syncWorkspace
    expect(firstTransport.closes).toBe(1) // stale transport torn down
    expect(backend.destroy).toHaveBeenCalledWith(firstVm) // dead VM force-removed
    expect(backend.boot).toHaveBeenCalledTimes(2) // rebooted
    expect(table.has('alpha')).toBe(true)
    expect(table.size()).toBe(1) // exactly one entry — no leak
  })

  it('treats an unhealthy (non-running) container as evictable too', async () => {
    const health = vi.fn(async (): Promise<HealthStatus> => ({ state: 'healthy' }))
    const backend = makeBackend({ health })
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const first = await table.acquire('alpha', 'base', {})
    health.mockResolvedValueOnce({ state: 'unhealthy', detail: 'exited' })
    const second = await table.acquire('alpha', 'base', {})

    expect(second).not.toBe(first)
    expect(backend.boot).toHaveBeenCalledTimes(2)
  })

  it('reboots when the health probe itself throws (defensive)', async () => {
    const health = vi.fn(async (): Promise<HealthStatus> => ({ state: 'healthy' }))
    const backend = makeBackend({ health })
    const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const first = await table.acquire('alpha', 'base', {})
    health.mockRejectedValueOnce(new Error('docker daemon gone'))
    const second = await table.acquire('alpha', 'base', {})

    expect(second).not.toBe(first)
    expect(backend.boot).toHaveBeenCalledTimes(2)
  })
})

describe('AttachmentTable.release', () => {
  it('decrements refCount but leaves the entry parked when count hits zero', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const att = await table.acquire('alpha', 'base', {})
    table.release(att)
    expect(att.refCount).toBe(0)
    expect(table.has('alpha')).toBe(true)
    // VM still alive — neither destroy nor reset called yet.
    expect(backend.destroy).not.toHaveBeenCalled()
    expect(backend.reset).not.toHaveBeenCalled()
  })

  it('survives an over-release (refCount floored at 0)', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const att = await table.acquire('alpha', 'base', {})
    table.release(att)
    table.release(att)
    table.release(att)
    expect(att.refCount).toBe(0)
  })

  it('reacquire after release-to-zero bumps refCount back to 1', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const a = await table.acquire('alpha', 'base', {})
    table.release(a)
    const b = await table.acquire('alpha', 'base', {})
    expect(b).toBe(a)
    expect(b.refCount).toBe(1)
    expect(backend.boot).toHaveBeenCalledTimes(1) // still only the one boot
  })
})

describe('AttachmentTable.sweepIdle', () => {
  it('destroys refCount=0 attachments past idleMs and cascades to pool.evictIdle', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeBackend()
      const pool = new WarmPool(backend, { caps: { base: 2 }, idleEvictMs: 10_000 })
      const evictSpy = vi.spyOn(pool, 'evictIdle')
      const table = new AttachmentTable(backend, pool, { idleMs: 10_000 })

      const t0 = 1_000_000
      vi.setSystemTime(t0)
      const att = await table.acquire('alpha', 'base', {})
      table.release(att)
      expect(att.refCount).toBe(0)

      // Still fresh at t0 + 5s — no eviction.
      await table.sweepIdle(t0 + 5_000)
      expect(table.has('alpha')).toBe(true)

      // Past idleMs at t0 + 11s — evicted.
      await table.sweepIdle(t0 + 11_000)
      expect(table.has('alpha')).toBe(false)
      expect(evictSpy).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not destroy attachments still in use (refCount > 0)', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeBackend()
      const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
      const table = new AttachmentTable(backend, pool, { idleMs: 10_000 })

      const t0 = 1_000_000
      vi.setSystemTime(t0)
      const att = await table.acquire('alpha', 'base', {})
      // refCount = 1; even past idleMs, must not be evicted.
      await table.sweepIdle(t0 + 100_000)
      expect(table.has('alpha')).toBe(true)
      expect(att.refCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AttachmentTable.destroyById', () => {
  it('removes the attachment regardless of refCount', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    const att = await table.acquire('alpha', 'base', {})
    expect(att.refCount).toBe(1) // still in use
    await table.destroyById('alpha')
    expect(table.has('alpha')).toBe(false)
  })

  it('is a no-op on unknown id', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })
    await expect(table.destroyById('nope')).resolves.toBeUndefined()
  })
})

describe('AttachmentTable.shutdown', () => {
  it('destroys every attachment and empties the table', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 3 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000 })

    await table.acquire('a', 'base', {})
    await table.acquire('b', 'base', {})
    await table.acquire('c', 'base', {})
    expect(table.size()).toBe(3)

    await table.shutdown()
    expect(table.size()).toBe(0)
  })
})

describe('AttachmentTable maxAttachments — LRU cap (#82)', () => {
  it('evicts the least-recently-used parked entry when a new boot exceeds the cap', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeBackend()
      const pool = new WarmPool(backend, { caps: { base: 3 }, idleEvictMs: 60_000 })
      const table = new AttachmentTable(backend, pool, { idleMs: 60_000, maxAttachments: 2 })

      vi.setSystemTime(1_000)
      const a = await table.acquire('alpha', 'base', {})
      table.release(a) // parked, lastUsedAt = 1_000 (oldest)

      vi.setSystemTime(2_000)
      const b = await table.acquire('beta', 'base', {})
      table.release(b) // parked, lastUsedAt = 2_000 (more recent)
      expect(table.size()).toBe(2)

      // Third distinct id at cap → evict the LRU parked entry (alpha).
      vi.setSystemTime(3_000)
      await table.acquire('gamma', 'base', {})

      expect(table.has('alpha')).toBe(false) // LRU evicted
      expect(table.has('beta')).toBe(true)
      expect(table.has('gamma')).toBe(true)
      expect(table.size()).toBe(2) // cap held
      expect((a.transport as FakeTransport).closes).toBe(1) // stale transport torn down
    } finally {
      vi.useRealTimers()
    }
  })

  it('overflows rather than evicting in-use (refCount>0) entries', async () => {
    const backend = makeBackend()
    const pool = new WarmPool(backend, { caps: { base: 4 }, idleEvictMs: 60_000 })
    const table = new AttachmentTable(backend, pool, { idleMs: 60_000, maxAttachments: 2 })

    await table.acquire('alpha', 'base', {}) // refCount 1 (not released)
    await table.acquire('beta', 'base', {}) // refCount 1 (not released)
    expect(table.size()).toBe(2)

    // Both in use → cap cannot evict; overflow rather than kill a live session.
    await table.acquire('gamma', 'base', {})
    expect(table.size()).toBe(3)
    expect(table.has('alpha')).toBe(true)
    expect(table.has('beta')).toBe(true)
  })
})

describe('AttachmentTable.startSweepTimer (#82)', () => {
  it('fires sweepIdle on the interval WITHOUT an acquire, reaping idle parked VMs', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeBackend()
      const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 10_000 })
      const table = new AttachmentTable(backend, pool, { idleMs: 10_000 })

      vi.setSystemTime(1_000_000)
      const att = await table.acquire('alpha', 'base', {})
      table.release(att) // parked at t0

      table.startSweepTimer(30_000)
      // No further acquire — only the timer drives the sweep. Advancing the fake
      // clock 30s both fires the interval and ages the entry past idleMs.
      await vi.advanceTimersByTimeAsync(30_000)

      expect(table.has('alpha')).toBe(false)
      table.stopSweepTimer()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopSweepTimer halts the periodic sweep', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeBackend()
      const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 10_000 })
      const table = new AttachmentTable(backend, pool, { idleMs: 10_000 })
      const sweepSpy = vi.spyOn(table, 'sweepIdle')

      table.startSweepTimer(30_000)
      table.stopSweepTimer()
      await vi.advanceTimersByTimeAsync(90_000)

      expect(sweepSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('startSweepTimer is idempotent (no duplicate timers)', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeBackend()
      const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 10_000 })
      const table = new AttachmentTable(backend, pool, { idleMs: 10_000 })
      const sweepSpy = vi.spyOn(table, 'sweepIdle')

      table.startSweepTimer(30_000)
      table.startSweepTimer(30_000) // second call is a no-op
      await vi.advanceTimersByTimeAsync(30_000)

      expect(sweepSpy).toHaveBeenCalledTimes(1) // one tick, not two
      table.stopSweepTimer()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shutdown stops the sweep timer', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeBackend()
      const pool = new WarmPool(backend, { caps: { base: 1 }, idleEvictMs: 10_000 })
      const table = new AttachmentTable(backend, pool, { idleMs: 10_000 })

      table.startSweepTimer(30_000)
      await table.shutdown()
      const sweepSpy = vi.spyOn(table, 'sweepIdle')
      await vi.advanceTimersByTimeAsync(90_000)

      expect(sweepSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
