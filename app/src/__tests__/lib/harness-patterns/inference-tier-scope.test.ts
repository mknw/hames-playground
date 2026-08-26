/**
 * The per-user inference-tier switch, at the seam it actually acts on.
 *
 * `clients-verda.test.ts` pins the process-wide flag. This pins what the header
 * control adds on top: a PER-RUN scope, and the guarantee that both of its
 * positions reach the right client override.
 *
 * The failures worth pinning, in the order they would ship:
 *   - a scope that widens OR narrows the role set. The switch must move exactly
 *     the roles `USE_VERDA_INFERENCE` moves, which after the two 2026-08-26
 *     owner decisions is all of them, `screen` included. That was the inverse
 *     until the second decision, and the reason the pin is per-role either way:
 *     a user-facing control is the easiest place for a security control's client
 *     to end up somewhere nobody decided (SA-M5). The two halves are now "the
 *     scope moves the screen too" and "the anthropic position moves it back".
 *   - the `'anthropic'` position failing to *undo* the deployment default. A
 *     user who opts out while `USE_VERDA_INFERENCE=1` must actually leave.
 *   - a scope leaking past its own callback, which would make one user's choice
 *     the next request's routing.
 *   - `'verda'` accepted while the endpoint is unset. The fall-through to
 *     Anthropic that would follow is the one failure this whole route exists to
 *     prevent, and it is no less dangerous for coming from a preference row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import type { BamlRole } from '../../../lib/harness-patterns/clients.server'

const ENV_KEYS = [
  'USE_VERDA_INFERENCE',
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
] as const

/** The roles the map routes — all of them, since 2026-08-26. `router` /
 *  `planner` / `describe` joined on the widening; `screen` on the owner's rule
 *  that no call made under the private tier may be sent to any public AI
 *  provider. */
const ROUTED: BamlRole[] = [
  'controller',
  'critic',
  'compactExecution',
  'router',
  'planner',
  'describe',
  'screen',
]
/** Nothing is held back. Kept as an empty list rather than deleted so a future
 *  exception is added in one place and asserted in both scope positions. */
const UNROUTED: [BamlRole, string][] = []

let saved: Record<string, string | undefined>

/** Endpoint present and shaped correctly, flag NOT set — the preview's normal
 *  deployment posture once the per-user switch exists. */
function configureEndpointOnly(): void {
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
}

async function load() {
  vi.resetModules()
  return await import('../../../lib/harness-patterns/clients.server')
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('runWithInferenceTier — both positions reach the right override', () => {
  beforeEach(configureEndpointOnly)

  it('the verda position routes exactly the mapped roles', async () => {
    const { runWithInferenceTier, clientOverrideFor, resolveClientForRole } = await load()

    await runWithInferenceTier('verda', async () => {
      for (const role of ROUTED) {
        expect(clientOverrideFor(role)).toEqual({ client: 'VerdaQwen' })
        expect(resolveClientForRole(role)).toBe('VerdaQwen')
      }
    })
  })

  it('the verda position moves the injection screen too, and holds nothing back', async () => {
    const { runWithInferenceTier, clientOverrideFor, resolveClientForRole } = await load()

    await runWithInferenceTier('verda', async () => {
      for (const [role, chain] of UNROUTED) {
        expect(clientOverrideFor(role)).toBeUndefined()
        expect(resolveClientForRole(role)).toBe(chain)
      }
      // SA-M5, stated separately because it is the one role whose client is a
      // security decision rather than a routing preference. It used to be
      // asserted as `DescribeAnthropic` here; the owner moved it on 2026-08-26
      // and a user-facing control is exactly where that has to be visible, in
      // both directions, rather than inferred from the map.
      expect(clientOverrideFor('screen')).toEqual({ client: 'VerdaQwen' })
      expect(resolveClientForRole('screen')).toBe('VerdaQwen')
      // Paired with its neighbour on the same BAML chain, which moved a few
      // hours earlier — the two are now on the same side, by two decisions.
      expect(resolveClientForRole('describe')).toBe('VerdaQwen')
    })
  })

  it('the anthropic position adds no override at all', async () => {
    const { runWithInferenceTier, clientOverrideFor } = await load()

    await runWithInferenceTier('anthropic', async () => {
      for (const role of [...ROUTED, ...UNROUTED.map(([r]) => r)]) {
        expect(clientOverrideFor(role)).toBeUndefined()
      }
    })
  })

  it('the anthropic position UNDOES the deployment default', async () => {
    // A user opting out while the process default is Verda is the whole point
    // of the control. A scope that could only widen would silently ignore them.
    process.env.USE_VERDA_INFERENCE = '1'
    const { runWithInferenceTier, clientOverrideFor, activeInferenceTier } = await load()

    expect(activeInferenceTier()).toBe('verda')
    expect(clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })

    await runWithInferenceTier('anthropic', async () => {
      expect(activeInferenceTier()).toBe('anthropic')
      expect(clientOverrideFor('controller')).toBeUndefined()
    })
  })

  it('trims a scoped Verda run against the 131K server window', async () => {
    const { runWithInferenceTier, resolveClientForRole } = await load()
    const { getContextWindow } = await import('../../../lib/harness-patterns/token-budget.server')

    await runWithInferenceTier('verda', async () => {
      expect(getContextWindow(resolveClientForRole('controller'))).toBe(131_072)
      // …including the describe role, which sizes `compactBulkData`'s batches
      // and the retriever's history trim.
      expect(getContextWindow(resolveClientForRole('describe'))).toBe(131_072)
      // …and the screen, which moved on 2026-08-26. This is the half of that
      // move easiest to forget: the guard hands the screen up to 20 000
      // characters of fetched content, so a screen still budgeted for 200K
      // against a 131K server would be the switch working and the control
      // failing on exactly the payload it exists to read.
      expect(getContextWindow(resolveClientForRole('screen'))).toBe(131_072)
    })
  })
})

