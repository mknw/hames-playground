/**
 * #419 slice M1 — the memory recall step.
 *
 * Every test names the source mutation that reddens it; every one was run — see
 * the PR's pin/mutation table. The pins:
 *
 *   bm25-rrf-floors              — tokenizer, BM25, RRF, the floors BEFORE
 *                                  fusion, cap, budget; an irrelevant corpus
 *                                  attaches nothing
 *   tier-filter                  — a verda memory never appears on an anthropic
 *                                  turn, even from a store that ignores `tiers`
 *   per-turn-clear               — turn 2 never sees turn 1's memories after a
 *                                  skip or a failure
 *   recall-never-skips-downstream— a throwing store/embedder/gate still runs the
 *                                  next pattern, with no `error` event (#398)
 *   gate-policy                  — abstain / timeout / error / out-of-set /
 *                                  `skip` attach nothing and record why
 *   recall-threshold-method (F2) — a logprob-fitted cut is never applied to a
 *                                  Jev read; the Jev entry's own cuts apply
 *   event-hygiene                — no memory content in `serialize()`, either
 *                                  `serializeCompact()` branch or the event
 *   recall-wake                  — the wake shares the gate's budget: `waking`,
 *                                  never unbounded, never an error
 */

import { describe, expect, it } from 'vitest'
import {
  MEMORY_RECALL_KEY,
  MEMORY_RECALL_SPEC,
  formatMemoryContext,
  memoryRecall,
  type MemoryRecallConfig,
  type MemoryRecallData,
} from '@hames-ai/harness-patterns/patterns/memoryRecall.server'
import {
  STOPWORDS,
  capMemories,
  idf,
  memoryTokenBudget,
  rankMemories,
  tokenize,
  type RankInput,
} from '@hames-ai/harness-patterns/memory-ranking.server'
import { configurePattern, runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import { createContext } from '@hames-ai/harness-patterns/context.server'
import { harnessUsesMemory } from '@hames-ai/harness-patterns/pattern-capabilities'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type {
  ContextEvent,
  DecideFn,
  DecideResult,
  MemoryCandidate,
  MemoryRecalledEventData,
  MemoryStore,
} from '@hames-ai/harness-patterns/types'

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

type Data = MemoryRecallData & Record<string, unknown>

const SPACE = 'qwen3-embedding-0.6b/1024'
const NOW = Date.UTC(2026, 9, 1)

const mem = (
  id: string,
  content: string,
  similarity: number,
  extra: Partial<MemoryCandidate> = {},
): MemoryCandidate => ({
  id,
  kind: 'preference',
  tier: 'verda',
  content,
  embedSpace: SPACE,
  distance: 1 - similarity,
  lastSeenAt: NOW,
  ...extra,
})

/** A store that IGNORES the tiers it is asked for — so the core's own filter is
 *  what the tier pin measures — and records what it was asked. */
function fakeStore(rows: MemoryCandidate[], opts: { throwOn?: 'count' | 'candidates' } = {}) {
  const asked: { count: string[][]; candidates: Array<{ tiers: readonly string[] }> } = {
    count: [],
    candidates: [],
  }
  const store: MemoryStore = {
    async count(tiers) {
      asked.count.push([...tiers])
      if (opts.throwOn === 'count') throw new Error('db down')
      return rows.length
    },
    async candidates(q) {
      asked.candidates.push({ tiers: q.tiers })
      if (opts.throwOn === 'candidates') throw new Error('db down')
      return rows
    },
  }
  return { store, asked }
}

const embedder = (spaceId: string | undefined = SPACE) => ({
  query: async () => [1, 0, 0],
  ...(spaceId !== undefined ? { spaceId } : {}),
})

const logprob = (probs: Record<string, number>, extra: Partial<DecideResult> = {}) =>
  ({ probs, method: 'logprob', calibrated: true, ...extra }) as DecideResult

function fakeDecide(
  answer: (input: { state: string }) => unknown,
  extras: Pick<DecideFn, 'serving' | 'limits'> = {},
) {
  const calls: Array<{ spec: { key: string }; state: string }> = []
  const fn = (async (input: { spec: { key: string }; state: string }) => {
    calls.push(input)
    return answer(input)
  }) as unknown as DecideFn
  Object.assign(fn, extras)
  return { fn, calls }
}
const retrieves = () => fakeDecide(() => logprob({ retrieve: 0.9, skip: 0.1 }))

const visibleTiers = (t: string | undefined) =>
  t === 'verda' ? ['verda', 'anthropic'] : ['anthropic']

const TWO_TIERS = [
  mem('v1', 'prefers metric units', 0.9, { tier: 'verda' }),
  mem('a1', 'prefers metric units for recipes', 0.8, { tier: 'anthropic' }),
]

function config(over: Partial<MemoryRecallConfig> = {}): MemoryRecallConfig {
  return {
    store: fakeStore(TWO_TIERS).store,
    decide: retrieves().fn,
    embed: embedder(),
    owner: () => 'user-1',
    visibleTiers,
    tier: () => 'verda',
    ...over,
  }
}

const typesOf = (events: ContextEvent[]) => events.map((e) => e.type)
const recalled = (ctx: { events: ContextEvent[] }) =>
  ctx.events
    .filter((e) => e.type === 'memory_recalled')
    .map((e) => e.data as MemoryRecalledEventData)

async function run(
  cfg: MemoryRecallConfig,
  opts: {
    input?: string
    seed?: Data
    after?: Array<ReturnType<typeof configurePattern<Data>>>
    frame?: Parameters<typeof withRunFrame>[0]
    prior?: ContextEvent[]
  } = {},
) {
  const ctx = createContext<Data>(opts.input ?? 'what units do I prefer?', opts.seed)
  if (opts.prior) ctx.events.unshift(...opts.prior)
  await withRunFrame(opts.frame ?? {}, () =>
    runChain(ctx, [memoryRecall<Data>(cfg), ...(opts.after ?? [])]),
  )
  return ctx
}

// ============================================================================
// bm25-rrf-floors — the pure half
// ============================================================================

describe('bm25-rrf-floors: tokenizer', () => {
  it('NFKC-folds, lowercases and splits on letter/number runs', () => {
    // Full-width Latin and the ﬁ ligature fold to ASCII under NFKC.
    expect(tokenize('Ｍetric ﬁlter, 42kg')).toEqual(['metric', 'filter', '42kg'])
  })

  it('keeps an identifier WHOLE beside its parts', () => {
    const t = tokenize('see user_id and mail me at a.b@x-y.com')
    expect(t).toContain('user_id')
    expect(t).toContain('user')
    expect(t).toContain('a.b@x-y.com')
    expect(t).toContain('x')
  })

  it('drops EN/NL/FR stopwords and never stems', () => {
    expect(tokenize('the units of de eenheden les unités')).toEqual(['units', 'eenheden', 'unités'])
    for (const w of ['the', 'de', 'les', 'een', 'nous']) expect(STOPWORDS.has(w)).toBe(true)
    expect(tokenize('running runs')).toEqual(['running', 'runs'])
  })
})

describe('bm25-rrf-floors: BM25 and RRF', () => {
  const P = { minSemantic: 0.5, minIdf: 0.5 }
  const row = (id: string, content: string, semantic: number, lastSeenMs = NOW): RankInput => ({
    id,
    content,
    semantic,
    lastSeenMs,
  })

  it('idf is Lucene’s non-negative form', () => {
    expect(idf(5, 1)).toBeCloseTo(Math.log(4), 12)
    expect(idf(1, 1)).toBeCloseTo(Math.log(4 / 3), 12)
    expect(idf(2, 2)).toBeGreaterThan(0)
  })

  it('fuses with k = 60 over the two ranked lists, exactly', () => {
    // A: both channels, rank 1 in each. C: semantic rank 2, lexical rank 2.
    const r = rankMemories(
      'metric units',
      [
        row('A', 'prefers metric units', 0.9),
        row('C', 'metric system explained at length today', 0.6),
        row('X', 'likes jazz music', 0.1),
      ],
      { minSemantic: 0.5, minIdf: 0.4 },
    )
    const a = r.ranked.find((x) => x.id === 'A')!
    const c = r.ranked.find((x) => x.id === 'C')!
    expect(a.score).toBeCloseTo(1 / 61 + 1 / 61, 12)
    expect(c.score).toBeCloseTo(1 / 62 + 1 / 62, 12)
    expect(r.ranked.map((x) => x.id)).toEqual(['A', 'C'])
  })

  it('applies the floors BEFORE fusion: a junk row cannot take a rank position', () => {
    // J fails BOTH floors (semantic 0.1; its only shared terms are common) yet
    // out-scores S on raw BM25 by repeating common words; S clears the lexical
    // floor on a rare term. Ranked over survivors, S is lexical rank 1 and its
    // fused score is 1/61 + 1/61; ranked over everything, J would be rank 1
    // and S's score would drop to 1/61 + 1/62.
    const corpus = [
      row('S', 'metric zymurgy', 0.9),
      row('J', 'metric metric metric metric metric', 0.1),
      row('F1', 'metric alpha', 0.1),
      row('F2', 'metric beta', 0.1),
      row('F3', 'metric gamma', 0.1),
    ]
    const r = rankMemories('metric zymurgy', corpus, { minSemantic: 0.5, minIdf: 0.8 })
    expect(r.ranked.map((x) => x.id)).toEqual(['S'])
    expect(r.ranked[0].score).toBeCloseTo(1 / 61 + 1 / 61, 12)
    expect(r.considered).toBe(5)
  })

  it('breaks ties on s_v, then last_seen_at, then id', () => {
    const r = rankMemories(
      'zzz',
      [
        row('b', 'one', 0.7, NOW),
        row('a', 'two', 0.7, NOW),
        row('c', 'three', 0.7, NOW + 1000),
        row('d', 'four', 0.9, NOW - 5000),
      ],
      P,
    )
    // Same semantic score ranks are distinct positions, so fused scores differ
    // by rank: the order IS the semantic list's order — s_v, recency, id.
    expect(r.ranked.map((x) => x.id)).toEqual(['d', 'c', 'a', 'b'])
  })

  it('an irrelevant corpus attaches nothing', () => {
    const r = rankMemories(
      'what units do I prefer',
      [
        row('1', 'works at the harbour office', 0.2),
        row('2', 'allergic to nothing in particular', 0.3),
        row('3', 'drives a blue car', 0.25),
      ],
      P,
    )
    expect(r.ranked).toEqual([])
  })

  it('a shared term shorter than 3 characters never opens the lexical floor', () => {
    const r = rankMemories(
      'go',
      [row('1', 'go', 0.1), row('2', 'xx yy', 0.1), row('3', 'qq rr', 0.1)],
      { minSemantic: 0.9, minIdf: 0.01 },
    )
    expect(r.ranked).toEqual([])
  })

  it('the lexical floor needs a RARE term: a common one alone does not pass', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => row(id, 'metric thing' + id, 0.1))
    // `metric` is in all 5: idf ≈ 0.087 < 0.5, and every other word is unshared.
    expect(rankMemories('metric', rows, P).ranked).toEqual([])
  })
})

