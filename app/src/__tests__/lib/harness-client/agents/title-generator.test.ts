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
import { testAgentDeps } from './test-deps'

// `agents/title-generator.server.ts` imports `harness-patterns` (which
// asserts server-only on import) and `db/conversations.server` (which
// needs a pg pool). Mock both before dynamic-importing the SUT.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
vi.mock('../../../../lib/db/conversations.server', () => ({
  updateConversationTitle: vi.fn(async () => undefined),
}))
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: {
    GenerateConversationTitle: vi.fn(async (msg: string) => `Title For ${msg.slice(0, 8)}`),
  },
}))
vi.mock('@hames-ai/harness-patterns', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@hames-ai/harness-patterns')
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

const { updateConversationTitle } = await import('../../../../lib/db/conversations.server')
const persistDeps = { ...testAgentDeps, persistTitle: updateConversationTitle }
const sut = await import('@hames-ai/agents/agents/title-generator.server')

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

  // #454: the two ends were stripped separately, so a closing quote that
  // belongs to the title was taken without its opening partner. Output before
  // the fix, recorded 2026-10-03: `Review of "Dune"` → `Review of "Dune`.
  // Mutation: restore the end-wise strip `.replace(/^["'`]+|["'`]+$/g, '')`
  // in place of the pair loop → `Review of "Dune`.
  it('keeps a quoted span that ends the title', () => {
    expect(sut.sanitizeTitle('Review of "Dune"')).toBe('Review of "Dune"')
  })

  // #454: punctuation is stripped whether it sits outside the wrapping quotes
  // or inside them. Output before the fix, recorded 2026-10-03:
  // `"Title".` → `Title"` (the `.` hid the closing quote from the strip).
  // Mutation: strip punctuation once, AFTER the pair loop, instead of on each
  // pass → `"Title".` keeps its quotes.
  // Mutation: strip punctuation once, BEFORE the pair loop → `"Title."` keeps
  // its `.`.
  it('strips trailing punctuation outside or inside the wrapping quotes', () => {
    expect(sut.sanitizeTitle('"Title".')).toBe('Title')
    expect(sut.sanitizeTitle('"Title."')).toBe('Title')
  })

  // #454: matching quote characters at both ends are not a pair when each
  // belongs to its own span; peeling them would leave `Dune" and "Arrakis`.
  // Mutation: have the pair test answer true once both ends match, without
  // looking inside → `Dune" and "Arrakis`.
  it('leaves two quoted spans that open and close the title', () => {
    expect(sut.sanitizeTitle('"Dune" and "Arrakis"')).toBe('"Dune" and "Arrakis"')
  })

  // Mutation: refuse the pair whenever the same quote appears inside → the
  // wrapping quotes stay on.
  // Mutation: count an inner quote as opening only at the very start (drop
  // the after-a-space case) → the wrapping quotes stay on.
  it('strips wrapping quotes around a title that holds a quoted span', () => {
    expect(sut.sanitizeTitle('"Review of "Dune""')).toBe('Review of "Dune"')
    expect(sut.sanitizeTitle(`'Review of "Dune"'`)).toBe('Review of "Dune"')
  })

  // An inner quote after an opening bracket or a dash opens a span, as one
  // after a space does; `main` stripped both of these.
  // Mutation: revert the class to `/\s/` → both keep their wrapping quotes.
  it('strips wrapping quotes when the inner span opens after a bracket or a dash', () => {
    expect(sut.sanitizeTitle('"Review ("Dune")"')).toBe('Review ("Dune")')
    expect(sut.sanitizeTitle('"Notes on—"Dune""')).toBe('Notes on—"Dune"')
  })

  // An inner quote after punctuation that ends a word still closes the
  // leading quote.
  // Mutation: `return i === 0 || !LETTER_OR_DIGIT.test(before)` (an inner quote
  // opens after any non-word character) → `Dune!" and "Arrakis`.
  it('leaves two quoted spans when the first ends in punctuation', () => {
    expect(sut.sanitizeTitle('"Dune!" and "Arrakis"')).toBe('"Dune!" and "Arrakis"')
    expect(sut.sanitizeTitle('"Dune", "Arrakis"')).toBe('"Dune", "Arrakis"')
  })

  // Mutation: drop the apostrophe exemption → the `'` in `Dune's` reads as
  // closing the leading quote, and the wrapping quotes stay on.
  it('treats an apostrophe inside a single-quoted title as part of a word', () => {
    expect(sut.sanitizeTitle("'Dune's Ending'")).toBe("Dune's Ending")
  })

  // Mutation: `const LETTER_OR_DIGIT = /[\p{L}]/u` (letters only) → the `'`
  // after `10` reads as closing the leading quote, and the quotes stay on.
  it('treats an apostrophe after a digit as part of a word', () => {
    expect(sut.sanitizeTitle("'Top 10's Picks'")).toBe("Top 10's Picks")
  })

  // Accepted behaviour change (owner call O1 on #459): a quote that ends a
  // word inside a single-quoted title looks the same as the one closing
  // `'Dune'` in `'Dune' and 'Arrakis'`, so the wrapping pair is kept. `main`
  // stripped it to `The Jones' House`.
  // Mutation: `if (LETTER_OR_DIGIT.test(before)) continue` (exempt on the
  // letter before only) → `The Jones' House`.
  it("keeps the wrapping quotes when an inner quote ends a word ('The Jones' House')", () => {
    expect(sut.sanitizeTitle("'The Jones' House'")).toBe("'The Jones' House'")
  })

  // #454: a quote is only removed together with its partner. Output before the
  // fix, recorded 2026-10-03: both came back `Dune Review`.
  // Mutation: drop the `title.endsWith(q)` check → the first loses its last
  // letter (`Dune Revie`).
  // Mutation: accept any quote at the end (`QUOTES.has(title.at(-1))`) → the
  // second comes back `Dune Review`.
  it('keeps a quote that has no partner at the other end', () => {
    expect(sut.sanitizeTitle('"Dune Review')).toBe('"Dune Review')
    expect(sut.sanitizeTitle(`"Dune Review'`)).toBe(`"Dune Review'`)
  })

  // Mutation: drop the `.trim()` at the top of the strip loop → the padding
  // inside the quotes survives (` Title `).
  it('trims the padding inside wrapping quotes', () => {
    expect(sut.sanitizeTitle('" Title "')).toBe('Title')
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
    // Mutation: refuse a "pair" shorter than two characters → a lone quote
    // comes back as the title `"`.
    expect(sut.sanitizeTitle('"')).toBeNull()
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
    const result = await sut.runFirstTurnTitleGen(ctx, 's1', 'u1', persistDeps)
    expect(result).toBeNull()
    expect(updateConversationTitle).not.toHaveBeenCalled()
  })

  it('skips when there are already 2+ user messages (regen only via on-demand path)', async () => {
    const ctx = {
      sessionId: 's',
      createdAt: 0,
      events: [
        {
          id: 'u1',
          type: 'user_message' as const,
          ts: 1,
          patternId: 'h',
          data: { content: 'first' },
        },
        {
          id: 'u2',
          type: 'user_message' as const,
          ts: 2,
          patternId: 'h',
          data: { content: 'second' },
        },
      ],
      status: 'done' as const,
      input: 'second',
      data: {},
    }
    const result = await sut.runFirstTurnTitleGen(ctx, 's1', 'u1', persistDeps)
    expect(result).toBeNull()
  })

  it('runs on first turn and persists the sanitized title', async () => {
    vi.mocked(updateConversationTitle).mockClear()
    const ctx = {
      sessionId: 's',
      createdAt: 0,
      events: [
        {
          id: 'u1',
          type: 'user_message' as const,
          ts: 1,
          patternId: 'h',
          data: { content: 'first message' },
        },
      ],
      status: 'done' as const,
      input: 'first message',
      data: {},
    }
    const result = await sut.runFirstTurnTitleGen(ctx, 'sess-1', 'user-1', persistDeps)
    // The mocked harness returns 'Mocked Agent Response' which sanitizes to itself.
    expect(result).toBe('Mocked Agent Response')
    expect(updateConversationTitle).toHaveBeenCalledWith(
      'sess-1',
      'user-1',
      'Mocked Agent Response',
    )
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
    const result = await sut.runRegenerateTitle(ctx, 's1', 'u1', persistDeps)
    expect(result).toBeNull()
    expect(updateConversationTitle).not.toHaveBeenCalled()
  })

  it('runs regardless of message count (unlike runFirstTurnTitleGen)', async () => {
    vi.mocked(updateConversationTitle).mockClear()
    const ctx = {
      sessionId: 's',
      createdAt: 0,
      events: [
        {
          id: 'u1',
          type: 'user_message' as const,
          ts: 1,
          patternId: 'h',
          data: { content: 'first' },
        },
        {
          id: 'u2',
          type: 'user_message' as const,
          ts: 2,
          patternId: 'h',
          data: { content: 'latest' },
        },
        {
          id: 'u3',
          type: 'user_message' as const,
          ts: 3,
          patternId: 'h',
          data: { content: 'newest' },
        },
      ],
      status: 'done' as const,
      input: 'newest',
      data: {},
    }
    const result = await sut.runRegenerateTitle(ctx, 'sess-x', 'user-x', persistDeps)
    expect(result).toBe('Mocked Agent Response')
    expect(updateConversationTitle).toHaveBeenCalledWith(
      'sess-x',
      'user-x',
      'Mocked Agent Response',
    )
  })
})
