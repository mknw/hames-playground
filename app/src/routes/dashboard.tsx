/**
 * Metrics Dashboard (#132)
 *
 * Tokens, tool calls and self-deployed GPU transparency across everything the
 * signed-in user has run. Cache figures render only where a token-priced step
 * exists — a step billed by wall-clock (the self-deployed tier) saves nothing
 * by caching. Numbers come from `event.metrics` (#122 / PR #130) folded
 * server-side — see `@hames-ai/harness-patterns/metrics/aggregate` for the fold
 * and `dashboard.server.ts` for the user-scoped load. Auth matches the rest of
 * the app: the page renders behind `AuthProvider`, and the server action
 * independently re-checks the session, so an unauthenticated fetch gets nothing
 * regardless of the client gate.
 *
 * No chart library by design — composition bars are two divs and a width.
 */

import { createResource, createMemo, For, Show } from 'solid-js'
import { getMetricsDashboard, type MetricsDashboard } from '~/lib/metrics/dashboard.server'
import type { MetricSummary } from '@hames-ai/harness-patterns/metrics/aggregate'
import { fmtEur } from '@hames-ai/harness-patterns/observability/token-totals'

// ============================================================================
// Formatting
// ============================================================================

/** 1234 → "1.2k", 2_500_000 → "2.50M". */
const fmtTok = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** A `≥` in front of a figure that only some of the bill is visible for — see
 *  `MetricTotals.timePricedCalls`. Nothing when every priced call was billed by
 *  the token, which is a number this app can state exactly. */
const floorMark = (s: MetricSummary): string => (s.timePricedCalls > 0 ? '≥ ' : '')

const fmtPct = (v: number): string => `${Math.round(v * 100)}%`

const fmtWhen = (ms: number): string => new Date(ms).toLocaleString()

/** Wake waits and call durations: 9_400 → "9.4s", 157_000 → "2m 37s". Below
 *  10s one decimal keeps a sub-second reading from rounding to a bare 0s. */
const fmtMs = (ms: number): string => {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

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
    bg="ui-bg-secondary"
    border="1 ui-border-primary"
    title={props.title}
  >
    <span text="xs ui-text-tertiary" tracking="wide" uppercase>
      {props.label}
    </span>
    <span text={`2xl ${props.tone ?? 'ui-text-primary'}`} font="mono">
      {props.value}
    </span>
    <Show when={props.hint}>
      <span text="xs ui-text-secondary">{props.hint}</span>
    </Show>
    {props.children}
  </div>
)

/** One GPU box's wake-wait window: count, median and slowest, with the basis.
 *  "—" means this app process has measured no wake — the chat's countdown then
 *  runs on its named fallback constant, and this card does not dress that up as
 *  a reading. */
const BoxWakeCard = (props: {
  label: string
  stats: MetricsDashboard['inference']['large']
  title: string
}) => (
  <Card
    label={props.label}
    value={
      props.stats.medianMs === null
        ? '—'
        : `${fmtMs(props.stats.medianMs)} / ${fmtMs(props.stats.slowestMs!)}`
    }
    hint={
      props.stats.samples > 0
        ? `median / slowest of ${props.stats.samples} wake(s) · ${props.stats.basis}`
        : 'no wake measured by this process yet'
    }
    title={props.title}
  />
)
/** Input-token composition: fresh / cache read / cache write, as one bar.
 *
 *  Cache segments render only when the scope contains a token-priced step
 *  (`tokenPricedCalls > 0`): on a purely wall-clock-billed scope caching is not
 *  a billing variable, and a bar reading "75% cache" would dress a GPU-second
 *  figure in token-price colours. */
const CompositionBar = (props: { summary: MetricSummary }) => {
  const total = () => Math.max(1, props.summary.inputTotalTokens)
  const seg = (n: number) => `${(n / total()) * 100}%`
  const showCache = () => props.summary.tokenPricedCalls > 0
  return (
    <div flex="~ col" gap="2" m="t-2">
      <div flex="~" h="2" w="full" rounded="full" overflow="hidden" bg="ui-bg-tertiary">
        <div
          bg="ui-success"
          style={{ width: seg(props.summary.inputUncachedTokens) }}
          title={`Uncached input: ${props.summary.inputUncachedTokens.toLocaleString()} tokens`}
        />
        <Show when={showCache()}>
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
        </Show>
      </div>
      <div flex="~ wrap" gap="3" text="xs ui-text-secondary">
        <span>
          <span text="ui-success">■</span> fresh {fmtTok(props.summary.inputUncachedTokens)}
        </span>
        <Show when={showCache()}>
          <span>
            <span text="violet-400">■</span> cache read {fmtTok(props.summary.inputCacheReadTokens)}
          </span>
          <span>
            <span text="amber-400">■</span> cache write{' '}
            {fmtTok(props.summary.inputCacheWriteTokens)}
          </span>
        </Show>
      </div>
    </div>
  )
}

