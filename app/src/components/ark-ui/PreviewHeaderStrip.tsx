/**
 * Preview header strip — the inference-tier switch, the self-hosted box's warm
 * state, and a few global counters.
 *
 * One compact cluster in the top bar, not a dashboard: `/dashboard` is where
 * numbers get room, and anything needing a second line belongs there. Every
 * value is measured rather than estimated (see
 * `metrics/preview-counters.server.ts` for what each one counts), and nothing
 * here opens a conversation blob — the whole strip is one round trip over two
 * small indexed reads, which is what makes it safe to poll beside a live chat.
 *
 * ## No layout shift
 *
 * The strip sits next to controls a user clicks, so a value that widens as it
 * ticks would shove them sideways once a second. Three things prevent that:
 * every numeric field is `font="mono"` (fixed-width digits), the countdown is
 * always `m:ss` and compact numbers keep one decimal
 * (`lib/preview-header-format.ts`), and each field reserves its width with
 * `min-w`.
 *
 * ## Polling
 *
 * The top bar has no SSE channel — the app's only stream is the per-turn POST
 * in `routes/api/events.ts`, which lives for the duration of one answer. So
 * this polls one server action on a timer and ticks the countdown locally in
 * between, against the server's `generatedAt` rather than by counting its own
 * intervals, so a backgrounded tab resumes on the right number instead of
 * however many callbacks it managed to run.
 *
 * ## Accessibility
 *
 * The warm state is a word, not a colour (`color-not-only`), and only that word
 * is announced: the countdown is `aria-hidden` because a live region that
 * re-reads a number every second is noise, not information.
 *
 * ## Themes
 *
 * Dark tokens only, per the house styleguide — `uno.config.ts` defines exactly
 * one palette and there is no light token set behind `ThemeSwitcher` today, so
 * this strip reads identically in both switcher positions because everything
 * around it does. Flagged in the PR body rather than papered over with `dark:`
 * variants nothing could test.
 */
import { createSignal, createMemo, onMount, onCleanup, Show } from 'solid-js'
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
  formatShare,
  remainingSeconds,
} from '~/lib/preview-header-format'

/** How often the strip re-reads the server. Slower than the countdown ticks
 *  (which are local arithmetic): the numbers behind it move on the scale of a
 *  turn, not a second. */
export const POLL_INTERVAL_MS = 15_000
/** How often the countdown re-renders. */
export const TICK_INTERVAL_MS = 1_000

/** Warm state → the word, the glyph and the tone that carry it. The word is
 *  not decoration: a bare coloured dot fails `color-not-only`, and "warm" vs
 *  "cold" is the whole content of the indicator anyway. */
export const WARMTH_PRESENTATION = {
  running: {
    word: 'answering',
    icon: 'i-material-symbols-bolt',
    tone: 'cyan-400',
    hint: 'A chat is running on the self-hosted endpoint right now.',
  },
  warm: {
    word: 'warm',
    icon: 'i-material-symbols-local-fire-department-outline',
    tone: 'amber-500',
    hint:
      'The self-hosted endpoint is up. It scales to zero when the countdown reaches nought, and ' +
      'the next message then pays a cold start of minutes.',
  },
  cold: {
    word: 'cold',
    icon: 'i-material-symbols-ac-unit',
    tone: 'dark-text-tertiary',
    hint: 'The self-hosted endpoint has scaled to zero. The next message pays a cold start of minutes.',
  },
  unknown: {
    word: 'unknown',
    icon: 'i-material-symbols-help-outline',
    tone: 'dark-text-tertiary',
    hint:
      'This server has not seen a call to the self-hosted endpoint yet, so it cannot tell cold ' +
      'from warm.',
  },
} as const

type WarmthKey = keyof typeof WARMTH_PRESENTATION

/** One glanceable number. `min-w` on the value is what keeps the row still
 *  while the value changes width. */
