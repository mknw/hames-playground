/**
 * `configureDecideSecondary` — the operator's naming of the decide role's
 * verbalized secondary (#418 slice T5, coordinator decision G5).
 *
 * The setting moves exactly one thing: the client the `decide` role resolves to
 * on the Anthropic tier. Three properties are the whole point and each is
 * pinned by the mutation that breaks it:
 *
 *   1. POSITIVE tier match — only a run on the Anthropic tier, named
 *      explicitly, takes it. The private tier, an unknown tier and a future
 *      tier all ignore it ("not verda" would extend a public-provider route to
 *      every tier nobody reviewed).
 *   2. ONE source — `resolveClientForRole` (the budget and the transport) and
 *      `clientOverrideFor` (the call) agree for every tier × setting.
 *   3. VALIDATED — a name that is not a decide secondary throws at
 *      configuration, never on a turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  clientOverrideFor,
  configureConsumerClients,
  configureDecideSecondary,
  configureInferencePolicy,
  DECIDE_DEFAULT_CLIENT,
  resolveClientForRole,
  LOGPROB_CLIENTS,
  JEV_CLIENTS,
  VERDA_CLIENT_BY_ROLE,
  type BamlRole,
} from '@hames-ai/harness-baml/clients.server'

const PRIVATE = VERDA_CLIENT_BY_ROLE.decide!

/** The default tier outside a run frame. `'future'` is a tier nobody has
 *  reviewed: the type says two, the wire can say anything (a host typo, a tier
 *  added later), and the setting must not extend to it. */
function tier(t: string): void {
  configureInferencePolicy({ defaultTier: () => t as 'verda' | 'anthropic' })
}

beforeEach(() => {
  tier('anthropic')
  configureDecideSecondary(undefined)
})
afterEach(() => {
  configureDecideSecondary(undefined)
  configureConsumerClients(undefined)
  tier('anthropic')
})

describe('unset — no change from main', () => {
  it('the Anthropic tier resolves to the mirror and routes nothing; the private tier to its 4B', () => {
    expect(resolveClientForRole('decide')).toBe(DECIDE_DEFAULT_CLIENT)
    expect(DECIDE_DEFAULT_CLIENT).toBe('JevDecide')
    expect(clientOverrideFor('decide')).toBeUndefined()
    tier('verda')
    expect(resolveClientForRole('decide')).toBe(PRIVATE)
    expect(clientOverrideFor('decide')).toEqual({ client: PRIVATE })
  })
})

describe('the setting on the Anthropic tier', () => {
  it('re-points the decide role, and the call carries the same client explicitly', () => {
    configureDecideSecondary('DecideAnthropic')
    expect(resolveClientForRole('decide')).toBe('DecideAnthropic')
    expect(clientOverrideFor('decide')).toEqual({ client: 'DecideAnthropic' })
  })

  it('moves no other role', () => {
    configureDecideSecondary('DecideAnthropic')
    const before = (r: BamlRole) => [resolveClientForRole(r), clientOverrideFor(r)]
    configureDecideSecondary(undefined)
    const roles = ['controller', 'router', 'describe', 'screen', 'critic'] as BamlRole[]
    const unset = roles.map(before)
    configureDecideSecondary('DecideAnthropic')
    expect(roles.map(before)).toEqual(unset)
  })

  it('yields to a consumer client the operator registered for the role', () => {
    configureDecideSecondary('DecideAnthropic')
    configureConsumerClients((role) => (role === 'decide' ? { client: 'ByoDecide' } : undefined))
    expect(resolveClientForRole('decide')).toBe('ByoDecide')
    expect(clientOverrideFor('decide')).toEqual({ client: 'ByoDecide' })
  })

  it('names a client no transport claims, so the adapter selects it as verbalized', async () => {
    const { decideTransportFor } = await import('@hames-ai/harness-baml/baml-adapters.server')
    expect(LOGPROB_CLIENTS.has('DecideAnthropic')).toBe(false)
    expect(JEV_CLIENTS.has('DecideAnthropic')).toBe(false)
    expect(decideTransportFor('DecideAnthropic')).toBe('verbalized')
  })
})

