/**
 * The theming mechanism at the config level (#226 B8).
 *
 * `uno.config.ts` is the whole light/dark mechanism: `ui-*` utilities resolve
 * to `var(--ui-*)`, and the palette flips because `:root.light` redefines
 * those variables. None of that is type-checked, and a component using a
 * themed token cannot tell a working variable from a missing one — it just
 * renders transparent. So the config is generated here and asserted against.
 *
 * The load-bearing claim is the first one: **the dark palette is byte-
 * identical to the fixed `dark-*` hexes it replaced.** That is what makes
 * "unchanged by default" a fact rather than a hope, and what makes migrating a
 * component a rename.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createGenerator } from 'unocss'
import config from '../../../uno.config'

const generator = await createGenerator(config as never)

/** All CSS the config emits for `input`, preflights included. */
const cssFor = async (input: string) => (await generator.generate(input, {})).css

/**
 * Load the icon collections BEFORE any test measures anything (#280).
 *
 * `presetIcons` loads `@iconify-json/material-symbols` — a multi-megabyte JSON —
 * lazily, on the first `i-material-symbols-*` utility it is asked to generate. So
 * whichever icon case ran first paid that load inside its own 5s test budget, and
 * on a loaded machine it lost: `emits CSS for i-material-symbols-light-mode`
 * failed at 5004ms in a full-suite run while passing in isolation, which is the
 * signature of a one-time cost billed to an assertion rather than a defect.
 *
 * Widening the test timeout would have hidden it and left the next case that got
 * slow indistinguishable from a regression. Paying the load here, once, against a
 * hook timeout that says what it is for, leaves each test's own budget measuring
 * the generation it is actually about.
 */
beforeAll(async () => {
  await cssFor('i-material-symbols-home i-material-symbols-light-home')
}, 60_000)