const Metric = (props: {
  icon: string
  label: string
  value: string
  tone: string
  hint: string
}) => (
  <div flex="~" items="center" gap="1" title={props.hint}>
    <span class={props.icon} w="3.5" h="3.5" text={props.tone} aria-hidden="true" />
    <span text="xs dark-text-primary right" font="mono" min-w="8">
      {props.value}
    </span>
    <span text="xs dark-text-tertiary">{props.label}</span>
  </div>
)

export const PreviewHeaderStrip = () => {
  const [state, setState] = createSignal<PreviewHeaderState | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  /** Bumped only when the server's answer disagrees with the click — see
   *  `chooseTier`. Used as a `keyed` Show value, so the switch is rebuilt on
   *  server truth instead of keeping its own optimistic selection. */
  const [revision, setRevision] = createSignal(0)

  const load = async () => {
    try {
      setState(await getPreviewHeaderState())
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
    return remainingSeconds(s.warmth.secondsUntilScaledown, s.generatedAt, now())
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
              <SegmentGroup.Label text="xs dark-text-tertiary">Model</SegmentGroup.Label>
              <div
                flex="~"
                items="center"
                gap="0.5"
                p="0.5"
                rounded="md"
                bg="dark-bg-tertiary"
                border="1 dark-border-primary"
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
                  ring="2 transparent focus-within:neon-cyan/40"
                  text={s().tier === 'verda' ? 'xs neon-cyan' : 'xs dark-text-secondary'}
                  bg={s().tier === 'verda' ? 'neon-cyan/10' : 'transparent hover:dark-bg-hover'}
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
                  ring="2 transparent focus-within:neon-cyan/40"
                  text={s().tier === 'anthropic' ? 'xs neon-magenta' : 'xs dark-text-secondary'}
                  bg={
                    s().tier === 'anthropic' ? 'neon-magenta/10' : 'transparent hover:dark-bg-hover'
                  }
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
              <span
                class={WARMTH_PRESENTATION[warmthKey()].icon}
                w="3.5"
                h="3.5"
                text={WARMTH_PRESENTATION[warmthKey()].tone}
                aria-hidden="true"
              />
              <span text={`xs ${WARMTH_PRESENTATION[warmthKey()].tone}`} aria-hidden="true">
                {WARMTH_PRESENTATION[warmthKey()].word}
              </span>
              <Show when={warmthKey() === 'warm' && countdown() !== null}>
                <span text="xs dark-text-tertiary right" font="mono" min-w="9" aria-hidden="true">
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
          <div flex="~" items="center" gap="3" border="l dark-border-primary" p="l-3">
            <Metric
              icon="i-material-symbols-group-outline"
              label="active"
              tone="cyan-400"
              value={formatCompactNumber(s().activeUsers)}
              hint={`Distinct people with chat activity in the last ${s().activeWindowMinutes} minutes.`}
            />
            <Metric
              icon="i-material-symbols-token-outline"
              label="tokens"
              tone="neon-cyan"
              value={formatCompactNumber(s().usage.totalTokens)}
              hint="Input + output tokens across everyone today (UTC), counted since this counter shipped."
            />
            <Metric
              icon="i-material-symbols-forum-outline"
              label="turns"
              tone="violet-400"
              value={formatCompactNumber(s().usage.turns)}
              hint="Chat turns started across everyone today (UTC)."
            />
            <Show when={s().verdaAvailable}>
              <Metric
                icon="i-material-symbols-shield-outline"
                label="on-prem"
                tone="emerald-500"
                value={formatShare(s().usage.verdaCallShare)}
                hint="Share of today's model calls that ran on the company-hosted deployment. Measured from the client each call actually used, not from the setting."
              />
            </Show>
          </div>

          <Show when={error()}>
            <span role="status" text="xs amber-500" title={error() ?? undefined}>
              stale
            </span>
          </Show>
        </div>
      )}
    </Show>
  )
}
