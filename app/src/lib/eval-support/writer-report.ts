/**
 * Per-turn writer input size for the general-next Eval report (#1032). The
 * answer writer (`Synthesize`, via `compactExecution`) is the one call whose
 * input grows with everything a turn's routes found, so the report says, per
 * turn, how big that input was against the window of the client that served
 * it, and whether the writer had to fall back to the compact route records to
 * fit (the `writer_evidence` warning `decisionLoop`'s trace evidence emits).
 *
 * Everything is computed from the turn's own events, as `guard-report.ts`
 * is: the size from the final answer's call record (`promptChars`, which the
 * redaction keeps), the provider's own token count from its usage, and the
 * fallback from the warning. The window comes from the caller, keyed by the
 * serving client, so this module stays pure (the runner passes harness-baml's
 * `getContextWindow`).
 *
 * Counts only; nothing here judges. The unit pin is `writer-report.test.ts`.
 */
import type { ContextEvent, LLMCallData } from '@hames-ai/harness-patterns'
import type { ConversationTrace } from './conversation'

/** The `warning` task the writer's fallback records (decisionLoop trace evidence). */
export const WRITER_EVIDENCE_WARNING = 'writer_evidence'

/** The repository's own estimate: one token per four characters (`token-budget.server.ts`). */
const CHARS_PER_TOKEN = 4

export interface WriterTurnSize {
  /** 1-based turn index, matching the report's turn numbering. */
  readonly turn: number
  /** The BAML function that wrote the answer, `null` when the turn wrote none
   *  (an iteration-1 decide failure, a gateway outage, a direct response). */
  readonly fn: string | null
  /** The client that served it. */
  readonly client: string | null
  /** Characters of the rendered prompt (the call record's `promptChars`). */
  readonly chars: number | null
  /** `chars / 4`, rounded up: the estimate the writer's own trim works with. */
  readonly estimatedTokens: number | null
  /** The provider's count of the prompt (uncached + cache read + cache write). */
  readonly providerInputTokens: number | null
  /** The serving client's context window, in tokens. */
  readonly contextWindow: number | null
  /** The share of the window the prompt took, to three decimals: the
   *  provider's own count when the call reported usage, else the estimate. The
   *  estimate reads trace prompts about 1.45x low (#1032), and this number
   *  feeds the compaction decision (rv-1033 term 5). */
  readonly windowShare: number | null
  /** `estimatedTokens / contextWindow`, to three decimals. */
  readonly estimatedShare: number | null
  /** The writer could not fit the full trace and fell back to compact records. */
  readonly fallbackFired: boolean
  /** How many route calls fell back (the warnings' `detail.routeCalls`). */
  readonly fallbackRouteCalls: number
}

/** The record of the call that wrote this turn's answer: the final
 *  `assistant_message`'s, or the `error` event a failed synthesis left. */
function writerCall(events: readonly ContextEvent[]): LLMCallData | undefined {
  const final = events.findLast(
    (e) => e.type === 'assistant_message' && (e.data as { final?: boolean }).final === true,
  )
  if (final?.llmCall) return final.llmCall
  return events.findLast(
    (e) => e.type === 'error' && /^Synthesize/.test(e.llmCall?.functionName ?? ''),
  )?.llmCall
}

const share = (tokens: number | null, window: number | null): number | null =>
  tokens !== null && window ? Math.round((tokens / window) * 1000) / 1000 : null

export function writerTurnSize(
  turn: number,
  events: readonly ContextEvent[],
  contextWindowOf: (client: string) => number | undefined,
): WriterTurnSize {
  const call = writerCall(events)
  const chars = typeof call?.promptChars === 'number' ? call.promptChars : null
  const estimatedTokens = chars === null ? null : Math.ceil(chars / CHARS_PER_TOKEN)
  const usage = call?.usage
  const providerInputTokens = usage
    ? usage.inputTokens + usage.cachedInputTokens + (usage.cacheCreationInputTokens ?? 0)
    : null
  const client = call?.clientName ?? null
  const contextWindow = client ? (contextWindowOf(client) ?? null) : null
  const warnings = events.filter(
    (e) => e.type === 'warning' && (e.data as { task?: unknown }).task === WRITER_EVIDENCE_WARNING,
  )
  const routeCalls = warnings.reduce((n, e) => {
    const cells = (e.data as { detail?: Record<string, unknown> }).detail
    return n + (typeof cells?.routeCalls === 'number' ? cells.routeCalls : 0)
  }, 0)
  return {
    turn,
    fn: call?.functionName ?? null,
    client,
    chars,
    estimatedTokens,
    providerInputTokens,
    contextWindow,
    windowShare: share(providerInputTokens ?? estimatedTokens, contextWindow),
    estimatedShare: share(estimatedTokens, contextWindow),
    fallbackFired: warnings.length > 0,
    fallbackRouteCalls: routeCalls,
  }
}

/** One row per turn of a conversation. */
export function writerTurnSizes(
  turns: ConversationTrace['turns'],
  contextWindowOf: (client: string) => number | undefined,
): WriterTurnSize[] {
  return turns.map((t, i) => writerTurnSize(i + 1, t.events, contextWindowOf))
}

/** The largest writer input of a run and whether any turn fell back: the
 *  report's one-line answer to "did the trace fit". */
export function writerSummary(rows: readonly { writer?: readonly WriterTurnSize[] }[]): {
  turns: number
  maxChars: number | null
  maxEstimatedTokens: number | null
  maxWindowShare: number | null
  fallbackTurns: number
} {
  const all = rows.flatMap((r) => r.writer ?? [])
  const max = (pick: (w: WriterTurnSize) => number | null): number | null => {
    const values = all.map(pick).filter((v): v is number => v !== null)
    return values.length ? Math.max(...values) : null
  }
  return {
    turns: all.length,
    maxChars: max((w) => w.chars),
    maxEstimatedTokens: max((w) => w.estimatedTokens),
    maxWindowShare: max((w) => w.windowShare),
    fallbackTurns: all.filter((w) => w.fallbackFired).length,
  }
}
