/**
 * The app → library runtime-config seam (#225 Lane C / PR #342).
 *
 * Before the split, `simpleLoop` imported the app's `getRequestSettings`
 * directly: one module, one AsyncLocalStorage object, so "the user's setting
 * reaches the loop" was true BY CONSTRUCTION and needed no test. The split
 * makes it true by RESOLUTION instead — the app writes the scope through
 * `@hames/harness-patterns/runtime-config.server` (the workspace symlink) and
 * the pattern reads it through the package-relative `../runtime-config.server`.
 * Those are the same module only as long as every bundler on the path resolves
 * the symlink; if one ever doesn't, there are two stores, every request setting
 * silently reverts to the library default, and NOTHING errors — the same
 * silent-scope-loss class as SA-M13.
 *
 * Mutation-checked: pointing the package's `runtimeConfig()` at a second
 * AsyncLocalStorage instance (the dual-instance failure, verbatim) leaves the
 * whole 4 146-test unit suite green and turns the first test here RED.
 */
import { describe, it, expect, vi } from 'vitest'
import { mockAction, mockBAMLClient } from '../../mocks/baml'
import { mockCallTool, mockListTools } from '../../mocks/mcp'

vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const callToolMock = mockCallTool({
  responses: { read_neo4j_cypher: { rows: [] }, Return: { response: 'Done' } },
})

vi.mock('@hames/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools(['read_neo4j_cypher', 'Return']),
}))

vi.mock('../../../../baml_client', () => ({
  b: mockBAMLClient({
    loopActions: [mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{}' })],
  }),
}))

const contextWith = (input: string) => ({
  sessionId: 'test',
  createdAt: 0,
  events: [
    { type: 'user_message' as const, ts: 0, patternId: 'harness', data: { content: input } },
  ],
  status: 'running' as const,
  data: {},
  input,
})

/** Never signals completion — the round budget is the only way out. */
const neverFinishingController = () =>
  vi.fn().mockResolvedValue({
    action: {
      reasoning: 'still working',
      status: 'working',
      tool_name: 'read_neo4j_cypher',
      tool_args: '{}',
      additional_calls: null,
      is_final: false,
    },
    llmCall: undefined,
  })

describe('the scope the app opens is the scope the library reads', () => {
  it("a runWithSettings override reaches a pattern's own runtimeConfig() reader", async () => {
    const { runWithSettings } = await import('../../../lib/settings-context.server')
    const { DEFAULT_SETTINGS } = await import('../../../lib/settings')
    const { simpleLoop } = await import('@hames/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('@hames/harness-patterns/context.server')
    const { createEventView } = await import('@hames/harness-patterns/patterns')

    const controller = neverFinishingController()
    // No `maxTurns` on the pattern: the budget can ONLY come from the scope,
    // so the call count is a direct readout of which config the loop saw.
    const pattern = simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'execute',
    })

    await runWithSettings({ ...DEFAULT_SETTINGS, maxToolTurns: 2 }, () =>
      pattern.fn(
        createScope('execute', { intent: 'do the thing' }),
        createEventView(contextWith('do the thing')),
      ),
    )

    // 2 = the override. 8 = the library default, i.e. the scope was lost.
    expect(controller).toHaveBeenCalledTimes(2)
    expect(DEFAULT_SETTINGS.maxToolTurns).not.toBe(2)
  })

  it('outside any scope the app reader still returns its FULL defaults', async () => {
    const { getRequestSettings } = await import('../../../lib/settings-context.server')
    const { DEFAULT_SETTINGS } = await import('../../../lib/settings')

    // The library's defaults carry only the six core knobs; this reader must
    // keep answering with the app's own `sandbox` / `maxConcurrentRuns` too,
    // because `with-sandbox.server.ts` dereferences `.sandbox` unguarded.
    expect(getRequestSettings()).toEqual(DEFAULT_SETTINGS)
    expect(getRequestSettings().sandbox.defaultEgress).toBe('mcp-only')
  })
})
