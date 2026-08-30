/**
 * Preview header strip — the self-hosted box's warm state, and a few global
 * counters.
 *
 * **The tier switch is not here any more.** It moved beside the agent selector
 * and became per-conversation (`ConversationTierSwitch`), because the thing
 * people want is to start an Anthropic chat while a private one is still
 * waking. What is left in this strip describes the BOX and the deployment —
 * warm or cold, how many people are active, what today cost — none of which is
 * a claim about the conversation on screen, so nothing here can contradict the
 * switch. The one exception is the p50, which has to name a tier to be
 * meaningful; it names the one a NEW chat starts on and says so.
 *
 * One compact cluster in the top bar, not a dashboard: `/dashboard` is where
 * numbers get room, and anything needing a second line belongs there. Every
 * value is measured rather than estimated (see
 * `metrics/preview-counters.server.ts` for what each one counts), and nothing
 * here opens a conversation blob — the whole strip is one round trip over two
 * small indexed reads and two process-local readings, which is what makes it
 * safe to poll beside a live chat. Two of the numbers are what THIS server has
 * seen (the latency median, and the completion evidence behind `ready`) rather
 * than deployment-wide, and both say so in their tooltip; the cold/starting
 * halves of the warm state are an observation of the deployment itself, read
 * from the Verda control plane (`lib/inference/verda-control-plane.server.ts`)
 * and shared by every user of this process.
 *
 * ## The warm state's two sources
 *
 * `ready` is completion evidence ONLY — a real call the deployment answered
 * within the scale-down window (`verdaWarmth`'s clock). It never flips on a
 * timer or on the control plane. Everything else consults the control plane:
 * no replicas is `cold` (observed scaled-down, which is what retires the old
 * pre-message `unknown` — a process that had never seen a call used to be able
 * to say nothing about a box another instance was using), a replica present is
 * `starting` (the weight load happens inside the container, after the replica
 * reports), and only a probe failure — an error path — is `unknown`. The start
 * button renders in `cold` AND in `unknown`: the probe being down is not a
 * reason to strand a user who wants to warm the box.
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
 * The RATE is a function of what the last poll said — {@link POLL_INTERVAL_MS}
 * for a settled box, {@link ACTIVE_POLL_INTERVAL_MS} while one is mid-transition
 * — which is half of why the countdown was never seen; the other half is the
 * next section.
 *
 * ## Why nobody had seen the countdown
 *
 * It shipped working and unreachable, which is the failure mode a screenshot
 * cannot catch and a green suite does not either. Three independent causes, all
 * fixed here, all pinned — the third only became visible once the first two had
 * put the number on screen where a reviewer could watch it:
 *
 *  1. **The render site asked the wrong question.** It gated the number on
 *     `warmthKey() === 'warm'`, but `verdaWarmth()` also computes one for
 *     `running` — the state whose whole documented promise is that it implies
 *     warm, and the state a user is in for as long as their own turn is on the
 *     box. On a route whose first call costs minutes, that is nearly all of the
 *     time anyone is looking at this strip. The entitlement is now a property of
 *     the state (`WARMTH_PRESENTATION[...].countdown`) rather than a literal
 *     written here, so it cannot drift from the word again.
 *  2. **The strip learned too late.** With one 15-second interval for every
 *     state, the `cold` → `warm` flip a user's own message causes landed up to
 *     fifteen seconds after the answer they were watching for — by which time
 *     they had stopped looking. Hence the two rates.
 *  3. **The number `running` then showed did not count down.** It reset on every
 *     poll — `5:00 | 4:59 | 5:00 | 5:00 | 4:59` traced at one-second intervals —
 *     because the server re-sends the FULL window for that state and the client
 *     ran its local clock over it. The two fixes above are what made it visible:
 *     they put the figure on screen and then re-read it every three seconds
 *     instead of every fifteen. `running`'s figure is now rendered statically,
 *     which is what it always was (`shownSeconds`).
 *
 * ## Starting the box from here
 *
 * A cold indicator is also a BUTTON, and the only one in the app that acts on
 * the deployment rather than on a conversation: hovering it offers
 * {@link IGNITE_LABEL} and clicking calls `igniteVerdaBox`, which is the same
 * `ensureVerdaAwake` a turn uses — so a click during an in-flight wake joins it
 * and a click on a warm box costs nothing. The reasoning for reusing that entry
 * point rather than issuing a second wake is on the action itself.
 *
 * A start that FAILS has its own report ({@link IGNITE_FAILED_LABEL}, and
 * `igniteError`), separate from the poll's "stale". A wake can legitimately take
 * minutes, so the user who pressed it is by then somewhere else; a failure on
 * the poll's channel was worded as though some numbers were old and was cleared
 * by the next successful poll three seconds later, which left that user with a
 * cold indicator and nothing to read.
 *
 * ## Accessibility
 *
 * The warm state is a word, not a colour (`color-not-only`), and only that word
 * is announced: the countdown is `aria-hidden` because a live region that
 * re-reads a number every second is noise, not information. The cold state is a
 * real `<button>` rather than a clickable `<div>`, so it is reachable and
 * operable from the keyboard, and its `aria-label` is the action rather than the
 * state — the hover swap is visual only and is deliberately not announced.
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
 */
