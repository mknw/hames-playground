/**
 * Metrics Dashboard (#132)
 *
 * Token, cache and cost transparency across everything the signed-in user has
 * run. Numbers come from `event.metrics` (#122 / PR #130) folded server-side —
 * see `lib/metrics/aggregate.ts` for the fold and `dashboard.server.ts` for the
 * user-scoped load. Auth matches the rest of the app: the page renders behind
 * `AuthProvider`, and the server action independently re-checks the session,
 * so an unauthenticated fetch gets nothing regardless of the client gate.
 *
 * No chart library by design — composition bars are two divs and a width.
 */

import { createResource, createMemo, For, Show } from 'solid-js'
import { getMetricsDashboard, type MetricsDashboard } from '~/lib/metrics/dashboard.server'
import type { MetricSummary } from '~/lib/metrics/aggregate'

// ============================================================================
// Formatting
// ============================================================================

/** 1234 → "1.2k", 2_500_000 → "2.50M". */
const fmtTok = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Cost with enough precision to stay meaningful at per-call scale. */
const fmtUsd = (v: number): string => (v >= 0.1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`)

const fmtPct = (v: number): string => `${Math.round(v * 100)}%`

const fmtWhen = (ms: number): string => new Date(ms).toLocaleString()

// ============================================================================
// Building blocks
// ============================================================================

const Card = (props: {
  label: string
  value: string
  hint?: string
  /** Colour token for the value. Named `tone`, not `accent`: attributify reads
   *  an `accent=` attribute as the `accent-color` utility and would emit a
   *  stray rule on the card. */
  tone?: string
  title?: string
  children?: import('solid-js').JSX.Element
}) => (
  <div
    flex="~ col"
    gap="1"
    p="4"
    rounded="lg"
    bg="dark-bg-secondary"
    border="1 dark-border-primary"
    title={props.title}
  >
    <span text="xs dark-text-tertiary" tracking="wide" uppercase>
      {props.label}
    </span>
    <span text={`2xl ${props.tone ?? 'dark-text-primary'}`} font="mono">
      {props.value}
    </span>
    <Show when={props.hint}>
      <span text="xs dark-text-secondary">{props.hint}</span>
    </Show>
    {props.children}
  </div>
)

/** Input-token composition: fresh / cache read / cache write, as one bar. */
const CompositionBar = (props: { summary: MetricSummary }) => {
  const total = () => Math.max(1, props.summary.inputTotalTokens)
  const seg = (n: number) => `${(n / total()) * 100}%`
  return (
    <div flex="~ col" gap="2" m="t-2">
      <div flex="~" h="2" w="full" rounded="full" overflow="hidden" bg="dark-bg-tertiary">
        <div
          bg="neon-green"
          style={{ width: seg(props.summary.inputUncachedTokens) }}
          title={`Uncached input: ${props.summary.inputUncachedTokens.toLocaleString()} tokens`}
        />
        <div
          bg="violet-400"
          style={{ width: seg(props.summary.inputCacheReadTokens) }}
          title={`Cache read: ${props.summary.inputCacheReadTokens.toLocaleString()} tokens`}
        />
        <div
          bg="amber-400"
          style={{ width: seg(props.summary.inputCacheWriteTokens) }}
          title={`Cache write: ${props.summary.inputCacheWriteTokens.toLocaleString()} tokens`}
        />
      </div>
      <div flex="~ wrap" gap="3" text="xs dark-text-secondary">
        <span>
          <span text="neon-green">■</span> fresh {fmtTok(props.summary.inputUncachedTokens)}
        </span>
        <span>
          <span text="violet-400">■</span> cache read {fmtTok(props.summary.inputCacheReadTokens)}
        </span>
        <span>
          <span text="amber-400">■</span> cache write {fmtTok(props.summary.inputCacheWriteTokens)}
        </span>
      </div>
    </div>
  )
}

const Th = (props: { children: import('solid-js').JSX.Element; right?: boolean }) => (
  // Alignment stays an inline style: `text="right"` emits no CSS under this
  // UnoCSS config (verified against the built stylesheet), unlike `text="left"`.
  <th
    p="x-3 y-2"
    text="xs dark-text-tertiary"
    font="medium"
    tracking="wide"
    uppercase
    style={{ 'text-align': props.right ? 'right' : 'left' }}
  >
    {props.children}
  </th>
)

const Td = (props: {
  children: import('solid-js').JSX.Element
  right?: boolean
  mono?: boolean
  title?: string
}) => (
  <td
    p="x-3 y-2"
    text="sm dark-text-primary"
    font={props.mono === false ? undefined : 'mono'}
    title={props.title}
    style={{ 'text-align': props.right ? 'right' : 'left' }}
  >
    {props.children}
  </td>
)

const SectionTitle = (props: { title: string; note?: string }) => (
  <div flex="~ wrap" items="baseline" gap="3" m="b-3">
    <h2 text="lg dark-text-primary" font="medium">
      {props.title}
    </h2>
    <Show when={props.note}>
      <span text="xs dark-text-tertiary">{props.note}</span>
    </Show>
  </div>
)

/** Shared numeric columns for both aggregate tables. */
const SummaryCells = (props: { summary: MetricSummary }) => (
  <>
    <Td right>{props.summary.meteredCalls}</Td>
    <Td right title="Uncached / cache read / cache write input tokens">
      {fmtTok(props.summary.inputTotalTokens)}
    </Td>
    <Td right>{fmtTok(props.summary.outputTokens)}</Td>
    <Td right>
      <span text={props.summary.cacheHitRate > 0 ? 'violet-400' : 'dark-text-tertiary'}>
        {fmtPct(props.summary.cacheHitRate)}
      </span>
    </Td>
    <Td right>
      <Show
        when={props.summary.pricedCalls > 0}
        fallback={<span text="dark-text-tertiary">—</span>}
      >
        {fmtUsd(props.summary.costUsd)}
      </Show>
    </Td>
  </>
)

// ============================================================================
// Page
// ============================================================================

export default function Dashboard() {
  const [data, { refetch }] = createResource<MetricsDashboard>(() => getMetricsDashboard(10))

  const totals = createMemo(() => data()?.totals)
  const hasActivity = () => {
    const t = totals()
    return !!t && (t.meteredCalls > 0 || t.unmeteredCalls > 0)
  }

  // No `min-h="screen"` on <main>: `Nav` sits above this route in the root
  // layout, so a full viewport here would always overflow by the nav's height.
  return (
    <main flex="~ col" gap="6" p="6" bg="dark-bg-primary" text="dark-text-primary" font="sans">
      <header flex="~ wrap" items="center" gap="4">
        <div flex="~ col" gap="1">
          <h1 text="2xl dark-text-primary" font="medium">
            Metrics
          </h1>
          <span text="xs dark-text-secondary">
            Tokens, cache and estimated cost across your conversations
          </span>
        </div>
        <div flex="~" items="center" gap="2" m="l-auto">
          <Show when={data()}>
            {(d) => (
              <span text="xs dark-text-tertiary" font="mono">
                {/* Say so when the load hit its ceiling — "N conversations" would
                    otherwise read as "all of them". */}
                {d().conversationCount >= d().conversationScanLimit
                  ? `most recent ${d().conversationScanLimit} conversations`
                  : `${d().conversationCount} conversations`}{' '}
                · {d().eventCount} events · {fmtWhen(d().generatedAt)}
              </span>
            )}
          </Show>
          <button
            onClick={() => void refetch()}
            flex="~"
            items="center"
            gap="2"
            p="x-3 y-2"
            rounded="md"
            bg="cyber-800/20 hover:cyber-700/30"
            border="1 cyber-700/50"
            text="xs dark-text-primary"
            cursor="pointer"
            transition="all"
            disabled={data.loading}
          >
            <span class="i-material-symbols-refresh" w="4" h="4" aria-hidden="true" />
            Refresh
          </button>
          {/* No "back to chat" control here: `Nav` renders on every route and
              already flips to a chat-icon link while you are on /dashboard. */}
        </div>
      </header>

      <Show
        when={data()}
        fallback={
          <div p="6" text="sm dark-text-tertiary">
            <Show when={!data.error} fallback={<span text="red-400">{String(data.error)}</span>}>
              Folding your conversations…
            </Show>
          </div>
        }
      >
        {(d) => (
          <Show
            when={hasActivity()}
            fallback={
              <div
                p="8"
                rounded="lg"
                bg="dark-bg-secondary"
                border="1 dark-border-primary"
                text="sm dark-text-secondary"
                flex="~ col"
                gap="2"
              >
                <span text="dark-text-primary">No LLM activity recorded yet.</span>
                <span text="xs dark-text-tertiary">
                  Run a conversation and its per-step token and cost accounting shows up here.
                </span>
              </div>
            }
          >
            {/* ---------------------------------------------------------- */}
            {/* Global totals                                              */}
            {/* ---------------------------------------------------------- */}
            <section>
              <SectionTitle
                title="Totals"
                note={`${totals()!.meteredCalls} metered LLM steps${
                  totals()!.attempts > totals()!.meteredCalls
                    ? ` · ${totals()!.attempts - totals()!.meteredCalls} retry/fallback calls`
                    : ''
                }`}
              />
              <div grid="~ cols-1 sm:cols-2 lg:cols-4" gap="4">
                {/* Same rule as the table's cost column: no priced step means no
                    figure, not $0.0000. */}
                <Card
                  label="Estimated cost"
                  value={totals()!.pricedCalls > 0 ? fmtUsd(totals()!.costUsd) : '—'}
                  tone={totals()!.pricedCalls > 0 ? 'neon-cyan' : 'dark-text-tertiary'}
                  hint={
                    totals()!.pricedCalls < totals()!.meteredCalls
                      ? `${totals()!.pricedCalls}/${totals()!.meteredCalls} steps priced`
                      : 'all steps priced'
                  }
                  title="Sum of per-call estimates stamped with the rates in force at call time"
                />
                <Card
                  label="Saved by caching"
                  value={fmtUsd(totals()!.savingsUsd)}
                  tone="neon-green"
                  hint={`${fmtPct(totals()!.savingsPct)} off ${fmtUsd(totals()!.noCacheUsd)} uncached`}
                  title="Difference between the billed estimate and the same tokens priced with no caching"
                />
                <Card
                  label="Cache hit-rate"
                  value={fmtPct(totals()!.cacheHitRate)}
                  tone="violet-400"
                  hint={`${fmtTok(totals()!.inputCacheReadTokens)} of ${fmtTok(
                    totals()!.inputTotalTokens,
                  )} input tokens`}
                  title="Share of input tokens served from cache (billed at 0.1× the base input rate)"
                />
                <Card
                  label="Output tokens"
                  value={fmtTok(totals()!.outputTokens)}
                  tone="neon-cyan"
                  hint={`${fmtTok(totals()!.totalTokens)} tokens in total`}
                />
                <div
                  p="4"
                  rounded="lg"
                  bg="dark-bg-secondary"
                  border="1 dark-border-primary"
                  style={{ 'grid-column': '1 / -1' }}
                >
                  <div flex="~ wrap" items="baseline" gap="3">
                    <span text="xs dark-text-tertiary" tracking="wide" uppercase>
                      Input composition
                    </span>
                    <span text="sm dark-text-primary" font="mono">
                      {fmtTok(totals()!.inputTotalTokens)} tokens
                    </span>
                  </div>
                  <CompositionBar summary={totals()!} />
                </div>
              </div>

              <Show when={totals()!.unmeteredCalls > 0}>
                <div
                  m="t-4"
                  p="3"
                  rounded="md"
                  bg="amber-400/5"
                  border="1 amber-400/30"
                  flex="~"
                  items="center"
                  gap="2"
                  text="xs amber-300"
                >
                  <span class="i-material-symbols-info-outline" w="4" h="4" aria-hidden="true" />
                  <span>
                    {totals()!.unmeteredCalls} LLM steps are <strong>unmetered</strong> — they
                    predate per-event metrics and are excluded from every number above.
                  </span>
                </div>
              </Show>
            </section>

            {/* ---------------------------------------------------------- */}
            {/* Per-pattern                                                */}
            {/* ---------------------------------------------------------- */}
            <section>
              <SectionTitle title="By pattern" note="ranked by estimated cost" />
              <div
                rounded="lg"
                bg="dark-bg-secondary"
                border="1 dark-border-primary"
                overflow="auto"
              >
                <table w="full" border="collapse">
                  <thead bg="dark-bg-tertiary">
                    <tr>
                      <Th>Pattern</Th>
                      <Th right>Steps</Th>
                      <Th right>Input</Th>
                      <Th right>Output</Th>
                      <Th right>Cached</Th>
                      <Th right>Cost</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={d().byPattern}>
                      {(row) => (
                        <tr border="t dark-border-primary">
                          <Td mono={false}>
                            <span text="sm neon-cyan" font="mono">
                              {row.patternId}
                            </span>
                            <Show when={row.summary.unmeteredCalls > 0}>
                              <span text="xs amber-300" m="l-2">
                                +{row.summary.unmeteredCalls} unmetered
                              </span>
                            </Show>
                          </Td>
                          <SummaryCells summary={row.summary} />
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </section>

            {/* ---------------------------------------------------------- */}
            {/* Per-conversation                                           */}
            {/* ---------------------------------------------------------- */}
            <section>
              <SectionTitle
                title="Top conversations"
                note={
                  d().conversationsOmitted > 0
                    ? `by estimated cost · ${d().conversationsOmitted} more not shown`
                    : 'by estimated cost'
                }
              />
              <div
                rounded="lg"
                bg="dark-bg-secondary"
                border="1 dark-border-primary"
                overflow="auto"
              >
                <table w="full" border="collapse">
                  <thead bg="dark-bg-tertiary">
                    <tr>
                      <Th>Conversation</Th>
                      <Th>Agent</Th>
                      <Th right>Steps</Th>
                      <Th right>Input</Th>
                      <Th right>Output</Th>
                      <Th right>Cached</Th>
                      <Th right>Cost</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={d().byConversation}>
                      {(row) => (
                        <tr border="t dark-border-primary">
                          <Td mono={false} title={`Last activity ${fmtWhen(row.updatedAt)}`}>
                            <span text="sm dark-text-primary">{row.title ?? 'Untitled'}</span>
                            <Show when={row.summary.unmeteredCalls > 0}>
                              <span text="xs amber-300" m="l-2">
                                +{row.summary.unmeteredCalls} unmetered
                              </span>
                            </Show>
                          </Td>
                          <Td mono={false}>
                            <span text="xs dark-text-tertiary" font="mono">
                              {row.agentId}
                            </span>
                          </Td>
                          <SummaryCells summary={row.summary} />
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </section>

            <footer text="xs dark-text-secondary" m="t-2">
              Costs are estimates: each step is priced at the $/MTok rates in force for the client
              that served it (see <span font="mono">CLIENT_PRICING</span> in{' '}
              <span font="mono">lib/settings.ts</span>), with cache reads at 0.1× and cache writes
              at 1.25× the base input rate. Steps whose client has no pricing entry are counted but
              left out of the cost columns.
            </footer>
          </Show>
        )}
      </Show>
    </main>
  )
}
