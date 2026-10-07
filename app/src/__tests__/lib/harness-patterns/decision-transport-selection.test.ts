/**
 * `decision-transport-selection` (F1, #418 slice T3) — the adapter resolves the
 * role's client FIRST and picks the transport by the CLIENT, never by the tier.
 *
 *   resolved client           transport
 *   ─────────────────────     ───────────────────────────────────────────────
 *   ∈ LOGPROB_CLIENTS         the BAML `Decide` readout
 *   ∈ JEV_CLIENTS             the Jev REST adapter (`jev-decide.server.ts`, slice T4)
 *   anything else             the injected verbalized secondary (slice T5)
 *
 * The throw rule is therefore NARROW: a client CLAIMED logprob-capable whose
 * response carries no logprobs throws; nothing else can make a logprob check
 * throw, and the Anthropic tier can never reach one. These tests pin both halves
 * against a counting fake server, so "never calls `Decide`" is a statement about
 * requests that were not made, not about a mock that was not invoked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

import '../../../lib/inference/config.server'
import type { DecideFn } from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const FIXTURES = path.resolve(process.cwd(), 'src/__tests__/fixtures/decide')
const readFixture = (name: string) =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')).response

const SPEC = {
  key: 'route',
  question: 'Which route?',
  labels: [
    { id: 'search', description: 'look something up' },
    { id: 'chat', description: 'just talk' },
  ],
} as const

/** A verbalized secondary that records it was used. Never calibrated, by construction. */
const verbalizedStub = vi.fn(async () => ({
  probs: { search: 0.7, chat: 0.3 },
  method: 'verbalized' as const,
  calibrated: false,
}))

let server: Server
let requests = 0
let reply: unknown = readFixture('llamacpp-confident')

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.SMALL_LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  process.env.SMALL_LLM_API_KEY = 'local'
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'unused'
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
afterEach(() => {
  verbalizedStub.mockClear()
  requests = 0
  reply = readFixture('llamacpp-confident')
})

async function onPrivateTier<T>(fn: () => Promise<T>): Promise<T> {
  const clients = await import('@hames-ai/harness-baml/clients.server')
  const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  clients.assertInferenceTier('verda')
  return withRunFrame({ inference: { tier: 'verda' } }, fn)
}

describe('the selection table (by the resolved client)', () => {
  it('a LOGPROB_CLIENTS member is read for logprobs; the private tier’s decide client is one', async () => {
    const { decideTransportFor } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { LOGPROB_CLIENTS, VERDA_CLIENT_BY_ROLE } =
      await import('@hames-ai/harness-baml/clients.server')
    expect(decideTransportFor('LocalQwenSmallDecide')).toBe('logprob')
    expect(LOGPROB_CLIENTS.has(VERDA_CLIENT_BY_ROLE.decide!)).toBe(true)
  })

  it('a JEV_CLIENTS member selects the Jev transport; the Anthropic tier’s decide client is one', async () => {
    const { decideTransportFor } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const { JEV_CLIENTS, resolveClientForRole } =
      await import('@hames-ai/harness-baml/clients.server')
    expect([...JEV_CLIENTS]).toEqual(['JevDecide'])
    expect(JEV_CLIENTS.has(resolveClientForRole('decide'))).toBe(true)
    expect(decideTransportFor('JevDecide')).toBe('jev')
  })

  it.each(['AnthropicHaiku45', 'VerdaQwen', 'LocalQwenSmall', 'whatever'])(
    'any other client (%s) is verbalized — a chat model cannot be read for a distribution',
    async (client) => {
      const { decideTransportFor } = await import('@hames-ai/harness-baml/baml-adapters.server')
      expect(decideTransportFor(client)).toBe('verbalized')
    },
  )
})

describe('a non-logprob client never calls `Decide` and never throws a logprob error', () => {
  // The Anthropic tier's own client is Jev (T4), so a verbalized read is reached
  // by a consumer layer naming a chat client for the role.
  beforeEach(async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients((role) =>
      role === 'decide' ? { client: 'AnthropicHaiku45' } : undefined,
    )
  })
  afterEach(async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients(undefined)
  })

  it('the Anthropic tier (no frame) takes the verbalized secondary: calibrated false, zero requests', async () => {
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.method).toBe('verbalized')
    expect(r.calibrated).toBe(false)
    expect(verbalizedStub).toHaveBeenCalledTimes(1)
    expect(requests).toBe(0)
  })

  it('with no verbalized secondary wired it rejects with an LLMCallError — never a silent downgrade', async () => {
    const { createDecideAdapter, LLMCallError } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter()
    const err = await decide({ spec: SPEC, state: 's' }).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/no decide transport for client AnthropicHaiku45/i)
    expect(String(err.message)).toMatch(/rather than downgrading/)
    // Not the logprob throw, and nothing was sent anywhere.
    expect(String(err.message)).not.toMatch(/top_logprobs/)
    expect(requests).toBe(0)
  })
})

