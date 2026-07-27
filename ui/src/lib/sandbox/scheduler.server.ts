/**
 * SandboxScheduler — capacity gate for concurrent sandbox attachments.
 *
 * Two caps, both enforced:
 *   - `globalCap`        — total in-flight sandboxes across the harness
 *   - `perSessionCap`    — in-flight sandboxes for any single session
 *
 * `allocate(sessionId)` returns a `Slot` immediately if under both caps;
 * otherwise the caller waits until a release frees space. Release is
 * idempotent — calling it twice is a no-op on the second call (safer for
 * try/finally patterns where the slot might already be released).
 *
 * Orthogonal to `WarmPool`: the scheduler decides *whether* a sandbox may
 * exist right now, not where it comes from. `withSandbox` does
 * `scheduler.allocate(...)` first (blocks on cap), then `pool.acquire(...)`
 * (cold-boot vs. pool hit). See docs/plan/sandbox.md → "Scheduler".
 *
 * Queue fairness: FIFO with skip-on-session-cap. A waiter whose session is
 * still over its per-session cap is passed over so later waiters in *other*
 * sessions aren't blocked behind a noisy neighbor. Strict FIFO (no skip) is
 * safer against pathological starvation but blocks a whole queue behind one
 * over-cap session, which is worse for v0's interactive workloads.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'

assertServerOnImport()

export interface SandboxSchedulerConfig {
  globalCap: number
  perSessionCap: number
}

export interface Slot {
  /** Free the slot. Idempotent — safe to call from try/finally. */
  release(): void
}

interface Pending {
  sessionId: string
  resolve: (slot: Slot) => void
}

export class SandboxScheduler {
  private readonly globalCap: number
  private readonly perSessionCap: number
  private inflightGlobal = 0
  private readonly inflightPerSession = new Map<string, number>()
  private readonly queue: Pending[] = []

  constructor(config: SandboxSchedulerConfig) {
    this.globalCap = config.globalCap
    this.perSessionCap = config.perSessionCap
  }

  /** Acquire a slot, waiting if either cap is reached. */
  async allocate(sessionId: string): Promise<Slot> {
    if (this.canAdmit(sessionId)) {
      return this.grant(sessionId)
    }
    return new Promise<Slot>((resolve) => {
      this.queue.push({ sessionId, resolve })
    })
  }

  /** Total in-flight count (or per-session if `sessionId` provided). */
  inflightCount(sessionId?: string): number {
    if (sessionId === undefined) return this.inflightGlobal
    return this.inflightPerSession.get(sessionId) ?? 0
  }

  /** Number of pending waiters (overall or per-session). */
  queueDepth(sessionId?: string): number {
    if (sessionId === undefined) return this.queue.length
    return this.queue.filter((p) => p.sessionId === sessionId).length
  }

  private canAdmit(sessionId: string): boolean {
    if (this.inflightGlobal >= this.globalCap) return false
    const perSession = this.inflightPerSession.get(sessionId) ?? 0
    if (perSession >= this.perSessionCap) return false
    return true
  }

  private grant(sessionId: string): Slot {
    this.inflightGlobal += 1
    this.inflightPerSession.set(
      sessionId,
      (this.inflightPerSession.get(sessionId) ?? 0) + 1,
    )
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.inflightGlobal -= 1
        const next = (this.inflightPerSession.get(sessionId) ?? 1) - 1
        if (next <= 0) this.inflightPerSession.delete(sessionId)
        else this.inflightPerSession.set(sessionId, next)
        this.drainQueue()
      },
    }
  }

  /**
   * Wake compatible waiters in FIFO order, skipping any whose session is
   * still over its per-session cap. Stops when the global cap is full.
   */
  private drainQueue(): void {
    let i = 0
    while (i < this.queue.length && this.inflightGlobal < this.globalCap) {
      const w = this.queue[i]
      if (this.canAdmit(w.sessionId)) {
        this.queue.splice(i, 1)
        w.resolve(this.grant(w.sessionId))
        // Indices shifted; restart from 0 since previously-skipped waiters
        // remain over-cap unless their session also just released.
        i = 0
      } else {
        i += 1
      }
    }
  }
}
