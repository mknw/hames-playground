import { describe, expect, it } from 'vitest'
import { SpendBudget, parseSpendCap, type SpendKey } from '../../../lib/eval-support/spend-budget'

const key: SpendKey = { agent: 'general-next', scenario: 'count', tier: 'verda' }

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
    const budget = new SpendBudget(20, 0.5)
    const ran: string[] = []
    for (const scenario of ['one', 'two', 'three']) {
      if (budget.stopped) break
      ran.push(scenario)
      budget.observe({ ...key, scenario }, { costEur: 4 })
    }
    expect(ran).toEqual(['one', 'two'])
    expect(budget.totalUsd).toBe(16)
    expect(budget.reason).toContain('threshold')
  })
  it('records a crossing call in full instead of clipping it to the cap', () => {
    const budget = new SpendBudget(20, 1)
    budget.observe(key, { costEur: 22 })
    expect(budget.totalUsd).toBe(22)
    expect(budget.stopped).toBe(true)
  })
  it('attributes every sample to the scenario and agent, without resetting the run total', () => {
    const budget = new SpendBudget(20, 0.5)
    budget.observe(key, { costEur: 0.5 })
    budget.observe(key, { costEur: 1 })
    budget.observe({ ...key, scenario: 'retry' }, { costEur: 1.5 })
    budget.observe({ ...key, agent: 'general' }, { costEur: 2 })
    expect(budget.rows.map((r) => [r.agent, r.scenario, r.calls, r.observerUsd])).toEqual([
      ['general-next', 'count', 2, 3],
      ['general-next', 'retry', 1, 3],
      ['general', 'count', 1, 4],
    ])
    expect(budget.totalUsd).toBe(10)
  })
  it.each([undefined, {}, { costEur: NaN }, { costEur: Infinity }, { costEur: -0.1 }])(
    'stops on missing or invalid observer cost %j',
    (metrics) => {
      const budget = new SpendBudget(20, 1)
      budget.observe(key, metrics)
      expect(budget.stopped).toBe(true)
      expect(budget.reason).toContain('Unknown observer cost')
      expect(budget.rows[0].unknownCost).toBe(true)
    },
  )
  it('accepts an explicitly reported zero cost', () => {
    const budget = new SpendBudget(20, 1)
    budget.observe(key, { costEur: 0 })
    expect(budget.stopped).toBe(false)
    expect(budget.rows[0].calls).toBe(1)
  })
  it('adds cumulative wall time for both GPU boxes, including wake wait, conservatively', () => {
    const budget = new SpendBudget(20, 0.5)
    budget.observe(key, { costEur: 0.5 })
    budget.infrastructure(key, 1_800_000, 2 + 1)
    budget.infrastructure(key, 3_600_000, 2 + 1)
    budget.infrastructure(key, 1_000, 2 + 1)
    expect(budget.row(key).infrastructureUsd).toBe(6)
    expect(budget.totalUsd).toBe(7)
    budget.infrastructure(key, 9_000_000, 2 + 1)
    expect(budget.totalUsd).toBe(16)
    expect(budget.stopped).toBe(true)
  })
  it.each([
    [NaN, 1],
    [-1, 1],
    [1, 0],
    [1, Infinity],
  ])('fails closed on invalid infrastructure inputs', (ms, rate) => {
    const budget = new SpendBudget(20, 1)
    budget.infrastructure(key, ms, rate)
    expect(budget.stopped).toBe(true)
  })
})