describe('bm25-rrf-floors: cap and budget', () => {
  it('caps by count, then by tokens, stopping at the first row that does not fit', () => {
    const items = ['aaaa', 'bbbb', 'cccc', 'dddd']
    // 4 chars → 1 token each.
    expect(capMemories(items, (s) => s, 2, 100).kept).toEqual(['aaaa', 'bbbb'])
    expect(capMemories(items, (s) => s, 10, 3)).toEqual({
      kept: ['aaaa', 'bbbb', 'cccc'],
      tokens: 3,
    })
    // A big row stops the block even though a later small one would fit.
    const mixed = ['x'.repeat(40), 'y'.repeat(4)]
    expect(capMemories(mixed, (s) => s, 10, 5).kept).toEqual([])
  })

  it('the token budget is hard-capped at 5% of the responder’s window', () => {
    expect(memoryTokenBudget(400, undefined)).toBe(400)
    expect(memoryTokenBudget(400, 8_000)).toBe(400)
    expect(memoryTokenBudget(400, 4_000)).toBe(200)
    expect(memoryTokenBudget(400, 0)).toBe(400)
  })

  it('end to end: maxMemories and the window ceiling bound what is attached', async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      mem(`m${i}`, `prefers metric units variant${i}`, 0.9 - i * 0.01),
    )
    const capped = await run(config({ store: fakeStore(rows).store, settings: { maxMemories: 3 } }))
    expect(capped.data.memories).toHaveLength(3)

    // A 300-token window → 15-token ceiling; each line is 11 tokens.
    const tight = await run(
      config({ store: fakeStore(rows).store, limits: () => ({ contextWindow: 300 }) }),
    )
    expect(tight.data.memories!.length).toBe(1)
    expect(recalled(tight)[0].tokens).toBeLessThanOrEqual(15)
  })
})