describe('the tier match is POSITIVE (G5 condition 1)', () => {
  it('the private tier ignores it: decide still resolves to the 4B and the override still targets it', () => {
    tier('verda')
    configureDecideSecondary('DecideAnthropic')
    expect(resolveClientForRole('decide')).toBe(PRIVATE)
    expect(clientOverrideFor('decide')).toEqual({ client: PRIVATE })
  })

  it('a per-run private frame ignores it even when the process default is the Anthropic tier', async () => {
    configureDecideSecondary('DecideAnthropic')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    await withRunFrame({ inference: { tier: 'verda' } }, async () => {
      expect(resolveClientForRole('decide')).toBe(PRIVATE)
      expect(clientOverrideFor('decide')).toEqual({ client: PRIVATE })
    })
  })

  it('an unknown or future tier ignores it', () => {
    configureDecideSecondary('DecideAnthropic')
    for (const t of ['future', '', 'ANTHROPIC']) {
      tier(t)
      expect(resolveClientForRole('decide'), `tier ${JSON.stringify(t)}`).toBe(
        DECIDE_DEFAULT_CLIENT,
      )
      expect(clientOverrideFor('decide'), `tier ${JSON.stringify(t)}`).toBeUndefined()
    }
  })
})

describe('one source: the resolver and the override agree (G5 condition 2)', () => {
  it.each(['anthropic', 'verda', 'future'])('tier %s, every setting', (t) => {
    tier(t)
    for (const setting of [undefined, 'DecideAnthropic'] as const) {
      configureDecideSecondary(setting)
      // The client a call actually takes: the override when there is one, else
      // the declared default the mirror restates.
      const effective = clientOverrideFor('decide')?.client ?? DECIDE_DEFAULT_CLIENT
      expect(resolveClientForRole('decide'), `${t} / ${setting}`).toBe(effective)
    }
  })
})

describe('validation (G5 condition 3)', () => {
  it.each(['DecideAnthr0pic', 'JevDecide', 'LocalQwenSmallDecide', 'AnthropicSonnet5', ''])(
    'rejects %j at configuration and leaves the setting untouched',
    (name) => {
      configureDecideSecondary('DecideAnthropic')
      expect(() => configureDecideSecondary(name as never)).toThrow(/not a decide secondary/)
      expect(resolveClientForRole('decide')).toBe('DecideAnthropic')
    },
  )

  it('accepts DecideAnthropic and undefined, and undefined clears it', () => {
    expect(() => configureDecideSecondary('DecideAnthropic')).not.toThrow()
    configureDecideSecondary(undefined)
    expect(resolveClientForRole('decide')).toBe(DECIDE_DEFAULT_CLIENT)
  })
})

describe('reachable only when an operator names it', () => {
  it('no role map value names DecideAnthropic: it is not a default, on either tier', async () => {
    const { VERDA_CLIENT_BY_ROLE: v } = await import('@hames-ai/harness-baml/clients.server')
    expect(Object.values(v)).not.toContain('DecideAnthropic')
    expect(DECIDE_DEFAULT_CLIENT).not.toBe('DecideAnthropic')
  })

  it('nothing in app/src outside tests calls configureDecideSecondary or createVerbalizedDecide', () => {
    const root = path.resolve(process.cwd(), 'src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full)
        } else if (/\.(ts|tsx)$/.test(name)) {
          const code = readFileSync(full, 'utf8')
          if (/\b(configureDecideSecondary|createVerbalizedDecide)\s*\(/.test(code)) {
            offenders.push(path.relative(root, full))
          }
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

describe('the verbalized secondary’s own lock is a positive match too', () => {
  it('refuses on an unknown tier before any request, even with a client named', async () => {
    const { createVerbalizedDecide } = await import('@hames-ai/harness-baml/baml-adapters.server')
    configureConsumerClients((role) => (role === 'decide' ? { client: 'ByoDecide' } : undefined))
    tier('future')
    await expect(
      createVerbalizedDecide()({
        spec: {
          key: 'k',
          question: 'q',
          labels: [
            { id: 'a', description: 'a' },
            { id: 'b', description: 'b' },
          ],
        },
        state: 's',
      }),
    ).rejects.toThrow(/outside the Anthropic tier/)
  })
})
