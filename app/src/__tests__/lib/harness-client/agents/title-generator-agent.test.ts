/**
 * Title Generator — the agent itself, through the REAL harness.
 *
 * `title-generator.test.ts` stubs `harness()` to test the gates; this file
 * keeps it real and fakes only the BAML call, so the `synthesize` body — the
 * describe-role client override and the sanitizer on the model's raw output —
 * and `runTitleAgent`'s three exits are exercised (#407).
 *
 * Each test names the source mutation that reddens it; every one was run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testAgentDeps } from './test-deps'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
const generate = vi.fn<(msg: string, opts?: Record<string, unknown>) => Promise<string>>()
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: {
    GenerateConversationTitle: (msg: string, opts?: Record<string, unknown>) => generate(msg, opts),
  },
}))

const sut = await import('@hames-ai/agents/agents/title-generator.server')

afterEach(() => {
  generate.mockReset()
  vi.restoreAllMocks()
})

describe('createTitleAgent', () => {
  // Mutation: drop `...(deps.clientOverride?.('describe') ?? {})` from the
  // BAML call → the override never reaches the options bag, so a private-tier
  // title would be generated off the box.
  // Mutation: ask for a different role (`clientOverride?.('synthesizer')`) →
  // the recorded role changes.
  it("spreads the describe role's client override into the BAML call", async () => {
    generate.mockResolvedValue('Box Title')
    const clientOverride = vi.fn(() => ({ client: 'LocalQwenSmall' }))
    await sut.createTitleAgent({ ...testAgentDeps, clientOverride })('hello', 's')
    expect(clientOverride).toHaveBeenCalledWith('describe')
    expect(generate).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ client: 'LocalQwenSmall' }),
    )
  })

  // Mutation: return `{ value: raw }` instead of `sanitizeTitle(raw) ?? ''` →
  // the quotes and trailing punctuation reach the response.
  it("sanitizes the model's raw output into the response", async () => {
    generate.mockResolvedValue('"Graph Styling Tips."')
    const result = await sut.createTitleAgent(testAgentDeps)('hello', 's')
    expect(result.response).toBe('Graph Styling Tips')
  })

  // #409: the quote and punctuation strips ran on the ends of the WHOLE reply
  // before the first line was taken, so a quoted first line followed by more
  // text kept its closing quote. Output before the fix, recorded 2026-09-28:
  //   '"Graph Styling Tips."\nextra line' → 'Graph Styling Tips."'
  // Mutation: move `.split('\n')[0]` back after the two strips → both
  // expectations keep a stray `"` (and the first a stray `.`).
  it('sanitizes a multi-line reply on its first line', () => {
    expect(sut.sanitizeTitle('"Graph Styling Tips."\nextra line')).toBe('Graph Styling Tips')
    expect(sut.sanitizeTitle('"Graph Styling Tips"\nHere is why…')).toBe('Graph Styling Tips')
  })

  // Mutation: drop the `.trim()` between the split and the strips → the `\r`
  // a CRLF reply leaves on its first line hides the closing quote from the
  // strip, and the title is `Graph Styling Tips"`.
  it('sanitizes the first line of a CRLF reply', () => {
    expect(sut.sanitizeTitle('"Graph Styling Tips"\r\nHere is why')).toBe('Graph Styling Tips')
  })

  // Mutation: drop the leading `.trim()` → the first line of the reply is the
  // empty one, and the title is null.
  it('skips blank lines ahead of the title', () => {
    expect(sut.sanitizeTitle('\n\n"Graph Styling Tips"\nHere is why')).toBe('Graph Styling Tips')
  })

  // The user-visible path: the agent's response, not just the helper.
  // Mutation: the #409 one above → the response keeps the stray quote.
  it("sanitizes a multi-line model reply into the agent's response", async () => {
    generate.mockResolvedValue('"Graph Styling Tips"\nHere is why this title fits.')
    const result = await sut.createTitleAgent(testAgentDeps)('hello', 's')
    expect(result.response).toBe('Graph Styling Tips')
  })
})

describe('runRegenerateTitle through the real agent', () => {
  const ctx = (content: string) => ({
    sessionId: 's',
    createdAt: 0,
    events: [{ id: 'u', type: 'user_message' as const, ts: 1, patternId: 'h', data: { content } }],
    status: 'done' as const,
    input: content,
    data: {},
  })

  // Mutation: delete `if (!title) return null` → an empty title is persisted.
  it('returns null and persists nothing when the model output sanitizes to nothing', async () => {
    generate.mockResolvedValue('   ')
    const persistTitle = vi.fn(async () => undefined)
    expect(
      await sut.runRegenerateTitle(ctx('m'), 's', 'u', { ...testAgentDeps, persistTitle }),
    ).toBeNull()
    expect(persistTitle).not.toHaveBeenCalled()
  })

  // Mutation: delete the `console.warn` in the no-`persistTitle` branch → the
  // unpersisted title is silent.
  it('still returns the title without a persistence channel, and says so', async () => {
    generate.mockResolvedValue('Unsaved Title')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await sut.runRegenerateTitle(ctx('m'), 's', 'u', testAgentDeps)).toBe('Unsaved Title')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no persistTitle'))
  })

  // Mutation: re-throw from the catch (`throw err`) → the regenerate action
  // rejects instead of leaving the heuristic title in place.
  it('returns null and logs when persistence throws', async () => {
    generate.mockResolvedValue('Good Title')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const persistTitle = vi.fn(async () => {
      throw new Error('db down')
    })
    expect(
      await sut.runRegenerateTitle(ctx('m'), 's', 'u', { ...testAgentDeps, persistTitle }),
    ).toBeNull()
    expect(error).toHaveBeenCalledWith(
      '[title-gen] could not persist the title:',
      expect.any(Error),
    )
  })

  // The button's contract survives #420: a failed generation still answers null.
  // Mutation: delete the `.catch` in `runRegenerateTitle` → it rejects.
  it('returns null when the generation itself fails', async () => {
    generate.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8095'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const persistTitle = vi.fn(async () => undefined)
    expect(
      await sut.runRegenerateTitle(ctx('m'), 's', 'u', { ...testAgentDeps, persistTitle }),
    ).toBeNull()
    expect(persistTitle).not.toHaveBeenCalled()
  })
})

// #420: the harness never throws for a failed generation — `compactExecution`
// catches and the run settles as `status: 'error'` with an empty response — and
// `runTitleAgent` read only the response, so a summarizer outage was the same
// silent `null` as a blank title. The first-turn entry point now REJECTS, which
// is what lets the turn say so.
describe('runFirstTurnTitleGen through the real agent', () => {
  const firstTurn = {
    sessionId: 's',
    createdAt: 0,
    events: [
      { id: 'u', type: 'user_message' as const, ts: 1, patternId: 'h', data: { content: 'hi' } },
    ],
    status: 'done' as const,
    input: 'hi',
    data: {},
  }

  // Mutation: delete the `result.status === 'error'` throw → resolves null.
  it('rejects with the failure when the summarizer call fails, and persists nothing', async () => {
    generate.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8095'))
    const persistTitle = vi.fn(async () => undefined)
    await expect(
      sut.runFirstTurnTitleGen(firstTurn, 's', 'u', { ...testAgentDeps, persistTitle }),
    ).rejects.toThrow('ECONNREFUSED')
    expect(persistTitle).not.toHaveBeenCalled()
  })

  it('still answers null — not a rejection — for a blank title', async () => {
    generate.mockResolvedValue('   ')
    await expect(sut.runFirstTurnTitleGen(firstTurn, 's', 'u', testAgentDeps)).resolves.toBeNull()
  })
})
