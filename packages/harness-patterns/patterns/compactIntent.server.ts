/**
 * compactIntent Pattern
 *
 * Rewrites the user's latest message into a self-contained `intent` brief and
 * writes it to `scope.data.intent`, so a downstream router-less actor (which
 * only sees the current turn + `scope.data.intent`) can resolve bare
 * back-references like "try again", "I can't find the file", or "now in
 * TypeScript" without the conversation history.
 *
 * Placed upstream of an actor pattern in a chain:
 *
 *   chain(
 *     compactIntent({ viewConfig: { fromLastNTurns: 5 } }),
 *     withSandbox({ id })(actorCritic(actor, critic, [], { … })),
 *     compactExecution({ mode: 'thread' }),
 *   )
 *
 * This is the chain-based counterpart to `router`, which sets `data.intent` as
 * a side-effect of classification (#53). compactIntent strips the
 * classification — there is no routing decision, only the rewrite.
 *
 * Backward-compatible: agents that don't use it are unchanged. On any failure
 * it CLEARS `scope.data.intent` so the actor falls back to the raw user message
 * — never fatal, and never the previous turn's brief.
 */

import { assertServerOnImport } from '../assert.server'
import type {
  PatternScope,
  EventView,
  ConfiguredPattern,
  PatternConfig,
  ViewConfig,
  UserMessageEventData,
  AssistantMessageEventData,
  IntentCompactedEventData,
  ErrorEventData,
  LLMCallData,
  CompactIntentFn,
} from '../types'
import { LLMCallError } from '../types'
import { trackEvent, resolveConfig } from '../context.server'
import { getErrorHint } from '../error-hints'
import { stripThinkBlocks } from '../content-transforms'
import { trimToFit } from '../token-budget.server'

assertServerOnImport()

export type CompactIntentConfig = PatternConfig

export interface CompactIntentData {
  intent?: string
}

/**
 * Create a compactIntent pattern.
 *
 * @param compactIntentFn - REQUIRED (Lane A6 seam): the intent-rewrite
 *   implementation — `bamlPatterns().compactIntent` from `harness-baml`, or
 *   your own. Core hosts no BAML default any more, so there is no fallback.
 * @param config - Optional pattern configuration. The default `viewConfig`
 *   reads the last 5 user turns of message history (think-blocks stripped);
 *   override it to widen/narrow the window.
 * @returns ConfiguredPattern ready for chain
 */
export function compactIntent<T extends CompactIntentData>(
  compactIntentFn: CompactIntentFn,
  config?: CompactIntentConfig,
): ConfiguredPattern<T> {
  // Default: cross-turn message history of the last 5 turns, messages only —
  // mirrors the router's default view. Caller can override entirely.
  const DEFAULT_VIEW: ViewConfig = {
    fromLast: false,
    fromLastNTurns: 5,
    eventTypes: ['user_message', 'assistant_message'],
    contentTransforms: [stripThinkBlocks],
  }
  const resolved = resolveConfig('compactIntent', {
    viewConfig: DEFAULT_VIEW,
    ...config,
  })

  /** Drop an intent carried over from an earlier turn. Every exit path that
   *  does NOT produce a fresh brief goes through this: `scope.data` survives
   *  the turn boundary, so returning it untouched would hand the actor the
   *  PREVIOUS turn's brief — and a sandbox actor then executes the wrong one
   *  with real file side-effects. Mirrors `planner`'s `clearPlan`. */
  const clearIntent = (scope: PatternScope<T>): PatternScope<T> => {
    scope.data = { ...scope.data, intent: undefined }
    return scope
  }

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    try {
      // view is pre-configured by viewConfig (last N turns of messages).
      const allMessages = view.get()

      // Latest message = the last user_message in the window.
      const currentMsg = [...allMessages].reverse().find((e) => e.type === 'user_message')
      const latest = currentMsg ? (currentMsg.data as UserMessageEventData).content : ''

      // Nothing to rewrite — clear intent, actor falls back to raw input.
      if (!latest) return clearIntent(scope)

      // History = every message except the current one, mapped to {role, content}.
      const rawHistory = allMessages
        .filter((e) => e !== currentMsg)
        .map((e) => ({
          role: e.type === 'user_message' ? 'user' : 'assistant',
          content: (e.data as UserMessageEventData | AssistantMessageEventData).content,
        }))

      // Turn 1 (no prior history): no back-references to resolve. Pass the
      // latest message through unchanged and skip the LLM call entirely.
      if (rawHistory.length === 0) {
        scope.data = { ...scope.data, intent: latest }
        trackEvent(
          scope,
          'intent_compacted',
          {
            intent: latest,
            latest,
            historyLength: 0,
            skipped: 'no-history',
          } as IntentCompactedEventData,
          resolved.trackHistory,
        )
        return scope
      }

      // Trim oldest history if it would overflow the describe-tier model
      // (the client this call will actually use, not a hardcoded chain name).
      // The window comes from the INJECTED fn's own `limits()` (Lane A6) —
      // the pattern no longer reads the role map. The trim stays here so the
      // event below keeps reporting the length actually sent.
      const contextWindow = compactIntentFn.limits?.().contextWindow ?? 16_384
      const history = trimToFit(rawHistory, (h) => JSON.stringify(h), 300, contextWindow)

      // The injected implementation owns the collector and the client
      // override; on failure after reaching the model it throws
      // `LLMCallError` carrying the record (the seam's throw contract).
      const { value: intent, call: llmCall } = await compactIntentFn({ history, latest })

      scope.data = { ...scope.data, intent }
      trackEvent(
        scope,
        'intent_compacted',
        { intent, latest, historyLength: history.length } as IntentCompactedEventData,
        resolved.trackHistory,
        llmCall,
      )

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Best-effort: surface the prompt/variables drill-down for the failed
      // LLM call — the injected implementation carries it on `LLMCallError`
      // (the seam's throw contract). Intent is cleared → actor falls back to
      // the raw message.
      const failedLlmCall =
        error instanceof LLMCallError ? (error.llmCall as LLMCallData) : undefined
      trackEvent(
        scope,
        'error',
        {
          error: msg,
          severity: resolved.errorSeverity,
          hint: getErrorHint(msg),
          ...(failedLlmCall ? { kind: 'llm_call' as const } : {}),
        } as ErrorEventData,
        true,
        failedLlmCall,
      )
      return clearIntent(scope)
    }
  }

  return {
    name: 'compactIntent',
    fn,
    config: resolved,
    estimateTurns: () => 1,
  }
}
