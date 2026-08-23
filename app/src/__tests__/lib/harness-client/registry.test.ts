/**
 * Agent registry (`lib/harness-client/registry.server.ts`) — registration,
 * client-safe metadata, and the two structural capability probes
 * (redis-retriever / durable sandbox workspace).
 *
 * The structural detectors from harness-patterns are mocked so the probes can
 * be driven independently of any real pattern graph; the agents that the
 * module registers on import are exercised through the public listing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentConfig } from '../../../lib/harness-client/registry.server'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const harnessHasRedisRetriever = vi.fn(() => false)
const harnessUsesSyncWorkspace = vi.fn(() => false)
vi.mock('../../../lib/harness-patterns', () => ({
  harnessHasRedisRetriever,
  harnessUsesSyncWorkspace,
}))

// The module registers the seven agents on import; each one pulls in the whole
// pattern/tool graph, so stub them down to bare configs.
function stubAgent(id: string): AgentConfig {
  return {
    id,
    name: id,
    description: id,
    icon: `i-${id}`,
    accent: 'blue',
    servers: [],
    createPatterns: async () => [],
  }
}
vi.mock('../../../lib/harness-client/agents/default.server', () => ({
  defaultAgent: stubAgent('default'),
}))
vi.mock('../../../lib/harness-client/agents/general.server', () => ({
  generalAgent: stubAgent('general'),
}))
vi.mock('../../../lib/harness-client/agents/multi-source-research.server', () => ({
  multiSourceResearchAgent: stubAgent('multi-source-research'),
}))
vi.mock('../../../lib/harness-client/agents/sandbox-session.server', () => ({
  sandboxSessionAgent: stubAgent('sandbox-session'),
}))
vi.mock('../../../lib/harness-client/agents/flavoured-sandbox.server', () => ({
  flavouredSandboxAgent: stubAgent('flavoured-sandbox'),
}))
vi.mock('../../../lib/harness-client/agents/retriever-agent.server', () => ({
  retrieverAgent: stubAgent('retriever'),
}))
vi.mock('../../../lib/harness-client/agents/microsoft-365.server', () => ({
  microsoft365Agent: stubAgent('microsoft-365'),
}))

const {
  registerAgent,
  getAgent,
  getAllAgents,
  getAgentMetadata,
  agentUsesRedisRetriever,
  agentUsesSyncWorkspace,
} = await import('../../../lib/harness-client/registry.server')

/** Unique ids per test keep the module-level capability caches from bleeding. */
let seq = 0
type PatternFactory = AgentConfig['createPatterns']

function freshAgent(overrides: Partial<{ createPatterns: PatternFactory }> = {}) {
  const id = `probe-${seq++}`
  const createPatterns = vi.fn<PatternFactory>(
    overrides.createPatterns ?? (async () => [{ patternId: 'x' }] as never),
  )
  registerAgent({
    id,
    name: `Agent ${id}`,
    description: 'probe',
    icon: `i-${id}`,
    accent: 'violet',
    servers: ['neo4j'],
    createPatterns,
  })
  return { id, createPatterns }
}

beforeEach(() => {
  harnessHasRedisRetriever.mockReturnValue(false)
  harnessUsesSyncWorkspace.mockReturnValue(false)
})

describe('registration + lookup', () => {
  it('registers the bundled agents on import', () => {
    expect(getAllAgents().map((a) => a.id)).toEqual(
      expect.arrayContaining([
        'default',
        'general',
        'multi-source-research',
        'sandbox-session',
        'flavoured-sandbox',
        'retriever',
        'microsoft-365',
      ]),
    )
  })

  it('returns undefined for an unknown id rather than throwing', () => {
    expect(getAgent('no-such-agent')).toBeUndefined()
  })

  it('replaces an agent registered twice under the same id', () => {
    const before = getAllAgents().length
    registerAgent({ ...stubAgent('default'), name: 'Renamed' })
    expect(getAgent('default')?.name).toBe('Renamed')
    expect(getAllAgents()).toHaveLength(before)
  })

  it('exposes metadata without the non-serializable pattern factory', () => {
    const { id } = freshAgent()
    const meta = getAgentMetadata().find((m) => m.id === id)!
    expect(meta).toEqual({
      id,
      name: `Agent ${id}`,
      description: 'probe',
      icon: `i-${id}`,
      accent: 'violet',
      servers: ['neo4j'],
    })
    expect('createPatterns' in meta).toBe(false)
  })
})

