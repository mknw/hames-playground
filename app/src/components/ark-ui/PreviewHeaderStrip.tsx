/**
 * Preview header strip — the inference-tier switch, the self-hosted box's warm
 * state, and a few global counters.
 *
 * One compact cluster in the top bar, not a dashboard: `/dashboard` is where
 * numbers get room, and anything needing a second line belongs there. Every
 * value is measured rather than estimated (see
 * `metrics/preview-counters.server.ts` for what each one counts), and nothing
 * here opens a conversation blob — the whole strip is one round trip over two
 * small indexed reads and two process-local readings, which is what makes it
 * safe to poll beside a live chat. Two of the numbers are what THIS server has
 * seen (the warm state and the latency median) rather than deployment-wide, and
 * both say so in their tooltip.
 *
 * ## No layout shift
 *
 * The strip sits next to controls a user clicks, so a value that widens as it
 * ticks would shove them sideways once a second. Three things prevent that:
 * every numeric field is `font="mono"` (fixed-width digits), the countdown is
 * always `m:ss`, and compact numbers and the latency figure keep one decimal
 * and a fixed unit width (`lib/preview-header-format.ts`), and each field
 * reserves its width with `min-w`.
 *
 * ## Polling
 *
 * The top bar has no SSE channel — the app's only stream is the per-turn POST
 * in `routes/api/events.ts`, which lives for the duration of one answer. So
 * this polls one server action on a timer and ticks the countdown locally in
 * between, against the wall-clock time THIS browser received the payload rather
 * than by counting its own intervals, so a backgrounded tab resumes on the right
 * number instead of however many callbacks it managed to run. Both ends of that
 * subtraction are stamped in the same browser (see `receivedAt`), so a clock
 * skewed against the server changes nothing.
 *
 * ## Accessibility
 *
 * The warm state is a word, not a colour (`color-not-only`), and only that word
 * is announced: the countdown is `aria-hidden` because a live region that
 * re-reads a number every second is noise, not information.
 *
 * ## Themes
 *
 * On the theme-aware `ui-*` tokens (#226 B8), like the bar it sits in — never
 * `dark-*`, and never a `dark:` variant: the token flips, the component does
 * not. The strip is chrome, so `theme-migration.test.ts` gates it.
 *
 * The fixed hues (`cyan-400`, `amber-500`, `violet-400`, `emerald-500`) stay,
 * matching the rest of the chrome: they are mid-tone GLYPH colours that read on
 * both grounds. They are grandfathered, not a precedent — the latency glyph
 * added after them is `ui-text-secondary`, because the styleguide's rule is
 * token before hex and a duration has no status hue to claim.
 *
 * Nothing that has to be read is one of the fixed hues — the values, the
 * labels, the warm-state word and both degradation chips are `ui-text-*` /
 * `ui-danger`, because `amber-500` on the light ground is about 2:1.
 *
 * The tier switch marks its selection with `ui-accent` in BOTH positions rather
 * than a hue per tier. The tiers are already distinguished by an icon, a word
 * and the radio state; the second hue it used to carry was `neon-magenta`,
 * which the light palette has no darkened twin for and which nothing else in
 * the chrome uses any more.
 */
import { createSignal, createMemo, onMount, onCleanup, Show, type JSX } from 'solid-js'
import { SegmentGroup } from '@ark-ui/solid/segment-group'
import {
  getPreviewHeaderState,
  setPreviewInferenceTier,
  type PreviewHeaderState,
} from '~/lib/harness-client/preview-header.server'
import {
  TIER_LABELS,
  formatCompactNumber,
  formatCountdown,
  formatLatency,
  formatShare,
  remainingSeconds,
} from '~/lib/preview-header-format'

/** How often the strip re-reads the server. Slower than the countdown ticks
 *  (which are local arithmetic): the numbers behind it move on the scale of a
 *  turn, not a second. */
export const POLL_INTERVAL_MS = 15_000
/** How often the countdown re-renders. */
export const TICK_INTERVAL_MS = 1_000

