/**
 * Summary bar — event counts, tool success rate, and the session-level
 * token/cost readout (#122). Split out of `ObservabilityPanel.tsx` (#226 B5).
 */

import { Show, createMemo } from 'solid-js'
import type { ContextEvent, ToolResultEventData } from '~/lib/harness-patterns'
import { fmtEur, fmtTok, foldTokenTotals } from '~/lib/observability/token-totals'

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
    <div p="3" bg="ui-bg-tertiary" border="b ui-border-primary" flex="~ wrap" gap="4">
      <div flex="~" items="center" gap="2">
        <span text="xs ui-text-tertiary">Events:</span>
        <span text="sm ui-text-primary" font="mono">
          {metrics().totalEvents}
        </span>
      </div>

      <div flex="~" items="center" gap="2">
        <span text="xs ui-text-tertiary">Success:</span>
        <span
          text={`sm ${metrics().successRate >= 0.9 ? 'ui-success' : metrics().successRate >= 0.5 ? 'neon-yellow' : 'red-500'}`}
          font="mono"
        >
          {Math.round(metrics().successRate * 100)}%
        </span>
      </div>

      <Show when={metrics().errorCount > 0}>
        <div flex="~" items="center" gap="2">
          <span text="xs ui-text-tertiary">Errors:</span>
          <span text="sm red-400" font="mono">
            {metrics().errorCount}
          </span>
        </div>
      </Show>

      {/* Session-level token/cost accounting (#122) — fold over event.metrics */}
      <Show when={tokenTotals().llmCalls > 0}>
        <div flex="~" items="center" gap="2" title="Input tokens: fresh / cache-read / cache-write">
          <span text="xs ui-text-tertiary">In:</span>
          <span text="sm ui-success" font="mono">
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
          <span text="xs ui-text-tertiary">Out:</span>
          <span text="sm ui-accent" font="mono">
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
            <span text="xs ui-text-tertiary">Cached:</span>
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
            title={
              `Estimated from per-call rates at call time; ${tokenTotals().costKnownCalls}/${tokenTotals().llmCalls} calls priced. ` +
              `Without caching: ${fmtEur(tokenTotals().noCacheEur)}. ` +
              `USD list prices converted at a static rate — no live FX.` +
              (tokenTotals().timePricedCalls > 0
                ? ` ${tokenTotals().timePricedCalls} call(s) ran on the self-hosted GPU and are billed by the second, so the total is a FLOOR: it covers the calls' own duration, not the idle scale-down window after the last one or the cold start before the first.`
                : '')
            }
          >
            <span text="xs ui-text-tertiary">Cost:</span>
            <span text="sm ui-text-primary" font="mono">
              {tokenTotals().timePricedCalls > 0 ? '≥ ' : ''}
              {fmtEur(tokenTotals().costEur)}
            </span>
            <Show when={tokenTotals().savedPct > 0.005}>
              <span text="xs ui-success" font="mono">
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
            <span text="xs ui-text-tertiary">Retries:</span>
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
