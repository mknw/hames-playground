/**
 * AttachmentTable — id-addressable, ref-counted sandbox attachments.
 *
 * `withSandbox({ id: 'foo' })` looks up an attachment by id; a hit reuses
 * the live VM + transport, a miss boots one via the pool and stores it.
 * Concurrent acquires on the same id share a single VM/transport via
 * reference counting; release decrements; refCount=0 leaves the entry
 * parked under the id (a sweeper destroys it after `idleMs`).
 *
 * Sweep model: lazy + optional timer. Each `acquire` fires a best-effort
 * background sweep that destroys idle attachments AND cascades to
 * `pool.evictIdle()`. Because that only fires on activity, `startSweepTimer`
 * adds a periodic (unref'd) sweep so a *fully idle* harness still reaps its
 * parked VMs (#82); production arms it in `with-sandbox`, tests opt in.
 *
 * At-rest cap: `maxAttachments` (optional) bounds parked VMs regardless of
 * idleness — a new boot evicts the least-recently-used refCount=0 entry
 * (#82). `globalCap` only bounds in-flight allocations, not the at-rest table.
 *
 * Race-safe: parallel callers requesting the same id share the same boot
 * promise via an `inFlight` map; only the first call does the work.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import type {
  ComputeBackend,
  HealthStatus,
  McpTransport,
  RootfsId,
  RuntimeConfig,
  VMHandle,
} from './types'
import type { WarmPool } from './warm-pool.server'

assertServerOnImport()

export interface Attachment {
  readonly id: string
  readonly vm: VMHandle
  readonly transport: McpTransport
  refCount: number
  lastUsedAt: number
  /**
   * True until the workspace has been hydrated into this (fresh) container.
   * Set `true` on first boot; the `withSandbox` wrapper hydrates `/work` from
   * the document store once and flips it to `false` so subsequent same-session
   * turns (which reuse this live attachment) don't re-hydrate (#89). A reconnect
   * after idle eviction boots a fresh container → new attachment → `true` again.
   */
  isFirstBoot: boolean
}

export interface AttachmentTableConfig {
  /** Idle time before a refCount=0 attachment is destroyed (ms). */
  idleMs: number
  /**
   * Hard ceiling on entries in the table (#82). When a new boot would exceed
   * it, the least-recently-used refCount=0 (parked) attachment is evicted to
   * make room. `undefined` = no cap (the historical behavior). Bounds at-rest
   * VMs regardless of idleness; `globalCap` only bounds in-flight allocations.
   */
  maxAttachments?: number
}