import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  Show,
  type JSX,
} from 'solid-js'
import {
  getPreviewHeaderState,
  igniteVerdaBox,
  type PreviewHeaderState,
} from '~/lib/harness-client/preview-header.server'
import { COLD_START_HEADLINE, coldStartBasisHint } from '~/lib/cold-start-format'
import {
  formatCompactNumber,
  formatCountdown,
  formatLatency,
  formatShare,
  remainingSeconds,
} from '~/lib/preview-header-format'
import { TIER_LABELS } from '~/lib/tier-presentation'

/** How often the strip re-reads the server when the box is SETTLED — warm with
 *  time on the clock, or cold with nothing running. Slower than the countdown
 *  ticks (which are local arithmetic): the numbers behind it move on the scale
 *  of a turn, not a second. */
export const POLL_INTERVAL_MS = 15_000
/**
 * How often it re-reads the server while the box is mid-transition — a turn is
 * on it (`starting`/`running`), or this browser has just asked it to wake.
 *
 * The whole reason the countdown was never seen is downstream of this number
 * (see the module docstring). At one interval for every state, the strip learns
 * the box came up on its next 15-second tick, so the flip a user sends a message
 * to cause lands up to fifteen seconds after the answer they were watching for
 * — which on a route whose first call costs minutes is long after they stopped
 * looking at the header. Three seconds is short enough that the transition
 * reads as caused by the thing that caused it.
 *
 * Cheap enough to do: the payload is two indexed reads and two process-local
 * readings, and this rate applies only while a turn is actually on the box, so
 * it is bounded by the turn rather than left running.
 */
export const ACTIVE_POLL_INTERVAL_MS = 3_000
/** How often the countdown re-renders. */
export const TICK_INTERVAL_MS = 1_000

/** The label the cold indicator swaps to under the pointer, and the accessible
 *  name of the button it becomes. Exported so a test asserts the string a user
 *  reads rather than one it chose itself. */
export const IGNITE_LABEL = 'start RTX PRO 6000'

/** What the strip says when a start this browser asked for did not happen.
 *  Deliberately NOT "stale", which is the word for numbers that are merely old:
 *  a user who pressed {@link IGNITE_LABEL} and waited minutes has to be able to
 *  tell "the figures are a moment behind" from "the box never came up".
 *  Exported for the same reason as {@link IGNITE_LABEL}. */
export const IGNITE_FAILED_LABEL = 'start failed'