describe('the narrow throw: a CLAIMED logprob client that returns no logprobs', () => {
  it('throws an LLMCallError naming the missing logprobs, and stamps hitOutputCap false', async () => {
    reply = readFixture('no-logprobs')
    const { createDecideAdapter, LLMCallError } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
    const err = await onPrivateTier(() => decide({ spec: SPEC, state: 's' })).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/carried no top_logprobs/)
    expect(err.llmCall.hitOutputCap).toBe(false)
    // It reached the server (that is how it learned there were no logprobs) …
    expect(requests).toBe(1)
    // … and did NOT fall through to the verbalized secondary to cover for it.
    expect(verbalizedStub).not.toHaveBeenCalled()
  })

  it('treats an empty logprobs window the same way', async () => {
    reply = {
      ...readFixture('llamacpp-confident'),
      choices: [
        {
          index: 0,
          finish_reason: 'length',
          message: { role: 'assistant', content: 'A' },
          logprobs: { content: [] },
        },
      ],
    }
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter()
    await expect(onPrivateTier(() => decide({ spec: SPEC, state: 's' }))).rejects.toThrow(
      /carried no top_logprobs/,
    )
  })
})

// ----------------------------------------------------------------------------
// #504 review: selection is by the CLIENT, one resolver, and the private tier
// locks every non-logprob transport.
// ----------------------------------------------------------------------------

