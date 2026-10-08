import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentDeps } from '@hames-ai/agents'
import { configurePattern } from '@hames-ai/harness-patterns'
import { runWithRequestContext } from '../../../lib/harness-client/request-user.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
const stores = vi.hoisted(() => ({
  count: vi.fn(async () => 0),
  candidates: vi.fn(async () => []),
  transaction: vi.fn(async () => 1),
}))
const createMemoryDbStore = vi.hoisted(() => vi.fn((_id: string) => stores))
const getMemoryEnabled = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../../lib/db/memories.server', () => ({ createMemoryDbStore }))
vi.mock('../../../lib/db/user-prefs.server', () => ({ getMemoryEnabled }))
const ensureMemoryAwake = vi.hoisted(() => vi.fn(async () => {}))
const awaitMemoryWake = vi.hoisted(() => vi.fn(async () => 'awake' as 'awake' | 'skipped'))
vi.mock('../../../lib/inference/memory-wake.server', () => ({
  ensureMemoryAwake,
  awaitMemoryWake,
  memoryWakeTimeoutMs: () => 30,
}))
const embed = vi.hoisted(() =>
  vi.fn(async (_texts: string[], _config: object) => ({
    vectors: [[1]],
    provider: 'local',
    model: 'test',
    dimensions: 1024,
  })),
)
vi.mock('@hames-ai/harness-patterns/stash/embeddings.server', async (original) => ({
  ...(await original<object>()),
  embed,
}))
const { createHostMemoryConfig, startTurnMemory, waitForTurnMemoryWake, visibleMemoryTiers } =
  await import('../../../lib/memory/config.server')
const { agentDeps } = await import('../../../lib/harness-client/session.server')

beforeEach(() => {
  vi.clearAllMocks()
})

// This must compile without memory; the typecheck is the consumer compatibility pin.
const oldConsumer: AgentDeps = { toolNamespaces: () => undefined }

