/** Pure ledger shared by the opt-in eval runner and hermetic cap tests. */
export interface SpendKey {
  agent: string
  scenario: string
  tier: 'self_deployed'
}

/** The injection screen's BAML function. general-next's office and info route guards screen
 * their tool results (`screenDespiteFindings` adds results with deterministic findings);
 * retriever hits and route-output records are not model-screened, so its private-tier time is its own report line. */
export const SCREEN_FUNCTION = 'ScreenUntrustedContent'

export interface FunctionSpend {
  calls: number
  observerUsd: number
}

export interface SpendRow extends SpendKey {
  /** Per BAML function; sums to `calls` / `observerUsd` below, never added on top. */
  functions: Record<string, FunctionSpend>
  observerUsd: number
  infrastructureUsd: number
  tailUsd: number
  calls: number
  unknownCost: boolean
}

export function parseSpendCap(raw: string | undefined): number {
  const cap = raw === undefined ? 20 : Number(raw)
  if (!Number.isFinite(cap) || cap <= 0 || cap > 25) {
    throw new Error('EVAL_GENERAL_CAP_USD must be positive and at most 25 (default 20)')
  }
  return cap
}

export class SpendBudget {
  readonly capUsd: number
  readonly stopUsd: number
  readonly rows: SpendRow[] = []
  readonly tailLines: Array<SpendKey & { box: string; usd: number }> = []
  private lastInfrastructureEnd?: number
  reason?: string

  constructor(
    capUsd: number,
    readonly eurPerUsd: number,
  ) {
    this.capUsd = parseSpendCap(String(capUsd))
    this.stopUsd = capUsd * 0.8
    if (!Number.isFinite(eurPerUsd) || eurPerUsd < 0.75 || eurPerUsd > 0.95)
      throw new Error('Invalid EUR per USD')
  }

  get totalUsd(): number {
    return this.rows.reduce(
      (sum, row) => sum + row.observerUsd + row.infrastructureUsd + row.tailUsd,
      0,
    )
  }

  get stopped(): boolean {
    return this.reason !== undefined
  }

  row(key: SpendKey): SpendRow {
    let row = this.rows.find(
      (r) => r.agent === key.agent && r.scenario === key.scenario && r.tier === key.tier,
    )
    if (!row) {
      row = {
        ...key,
        functions: {},
        observerUsd: 0,
        infrastructureUsd: 0,
        tailUsd: 0,
        calls: 0,
        unknownCost: false,
      }
      this.rows.push(row)
    }
    return row
  }

  /** Every observer sample counts, including calls that later fail parsing. */
  observe(
    key: SpendKey,
    metrics: { costEur?: number } | undefined,
    functionName = 'unknown',
  ): void {
    const row = this.row(key)
    row.calls++
    const fn = (row.functions[functionName] ??= { calls: 0, observerUsd: 0 })
    fn.calls++
    const cost = metrics?.costEur
    if (cost === undefined || !Number.isFinite(cost) || cost < 0) {
      row.unknownCost = true
      this.reason = 'Unknown observer cost; refusing further calls'
    } else {
      row.observerUsd += cost / this.eurPerUsd
      fn.observerUsd += cost / this.eurPerUsd
      this.check()
    }
  }

  /** Cumulative private scenario time, including setup/wake, charged ADDITIONALLY
   * to observer cost. Never subtract call-time pricing: this is conservative. */
  infrastructure(key: SpendKey, elapsedMs: number, eurPerHour: number): void {
    if (
      !Number.isFinite(elapsedMs) ||
      elapsedMs < 0 ||
      !Number.isFinite(eurPerHour) ||
      eurPerHour <= 0
    ) {
      this.reason = 'Unknown private infrastructure cost; refusing further calls'
      return
    }
    const row = this.row(key)
    row.infrastructureUsd = Math.max(
      row.infrastructureUsd,
      ((elapsedMs / 3_600_000) * eurPerHour) / this.eurPerUsd,
    )
    this.check()
  }

  /** Reserve one scale-down tail per run and another after each long idle gap.
   * Charge before waking, so a tail alone can stop the run. */
  beginInfrastructure(
    key: SpendKey,
    now: number,
    boxes: Array<{ box: string; seconds: number; eurPerHour: number }>,
  ): void {
    for (const { box, seconds, eurPerHour } of boxes) {
      if (!Number.isFinite(seconds) || seconds <= 0) {
        this.reason = 'Unknown scale-down tail; refusing further calls'
        return
      }
      if (
        this.lastInfrastructureEnd === undefined ||
        now - this.lastInfrastructureEnd > seconds * 1000
      ) {
        const usd = ((seconds / 3600) * eurPerHour) / this.eurPerUsd
        if (!Number.isFinite(usd) || usd <= 0) {
          this.reason = 'Unknown scale-down tail cost; refusing further calls'
          return
        }
        this.row(key).tailUsd += usd
        this.tailLines.push({ ...key, box, usd })
        this.check()
      }
    }
  }

  endInfrastructure(now: number): void {
    this.lastInfrastructureEnd = now
  }

  private check(): void {
    if (!this.stopped && this.totalUsd >= this.stopUsd) {
      this.reason = `Observed spend reached the conservative stop threshold (${this.stopUsd} USD)`
    }
  }
}

export function floorHourlyRate(configured: number, committed: number): number {
  if (!Number.isFinite(configured) || configured <= 0) throw new Error('Invalid hourly rate')
  return Math.max(configured, committed)
}

/** The screen against everything else, for one row. Shares are of observer cost and
 * of calls; infrastructure and tail lines are scenario time and not attributable. */
export function screenShare(row: Pick<SpendRow, 'functions' | 'calls' | 'observerUsd'>) {
  const screen = row.functions[SCREEN_FUNCTION] ?? { calls: 0, observerUsd: 0 }
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0)
  return {
    calls: screen.calls,
    observerUsd: screen.observerUsd,
    otherCalls: row.calls - screen.calls,
    otherObserverUsd: row.observerUsd - screen.observerUsd,
    callShare: share(screen.calls, row.calls),
    observerUsdShare: share(screen.observerUsd, row.observerUsd),
  }
}