describe('by the client, never by the tier (review findings 1, 2, 5)', () => {
  afterEach(async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients(undefined)
  })

  it('P2 — on the Anthropic tier a consumer client in LOGPROB_CLIENTS is read for logprobs', async () => {
    // The tier is "anthropic" (no frame) and the mirror says JevDecide, which
    // would be verbalized. A consumer layer names the logprob client for the
    // role; selection follows the CLIENT. Selection by tier would refuse or
    // verbalize here (mutation O7).
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients((role) =>
      role === 'decide' ? { client: 'LocalQwenSmallDecide' } : undefined,
    )
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
    const r = await decide({ spec: SPEC, state: 's' })
    expect(r.method).toBe('logprob')
    expect(requests).toBe(1)
    expect(verbalizedStub).not.toHaveBeenCalled()
  })

  it('P1 — a per-run clientOverride is seen by the resolver: a non-logprob client sends ZERO requests', async () => {
    // Before the fix `resolveClientForRole` skipped the run frame's per-run slot,
    // so selection said `LocalQwenSmallDecide` (logprob) while `b.Decide` was
    // routed to the plugged client — a request WAS sent and the guard then
    // misdiagnosed it. One resolver: the plugged client decides the transport,
    // and a private-tier frame refuses a non-logprob one (finding 3) before any
    // request.
    const clients = await import('@hames-ai/harness-baml/clients.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    clients.assertInferenceTier('verda')
    const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
    await expect(
      withRunFrame(
        {
          inference: {
            tier: 'verda',
            clientOverride: (role) =>
              role === 'decide' ? { client: 'LocalQwenSmall' } : undefined,
          },
        },
        () => decide({ spec: SPEC, state: 's' }),
      ),
    ).rejects.toThrow(/Refusing decide transport "verbalized"/)
    expect(requests).toBe(0)
    expect(verbalizedStub).not.toHaveBeenCalled()
    // The resolver itself reports the plugged client (the root cause).
    await withRunFrame(
      {
        inference: {
          tier: 'verda',
          clientOverride: (role) => (role === 'decide' ? { client: 'LocalQwenSmall' } : undefined),
        },
      },
      async () => expect(clients.resolveClientForRole('decide')).toBe('LocalQwenSmall'),
    )
  })

  it('O1 — the served client is checked after the call, not only the resolved one', async () => {
    // Force the two to disagree: the resolver (spied) says the logprob client,
    // while the call's bag names a chat client that serves a response WITH
    // logprobs-shaped data. Without the served-client term the response would
    // be returned as `method: 'logprob'`.
    const clients = await import('@hames-ai/harness-baml/clients.server')
    const spy = vi.spyOn(clients, 'resolveClientForRole').mockReturnValue('LocalQwenSmallDecide')
    const { configureConsumerClients } = clients
    configureConsumerClients((role) =>
      role === 'decide' ? { client: 'LocalQwenSmall' } : undefined,
    )
    try {
      const { createDecideAdapter, LLMCallError } =
        await import('@hames-ai/harness-baml/baml-adapters.server')
      const decide = createDecideAdapter()
      const err = await decide({ spec: SPEC, state: 's' }).catch((e) => e)
      expect(err).toBeInstanceOf(LLMCallError)
      expect(String(err.message)).toMatch(/ran on LocalQwenSmall, which is not in LOGPROB_CLIENTS/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('the private-tier lock on the non-logprob branches (review finding 3)', () => {
  afterEach(async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients(undefined)
  })

  it('P3 — a consumer mapping decide to a non-logprob client under the private tier is refused, secondary never called, zero requests', async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients((role) =>
      role === 'decide' ? { client: 'LocalQwenSmall' } : undefined,
    )
    const { createDecideAdapter, LLMCallError } =
      await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
    const err = await onPrivateTier(() => decide({ spec: SPEC, state: 's' })).catch((e) => e)
    expect(err).toBeInstanceOf(LLMCallError)
    expect(String(err.message)).toMatch(/under the private inference tier/)
    expect(verbalizedStub).not.toHaveBeenCalled()
    expect(requests).toBe(0)
  })

  it('the Jev branch refuses the same way (the adapter-level lock; the transport’s own is `jev-tier-lock`)', async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients((role) => (role === 'decide' ? { client: 'JevDecide' } : undefined))
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter()
    await expect(onPrivateTier(() => decide({ spec: SPEC, state: 's' }))).rejects.toThrow(
      /Refusing decide transport "jev"/,
    )
    expect(requests).toBe(0)
  })

  it('does not lock the Anthropic tier: the injected secondary is still reachable there', async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients((role) =>
      role === 'decide' ? { client: 'AnthropicHaiku45' } : undefined,
    )
    const { createDecideAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const decide = createDecideAdapter({ verbalized: verbalizedStub as unknown as DecideFn })
    await decide({ spec: SPEC, state: 's' })
    expect(verbalizedStub).toHaveBeenCalledTimes(1)
  })
})

describe('one layer order for the resolver and the router (review R1)', () => {
  const ROLES = [
    'controller',
    'planner',
    'critic',
    'compactExecution',
    'router',
    'describe',
    'screen',
    'decide',
  ] as const

  afterEach(async () => {
    const { configureConsumerClients } = await import('@hames-ai/harness-baml/clients.server')
    configureConsumerClients(undefined)
  })

  // "Selection by the client" only holds while the name the adapter reads and
  // the client the call is actually sent to agree. They are two functions
  // (`resolveClientForRole`, `clientOverrideFor`) and the only thing that keeps
  // them one answer is the layer order: per-run, then consumer, then tier map.
  it.each(['anthropic', 'verda'] as const)(
    'with per-run AND consumer layers set to different clients, the resolver names the routed client (%s tier)',
    async (tier) => {
      const clients = await import('@hames-ai/harness-baml/clients.server')
      const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
      if (tier === 'verda') clients.assertInferenceTier('verda')
      clients.configureConsumerClients((role) => ({ client: `Consumer-${role}` }))
      const frame = {
        inference: {
          ...(tier === 'verda' ? { tier: 'verda' } : {}),
          clientOverride: (role: string) => ({ client: `PerRun-${role}` }),
        },
      }
      await withRunFrame(frame, async () => {
        for (const role of ROLES) {
          const routed = clients.clientOverrideFor(role)?.client
          expect(routed, role).toBe(`PerRun-${role}`)
          expect(clients.resolveClientForRole(role), role).toBe(routed)
        }
      })
      // Consumer alone, and nothing but the tier: still the same answer.
      for (const role of ROLES) {
        await withRunFrame(tier === 'verda' ? { inference: { tier: 'verda' } } : {}, async () => {
          expect(clients.resolveClientForRole(role), role).toBe(
            clients.clientOverrideFor(role)?.client,
          )
        })
      }
      clients.configureConsumerClients(undefined)
      await withRunFrame(tier === 'verda' ? { inference: { tier: 'verda' } } : {}, async () => {
        for (const role of ROLES) {
          const routed = clients.clientOverrideFor(role)?.client
          // No layer names a client: the override is absent and the resolver
          // falls to the tier map / the mirror — the one place they may differ
          // in SHAPE (undefined vs a name), never in the client a call takes.
          if (routed !== undefined) expect(clients.resolveClientForRole(role), role).toBe(routed)
        }
      })
    },
  )
})
