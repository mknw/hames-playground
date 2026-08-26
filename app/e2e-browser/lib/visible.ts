/**
 * "Can a human actually see this?" — computed style, read in a real browser.
 *
 * Two failure shapes, both of which a jsdom component test passes with flying
 * colours because jsdom does not have a cascade:
 *
 *   - **Invisible on its ground.** A token that resolves to nearly the colour
 *     behind it. The theme work (#226 B8) moved every interface colour onto
 *     `ui-*` variables that are redefined per theme, so a component that reads
 *     correctly in dark can vanish in light with no markup change at all —
 *     which is why this is checked in BOTH.
 *   - **A dead icon class.** `presetIcons` registers exactly two collections;
 *     an `i-mdi-*` (removed in #226 B6) emits no CSS, so the span keeps its
 *     `w`/`h` box and renders NOTHING. It is invisible in a way no assertion on
 *     text, roles or geometry can see — the element is there and correctly
 *     sized, and the glyph is simply absent. `theme-migration.test.ts` catches
 *     the tokens by source scan; this catches the rendering.
 *
 * The threshold below is 3:1, not the 4.5:1 body-text floor from
 * `A11Y-CHECKLIST.md`. That is deliberate and is not this suite quietly
 * lowering a bar: the checklist owns contrast compliance and does it properly,
 * per element and per role, with the reasoning written down. What these
 * scenarios claim is the much weaker "this element is not invisible", and a
 * spot check that failed on a legitimately muted label would be noise in the
 * one suite whose red results are supposed to be worth reading.
 */
import { expect, type Locator } from '@playwright/test'

/** The floor below which an element is treated as invisible on its ground. */
export const NOT_INVISIBLE_RATIO = 3

interface Paint {
  /** Resolved sRGB, 0-255. */
  color: [number, number, number]
  /** The first non-transparent background found walking up from the element. */
  background: [number, number, number]
  /** The colours as the browser reported them, for a legible failure message. */
  colorCss: string
  backgroundCss: string
  width: number
  height: number
  /** UnoCSS renders monochrome icons as a mask over `currentColor`; some come
   *  through as a background image instead. Either counts as "a glyph". */
  maskImage: string
  backgroundImage: string
}

/**
 * Read an element's painted colours and box, as the browser resolved them.
 *
 * Colours are normalised through a 1x1 canvas rather than parsed. Chromium
 * reports resolved colours in whatever syntax the source used — the first draft
 * of this file parsed `rgb()` with a regex and silently scored
 * `color(srgb 0 1 1)` (the accent, cyan) as black, which made the header strip
 * look like a 1.06:1 contrast failure. A canvas resolves EVERY colour syntax,
 * including the ones that do not exist yet, and hands back the alpha too.
 */
export async function paintOf(locator: Locator): Promise<Paint> {
  return locator.evaluate((el) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1)
      // A syntax the canvas cannot parse leaves fillStyle untouched, so it is
      // seeded with a sentinel that would be obvious rather than plausible.
      ctx.fillStyle = 'rgba(0, 0, 0, 0)'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const data = ctx.getImageData(0, 0, 1, 1).data
      return [data[0], data[1], data[2], data[3]]
    }

    const style = getComputedStyle(el as Element)

    // COMPOSITE the background stack rather than taking the first layer with
    // any alpha at all. The house style tints controls with `bg="ui-accent/10"`
    // — a tenth of the accent over the bar — and reading that layer raw scores
    // accent-on-accent, i.e. 1.00:1, for text that is in fact perfectly legible
    // on the dark ground showing through it. Source-over, from the element
    // outwards, until the accumulated ground is opaque: which is what the
    // browser paints and therefore what a reader sees.
    const layers: string[] = []
    for (let node: Element | null = el as Element; node; node = node.parentElement) {
      layers.push(getComputedStyle(node).backgroundColor)
    }
    let ground: [number, number, number, number] = [0, 0, 0, 0]
    for (const layer of layers) {
      if (ground[3] >= 0.99) break
      const [lr, lg, lb, la255] = rgba(layer)
      const la = la255 / 255
      const remaining = 1 - ground[3]
      const added = la * remaining
      ground = [
        ground[0] + lr * added,
        ground[1] + lg * added,
        ground[2] + lb * added,
        ground[3] + added,
      ]
    }
    // Nothing opaque anywhere up the tree: the canvas behind the document is
    // white, which is what the remaining fraction is showing.
    const remainder = 1 - ground[3]
    const background: [number, number, number] = [
      Math.round(ground[0] + 255 * remainder),
      Math.round(ground[1] + 255 * remainder),
      Math.round(ground[2] + 255 * remainder),
    ]

    const box = (el as Element).getBoundingClientRect()
    const [cr, cg, cb] = rgba(style.color)
    return {
      color: [cr, cg, cb] as [number, number, number],
      background,
      colorCss: style.color,
      backgroundCss: `rgb(${background.join(', ')}) (composited from ${layers.length} layers)`,
      width: box.width,
      height: box.height,
      maskImage: style.maskImage || style.webkitMaskImage || 'none',
      backgroundImage: style.backgroundImage || 'none',
    }
  })
}

/** WCAG relative luminance of an sRGB triplet. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number): number => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two sRGB triplets. */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Assert an element's foreground is distinguishable from what is behind it. */
export async function expectReadable(locator: Locator, what: string): Promise<void> {
  const paint = await paintOf(locator)
  const ratio = contrastRatio(paint.color, paint.background)
  expect(
    ratio,
    `${what}: ${paint.colorCss} on ${paint.backgroundCss} is ${ratio.toFixed(2)}:1 — effectively ` +
      'invisible on its own background',
  ).toBeGreaterThanOrEqual(NOT_INVISIBLE_RATIO)
}

/**
 * Assert an icon span actually renders a glyph.
 *
 * Both halves are needed. A registered icon with no size is invisible; a sized
 * span with no mask is the `i-mdi-*` shape — present, correctly laid out, and
 * empty.
 */
export async function expectGlyphRenders(locator: Locator, what: string): Promise<void> {
  const paint = await paintOf(locator)
  expect(paint.width, `${what}: the icon has no width`).toBeGreaterThan(0)
  expect(paint.height, `${what}: the icon has no height`).toBeGreaterThan(0)
  expect(
    paint.maskImage !== 'none' || paint.backgroundImage !== 'none',
    `${what}: the icon class emitted no CSS — the span is sized but paints nothing, which is ` +
      'what an unregistered collection (e.g. a surviving `i-mdi-*`) looks like on screen',
  ).toBe(true)
}