describe('host memory composition', () => {
  it('is optional for an existing consumer and supplied by the composition root', () => {
    expect(oldConsumer.memory).toBeUndefined()
    expect(agentDeps().memory).toMatchObject({
      store: expect.any(Object),
      enabled: expect.any(Function),
      embed: expect.any(Object),
    })
  })
  it('cached closures resolve the owner per operation and fail closed without one', async () => {
    const cfg = createHostMemoryConfig()
    for (const userId of ['alice', 'bob'])
      await runWithRequestContext({ userId, sessionId: 'same', memoryAllowed: true }, async () => {
        expect(cfg.owner()).toBe(userId)
        await cfg.store.count(['anthropic'])
        await cfg.store.candidates({ embedding: [1], tiers: ['anthropic'] })
        await cfg.store.transaction(async () => 1)
        expect(await cfg.enabled()).toBe(true)
      })
    expect(createMemoryDbStore.mock.calls.map((a) => a[0])).toEqual([
      'alice',
      'alice',
      'alice',
      'bob',
      'bob',
      'bob',
    ])
    expect(getMemoryEnabled.mock.calls).toEqual([['alice'], ['bob']])
    getMemoryEnabled.mockResolvedValueOnce(false)
    await runWithRequestContext(
      { userId: 'alice', sessionId: 'same', memoryAllowed: true },
      async () => {
        expect(await cfg.enabled()).toBe(false)
      },
    )
    expect(await cfg.enabled()).toBe(false)
    expect(() => cfg.store.count([])).toThrow('owner')
  })
  it('private memories are visible only privately; unknown tiers are refused', () => {
    expect(visibleMemoryTiers('verda')).toEqual(['anthropic', 'verda'])
    expect(visibleMemoryTiers('anthropic')).toEqual(['anthropic'])
    expect(visibleMemoryTiers('future')).toEqual([])
    expect(visibleMemoryTiers(undefined)).toEqual([])
  })
  it('the composition root wires the fail-closed tier map and the settle budget (D8, D20)', async () => {
    const { memoryStoreConfig } =
      await import('@hames-ai/harness-patterns/patterns/withMemory.server')
    const cfg = agentDeps().memory!
    expect(cfg.visibleTiers('anthropic')).toEqual(['anthropic'])
    expect(cfg.visibleTiers('verda')).toEqual(['anthropic', 'verda'])
    expect(cfg.visibleTiers('future')).toEqual([])
    expect(cfg.visibleTiers(undefined)).toEqual([])
    expect(memoryStoreConfig(cfg).settings?.wakeBudgetMs).toBe(30)
  })
  it.each([false, true] as const)(
    '#553: recall and wake require the same interactive origin gate (%s)',
    async (memoryAllowed) => {
      const { createContext } = await import('@hames-ai/harness-patterns/context.server')
      const { runChain } = await import('@hames-ai/harness-patterns/patterns/chain.server')
      const { withMemory } = await import('@hames-ai/harness-patterns/patterns/withMemory.server')
      const cfg = agentDeps().memory!
      const patterns = withMemory<{ memoryContext?: string; [key: string]: unknown }>(cfg)([])
      await runWithRequestContext(
        { userId: 'alice', sessionId: 'same', memoryAllowed },
        async () => {
          expect(await cfg.enabled()).toBe(memoryAllowed)
          startTurnMemory(patterns, cfg)
          const ctx = createContext('synthetic question')
          await withRunFrame({ inference: { tier: 'anthropic' } }, () => runChain(ctx, patterns))
          expect(ctx.events.find((e) => e.type === 'memory_recalled')?.data).toMatchObject({
            attached: [],
            skipped: memoryAllowed ? 'empty' : 'disabled',
          })
          expect(stores.count).toHaveBeenCalledTimes(memoryAllowed ? 1 : 0)
          expect(stores.candidates).not.toHaveBeenCalled()
          expect(embed).not.toHaveBeenCalled()
          expect(ensureMemoryAwake).toHaveBeenCalledTimes(memoryAllowed ? 1 : 0)
        },
      )
    },
  )
  it('#553: a request scope that never set the origin gate fails closed', async () => {
    const cfg = agentDeps().memory!
    const leaf = configurePattern('leaf', async (scope) => scope)
    const memory = { ...leaf, capabilities: { memory: true as const } }
    await runWithRequestContext({ userId: 'alice', sessionId: 'same' }, async () => {
      expect(await cfg.enabled()).toBe(false)
      expect(startTurnMemory([memory], cfg)).toBeUndefined()
    })
    expect(getMemoryEnabled).not.toHaveBeenCalled()
    expect(ensureMemoryAwake).not.toHaveBeenCalled()
  })
  it('embeds query and documents explicitly locally despite a public stash setting', async () => {
    vi.stubEnv('EMBEDDINGS_PROVIDER', 'openrouter')
    const cfg = createHostMemoryConfig()
    await withRunFrame({ inference: { tier: 'verda' } }, async () => {
      await cfg.embed.query('synthetic query')
      await cfg.embed.documents(['synthetic document'])
    })
    expect(cfg.embed.spaceId).toContain('local:')
    expect(embed.mock.calls).toEqual([
      [
        ['Instruct: Retrieve relevant memories about the user\nQuery: synthetic query'],
        expect.objectContaining({ provider: 'local', dimensions: 1024 }),
      ],
      [['synthetic document'], expect.objectContaining({ provider: 'local', dimensions: 1024 })],
    ])
    vi.unstubAllEnvs()
  })
  it('starts only for a capability opt-in and captures the same wake for late settle', async () => {
    const leaf = configurePattern('leaf', async (scope) => scope)
    const memory = { ...leaf, capabilities: { memory: true as const } }
    const cfg = createHostMemoryConfig()
    await runWithRequestContext(
      { userId: 'alice', sessionId: 'same', memoryAllowed: true },
      async () => {
        expect(startTurnMemory([leaf], cfg)).toBeUndefined()
        expect(startTurnMemory([memory])).toBeUndefined()
        expect(ensureMemoryAwake).not.toHaveBeenCalled()
        awaitMemoryWake.mockResolvedValueOnce('skipped')
        expect(startTurnMemory([memory], cfg)).toBe(cfg)
        await Promise.resolve()
        awaitMemoryWake.mockResolvedValue('awake') // another turn cannot replace ours
        expect(await cfg.awaitWake!(100)).toBe('skipped')
        expect(awaitMemoryWake).toHaveBeenCalledTimes(1)
        expect(ensureMemoryAwake).toHaveBeenCalledExactlyOnceWith(true)
      },
    )
    expect(await waitForTurnMemoryWake(1)).toBe('skipped')
  })
  it('waits at most the consumer budget and fails closed on rejection', async () => {
    const { setRequestMemoryWake } = await import('../../../lib/harness-client/request-user.server')
    await runWithRequestContext(
      { userId: 'alice', sessionId: 'same', memoryAllowed: true },
      async () => {
        setRequestMemoryWake(new Promise(() => {}))
        expect(await waitForTurnMemoryWake(5)).toBe('skipped')
        setRequestMemoryWake(Promise.reject(new Error('refused')))
        expect(await waitForTurnMemoryWake(100)).toBe('skipped')
      },
    )
  })
})

// G9 Q4: composition is available, but no shipped agent opts in before M10.
it('shipped agent factories have no withMemory opt-in', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const files = await readdir('../packages/agents/agents')
  for (const file of files.filter((f) => f.endsWith('.server.ts'))) {
    expect(await readFile(`../packages/agents/agents/${file}`, 'utf8')).not.toMatch(
      /withMemory\s*\(/,
    )
  }
})