export class AttachmentTable {
  private readonly table = new Map<string, Attachment>()
  private readonly inFlight = new Map<string, Promise<Attachment>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly backend: ComputeBackend,
    private readonly pool: WarmPool,
    private readonly config: AttachmentTableConfig,
  ) {}

  /**
   * Acquire by id. Returns an existing live attachment with refCount bumped
   * if one exists; otherwise boots via the pool and stores a new entry.
   * Concurrent acquires of the same id share the same boot.
   */
  async acquire(id: string, rootfs: RootfsId, runtime: RuntimeConfig): Promise<Attachment> {
    // Fire-and-forget sweep so this call isn't latency-bound by cleanup.
    void this.sweepIdle().catch(() => {})

    const existing = this.table.get(id)
    if (existing) {
      // Liveness check before reuse (#97 Gap 2). A container can die out from
      // under us between turns — host crash, external `docker rm`, OOM-kill.
      // Reusing its dead transport would fail every tool call and wedge the
      // session until idle-evict. On a non-healthy verdict, tear the stale
      // entry down and fall through to a fresh boot; the new attachment is
      // `isFirstBoot=true`, so the `withSandbox` syncWorkspace path re-hydrates
      // /work transparently (#89). Costs ~1 `docker inspect` per reuse.
      const health = await this.backend
        .health(existing.vm)
        .catch((): HealthStatus => ({ state: 'gone' }))
      if (health.state === 'healthy') {
        existing.refCount += 1
        existing.lastUsedAt = Date.now()
        return existing
      }
      await this.evictStale(existing)
    }
    const pending = this.inFlight.get(id)
    if (pending) {
      const att = await pending
      att.refCount += 1
      att.lastUsedAt = Date.now()
      return att
    }
    const p = (async (): Promise<Attachment> => {
      // Make room under the at-rest cap BEFORE booting, so peak VM count stays
      // at the cap rather than cap+1 (#82).
      await this.enforceCap()
      const vm = await this.pool.acquire(rootfs, runtime)
      let transport: McpTransport
      try {
        transport = await this.backend.connectMcp(vm)
      } catch (err) {
        await this.pool.release(vm).catch(() => {})
        throw err
      }
      const att: Attachment = {
        id,
        vm,
        transport,
        refCount: 1,
        lastUsedAt: Date.now(),
        isFirstBoot: true,
      }
      this.table.set(id, att)
      return att
    })()
    this.inFlight.set(id, p)
    try {
      return await p
    } finally {
      this.inFlight.delete(id)
    }
  }

  /** Decrement refCount. At zero the attachment stays parked for idle sweep. */
  release(att: Attachment): void {
    att.refCount = Math.max(0, att.refCount - 1)
    att.lastUsedAt = Date.now()
  }

  /**
   * Drop a dead attachment found by the reuse health-check (#97 Gap 2).
   * Unlike `destroyById`/`release`, this does NOT route through the pool: the
   * container is already gone/unhealthy, so there is nothing to recycle —
   * `backend.destroy` (idempotent `docker rm -f`) clears any lingering record.
   * Removing it from the table lets the caller fall through to a fresh boot.
   */
  private async evictStale(att: Attachment): Promise<void> {
    this.table.delete(att.id)
    await att.transport.close().catch(() => {})
    await this.backend.destroy(att.vm).catch(() => {})
  }

  /**
   * Force-destroy an attachment regardless of refCount. Used by
   * `withSandbox({ id, fresh: true })` to blow away a stored entry before
   * re-acquiring. Safe to call on an unknown id (no-op).
   */
  async destroyById(id: string): Promise<void> {
    const att = this.table.get(id)
    if (!att) return
    this.table.delete(id)
    await att.transport.close().catch(() => {})
    await this.pool.release(att.vm).catch(() => {})
  }

  /**
   * LRU cap enforcement (#82). Before booting a new attachment, if the table
   * is at `maxAttachments`, evict the least-recently-used PARKED (refCount=0)
   * entry to make room. If every entry is still in use, the cap overflows
   * rather than kill a live session — the scheduler's `globalCap` remains the
   * in-flight backstop. No-op when `maxAttachments` is unset.
   *
   * Soft by design under concurrency too: two boots of *different* ids can both
   * pass this check before either inserts, transiently reaching cap+1. Not a
   * bug — the cap bounds steady-state accumulation, not a momentary race.
   */
  private async enforceCap(): Promise<void> {
    const max = this.config.maxAttachments
    if (max === undefined) return
    while (this.table.size >= max) {
      let lru: Attachment | undefined
      for (const att of this.table.values()) {
        if (att.refCount === 0 && (lru === undefined || att.lastUsedAt < lru.lastUsedAt)) {
          lru = att
        }
      }
      if (lru === undefined) break // all in use — allow overflow
      this.table.delete(lru.id)
      await lru.transport.close().catch(() => {})
      await this.pool.release(lru.vm).catch(() => {})
    }
  }

  /**
   * Start a periodic idle sweep (#82). The per-`acquire` lazy sweep only fires
   * on activity; this covers a *fully idle* harness whose parked VMs would
   * otherwise sit until the next sandbox action. Idempotent. `unref()`'d so it
   * never keeps the process alive on its own. Clear via `stopSweepTimer` /
   * `shutdown`.
   */
  startSweepTimer(intervalMs: number): void {
    if (this.sweepTimer) return
    const timer = setInterval(() => {
      void this.sweepIdle().catch(() => {})
    }, intervalMs)
    // Node's Timeout has unref(); guard in case the runtime's return type differs.
    timer.unref?.()
    this.sweepTimer = timer
  }

  /** Stop the periodic sweep started by `startSweepTimer` (idempotent). */
  stopSweepTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /**
   * Destroy refCount=0 attachments idle past the threshold, and cascade to
   * `pool.evictIdle` so warm-pool entries don't accumulate either. Public
   * for tests; production calls it via the lazy hook in `acquire` and the
   * periodic `startSweepTimer`.
   */
  async sweepIdle(now: number = Date.now()): Promise<void> {
    const toEvict: Attachment[] = []
    for (const att of this.table.values()) {
      if (att.refCount === 0 && now - att.lastUsedAt >= this.config.idleMs) {
        toEvict.push(att)
      }
    }
    for (const att of toEvict) {
      this.table.delete(att.id)
    }
    await Promise.all(
      toEvict.map(async (att) => {
        await att.transport.close().catch(() => {})
        await this.pool.release(att.vm).catch(() => {})
      }),
    )
    await this.pool.evictIdle(now).catch(() => {})
  }

  /** Destroy every attachment. Called on harness shutdown / between tests. */
  async shutdown(): Promise<void> {
    this.stopSweepTimer()
    const all = [...this.table.values()]
    this.table.clear()
    await Promise.all(
      all.map(async (att) => {
        await att.transport.close().catch(() => {})
        await this.pool.release(att.vm).catch(() => {})
      }),
    )
  }

  size(): number {
    return this.table.size
  }

  has(id: string): boolean {
    return this.table.has(id)
  }
}
