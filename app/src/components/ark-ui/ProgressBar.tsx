/**
 * ProgressBar — the app's one linear progress bar.
 *
 * WHY THIS FILE EXISTS. There were three copies of this geometry before #295:
 * `LiveProgressBar`'s Ark `Progress` (the in-chat chain bar), `ChatSidebar`'s
 * `RowProgress` (hand-rolled `<div>`s, plus its own copy of the gradient
 * literal under a comment claiming it was "shared with the in-chat
 * LiveProgressBar" — it was not, it was duplicated), and the boot splash was
 * about to be a fourth. They agreed on every value that matters — 3px track,
 * this gradient, this glow, this 420 ms ease — which is exactly the state in
 * which the next edit makes two of them disagree.
 *
 * So this owns the BAR and nothing else. What varies between consumers is the
 * label above it (a crossfading status line in chat, a truncated one in a
 * sidebar row, a rotating quip on the splash), and that stays with each
 * consumer as `children`, rendered inside `Progress.Root` so Ark's
 * `Progress.Label` still wires up to the root that labels it.
 *
 * ## Determinate and indeterminate are one prop
 *
 * `percent: null` is indeterminate, and it is expressed through the PRIMITIVE
 * rather than around it: zag computes `isIndeterminate` as `value === null` and
 * stamps `data-state` and the accessible name from it, so the semantics reach
 * assistive technology without this file asserting them. It takes BOTH `value`
 * and `defaultValue` to get there — see the comment on the root, and note that
 * the sidebar's hand-rolled strip had no `role="progressbar"` at all, so this is
 * the first version of that bar an assistive technology can read. The 40 %-wide
 * sweeping segment is the visual it already used.
 *
 * The glow is NOT a prop. It belongs to the determinate mode — a moving segment
 * with a glow smears — which is the rule both original copies had already
 * arrived at independently.
 */
import { Show, type JSX } from 'solid-js'
import { Progress } from '@ark-ui/solid/progress'

/**
 * The fill. Fixed hexes rather than tokens, and legitimately so: `--ui-accent`
 * flips to a dark teal in light mode, and this is a two-stop gradient whose
 * second stop (`neon-magenta`) has no `ui-*` role at all. Per the styleguide's
 * §4 this is the "value the build cannot see" case — a gradient is not a
 * utility — and it is data-coloured chrome that reads on both grounds.
 */
export const PROGRESS_GRADIENT =
  'linear-gradient(90deg, rgba(0,255,255,0.85), rgba(157,0,255,0.85))'

/** The glow under a determinate fill. */
const PROGRESS_GLOW = '0 0 8px rgba(0,255,255,0.45)'

/** Track height. 3px in all three original copies. */
const TRACK_HEIGHT = '3px'

/** How long the fill takes to travel to a new value. */
const FILL_TRANSITION_MS = 420

export interface ProgressBarProps {
  /**
   * Fill percentage, 0–100 — or `null` for indeterminate, when the consumer
   * cannot know how much is left.
   */
  percent: number | null
  /**
   * Label row, rendered above the track and INSIDE `Progress.Root`, so
   * `Progress.Label` resolves its root from context.
   */
  children?: JSX.Element
  /** Forwarded to the track, for tests that want to find one bar of several. */
  trackTestId?: string
}

export const ProgressBar = (props: ProgressBarProps) => {
  const determinate = () => props.percent !== null

  return (
    <Progress.Root
      value={props.percent}
      // BOTH, and the second one is not redundant. zag's `bindable` reads a
      // `null` controlled `value` as "uncontrolled" and falls back to
      // `defaultValue`, which it defaults to the MIDPOINT — so `value={null}`
      // alone rendered `aria-valuenow="50"` and `data-state="loading"`, i.e. an
      // indeterminate bar telling assistive technology it was half done. With
      // `defaultValue` also null the fallback is null too, `isIndeterminate`
      // (`value === null`) holds, and the announced name becomes zag's
      // "loading...". Pinned by ProgressBar.test.tsx.
      defaultValue={null}
      min={0}
      max={100}
      flex="~ col gap-1.5"
      w="full"
      style={{ 'min-width': 0 }}
    >
      {props.children}
      <Progress.Track
        data-testid={props.trackTestId}
        style={{
          height: TRACK_HEIGHT,
          // Byte-identical to the `rgb(58, 58, 74)` all three copies hardcoded
          // — that IS this token's dark value (`uno-theme.test.ts` pins it) —
          // so dark mode is unchanged and light mode stops drawing a near-black
          // trough on a white ground.
          'background-color': 'var(--ui-border-secondary)',
          'border-radius': '9999px',
          overflow: 'hidden',
        }}
      >
        <Show
          when={determinate()}
          fallback={
            // Indeterminate: a segment sweeps the track. Width is inline
            // because the reduced-motion branch in the preflight has to be
            // able to override it with `!important`.
            <Progress.Range
              class="progress-indeterminate"
              style={{
                height: '100%',
                width: '40%',
                'border-radius': '9999px',
                'background-image': PROGRESS_GRADIENT,
              }}
            />
          }
        >
          <Progress.Range
            style={{
              height: '100%',
              width: `${props.percent}%`,
              'background-image': PROGRESS_GRADIENT,
              'box-shadow': PROGRESS_GLOW,
              transition: `width ${FILL_TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
            }}
          />
        </Show>
      </Progress.Track>
    </Progress.Root>
  )
}
