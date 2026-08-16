/**
 * WarmPool — pool of pre-booted VMs per rootfs flavor.
 *
 * Acquisition is O(ms) on a hit (return a parked VM); cold-boot via the
 * backend otherwise. Release calls `backend.reset(vm)` and parks the VM if
 * the pool has capacity; otherwise (cap reached or reset failed) destroys
 * it. See docs/plan/sandbox.md → "Warm pool".
 *
 * Pool is keyed by rootfs flavor only — v0 sandboxes use settings-driven
 * defaults, so all parked VMs share a runtime fingerprint. If a future
 * caller passes non-default runtime to `acquire`, they'll get either a
 * parked VM with the pool's original runtime (pool hit) or a cold-boot
 * with their runtime (pool miss). Segmenting by runtime fingerprint can
 * land if/when per-call overrides become common.
 *
 * This is a library, not a service: the harness creates one instance and
 * shares it; tests instantiate per-test. No background timers — the host
 * is expected to call `evictIdle` on a cadence (the `withSandbox` wiring
 * sets this up in build-order step 5 wiring, alongside `SandboxScheduler`).
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import type { ComputeBackend, RootfsId, RuntimeConfig, VMHandle } from './types'

assertServerOnImport()

export interface WarmPoolConfig {
  /**
   * Per-rootfs max parked count. Flavors not listed default to 0 (no pooling
   * for that flavor — release always destroys). Defaults come from
   * HarnessSettings (`sandbox.warmPool.*`) once wired.
   */
  caps: Partial<Record<RootfsId, number>>
  /** Idle threshold for `evictIdle`. */
  idleEvictMs: number
}

interface ParkedVm {
  vm: VMHandle
  parkedAt: number
}

export class WarmPool {
  private readonly pool = new Map<RootfsId, ParkedVm[]>()

  constructor(
    private readonly backend: ComputeBackend,
    private readonly config: WarmPoolConfig,
  ) {}

  /** Hit the pool if a VM of the right flavor is parked; cold-boot otherwise. */
  async acquire(rootfs: RootfsId, runtime: RuntimeConfig): Promise<VMHandle> {
    const parked = this.pool.get(rootfs)
    if (parked && parked.length > 0) {
      return parked.shift()!.vm
    }
    return this.backend.boot(rootfs, runtime)
  }

  /**
   * Recycle and park, or destroy if pool is full or recycle fails. The
   * caller is responsible for closing any McpTransport for this VM first
   * (its stdio pipes target the soon-to-be-destroyed container — see
   * `DockerBackend.reset`).
   */
  async release(vm: VMHandle): Promise<void> {
    try {
      await this.backend.reset(vm)
    } catch {
      await this.backend.destroy(vm).catch(() => {})
      return
    }
    const cap = this.config.caps[vm.rootfs] ?? 0
    const parked = this.pool.get(vm.rootfs) ?? []
    if (parked.length >= cap) {
      await this.backend.destroy(vm).catch(() => {})
      return
    }
    parked.push({ vm, parkedAt: Date.now() })
    this.pool.set(vm.rootfs, parked)
  }

  /** Destroy any parked VM idle past `idleEvictMs`. Idempotent; safe to call often. */
  async evictIdle(now: number = Date.now()): Promise<void> {
    const evictions: Promise<void>[] = []
    for (const [rootfs, parked] of this.pool) {
      const fresh: ParkedVm[] = []
      for (const p of parked) {
        if (now - p.parkedAt >= this.config.idleEvictMs) {
          evictions.push(this.backend.destroy(p.vm).catch(() => {}))
        } else {
          fresh.push(p)
        }
      }
      this.pool.set(rootfs, fresh)
    }
    await Promise.all(evictions)
  }

  /**
   * Boot `count` VMs into the pool ahead of demand (capped by `caps[rootfs]`).
   * Used to seed the baseline pool depth at process start. Boots happen
   * concurrently; one failure does not abort the others.
   */
  async prewarm(rootfs: RootfsId, count: number, runtime: RuntimeConfig): Promise<void> {
    const cap = this.config.caps[rootfs] ?? 0
    const current = this.pool.get(rootfs)?.length ?? 0
    const target = Math.min(count, cap - current)
    if (target <= 0) return
    const results = await Promise.allSettled(
      Array.from({ length: target }, () => this.backend.boot(rootfs, runtime)),
    )
    const now = Date.now()
    const parked = this.pool.get(rootfs) ?? []
    for (const r of results) {
      if (r.status === 'fulfilled') {
        parked.push({ vm: r.value, parkedAt: now })
      }
    }
    this.pool.set(rootfs, parked)
  }

  /** Destroy every parked VM. Called on harness shutdown. */
  async shutdown(): Promise<void> {
    const all: VMHandle[] = []
    for (const parked of this.pool.values()) {
      for (const p of parked) all.push(p.vm)
    }
    this.pool.clear()
    await Promise.all(all.map((vm) => this.backend.destroy(vm).catch(() => {})))
  }

  /** Current parked count, optionally narrowed to one flavor. */
  size(rootfs?: RootfsId): number {
    if (rootfs) return this.pool.get(rootfs)?.length ?? 0
    let total = 0
    for (const p of this.pool.values()) total += p.length
    return total
  }
}
