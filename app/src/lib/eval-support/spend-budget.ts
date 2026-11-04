/** Pure ledger shared by the opt-in eval runner and hermetic cap tests. */
export interface SpendKey {
  agent: string
  scenario: string
  tier: 'self_deployed'
}

/** The injection screen's BAML function. general-next's office and info route guards screen
 * external tool results (always after a deterministic finding, otherwise as the screen's mode
 * says); retriever hits and route-output records are not model-screened, so its private-tier
 * time is its own report line. The screen is default-OFF since revision 6 (#938, O35), so
 * this share is non-zero only when a run re-enables it — the share counts it only when
 * it runs. */
export const SCREEN_FUNCTION = 'ScreenUntrustedContent'

/** The injection-ingress-guard classification's ledger line: the Decide call
 * keyed `guard.ingress` (revision 6, slice 17) — one per external payload in
 * `'on'`/`'shadow'`. Matched EXACTLY: the egress gate's `Decide:guard.egress`
 * calls are not the classification's, and file under "other". */
export const INGRESS_FUNCTION = 'Decide:guard.ingress'

/** The ledger name of one observer sample: the BAML function, and for a Decide call its question
 * key, so the classification's calls are not filed with the loop's. */
export function ledgerFunction(functionName?: string, decisionKey?: string): string | undefined {
  return functionName && decisionKey ? `${functionName}:${decisionKey}` : functionName
}

export interface FunctionSpend {
  calls: number
  observerUsd: number
}

export interface SpendRow extends SpendKey {
  /** Per BAML function; sums to `calls` / `observerUsd` below, never added on top. */
  functions: Record<string, FunctionSpend>
  observerUsd: number
  infrastructureUsd: number
  /** Pricing basis of the infrastructure amount retained by the running maximum. */
  infrastructureBasis?: string
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
  readonly tailLines: Array<SpendKey & { box: string; usd: number; basis?: string }> = []
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
  infrastructure(key: SpendKey, elapsedMs: number, eurPerHour: number, basis?: string): void {
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
    const usd = ((elapsedMs / 3_600_000) * eurPerHour) / this.eurPerUsd
    if (usd > row.infrastructureUsd) {
      row.infrastructureUsd = usd
      row.infrastructureBasis = basis
    }
    this.check()
  }

  /** Reserve one scale-down tail per run and another after each long idle gap.
   * Charge before waking, so a tail alone can stop the run. */
  beginInfrastructure(
    key: SpendKey,
    now: number,
    boxes: Array<{ box: string; seconds: number; eurPerHour: number; basis?: string }>,
  ): void {
    for (const { box, seconds, eurPerHour, basis } of boxes) {
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
        this.tailLines.push({ ...key, box, usd, basis })
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

/** The two model steps of the ingress check, against everything else, for one
 * row — the screen's share (counted only when it runs) and the
 * injection-ingress-guard classification's, whose Decide calls are its own
 * line beside the screen's, so a run shows what the classification costs
 * while the screen is off. Shares are of observer cost and of calls;
 * infrastructure and tail lines are scenario time and not attributable. */
export function guardShare(row: Pick<SpendRow, 'functions' | 'calls' | 'observerUsd'>) {
  const screen = row.functions[SCREEN_FUNCTION] ?? { calls: 0, observerUsd: 0 }
  const classification = row.functions[INGRESS_FUNCTION] ?? { calls: 0, observerUsd: 0 }
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0)
  return {
    screenCalls: screen.calls,
    screenObserverUsd: screen.observerUsd,
    classificationCalls: classification.calls,
    classificationObserverUsd: classification.observerUsd,
    otherCalls: row.calls - screen.calls - classification.calls,
    otherObserverUsd: row.observerUsd - screen.observerUsd - classification.observerUsd,
    screenCallShare: share(screen.calls, row.calls),
    screenObserverUsdShare: share(screen.observerUsd, row.observerUsd),
    classificationCallShare: share(classification.calls, row.calls),
    classificationObserverUsdShare: share(classification.observerUsd, row.observerUsd),
  }
}
