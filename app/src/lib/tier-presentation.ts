/**
 * How an inference tier is PRESENTED — the label, the glyph and the sentence
 * that explains it. Client-safe, and the single home for all three.
 *
 * Three surfaces render a tier and they must agree: the switch beside the agent
 * selector, the always-visible glyph on every sidebar row, and the preview
 * header's latency tooltip. Two of them showing different icons for the same
 * tier would read as two different things rather than one setting seen twice.
 *
 * `@unocss-include` above the icon map is load-bearing and not decoration.
 * UnoCSS extracts utilities from `[jt]sx` by default and REJECTS a plain `.ts`
 * file unless that literal marker appears in it (`uno.config.ts` spells out the
 * mechanism on its `content.filesystem` entry). Without it these two `i-*`
 * classes emit no CSS at all and both surfaces render an empty span — a silent
 * failure with no error anywhere, which is why `tier-presentation.test.ts`
 * generates the CSS and asserts the rules exist rather than trusting the
 * marker.
 *
 * @unocss-include
 */
import type { InferenceTier } from './harness-patterns/clients.server'

/** Tier labels, in the words a preview user can act on. "Private" is the
 *  property they care about; the deployment name is the parenthetical. */
export const TIER_LABELS: Record<InferenceTier, string> = {
  verda: 'Private (Verda)',
  anthropic: 'Anthropic',
}

/**
 * The glyph per tier, as a `material-symbols` class.
 *
 * A shield-lock for the private tier and a cloud for Anthropic — the shape
 * carries "stays on our infrastructure" vs "goes to a hosted provider", which
 * is the whole distinction. Both are outline weights so they read at 14px on
 * either ground, and neither carries a hue: colour is the surface's to choose
 * (`ui-*` tokens), and a glyph that meant something only by its colour would
 * fail `color-not-only`.
 */
export const TIER_ICONS: Record<InferenceTier, string> = {
  verda: 'i-material-symbols-shield-lock-outline',
  anthropic: 'i-material-symbols-cloud-outline',
}

/** What each position means, for a `title` tooltip on the switch. */
export const TIER_HINTS: Record<InferenceTier, string> = {
  verda:
    'Run this conversation on the company-hosted deployment — prompts stay on infrastructure ' +
    'we control.',
  anthropic: "Run this conversation on Anthropic's hosted models.",
}

/** Shown in place of {@link TIER_HINTS}.verda when the deployment has no
 *  self-hosted endpoint configured, which is when that position is disabled. */
export const TIER_UNAVAILABLE_HINT =
  'The self-hosted endpoint is not configured on this deployment.'

/** The accessible name for a row's tier glyph — a sentence rather than a label,
 *  because it is read out of context in a list of conversations. */
export function tierRowLabel(tier: InferenceTier): string {
  return `Runs on ${TIER_LABELS[tier]}`
}
