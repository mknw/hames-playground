/**
 * The app → library RUN FRAME seam (#225 Lane C / PR #342, re-pointed by #374).
 *
 * Before the package split, `simpleLoop` imported the app's `getRequestSettings`
 * directly: one module, one AsyncLocalStorage object, so "the user's setting
 * reaches the loop" was true BY CONSTRUCTION and needed no test. The split made
 * it true by RESOLUTION instead — the app writes the scope through
 * `@hames/harness-patterns` (the workspace symlink) and the pattern reads it
 * through a package-relative import. Those are the same module only as long as
 * every bundler on the path resolves the symlink; if one ever doesn't, the
 * request setting silently reverts to the library default and NOTHING errors —
 * the same silent-scope-loss class as SA-M13.
 *
 * #374 replaced five such stores with ONE run frame, so this file's subject
 * narrowed and hardened at the same time:
 *
 *  - the scope the app opens is `withRunFrame({ config })`, not
 *    `runWithSettings`, and there is exactly one store left to resolve;
 *  - that store lives on a `globalThis` symbol, so it survives a SECOND
 *    resolved copy of the package as well as a symlink the bundler missed.
 *    `packages/harness-patterns/__tests__/run-frame.test.ts` pins the
 *    two-copies case directly;
 *  - the old fall-back is gone (ruling D3): a pattern reached with no frame
 *    open REFUSES instead of quietly running on the library's budgets, which is
 *    the failure this file was written to detect, now turned from a silent
 *    wrong answer into an error.
 *
 * Mutation-checked: pointing the package's `runtimeConfig()` at a second
 * AsyncLocalStorage instance (the dual-instance failure, verbatim) leaves the
 * whole unit suite green and turns the first test here RED.
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

vi.mock('@hames/harness-baml/baml_client', () => ({
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

describe('the frame the app opens is the frame the library reads', () => {
  it("the app's settings in the frame's config slot reach a pattern's runtimeConfig() reader", async () => {
    const { withRunFrame } = await import('@hames/harness-patterns/run-frame.server')
    const { DEFAULT_SETTINGS } = await import('../../../lib/settings')
    const { simpleLoop } = await import('@hames/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('@hames/harness-patterns/context.server')
    const { createEventView } = await import('@hames/harness-patterns/patterns')

    const controller = neverFinishingController()
    // No `maxTurns` on the pattern: the budget can ONLY come from the frame,
    // so the call count is a direct readout of which config the loop saw.
    const pattern = simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'execute',
    })

    await withRunFrame({ config: { ...DEFAULT_SETTINGS, maxToolTurns: 2 } }, () =>
      pattern.fn(
        createScope('execute', { intent: 'do the thing' }),
        createEventView(contextWith('do the thing')),
      ),
    )

    // 2 = the override. 8 = the library default, i.e. the frame was lost.
    expect(controller).toHaveBeenCalledTimes(2)
    expect(DEFAULT_SETTINGS.maxToolTurns).not.toBe(2)
  })

  it("the app's FULL settings survive the slot — not just the six library knobs", async () => {
    // `with-sandbox.server.ts` dereferences `.sandbox` unguarded, so the slot
    // has to carry the app's own fields too. It does, because the app puts its
    // whole `HarnessSettings` object in rather than a projection of it: this is
    // what `getRequestSettings`'s defensive `{ ...DEFAULT_SETTINGS, ...scope }`
    // spread used to be for, and deleting that reader is only safe while this
    // holds.
    const { withRunFrame } = await import('@hames/harness-patterns/run-frame.server')
    const { runtimeConfig } = await import('@hames/harness-patterns/runtime-config.server')
    const { DEFAULT_SETTINGS } = await import('../../../lib/settings')

    await withRunFrame({ config: DEFAULT_SETTINGS }, async () => {
      expect(runtimeConfig()).toEqual(DEFAULT_SETTINGS)
      expect((runtimeConfig() as typeof DEFAULT_SETTINGS).sandbox.defaultEgress).toBe('mcp-only')
    })
  })

  it('outside any frame the reader REFUSES rather than answering with a default', async () => {
    // Ruling D3. The fall-back this replaces could not tell "this host wants
    // the defaults" from "this host never opened a frame", and answered the
    // same way for both.
    const { runtimeConfig } = await import('@hames/harness-patterns/runtime-config.server')
    expect(() => runtimeConfig()).toThrow(/No run frame is open/)
  })
})