describe('scope isolation — one user’s choice is not another’s routing', () => {
  beforeEach(configureEndpointOnly)

  it('does not leak past its own callback', async () => {
    const { runWithInferenceTier, clientOverrideFor } = await load()

    await runWithInferenceTier('verda', async () => {
      expect(clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })
    })
    expect(clientOverrideFor('controller')).toBeUndefined()
  })

  it('keeps concurrent runs on their own tier', async () => {
    // Two turns interleaved in one process is the ordinary case for a preview
    // with more than one user; an AsyncLocalStorage that lost its store across
    // an await would cross them.
    const { runWithInferenceTier, clientOverrideFor } = await load()
    const seen: Record<string, unknown> = {}

    await Promise.all([
      runWithInferenceTier('verda', async () => {
        await new Promise((r) => setTimeout(r, 5))
        seen.verda = clientOverrideFor('controller')
      }),
      runWithInferenceTier('anthropic', async () => {
        await new Promise((r) => setTimeout(r, 1))
        seen.anthropic = clientOverrideFor('controller')
      }),
    ])

    expect(seen.verda).toEqual({ client: 'VerdaQwen' })
    expect(seen.anthropic).toBeUndefined()
  })

  it('restores the outer tier after a nested scope', async () => {
    const { runWithInferenceTier, activeInferenceTier } = await load()

    await runWithInferenceTier('verda', async () => {
      await runWithInferenceTier('anthropic', async () => {
        expect(activeInferenceTier()).toBe('anthropic')
      })
      expect(activeInferenceTier()).toBe('verda')
    })
  })
})

describe('the verda position fails closed when the endpoint is unset', () => {
  it('throws instead of opening a scope that would fall through to Anthropic', async () => {
    const { runWithInferenceTier } = await load()
    const ran = vi.fn()

    await expect(runWithInferenceTier('verda', async () => ran())).rejects.toThrow(
      /VERDA_INFERENCE_ENDPOINT and VERDA_INFERENCE_API_KEY/,
    )
    // The callback must not have run at all: the check is before any prompt is
    // built, not after the first call 404s.
    expect(ran).not.toHaveBeenCalled()
  })

  it('rejects a root URL the same way the flag does', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    const { runWithInferenceTier } = await load()

    await expect(runWithInferenceTier('verda', async () => 1)).rejects.toThrow(
      /must be the OpenAI-compatible base URL/,
    )
  })

  it('never blocks the anthropic position — it needs no endpoint', async () => {
    const { runWithInferenceTier, clientOverrideFor } = await load()

    await expect(
      runWithInferenceTier('anthropic', async () => clientOverrideFor('controller')),
    ).resolves.toBeUndefined()
  })
})

describe('verdaConfigured — the non-throwing sibling', () => {
  it('is false with nothing set, and does not throw', async () => {
    const { verdaConfigured } = await load()
    expect(verdaConfigured()).toBe(false)
  })

  it('is true once both values are present and the endpoint is a /v1 base', async () => {
    configureEndpointOnly()
    const { verdaConfigured } = await load()
    expect(verdaConfigured()).toBe(true)
  })

  it('is false for a root URL — offering a tier that throws is worse than hiding it', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/'
    process.env.VERDA_INFERENCE_API_KEY = 'test-key'
    const { verdaConfigured } = await load()
    expect(verdaConfigured()).toBe(false)
  })
})

describe('activeInferenceTier — what runs outside any scope', () => {
  it('is anthropic with no flag, even when the endpoint is configured', async () => {
    // The endpoint being reachable is what makes the tier OFFERABLE to a user;
    // it is deliberately not what re-points background work that has no user.
    configureEndpointOnly()
    const { activeInferenceTier } = await load()
    expect(activeInferenceTier()).toBe('anthropic')
  })

  it('follows USE_VERDA_INFERENCE when it is set', async () => {
    configureEndpointOnly()
    process.env.USE_VERDA_INFERENCE = '1'
    const { activeInferenceTier } = await load()
    expect(activeInferenceTier()).toBe('verda')
  })
})
