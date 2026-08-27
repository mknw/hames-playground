/**
 * The five webfont families are SELF-HOSTED, and stay that way (#285).
 *
 * Until this test, all three layers `docs/testing/pyramid.md` calls hermetic
 * depended on `fonts.googleapis.com` being up. `uno.config.ts` declared the
 * families through `presetWebFonts`'s **google** provider, which fetches the
 * `css2` stylesheet while UnoCSS builds its preflights and inlines the answer —
 * once per `vinxi dev` boot for layers 2 and 3, and once inside layer 1 as well,
 * because `uno-theme.test.ts` generates preflights.
 *
 * WHAT MAKES IT WORTH A TEST rather than a comment is the shape of the failure.
 * The preset picks between two of them on `process.env.CI`: unset, the fetch
 * failure is SWALLOWED and the app renders in the fallback stack — every glyph
 * shifts, the six committed screenshot baselines go red with a font-metrics diff
 * that looks exactly like a visual regression, and nothing anywhere says
 * "network". Set, it throws and the dev server exits 1 before serving. Neither
 * failure names its cause, and BOTH are one word in this config away.
 *
 * So this pins both halves, because either alone is passable while the app is
 * broken:
 *
 *  1. **No remote font is requested.** The generated CSS names neither fonts
 *     host, and neither does the CSS the packages ship.
 *  2. **A local face is actually declared for every family the theme names**, at
 *     the weight the old Google request asked for. Half 1 alone would be green
 *     for an app with no `@font-face` at all, which is precisely the swallowed
 *     failure above — hermetic and wrong.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createGenerator } from 'unocss'
import config from '../../../uno.config'

const generator = await createGenerator(config as never)

const REMOTE_FONT_HOST = /fonts\.(googleapis|gstatic)\.com/

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8')

/**
 * One row per family in `uno.config.ts`'s `presetWebFonts` block.
 *
 * `weight` is what the google provider's URL asked for, and therefore what the
 * browser used to download: a bare `family=Inter` in a `css2` URL resolves to the
 * 400 instance, and the two Lexends carried an explicit `:200`. Keeping the same
 * weights is what makes the committed screenshot baselines a fair comparison —
 * self-hosting a family at 300 or as a variable face would re-render every glyph
 * and read as a regression in scenario 7.
 */
const FAMILIES = [
  { token: 'sans', family: 'Inter', weight: 400, pkg: '@fontsource/inter' },
  { token: 'serif', family: 'Roboto Slab', weight: 400, pkg: '@fontsource/roboto-slab' },
  { token: 'mono', family: 'Fira Code', weight: 400, pkg: '@fontsource/fira-code' },
  { token: 'lexend', family: 'Lexend Zetta', weight: 200, pkg: '@fontsource/lexend-zetta' },
  { token: 'lexend_exa', family: 'Lexend Exa', weight: 200, pkg: '@fontsource/lexend-exa' },
] as const

describe('webfonts are self-hosted', () => {
  it('generates no request to a third-party font host', async () => {
    // Preflights included — that is where the google provider inlined its
    // `@import` / `@font-face`, so a config that went back to it would show here.
    const { css } = await generator.generate(FAMILIES.map((f) => `font-${f.token}`).join(' '), {})
    expect(css).not.toMatch(REMOTE_FONT_HOST)
  })

  it('still resolves every family the theme names', async () => {
    const { css } = await generator.generate(FAMILIES.map((f) => `font-${f.token}`).join(' '), {})
    // A dropped `presetWebFonts` would leave `font-sans` resolving to the
    // framework default and pass the no-remote-host test above with nothing
    // named at all.
    for (const { token, family } of FAMILIES) {
      expect(css, `--font-${token} no longer names ${family}`).toContain(family)
    }
  })

  it('imports a local face for every family, at the weight Google served', () => {
    const entry = read('../../app.tsx')
    for (const { pkg, weight } of FAMILIES) {
      expect(entry, `${pkg} is declared in uno.config.ts but never imported`).toContain(
        `${pkg}/${weight}.css`,
      )
    }
  })

  it('serves those faces from disk rather than from a CDN', async () => {
    // The packages could in principle ship CSS that points back at gstatic; then
    // the generated CSS would be clean and the browser would still leave the
    // machine. Read what is actually imported.
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    for (const { pkg, weight, family } of FAMILIES) {
      const css = readFileSync(require.resolve(`${pkg}/${weight}.css`), 'utf-8')
      expect(css, `${pkg} reaches a remote host`).not.toMatch(REMOTE_FONT_HOST)
      expect(css, `${pkg} declares no @font-face`).toContain('@font-face')
      expect(css, `${pkg} is not ${family}`).toContain(`font-family: '${family}'`)
      expect(css, `${pkg} is not weight ${weight}`).toContain(`font-weight: ${weight}`)
    }
  })
})
