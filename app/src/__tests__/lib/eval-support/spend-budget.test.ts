import { describe, expect, it } from 'vitest'
import {
  SpendBudget,
  parseSpendCap,
  floorHourlyRate,
  screenShare,
  SCREEN_FUNCTION,
  GATE_FUNCTION_PREFIX,
  ledgerFunction,
  type SpendKey,
} from '../../../lib/eval-support/spend-budget'

const key: SpendKey = { agent: 'general-next', scenario: 'count', tier: 'self_deployed' }

describe('eval spend budget (hermetic, no provider calls)', () => {
  it('defaults to 20 and accepts the absolute ceiling of 25', () => {
    expect(parseSpendCap(undefined)).toBe(20)
    expect(parseSpendCap('25')).toBe(25)
    expect(new SpendBudget(20, 0.8).stopUsd).toBe(16)
  })
  it.each(['25.01', '26', '0', '-1', '', 'NaN', 'Infinity', 'garbage'])(
    'refuses invalid cap %s',
    (value) => {
      expect(() => parseSpendCap(value)).toThrow('at most 25')
    },
  )
  it.each([0, -1, NaN, Infinity])('refuses invalid conversion rate %s', (rate) => {
    expect(() => new SpendBudget(20, rate)).toThrow('EUR per USD')
  })
  it('stops exactly at 80% of the cap, before another scenario can start', () => {
    const budget = new SpendBudget(20, 0.8)
    const ran: string[] = []
    for (const scenario of ['one', 'two', 'three']) {
      if (budget.stopped) break
      ran.push(scenario)
      budget.observe({ ...key, scenario }, { costEur: 6.4 })
    }
    expect(ran).toEqual(['one', 'two'])
    expect(budget.totalUsd).toBe(16)
    expect(budget.reason).toContain('threshold')
  })
  it('records a crossing call in full instead of clipping it to the cap', () => {
    const budget = new SpendBudget(20, 0.8)
    budget.observe(key, { costEur: 17.6 })
    expect(budget.totalUsd).toBe(22)
    expect(budget.stopped).toBe(true)
  })
  it('attributes every sample to the scenario and agent, without resetting the run total', () => {
    const budget = new SpendBudget(20, 0.8)
    budget.observe(key, { costEur: 0.8 })
    budget.observe(key, { costEur: 1.6 })
    budget.observe({ ...key, scenario: 'retry' }, { costEur: 2.4 })
    budget.observe({ ...key, agent: 'general' }, { costEur: 3.2 })
    expect(budget.rows.map((r) => [r.agent, r.scenario, r.calls, r.observerUsd])).toEqual([
      ['general-next', 'count', 2, 3],
      ['general-next', 'retry', 1, expect.closeTo(3)],
      ['general', 'count', 1, 4],
    ])
    expect(budget.totalUsd).toBe(10)
  })
  it.each([undefined, {}, { costEur: NaN }, { costEur: Infinity }, { costEur: -0.1 }])(
    'stops on missing or invalid observer cost %j',
    (metrics) => {
      const budget = new SpendBudget(20, 0.8)
      budget.observe(key, metrics)
      expect(budget.stopped).toBe(true)
      expect(budget.reason).toContain('Unknown observer cost')
      expect(budget.rows[0].unknownCost).toBe(true)
    },
  )
  it('accepts an explicitly reported zero cost', () => {
    const budget = new SpendBudget(20, 0.8)
    budget.observe(key, { costEur: 0 })
    expect(budget.stopped).toBe(false)
    expect(budget.rows[0].calls).toBe(1)
  })
  it('adds cumulative wall time for both GPU boxes, including wake wait, conservatively', () => {
    const budget = new SpendBudget(20, 0.8)
    budget.observe(key, { costEur: 0.8 })
    budget.infrastructure(key, 1_800_000, 3.2 + 1.6)
    budget.infrastructure(key, 3_600_000, 3.2 + 1.6)
    budget.infrastructure(key, 1_000, 3.2 + 1.6)
    expect(budget.row(key).infrastructureUsd).toBeCloseTo(6)
    expect(budget.totalUsd).toBeCloseTo(7)
    budget.infrastructure(key, 9_000_000, 3.2 + 1.6)
    expect(budget.totalUsd).toBe(16)
    expect(budget.stopped).toBe(true)
  })
  it.each([
    [NaN, 1],
    [-1, 1],
    [1, 0],
    [1, Infinity],
  ])('fails closed on invalid infrastructure inputs', (ms, rate) => {
    const budget = new SpendBudget(20, 0.8)
    budget.infrastructure(key, ms, rate)
    expect(budget.stopped).toBe(true)
  })
})

