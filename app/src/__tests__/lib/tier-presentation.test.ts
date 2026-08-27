/**
 * How a tier is presented — and, mostly, that its glyphs EXIST.
 *
 * The interesting failure here is silent. UnoCSS extracts utilities from
 * `[jt]sx` by default and rejects a plain `.ts` file unless it carries a
 * literal `@unocss-include` marker, so an icon class named from a `.ts` module
 * can emit no CSS at all: no error, no warning, an empty 14px span on every
 * sidebar row and both halves of the switch. That is exactly the shape of the
 * `i-mdi-*` bug the icon migration left behind, which is why the marker is not
 * trusted and the CSS is generated instead.
 *
 * The labels are pinned for a duller reason: the browser suite locates the
 * switch by the words a user reads, and three surfaces have to agree on them.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createGenerator } from 'unocss'
import config from '../../../uno.config'
import { TIER_ICONS, TIER_LABELS, TIER_HINTS, tierRowLabel } from '../../lib/tier-presentation'

const generator = await createGenerator(config as never)
const cssFor = async (input: string) => (await generator.generate(input, {})).css

// The icon collection is a multi-megabyte lazy JSON load; paying it here keeps
// it out of an assertion's own budget (see `uno-theme.test.ts` for the flake
// that taught this).
beforeAll(async () => {
  await cssFor('i-material-symbols-home')
}, 30_000)

describe('tier glyphs', () => {
  it('are declared in a file UnoCSS will actually scan', async () => {
    // The other half of the failure, and the half a generated-CSS assertion
    // cannot see: `@unocss/vite`'s pipeline filter drops a `.ts` file unless it
    // carries this literal marker, so the classes below would be perfectly
    // generatable and still never generated. `uno.config.ts` spells out the
    // mechanism on its `content.filesystem` entry.
    const source = await readFile(resolve(process.cwd(), 'src/lib/tier-presentation.ts'), 'utf8')
    expect(source, 'tier-presentation.ts lost its @unocss-include marker').toContain(
      '@unocss-include',
    )
  })

  it('emit real CSS, rather than reading like icons and rendering nothing', async () => {
    for (const [tier, icon] of Object.entries(TIER_ICONS)) {
      const css = await cssFor(icon)
      expect(css, `${tier}'s glyph (${icon}) emitted no CSS`).toContain(icon)
      // An icon rule carries the glyph itself; a rule with no mask/background
      // is a class that exists and draws nothing.
      expect(css, `${tier}'s glyph (${icon}) emitted a rule with no image`).toMatch(
        /mask|background-image/,
      )
    }
  })

  it('names a DIFFERENT glyph per tier', () => {
    // Two rows showing the same icon would read as one setting rather than a
    // distinction, which is the whole content of the sidebar affordance.
    expect(TIER_ICONS.verda).not.toBe(TIER_ICONS.anthropic)
  })

  it('carries no colour of its own', () => {
    // Colour is the surface's to choose (`ui-*` tokens): a glyph whose meaning
    // rode in its hue would fail `color-not-only`, and a fixed hex here could
    // not clear contrast on both grounds.
    for (const icon of Object.values(TIER_ICONS)) {
      expect(icon).toMatch(/^i-material-symbols-/)
    }
  })
})

describe('tier words', () => {
  it('names both positions in words a preview user can act on', () => {
    // The switch has to be self-explanatory without documentation, which means
    // the label leads with the property, not the vendor.
    expect(TIER_LABELS.verda).toBe('Private (Verda)')
    expect(TIER_LABELS.anthropic).toBe('Anthropic')
  })

  it('reads as a sentence on a sidebar row, where there is no surrounding label', () => {
    expect(tierRowLabel('verda')).toBe('Runs on Private (Verda)')
    expect(tierRowLabel('anthropic')).toBe('Runs on Anthropic')
  })

  it('explains each position in terms of where the prompts go', () => {
    expect(TIER_HINTS.verda).toMatch(/infrastructure we control/)
    expect(TIER_HINTS.anthropic).toMatch(/Anthropic/)
  })
})