// ============================================================================
// The step: attach, skip reasons, the record
// ============================================================================

describe('memoryRecall: the happy path', () => {
  it('attaches the best matches as data.memories + memoryContext and records ids only', async () => {
    const ctx = await run(config())
    expect(ctx.status).toBe('running')
    expect(ctx.data.memories!.map((m) => m.id)).toEqual(['v1', 'a1'])
    expect(ctx.data.memoryContext).toBe(
      '- [preference] prefers metric units\n- [preference] prefers metric units for recipes',
    )
    const [ev] = recalled(ctx)
    expect(ev.attached).toEqual(['v1', 'a1'])
    expect(ev).toMatchObject({ considered: 2, survivors: 2, tier: 'verda', wake: 'awake' })
    expect(ev.skipped).toBeUndefined()
    expect(ev.gate).toMatchObject({ label: 'retrieve', abstained: false, calibrated: true })
  })

  it('asks the gate over the latest message and the previous FINAL assistant message only', async () => {
    const d = retrieves()
    await run(config({ decide: d.fn }), {
      input: 'and for the garden?',
      prior: [
        { type: 'user_message', ts: 1, patternId: 'u', data: { content: 'older question' } },
        {
          type: 'assistant_message',
          ts: 2,
          patternId: 'a',
          data: { content: 'status line', final: false },
        },
        {
          type: 'assistant_message',
          ts: 3,
          patternId: 'a',
          data: { content: 'the final answer', final: true },
        },
      ] as ContextEvent[],
    })
    expect(d.calls[0].spec.key).toBe(MEMORY_RECALL_KEY)
    expect(d.calls[0].state).toBe('Assistant: the final answer\n\nUser: and for the garden?')
    expect(MEMORY_RECALL_SPEC.labels.map((l) => l.id)).toEqual(['retrieve', 'skip'])
  })

  it('never puts memory content in the gate state', async () => {
    const d = retrieves()
    await run(config({ decide: d.fn }))
    expect(d.calls[0].state).not.toContain('metric')
  })

  it('formats one line per memory without the id', () => {
    expect(
      formatMemoryContext([{ id: 'secret-id', kind: 'trait', tier: 'verda', content: 'a\n b' }]),
    ).toBe('- [trait] a b')
  })
})