/** Warm state → the word and the glyph that carry it. The word is not
 *  decoration: a bare coloured dot fails `color-not-only`, and "warm" vs "cold"
 *  is the whole content of the indicator anyway.
 *
 *  The glyph is a THUNK returning literal JSX rather than an icon-name/tone
 *  pair, for the reason spelled out on `Metric` below: a colour applied as
 *  `text={props.tone}` is invisible to UnoCSS's extractor and emits no CSS at
 *  all. Written this way the colour cannot be resolved at runtime, so it cannot
 *  silently fail to exist. */
export const WARMTH_PRESENTATION = {
  running: {
    word: 'answering',
    glyph: () => (
      <span class="i-material-symbols-bolt" w="3.5" h="3.5" text="cyan-400" aria-hidden="true" />
    ),
    hint: 'A chat is running on the self-hosted endpoint, which was already up when it started.',
  },
  starting: {
    word: 'starting',
    glyph: () => (
      <span
        class="i-material-symbols-hourglass-top"
        w="3.5"
        h="3.5"
        text="amber-500"
        aria-hidden="true"
      />
    ),
    hint:
      'A chat is running on the self-hosted endpoint, but nothing recent shows the endpoint was ' +
      'up — so it is probably paying a cold start of minutes. Sending now joins the same wait.',
  },
  warm: {
    word: 'warm',
    glyph: () => (
      <span
        class="i-material-symbols-local-fire-department-outline"
        w="3.5"
        h="3.5"
        text="amber-500"
        aria-hidden="true"
      />
    ),
    hint:
      'The self-hosted endpoint is up. It scales to zero when the countdown reaches nought, and ' +
      'the next message then pays a cold start of minutes.',
  },
  cold: {
    word: 'cold',
    glyph: () => (
      <span
        class="i-material-symbols-ac-unit"
        w="3.5"
        h="3.5"
        text="ui-text-tertiary"
        aria-hidden="true"
      />
    ),
    hint: 'The self-hosted endpoint has scaled to zero. The next message pays a cold start of minutes.',
  },
  unknown: {
    word: 'unknown',
    glyph: () => (
      <span
        class="i-material-symbols-help-outline"
        w="3.5"
        h="3.5"
        text="ui-text-tertiary"
        aria-hidden="true"
      />
    ),
    hint:
      'This server has not seen a call to the self-hosted endpoint yet, so it cannot tell cold ' +
      'from warm.',
  },
} as const

type WarmthKey = keyof typeof WARMTH_PRESENTATION

/** One glanceable number. `min-w` on the value is what keeps the row still
 *  while the value changes width.
 *
 *  `min-w="9"` is 2.25rem, which is 3.0em at `text-xs` — five monospace
 *  characters at the 0.6em advance every face in the `font-mono` stack has, and
 *  the same value the `m:ss` countdown beside it uses for the same maximum.
 *  `min-w="8"` was one step short of the five characters `formatLatency` and
 *  `formatCompactNumber` can both render (`99.9m`, `12.5k`). One value can
 *  still exceed it — `formatCompactNumber` reaches six at `999.9k` — and that
 *  is a field widening, not a control moving: the metrics cluster sits after the
 *  tier switch and `Nav`'s icon row is pinned by `m="l-auto"`.
 *
 *  The glyph is passed in as a CHILD rather than as `icon` + `tone` props on
 *  purpose. UnoCSS extracts attributify utilities from literal `attr="value"`
 *  text in the source, so a runtime-resolved `text={props.tone}` produces no
 *  CSS at all — the value is simply never seen by the build. That is the
 *  silent kind of failure (no error, an element that just renders uncoloured),
 *  and it had already happened: `emerald-500` was absent from the built bundle
 *  while the other three tones survived only because unrelated components
 *  happened to spell them out. Keeping the colour at the call site keeps every
 *  tone literal in this file, so nothing here depends on another component. */
