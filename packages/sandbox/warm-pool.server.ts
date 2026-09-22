/**
 * WarmPool — pool of pre-booted VMs per rootfs flavor.
 *
 * Acquisition is O(ms) on a hit (return a parked VM); cold-boot via the
 * backend otherwise. Release calls `backend.reset(vm)` and parks the VM if
 * the pool has capacity; otherwise (cap reached or reset failed) destroys
 * it. See docs/plan/sandbox.md → "Warm pool".
 *
 * Pool handoffs are fingerprint-scoped (docs/plan/sandbox.md → channel 3):
 * a parked VM is handed over only to an `acquire` whose posture fingerprint
 * — `tenantId|rootfs|egress` — matches the VM's recorded posture exactly. A
 * mismatch is a pool MISS for that caller (cold-boot with the requested
 * runtime); the mismatched parked VM stays parked for its own fingerprint's
 * next acquire. Without this, an `mcp-only` caller could receive a VM booted
 * with `pypi` egress — network attached, and (per tenant) mounted on another
 * tenant's `/cache` volume — because `native.runtime` survives `reset`.
 *
 * This is a library, not a service: the harness creates one instance and
 * shares it; tests instantiate per-test. No background timers — the host
 * is expected to call `evictIdle` on a cadence (the `withSandbox` wiring
 * sets this up in build-order step 5 wiring, alongside `SandboxScheduler`).
 */

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
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
  /** Posture the VM (still) runs — see `vmFingerprint`. Handover requires an
   *  exact match against the acquire's fingerprint. */
  fingerprint: string
  parkedAt: number
}

/**
 * Posture fingerprint (docs/plan/sandbox.md → channel 3): the exact rule a
 * pool handoff must satisfy — `tenantId|rootfs|egress`. A pool hit MUST match
 * all three; anything else is a miss.
 */
export function runtimeFingerprint(rootfs: RootfsId, runtime: RuntimeConfig): string {
  return `${runtime.tenantId ?? 'default'}|${rootfs}|${runtime.egress ?? 'mcp-only'}`
}

/**
 * The fingerprint a VM actually RUNS, read from the runtime record the
 * booting backend left in `native.runtime` (DockerNative — the same record
 * `reset` re-applies, so it is true across recycle). Absent → the pool
 * cannot vouch for the posture and must not park the VM (see `release`).
 */
function vmFingerprint(vm: VMHandle): string | undefined {
  const runtime = (vm.native as { runtime?: RuntimeConfig }).runtime
  return runtime ? runtimeFingerprint(vm.rootfs, runtime) : undefined
}

export class WarmPool {
  private readonly pool = new Map<RootfsId, ParkedVm[]>()

  constructor(
    private readonly backend: ComputeBackend,
    private readonly config: WarmPoolConfig,
  ) {}

  /**
   * Hit the pool ONLY on an exact fingerprint match (tenantId|rootfs|egress);
   * cold-boot otherwise. A parked VM of a different posture is NOT handed
   * over and NOT destroyed — it stays parked for its own fingerprint's next
   * acquire (a miss for this caller is still an exact-match hit for that one).
   */
  async acquire(rootfs: RootfsId, runtime: RuntimeConfig): Promise<VMHandle> {
    const fingerprint = runtimeFingerprint(rootfs, runtime)
    const parked = this.pool.get(rootfs)
    if (parked) {
      const idx = parked.findIndex((p) => p.fingerprint === fingerprint)
      if (idx !== -1) {
        const [match] = parked.splice(idx, 1)
        if (parked.length === 0) this.pool.delete(rootfs)
        return match.vm
      }
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
    // Park under the posture the VM actually runs (its own native.runtime
    // record — the same record reset re-applied), never under what a caller
    // might claim. A handle with no runtime record is un-vouchable: destroy
    // rather than park, so an unknown posture can never be handed over.
    const fingerprint = vmFingerprint(vm)
    if (!fingerprint) {
      await this.backend.destroy(vm).catch(() => {})
      return
    }
    const cap = this.config.caps[vm.rootfs] ?? 0
    const parked = this.pool.get(vm.rootfs) ?? []
    if (parked.length >= cap) {
      await this.backend.destroy(vm).catch(() => {})
      return
    }
    parked.push({ vm, fingerprint, parkedAt: Date.now() })
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
    const fingerprint = runtimeFingerprint(rootfs, runtime)
    const results = await Promise.allSettled(
      Array.from({ length: target }, () => this.backend.boot(rootfs, runtime)),
    )
    const now = Date.now()
    const parked = this.pool.get(rootfs) ?? []
    for (const r of results) {
      if (r.status === 'fulfilled') {
        // The backend records the boot runtime in native.runtime, so the VM's
        // own fingerprint IS this one; park under the requested runtime's
        // fingerprint directly (identical, no native re-read needed).
        parked.push({ vm: r.value, fingerprint, parkedAt: now })
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