describe('memoryRecall: skip reasons', () => {
  it('no owner → no-user, and nothing is asked of the store or the gate', async () => {
    const { store, asked } = fakeStore(TWO_TIERS)
    const d = retrieves()
    const ctx = await run(config({ owner: () => null, store, decide: d.fn }))
    expect(recalled(ctx)[0]).toMatchObject({ skipped: 'no-user', attached: [] })
    expect(asked.count).toEqual([])
    expect(d.calls).toHaveLength(0)
  })

  it('the switch off → disabled', async () => {
    const ctx = await run(config({ settings: { enabled: () => false } }))
    expect(recalled(ctx)[0].skipped).toBe('disabled')
  })

  it('nothing visible → empty, with no gate and no embedding paid', async () => {
    let embedded = 0
    const d = retrieves()
    const ctx = await run(
      config({
        store: fakeStore([]).store,
        decide: d.fn,
        embed: {
          spaceId: SPACE,
          query: async () => {
            embedded++
            return [1]
          },
        },
      }),
    )
    expect(recalled(ctx)[0].skipped).toBe('empty')
    expect(d.calls).toHaveLength(0)
    expect(embedded).toBe(0)
  })

  it('no user message → no-query', async () => {
    const ctx = await run(config(), { input: '   ' })
    expect(recalled(ctx)[0].skipped).toBe('no-query')
  })

  it('the gate says retrieve but nothing clears the floors → no-match', async () => {
    const ctx = await run(
      config({ store: fakeStore([mem('x', 'works at the harbour office', 0.1)]).store }),
    )
    expect(recalled(ctx)[0]).toMatchObject({ skipped: 'no-match', survivors: 0, attached: [] })
    expect(ctx.data.memories).toEqual([])
  })

  it('refuses a row from another embedding space', async () => {
    const ctx = await run(
      config({
        store: fakeStore([mem('old', 'prefers metric units', 0.9, { embedSpace: 'old/512' })])
          .store,
      }),
    )
    expect(recalled(ctx)[0]).toMatchObject({ skipped: 'error', attached: [] })
    expect(ctx.data.memories).toEqual([])
  })
})

