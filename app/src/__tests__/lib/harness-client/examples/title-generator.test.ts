/**
 * Title Generator — sanitizer + first-turn gate tests.
 *
 * The agent itself (`titleAgent`) is exercised via the live SSE path in
 * manual verification; here we cover the pure helpers that decide whether
 * to write a title and how to clean up model output. The DB action and
 * the harness invocation are heavy server modules; we test them indirectly
 * by validating the pieces that decide whether they're called.
 */
import { describe, it, expect, vi } from 'vitest'

// `examples/title-generator.server.ts` imports `harness-patterns` (which
// asserts server-only on import) and `db/conversations.server` (which
// needs a pg pool). Mock both before dynamic-importing the SUT.
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
vi.mock('../../../../lib/db/conversations.server', () => ({
  updateConversationTitle: vi.fn(async () => undefined),
}))
vi.mock('../../../../../baml_client', () => ({
  b: {
    GenerateConversationTitle: vi.fn(async (msg: string) => `Title For ${msg.slice(0, 8)}`),
  },
}))
vi.mock('../../../../lib/harness-patterns', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../../lib/harness-patterns',
  )
  // Keep the real exports but stub out the `harness()` factory — the agent
  // would otherwise pull in MCP tools, settings-context, etc.
  return {
    ...actual,
    harness: () => async (_input: string, _sid?: string) => ({
      response: 'Mocked Agent Response',
      data: {},
      status: 'done' as const,
      duration_ms: 0,
      context: { events: [], sessionId: 'mock', createdAt: 0, status: 'done', input: '', data: {} },
      serialized: '{}',
    }),
  }
})

const sut = await import('../../../../lib/harness-client/examples/title-generator.server')
const { updateConversationTitle } = await import('../../../../lib/db/conversations.server')

describe('sanitizeTitle', () => {
  it('returns the input verbatim when already clean', () => {
    expect(sut.sanitizeTitle('Cytoscape Edge Styling')).toBe('Cytoscape Edge Styling')
  })

  it('strips surrounding quotes and backticks', () => {
    expect(sut.sanitizeTitle('"Cytoscape Edge Styling"')).toBe('Cytoscape Edge Styling')
    expect(sut.sanitizeTitle("'Foo Bar'")).toBe('Foo Bar')
    expect(sut.sanitizeTitle('`A Title`')).toBe('A Title')
    expect(sut.sanitizeTitle('""Mixed""')).toBe('Mixed')
  })

  it('strips trailing punctuation', () => {
    expect(sut.sanitizeTitle('A Title.')).toBe('A Title')
    expect(sut.sanitizeTitle('A Title!')).toBe('A Title')
    expect(sut.sanitizeTitle('A Title???')).toBe('A Title')
  })

  it('takes only the first line of a multi-line response', () => {
    expect(sut.sanitizeTitle('First Line\nSecond Line')).toBe('First Line')
    expect(sut.sanitizeTitle('Preamble\n\nReal Title')).toBe('Preamble')
  })

  it('caps overlong output at 50 chars', () => {
    const long = 'A '.repeat(60).trim()
    const result = sut.sanitizeTitle(long)
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(50)
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(sut.sanitizeTitle('')).toBeNull()
    expect(sut.sanitizeTitle('   ')).toBeNull()
    expect(sut.sanitizeTitle('""')).toBeNull()
  })
})

describe('runFirstTurnTitleGen', () => {
  it('skips when the context has zero user messages', async () => {
    const ctx = {
      sessionId: 's',
      createdAt: 0,
      events: [],
      status: 'done' as const,
      input: '',
      data: {},
    }
    const result = await sut.runFirstTurnTitleGen(ctx, 's1', 'u1')
    expect(result).toBeNull()
    expect(updateConversationTitle).not.toHaveBeenCalled()
  })

  it('skips when there are already 2+ user messages (regen only via on-demand path)', async () => {
    const ctx = {
      sessionId: 's',
      createdAt: 0,
      events: [
        { id: 'u1', type: 'user_message' as const, ts: 1, patternId: 'h', data: { content: 'first' } },
        { id: 'u2', type: 'user_message' as const, ts: 2, patternId: 'h', data: { content: 'second' } },
      ],
      status: 'done' as const,
      input: 'second',
      data: {},
    }
    const result = await sut.runFirstTurnTitleGen(ctx, 's1', 'u1')
    expect(result).toBeNull()
  })

  it('runs on first turn and persists the sanitized title', async () => {
    vi.mocked(updateConversationTitle).mockClear()
    const ctx = {
      sessionId: 's',
      createdAt: 0,
      events: [
        { id: 'u1', type: 'user_message' as const, ts: 1, patternId: 'h', data: { content: 'first message' } },
      ],
      status: 'done' as const,
      input: 'first message',
      data: {},
    }
    const result = await sut.runFirstTurnTitleGen(ctx, 'sess-1', 'user-1')
    // The mocked harness returns 'Mocked Agent Response' which sanitizes to itself.
    expect(result).toBe('Mocked Agent Response')
    expect(updateConversationTitle).toHaveBeenCalledWith('sess-1', 'user-1', 'Mocked Agent Response')
  })
})

describe('runRegenerateTitle', () => {
  it('returns null when context has no user messages', async () => {
    vi.mocked(updateConversationTitle).mockClear()
    const ctx = {
      sessionId: 's',
      createdAt: 0,
      events: [],
      status: 'done' as const,
      input: '',
      data: {},
    }
    const result = await sut.runRegenerateTitle(ctx, 's1', 'u1')
    expect(result).toBeNull()
    expect(updateConversationTitle).not.toHaveBeenCalled()
  })

  it('runs regardless of message count (unlike runFirstTurnTitleGen)', async () => {
    vi.mocked(updateConversationTitle).mockClear()
    const ctx = {
      sessionId: 's',
      createdAt: 0,
      events: [
        { id: 'u1', type: 'user_message' as const, ts: 1, patternId: 'h', data: { content: 'first' } },
        { id: 'u2', type: 'user_message' as const, ts: 2, patternId: 'h', data: { content: 'latest' } },
        { id: 'u3', type: 'user_message' as const, ts: 3, patternId: 'h', data: { content: 'newest' } },
      ],
      status: 'done' as const,
      input: 'newest',
      data: {},
    }
    const result = await sut.runRegenerateTitle(ctx, 'sess-x', 'user-x')
    expect(result).toBe('Mocked Agent Response')
    expect(updateConversationTitle).toHaveBeenCalledWith('sess-x', 'user-x', 'Mocked Agent Response')
  })
})
