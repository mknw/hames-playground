/**
 * The consumer's client layer — `defineInferenceClients` (#374, D1).
 *
 * "Own provider or model, SAME prompts" (owner ruling 2026-09-22): a consumer
 * supplies runtime BAML clients through a `ClientRegistry`, maps the roles it
 * wants off the built-in chains, and the composition inside
 * `clientOverrideFor` layers the consumer's client OVER the built-in tier for
 * exactly the mapped roles. `clients-verda.test.ts` pins the built-in tier;
 * this file pins the layer on top of it. Nothing here renders a prompt — every
 * render is offline (`b.request.*`), no socket opened, same hermetic pattern
 * as `verda-body-shape.test.ts`.
 *
 * The five pins, each with the mutation that reddens it (verified, recorded
 * verbatim in the PR body):
 *
 *   P1 — an offline render THROUGH the plug shows the request targeting the
 *        consumer's client (the model id in the rendered body). Mutation: drop
 *        `clientRegistry` from the returned bag → the render does NOT fall to
 *        the chain default, it THROWS at resolve time (`client 'ByoRouter'
 *        not found`, an empty transient registry) — red either way.
 *   P2 — an unmapped role yields `undefined`, so the built-in tier's tests
 *        stay green unchanged (that family's files are byte-identical here).
 *        Mutation: return a bag for every role → this test reds, AND the
 *        built-in tier's own pinned bags would gain a `client` key.
 *   P3 — describe mapped, screen unmapped ⇒ the screen's override is
 *        `undefined` and its render is unchanged (SA-M5 / SD-4). Mutation:
 *        make the plug map `screen` implicitly (follow `describe`) → red.
 *   P4 — definition-time validation: `byRole` naming an undefined client
 *        throws HERE, naming the role and the client. Mutation: remove the
 *        check → the throw moves to call time, as BAML's
 *        "client `Nope` not found" at the first render.
 *   P5 — `AgentDeps.clientOverride` accepts the plug's return value with no
 *        cast. A typecheck-level pin: vitest transpiles without type
 *        checking, so the RED half lives in `pnpm typecheck` (mutation:
 *        widen the deps' role parameter back to `string` → contravariance
 *        fails).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ClientRegistry } from '@boundaryml/baml'

vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  defineInferenceClients,
  activateConsumerClients,
  type ClientOverride,
  type InferenceRole,
} from '@hames/harness-baml/consumer-clients.server'
import {
  clientOverrideFor,
  configureConsumerClients,
  activeConsumerClients,
  configureInferencePolicy,
  resolveClientForRole,
  type BamlRole,
} from '@hames/harness-baml/clients.server'
import type { AgentDeps } from '@hames/agents/types'
/** The offline render's shape — what `b.request.<Fn>` resolves to (the same
 *  loose typing `verda-body-shape.test.ts` uses; the generated request types
 *  are not exported, so naming them would invent members). */
type RenderedRequest = { body: { json(): unknown } }

const ALL_ROLES: BamlRole[] = [
  'controller',
  'planner',
  'critic',
  'compactExecution',
  'router',
  'describe',
  'screen',
]

const BYO_ROUTER = 'ByoRouter'
const BYO_DESCRIBE = 'ByoSummarizer'
const CONSUMER_OPTIONS = {
  model: 'consumer-model-7b',
  base_url: 'https://consumer.example.invalid/v1',
  api_key: 'offline-render-test',
}

/** A one-client registry the router rides. */
function plugRouter(): ClientOverride {
  return defineInferenceClients({
    clients: [{ name: BYO_ROUTER, provider: 'openai-generic', options: CONSUMER_OPTIONS }],
    byRole: { router: BYO_ROUTER },
  })
}

/** The SA-M5 shape: describe re-pointed, screen deliberately not. */
function plugDescribeOnly(): ClientOverride {
  return defineInferenceClients({
    clients: [{ name: BYO_DESCRIBE, provider: 'openai-generic', options: CONSUMER_OPTIONS }],
    byRole: { describe: BYO_DESCRIBE },
  })
}

const ROUTER_MESSAGES = [{ role: 'user', content: 'q' }] as const
const ROUTES = [{ name: 'search', description: 'd' }]

async function renderRouter(bag: Record<string, unknown>): Promise<{ model?: string }> {
  // Import lazily: the jsdom test env only needs the generated client for the
  // offline render, and importing it at module scope drags the whole tree in
  // before the mocks above are in place.
  const { b } = await import('@hames/harness-baml/baml_client')
  const render = await (
    b.request as unknown as Record<string, (...args: unknown[]) => Promise<RenderedRequest>>
  ).Router('q', ROUTES, [...ROUTER_MESSAGES], bag as never)
  return render.body.json() as { model?: string }
}

