/**
 * withReferences: what the selector is SHOWN (tool args, fallback summaries),
 * the `source` allow-list, the failure path and the LRU bound — the branches
 * the app-side `with-references.test.ts` does not reach (#407). The selector
 * here is a plain fake: core hosts no default (#225 L3), so none is needed.
 *
 * Each test names the source mutation that reddens it; every one was run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __clearReferenceCache,
  withReferences,
} from '@hames-ai/harness-patterns/patterns/with-references.server'
import { createContext } from '@hames-ai/harness-patterns/context.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import {
  LLMCallError,
  type ConfiguredPattern,
  type ContextEvent,
  type LLMCallRecord,
  type PatternScope,
  type ReferenceCandidate,
  type SelectorFn,
} from '@hames-ai/harness-patterns/types'

type Data = Record<string, unknown>

function result(
  id: string,
  opts: { patternId?: string; result?: unknown; summary?: string; callId?: string } = {},
): ContextEvent {
  return {
    id,
    type: 'tool_result',
    ts: 1,
    patternId: opts.patternId ?? 'web',
    data: {
      tool: 'fetch',
      result: opts.result ?? `r-${id}`,
      success: true,
      summary: opts.summary ?? `s-${id}`,
      callId: opts.callId,
    },
  }
}

function call(callId: string, args: unknown): ContextEvent {
  return {
    id: `c-${callId}`,
    type: 'tool_call',
    ts: 1,
    patternId: 'web',
    data: { tool: 'fetch', args, callId },
  }
}

function inner(): { pattern: ConfiguredPattern<Data>; fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (s: PatternScope<Data>) => s)
  return { pattern: { name: 'inner', fn, config: { patternId: 'inner' } }, fn }
}

function scope(): PatternScope<Data> {
  return { id: 'wrap', data: {}, events: [], startTime: 0 }
}

/** A selector that records what it was shown and picks everything. */
function recordingSelector(): { selector: SelectorFn; seen: ReferenceCandidate[][] } {
  const seen: ReferenceCandidate[][] = []
  const selector: SelectorFn = async ({ candidates }) => {
    seen.push(candidates)
    return {
      reasoning: 'all',
      selected: candidates.map((c) => ({ ref_id: c.ref_id, reason: 'x' })),
    }
  }
  return { selector, seen }
}

async function run(
  events: ContextEvent[],
  config: Parameters<typeof withReferences<Data>>[1],
  intent = 'q',
) {
  const ctx = createContext<Data>(intent)
  ctx.events.push(...events)
  const s = scope()
  const i = inner()
  const out = await withReferences(i.pattern, config).fn(s, createEventView(ctx))
  return { out, inner: i }
}

beforeEach(() => __clearReferenceCache())

describe('what the selector is shown', () => {
  // Mutation: `findToolArgs` returns `undefined` unconditionally → `tool_args`
  // is missing from every candidate.
  it("carries the originating tool_call's args, stringified and truncated", async () => {
    const long = 'x'.repeat(300)
    const { selector, seen } = recordingSelector()
    await run([call('k1', { q: long }), result('a', { callId: 'k1' }), result('b')], { selector })
    const [a, b] = seen[0]
    expect(a.tool_args).toBe(JSON.stringify({ q: long }).slice(0, 120) + '…')
    expect(b.tool_args).toBeUndefined()
  })

  // Mutation: `summaryFromEvent` returns `data.summary` without the
  // blank-check → the candidate's summary is the empty string.
  it('falls back to the truncated raw result when the summary is blank', async () => {
    const { selector, seen } = recordingSelector()
    const big = { rows: 'y'.repeat(200) }
    await run([result('a', { summary: '  ', result: big }), result('b', { summary: 'ok' })], {
      selector,
    })
    expect(seen[0][0].summary).toBe(JSON.stringify(big).slice(0, 120) + '…')
    expect(seen[0][1].summary).toBe('ok')
  })
})

