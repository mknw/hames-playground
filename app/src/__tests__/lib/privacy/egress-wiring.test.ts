/**
 * A tripwire, not a feature test.
 *
 * `lib/privacy/` is built and tested but imported by NOTHING outside its own
 * tests, and that is the single most load-bearing fact about it: "the modules
 * exist" and "the modules run" are separate claims, and the second one is false.
 * `docs/plan/graph-pseudonymisation.md` says so in prose. Prose drifts, and a
 * reader who finds a tested module naturally assumes it is on the hot path.
 *
 * So the claim is pinned mechanically here. The scan walks `src/` and asserts
 * that every importer of `lib/privacy/*` lives under `src/__tests__/`.
 *
 * ## This test is MEANT to fail when the layer is wired up
 *
 * It is not an assertion that wiring is wrong. It is a stop sign in front of
 * the three open questions in the plan doc — where the hook goes (Q1), whether
 * `conversations.context` stores clear or pseudonymised text (Q2), and where the
 * substitution table lives and for how long (Q3, and the table is itself
 * personal data). Those are owner decisions, and a hook added without them is a
 * default nobody chose.
 *
 * When they are decided, DELETE this file in the same commit that adds the
 * production import, and say in the message which way each question went.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..', '..')
const TESTS = join('src', '__tests__')

/** Every `.ts` / `.tsx` file under `src/`, repo-relative from `app/`. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(name)) {
      out.push(join('src', relative(SRC, full)))
    }
  }
  return out
}

/** Matches any import/export/dynamic-import whose specifier ends in
 *  `privacy/<module>`, however many `../` hops it took to get there. */
const IMPORTS_PRIVACY = /(?:from|import)\s*\(?\s*['"][^'"]*\/privacy\/[a-z-]+['"]/

describe('lib/privacy is reachable only from its own tests', () => {
  const files = sourceFiles(SRC)

  it('finds the source tree at all — the scan is worthless if it globs nothing', () => {
    // Without this, a broken path would make the assertion below vacuously true,
    // which is the failure mode that turns a source-scan pin into decoration.
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain(join('src', 'lib', 'privacy', 'pseudonymise.ts'))
  })

  it('has no importer outside src/__tests__', () => {
    const importers = files
      .filter((f) => !f.startsWith(join('src', 'lib', 'privacy') + sep))
      .filter((f) => IMPORTS_PRIVACY.test(readFileSync(join(SRC, '..', f), 'utf8')))
      .filter((f) => !f.startsWith(TESTS + sep))

    // If this fails, the layer has been wired up. See the module header: the
    // right response is to delete this file deliberately, not to add an
    // exemption to the list above.
    expect(importers).toEqual([])
  })

  it('is imported by its own tests, so the scan can actually detect an importer', () => {
    // The positive control for the assertion above.
    const testImporters = files
      .filter((f) => f.startsWith(TESTS + sep))
      .filter((f) => IMPORTS_PRIVACY.test(readFileSync(join(SRC, '..', f), 'utf8')))
    expect(testImporters.length).toBeGreaterThanOrEqual(4)
  })
})
