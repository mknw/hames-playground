/**
 * Summary bar — event counts, tool success rate, and the session-level
 * token/cost readout (#122). Split out of `ObservabilityPanel.tsx` (#226 B5).
 */

import { Show, createMemo } from 'solid-js'
import type { ContextEvent, ToolResultEventData } from '~/lib/harness-patterns'
import { fmtTok, fmtUsd, foldTokenTotals } from '~/lib/observability/token-totals'

export const SummaryBar = (props: { events: ContextEvent[]; onClear?: () => void }) => {
  const metrics = createMemo(() => {
    const events = props.events
    const toolResults = events.filter((e) => e.type === 'tool_result')
    const successCount = toolResults.filter((e) => (e.data as ToolResultEventData).success).length
    const errorCount = events.filter((e) => e.type === 'error').length

    return {
      totalEvents: events.length,
      successRate: toolResults.length > 0 ? successCount / toolResults.length : 1,
      errorCount,
    }
  })

  const tokenTotals = createMemo(() => foldTokenTotals(props.events))

  return (
    <div p="3" bg="dark-bg-tertiary" border="b dark-border-primary" flex="~ wrap" gap="4">
      <div flex="~" items="center" gap="2">
        <span text="xs dark-text-tertiary">Events:</span>
        <span text="sm dark-text-primary" font="mono">
          {metrics().totalEvents}
        </span>
      </div>

      <div flex="~" items="center" gap="2">
        <span text="xs dark-text-tertiary">Success:</span>
        <span
          text={`sm ${metrics().successRate >= 0.9 ? 'neon-green' : metrics().successRate >= 0.5 ? 'neon-yellow' : 'red-500'}`}
          font="mono"
        >
          {Math.round(metrics().successRate * 100)}%
        </span>
      </div>

      <Show when={metrics().errorCount > 0}>
        <div flex="~" items="center" gap="2">
          <span text="xs dark-text-tertiary">Errors:</span>
          <span text="sm red-400" font="mono">
            {metrics().errorCount}
          </span>
        </div>
      </Show>

      {/* Session-level token/cost accounting (#122) — fold over event.metrics */}
      <Show when={tokenTotals().llmCalls > 0}>
        <div flex="~" items="center" gap="2" title="Input tokens: fresh / cache-read / cache-write">
          <span text="xs dark-text-tertiary">In:</span>
          <span text="sm neon-green" font="mono">
            {fmtTok(tokenTotals().inputUncached)}
          </span>
          <Show when={tokenTotals().cacheRead > 0 || tokenTotals().cacheWrite > 0}>
            <span text="sm violet-400" font="mono">
              +{fmtTok(tokenTotals().cacheRead)}⚡
            </span>
            <span text="sm amber-400" font="mono">
              +{fmtTok(tokenTotals().cacheWrite)}✎
            </span>
          </Show>
        </div>
        <div flex="~" items="center" gap="2">
          <span text="xs dark-text-tertiary">Out:</span>
          <span text="sm neon-cyan" font="mono">
            {fmtTok(tokenTotals().output)}
          </span>
        </div>
        <Show when={tokenTotals().cachedPct > 0}>
          <div
            flex="~"
            items="center"
            gap="2"
            title="Share of input tokens served from cache (0.1× rate)"
          >
            <span text="xs dark-text-tertiary">Cached:</span>
            <span text="sm violet-400" font="mono">
              {Math.round(tokenTotals().cachedPct * 100)}%
            </span>
          </div>
        </Show>
        <Show when={tokenTotals().costKnownCalls > 0}>
          <div
            flex="~"
            items="center"
            gap="2"
            title={`Estimated from per-call rates at call time; ${tokenTotals().costKnownCalls}/${tokenTotals().llmCalls} calls priced. Without caching: ${fmtUsd(tokenTotals().noCacheUsd)}`}
          >
            <span text="xs dark-text-tertiary">Cost:</span>
            <span text="sm dark-text-primary" font="mono">
              {fmtUsd(tokenTotals().costUsd)}
            </span>
            <Show when={tokenTotals().savedPct > 0.005}>
              <span text="xs neon-green" font="mono">
                −{Math.round(tokenTotals().savedPct * 100)}%
              </span>
            </Show>
          </div>
        </Show>
        <Show when={tokenTotals().attempts > tokenTotals().llmCalls}>
          <div
            flex="~"
            items="center"
            gap="2"
            title="Physical API calls exceeded LLM steps — retries/fallbacks burned extra spend (already included in the totals)"
          >
            <span text="xs dark-text-tertiary">Retries:</span>
            <span text="sm amber-400" font="mono">
              +{tokenTotals().attempts - tokenTotals().llmCalls}
            </span>
          </div>
        </Show>
      </Show>

      <Show when={props.events.length > 0}>
        <button
          onClick={() => props.onClear?.()}
          m="l-auto"
          p="x-2 y-1"
          text="xs red-400"
          bg="red-600/10 hover:red-600/20"
          border="1 red-500/30"
          rounded="md"
          cursor="pointer"
          transition="all"
        >
          Clear
        </button>
      </Show>
    </div>
  )
}
