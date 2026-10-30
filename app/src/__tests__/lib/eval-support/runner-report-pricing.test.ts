/** #882 regression: exercise the runner's serializer against a real ledger. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpendBudget } from '../../../lib/eval-support/spend-budget'
import { smallInfraRate } from '../../../lib/eval-support/small-infra.server'
import {
  resetSmallGpuForTests,
  seedSmallGpuForTests,
} from '../../../lib/inference/small-gpu.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const source = readFileSync(resolve('evals/general-next/run.ts'), 'utf8')
const body = /const write = \(\) => \{([\s\S]*?)\n {2}\}\n {2}const tick/.exec(source)?.[1]
const tickBody = /const tick = \(\) => \{([\s\S]*?)\n {2}\}\n {2}const stop/.exec(source)?.[1]
const reserveBody =
  /const small = smallInfraRate\(\)\s*budget\.beginInfrastructure\(active, started, \[([\s\S]*?)\]\)\n {12}if \(budget\.stopped\)/.exec(
    source,
  )?.[1]
const mode = process.env.REVIEW_FIXED_L4
const oldBasis = process.env.REVIEW_OLD_BASIS === '1'
const L4_EUR = (0.8 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15 * 0.86
const A10_EUR = (1.1 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15 * 0.86
const readRate = () =>
  mode === 'seam' ? { ...smallInfraRate(), eurPerHour: L4_EUR } : smallInfraRate()

beforeEach(() => {
  resetSmallGpuForTests()
  vi.stubEnv('SMALL_LLM_EUR_PER_HOUR', undefined as unknown as string)
  vi.stubEnv('SMALL_LLM_EUR_PER_HOUR_A10', undefined as unknown as string)
  vi.stubEnv('EUR_PER_USD', undefined as unknown as string)
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetSmallGpuForTests()
})

function serializedReport(budget: SpendBudget): Record<string, unknown> {
  expect(body).toBeDefined()
  const reportBody = mode === 'runner' ? body!.replaceAll('small.eurPerHour', 'smallRate') : body
  const js = ts.transpileModule(`const write = () => {${reportBody}}; write()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  let serialized = ''
  const key = { agent: 'general-next', scenario: 'count', tier: 'self_deployed' as const }
  runInNewContext(js, {
    smallInfraRate: readRate,
    smallRate: L4_EUR,
    jobs: [{ key }],
    results: [],
    budget,
    live: true,
    picked: [{ id: 'count' }],
    scenarios: [{ id: 'count' }],
    candidate: 'general-next',
    flipGate: () => ({}),
    GENERAL_BASELINE: {},
    openRouterLarge: false,
    cap: 20,
    largeRate: 4,
    file: 'report.json',
    capture: undefined,
    wakeDetail: undefined,
    screenShare: () => ({}),
    writeFileSync: (_path: string, value: string) => {
      serialized = value
    },
  })
  return JSON.parse(serialized) as Record<string, unknown>
}

function reserveRunnerTail(budget: SpendBudget, now: number): void {
  expect(reserveBody).toBeDefined()
  const active = { agent: 'general-next', scenario: 'count', tier: 'self_deployed' as const }
  runInNewContext(
    `const small = smallInfraRate(); budget.beginInfrastructure(active, started, [${reserveBody}])`,
    {
      smallInfraRate: readRate,
      budget,
      active,
      started: now,
      openRouterLarge: true,
      smallScaledownSeconds: () => 600,
    },
  )
}

function tickRunnerFloor(budget: SpendBudget, omitBasis = false): void {
  expect(tickBody).toBeDefined()
  const active = { agent: 'general-next', scenario: 'count', tier: 'self_deployed' as const }
  const body = omitBasis ? tickBody!.replace('small.basis,', '') : tickBody
  runInNewContext(`const tick = () => {${body}}; tick()`, {
    active,
    live: true,
    budget,
    started: 0,
    openRouterLarge: true,
    smallInfraRate: readRate,
    Date: { now: () => 600_000 },
  })
}

it.each([
  ['A10', 'A10', false],
  ['unknown', undefined, false],
  ['unknown then L4', 'L4', true],
] as const)('serialized report explains the %s tail charge', (_case, family, reservedUnknown) => {
  const budget = new SpendBudget(20, 0.86)
  if (family === 'A10') seedSmallGpuForTests('A10')
  const reserved = smallInfraRate()
  reserveRunnerTail(budget, 0)
  if (family === 'L4') seedSmallGpuForTests('L4')
  const report = serializedReport(budget)
  const tail = (report.tailLines as Array<{ usd: number; basis: string }>)[0]
  expect(tail.usd).toBeCloseTo(((600 / 3600) * reserved.eurPerHour) / 0.86, 6)
  expect(tail.basis).toBe(reserved.basis)
  expect(report.smallGpuFamily).toBe(family ?? null)
  expect(report.smallGpuBasis).toContain(family ?? 'not observed')
  if (reservedUnknown) expect(tail.basis).toMatch(/conservative|highest|maximum/i)
})

it('reports each tail basis after an idle gap and retains the basis of the winning floor', () => {
  const budget = new SpendBudget(20, 0.86)
  const unknown = smallInfraRate()
  reserveRunnerTail(budget, 0)
  tickRunnerFloor(budget)
  seedSmallGpuForTests('L4')
  tickRunnerFloor(budget)
  budget.endInfrastructure(0)
  reserveRunnerTail(budget, 601_000)
  const report = serializedReport(budget)
  const tails = report.tailLines as Array<{ usd: number; basis: string }>
  expect(tails.map((tail) => tail.basis)).toEqual([unknown.basis, smallInfraRate().basis])
  expect(tails[0].usd).toBeGreaterThan(tails[1].usd)
  expect(
    (report.results as Array<{ spend: { infrastructureBasis: string } }>)[0].spend
      .infrastructureBasis,
  ).toBe(unknown.basis)
  expect(report.smallGpuFamily).toBe('L4')
})

it('reports the new family when a higher rate overtakes an accrued floor', () => {
  const budget = new SpendBudget(20, 0.86)
  seedSmallGpuForTests('L4')
  const first = smallInfraRate()
  tickRunnerFloor(budget)
  expect(budget.rows[0].infrastructureBasis).toBe(first.basis)
  seedSmallGpuForTests('A10')
  const second = smallInfraRate()
  tickRunnerFloor(budget, oldBasis)
  const report = serializedReport(budget)
  const spend = (
    report.results as Array<{ spend: { infrastructureUsd: number; infrastructureBasis: string } }>
  )[0].spend
  expect(spend.infrastructureUsd).toBeCloseTo(((600 / 3600) * second.eurPerHour) / 0.86, 6)
  expect(spend.infrastructureBasis).toBe(second.basis)
  expect(report.smallGpuFamily).toBe('A10')
})

it('FX override changes EUR rate while the cap converts it back to the same USD reservation', () => {
  vi.stubEnv('EUR_PER_USD', '0.9')
  const rate = smallInfraRate()
  expect(rate.eurPerHour).toBeCloseTo(A10_EUR * (0.9 / 0.86), 6)
  const budget = new SpendBudget(0.3, 0.9)
  budget.beginInfrastructure(
    { agent: 'general-next', scenario: 'count', tier: 'self_deployed' },
    0,
    [{ box: 'small', seconds: 600, eurPerHour: rate.eurPerHour }],
  )
  expect(budget.tailLines[0].usd).toBeCloseTo(((600 / 3600) * A10_EUR) / 0.86, 6)
  expect(budget.stopped).toBe(true)
})

it('serialized totals count one observer sample once beside infrastructure and tail', () => {
  seedSmallGpuForTests('A10')
  const budget = new SpendBudget(20, 0.86)
  const key = { agent: 'general-next', scenario: 'count', tier: 'self_deployed' as const }
  budget.observe(key, { costEur: 0.86 }, 'SmallQwen')
  budget.infrastructure(key, 600_000, A10_EUR)
  budget.beginInfrastructure(key, 0, [{ box: 'small', seconds: 600, eurPerHour: A10_EUR }])
  const report = serializedReport(budget)
  const spend = (report.results as Array<{ spend: { observerUsd: number } }>)[0].spend
  expect(spend.observerUsd).toBe(1)
  expect(report.totalUsd).toBeCloseTo(1 + (2 * (600 / 3600) * A10_EUR) / 0.86, 6)
})

it.each(['A10', 'unknown'] as const)(
  'mutation proof: %s charges cap, floor, tail and report at the high rate',
  (family) => {
    expect(tickBody).toBeDefined()
    expect(reserveBody).toBeDefined()
    if (family === 'A10') seedSmallGpuForTests('A10')
    const budget = new SpendBudget(0.3, 0.86)
    const active = { agent: 'general-next', scenario: 'count', tier: 'self_deployed' as const }
    const reserve =
      mode === 'runner' ? reserveBody!.replaceAll('small.eurPerHour', 'smallRate') : reserveBody
    runInNewContext(
      `const small = smallInfraRate(); budget.beginInfrastructure(active, started, [${reserve}])`,
      {
        smallInfraRate: readRate,
        smallRate: L4_EUR,
        budget,
        active,
        started: 0,
        openRouterLarge: true,
        smallScaledownSeconds: () => 600,
      },
    )
    expect.soft(budget.stopped, 'A10 or unknown tail must trip the 0.24 USD stop').toBe(true)
    expect.soft(budget.tailLines[0].usd).toBeCloseTo(((600 / 3600) * A10_EUR) / 0.86, 6)
    const elapsed = new SpendBudget(20, 0.86)
    const tick =
      mode === 'runner' ? tickBody!.replaceAll('small.eurPerHour', 'smallRate') : tickBody
    runInNewContext(`const tick = () => {${tick}}; tick()`, {
      active,
      live: true,
      budget: elapsed,
      started: Date.now() - 600_000,
      openRouterLarge: true,
      smallInfraRate: readRate,
      smallRate: L4_EUR,
      Date,
    })
    expect
      .soft(elapsed.row(active).infrastructureUsd)
      .toBeCloseTo(((600 / 3600) * A10_EUR) / 0.86, 3)
    const report = serializedReport(budget)
    expect.soft(report.smallEurPerHour).toBeCloseTo(A10_EUR, 6)
    expect.soft(report.smallGpuFamily).toBe(family === 'A10' ? 'A10' : null)
  },
)
