/**
 * NEW (PR #926 correctness review, uncommitted): a discriminating pin for the
 * EXACT byte comparison behind `repeatOf` (decisionLoop-records.server).
 *
 * The author's five mutations all target the mark being SET or CONSUMED; none
 * pins that the comparison is the whole result rather than a prefix of it. A
 * weaker comparison (e.g. first-50-chars) would falsely mark a retriever read
 * whose excerpt differs only later in the line as a repeat, and two such reads
 * in a row would withhold a route that keeps finding new information.
 *
 * MUTATION this pin turns red: in `repeatOf`, replace
 *   `p.result === r.result`
 * with
 *   `String(p.result).slice(0, 50) === String(r.result).slice(0, 50)`
 * → the second and third reads are falsely marked repeats → `read` is withheld
 * at the fourth decision → red. On the shipped code the reads' results differ
 * beyond the first 50 characters, so every read makes progress and `read` is
 * still offered to the end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createContext } from '@hames-ai/harness-patterns/context.server'
import {
  decisionLoop,
  DECISION_LOOP_ANSWER,
  type DecisionLoopData,
  type DecisionLoopRoute,
} from '@hames-ai/harness-patterns/patterns/decisionLoop.server'
import { retriever } from '@hames-ai/harness-patterns/patterns/retriever.server'
import type { DecideFn, ConfiguredPattern } from '@hames-ai/harness-patterns'

type Data = DecisionLoopData & Record<string, unknown>

/** Takes `prefer` for its first `times` decisions, then `answer`. */
function stubborn(prefer: string, times: number) {
  const taken: string[] = []
  const offeredAt: string[][] = []
  const fn = (async ({ spec }: { spec: { labels: readonly { id: string }[] }; state: string }) => {
    const ids = spec.labels.map((l) => l.id)
    offeredAt.push(ids)
    const label = taken.length < times && ids.includes(prefer) ? prefer : DECISION_LOOP_ANSWER
    taken.push(label)
    return {
      probs: Object.fromEntries(ids.map((id) => [id, id === label ? 1 : 0])),
      method: 'jev',
      calibrated: false,
    }
  }) as unknown as DecideFn
  Object.assign(fn, { supportedTypes: ['choice'], limits: () => ({ contextWindow: 131_072 }) })
  return { decide: fn, offeredAt, taken }
}

const route = (pattern: ConfiguredPattern<Data>, extra: Partial<DecisionLoopRoute<Data>> = {}) => ({
  pattern,
  description: `does ${pattern.config.patternId}`,
  ...extra,
})

const decided = (ctx: { events: unknown[] }) =>
  (ctx.events as Array<{ patternId: string; type: string; data: { label: string } }>)
    .filter((e) => e.patternId === 'orchestrator' && e.type === 'decision_made')
    .map((e) => e.data.label)

describe('decisionLoop — repeatOf compares the WHOLE result, not a prefix', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a retriever read whose excerpt differs only beyond the prefix is NOT a repeat: the route stays offered', async () => {
    // Every dispatch returns ONE hit whose excerpt shares its opening with the
    // others but differs past ~50 characters of the rendered result line — the
    // results are NOT byte-identical, so none is a repeat.
    const common = 'Common opening shared by every dispatch of this read; '
    let n = 0
    const search = vi.fn(async () => [
      {
        backend: 'redis',
        id: `h${++n}`,
        docId: 'd1',
        startOffset: 0,
        endOffset: 40,
        content: `${common}unique tail number ${n}`,
        source: 'q3.md',
      },
    ])
    const read = retriever<Data>({
      backends: [{ name: 'redis', type: 'vector', search }],
      rewrite: (async () => ({ value: '' })) as never,
      patternId: 'read-p',
    })
    const { decide, offeredAt, taken } = stubborn('read', 3)
    const ctx = createContext<Data>('what is the answer?', {})
    await withRunFrame({}, () =>
      runChain(ctx, [
        decisionLoop<Data>(
          { read: route(read) },
          {
            decide,
            answer: 'Answer the user now',
            patternId: 'orchestrator',
          },
        ),
      ]),
    )

    // Three reads, each with fresh information; the fourth decision still
    // OFFERS `read` (every record made progress) and the stub declines it.
    // Under the prefix mutation reads 2–3 are false repeats, two no-progress
    // records in a row withhold the route, and offeredAt[3] lacks it → red.
    expect(taken).toEqual(['read', 'read', 'read', 'answer'])
    expect(decided(ctx)).toEqual(['read', 'read', 'read', 'answer'])
    expect(offeredAt[3]).toContain('read')
  })
})
