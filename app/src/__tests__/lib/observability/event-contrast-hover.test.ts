/**
 * Event labels on the HOVERED row (#1008 fix round 1, from the #1013 review).
 *
 * The timeline's event node (TimelineRows.tsx NodeContent / ToolPairRow)
 * paints `hover:ui-bg-hover` behind its label and icon, and --ui-bg-hover is
 * the lowest-contrast ground a label meets in dark. event-contrast.test.ts
 * checks the resting grounds; this checks that one, in both themes, and
 * collects every failure rather than stopping at the first.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createGenerator } from 'unocss'
import config from '../../../../uno.config'
import { eventColors } from '~/lib/observability/event-styles'

const generator = await createGenerator(config as never)
beforeAll(async () => {
  await generator.generate('i-material-symbols-home', {})
}, 60_000)

async function palette(selector: ':root' | ':root.light'): Promise<Record<string, string>> {
  const css = (await generator.generate('', {})).css
  const block = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)
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

describe('event labels on the hovered row ground', () => {
  it('every event label clears 4.5:1 on --ui-bg-hover in both themes', async () => {
    const [dark, light] = await Promise.all([palette(':root'), palette(':root.light')])
    const failures: string[] = []
    for (const [type, color] of Object.entries(eventColors)) {
      const name = color.match(/^var\((--ui-[\w-]+)\)$/)![1]
      for (const [theme, p] of [
        ['dark', dark],
        ['light', light],
      ] as const) {
        const r = contrast(p[name], p['--ui-bg-hover'])
        if (r < 4.5)
          failures.push(`${theme} ${type} ${p[name]} on ${p['--ui-bg-hover']}: ${r.toFixed(2)}`)
      }
    }
    console.log(failures.join('\n'))
    expect(failures).toEqual([])
  })
})
