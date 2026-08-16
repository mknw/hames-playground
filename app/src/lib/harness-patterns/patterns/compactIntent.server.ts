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
 *     synthesizer({ mode: 'thread' }),
 *   )
 *
 * This is the chain-based counterpart to `router`, which sets `data.intent` as
 * a side-effect of classification (#53). compactIntent strips the
 * classification — there is no routing decision, only the rewrite.
 *
 * Backward-compatible: agents that don't use it are unchanged. On any failure
 * it leaves `scope.data.intent` unset so the actor falls back to the raw user
 * message — never fatal.
 */

import { assertServerOnImport } from '../assert.server'
import { Collector } from '@boundaryml/baml'
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
} from '../types'
import { trackEvent, resolveConfig } from '../context.server'
import { getErrorHint } from '../error-hints'
import { stripThinkBlocks } from '../content-transforms'
import { trimToFit, getContextWindow } from '../token-budget.server'
import { extractLLMCallData, extractFailureLLMCallData } from '../baml-adapters.server'
import { clientOverrideFor, resolveClientForRole } from '../clients.server'

assertServerOnImport()

export type CompactIntentConfig = PatternConfig

export interface CompactIntentData {
  intent?: string
}

/**
 * Create a compactIntent pattern.
 *
 * @param config - Optional pattern configuration. The default `viewConfig`
 *   reads the last 5 user turns of message history (think-blocks stripped);
 *   override it to widen/narrow the window.
 * @returns ConfiguredPattern ready for chain
 */
export function compactIntent<T extends CompactIntentData>(
  config?: CompactIntentConfig
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

  const fn = async (
    scope: PatternScope<T>,
    view: EventView
  ): Promise<PatternScope<T>> => {
    let collector: Collector | undefined
    let startTime: number | undefined
    let variables: Record<string, unknown> | undefined
    try {
      // view is pre-configured by viewConfig (last N turns of messages).
      const allMessages = view.get()

      // Latest message = the last user_message in the window.
      const currentMsg = [...allMessages].reverse().find(e => e.type === 'user_message')
      const latest = currentMsg
        ? (currentMsg.data as UserMessageEventData).content
        : ''

      // Nothing to rewrite — leave intent unset, actor falls back to raw input.
      if (!latest) return scope

      // History = every message except the current one, mapped to {role, content}.
      const rawHistory = allMessages
        .filter(e => e !== currentMsg)
        .map(e => ({
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
          { intent: latest, latest, historyLength: 0, skipped: 'no-history' } as IntentCompactedEventData,
          resolved.trackHistory
        )
        return scope
      }

      // Trim oldest history if it would overflow the describe-tier model
      // (the client this call will actually use, not the hardcoded Fallback).
      const contextWindow = getContextWindow(resolveClientForRole('describe'))
      const history = trimToFit(rawHistory, h => JSON.stringify(h), 300, contextWindow)

      const { b } = await import('../../../../baml_client')
      collector = new Collector('compactIntent')
      startTime = Date.now()
      variables = { history, latest }

      // Default (no override): routes to `DescribeAnthropic` (Haiku 4.5).
      // `USE_MIXED_CHAINS=1`: swaps in `DescribeFallback` via clientOverrideFor.
      const opts = { collector, ...clientOverrideFor('describe') }
      const raw = await b.CompactIntent(history, latest, opts)
      const intent = raw.trim() || latest

      const llmCall: LLMCallData | undefined = extractLLMCallData(
        collector,
        'CompactIntent',
        variables,
        startTime,
        intent
      )

      scope.data = { ...scope.data, intent }
      trackEvent(
        scope,
        'intent_compacted',
        { intent, latest, historyLength: history.length } as IntentCompactedEventData,
        resolved.trackHistory,
        llmCall
      )

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Best-effort: surface the prompt/variables drill-down for the failed
      // BAML call. Intent stays unset → actor falls back to the raw message.
      const failedLlmCall =
        collector !== undefined && variables !== undefined && startTime !== undefined
          ? extractFailureLLMCallData(collector, 'CompactIntent', variables, startTime)
          : undefined
      trackEvent(scope, 'error', {
        error: msg,
        severity: resolved.errorSeverity,
        hint: getErrorHint(msg),
        ...(failedLlmCall ? { kind: 'llm_call' as const } : {}),
      } as ErrorEventData, true, failedLlmCall)
      return scope
    }
  }

  return {
    name: 'compactIntent',
    fn,
    config: resolved,
    estimateTurns: () => 1,
  }
}