// ============================================================================
// tier-filter
// ============================================================================

describe('tier-filter', () => {
  it('an anthropic turn never sees a verda memory, though the store returns one', async () => {
    const { store, asked } = fakeStore(TWO_TIERS)
    const ctx = await run(config({ store, tier: () => 'anthropic' }))
    expect(ctx.data.memories!.map((m) => m.id)).toEqual(['a1'])
    expect(recalled(ctx)[0]).toMatchObject({ attached: ['a1'], considered: 1, tier: 'anthropic' })
    // And the store was ASKED only for what the turn may read.
    expect(asked.count[0]).toEqual(['anthropic'])
    expect(asked.candidates[0].tiers).toEqual(['anthropic'])
  })

  it('a verda turn sees both tiers', async () => {
    const ctx = await run(config({ tier: () => 'verda' }))
    expect(ctx.data.memories!.map((m) => m.id).sort()).toEqual(['a1', 'v1'])
  })

  it('reads the turn’s tier from the run frame when no resolver is given', async () => {
    const { tier: _t, ...rest } = config()
    const ctx = await run(rest, { frame: { inference: { tier: 'anthropic' } } })
    expect(ctx.data.memories!.map((m) => m.id)).toEqual(['a1'])
  })

  it('a tier the host maps to nothing is empty, not everything', async () => {
    const ctx = await run(config({ tier: () => 'mystery', visibleTiers: () => [] }))
    expect(recalled(ctx)[0].skipped).toBe('empty')
  })
})

// ============================================================================
// per-turn-clear
// ============================================================================

describe('per-turn-clear', () => {
  const STALE: Data = {
    memories: [{ id: 'old', kind: 'trait', tier: 'verda', content: 'turn one leftover' }],
    memoryContext: '- [trait] turn one leftover',
  }
  const cases: Array<[string, Partial<MemoryRecallConfig>]> = [
    ['no owner', { owner: () => null }],
    ['switch off', { settings: { enabled: () => false } }],
    ['the gate says skip', { decide: fakeDecide(() => logprob({ retrieve: 0.1, skip: 0.9 })).fn }],
    ['the gate abstains', { decide: fakeDecide(() => logprob({ retrieve: 0.55, skip: 0.45 })).fn }],
    ['an empty store', { store: fakeStore([]).store }],
    ['nothing clears the floors', { store: fakeStore([mem('x', 'unrelated', 0.1)]).store }],
    ['the store throws', { store: fakeStore(TWO_TIERS, { throwOn: 'candidates' }).store }],
    [
      'the embedder throws',
      { embed: { spaceId: SPACE, query: async () => Promise.reject(new Error('down')) } },
    ],
    ['the wake is skipped', { awaitWake: async () => 'skipped' as const }],
  ]

  it.each(cases)('%s: turn 2 does not inherit turn 1’s memories', async (_name, over) => {
    const ctx = await run(config(over), { seed: STALE })
    expect(ctx.data.memories).toEqual([])
    expect(ctx.data.memoryContext).toBe('')
  })

  it('a success replaces them', async () => {
    const ctx = await run(config(), { seed: STALE })
    expect(ctx.data.memories!.map((m) => m.id)).not.toContain('old')
    expect(ctx.data.memoryContext).not.toContain('leftover')
  })
})

// ============================================================================
// recall-never-skips-downstream
// ============================================================================

