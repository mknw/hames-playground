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
import { describe, it, expect } from 'vitest'
import { createGenerator } from 'unocss'
import config from '../../../uno.config'

const generator = await createGenerator(config as never)

/** All CSS the config emits for `input`, preflights included. */
const cssFor = async (input: string) => (await generator.generate(input, {})).css

/** The `--ui-*` declarations inside the `:root` / `:root.light` blocks. */
async function palette(selector: ':root' | ':root.light'): Promise<Record<string, string>> {
  const css = await cssFor('')
  // The preflight is emitted verbatim, so match its block and read the pairs.
  const block = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)
  expect(block, `no ${selector} block in the generated CSS`).not.toBeNull()
  return Object.fromEntries(
    [...block![1].matchAll(/(--ui-[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  )
}

// The roles that existed as fixed hexes before the theme, and the value each
// one had. `uno.config.ts` still declares them under `theme.colors.dark`.
const INHERITED_DARK_VALUES: Record<string, string> = {
  '--ui-bg-primary': '#0a0a0f',
  '--ui-bg-secondary': '#12121a',
  '--ui-bg-tertiary': '#1a1a24',
  '--ui-bg-hover': '#22222f',
  '--ui-border-primary': '#2a2a3a',
  '--ui-border-secondary': '#3a3a4a',
  '--ui-border-accent': '#4a4a5a',
  '--ui-text-primary': '#e4e4e7',
  '--ui-text-secondary': '#a1a1aa',
  '--ui-text-tertiary': '#71717a',
  // The brand accent, previously written as `neon-cyan`.
  '--ui-accent': '#00ffff',
}

describe('ui-* token palette', () => {
  it('keeps the dark palette byte-identical to the hexes it replaced', async () => {
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
    ['bg-ui-danger/10', '--ui-danger'],
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
