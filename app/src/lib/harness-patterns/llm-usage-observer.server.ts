/**
 * LLM-usage observer — Server Only
 *
 * One notification per finished BAML call, carrying the client BAML actually
 * selected and the step accounting the adapters just computed. It exists so
 * process-wide, cross-conversation bookkeeping (a global token counter, the
 * "is the self-hosted box warm?" clock) can be written WITHOUT the framework
 * importing the app's database layer, and without a second traversal of the
 * event stream to re-derive numbers `computeEventMetrics` already summed.
 *
 * Why here and not on the event stream: `event.metrics` is per-conversation
 * and lands in a JSONB blob, so a global "tokens today" would mean folding
 * every user's blob on every read — accurate, and far too expensive to put
 * behind a header that polls. This fires once per call, at the only two places
 * that stamp accounting (`extractLLMCallData` and `extractFailureLLMCallData`),
 * so the failed-but-billed calls are counted too.
 *
 * Deliberately weak by design:
 *
 * - **`clientName` is the ground truth, not the flag.** It is the client BAML
 *   selected, after chains and fallbacks. A sample saying `VerdaQwen` means
 *   that call reached the self-hosted box; a routing intention that silently
 *   did not take effect cannot fake one.
 * - **A throwing listener never breaks a turn.** Bookkeeping is not worth an
 *   answer. The throw is logged rather than swallowed — a counter that quietly
 *   stops counting reads as "nothing happened today", which is a lie the
 *   absence of the number would not have told.
 * - **No listener is the normal state.** Tests, scripts and the framework's own
 *   consumers run with none registered and pay one array check per call.
 */
import { assertServerOnImport } from './assert.server'
import type { EventMetrics } from './types'

assertServerOnImport()

/** What one finished BAML call reports about itself. */
export interface LlmUsageSample {
  /** BAML function name, e.g. `LoopController`. */
  functionName: string
  /** The client BAML SELECTED — `VerdaQwen`, `AnthropicSonnet5`, … Absent when
   *  the collector never got far enough to name one. */
  clientName?: string
  /** Step accounting across every attempt of this call; absent when the call
   *  spent no tokens at all (a pre-flight network failure). */
  metrics?: EventMetrics
}

export type LlmUsageListener = (sample: LlmUsageSample) => void

const listeners: LlmUsageListener[] = []

/** Register a listener. Returns a disposer — tests use it, and it is the only
 *  supported way to remove one. */
export function observeLlmUsage(listener: LlmUsageListener): () => void {
  listeners.push(listener)
  return () => {
    const at = listeners.indexOf(listener)
    if (at >= 0) listeners.splice(at, 1)
  }
}

/** Drop every listener (test teardown only). */
export function resetLlmUsageObservers(): void {
  listeners.length = 0
}

/** Fire one sample at every listener. Never throws. */
export function notifyLlmUsage(sample: LlmUsageSample): void {
  for (const listener of listeners) {
    try {
      listener(sample)
    } catch (err) {
      console.error('[llm-usage] observer threw; usage for this call is not recorded:', err)
    }
  }
}