describe('recall-never-skips-downstream', () => {
  const failures: Array<[string, Partial<MemoryRecallConfig>]> = [
    ['count throws', { store: fakeStore(TWO_TIERS, { throwOn: 'count' }).store }],
    ['candidates throws', { store: fakeStore(TWO_TIERS, { throwOn: 'candidates' }).store }],
    ['the embedder rejects', { embed: { query: async () => Promise.reject(new Error('x')) } }],
    ['the gate throws', { decide: fakeDecide(() => Promise.reject(new Error('x'))).fn }],
    [
      'the switch throws',
      {
        settings: {
          enabled: () => {
            throw new Error('x')
          },
        },
      },
    ],
    [
      'the owner resolver throws',
      {
        owner: () => {
          throw new Error('x')
        },
      },
    ],
    [
      'the wake rejects',
      { awaitWake: () => Promise.reject(new Error('x')) as Promise<'awake' | 'skipped'> },
    ],
  ]

  it.each(failures)(
    '%s: the next pattern still runs, the turn is not an error',
    async (_n, over) => {
      let ran = 0
      const next = configurePattern<Data>('next', async (scope) => {
        ran++
        return scope
      })
      const ctx = await run(config(over), { after: [next] })
      expect(ran).toBe(1)
      expect(ctx.status).toBe('running')
      expect(ctx.error).toBeUndefined()
      // Memory is opportunistic: no `error` event for a turn-level reader to act on.
      expect(typesOf(ctx.events)).not.toContain('error')
      expect(recalled(ctx)).toHaveLength(1)
      expect(recalled(ctx)[0].attached).toEqual([])
    },
  )
})

// ============================================================================
// gate-policy
// ============================================================================

describe('gate-policy', () => {
  const nothingAttached = (ctx: Awaited<ReturnType<typeof run>>) => {
    expect(ctx.data.memories).toEqual([])
    expect(recalled(ctx)[0].attached).toEqual([])
  }

  it('an abstain (low confidence) attaches nothing — though its argmax is retrieve', async () => {
    const ctx = await run(
      config({ decide: fakeDecide(() => logprob({ retrieve: 0.55, skip: 0.45 })).fn }),
    )
    nothingAttached(ctx)
    expect(recalled(ctx)[0]).toMatchObject({
      skipped: 'gate',
      gate: { abstained: true, top: 'retrieve', label: 'skip', reason: 'low-confidence' },
    })
  })

  it('a low margin abstains', async () => {
    const ctx = await run(
      config({
        decide: fakeDecide(() => logprob({ retrieve: 0.7, skip: 0.3 })).fn,
        settings: { gate: { minConfidence: 0.1, minMargin: 0.6 } },
      }),
    )
    nothingAttached(ctx)
    expect(recalled(ctx)[0].gate?.reason).toBe('low-margin')
  })

  it('a decided skip attaches nothing', async () => {
    const ctx = await run(
      config({ decide: fakeDecide(() => logprob({ retrieve: 0.05, skip: 0.95 })).fn }),
    )
    nothingAttached(ctx)
    expect(recalled(ctx)[0]).toMatchObject({
      skipped: 'gate',
      gate: { label: 'skip', abstained: false },
    })
  })

  it('a throwing gate attaches nothing and records the abstain', async () => {
    const ctx = await run(config({ decide: fakeDecide(() => Promise.reject(new Error('503'))).fn }))
    nothingAttached(ctx)
    expect(recalled(ctx)[0]).toMatchObject({
      skipped: 'gate',
      gate: { abstained: true, reason: 'error' },
    })
  })

  it('an out-of-set label attaches nothing', async () => {
    const ctx = await run(config({ decide: fakeDecide(() => logprob({ bogus: 1 })).fn }))
    nothingAttached(ctx)
    expect(recalled(ctx)[0].skipped).toBe('gate')
  })

  it('a gate slower than its budget attaches nothing and records the timeout', async () => {
    const never = fakeDecide(() => new Promise(() => {}))
    const ctx = await run(config({ decide: never.fn, settings: { gate: { timeoutMs: 20 } } }))
    nothingAttached(ctx)
    expect(recalled(ctx)[0].skipped).toBe('timeout')
  })

  it('records NO decision_made: recall’s outcome lives only in memory_recalled', async () => {
    const ctx = await run(config())
    expect(typesOf(ctx.events)).not.toContain('decision_made')
    expect(typesOf(ctx.events)).toContain('memory_recalled')
  })
})

// ============================================================================
// recall-threshold-method (#418 F2)
// ============================================================================

