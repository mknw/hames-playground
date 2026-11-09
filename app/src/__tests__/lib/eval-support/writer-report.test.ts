/**
 * The general-next report's per-turn writer input size (#1032), computed from
 * the turn's own events: the final answer's call record carries the prompt's
 * size (`promptChars`, kept by the redaction) and the provider's usage; the
 * window is the serving client's; the fallback is the `writer_evidence`
 * warning. Mutations that turn this red, each checked:
 *   - read the FIRST assistant_message instead of the final one → the router
 *     status message's (absent) record is read and `chars` is null;
 *   - drop `cachedInputTokens` from `providerInputTokens` → 1300 reads 1000;
 *   - count every `warning` as a fallback → the title warning fires it;
 *   - take `routeCalls` from the first warning only → 3 reads 2.
 */
import { describe, expect, it } from 'vitest'
import type { ContextEvent, LLMCallData } from '@hames-ai/harness-patterns'
import {
  WRITER_EVIDENCE_WARNING,
  writerSummary,
  writerTurnSize,
  writerTurnSizes,
} from '../../../lib/eval-support/writer-report'

const event = (type: string, data: unknown, llmCall?: Partial<LLMCallData>) =>
  ({ type, data, ...(llmCall ? { llmCall } : {}) }) as ContextEvent

const windows = (client: string) => (client === 'LargeQwen' ? 131072 : undefined)

const answer = (promptChars: number | undefined) =>
  event(
    'assistant_message',
    { content: 'The answer', final: true },
    {
      functionName: 'Synthesize',
      variables: {},
      clientName: 'LargeQwen',
      ...(promptChars !== undefined ? { promptChars } : {}),
      usage: { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 300, totalTokens: 1350 },
    },
  )

describe('writerTurnSize', () => {
  it('reads the final answer’s call record against the serving client’s window', () => {
    const row = writerTurnSize(
      1,
      [
        event('assistant_message', { content: 'Let me look', final: false }),
        event('warning', { task: 'title', message: 'no title', fallback: 'none' }),
        answer(40_000),
      ],
      windows,
    )
    expect(row).toEqual({
      turn: 1,
      fn: 'Synthesize',
      client: 'LargeQwen',
      chars: 40_000,
      estimatedTokens: 10_000,
      providerInputTokens: 1300,
      contextWindow: 131072,
      // The provider's count when usage is present (1 300 tokens), the estimate beside it.
      windowShare: 0.01,
      estimatedShare: 0.076,
      fallbackFired: false,
      fallbackRouteCalls: 0,
    })
  })

  it('counts the writer_evidence warnings and the route calls they name', () => {
    const fallback = (routeCalls: number) =>
      event('warning', {
        task: WRITER_EVIDENCE_WARNING,
        message: 'fell back',
        fallback: 'compact records',
        detail: { routeCalls },
      })
    const row = writerTurnSize(2, [fallback(2), fallback(1), answer(10)], windows)
    expect(row.fallbackFired).toBe(true)
    expect(row.fallbackRouteCalls).toBe(3)
  })

  it('reads a failed synthesis from its error event, and says null when nothing wrote', () => {
    const failed = writerTurnSize(
      1,
      [
        event(
          'error',
          { error: 'boom' },
          { functionName: 'Synthesize', variables: {}, promptChars: 8, clientName: 'Other' },
        ),
      ],
      windows,
    )
    expect(failed).toMatchObject({ chars: 8, estimatedTokens: 2, contextWindow: null })
    expect(failed.windowShare).toBeNull()
    // No usage: the share falls back to the estimate.
    // MUTATION: always read the estimate → the first case reads 0.076.
    const noUsage = writerTurnSize(
      1,
      [
        event(
          'assistant_message',
          { content: 'a', final: true },
          {
            functionName: 'Synthesize',
            variables: {},
            clientName: 'LargeQwen',
            promptChars: 40_000,
          },
        ),
      ],
      windows,
    )
    expect(noUsage).toMatchObject({
      providerInputTokens: null,
      windowShare: 0.076,
      estimatedShare: 0.076,
    })
    expect(writerTurnSize(1, [event('error', { error: 'decide failed' })], windows)).toMatchObject({
      fn: null,
      chars: null,
      providerInputTokens: null,
      fallbackFired: false,
    })
    // A record without the count (an older blob) is unmeasured, never 0.
    expect(writerTurnSize(1, [answer(undefined)], windows).chars).toBeNull()
    // The final answer's record, wherever it sits: a non-final assistant
    // message after it (a status emit) is not the writer's call.
    // MUTATION: read the first assistant_message, or drop the `final` filter
    // (rv-1033's two forms) → chars reads null.
    expect(
      writerTurnSize(
        1,
        [
          event('assistant_message', { content: 'Let me look', final: false }),
          answer(1_234),
          event('assistant_message', { content: 'Saved for later?', final: false }),
        ],
        windows,
      ).chars,
    ).toBe(1_234)
  })
})

describe('writerTurnSizes / writerSummary', () => {
  it('numbers turns from 1 and summarises the run', () => {
    const rows = writerTurnSizes(
      [
        { response: 'a', status: 'done', events: [answer(400)] },
        {
          response: 'b',
          status: 'done',
          events: [
            event('warning', {
              task: WRITER_EVIDENCE_WARNING,
              message: 'x',
              fallback: 'y',
              detail: { routeCalls: 1 },
            }),
            answer(800),
          ],
        },
      ],
      windows,
    )
    expect(rows.map((r) => r.turn)).toEqual([1, 2])
    expect(writerSummary([{ writer: rows }, {}])).toEqual({
      turns: 2,
      maxChars: 800,
      maxEstimatedTokens: 200,
      maxWindowShare: 0.01,
      fallbackTurns: 1,
    })
    expect(writerSummary([])).toEqual({
      turns: 0,
      maxChars: null,
      maxEstimatedTokens: null,
      maxWindowShare: null,
      fallbackTurns: 0,
    })
  })
})