describe('rates and scale-down reservations', () => {
  it.each([0.5, 1, 1.16, 86, 0.74, 0.96])('refuses implausible EUR/USD %s', (rate) => {
    expect(() => new SpendBudget(20, rate)).toThrow('EUR per USD')
  })
  it('floors both hourly rates at their committed defaults', () => {
    expect(floorHourlyRate(0.1819, 1.819)).toBe(1.819)
    expect(floorHourlyRate(0.154, 1.54)).toBe(1.54)
    expect(floorHourlyRate(4, 1.54)).toBe(4)
    expect(() => floorHourlyRate(NaN, 1.54)).toThrow()
  })
  it('reserves one tail per box per run, and after idle gaps longer than its window', () => {
    const b = new SpendBudget(20, 0.8)
    const boxes = [
      { box: 'self_deployed', seconds: 300, eurPerHour: 1.819 },
      { box: 'small', seconds: 120, eurPerHour: 1.54 },
    ]
    b.beginInfrastructure(key, 0, boxes)
    expect(b.tailLines.map((t) => t.box)).toEqual(['self_deployed', 'small'])
    expect(b.totalUsd).toBeCloseTo((300 * 1.819 + 120 * 1.54) / 3600 / 0.8)
    b.endInfrastructure(1000)
    b.beginInfrastructure(key, 121000, boxes)
    expect(b.tailLines).toHaveLength(2)
    b.beginInfrastructure(key, 121001, boxes)
    expect(b.tailLines.map((t) => t.box)).toEqual(['self_deployed', 'small', 'small'])
    b.endInfrastructure(122000)
    b.beginInfrastructure(key, 423000, boxes)
    expect(b.tailLines.map((t) => t.box)).toEqual([
      'self_deployed',
      'small',
      'small',
      'self_deployed',
      'small',
    ])
    const tiny = new SpendBudget(0.01, 0.8)
    tiny.beginInfrastructure(key, 0, boxes)
    expect(tiny.stopped).toBe(true)
  })
  it('refuses unknown tail inputs', () => {
    for (const box of [
      { box: 'x', seconds: NaN, eurPerHour: 1 },
      { box: 'x', seconds: 1, eurPerHour: NaN },
    ]) {
      const b = new SpendBudget(20, 0.8)
      b.beginInfrastructure(key, 0, [box])
      expect(b.stopped).toBe(true)
    }
  })
})

describe('per-function screen subtotal', () => {
  const fill = () => {
    const budget = new SpendBudget(20, 0.8)
    budget.observe(key, { costEur: 0.08 }, 'LoopController')
    budget.observe(key, { costEur: 0.04 }, SCREEN_FUNCTION)
    budget.observe(key, { costEur: 0.04 }, SCREEN_FUNCTION)
    budget.observe(key, { costEur: 0.04 }, 'Synthesize')
    return budget
  }
  it('splits calls and cost by BAML function without changing the totals', () => {
    const row = fill().row(key)
    expect(row.calls).toBe(4)
    expect(row.functions[SCREEN_FUNCTION].calls).toBe(2)
    expect(row.functions[SCREEN_FUNCTION].observerUsd).toBeCloseTo(0.1)
    expect(row.observerUsd).toBeCloseTo(0.25)
    expect(Object.values(row.functions).reduce((n, f) => n + f.calls, 0)).toBe(row.calls)
  })
  it('reports the screen against everything else, per row', () => {
    const share = screenShare(fill().row(key))
    expect(share).toMatchObject({ calls: 2, otherCalls: 2 })
    expect(share.callShare).toBeCloseTo(0.5)
    expect(share.observerUsd).toBeCloseTo(0.1)
    expect(share.otherObserverUsd).toBeCloseTo(0.15)
    expect(share.observerUsdShare).toBeCloseTo(0.4)
  })
  it('is zero, not NaN, for a row with no screen call or no spend', () => {
    expect(screenShare(new SpendBudget(20, 0.8).row(key))).toMatchObject({
      calls: 0,
      callShare: 0,
      observerUsdShare: 0,
    })
  })
  it('files a sample with no function name under unknown, never under the screen', () => {
    const budget = new SpendBudget(20, 0.8)
    budget.observe(key, { costEur: 0.01 })
    expect(screenShare(budget.row(key)).calls).toBe(0)
    expect(budget.row(key).functions.unknown.calls).toBe(1)
  })
  // Boundary guards slice 3. MUTATION: drop the gate's prefix match in
  // `screenShare` (count gate calls as "other"): the gate share reads 0 and
  // `otherCalls` swallows it.
  it('reports the guard gate (Decide calls keyed guard.*) on its own line, apart from the loop', () => {
    const budget = fill()
    budget.observe(key, { costEur: 0.008 }, ledgerFunction('Decide', 'guard.screen'))
    budget.observe(key, { costEur: 0.008 }, ledgerFunction('Decide', 'guard.screen'))
    budget.observe(key, { costEur: 0.008 }, ledgerFunction('Decide', 'next_step'))
    const share = screenShare(budget.row(key))
    expect(share).toMatchObject({ calls: 2, gateCalls: 2, otherCalls: 3 })
    expect(share.gateObserverUsd).toBeCloseTo(0.02)
    expect(share.gateCallShare).toBeCloseTo(2 / 7)
    expect(budget.row(key).functions['Decide:next_step'].calls).toBe(1)
  })
  it('names a ledger line by function, and a Decide line by its question key too', () => {
    expect(ledgerFunction('Decide', 'guard.screen')).toBe(`${GATE_FUNCTION_PREFIX}screen`)
    expect(ledgerFunction('LoopController')).toBe('LoopController')
    expect(ledgerFunction(undefined, 'guard.screen')).toBeUndefined()
  })
  it('still counts a screen call of unknown cost, and stops the run on it', () => {
    const budget = new SpendBudget(20, 0.8)
    budget.observe(key, undefined, SCREEN_FUNCTION)
    expect(budget.stopped).toBe(true)
    expect(screenShare(budget.row(key)).calls).toBe(1)
  })
})
