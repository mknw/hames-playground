/**
 * Required-supplier discipline for `registerGraphConnectorTools` (PR-2
 * doctrine + PR-C1 review finding F1, resolved in PR-C2).
 *
 * F1 was a non-blocking finding on the PR-C1 review: the graph tools' supplier
 * check tested only `value == null`, while the registry's `requireSupplier`
 * tested `typeof value !== 'function'`. A present-but-wrong-typed supplier
 * (e.g. `graphFetch: 42`) therefore passed the factory and blew up at FIRST
 * TOOL USE instead — a miscomposition that reads like a runtime failure of a
 * correctly-composed app. The two helpers are aligned now (both
 * function-typed), and this file is the turn-red check the review asked for:
 * every case below throws AT FACTORY CALL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerGraphConnectorTools } from '../../graph/graph-tools.server'

const registerAppTool = vi.fn()
const graphFetch = vi.fn(async () => ({ value: [] }))
const content = {
  conversionEnabled: vi.fn(() => false),
  isConvertible: vi.fn(() => false),
  guessMimeType: vi.fn(() => 'text/plain'),
  isTextMime: vi.fn(() => true),
}
const stash = {
  loadStore: vi.fn(async () => ({ storeDocument: vi.fn(), maxContentBytes: 5 })),
  ingest: vi.fn(async () => null),
}

const goodDeps = { registerAppTool, graphFetch, content, stash }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registerGraphConnectorTools refuses a non-function supplier at factory call (F1)', () => {
  it('graphFetch: 42 throws at the factory, naming the field', () => {
    expect(() =>
      registerGraphConnectorTools({ ...goodDeps, graphFetch: 42 } as never),
    ).toThrow(/graphFetch/)
    expect(registerAppTool).not.toHaveBeenCalled()
  })

  it('registerAppTool: null throws at the factory', () => {
    expect(() =>
      registerGraphConnectorTools({ ...goodDeps, registerAppTool: null } as never),
    ).toThrow(/registerAppTool/)
  })

  it.each(['conversionEnabled', 'isConvertible', 'guessMimeType', 'isTextMime'])(
    'content.%s: 42 throws at the factory',
    (field) => {
      expect(() =>
        registerGraphConnectorTools({
          ...goodDeps,
          content: { ...content, [field]: 42 },
        } as never),
      ).toThrow(new RegExp(`"${field}"`))
    },
  )

  it('content missing entirely throws at the factory', () => {
    const { content: _omit, ...rest } = goodDeps
    expect(() => registerGraphConnectorTools(rest as never)).toThrow(/"content"/)
  })

  it.each(['loadStore', 'ingest'])('stash.%s: 42 throws at the factory', (field) => {
    expect(() =>
      registerGraphConnectorTools({ ...goodDeps, stash: { ...stash, [field]: 42 } } as never),
    ).toThrow(new RegExp(`"${field}"`))
  })

  it('stash missing entirely throws at the factory', () => {
    const { stash: _omit, ...rest } = goodDeps
    expect(() => registerGraphConnectorTools(rest as never)).toThrow(/"stash"/)
  })

  it('a well-formed bag registers all nine tools', () => {
    expect(() => registerGraphConnectorTools(goodDeps)).not.toThrow()
    expect(registerAppTool).toHaveBeenCalledTimes(9)
  })
})
