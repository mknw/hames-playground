import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  forget: vi.fn(),
  all: vi.fn(),
  set: vi.fn(),
  export: vi.fn(),
}))
vi.mock('../../../lib/memory/actions.server', () => ({
  listMyMemories: mocks.list,
  forgetMemory: mocks.forget,
  forgetAllMemories: mocks.all,
  setMemoryEnabled: mocks.set,
  exportMyMemories: mocks.export,
}))
import { MemoryPanel } from '../../../components/ark-ui/MemoryPanel'
const row = {
  id: 'memory-1',
  content: 'I prefer synthetic examples',
  kind: 'preference',
  tier: 'verda',
  createdAt: new Date('2026-01-01'),
  lastSeenAt: new Date('2026-02-01'),
  compactedFrom: 3,
  sourceConversationIds: ['synthetic-conversation'],
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.list.mockResolvedValue({ enabled: true, memories: [row] })
})
async function ready() {
  render(() => <MemoryPanel />)
  await screen.findByText(row.content)
}
it('lists metadata and sources, keeps disclosure visible and filters by kind', async () => {
  await ready()
  expect(screen.getByText('Merged from 3')).toBeTruthy()
  expect(screen.getByText(/First seen/)).toBeTruthy()
  expect(
    screen.getByText(
      "Forget deletes rows; it does not reach the responder's recorded prompt or the nightly pg_dump.",
    ),
  ).toBeTruthy()
  const source = screen.getByRole('link', { name: /Source conversation/ })
  expect(source.getAttribute('target')).toBe('_blank')
  expect(source.getAttribute('rel')).toContain('noopener')
  await fireEvent.click(screen.getByRole('tab', { name: 'semantic' }))
  await screen.findByText('No saved memories.')
})
it('forgets one row and reloads the list', async () => {
  await ready()
  mocks.list.mockResolvedValue({ enabled: true, memories: [] })
  await fireEvent.click(screen.getByRole('button', { name: `Forget ${row.content}` }))
  await screen.findByText('No saved memories.')
  expect(mocks.forget).toHaveBeenCalledExactlyOnceWith(row.id)
})
it('requires an Ark Dialog confirmation, allows cancel, then turns off after forget all', async () => {
  await ready()
  await fireEvent.click(screen.getByRole('button', { name: 'Forget everything' }))
  await screen.findByRole('dialog', { name: 'Forget everything?' })
  expect(mocks.all).not.toHaveBeenCalled()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await fireEvent.click(screen.getByRole('button', { name: 'Forget everything' }))
  mocks.list.mockResolvedValue({ enabled: false, memories: [] })
  await fireEvent.click(await screen.findByRole('button', { name: 'Confirm forget everything' }))
  await screen.findByText('No saved memories.')
  expect(mocks.all).toHaveBeenCalledOnce()
  expect(
    (screen.getByRole('checkbox', { name: 'Memory enabled' }) as HTMLInputElement).checked,
  ).toBe(false)
})
it('switch calls the persisted RPC and reports incomplete erasure without hiding remaining rows', async () => {
  await ready()
  mocks.set.mockRejectedValue(new Error('Lock timeout: retry'))
  mocks.list.mockResolvedValue({ enabled: false, memories: [row] })
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Memory enabled' }))
  await screen.findByRole('alert')
  expect(mocks.set).toHaveBeenCalledWith(false)
  expect(screen.getByText(row.content)).toBeTruthy()
  expect(screen.getByText(/Lock timeout/)).toBeTruthy()
})
it('downloads a JSON access export and revokes the object URL', async () => {
  const create = vi.fn(() => 'blob:synthetic')
  const revoke = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  mocks.export.mockResolvedValue({ enabled: true, memories: [row] })
  await ready()
  await fireEvent.click(screen.getByRole('button', { name: 'Export my memories (Art. 15)' }))
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:synthetic'))
  expect(create.mock.calls[0]).toHaveLength(1)
  expect(click).toHaveBeenCalledOnce()
  click.mockRestore()
})
it('shows an initial load failure and allows retry', async () => {
  mocks.list.mockRejectedValueOnce(new Error('Database unavailable'))
  render(() => <MemoryPanel />)
  await screen.findByRole('alert')
  await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText(row.content)
})
