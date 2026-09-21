/**
 * Source scan: core never imports a companion or its host (the 0-app-imports
 * pin, BAML-companion seam lane).
 *
 * `packages/harness-patterns/`, and since #225 PR-C2 `packages/connectors/`
 * too, are published libraries; `app/src` is their HOST. The direction rule
 * (#225 L3) is that core never imports a companion — and app code is exactly
 * that, a companion the package must not know about. The Step 1a interim
 * re-points (four import statements reaching `app/src/lib/harness-baml`)
 * were the last deliberate debt; the BAML-companion seam lane removed them,
 * and this pin is the exit criterion made permanent: a single new import that
 * escapes the package goes red, in the same commit that adds it.
 *
 * The connectors widening (PR-C2) covers the moved modules wholesale: the
 * #346 lesson is that a TYPE-ONLY import still counts — tsx erases it before
 * pack, so only this pin sees it — and the moved graph tools / registry /
 * neo4j modules previously imported app code as values, types and dynamic
 * `import()`s alike. Raw text catches all three shapes.
 *
 * Like `core-types-source-scan.test.ts`, this scans the RAW TEXT of every
 * `.ts`/`.tsx` file under `packages/harness-patterns/`, `packages/agents/`
 * (extended at the @hames/agents extraction, #225 PR-2) and
 * `packages/connectors/` (extended at the connectors move, #225 PR-C2 — same
 * pin shape, one scan over the published packages) and `packages/sandbox/`
 * (extended at the @hames/sandbox extraction — the package the app leans on
 * hardest, since the composition root, three PTY routes and a browser
 * component all import it) — import lines and inline `import()`
 * positions alike, comments included, because a static import cannot hide
 * anywhere else.
 *
 * **Including each package's own co-located `__tests__/` tree** (#365
 * post-merge review, D2). The skip that used to sit in `walk()` dates from
 * when every test lived app-side, where climbing into `app/` is not an
 * escape; since #225 PR-C2 and the @hames/sandbox extraction the tests moved
 * INTO `packages/connectors/` and `packages/sandbox/`, and nothing else can
 * see them: the tarball does not ship tests, so the pack smoke is blind to
 * them, and CI runs each package's suite from inside the full workspace
 * checkout, where a relative climb into `app/` resolves fine. That left the
 * claim those very fixtures make about themselves — "a package whose suite
 * reaches back into the host's test tree is not independently shippable,
 * which is the whole point of co-locating the tests here"
 * (`packages/sandbox/__tests__/fixtures/baml.ts`) — as convention rather than
 * an invariant, and a standalone clone would fail to run its own suite.
 *
 * Three escape shapes are checked:
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
const PACKAGE_ROOTS = [
  resolve(process.cwd(), '../packages/harness-patterns'),
  resolve(process.cwd(), '../packages/agents'),
  resolve(process.cwd(), '../packages/connectors'),
  resolve(process.cwd(), '../packages/sandbox'),
]

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
      // Only the installed dependency tree is out of scope — a package's own
      // `__tests__/` is IN it (see the header). Tests and fixtures are held to
      // the same rule as the modules beside them, so no filename filter here
      // either: a `.test.ts` reaching into `app/` is exactly the shape D2 named.
      if (entry.name === 'node_modules') continue
      files.push(...(await walk(full)))
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

describe('zero app imports under the published packages (BAML-companion seam lane pin)', () => {
  it('no file under any published package imports app code, tests and fixtures included', async () => {
    const offenders: string[] = []
    for (const root of PACKAGE_ROOTS) {
      const files = await walk(root)
      expect(
        files.length,
        `${root} scanned nothing — a broken walk must fail loudly`,
      ).toBeGreaterThan(0)

      for (const file of files) {
        const text = await readFile(file, 'utf8')
        const rel = relative(root, file)
        if (RELATIVE_ESCAPE.test(text)) {
          offenders.push(`${root.split('/').pop()}/${rel} (relative escape into app/)`)
          continue
        }
        for (const specifier of APP_SPECIFIERS) {
          if (text.includes(specifier)) {
            offenders.push(`${root.split('/').pop()}/${rel} (${specifier})`)
            break
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