/** The `--ui-*` declarations inside the `:root` / `:root.light` blocks. */
async function palette(selector: ':root' | ':root.light'): Promise<Record<string, string>> {
  const css = await cssFor('')
  // The preflight is emitted verbatim, so match its block and read the pairs.
  const block = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)
  expect(block, `no ${selector} block in the generated CSS`).not.toBeNull()
  // Comments first: a prose mention of `--ui-something:` reads as a
  // declaration whose value runs to the next `;`, which swallows the real
  // declaration after it. That failure is silent — the token just goes
  // missing from one palette — so it is stripped rather than tolerated.
  const declarations = block![1].replace(/\/\*[\s\S]*?\*\//g, '')
  return Object.fromEntries(
    [...declarations.matchAll(/(--ui-[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  )
}

// The dark palette, pinned value by value. Originally the hexes the `ui-*`
// rename inherited unchanged (#226 B8); #1008 re-pinned the whole record when
// the sober dark palette replaced the neon accent and the violet-cast
// neutrals — the point of the pin is unchanged: a one-line edit to the
// preflight cannot move the dark palette without going through this list.
const INHERITED_DARK_VALUES: Record<string, string> = {
  '--ui-bg-primary': '#0f1115',
  '--ui-bg-secondary': '#16191e',
  '--ui-bg-tertiary': '#1d2127',
  '--ui-bg-hover': '#262b33',
  '--ui-border-primary': '#2b3038',
  '--ui-border-secondary': '#3a4048',
  '--ui-border-accent': '#4b525c',
  '--ui-text-primary': '#e2e4e8',
  '--ui-text-secondary': '#9aa1ab',
  '--ui-text-tertiary': '#848b93',
  // The brand accent and the success tone, previously `neon-cyan` /
  // `neon-green`, sobered by #1008.
  '--ui-accent': '#45b0b8',
  '--ui-success': '#3fb950',
  // Literals lifted out of `.prose-chat`, `.think-*`, `.agent-glyph` and
  // `.graph-entity`, which are CSS rather than utilities and so could not
  // carry a token at all before.
  '--ui-accent-soft': 'rgba(69, 176, 184, 0.1)',
  '--ui-accent-glow': 'rgba(69, 176, 184, 0.15)',
  '--ui-accent-strong': 'rgba(69, 176, 184, 0.2)',
  '--ui-accent-line': 'rgba(69, 176, 184, 0.4)',
  '--ui-overlay-wash': 'rgba(255, 255, 255, 0.03)',
  '--ui-overlay-raise': 'rgba(255, 255, 255, 0.06)',
  '--ui-overlay-line': 'rgba(255, 255, 255, 0.06)',
  '--ui-overlay-hairline': 'rgba(255, 255, 255, 0.05)',
  '--ui-overlay-sunken': 'rgba(0, 0, 0, 0.15)',
  '--ui-code-bg': '#0c0e11',
  // #1008 round 2: the accent as a button ground, and its text.
  '--ui-on-accent': '#0f1115',
  '--ui-accent-deep': '#2f9aa4',
  // …and as text on a tint of itself.
  '--ui-accent-text': '#45b0b8',
}

describe('ui-* token palette', () => {
  it('keeps the fixed dark.* hexes equal to the dark --ui-* values they mirror', async () => {
    // uno.config.ts promises this equality in prose; until #1008's review this
    // test did not exist, and `dark.text.tertiary` had drifted to #7b828c.
    const dark = await palette(':root')
    const fixed = (
      config as { theme: { colors: { dark: Record<string, Record<string, string>> } } }
    ).theme.colors.dark
    let compared = 0
    for (const [group, entries] of Object.entries(fixed)) {
      for (const [key, hex] of Object.entries(entries)) {
        expect(hex, `dark.${group}.${key} vs --ui-${group}-${key}`).toBe(
          dark[`--ui-${group}-${key}`],
        )
        compared++
      }
    }
    expect(compared).toBeGreaterThanOrEqual(10)
  })

  it('keeps the dark palette byte-identical to its pinned values (#1008)', async () => {
    const dark = await palette(':root')
    for (const [variable, hex] of Object.entries(INHERITED_DARK_VALUES)) {
      expect(dark[variable], variable).toBe(hex)
    }
  })

  it('overrides every dark variable in the light palette', async () => {
    const dark = await palette(':root')
    const light = await palette(':root.light')

    // A token defined only in dark is the failure mode this catches: the
    // utility keeps working, and light mode silently keeps the dark value.
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort())
    for (const key of Object.keys(dark)) {
      expect(light[key], `${key} is the same in both themes`).not.toBe(dark[key])
    }
  })

  it('declares a colour-scheme for light so native controls follow', async () => {
    const css = await cssFor('')
    expect(/:root\.light\s*\{[^}]*color-scheme:\s*light/.test(css)).toBe(true)
  })
})

describe('ui-* utilities', () => {
  // One per family, plus the two flat tokens and an opacity modifier — the
  // shapes the auth pages actually use.
  const cases = [
    ['bg-ui-bg-primary', '--ui-bg-primary'],
    ['bg-ui-bg-secondary', '--ui-bg-secondary'],
    ['bg-ui-bg-tertiary', '--ui-bg-tertiary'],
    ['bg-ui-bg-hover', '--ui-bg-hover'],
    ['border-ui-border-primary', '--ui-border-primary'],
    ['border-ui-border-secondary', '--ui-border-secondary'],
    ['border-ui-border-accent', '--ui-border-accent'],
    ['text-ui-text-primary', '--ui-text-primary'],
    ['text-ui-text-secondary', '--ui-text-secondary'],
    ['text-ui-text-tertiary', '--ui-text-tertiary'],
    ['text-ui-accent', '--ui-accent'],
    ['text-ui-danger', '--ui-danger'],
    ['text-ui-success', '--ui-success'],
    ['bg-ui-success', '--ui-success'],
    ['bg-ui-danger/10', '--ui-danger'],
    // The primary button's pair (#1008 round 2): `cyber-button` and + New
    // Chat use these, and an unregistered key emits nothing at all.
    ['text-ui-on-accent', '--ui-on-accent'],
    ['hover:bg-ui-accent-deep', '--ui-accent-deep'],
    ['text-ui-accent-text', '--ui-accent-text'],
  ] as const

  it.each(cases)('%s resolves through %s', async (utility, variable) => {
    const css = await cssFor(utility)
    expect(css).toContain(`var(${variable})`)
  })
})

describe('the icon collections', () => {
  // Both are registered, and `material-symbols-light` shares a prefix with
  // `material-symbols` — an ambiguity that would resolve to an empty span
  // rather than an error, so it is asserted rather than assumed.
  it.each([
    'i-material-symbols-light-mode',
    'i-material-symbols-dark-mode',
    'i-material-symbols-light-home',
    'i-material-symbols-hub-outline',
  ])('emits CSS for %s', async (icon) => {
    expect(await cssFor(icon)).toContain(`.${icon}{`)
  })

  it('emits nothing for a collection that is not registered', async () => {
    // #226 B6 removed mdi. An `i-mdi-*` is a live bug, not precedent.
    expect(await cssFor('i-mdi-home')).not.toContain('i-mdi-home{')
  })
})

describe('the Sandbox tab blink (#415)', () => {
  /** The balanced `{ … }` body starting at the first `{` after `from`. */
  const blockAfter = (css: string, from: number): string => {
    const open = css.indexOf('{', from)
    let depth = 0
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
    }
    throw new Error('unbalanced CSS')
  }

  // The class is applied from TS for SANDBOX_BLINK_MS; the keyframes run in
  // CSS. Two numbers in two files, so one pins the other: a longer animation
  // would be cut off mid-pulse, a shorter one would leave the class on idle.
  it('runs ONE pass of two pulses, as long as SupportPanel keeps the class on', async () => {
    const { SANDBOX_BLINK_MS } = await import('../../lib/sandbox-blink')
    const css = await cssFor('')
    const rule =
      /\.sandbox-tab-blink\s*\{\s*animation:\s*sandbox-tab-blink\s+([\d.]+)s\s+[\w-]+\s+1;/.exec(
        css,
      )
    expect(rule, 'no .sandbox-tab-blink animation rule').not.toBeNull()
    expect(Number(rule![1]) * 1000).toBe(SANDBOX_BLINK_MS)
    const frames = blockAfter(css, css.indexOf('@keyframes sandbox-tab-blink'))
    // Two lit frames (25%, 75%) between dark ones: a blink, twice.
    expect(frames).toMatch(/0%,\s*50%,\s*100%\s*\{\s*background-color:\s*transparent/)
    expect(frames).toMatch(/25%,\s*75%\s*\{/)
  })

  it('drops the motion under prefers-reduced-motion and keeps a steady signal', async () => {
    const css = await cssFor('')
    const blocks: string[] = []
    for (let at = css.indexOf('@media (prefers-reduced-motion: reduce)'); at !== -1;) {
      blocks.push(blockAfter(css, at))
      at = css.indexOf('@media (prefers-reduced-motion: reduce)', at + 1)
    }
    const reduced = blocks.find((b) => b.includes('.sandbox-tab-blink'))
    expect(reduced, 'no reduced-motion rule for .sandbox-tab-blink').toBeDefined()
    expect(reduced).toMatch(/\.sandbox-tab-blink\s*\{[^}]*animation:\s*none/)
    expect(reduced).toMatch(/\.sandbox-tab-blink\s*\{[^}]*box-shadow:\s*inset/)
  })
})

describe('fontSize theme', () => {
  it('emits a real font-size rule for text-2xs — the caption size is not a silent no-op', async () => {
    // presetWind4 ships `xs`…`9xl` and nothing below, so before the #937 fix
    // `text="2xs"` generated no CSS at all and every caption site rendered
    // at the ambient 16px. This is the no-op's tripwire: remove the
    // `theme.fontSize['2xs']` entry in uno.config.ts and this goes red.
    // In wind4 the utility resolves through custom properties, so BOTH halves
    // have to exist: the `.text-2xs` rule referencing them, and the theme
    // layer declaring them. Removing the entry kills both.
    const css = await cssFor('text-2xs')
    expect(css).toMatch(/\.text-2xs\s*\{[^}]*font-size:\s*var\(--text-2xs-fontSize\)/)
    expect(css).toMatch(/--text-2xs-fontSize:\s*0\.6875rem/)
    expect(css).toMatch(/--text-2xs-lineHeight:\s*0\.875rem/)
  })
})