async function renderScreen(bag: Record<string, unknown>): Promise<{ model?: string }> {
  const { b } = await import('@hames/harness-baml/baml_client')
  const render = await (
    b.request as unknown as Record<string, (...args: unknown[]) => Promise<RenderedRequest>>
  )['ScreenUntrustedContent']('web/fetch', 'fetched page text', bag as never)
  return render.body.json() as { model?: string }
}

// The tier policy is module state (the package-side default is 'anthropic');
// these tests register a verda default directly, the same way the host's
// composition root would, and restore the safe default after each.
function policy(tier: 'anthropic' | 'verda', onPrivateCallStart?: (client: string) => void): void {
  configureInferencePolicy({ defaultTier: () => tier, onPrivateCallStart })
}

let restored: typeof process.env

beforeEach(() => {
  restored = { ...process.env }
  policy('anthropic')
})

afterEach(() => {
  process.env = restored
  // The consumer layer is module state too — clear it, or a later suite in the
  // same worker inherits a routing layer nobody registered.
  configureConsumerClients(undefined)
  policy('anthropic')
})

describe('defineInferenceClients — definition-time validation (P4)', () => {
  it('byRole naming an undefined client throws HERE, naming the role and the client', () => {
    expect(() =>
      defineInferenceClients({
        clients: [{ name: 'real', provider: 'openai-generic', options: {} }],
        byRole: { router: 'Nope' },
      }),
    ).toThrow(/byRole maps role 'router' to client 'Nope', which is not in clients/)
  })

  it('an empty client name throws, naming the entry', () => {
    expect(() =>
      defineInferenceClients({
        clients: [{ name: '  ', provider: 'openai-generic', options: {} }],
        byRole: {},
      }),
    ).toThrow(/client #0 has an empty name/)
  })

  it('an empty provider throws, naming the client', () => {
    expect(() =>
      defineInferenceClients({
        clients: [{ name: 'real', provider: '', options: {} }],
        byRole: {},
      }),
    ).toThrow(/client 'real' has an empty provider/)
  })

  it('a valid config does not throw, and the registry it builds holds the clients', () => {
    const plug = plugRouter()
    expect(plug).toBeTypeOf('function')
    // The registry is built ONCE, at definition — the render pins below prove
    // it resolves; here we prove the returned bag carries THAT instance.
    const bag = plug('router')
    expect(bag?.clientRegistry).toBeInstanceOf(ClientRegistry)
  })
})

describe('the plug — unmapped roles (P2)', () => {
  it('every role the consumer does not map yields undefined', () => {
    const plug = plugDescribeOnly()
    const unmapped = ALL_ROLES.filter((role) => role !== 'describe') as InferenceRole[]
    for (const role of unmapped) {
      expect(plug(role), `role ${role} must stay unmapped`).toBeUndefined()
    }
    expect(plug('describe')?.client).toBe(BYO_DESCRIBE)
  })

  it('unmapped roles keep the built-in behaviour exactly — no bag on the anthropic tier, the built-in tier under a verda default', () => {
    configureConsumerClients(plugDescribeOnly())
    // Anthropic default: no bag at all, for the mapped role OR the unmapped ones.
    expect(clientOverrideFor('controller')).toBeUndefined()
    expect(clientOverrideFor('screen')).toBeUndefined()

    // Verda default: only the MAPPED role moves; the built-in tier applies to
    // every other role unchanged.
    policy('verda')
    expect(clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })
    expect(clientOverrideFor('screen')).toEqual({ client: 'VerdaQwen' })
    expect(clientOverrideFor('describe')).toEqual({
      client: BYO_DESCRIBE,
      clientRegistry: expect.any(ClientRegistry),
    })
    // ...and budgeting follows the client the call actually takes.
    expect(resolveClientForRole('controller')).toBe('VerdaQwen')
    expect(resolveClientForRole('describe')).toBe(BYO_DESCRIBE)
  })
})

