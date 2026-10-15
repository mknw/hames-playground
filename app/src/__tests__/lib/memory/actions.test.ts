import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bypass: vi.fn(() => false),
  list: vi.fn(),
  erase: vi.fn(),
  eraseOne: vi.fn(),
  enabled: vi.fn(),
  set: vi.fn(),
  export: vi.fn(),
  purge: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))
vi.mock('../../../lib/db/hitl.server', () => ({ deleteHitlProposalsForUser: mocks.purge }))
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser: mocks.auth }))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: mocks.bypass,
  BYPASS_USER: { id: 'dev-bypass-user' },
}))
vi.mock('../../../lib/db/memories.server', () => ({
  listMemoriesForUser: mocks.list,
  deleteAllMemoriesForUser: mocks.erase,
  deleteMemoryForUser: mocks.eraseOne,
  exportMemoryDataForUser: mocks.export,
}))
vi.mock('../../../lib/db/user-prefs.server', () => ({
  getMemoryEnabled: mocks.enabled,
  setMemoryEnabledForUser: mocks.set,
}))
import * as rpc from '../../../lib/memory/actions.server'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ id: 'synthetic-owner' })
  mocks.enabled.mockResolvedValue(false)
  mocks.list.mockResolvedValue([])
  mocks.export.mockResolvedValue([
    { content: 'Synthetic preference', embedding: '[0.1]', sources: [] },
  ])
})
describe('#579 review 1: erasure takes the pending proposals too', () => {
  // MUTATION: drop the purge from either RPC → a pending proposal's text
  // survives "Forget everything" / switching off, readable and saveable → red.
  it.each([
    ['forget all', () => rpc.forgetAllMemories()],
    ['turn off', () => rpc.setMemoryEnabled(false)],
  ])('%s purges the caller’s memory proposals AFTER the memories are erased', async (_, invoke) => {
    const order: string[] = []
    mocks.set.mockImplementation(async () => void order.push('off'))
    mocks.erase.mockImplementation(async () => void order.push('erase'))
    mocks.purge.mockImplementation(async () => void order.push('purge'))
    await invoke()
    expect(order).toEqual(['off', 'erase', 'purge'])
    expect(mocks.purge).toHaveBeenCalledExactlyOnceWith('synthetic-owner', 'memory.confirm')
  })

  // MUTATION: swallow the purge failure → success is reported with the text still held → red.
  it.each([
    ['forget all', () => rpc.forgetAllMemories()],
    ['turn off', () => rpc.setMemoryEnabled(false)],
  ])(
    '%s reports a failed purge as a retryable failure, leaving the switch OFF',
    async (_, invoke) => {
      mocks.purge.mockRejectedValue(new Error('retry purge'))
      await expect(invoke()).rejects.toThrow('retry purge')
      expect(mocks.set).toHaveBeenCalledExactlyOnceWith('synthetic-owner', false)
    },
  )

  // MUTATION: purge on switch-ON as well → harmless but wrong; and a failed
  // erase must not reach the purge (the order the #552 policy fixes).
  it('turning memory ON purges nothing, and a failed erase never reaches the purge', async () => {
    await rpc.setMemoryEnabled(true)
    expect(mocks.purge).not.toHaveBeenCalled()
    mocks.erase.mockRejectedValue(new Error('retry erase'))
    await expect(rpc.forgetAllMemories()).rejects.toThrow('retry erase')
    expect(mocks.purge).not.toHaveBeenCalled()
  })
})

describe('memory RPC ownership and erase ordering', () => {
  it('scopes every operation to the authenticated principal', async () => {
    expect(await rpc.listMyMemories()).toEqual({ enabled: false, memories: [] })
    await rpc.forgetMemory('memory-1')
    await rpc.setMemoryEnabled(true)
    const out = await rpc.exportMyMemories()
    expect(mocks.list).toHaveBeenCalledWith('synthetic-owner')
    expect(mocks.eraseOne).toHaveBeenCalledWith('synthetic-owner', 'memory-1')
    expect(mocks.set).toHaveBeenCalledWith('synthetic-owner', true)
    expect(mocks.erase).not.toHaveBeenCalled()
    expect(mocks.export).toHaveBeenCalledWith('synthetic-owner')
    expect(out.memories).toEqual(await mocks.export.mock.results[0].value)
    expect(out.exportedAt).toEqual(expect.any(String))
  })
  it.each([
    ['forget all', () => rpc.forgetAllMemories()],
    ['turn off', () => rpc.setMemoryEnabled(false)],
  ])('%s commits OFF before erase, and propagates retryable failures', async (_, invoke) => {
    const order: string[] = []
    mocks.set.mockImplementation(async () => {
      order.push('off')
    })
    mocks.erase.mockImplementation(async () => {
      order.push('erase')
      throw Object.assign(new Error('retry erase'), { code: '55P03' })
    })
    await expect(invoke()).rejects.toThrow('retry erase')
    expect(order).toEqual(['off', 'erase'])
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith('synthetic-owner', false)
  })
  it('never erases when switch commit fails', async () => {
    mocks.set.mockRejectedValue(new Error('preference unavailable'))
    await expect(rpc.forgetAllMemories()).rejects.toThrow('preference unavailable')
    expect(mocks.erase).not.toHaveBeenCalled()
  })
  it('gates ALL exports before opening a resource, including invalid input', async () => {
    mocks.auth.mockRejectedValue(new Error('Authentication required'))
    for (const invoke of [
      () => rpc.listMyMemories(),
      () => rpc.forgetMemory(''),
      () => rpc.forgetAllMemories(),
      () => rpc.setMemoryEnabled(true),
      () => rpc.exportMyMemories(),
    ])
      await expect(invoke()).rejects.toThrow('Authentication required')
    for (const fn of [
      mocks.list,
      mocks.erase,
      mocks.eraseOne,
      mocks.set,
      mocks.enabled,
      mocks.export,
    ])
      expect(fn).not.toHaveBeenCalled()
  })
  it('honors the DEV-only bypass', async () => {
    mocks.bypass.mockReturnValue(true)
    await rpc.listMyMemories()
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.list).toHaveBeenCalledWith('dev-bypass-user')
  })
  it('validates runtime input after authentication', async () => {
    await expect(rpc.setMemoryEnabled('false' as never)).rejects.toThrow('boolean')
    await expect(rpc.forgetMemory(' ')).rejects.toThrow('Memory ID')
    expect(mocks.set).not.toHaveBeenCalled()
    expect(mocks.eraseOne).not.toHaveBeenCalled()
  })
})
