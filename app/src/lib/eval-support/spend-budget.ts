/** Pure ledger shared by the opt-in eval runner and hermetic cap tests. */
export interface SpendKey {
  agent: string
  scenario: string
  tier: 'verda'
}

export interface SpendRow extends SpendKey {
  observerUsd: number
  infrastructureUsd: number
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
  reason?: string

  constructor(
    capUsd: number,
    readonly eurPerUsd: number,
  ) {
    this.capUsd = parseSpendCap(String(capUsd))
    this.stopUsd = capUsd * 0.8
    if (!Number.isFinite(eurPerUsd) || eurPerUsd <= 0) throw new Error('Invalid EUR per USD')
  }

  get totalUsd(): number {
    return this.rows.reduce((sum, row) => sum + row.observerUsd + row.infrastructureUsd, 0)
  }

  get stopped(): boolean {
    return this.reason !== undefined
  }

  row(key: SpendKey): SpendRow {
    let row = this.rows.find(
      (r) => r.agent === key.agent && r.scenario === key.scenario && r.tier === key.tier,
    )
    if (!row) {
      row = { ...key, observerUsd: 0, infrastructureUsd: 0, calls: 0, unknownCost: false }
      this.rows.push(row)
    }
    return row
  }

  /** Every observer sample counts, including calls that later fail parsing. */
  observe(key: SpendKey, metrics: { costEur?: number } | undefined): void {
    const row = this.row(key)
    row.calls++
    const cost = metrics?.costEur
    if (cost === undefined || !Number.isFinite(cost) || cost < 0) {
      row.unknownCost = true
      this.reason = 'Unknown observer cost; refusing further calls'
    } else {
      row.observerUsd += cost / this.eurPerUsd
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

  private check(): void {
    if (!this.stopped && this.totalUsd >= this.stopUsd) {
      this.reason = `Observed spend reached the conservative stop threshold (${this.stopUsd} USD)`
    }
  }
}
