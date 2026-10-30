/**
 * #882: the eval runner's small-box rate follows the served GPU family —
 * hermetically, through the production seam and the real ledger.
 *
 * The defect these pin: a rate captured once, before the wake, at the L4 base,
 * understated every A10 tail and elapsed charge. The drive below puts each
 * family (L4, A10, unknown) through the runner's real charge sequence —
 * cap reservation before the wake, elapsed floor, a second tail after an
 * idle gap, and the report basis — against the real `SpendBudget` and the
 * real GPU-aware seam. No runner import (nothing under src/ may import
 * evals/); the runner's charge sites are pinned in `runner-wiring.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import { smallInfraRate } from '../../../lib/eval-support/small-infra.server'
import { SpendBudget, type SpendKey } from '../../../lib/eval-support/spend-budget'
import {
  SMALL_GPU_SAMPLE_TTL_MS,
  resetSmallGpuForTests,
  seedSmallGpuForTests,
} from '../../../lib/inference/small-gpu.server'

/** Independent full-container arithmetic from the 2026-10-30 Modal list
 * prices (GPU + 2 cores + 24 GiB, broad eu, EUR at the static 0.86) — the
 * same derivation `modal-pricing.ts` encodes, not a copy of its output. */
const L4_USD = (0.8 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15
const A10_USD = (1.1 + 2 * 0.0000131 * 3600 + 24 * 0.00000222 * 3600) * 1.15
const L4_EUR = L4_USD * 0.86
const A10_EUR = A10_USD * 0.86

const key: SpendKey = { agent: 'general-next', scenario: 'count', tier: 'self_deployed' }

/** What the runner's 600s small tail (or 600s of elapsed time) charges, in USD. */
const usd = (eurPerHour: number) => ((600 / 3600) * eurPerHour) / 0.86

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

describe('smallInfraRate prices the served family and states its basis', () => {
  it.each([
    ['L4', L4_EUR],
    ['A10', A10_EUR],
  ] as const)("a served %s prices at that family's full-container rate", (family, expected) => {
    seedSmallGpuForTests(family)
    const small = smallInfraRate()
    expect(small.family).toBe(family)
    expect(small.eurPerHour).toBeCloseTo(expected, 6)
    expect(small.basis).toContain(family)
  })

  it('an unobserved GPU prices at the HIGHEST supported-family rate, never silently the L4 base', () => {
    const small = smallInfraRate()
    expect(small.family).toBeNull()
    expect(small.eurPerHour).toBeCloseTo(A10_EUR, 6)
    expect(small.basis).toContain('not observed')
  })

  it("a stale sample prices as unobserved — never as the previous container's family", () => {
    // Seeded L4, past its TTL: the honest answer is the conservative maximum,
    // not the dead container's cheaper family.
    seedSmallGpuForTests('L4', Date.now() - SMALL_GPU_SAMPLE_TTL_MS - 1)
    const small = smallInfraRate()
    expect(small.family).toBeNull()
    expect(small.eurPerHour).toBeCloseTo(A10_EUR, 6)
  })
})

describe("the runner's charge sequence, driven per family through the real ledger", () => {
  // The #882 defect in one cap: a 600s small tail alone crosses a 0.3 cap's
  // 0.24 stop threshold at the A10 rate (0.266 USD) and does not at the L4
  // rate (0.208 USD). A runner still priced at the captured L4 base would
  // have waved an A10-boxed run through the cap — this row is what the fix
  // is for.
  // MUTATION: make the seam return the fixed L4 base for every family → the
  // A10 and unknown rows redden on `stopped` (their tails no longer trip the
  // cap) and on every rate assertion below.
  it.each([
    ['L4', L4_EUR, false],
    ['A10', A10_EUR, true],
    [undefined, A10_EUR, true],
  ] as const)(
    '%s family: tail reserves at that rate, elapsed charges it, a second idle tail re-prices it',
    (family, expectedEur, tailStops) => {
      if (family !== undefined) seedSmallGpuForTests(family)
      const small = smallInfraRate()

      // Cap reservation BEFORE the wake (no sample means unknown, and unknown
      // means conservative) — a tail alone can stop the run at this rate.
      const reserve = new SpendBudget(0.3, 0.86)
      reserve.beginInfrastructure(key, 0, [
        { box: 'small', seconds: 600, eurPerHour: small.eurPerHour },
      ])
      expect(
        reserve.stopped,
        `${family}: a 600s tail at ${small.eurPerHour} EUR/h must ${tailStops ? '' : 'not '}cross the 0.24 stop threshold`,
      ).toBe(tailStops)
      expect(reserve.tailLines[0].usd).toBeCloseTo(usd(expectedEur), 6)

      // Elapsed floor at the same rate, charged additionally to observer cost
      // (the documented deliberate overcount — nothing here adds the observer
      // a second time).
      const elapsed = new SpendBudget(20, 0.86)
      elapsed.infrastructure(key, 600_000, small.eurPerHour)
      expect(elapsed.row(key).infrastructureUsd).toBeCloseTo(usd(expectedEur), 6)

      // A second tail after an idle gap longer than the box window.
      reserve.endInfrastructure(0)
      reserve.beginInfrastructure(key, 601_000, [
        { box: 'small', seconds: 600, eurPerHour: small.eurPerHour },
      ])
      expect(reserve.tailLines).toHaveLength(2)
      expect(reserve.totalUsd).toBeCloseTo(2 * usd(expectedEur), 6)
    },
  )
})

describe('rate overrides flow through the seam, floored at the committed default', () => {
  it('a changed L4 base moves the L4 rate and the derived A10 rate with it', () => {
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR', '2')
    seedSmallGpuForTests('L4')
    expect(smallInfraRate().eurPerHour).toBe(2)
    seedSmallGpuForTests('A10')
    expect(smallInfraRate().eurPerHour).toBeCloseTo(2 * (A10_USD / L4_USD), 6)
  })

  it('the per-family override wins, and the unknown-family reservation follows the highest', () => {
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR_A10', '5')
    seedSmallGpuForTests('A10')
    expect(smallInfraRate().eurPerHour).toBe(5)
    // Unknown → highest supported family, which the override just raised.
    resetSmallGpuForTests()
    const unknown = smallInfraRate()
    expect(unknown.family).toBeNull()
    expect(unknown.eurPerHour).toBe(5)
  })

  it('a below-default override is floored at the committed default, never understating', () => {
    vi.stubEnv('SMALL_LLM_EUR_PER_HOUR', '0.5')
    seedSmallGpuForTests('L4')
    expect(smallInfraRate().eurPerHour).toBeCloseTo(L4_EUR, 6)
  })
})