/** Warm state → the word and the glyph that carry it. The word is not
 *  decoration: a bare coloured dot fails `color-not-only`, and what the box is
 *  doing is the whole content of the indicator anyway.
 *
 *  The states are the display state machine the server assembly computes
 *  (`HeaderWarmth['state']`): `ready` is completion evidence — a real call the
 *  deployment answered, never a timer; `answering` is its turn-in-flight
 *  flavour; `starting` and `cold` come from the control-plane probe when there
 *  is no completion evidence; and `unknown` is the DEGRADED display, an error
 *  path. Before the control plane existed, `unknown` was what this strip showed
 *  until the first message of a session — a guess that a box another instance
 *  was keeping warm hid behind. That pre-message `unknown` is gone; one here
 *  now means the control plane could not be asked.
 *
 *  The glyph is a THUNK returning literal JSX rather than an icon-name/tone
 *  pair, for the reason spelled out on `Metric` below: a colour applied as
 *  `text={props.tone}` is invisible to UnoCSS's extractor and emits no CSS at
 *  all. Written this way the colour cannot be resolved at runtime, so it cannot
 *  silently fail to exist.
 *
 *  `countdown` says what number this state MEANS to show — and how it behaves.
 *  It lives here rather than as a comparison at the render site because that
 *  comparison is the bug this file shipped with: the render site silently
 *  dropped `answering`'s figure. A flag beside the word cannot go out of step
 *  with the word the way a second literal can.
 *
 *  The values are not renderings of one number. `ready` sends what is LEFT of
 *  the scale-down window, so the client ticks it between polls. `answering`
 *  sends the WHOLE window on every poll — correctly, because the box cannot
 *  scale down while a turn is on it — so ticking that one drew a figure that
 *  fell for a poll interval and then snapped back to the top; it is rendered as
 *  the standing figure it is. `starting`'s figure is not a scale-down at all:
 *  it is the ESTIMATED time to first token still remaining
 *  (`HeaderWarmth.coldStartEstimateMs` — estimate minus what the control plane
 *  has watched the replica spend), and the server re-sends a genuinely smaller
 *  number on every poll, so the client renders it STATICALLY: ticking it
 *  locally would draw a figure that falls for one poll interval and snaps back
 *  to the top, the defect `answering`'s mode exists for. It disappears once the
 *  estimate is spent rather than sitting at 0:00 — running long is expected (a
 *  burst queues on one replica), and the word stays to say so. */
export const WARMTH_PRESENTATION = {
  answering: {
    word: 'answering',
    countdown: 'static',
    glyph: () => (
      <span class="i-material-symbols-bolt" w="3.5" h="3.5" text="cyan-400" aria-hidden="true" />
    ),
    hint:
      'A chat is running on the self-hosted endpoint, which was already up when it started. The ' +
      'figure is how long it then stays up once the turn ends — it does not count down while a ' +
      'turn is on the box, because the box cannot scale down under one.',
  },
  starting: {
    word: 'starting',
    countdown: 'estimate',
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
      'The self-hosted box is engaged but has not answered a call yet — a chat is running on it, ' +
      'or the control plane reports a replica whose model is still loading (a cold start takes ' +
      'minutes). The figure is the estimated time to the first token; it is an estimate, and ' +
      'running long is expected when several chats queue on the one replica.',
  },
  ready: {
    word: 'ready',
    countdown: 'ticking',
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
      'The self-hosted endpoint answered a call within the last few minutes, so it is up. It ' +
      'scales to zero when the countdown reaches nought, and the next message then pays a cold ' +
      'start of minutes.',
  },
  cold: {
    word: 'cold',
    countdown: 'none',
    glyph: () => (
      <span
        class="i-material-symbols-ac-unit"
        w="3.5"
        h="3.5"
        text="ui-text-tertiary"
        aria-hidden="true"
      />
    ),
    hint:
      'The control plane reports no replicas for the self-hosted deployment, so it has scaled to ' +
      'zero. The next message pays a cold start of minutes.',
  },
  unknown: {
    word: 'unknown',
    countdown: 'none',
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
      'The deployment control plane could not be asked (it is unreachable, or its credentials ' +
      'are missing on this server), so the box’s state cannot be read. You can still try to ' +
      'start it.',
  },
} as const

type WarmthKey = keyof typeof WARMTH_PRESENTATION

