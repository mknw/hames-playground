/**
 * The WCAG AA floor for the observability label colours (#1008 round 2).
 *
 * event-styles.ts emits `var(--ui-evt-…)` / `var(--ui-pat-…)` strings, and
 * the VALUES live in uno.config.ts's theme preflights — one muted pair per
 * label, dark and light. Nothing else checks the property the owner asked
 * for: every label and icon reads (≥ 4.5:1, WCAG AA for text) on its row
 * background in BOTH themes. A hex edit that drops one pair below the floor
 * fails here with the failing pair named.
 *
 * The grounds are the row's real composites: the timeline paints rows on the
 * panel's secondary ground, expanded rows on tertiary, and the page can show
 * the panel over the primary ground; the pattern tints are 6%-alpha washes,
 * which move the composite by less than the margin these pairs keep. So
 * each colour is checked against three dark and three light grounds.
 *
 * Rendered like uno-theme.test.ts does — the real generator over the real
 * config, not a regex over the source — so a declaration that stops being
 * emitted cannot pass.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll } from 'vitest'
import { createGenerator } from 'unocss'
import config from '../../../../uno.config'
import { eventColors, getPatternColor } from '~/lib/observability/event-styles'
import patternColorsJson from '../../../../pattern-colors.json'

const generator = await createGenerator(config as never)

beforeAll(async () => {
  // Pay the icon-collection load once, as uno-theme.test.ts does, so each
  // test's own budget measures generation rather than a multi-MB JSON parse.
  await generator.generate('i-material-symbols-home', {})
}, 60_000)

async function palette(selector: ':root' | ':root.light'): Promise<Record<string, string>> {
  const css = (await generator.generate('', {})).css
  const block = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)
  expect(block, `no ${selector} block in the generated CSS`).not.toBeNull()
  const declarations = block![1].replace(/\/\*[\s\S]*?\*\//g, '')
  return Object.fromEntries(
    [...declarations.matchAll(/(--ui-[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  )
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// The grounds a timeline label can sit on, per theme: panel secondary, the
// expanded row's tertiary, and the page primary.
const DARK_GROUNDS = ['#16191e', '#1d2127', '#0f1115']
const LIGHT_GROUNDS = ['#ffffff', '#f5f6f8', '#eceef2']

const patternIds = Object.keys(patternColorsJson).filter((k) => k !== '$comment')

describe('event + pattern label colours clear WCAG AA in both themes', () => {
  it('every eventColour var is declared in both palettes', async () => {
    const [dark, light] = await Promise.all([palette(':root'), palette(':root.light')])
    for (const color of Object.values(eventColors)) {
      const name = color.match(/^var\((--ui-[\w-]+)\)$/)?.[1]
      expect(name, `event colour is not a single var: ${color}`).toBeTruthy()
      expect(dark[name!], `${name} missing from the dark palette`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(light[name!], `${name} missing from the light palette`).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('every event label clears 4.5:1 on its dark and light row grounds', async () => {
    const [dark, light] = await Promise.all([palette(':root'), palette(':root.light')])
    for (const [type, color] of Object.entries(eventColors)) {
      const name = color.match(/^var\((--ui-[\w-]+)\)$/)![1]
      for (const ground of DARK_GROUNDS) {
        const ratio = contrast(dark[name!], ground)
        expect(ratio, `${type} (${dark[name!]}) on dark ${ground}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const ground of LIGHT_GROUNDS) {
        const ratio = contrast(light[name!], ground)
        expect(ratio, `${type} (${light[name!]}) on light ${ground}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('every pattern label clears 4.5:1 on its dark and light row grounds', async () => {
    const [dark, light] = await Promise.all([palette(':root'), palette(':root.light')])
    for (const id of patternIds) {
      const v = getPatternColor(id).color.match(/^var\((--ui-[\w-]+),/)?.[1]
      expect(v, `${id} has no declared var`).toBeTruthy()
      for (const ground of DARK_GROUNDS) {
        expect(contrast(dark[v!], ground), `${id} on dark ${ground}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const ground of LIGHT_GROUNDS) {
        expect(contrast(light[v!], ground), `${id} on light ${ground}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('the accent button pair clears AA with its own text colour', async () => {
    const [dark, light] = await Promise.all([palette(':root'), palette(':root.light')])
    // Rest state: --ui-accent ground, --ui-on-accent text.
    expect(contrast(dark['--ui-accent'], dark['--ui-on-accent'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['--ui-accent'], light['--ui-on-accent'])).toBeGreaterThanOrEqual(4.5)
    // Hover: --ui-accent-deep ground, same text token.
    expect(contrast(dark['--ui-accent-deep'], dark['--ui-on-accent'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['--ui-accent-deep'], light['--ui-on-accent'])).toBeGreaterThanOrEqual(4.5)
  })

  it('is not vacuous: the pin breaks if the tables change shape', () => {
    // The var-name extraction above silently passes on an empty map; keep the
    // input honest the way theme-migration guards its file list.
    expect(Object.keys(eventColors).length).toBeGreaterThan(20)
    expect(patternIds.length).toBeGreaterThan(15)
    expect(readFileSync('src/lib/observability/event-styles.ts', 'utf8')).toMatch(/var\(--ui-evt-/)
  })
})