const Metric = (props: { label: string; value: string; hint: string; children: JSX.Element }) => (
  <div flex="~" items="center" gap="1" title={props.hint}>
    {props.children}
    <span text="xs ui-text-primary right" font="mono" min-w="9">
      {props.value}
    </span>
    <span text="xs ui-text-tertiary">{props.label}</span>
  </div>
)

export const PreviewHeaderStrip = () => {
  const [state, setState] = createSignal<PreviewHeaderState | null>(null)
  /** When THIS browser received the payload above. The countdown ticks against
   *  it rather than against the server's `generatedAt`, because subtracting a
   *  server stamp from a client `Date.now()` measures clock skew as well as
   *  elapsed time — on a skewed clock the countdown jumps at each poll instead
   *  of ticking, and a far-enough-behind client would read a full window as
   *  already expired. Both stamps are `Date.now()` in the same browser, so the
   *  difference is elapsed time and nothing else. */
  const [receivedAt, setReceivedAt] = createSignal(Date.now())
  const [now, setNow] = createSignal(Date.now())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  /** Bumped only when the server's answer disagrees with the click — see
   *  `chooseTier`. Used as a `keyed` Show value, so the switch is rebuilt on
   *  server truth instead of keeping its own optimistic selection. */
  const [revision, setRevision] = createSignal(0)

  const load = async () => {
    try {
      const next = await getPreviewHeaderState()
      setState(next)
      setReceivedAt(Date.now())
      setError(null)
    } catch {
      // A poll that cannot reach the server leaves the last known values on
      // screen rather than blanking the bar — but it must not keep presenting
      // them as live, so the strip dims and says "stale".
      setError('The preview status could not be refreshed.')
    }
  }

  onMount(() => {
    void load()
    const poll = setInterval(() => void load(), POLL_INTERVAL_MS)
    const tick = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(tick)
    })
  })

  /** The countdown, ticked locally between polls; `null` when there is nothing
   *  to count down. */
  const countdown = createMemo(() => {
    const s = state()
    if (!s) return null
    return remainingSeconds(s.warmth.secondsUntilScaledown, receivedAt(), now())
  })

  const warmthKey = createMemo<WarmthKey>(() => {
    const s = state()
    if (!s) return 'unknown'
    // The local clock is allowed to EXPIRE the window early; it is never
    // allowed to extend one, which is why only this direction is derived here
    // and the other waits for the server.
    if (s.warmth.state === 'warm' && countdown() === 0) return 'cold'
    return s.warmth.state
  })

  const chooseTier = async (value: string) => {
    if (value !== 'verda' && value !== 'anthropic') return
    if (value === state()?.tier) return
    setBusy(true)
    try {
      const next = await setPreviewInferenceTier(value)
      setState(next)
      setReceivedAt(Date.now())
      setError(null)
      // The server is the authority and may not agree with the click (it
      // refuses the self-hosted position on a deployment with no endpoint).
      // The segment group holds its own selection internally, and re-rendering
      // it with the SAME `value` it started with does not move it back — so
      // when the answer differs from what was asked, remount it on the
      // authoritative value. Anything less leaves the switch showing one tier
      // while the next turn runs on another, which is worse than no switch.
      if (next.tier !== value) setRevision((r) => r + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the inference tier.')
      setRevision((r) => r + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* A failing FIRST poll leaves `state()` null, and the strip below is
          gated on it — so without this the bar is EMPTY, and a permanently
          broken action (Postgres down, the table missing) is indistinguishable
          from a deployment that never shipped the feature. The stale path below
          keeps the last known values; this one has none to keep, so it says so
          rather than showing nothing. */}
      <Show when={!state() && error()}>
        <span
          role="status"
          text="xs ui-danger"
          title={error() ?? undefined}
          data-testid="preview-header-unavailable"
        >
          preview status unavailable
        </span>
      </Show>
      <Show when={state()}>
        {(s) => (
          <div
            role="group"
            aria-label="Preview status"
            flex="~"
            items="center"
            gap="3"
            op={error() ? '60' : '100'}
            transition="opacity"
          >
            {/* ---- Inference-tier switch --------------------------------- */}
            {/* `keyed` on the revision: the segment group owns its selection
              internally, so the only way to force it back onto server truth is
              to rebuild it. The value changes rarely (see `chooseTier`), so
              this is not a per-poll remount. */}
            <Show when={revision() + 1} keyed>
              <SegmentGroup.Root
                value={s().tier}
                onValueChange={(details) => void chooseTier(details.value ?? '')}
                disabled={busy()}
                flex="~"
                items="center"
                gap="2"
              >
                <SegmentGroup.Label text="xs ui-text-tertiary">Model</SegmentGroup.Label>
                <div
                  flex="~"
                  items="center"
                  gap="0.5"
                  p="0.5"
                  rounded="md"
                  bg="ui-bg-tertiary"
                  border="1 ui-border-primary"
                >
                  <SegmentGroup.Item
                    value="verda"
                    disabled={!s().verdaAvailable}
                    flex="~"
                    items="center"
                    gap="1"
                    p="x-2 y-1"
                    rounded="sm"
                    cursor="pointer"
                    transition="all"
                    ring="2 transparent focus-within:ui-accent/40"
                    text={s().tier === 'verda' ? 'xs ui-accent' : 'xs ui-text-secondary'}
                    bg={s().tier === 'verda' ? 'ui-accent/10' : 'transparent hover:ui-bg-hover'}
                    op={s().verdaAvailable ? '100' : '50'}
                    title={
                      s().verdaAvailable
                        ? 'Run your chats on the company-hosted deployment — prompts stay on infrastructure we control.'
                        : 'The self-hosted endpoint is not configured on this deployment.'
                    }
                  >
                    <span
                      class="i-material-symbols-shield-lock-outline"
                      w="3.5"
                      h="3.5"
                      aria-hidden="true"
                    />
                    <SegmentGroup.ItemText>{TIER_LABELS.verda}</SegmentGroup.ItemText>
                    <SegmentGroup.ItemHiddenInput />
                  </SegmentGroup.Item>
                  <SegmentGroup.Item
                    value="anthropic"
                    flex="~"
                    items="center"
                    gap="1"
                    p="x-2 y-1"
                    rounded="sm"
                    cursor="pointer"
                    transition="all"
                    ring="2 transparent focus-within:ui-accent/40"
                    text={s().tier === 'anthropic' ? 'xs ui-accent' : 'xs ui-text-secondary'}
                    bg={s().tier === 'anthropic' ? 'ui-accent/10' : 'transparent hover:ui-bg-hover'}
                    title="Run your chats on Anthropic's hosted models."
                  >
                    <span
                      class="i-material-symbols-cloud-outline"
                      w="3.5"
                      h="3.5"
                      aria-hidden="true"
                    />
                    <SegmentGroup.ItemText>{TIER_LABELS.anthropic}</SegmentGroup.ItemText>
                    <SegmentGroup.ItemHiddenInput />
                  </SegmentGroup.Item>
                </div>
              </SegmentGroup.Root>
            </Show>

            {/* ---- Warm state -------------------------------------------- */}
            <Show when={s().verdaAvailable}>
              <div
                flex="~"
                items="center"
                gap="1"
                title={WARMTH_PRESENTATION[warmthKey()].hint}
                data-testid="verda-warmth"
              >
                {WARMTH_PRESENTATION[warmthKey()].glyph()}
                {/* The WORD is themed text, not the glyph's hue: `amber-500` on
                    the light ground is around 2:1, and the state has to be
                    readable in both. The hue rides the glyph beside it, which
                    carries no information of its own (`color-not-only`). */}
                <span text="xs ui-text-primary" aria-hidden="true">
                  {WARMTH_PRESENTATION[warmthKey()].word}
                </span>
                <Show when={warmthKey() === 'warm' && countdown() !== null}>
                  <span text="xs ui-text-tertiary right" font="mono" min-w="9" aria-hidden="true">
                    {formatCountdown(countdown() ?? 0)}
                  </span>
                </Show>
                {/* The only announced part: the state word, which changes rarely.
                  The countdown above is aria-hidden on purpose. */}
                <span sr-only aria-live="polite">
                  Self-hosted endpoint {WARMTH_PRESENTATION[warmthKey()].word}
                </span>
              </div>
            </Show>

            {/* ---- Metrics ----------------------------------------------- */}
            {/* `data-testid` so the browser suite's screenshot comparison can
                MASK this block: every figure in it (active people, today's
                tokens and turns, the rolling p50) is a live counter, so an
                unmasked header would diff against its own baseline on every
                run. Masked rather than stubbed — a stub would make the visual
                test assert a layout the app never renders. */}
            <div
              data-testid="preview-header-metrics"
              flex="~"
              items="center"
              gap="3"
              border="l ui-border-primary"
              p="l-3"
            >
              <Metric
                label="active"
                value={formatCompactNumber(s().activeUsers)}
                hint={`Distinct people with chat activity in the last ${s().activeWindowMinutes} minutes.`}
              >
                <span
                  class="i-material-symbols-group-outline"
                  w="3.5"
                  h="3.5"
                  text="cyan-400"
                  aria-hidden="true"
                />
              </Metric>
              <Metric
                label="tokens"
                value={formatCompactNumber(s().usage.totalTokens)}
                hint="Input + output tokens across everyone today (UTC), counted since this counter shipped. Every model call is counted, including the summarizer and the injection screen."
              >
                <span
                  class="i-material-symbols-token-outline"
                  w="3.5"
                  h="3.5"
                  text="ui-accent"
                  aria-hidden="true"
                />
              </Metric>
              <Metric
                label="turns"
                value={formatCompactNumber(s().usage.turns)}
                hint="Chat turns started across everyone today (UTC)."
              >
                <span
                  class="i-material-symbols-forum-outline"
                  w="3.5"
                  h="3.5"
                  text="violet-400"
                  aria-hidden="true"
                />
              </Metric>
              <Metric
                label="p50"
                value={formatLatency(s().latency.p50Ms)}
                hint={
                  s().latency.samples === 0
                    ? `No model call that the tier switch moves has completed on ${TIER_LABELS[s().tier]} on this server yet, so there is no median to show.`
                    : `Median duration of the last ${s().latency.samples} model call(s) on ${TIER_LABELS[s().tier]} — the tier your next message runs on. Counting only the calls the switch actually moves, so the two positions are comparable — which is now every model call a turn makes, with no exception. A mix of long and short calls, so this is well under what a reply takes: one model call, not one reply — a turn makes several. Counted by this server only, so another instance may show a different figure, and a restart clears it. A cold start is included, because it is time someone waited.`
                }
              >
                {/* A NEW glyph takes a theme token, not a fifth fixed hue: §4
                    of the styleguide is token-before-hex, and the four literal
                    mid-tones above predate the `ui-*` palette. There is also
                    nothing to say with a hue here — a duration is not a status,
                    and amber is the warm indicator's. */}
                <span
                  class="i-material-symbols-speed-outline"
                  w="3.5"
                  h="3.5"
                  text="ui-text-secondary"
                  aria-hidden="true"
                />
              </Metric>
              <Show when={s().verdaAvailable}>
                <Metric
                  label="on-prem"
                  value={formatShare(s().usage.verdaCallShare)}
                  hint="Share of today's model calls that ran on the company-hosted deployment. Measured from the client each call actually used, not from the setting, and over every model call the app makes — including the safety screen on fetched content, which follows the setting like everything else. A day on which every chat used the company-hosted setting reads 100%."
                >
                  <span
                    class="i-material-symbols-shield-outline"
                    w="3.5"
                    h="3.5"
                    text="emerald-500"
                    aria-hidden="true"
                  />
                </Metric>
              </Show>
            </div>

            <Show when={error()}>
              {/* `ui-danger`, not `amber-500`: this is text a user has to READ,
                  and amber on the light ground is about 2:1. */}
              <span role="status" text="xs ui-danger" title={error() ?? undefined}>
                stale
              </span>
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}