describe('the composition seam — consumer over the built-in tier', () => {
  it('a mapped role takes the consumer client OVER the verda tier, and the private-call hook does not fire for it', () => {
    const privateCalls: string[] = []
    policy('verda', (client) => privateCalls.push(client))
    configureConsumerClients(plugRouter())

    // The consumer's client wins over the built-in tier for the mapped role.
    expect(clientOverrideFor('router')).toEqual({
      client: BYO_ROUTER,
      clientRegistry: expect.any(ClientRegistry),
    })
    // The built-in tier applies unchanged to every unmapped role — and the
    // private-call hook fires only for those (the consumer's client is not
    // the private tier and owes nobody a wake).
    expect(clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })
    expect(privateCalls).toEqual(['VerdaQwen'])
    expect(privateCalls).not.toContain(BYO_ROUTER)
  })

  it('with no consumer layer the seam is what it was before — hook included', () => {
    const privateCalls: string[] = []
    policy('verda', (client) => privateCalls.push(client))
    expect(activeConsumerClients()).toBeUndefined()
    expect(clientOverrideFor('controller')).toEqual({ client: 'VerdaQwen' })
    expect(privateCalls).toEqual(['VerdaQwen'])
  })

  it('clearing the layer returns the seam to the built-in tier', () => {
    policy('verda')
    configureConsumerClients(plugRouter())
    expect(resolveClientForRole('router')).toBe(BYO_ROUTER)
    configureConsumerClients(undefined)
    expect(resolveClientForRole('router')).toBe('VerdaQwen')
    expect(clientOverrideFor('router')).toEqual({ client: 'VerdaQwen' })
  })

  it('activateConsumerClients registers the layer (the one-subpath convenience)', () => {
    const plug = plugRouter()
    activateConsumerClients(plug)
    expect(activeConsumerClients()).toBe(plug)
    activateConsumerClients(undefined)
    expect(activeConsumerClients()).toBeUndefined()
  })
})

describe('offline render through the plug (P1)', () => {
  it('the request targets the consumer’s client — the model id in the rendered body', async () => {
    const plug = plugRouter()
    const bag = plug('router')!
    const body = await renderRouter({ ...bag, env: { ANTHROPIC_API_KEY: 'offline-render-test' } })
    expect(body.model).toBe(CONSUMER_OPTIONS.model)
  })

  it('the chain default render is untouched when the consumer bag is absent', async () => {
    // The same render with an empty bag (no override) names the declared
    // chain's primary — the fallback an unmapped role keeps.
    const noOverride = await renderRouter({ env: { ANTHROPIC_API_KEY: 'offline-render-test' } })
    expect(noOverride.model).not.toBe(CONSUMER_OPTIONS.model)
    expect(noOverride.model).toBe('claude-haiku-4-5')
  })
})

describe('SA-M5 / SD-4 — the screen moves only by its own key (P3)', () => {
  it('describe mapped, screen unmapped: the screen’s override stays undefined and its render is unchanged', async () => {
    configureConsumerClients(plugDescribeOnly())
    expect(clientOverrideFor('screen')).toBeUndefined()
    expect(clientOverrideFor('describe')).toBeDefined()

    const withLayer = await renderScreen({ env: { ANTHROPIC_API_KEY: 'offline-render-test' } })
    configureConsumerClients(undefined)
    const withoutLayer = await renderScreen({ env: { ANTHROPIC_API_KEY: 'offline-render-test' } })
    // Identical bodies — the consumer layer never touched the screen.
    expect(withLayer).toEqual(withoutLayer)
    expect(withLayer.model).toBe('claude-haiku-4-5')
  })

  it('mapping screen EXPLICITLY does move it — the mapped role’s render targets the consumer’s client', async () => {
    const plug = defineInferenceClients({
      clients: [{ name: BYO_ROUTER, provider: 'openai-generic', options: CONSUMER_OPTIONS }],
      byRole: { screen: BYO_ROUTER },
    })
    configureConsumerClients(plug)
    expect(clientOverrideFor('screen')).toEqual({
      client: BYO_ROUTER,
      clientRegistry: expect.any(ClientRegistry),
    })
    const body = await renderScreen({
      ...clientOverrideFor('screen'),
      env: { ANTHROPIC_API_KEY: 'offline-render-test' },
    } as Record<string, unknown>)
    expect(body.model).toBe(CONSUMER_OPTIONS.model)
  })
})

describe('the plug drops into the agent deps with no cast (P5 — typecheck pin)', () => {
  it('a defineInferenceClients return value is an AgentDeps.clientOverride', async () => {
    // The assignment below IS the pin: `ClientOverride` is the type
    // `AgentDeps.clientOverride` carries, so this compiles with no cast. The
    // RED half of the pin is a typecheck one (vitest transpiles without
    // checking): widen the deps' role parameter back to `string` and
    // `pnpm typecheck` fails on contravariance.
    const deps: AgentDeps = {
      toolNamespaces: () => undefined,
      clientOverride: plugDescribeOnly(),
    }
    expect(deps.clientOverride?.('describe')?.client).toBe(BYO_DESCRIBE)
    // The app's own feed (the built-in seam, `{ client }` only) still satisfies
    // the same type — the two producers share one bag shape.
    const builtIn: AgentDeps = {
      toolNamespaces: () => undefined,
      clientOverride: (role) => clientOverrideFor(role as BamlRole),
    }
    expect(builtIn.clientOverride?.('describe')).toBeUndefined()
  })
})
