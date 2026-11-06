/**
 * Two tinted controls in the Context Manager, read off the RENDERED element
 * and checked against the real palette (#1008 fix round 1, from the #1013
 * review).
 *
 * A palette-level test cannot see these: the failure was in the component's
 * own utilities — the Clear button's `hover:ui-danger/20` wash, and a sanitized
 * chip whose tint stayed a fixed `orange-400` while its text followed the
 * theme. So the test renders each control, parses the colour utilities it
 * actually carries (`text`, every `bg` tint, rest and hover), composites each
 * tint over the grounds the control can sit on, and asserts WCAG AA (4.5:1)
 * in both themes. The chip also has to keep recipe R4: its tint and border are
 * the same token as its text.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createGenerator } from 'unocss'
import config from '../../../../uno.config'
import { SummaryBar } from '~/components/ark-ui/observability/SummaryBar'
import { SanitizedChip } from '~/components/ark-ui/SanitizedChip'

const generator = await createGenerator(config as never)
beforeAll(async () => {
  await generator.generate('i-material-symbols-home', {})
}, 60_000)

type Palette = Record<string, string>

async function palette(selector: ':root' | ':root.light'): Promise<Palette> {
  const css = (await generator.generate('', {})).css
  const block = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)
  const declarations = block![1].replace(/\/\*[\s\S]*?\*\//g, '')
  return Object.fromEntries(
    [...declarations.matchAll(/(--ui-[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  )
}

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

function luminance(hex: string): number {
  const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = channels(hex).map((c) => f(c / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** A tint of `fg` at `alpha`, composited over an opaque `bg`. */
function over(fg: string, alpha: number, bg: string): string {
  const [f, b] = [channels(fg), channels(bg)]
  return (
    '#' +
    f
      .map((v, i) =>
        Math.round(alpha * v + (1 - alpha) * b[i])
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}

/** `ui-danger` → `--ui-danger`; `[var(--ui-x)]` → `--ui-x`. Null for a size or anything else. */
function colourVar(token: string): string | null {
  const bracket = /^\[var\((--ui-[\w-]+)\)\]$/.exec(token)
  if (bracket) return bracket[1]
  return /^ui-[\w-]+$/.test(token) ? `--${token}` : null
}

/** The single text colour an element's `text` attribute names. */
function textVar(el: Element): string {
  const vars = (el.getAttribute('text') ?? '').split(/\s+/).map(colourVar).filter(Boolean)
  expect(vars, `one text colour on ${el.outerHTML.slice(0, 80)}`).toHaveLength(1)
  return vars[0]!
}

/** Every tint on an attribute, rest and variants alike: `[hover:]X/N` → [var, N/100]. */
function tints(el: Element, attr: 'bg' | 'border'): Array<[string, number]> {
  return (el.getAttribute(attr) ?? '')
    .split(/\s+/)
    .map((t) => /^(?:[\w-]+:)?(.+)\/(\d+)$/.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const v = colourVar(m[1])
      expect(v, `tint ${m[0]} is not a theme colour`).not.toBeNull()
      return [v!, Number(m[2]) / 100] as [string, number]
    })
}

const GROUNDS = ['--ui-bg-primary', '--ui-bg-secondary', '--ui-bg-tertiary'] as const

const summary = {
  tool: 'fetch',
  namespace: 'web',
  findingCount: 2,
  rules: ['instruction-override', 'exfil-url'],
  neutralized: true,
  spotlighted: true,
  scanned: 4096,
  eventId: 'audit-1',
}

describe('tinted Context Manager controls clear AA in both themes', () => {
  it('the Clear button, at rest and on hover, on the summary bar ground', async () => {
    const themes = await Promise.all([palette(':root'), palette(':root.light')])
    const { getByText, container } = render(() => (
      <SummaryBar
        events={[{ type: 'user_message', ts: 1, patternId: 'x', data: {} }]}
        onClear={() => {}}
      />
    ))
    const button = getByText('Clear')
    // The bar paints its own ground; the button's tints sit on it.
    const ground = colourVar((container.firstElementChild!.getAttribute('bg') ?? '').trim())
    expect(ground).toBe('--ui-bg-tertiary')
    const ink = textVar(button)
    const washes = tints(button, 'bg')
    expect(washes.length).toBeGreaterThan(0)
    for (const p of themes) {
      for (const [tint, alpha] of washes) {
        const bg = over(p[tint], alpha, p[ground!])
        expect(
          contrast(p[ink], bg),
          `${ink} on ${tint}/${alpha} over ${p[ground!]}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  for (const jumpable of [false, true]) {
    it(`the sanitized chip (${jumpable ? 'button' : 'static'}) keeps R4 and AA on every ground`, async () => {
      const themes = await Promise.all([palette(':root'), palette(':root.light')])
      const { container } = render(() => (
        <SanitizedChip summary={summary} onJump={jumpable ? () => {} : undefined} />
      ))
      const chip = container.querySelector('[data-role="sanitized-chip"]')!
      const ink = textVar(chip)
      const washes = tints(chip, 'bg')
      expect(washes.length).toBeGreaterThan(0)
      // R4: the tint and the border are the same hue as the text, so all
      // three flip with the theme together.
      for (const [tint] of [...washes, ...tints(chip, 'border')]) expect(tint).toBe(ink)
      // The label, and the rules line inside the chip, on the tint over every ground.
      const rules = [...chip.querySelectorAll('span[text]')].find((s) =>
        s.textContent?.startsWith('·'),
      )!
      expect(rules).toBeTruthy()
      for (const p of themes) {
        for (const ground of GROUNDS) {
          for (const [tint, alpha] of washes) {
            const bg = over(p[tint], alpha, p[ground])
            expect(
              contrast(p[ink], bg),
              `label on ${tint}/${alpha} over ${ground}`,
            ).toBeGreaterThanOrEqual(4.5)
            expect(
              contrast(p[textVar(rules)], bg),
              `rules line on ${tint}/${alpha} over ${ground}`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    })
  }
})