/** The ignition glyph the cold indicator swaps to under the pointer. A flame
 *  being LIT, deliberately not the flame `warm` already owns — the two states
 *  sit in the same three pixels and a user has to be able to tell "it is up"
 *  from "press to bring it up". Literal JSX for `WARMTH_PRESENTATION`'s reason:
 *  a runtime-resolved colour emits no CSS at all. */
const igniteGlyph = () => (
  <span class="i-material-symbols-mode-heat" w="3.5" h="3.5" text="amber-500" aria-hidden="true" />
)

/** The pending glyph, once the wake is actually out on the wire. Shares the
 *  chat notice's spinner class (`uno.config.ts`), which carries the
 *  reduced-motion branch attributify has nowhere to put — so the glyph stops
 *  rotating for a user who asked for that, and the word beside it still says
 *  what is happening. */
const ignitingGlyph = () => (
  <span
    class="cold-start-spin i-material-symbols-autorenew"
    w="3.5"
    h="3.5"
    text="amber-500"
    aria-hidden="true"
  />
)

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
  /** This browser has a wake request out. Local, not server state: the server's
   *  own answer stays `cold` for the whole ping (nothing has completed yet), so
   *  without this the button would sit reading "cold" for the entire minutes-long
   *  start it had just been asked for. */
  const [igniting, setIgniting] = createSignal(false)
  /** Pointer or keyboard focus is on the cold indicator, so it offers the start
   *  instead of just reporting the state. */
  const [hovering, setHovering] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  /**
   * A start THIS browser asked for and did not get.
   *
   * A separate signal from `error` above, and the separation is the fix rather
   * than tidiness. A failed ignition used to ride the poll's error channel,
   * which gave it that channel's two properties, both wrong for it: it was
   * rendered as the word *stale* — the vocabulary for "these numbers are old",
   * where nothing here is old and the thing a user pressed for simply did not
   * happen — and it was cleared by `load()` on the next successful poll, which
   * at the active rate is three seconds later. A user who pressed
   * {@link IGNITE_LABEL}, was told to expect minutes, and looked away therefore
   * came back to an indicator reading "cold" and no account of the failure at
   * all. This one is cleared by exactly two things: pressing start again, and
   * evidence that the box is now up (`load`).
   */
  const [igniteError, setIgniteError] = createSignal<string | null>(null)

  const load = async () => {
    try {
      const next = await getPreviewHeaderState()
      setState(next)
      setReceivedAt(Date.now())
      setError(null)
      // A failed START is NOT cleared by a poll succeeding — see `igniteError`.
      // It is cleared by the box being UP, whoever brought it up: at that point
      // the report is false rather than merely old, and "the start failed" is
      // the one thing the strip must not keep saying about a running box.
      // `answering` counts because it is `ready` plus a turn (`verdaWarmth`).
      if (next.warmth.state === 'ready' || next.warmth.state === 'answering') setIgniteError(null)
    } catch {
      // A poll that cannot reach the server leaves the last known values on
      // screen rather than blanking the bar — but it must not keep presenting
      // them as live, so the strip dims and says "stale".
      setError('The preview status could not be refreshed.')
    }
  }

  onMount(() => {
    void load()
    const tick = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS)
    onCleanup(() => clearInterval(tick))
  })

  // The poll's RATE is a function of what the last poll said, so the interval
  // is owned by an effect that TRACKS it rather than armed once at mount: a
  // timer armed in `onMount` is armed before the first payload has arrived, so
  // it always gets the settled rate and the strip then waits the full fifteen
  // seconds before noticing the transition it had already been told about.
  // Re-running the effect tears the old interval down (`onCleanup` runs before
  // each re-run as well as on dispose), so exactly one is ever live.
  createEffect(() => {
    const poll = setInterval(() => void load(), pollInterval())
    onCleanup(() => clearInterval(poll))
  })

  /** The server's number, ticked down locally against this browser's receipt
   *  time; `null` when the payload carries none. This is the number for a state
   *  whose window is genuinely running out — see {@link shownSeconds} for which
   *  states those are, and it is also what expires a `ready` window early below. */
  const tickedSeconds = createMemo(() => {
    const s = state()
    if (!s) return null
    return remainingSeconds(s.warmth.secondsUntilScaledown, receivedAt(), now())
  })

  /** The `starting` state's figure: the estimated time to first token still
   *  remaining, as sent by the server (`HeaderWarmth.coldStartEstimateMs`).
   *  Rendered statically — see `shownSeconds` for why it must not be ticked. */
  const estimateSeconds = createMemo(() => {
    const s = state()
    if (!s || s.warmth.coldStartEstimateMs === null) return null
    return Math.round(s.warmth.coldStartEstimateMs / 1000)
  })

  const warmthKey = createMemo<WarmthKey>(() => {
    const s = state()
    if (!s) return 'unknown'
    // The local clock is allowed to EXPIRE the window early; it is never
    // allowed to extend one, which is why only this direction is derived here
    // and the other waits for the server. `ready` is the only state this
    // applies to: expiry makes it `cold` on screen until the next poll either
    // re-proves warmth (a completion) or the control plane re-observes a
    // replica. `starting`'s estimate spends itself into `null` (see
    // `shownSeconds`) but never into a different STATE — running long is the
    // expected case, and no local arithmetic may turn it into anything.
    if (s.warmth.state === 'ready' && tickedSeconds() === 0) return 'cold'
    return s.warmth.state
  })

  /**
   * The seconds the indicator SHOWS, or `null` when this state has no number.
   *
   * Which number — or none — belongs to the state (`WARMTH_PRESENTATION`), and
   * the distinction is not cosmetic. `ready` carries what is LEFT of the
   * window, so ticking it locally between polls is what makes it a countdown at
   * all. `answering` carries the WHOLE window on every poll — the server is
   * right to send it, because a box cannot scale down while a turn is on it —
   * so running the same local clock over it drew a figure that fell for one
   * poll interval and snapped back to the top, twice a minute at the active
   * rate. A number that resets is worse than no number: it reads as a countdown
   * that cannot make up its mind rather than as the standing figure it is.
   * `starting` shows the estimate REMAINING as the server re-sends it — each
   * poll's figure is genuinely smaller than the last — and shows nothing once
   * the estimate is spent: sitting at 0:00 would read as "done" for a box that
   * is merely slow.
   */
  const shownSeconds = createMemo<number | null>(() => {
    const s = state()
    if (!s) return null
    const mode = WARMTH_PRESENTATION[warmthKey()].countdown
    if (mode === 'none') return null
    if (mode === 'static') return s.warmth.secondsUntilScaledown
    if (mode === 'estimate') return estimateSeconds()
    return tickedSeconds()
  })

  /** Is the box mid-transition, so the next poll is worth taking sooner? The
   *  transitional states mean a turn is on the box right now, or this browser
   *  has just asked it to wake. Anything else is settled — a `ready` box ticking
   *  down, or a cold one nobody is starting — and re-reading that three times a
   *  minute is enough. */
  const pollInterval = () =>
    igniting() || warmthKey() === 'starting' || warmthKey() === 'answering'
      ? ACTIVE_POLL_INTERVAL_MS
      : POLL_INTERVAL_MS

  /** The states a click can do something about, and the only ones where the
   *  indicator becomes a button (see `igniteBox`).
   *
   *  `cold` because that is the state the click acts on. `unknown` too, and
   *  that is an owner decision (2026-08-29) that reverses this file's old
   *  policy: before the control plane, `unknown` meant "this process has never
   *  seen a call" and the button was withheld there. Now `unknown` means the
   *  CONTROL PLANE could not be asked — a probe failure, not an unknown box —
   *  and `igniteVerdaBox` is independent of the probe, so withholding the one
   *  control that could fix the situation would punish the user for a status
   *  API's downtime. `starting` and `ready`/`answering` hide it: a replica is
   *  already engaged, and a second wake would only queue behind the first. */
  const canIgnite = () => warmthKey() === 'cold' || warmthKey() === 'unknown'

  /** The starting state's tooltip carries the estimate's basis (`measured` vs
   *  `default`) — a fallback figure must never read as a local measurement,
   *  which is the same rule the chat notice's tooltip follows. */
  const indicatorHint = () => {
    const key = warmthKey()
    if (key !== 'starting') return WARMTH_PRESENTATION[key].hint
    const w = state()?.warmth
    if (!w || w.coldStartBasis === null || w.coldStartSamples === null) {
      return WARMTH_PRESENTATION.starting.hint
    }
    return `${WARMTH_PRESENTATION.starting.hint} ${coldStartBasisHint(w.coldStartBasis, w.coldStartSamples)}`
  }

  /** The word in the indicator: what the box is doing, unless this browser is
   *  mid-wake or offering to start one. */
  const ignitionWord = () =>
    igniting()
      ? COLD_START_HEADLINE
      : canIgnite() && hovering()
        ? IGNITE_LABEL
        : WARMTH_PRESENTATION[warmthKey()].word

  /**
   * Ask the server to wake the box, then settle on what it says.
   *
   * Deliberately thin: everything that makes this safe — one shared ping per
   * idle period, a click on an already-warm box costing nothing, a failure
   * naming the box rather than the click — belongs to `ensureVerdaAwake` and is
   * enforced there for every caller, not re-implemented per button. What is
   * this component's own is the pending state, because the wake can legitimately
   * take minutes and a control that looks idle for two minutes reads as broken.
   */
  const igniteBox = async () => {
    if (igniting()) return
    setIgniting(true)
    setError(null)
    setIgniteError(null)
    try {
      setState(await igniteVerdaBox())
      setReceivedAt(Date.now())
    } catch (err) {
      // Surfaced, never swallowed, and on its OWN channel: a wake that failed is
      // the difference between "the next message is slow" and "the next message
      // will not work at all", and it has to outlive the poll that follows it.
      setIgniteError(
        err instanceof Error ? err.message : 'The self-hosted endpoint could not be started.',
      )
    } finally {
      setIgniting(false)
    }
  }

  /** The indicator's contents, shared by the button a cold box renders and the
   *  plain div every other state does — written once so the two branches can
   *  differ in what they ARE without differing in what they say. */
  const indicatorBody = () => (
    <>
      <Show when={!igniting()} fallback={ignitingGlyph()}>
        <Show when={canIgnite() && hovering()} fallback={WARMTH_PRESENTATION[warmthKey()].glyph()}>
          {igniteGlyph()}
        </Show>
      </Show>
      {/* The WORD is themed text, not the glyph's hue: `amber-500` on the light
          ground is around 2:1, and the state has to be readable in both. The hue
          rides the glyph beside it, which carries no information of its own
          (`color-not-only`). */}
      <span text="xs ui-text-primary" aria-hidden="true">
        {ignitionWord()}
      </span>
      {/* Whether a state gets a number — and whether that number moves — is the
          state's own property, not a comparison written here (see
          `WARMTH_PRESENTATION` and `shownSeconds`). This line read
          `warmthKey() === 'warm'`, and that is the whole countdown bug:
          `running` carries one and never rendered it. */}
      <Show when={shownSeconds() !== null}>
        <span text="xs ui-text-tertiary right" font="mono" min-w="9" aria-hidden="true">
          {formatCountdown(shownSeconds() ?? 0)}
        </span>
      </Show>
      {/* The only announced part: the state word, which changes rarely. The
          countdown above is aria-hidden on purpose, and so is the hover swap —
          the button already has its accessible name from `aria-label`, and a
          live region that re-read it on every pointer crossing would be noise. */}
      <span sr-only aria-live="polite">
        Self-hosted endpoint {WARMTH_PRESENTATION[warmthKey()].word}
      </span>
    </>
  )

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
            {/* ---- Warm state -------------------------------------------- */}
            <Show when={s().verdaAvailable}>
              {/* Two elements, one `data-testid` and one body. A cold box is the
                  one state a click can act on, so THERE it is a real `<button>`
                  — not a `<div onClick>` — which is what buys the role, the
                  keyboard and the focus ring for free. In every other state
                  there is nothing to press, and a permanently-disabled button
                  would advertise an affordance that never applies.

                  Written as two branches with their utilities spelled out,
                  rather than one element carrying `p={cold ? 'x-1.5' : …}`:
                  UnoCSS extracts attributify from LITERAL `attr="value"` text,
                  so a utility that only ever exists inside a ternary can emit no
                  CSS at all and fail silently — an element that simply renders
                  unstyled. That is the same trap the `Metric` glyphs below
                  document, and it had already cost this file one missing colour. */}
              <Show
                when={canIgnite()}
                fallback={
                  <div
                    flex="~"
                    items="center"
                    gap="1"
                    transition="all"
                    title={indicatorHint()}
                    data-testid="verda-warmth"
                    onMouseEnter={() => setHovering(true)}
                    onMouseLeave={() => setHovering(false)}
                  >
                    {indicatorBody()}
                  </div>
                }
              >
                <button
                  type="button"
                  onClick={() => void igniteBox()}
                  onMouseEnter={() => setHovering(true)}
                  onMouseLeave={() => setHovering(false)}
                  onFocus={() => setHovering(true)}
                  onBlur={() => setHovering(false)}
                  disabled={igniting()}
                  aria-label={IGNITE_LABEL}
                  flex="~"
                  items="center"
                  gap="1"
                  p="x-1.5 y-0.5"
                  m="x--1.5"
                  rounded="md"
                  cursor="pointer"
                  bg="transparent hover:ui-bg-hover"
                  ring="2 transparent focus-visible:ui-accent/40"
                  transition="all"
                  title={
                    igniting()
                      ? 'Starting the self-hosted endpoint. The first call after it has scaled to zero takes minutes.'
                      : 'Start the self-hosted endpoint now, so your next message does not pay the cold start.'
                  }
                  data-testid="verda-warmth"
                >
                  {indicatorBody()}
                </button>
              </Show>
            </Show>

            {/* ---- Metrics ----------------------------------------------- */}
            {/* `data-testid` so the browser suite's screenshot comparison can
                REMOVE this block before the shot: every figure in it (active
                people, today's tokens and turns, the rolling p50) is a live
                counter, so leaving it in would diff the header against its own
                baseline on every run. Removed rather than masked — Playwright's
                `mask` paints over an element and leaves it in the flow, so a
                block whose width varies keeps moving what sits beside it (the
                measured cost was a 1152-pixel diff in a run where nothing had
                changed). Removed rather than stubbed, too: a stub would make the
                visual test assert a layout the app never renders. */}
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
                    : `Median duration of the last ${s().latency.samples} model call(s) on ${TIER_LABELS[s().tier]} — the tier a NEW chat starts on. Each conversation now picks its own next to the agent selector, so an open thread may be on the other one. Counting only the calls the switch actually moves, so the two positions are comparable — which is now every model call a turn makes, with no exception. A mix of long and short calls, so this is well under what a reply takes: one model call, not one reply — a turn makes several. Counted by this server only, so another instance may show a different figure, and a restart clears it. A cold start is included, because it is time someone waited.`
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

            {/* A start that failed, in its own words and on its own channel.
                `role="alert"` rather than the `status` beside it: this is the
                outcome of something the user pressed and then stopped watching,
                so it is worth interrupting for, where a stale poll is not. The
                sentence the box actually gave is in the `title` — it names the
                attempts and the elapsed time and does not fit a top bar — but
                the visible words are the ones that matter: the start failed, and
                it says so until it is retried or the box comes up. */}
            <Show when={igniteError()}>
              <span
                role="alert"
                text="xs ui-danger"
                title={igniteError() ?? undefined}
                data-testid="verda-ignite-failed"
              >
                {IGNITE_FAILED_LABEL}
              </span>
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}
