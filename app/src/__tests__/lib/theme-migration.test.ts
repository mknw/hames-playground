/**
 * The app's chrome is on the theme (#226 B8, owner follow-up).
 *
 * B8 shipped the mechanism and put the auth pages on it, which left the
 * switcher looking broken: the surfaces a signed-in user actually looks at
 * were still fixed `dark-*` hexes, so flipping to light repainted the top bar
 * and nothing else. The fix was a rename, and a rename is exactly the kind of
 * thing that half-comes-back — one `dark-bg-tertiary` copy-pasted into a new
 * panel is invisible in dark mode and a hole in light mode.
 *
 * So this is a source check, not a render check: there is no assertion a
 * mounted component can make here, because in dark mode both spellings look
 * identical by construction.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

/** Every `.tsx` under `dir`, recursively. */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return entry.name.endsWith('.tsx') ? [path] : []
  })
}

// The chrome: components and routed pages. `src/lib` is excluded on purpose —
// `turn-colors.ts` and `agent-palette.ts` are graph *data* palettes handed to
// Cytoscape as values, and those are not theme roles.
const CHROME = [...tsxFiles('src/components'), ...tsxFiles('src/routes')].sort()

describe('the migrated chrome', () => {
  it('covers the whole interface, not a sample of it', () => {
    // A guard on an empty list passes for the wrong reason.
    expect(CHROME.length).toBeGreaterThan(20)
  })

  it.each(CHROME)('%s uses no fixed dark-* colour token', (file) => {
    const source = readFileSync(file, 'utf8')
    const fixed = source.match(/\bdark-(bg|text|border)-[a-z]+/g) ?? []
    // `ui-bg-primary` is the same hex in dark; `dark-bg-primary` is that hex
    // in *both* modes, which is the bug.
    expect(fixed).toEqual([])
  })

  it.each(CHROME)('%s uses no neon colour the light palette cannot darken', (file) => {
    const source = readFileSync(file, 'utf8')
    // #00ffff and #39ff14 are unreadable on white. Both have a theme-aware
    // twin now — `ui-accent` and `ui-success` — whose dark values are those
    // very hexes, so this is a spelling rule, not a redesign.
    expect(source.match(/\bneon-(cyan|green)\b/g) ?? []).toEqual([])
  })
})