describe('recall-threshold-method', () => {
  const jev = (probs: Record<string, number>) => logprobLike(probs, 'jev')
  function logprobLike(probs: Record<string, number>, method: 'jev' | 'logprob') {
    return { probs, method, calibrated: true } as DecideResult
  }

  it('the Jev entry’s OWN cuts apply — a logprob-fitted static cut is never applied to a Jev read', async () => {
    // margin 0.2 / confidence 0.2: below the static 0.5 / 0.25, above the
    // entry's own 0.1 / 0.1.
    const d = fakeDecide(() => jev({ retrieve: 0.6, skip: 0.4 }), {
      serving: () => ({ method: 'jev', calibration: { minConfidence: 0.1, minMargin: 0.1 } }),
    })
    const ctx = await run(config({ decide: d.fn }))
    expect(ctx.data.memories!.length).toBeGreaterThan(0)
    expect(recalled(ctx)[0].gate).toMatchObject({ method: 'jev', abstained: false })
  })

  it('with NO entry for the serving method, the gate abstains method-mismatch', async () => {
    const d = fakeDecide(() => jev({ retrieve: 0.99, skip: 0.01 }), {
      serving: () => ({ method: 'jev' }),
    })
    const ctx = await run(config({ decide: d.fn }))
    expect(ctx.data.memories).toEqual([])
    expect(recalled(ctx)[0]).toMatchObject({
      skipped: 'gate',
      gate: { abstained: true, reason: 'method-mismatch', method: 'jev' },
    })
  })

  it('the same absent-serving mismatch is caught after the call, from the result', async () => {
    const d = fakeDecide(() => jev({ retrieve: 0.99, skip: 0.01 }))
    const ctx = await run(config({ decide: d.fn }))
    expect(recalled(ctx)[0].gate?.reason).toBe('method-mismatch')
  })

  it('a logprob read still honours the static cuts', async () => {
    const weak = fakeDecide(() => logprobLike({ retrieve: 0.6, skip: 0.4 }, 'logprob'))
    const ctx = await run(config({ decide: weak.fn }))
    expect(ctx.data.memories).toEqual([])
    expect(recalled(ctx)[0].gate?.reason).toBe('low-confidence')
  })

  it('a host whose static cuts were fitted on Jev says so, and they apply to Jev', async () => {
    const d = fakeDecide(() => jev({ retrieve: 0.9, skip: 0.1 }))
    const ctx = await run(config({ decide: d.fn, settings: { gate: { thresholdMethod: 'jev' } } }))
    expect(ctx.data.memories!.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// recall-wake — the shape M5 wires against `awaitMemoryWake`
// ============================================================================

describe('recall-wake', () => {
  it('a wake that has not landed within the budget → skipped: waking, nothing attached', async () => {
    const budgets: number[] = []
    const ctx = await run(
      config({
        settings: { gate: { timeoutMs: 25 } },
        awaitWake: (b) => {
          budgets.push(b)
          return new Promise(() => {})
        },
      }),
    )
    expect(budgets).toEqual([25]) // the wake is given the gate's budget
    expect(recalled(ctx)[0]).toMatchObject({ skipped: 'waking', attached: [] })
    expect(ctx.data.memories).toEqual([])
    expect(typesOf(ctx.events)).not.toContain('error')
  })

  it('a wake that reports skipped → waking, even when the gate and the search finished', async () => {
    const ctx = await run(config({ awaitWake: async () => 'skipped' }))
    expect(recalled(ctx)[0]).toMatchObject({ skipped: 'waking', wake: 'skipped' })
    expect(ctx.data.memories).toEqual([])
  })

  it('a landed wake costs the turn nothing and is recorded', async () => {
    const ctx = await run(config({ awaitWake: async () => 'awake' }))
    expect(recalled(ctx)[0]).toMatchObject({ wake: 'awake' })
    expect(ctx.data.memories!.length).toBeGreaterThan(0)
  })

  it('runs the gate, the search and the wake CONCURRENTLY, not in sequence', async () => {
    const order: string[] = []
    const d = fakeDecide(async () => {
      order.push('gate')
      return logprob({ retrieve: 0.9, skip: 0.1 })
    })
    const base = fakeStore(TWO_TIERS).store
    await run(
      config({
        decide: d.fn,
        store: {
          count: base.count,
          candidates: async (q) => {
            order.push('search')
            return base.candidates(q)
          },
        },
        awaitWake: async () => {
          order.push('wake')
          return 'awake'
        },
      }),
    )
    expect(new Set(order)).toEqual(new Set(['wake', 'gate', 'search']))
    // All three started before any of them could have been awaited in turn.
    expect(order).toHaveLength(3)
  })
})

// ============================================================================
// event-hygiene
// ============================================================================

describe('event-hygiene', () => {
  const SENTINEL = '⟦SENTINEL-memory-content⟧'
  const rows = [mem('m-1', `prefers metric units ${SENTINEL}`, 0.9)]

  /** An older turn holding a tool_result, so `serializeCompact` takes BOTH of
   *  its branches: the older result rendered compactly, the recent one in full. */
  const OLDER_TURN = [
    { type: 'user_message', ts: 1, patternId: 'u', data: { content: 'older question' } },
    { id: 'tr-1', type: 'tool_result', ts: 2, patternId: 't', data: { tool: 'x', result: 'r' } },
  ] as ContextEvent[]

  const everySurface = (ctx: ReturnType<typeof createContext<Data>>) => {
    const view = createEventView(ctx)
    return [
      view.serialize(),
      view.serializeCompact(),
      view.serializeCompact({ recentTurns: 2 }),
      ctx.events.map((e) => JSON.stringify({ type: e.type, data: e.data })).join('\n'),
    ]
  }

  it('memory content is absent from memory_recalled and from every serialization', async () => {
    const ctx = await run(config({ store: fakeStore(rows).store }), { prior: OLDER_TURN })
    // The content DID reach the prompt-side data — that is what recall is for.
    expect(JSON.stringify(ctx.data.memories)).toContain(SENTINEL)
    expect(ctx.data.memoryContext).toContain(SENTINEL)
    // …and nowhere an event can carry it.
    for (const surface of everySurface(ctx as never)) expect(surface).not.toContain(SENTINEL)
    expect(recalled(ctx)[0].attached).toEqual(['m-1'])
  })

  it('the skipped branches are clean too', async () => {
    const ctx = await run(
      config({ store: fakeStore(rows).store, decide: fakeDecide(() => logprob({ skip: 1 })).fn }),
      { prior: OLDER_TURN },
    )
    for (const surface of everySurface(ctx as never)) expect(surface).not.toContain(SENTINEL)
  })

  it('a failure records the error CLASS, never its message', async () => {
    const boom = fakeStore(rows, { throwOn: 'candidates' })
    boom.store.candidates = async () => {
      throw new TypeError(`could not read ${SENTINEL}`)
    }
    const ctx = await run(config({ store: boom.store }), { prior: OLDER_TURN })
    expect(recalled(ctx)[0]).toMatchObject({ skipped: 'error', errorKind: 'TypeError' })
    for (const surface of everySurface(ctx as never)) expect(surface).not.toContain(SENTINEL)
  })

  it('the LLM-facing line is metadata only', async () => {
    const ctx = await run(config({ store: fakeStore(rows).store }))
    expect(createEventView(ctx as never).serialize()).toContain('memory recalled: 1 attached')
  })
})

// ============================================================================
// Declared capability and defaults
// ============================================================================

describe('capability and defaults', () => {
  it('declares the memory capability and the decision key; harnessUsesMemory finds it, nested', () => {
    const p = memoryRecall<Data>(config())
    expect(p.capabilities).toMatchObject({ memory: true, decisionKeys: [MEMORY_RECALL_KEY] })
    expect(p.estimateTurns?.({} as never)).toBe(0)
    expect(p.config).toMatchObject({ commitStrategy: 'always', errorSeverity: 'recoverable' })
    expect(harnessUsesMemory([p])).toBe(true)
    expect(harnessUsesMemory([{ ...p, capabilities: undefined, children: [p] }])).toBe(true)
    expect(harnessUsesMemory([configurePattern<Data>('plain', async (s) => s)])).toBe(false)
    expect(harnessUsesMemory(undefined)).toBe(false)
  })

  it('is absent from a harness that did not opt in', () => {
    expect(harnessUsesMemory([])).toBe(false)
  })
})