describe.each([
  ['agentUsesRedisRetriever', agentUsesRedisRetriever, harnessHasRedisRetriever],
  ['agentUsesSyncWorkspace', agentUsesSyncWorkspace, harnessUsesSyncWorkspace],
] as const)('%s — structural capability probe', (_name, probe, detector) => {
  it('reports what the structural detector saw in the built patterns', async () => {
    detector.mockReturnValue(true)
    const { id, createPatterns } = freshAgent()

    await expect(probe(id, 'sess-1')).resolves.toBe(true)
    expect(createPatterns).toHaveBeenCalledWith('sess-1')
    expect(detector).toHaveBeenCalledWith([{ patternId: 'x' }])
  })

  it('memoizes per agentId — patterns are built once, not once per session', async () => {
    detector.mockReturnValue(true)
    const { id, createPatterns } = freshAgent()

    await probe(id, 'sess-1')
    await probe(id, 'sess-2')

    expect(createPatterns).toHaveBeenCalledTimes(1)
  })

  it('is false for an unregistered agent', async () => {
    await expect(probe('no-such-agent', 'sess-1')).resolves.toBe(false)
  })

  it('does not cache a pattern-construction failure, so the next call re-probes', async () => {
    let attempts = 0
    const { id } = freshAgent({
      createPatterns: async () => {
        if (attempts++ === 0) throw new Error('gateway down')
        return [{ patternId: 'x' }] as never
      },
    })
    detector.mockReturnValue(true)

    // First call falls back (no real detection possible)...
    await probe(id, 'sess-1')
    // ...and the second one gets the real answer.
    await expect(probe(id, 'sess-2')).resolves.toBe(true)
    expect(attempts).toBe(2)
  })
})

// sf-M7. Both probes turn a `createPatterns` failure into a plain
// false/fallback. The degraded answer is correct — nothing better is knowable —
// but it used to be indistinguishable from a real `false`, so the consequence
// (no auto-ingest, an unhydrated Shell) never reached anyone.
describe('capability probes report a degraded answer (sf-M7)', () => {
  it.each([
    ['agentUsesRedisRetriever', agentUsesRedisRetriever],
    ['agentUsesSyncWorkspace', agentUsesSyncWorkspace],
  ])('%s warns, names the probe, and says the answer is not cached', async (name, probe) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { id } = freshAgent({
      createPatterns: async () => {
        throw new Error('gateway down')
      },
    })

    await probe(id, 'sess-x')

    expect(warn).toHaveBeenCalledTimes(1)
    const msg = warn.mock.calls[0][0] as string
    expect(msg).toContain(name)
    expect(msg).toContain(id)
    expect(msg).toContain('gateway down')
    expect(msg).toContain('Not cached')
    warn.mockRestore()
  })

  it('warns again on the next call, because the outage may be persistent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { id } = freshAgent({
      createPatterns: async () => {
        throw new Error('gateway down')
      },
    })

    await agentUsesRedisRetriever(id, 's1')
    await agentUsesRedisRetriever(id, 's2')

    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('agentUsesRedisRetriever / agentUsesSyncWorkspace — failure fallback', () => {
  it('fails closed to false, with no name-based special case', async () => {
    const boom = async () => {
      throw new Error('gateway down')
    }
    const a = freshAgent({ createPatterns: boom })
    const b = freshAgent({ createPatterns: boom })

    await expect(agentUsesRedisRetriever(a.id, 's')).resolves.toBe(false)
    await expect(agentUsesSyncWorkspace(b.id, 's')).resolves.toBe(false)
  })
})
