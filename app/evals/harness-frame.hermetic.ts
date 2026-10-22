/** The eval runner names its tier in a run frame; no live call is made. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeInferenceTier } from '@hames-ai/harness-baml/clients.server'
import '../src/lib/inference/config.server'
import { check, runScenario, type Scenario } from './harness'
import type { EvalRouting } from './client'

const seen: string[] = []
const probe: Scenario = {
  id: 'tier-probe',
  role: 'controller',
  title: 'probe',
  what: 'reads the tier the runner opened',
  run: async () => {
    seen.push(activeInferenceTier())
    return { checks: [check('ran', true, '')] }
  },
}

beforeEach(() => {
  seen.length = 0
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '')
  vi.stubEnv('INFERENCE_TIERS', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('runScenario opens a run frame that names the eval tier', () => {
  // Mutation: call `scenario.run(ctx)` outside `withRunFrame` — the host default
  // (the self-deployed tier) is refused on this unconfigured box, so the
  // baseline row throws instead of answering 'anthropic'.
  it('the declared-chain baseline runs on the Anthropic tier, on an unconfigured box', async () => {
    const baseline: EvalRouting = { routed: [], note: 'baseline' }
    const result = await runScenario(probe, baseline)
    expect(result.error).toBeUndefined()
    expect(seen).toEqual(['anthropic'])
  })

  it('a per-role (tier) run takes the self-deployed tier', async () => {
    vi.stubEnv('LARGE_LLM_BASE_URL', 'https://large.example.invalid/v1')
    vi.stubEnv('LARGE_LLM_API_KEY', 'synthetic-key')
    vi.stubEnv('SMALL_LLM_BASE_URL', 'https://small.example.invalid/v1')
    vi.stubEnv('SMALL_LLM_DECISIONS_URL', 'https://small.example.invalid/v1/systemone')
    vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic-small-key')
    const perRole: EvalRouting = { byRole: { controller: 'LargeQwen' }, routed: [], note: 'tier' }
    const result = await runScenario(probe, perRole)
    expect(result.error).toBeUndefined()
    expect(seen).toEqual(['self_deployed'])
  })
})
