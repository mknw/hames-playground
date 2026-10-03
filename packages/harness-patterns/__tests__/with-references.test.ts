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
  // #420. Until then the selector shared the catch that wraps the INNER pattern,
  // so a selector that threw — a describe-tier call, so a summarizer outage was
  // enough — skipped the wrapped pattern entirely, and the route did no work.
  // `DEFAULT_ERROR_SEVERITY` described the opposite ("the inner pattern ran
  // without curated prior results"); this pins the description.
  // Mutation: put the selector call back under the outer try (delete its own
  // try/catch) → the inner pattern is skipped and an `error` replaces the
  // warning.
  // Mutation: drop the `LLMCallError` branch → the warning loses the record.
  it('a failed selector call is a warning, and the inner pattern still runs with nothing attached', async () => {
    const llmCall = { functionName: 'ReferenceSelector' } as unknown as LLMCallRecord
    const selector: SelectorFn = async () => {
      throw new LLMCallError('selector down', llmCall)
    }
    const { out, inner: i } = await run([result('a'), result('b')], { selector })
    const warning = out.events.find((e) => e.type === 'warning')
    expect(warning?.data).toMatchObject({ task: 'reference_selection', error: 'selector down' })
    expect(warning?.llmCall).toBe(llmCall)
    expect(out.events.some((e) => e.type === 'error')).toBe(false)
    expect(i.fn).toHaveBeenCalledTimes(1)
    expect((i.fn.mock.calls[0][0] as PatternScope<Data>).data.attachedRefs).toEqual([])
  })

  // Mutation: `cacheSet` the failed decision (an empty selection) → the next
  // turn reads it from the cache and never asks the selector again.
  it('does not cache a failed selection — the next run asks again', async () => {
    let calls = 0
    const selector: SelectorFn = async ({ candidates }) => {
      calls += 1
      if (calls === 1) throw new Error('summarizer down')
      return { reasoning: 'ok', selected: [{ ref_id: candidates[0].ref_id, reason: 'x' }] }
    }
    await run([result('a'), result('b')], { selector })
    const { inner: i } = await run([result('a'), result('b')], { selector })
    expect(calls).toBe(2)
    expect((i.fn.mock.calls[0][0] as PatternScope<Data>).data.attachedRefs).toHaveLength(1)
  })

  // A non-Error throw is recorded by its text. No mutation claim on this one:
  // it does NOT pin the `instanceof LLMCallError` guard, because `'boom'.llmCall`
  // is undefined with or without it (PR #424 review F5 ran that mutation and it
  // survived). The next test is the one that pins the guard.
  it('a plain throw is a warning carrying its text', async () => {
    const selector: SelectorFn = async () => {
      throw 'boom'
    }
    const { out } = await run([result('a'), result('b')], { selector })
    const warning = out.events.find((e) => e.type === 'warning')
    expect(warning?.data).toMatchObject({ task: 'reference_selection', error: 'boom' })
    expect(warning?.llmCall).toBeUndefined()
  })

  // Mutation: read `(error as { llmCall?: … }).llmCall` without the
  // `instanceof LLMCallError` guard → this error's foreign `llmCall` is
  // attached as though it were the selector's own call record.
  it('only an LLMCallError contributes a call record', async () => {
    const foreign = { functionName: 'SomethingElse' }
    const selector: SelectorFn = async () => {
      throw Object.assign(new Error('not a model failure'), { llmCall: foreign })
    }
    const { out } = await run([result('a'), result('b')], { selector })
    const warning = out.events.find((e) => e.type === 'warning')
    expect(warning?.data).toMatchObject({ error: 'not a model failure' })
    expect(warning?.llmCall).toBeUndefined()
  })

  // The outer catch still owns the INNER pattern's failures, unchanged.
  // Mutation: delete the outer catch's `trackEvent(scope, 'error', …)` → reds.
  it("an inner pattern's throw is still an error event", async () => {
    const { selector } = recordingSelector()
    const ctx = createContext<Data>('q')
    ctx.events.push(result('a'), result('b'))
    const failing: ConfiguredPattern<Data> = {
      name: 'inner',
      fn: async () => {
        throw new Error('inner broke')
      },
      config: { patternId: 'inner' },
    }
    const out = await withReferences(failing, { selector }).fn(scope(), createEventView(ctx))
    expect(out.events.find((e) => e.type === 'error')?.data).toEqual({ error: 'inner broke' })
    expect(out.events.some((e) => e.type === 'warning')).toBe(false)
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
