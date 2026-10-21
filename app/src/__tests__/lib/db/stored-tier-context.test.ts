// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/db/client.server', () => ({
  query,
  withTransaction: vi.fn(),
  onClosePool: vi.fn(),
  SCHEMA_LOCK_KEY: 'synthetic-schema-lock',
  databaseUrl: () => 'postgresql://x:x@127.0.0.1:59999/x',
}))
import { encryptJsonb } from '../../../lib/db/crypto.server'
import {
  loadConversation,
  loadSharedConversation,
  listConversationEvents,
} from '../../../lib/db/conversations.server'

const context = {
  data: {},
  events: [{ type: 'hitl_request', data: { tier: 'verda', content: 'verda' } }],
}
let ciphertext: string
beforeEach(() => {
  ciphertext = JSON.parse(encryptJsonb(JSON.stringify(context)))
  query.mockReset()
  query.mockResolvedValue({
    rows: [{ id: 'synthetic', title: null, context: ciphertext, inference_tier: 'verda' }],
  })
})
it.each([
  ['owner read', () => loadConversation('synthetic', 'synthetic-owner')],
  ['share read', () => loadSharedConversation('a'.repeat(43))],
] as const)('%s projects tier metadata without updating the stored blob', async (_, read) => {
  const row = await read()
  const projected = JSON.parse(row!.serializedContext)
  expect(projected.events[0].data).toEqual({ tier: 'self_deployed', content: 'verda' })
  expect(context.events[0].data.tier).toBe('verda')
  expect(query).toHaveBeenCalledOnce()
  expect(query.mock.calls[0][0]).toMatch(/^SELECT /)
})
it('event aggregates use the same read projection', async () => {
  const rows = await listConversationEvents('synthetic-owner')
  expect(rows[0].events).toEqual([
    { type: 'hitl_request', data: { tier: 'self_deployed', content: 'verda' } },
  ])
  expect(query).toHaveBeenCalledOnce()
})
