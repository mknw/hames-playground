// @vitest-environment node
/** Slice 15: an explicitly composed K5 runs on every tier, including a host's
 * Anthropic default. MUTATION: restore the exact-Anthropic skip. */
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

describe('K5 has no tier skip', () => {
  it.each(['anthropic', 'self_deployed'] as const)(
    'runs under host default %s',
    async (defaultTier) => {
      for (const tier of [undefined, '', 'future', 'anthropic', 'self_deployed']) {
        expect(await k5Runs(defaultTier, tier), `frame tier ${tier}`).toBe(true)
      }
    },
  )
})