describe('source allow-list', () => {
  // Mutation: ignore `config.source` (make `sourceList` depend on `scope`
  // only) → the `other` pattern's results become candidates too.
  it('a single source id restricts candidates to that pattern', async () => {
    const { selector, seen } = recordingSelector()
    await run(
      [
        result('a', { patternId: 'web' }),
        result('b', { patternId: 'web' }),
        result('c', { patternId: 'other' }),
      ],
      { selector, source: 'web' },
    )
    expect(seen[0].map((c) => c.ref_id)).toEqual(['a', 'b'])
  })

  // Mutation: drop the `Array.isArray` arm (always wrap in `[config.source]`)
  // → an array source is read as one nested id and matches nothing.
  it('an array source unions the listed patterns', async () => {
    const { selector, seen } = recordingSelector()
    await run(
      [
        result('a', { patternId: 'web' }),
        result('b', { patternId: 'db' }),
        result('c', { patternId: 'x' }),
      ],
      { selector, source: ['web', 'db'] },
    )
    expect(seen[0].map((c) => c.ref_id)).toEqual(['a', 'b'])
  })
})

describe('failure path', () => {
  // Mutation: drop the `LLMCallError` branch (`failedLlmCall = undefined`) →
  // the error event loses both `kind: 'llm_call'` and the call record.
  it('a failed selector call becomes an llm_call error event, and the inner pattern does not run', async () => {
    const llmCall = { functionName: 'ReferenceSelector' } as unknown as LLMCallRecord
    const selector: SelectorFn = async () => {
      throw new LLMCallError('selector down', llmCall)
    }
    const { out, inner: i } = await run([result('a'), result('b')], { selector })
    const err = out.events.find((e) => e.type === 'error')
    expect(err?.data).toEqual({ error: 'selector down', kind: 'llm_call' })
    expect(err?.llmCall).toBe(llmCall)
    expect(i.fn).not.toHaveBeenCalled()
  })

  // Mutation: spread `kind: 'llm_call'` unconditionally → a plain throw is
  // misreported as a model-call failure.
  it('a plain throw is recorded without an llm_call kind', async () => {
    const selector: SelectorFn = async () => {
      throw 'boom'
    }
    const { out } = await run([result('a'), result('b')], { selector })
    expect(out.events.find((e) => e.type === 'error')?.data).toEqual({ error: 'boom' })
  })
})

describe('decision cache', () => {
  // Mutation: delete the eviction block in `cacheSet` → the first decision
  // survives 200 later ones and the selector is not asked again.
  // Mutation: delete the re-insert in `cacheGet` → the refreshed key is the
  // oldest and gets evicted, so it is asked again.
  it('is bounded at 200 entries, evicting the least recently USED', async () => {
    const { selector, seen } = recordingSelector()
    const events = [result('a'), result('b')]
    await run(events, { selector }, 'first')
    await run(events, { selector }, 'refreshed')
    for (let i = 0; i < 198; i++) await run(events, { selector }, `fill-${i}`)
    await run(events, { selector }, 'first') // hit: moves `first` to the newest end
    expect(seen).toHaveLength(200)
    await run(events, { selector }, 'overflow') // evicts `refreshed`, the oldest
    await run(events, { selector }, 'first')
    expect(seen).toHaveLength(201)
    await run(events, { selector }, 'refreshed')
    expect(seen).toHaveLength(202)
  })
})

describe('estimateTurns', () => {
  // Mutation: `estimateTurns: () => 1` → the wrapped estimate is lost.
  // The wrapped estimate reads the settings, so they must be forwarded too.
  it("delegates to the wrapped pattern's estimate, defaulting to 1", () => {
    const { selector } = recordingSelector()
    const i = inner()
    const settings = { maxToolTurns: 5, maxRetries: 1 }
    expect(withReferences(i.pattern, { selector }).estimateTurns?.(settings)).toBe(1)
    const counted = { ...i.pattern, estimateTurns: (s: typeof settings) => s.maxToolTurns + 2 }
    expect(withReferences(counted, { selector }).estimateTurns?.(settings)).toBe(7)
  })
})
