/**
 * Source scan: core never imports a companion or its host (the 0-app-imports
 * pin, BAML-companion seam lane).
 *
 * `packages/harness-patterns/` is the published library; `app/src` is its
 * HOST. The direction rule (#225 L3) is that core never imports a companion —
 * and app code is exactly that, a companion the package must not know about.
 * The Step 1a interim re-points (four import statements reaching
 * `app/src/lib/harness-baml`) were the last deliberate debt; the
 * BAML-companion seam lane removed them, and this pin is the exit criterion
 * made permanent: a single new import that escapes the package goes red, in
 * the same commit that adds it.
 *
 * Like `core-types-source-scan.test.ts`, this scans the RAW TEXT of every
 * non-test file under `packages/harness-patterns/` — import lines and inline
 * `import()` positions alike, comments included, because a static import
 * cannot hide anywhere else. Three escape shapes are checked:
 *
 *   - a relative specifier climbing out of the package into `app/`
 *     (`../../app/…` — the shape all four removed edges had);
 *   - any `app/src` specifier (absolute-style or in prose that names one);
 *   - the app's `~/` path alias, which resolves to `app/src` under vinxi/Vite
 *     and would escape the package just as surely while reading local.
 */
import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

// `process.cwd()` is `app/` under vitest (same anchor the other source-scan
// pins use); `import.meta.url` is not a file URL in this jsdom environment.
const CORE = resolve(process.cwd(), '../packages/harness-patterns')

/** A relative climb out of the package (`../app`, `../../app`, …), whatever
 *  the depth or the trailing path. */
const RELATIVE_ESCAPE = /(?:\.\.\/)+app\//
/** Literal specifiers that resolve inside app/src. */
const APP_SPECIFIERS = ['app/src', '~/']

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      files.push(...(await walk(full)))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

describe('zero app imports under harness-patterns/ (BAML-companion seam lane pin)', () => {
  it('no non-test file under the package imports app code', async () => {
    const files = await walk(CORE)
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      const rel = relative(CORE, file)
      if (RELATIVE_ESCAPE.test(text)) {
        offenders.push(`${rel} (relative escape into app/)`)
        continue
      }
      for (const specifier of APP_SPECIFIERS) {
        if (text.includes(specifier)) {
          offenders.push(`${rel} (${specifier})`)
          break
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