const Th = (props: {
  children: import('solid-js').JSX.Element
  right?: boolean
  title?: string
}) => (
  // Alignment stays an inline style: `text="right"` emits no CSS under this
  // UnoCSS config (verified against the built stylesheet), unlike `text="left"`.
  <th
    p="x-3 y-2"
    text="xs ui-text-tertiary"
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
    text="sm ui-text-primary"
    font={props.mono === false ? undefined : 'mono'}
    title={props.title}
    style={{ 'text-align': props.right ? 'right' : 'left' }}
  >
    {props.children}
  </td>
)

const SectionTitle = (props: { title: string; note?: string }) => (
  <div flex="~ wrap" items="baseline" gap="3" m="b-3">
    <h2 text="lg ui-text-primary" font="medium">
      {props.title}
    </h2>
    <Show when={props.note}>
      <span text="xs ui-text-tertiary">{props.note}</span>
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
      {/* Cache is a token-pricing phenomenon: a scope billed entirely by
          wall-clock saves nothing by caching, so it gets a dash, not a 0%. */}
      <Show
        when={props.summary.tokenPricedCalls > 0}
        fallback={<span text="ui-text-tertiary">—</span>}
      >
        <span text={props.summary.cacheHitRate > 0 ? 'violet-400' : 'ui-text-tertiary'}>
          {fmtPct(props.summary.cacheHitRate)}
        </span>
      </Show>
    </Td>
    <Td right>
      <Show when={props.summary.pricedCalls > 0} fallback={<span text="ui-text-tertiary">—</span>}>
        {floorMark(props.summary)}
        {fmtEur(props.summary.costEur)}
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
    <main flex="~ col" gap="6" p="6" bg="ui-bg-primary" text="ui-text-primary" font="sans">
      <header flex="~ wrap" items="center" gap="4">
        <div flex="~ col" gap="1">
          <h1 text="2xl ui-text-primary" font="medium">
            Metrics
          </h1>
          <span text="xs ui-text-secondary">
            Tokens, tool calls and estimated cost (EUR) across your conversations — cache figures
            shown only where token-priced steps ran
          </span>
        </div>
        <div flex="~" items="center" gap="2" m="l-auto">
          <Show when={data()}>
            {(d) => (
              <span text="xs ui-text-tertiary" font="mono">
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
            text="xs ui-text-primary"
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
          <div p="6" text="sm ui-text-tertiary">
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
                bg="ui-bg-secondary"
                border="1 ui-border-primary"
                text="sm ui-text-secondary"
                flex="~ col"
                gap="2"
              >
                <span text="ui-text-primary">No LLM activity recorded yet.</span>
                <span text="xs ui-text-tertiary">
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
              {/* Exactly four tiles at desktop in every view, so the row never
                  wraps (owner feedback on the round-1 screenshots): the merged
                  cost tile plus hit-rate / output / tool calls when a
                  token-priced step exists, or the cost tile plus output / tool
                  calls / GPU compute time on a purely wall-clock-billed one.
                  Two columns at 390 px — the owner called a clean 2-column wrap
                  fine there. */}
              <div grid="~ cols-2 lg:cols-4" gap="4">
                {/* Same rule as the table's cost column: no priced step means no
                    figure, not €0.0000. The caching saving is this tile's
                    secondary line rather than its own tile (owner feedback): it
                    is the same figure's other half, and the merge keeps the row
                    at four tiles in the cached view. */}
                <Card
                  label="Estimated cost"
                  value={
                    totals()!.pricedCalls > 0
                      ? `${floorMark(totals()!)}${fmtEur(totals()!.costEur)}`
                      : '—'
                  }
                  tone={totals()!.pricedCalls > 0 ? 'ui-accent' : 'ui-text-tertiary'}
                  hint={
                    totals()!.pricedCalls < totals()!.meteredCalls
                      ? `${totals()!.pricedCalls}/${totals()!.meteredCalls} steps priced`
                      : 'all steps priced'
                  }
                  title={
                    'Sum of per-call estimates stamped with the rates in force at call time. ' +
                    'Token-priced clients use the vendor list price converted at a static USD→EUR ' +
                    'rate — no live FX.' +
                    (totals()!.timePricedCalls > 0
                      ? ` ${totals()!.timePricedCalls} step(s) ran on the self-hosted GPU, which bills` +
                        ' wall-clock rather than tokens, so the total is a FLOOR: it covers the' +
                        " calls' own duration, not the idle window the box stays warm afterwards" +
                        ' nor the cold start before the first call.'
                      : '')
                  }
                >
                  {/* No token-priced step ⇒ no saving line at all — a purely
                      wall-clock-billed scope saves nothing by caching, and a
                      fabricated €0.00 would read as a measured figure. */}
                  <Show when={totals()!.tokenPricedCalls > 0}>
                    <span text="xs ui-success">
                      {`saved ${fmtEur(totals()!.savingsEur)} by caching (${fmtPct(
                        totals()!.savingsPct,
                      )} off ${fmtEur(totals()!.noCacheEur)} uncached)`}
                    </span>
                  </Show>
                </Card>
                <Show when={totals()!.tokenPricedCalls > 0}>
                  <Card
                    label="Cache hit-rate"
                    value={fmtPct(totals()!.cacheHitRate)}
                    tone="violet-400"
                    hint={`${fmtTok(totals()!.inputCacheReadTokens)} of ${fmtTok(
                      totals()!.inputTotalTokens,
                    )} input tokens`}
                    title="Share of input tokens served from cache (billed at 0.1× the base input rate)"
                  />
                </Show>
                <Card
                  label="Output tokens"
                  value={fmtTok(totals()!.outputTokens)}
                  tone="ui-accent"
                  hint={`${fmtTok(totals()!.totalTokens)} tokens in total`}
                />
                <Card
                  label="Tool calls"
                  value={String(totals()!.toolCalls)}
                  hint={
                    totals()!.toolCalls > 0
                      ? totals()!.toolFailures > 0
                        ? `${totals()!.toolFailures} failed`
                        : 'none failed'
                      : 'none recorded in these conversations'
                  }
                  title="tool_call events in the folded conversations; a failure is a tool_result whose success is false. Independent of the LLM tier."
                />
                {/* The purely self-deployed view's fourth slot (owner feedback:
                    three tiles left one blank): the GPU compute-time floor, a
                    figure the fold already sums off `timeRate.durationMs`. It
                    only fills this slot when NO token-priced step exists — a
                    mixed scope already renders four tiles and its compute
                    seconds are part of the ≥ cost figure above. */}
                <Show when={totals()!.timePricedCalls > 0 && totals()!.tokenPricedCalls === 0}>
                  <Card
                    label="GPU compute time"
                    value={totals()!.timePricedMs > 0 ? `≥ ${fmtMs(totals()!.timePricedMs)}` : '—'}
                    tone="ui-accent"
                    hint="floor — the seconds of the calls themselves; not the idle window after, nor the cold start before"
                    title="Summed measured wall-clock of the time-priced attempts on the self-hosted GPUs (the stamps' timeRate). The box bills every second it is awake; this covers only the calls' own durations, so it is a floor on the compute bill, not the bill — the same reading the ≥ on the cost figure carries."
                  />
                </Show>
                <div
                  p="4"
                  rounded="lg"
                  bg="ui-bg-secondary"
                  border="1 ui-border-primary"
                  style={{ 'grid-column': '1 / -1' }}
                >
                  <div flex="~ wrap" items="baseline" gap="3">
                    <span text="xs ui-text-tertiary" tracking="wide" uppercase>
                      Input composition
                    </span>
                    <span text="sm ui-text-primary" font="mono">
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
            {/* Self-deployed inference                                     */}
            {/* ---------------------------------------------------------- */}
            <Show
              when={
                (d().inference.large.samples ?? 0) + (d().inference.small.samples ?? 0) > 0 ||
                totals()!.timePricedCalls > 0
              }
            >
              <section>
                <SectionTitle
                  title="Self-deployed inference"
                  note="wake waits recorded by this app process — a restart empties them, and another instance holds its own"
                />
                <div grid="~ cols-1 sm:cols-2" gap="4">
                  <BoxWakeCard
                    label="27B wake-ups (GPU boot-up)"
                    stats={d().inference.large}
                    title="How long the large box took to answer its first request after scaling to zero. Each figure is a wake poll's TOTAL wait — the cold-start countdown in the chat header estimates from the same window."
                  />
                  <BoxWakeCard
                    label="4B wake-ups (GPU boot-up)"
                    stats={d().inference.small}
                    title="How long the small box took to answer its health check after scaling to zero. Same window the chat's cold-start estimate uses."
                  />
                </div>
                <Show
                  when={
                    d().inference.large.medianMs !== null ||
                    d().inference.selfDeployedCall.p50Ms !== null
                  }
                >
                  <div grid="~ cols-1 sm:cols-2" gap="4" m="t-4">
                    <Card
                      label="Cold: first answer after a wake (27B)"
                      value={
                        d().inference.large.medianMs === null
                          ? '—'
                          : fmtMs(d().inference.large.medianMs!)
                      }
                      tone="ui-accent"
                      hint={`${d().inference.large.samples} wake(s) — the wait is to a 1-token probe, so this is time-to-first-token after a cold start`}
                      title="The closest honest cold figure the records hold: the median total wait of this process's wake polls on the large box. The probe is a 1-token completion, so the wait is effectively time to first token on a cold box."
                    />
                    <Card
                      label="Warm: recent call duration (self-hosted tier)"
                      value={
                        d().inference.selfDeployedCall.p50Ms === null
                          ? '—'
                          : fmtMs(d().inference.selfDeployedCall.p50Ms!)
                      }
                      tone="ui-accent"
                      hint={`${d().inference.selfDeployedCall.samples} recent call(s) — a whole call's duration, NOT time-to-first-token`}
                      title="Median duration of the last 32 model calls on the self-deployed tier. It is the warm-ish contrast to the cold figure beside it, not a matched measurement: it covers a full call's generation, not its first token, and no warm time-to-first-token is recorded. (Under wake-then-run a cold start is paid by the wake poll before the harness starts, so a completed call's duration does not include one.)"
                    />
                  </div>
                </Show>
              </section>
            </Show>

            {/* ---------------------------------------------------------- */}
            {/* Per-pattern                                                */}
            {/* ---------------------------------------------------------- */}
            <section>
              <SectionTitle
                title="By pattern"
                note={`${d().byPattern.length} pattern${d().byPattern.length === 1 ? '' : 's'} · ranked by estimated cost`}
              />
              <div rounded="lg" bg="ui-bg-secondary" border="1 ui-border-primary" overflow="auto">
                <table w="full" border="collapse">
                  <thead bg="ui-bg-tertiary">
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
                        <tr border="t ui-border-primary">
                          <Td mono={false}>
                            <span text="sm ui-accent" font="mono">
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
              <div rounded="lg" bg="ui-bg-secondary" border="1 ui-border-primary" overflow="auto">
                <table w="full" border="collapse">
                  <thead bg="ui-bg-tertiary">
                    <tr>
                      <Th>Conversation</Th>
                      <Th>Agent</Th>
                      <Th right>Steps</Th>
                      <Th right>Input</Th>
                      <Th right>Output</Th>
                      <Th right>Cached</Th>
                      <Th right>Cost</Th>
                      <Th
                        right
                        title="tool_call events in this conversation; failures in parentheses"
                      >
                        Tools
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={d().byConversation}>
                      {(row) => (
                        <tr border="t ui-border-primary">
                          <Td mono={false} title={`Last activity ${fmtWhen(row.updatedAt)}`}>
                            <span text="sm ui-text-primary">{row.title ?? 'Untitled'}</span>
                            <Show when={row.summary.unmeteredCalls > 0}>
                              <span text="xs amber-300" m="l-2">
                                +{row.summary.unmeteredCalls} unmetered
                              </span>
                            </Show>
                          </Td>
                          <Td mono={false}>
                            <span text="xs ui-text-tertiary" font="mono">
                              {row.agentId}
                            </span>
                          </Td>
                          <SummaryCells summary={row.summary} />
                          <Td right>
                            {row.summary.toolCalls > 0
                              ? `${row.summary.toolCalls}${
                                  row.summary.toolFailures > 0
                                    ? ` (${row.summary.toolFailures})`
                                    : ''
                                }`
                              : '—'}
                          </Td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </section>

            <footer flex="~ col" gap="1" text="xs ui-text-secondary" m="t-2">
              <Show
                when={totals()!.tokenPricedCalls > 0}
                fallback={
                  <span>
                    Every figure is in euro. Steps whose client could not be priced are counted but
                    left out of the cost columns.
                  </span>
                }
              >
                <span>
                  Every figure is in euro. Token-priced clients are priced at the $/MTok rates in
                  force for the client that served each step (see{' '}
                  <span font="mono">CLIENT_PRICING</span> in{' '}
                  <span font="mono">lib/settings.ts</span>
                  ), with cache reads at 0.1× and cache writes at 1.25× the base input rate,
                  converted at a static USD→EUR rate (<span font="mono">EUR_PER_USD</span>) — there
                  is no live FX lookup. Steps whose client could not be priced are counted but left
                  out of the cost columns.
                </span>
              </Show>
              <Show when={totals()!.timePricedCalls > 0}>
                <span>
                  A <span font="mono">≥</span> marks a figure that includes wall-clock-billed steps.
                  The self-hosted GPUs bill by the second they are awake (
                  <span font="mono">LARGE_LLM_EUR_PER_HOUR</span>, and
                  <span font="mono"> SMALL_LLM_EUR_PER_HOUR</span> — the small box's L4 rate, with
                  per-GPU overrides for the fallback types it can land on, and the highest known
                  rate shown when the served GPU could not be read) and their tokens are free, but
                  the only seconds visible here are the durations of the calls themselves — not the
                  idle window the box stays warm for afterwards, nor the cold start before the first
                  call. Those figures are floors on the bill, not the bill.
                </span>
              </Show>
            </footer>
          </Show>
        )}
      </Show>
    </main>
  )
}
