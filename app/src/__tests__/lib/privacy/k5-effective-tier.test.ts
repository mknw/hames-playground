// @vitest-environment node
/**
 * The one tier rule, K5's reader (boundary guards slice 9). The input
 * pseudonymiser used to compare the run frame's RAW tier with `'anthropic'`, so
 * a run that named no tier was pseudonymised whatever routing did with it. It now
 * asks `effectiveTier()` — the answer the tier module registered into core — so K5
 * and routing cannot disagree. Its own file: the registration is process-wide, and
 * `web-pseudonymiser.test.ts` runs the wrapper with no tier module loaded.
 *
 * Mutation: read `currentRunFrame()?.inference?.tier` again — the Anthropic-default
 * rows (an absent tier, an unknown one) run K5 and go red.
 */
import { describe, expect, it, vi } from 'vitest'
import { configureInferencePolicy, type InferenceTier } from '@hames-ai/harness-baml/clients.server'
import { createContext, createScope } from '@hames-ai/harness-patterns/context.server'
import { configurePattern } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import { withPseudonymisedInputs } from '@hames-ai/harness-patterns/patterns/withPseudonymisedInputs.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

const identity = <T>(value: T): T => value

/** Whether K5's host was consulted for a run whose frame carries `tier`. */
async function k5Runs(defaultTier: InferenceTier, tier: string | undefined): Promise<boolean> {
  configureInferencePolicy({ defaultTier: () => defaultTier, assertTierReachable: () => {} })
  const pseudonymise = vi.fn(async () => ({
    apply: identity,
    redact: identity,
    checkLiterals: () => undefined,
    observe: () => undefined,
    check: () => undefined,
  }))
  const wrapped = withPseudonymisedInputs({ pseudonymise })(
    configurePattern('probe', async (scope) => scope),
  )
  await withRunFrame({ inference: tier === undefined ? {} : { tier } }, () =>
    wrapped.fn(createScope('probe', {}), createEventView(createContext('task'))),
  )
  return pseudonymise.mock.calls.length > 0
}

describe('K5 reads the one tier rule, not the raw frame string', () => {
  it.each([
    ['an unfilled frame', undefined],
    ['an empty tier', ''],
  ])('%s on a deployment whose default is the Anthropic tier: no rewrite', async (_n, tier) => {
    expect(await k5Runs('anthropic', tier)).toBe(false)
  })

  it.each([
    ['an unfilled frame', undefined],
    ['an unknown tier', 'future'],
    ['an empty tier', ''],
    ['the self-deployed tier', 'self_deployed'],
  ])('%s on a deployment whose default is the self-deployed tier: rewrites', async (_n, tier) => {
    expect(await k5Runs('self_deployed', tier)).toBe(true)
  })

  // A present but unrecognised tier is never the Anthropic tier (ruling E), whatever
  // the host default is: K5 rewrites. Mutation: default an unknown tier to the host
  // default again and the Anthropic-default row goes red.
  it('an unknown tier on a deployment whose default is the Anthropic tier: rewrites', async () => {
    expect(await k5Runs('anthropic', 'future')).toBe(true)
  })

  it.each(['anthropic', 'self_deployed'] as const)(
    'a frame that names the Anthropic tier is never rewritten (default %s)',
    async (defaultTier) => {
      expect(await k5Runs(defaultTier, 'anthropic')).toBe(false)
    },
  )
})
