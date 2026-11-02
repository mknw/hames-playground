// Provenance pin for the two cold-start fallback estimates: the readings the
// constants name must exist in the measurement table they cite, and the
// constants must be consistent with the readings they claim to be derived
// from. Written from the review of #922 (findings F1, F2); the figures in the
// assertions are the readings recorded in `deploy/modal/README.md`.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
import '../../../lib/inference/config.server'
import {
  COLD_START_FALLBACK_MS,
  SMALL_COLD_START_FALLBACK_MS,
} from '../../../lib/inference/cold-start.server'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8')
const modalReadme = read('../../../../../deploy/modal/README.md')

describe('the 27B restore fallback provenance', () => {
  it('cites readings that exist in the measurement table it names', () => {
    for (const reading of ['11.9', '31.3', '36.2', '62.2', '156.8']) {
      expect(modalReadme, `README records no ${reading} s restore`).toContain(reading)
    }
    expect(COLD_START_FALLBACK_MS).toBeGreaterThanOrEqual(156_800)
    expect(COLD_START_FALLBACK_MS).toBeLessThan(505_000)
  })
})

describe('the small box restore fallback provenance', () => {
  it('obeys the same largest-reading, round-up rule the 27B figure states', () => {
    expect(modalReadme).toContain('31.4 s')
    expect(SMALL_COLD_START_FALLBACK_MS).toBeGreaterThanOrEqual(31_400)
    expect(SMALL_COLD_START_FALLBACK_MS).toBeLessThan(305_000)
  })
})
