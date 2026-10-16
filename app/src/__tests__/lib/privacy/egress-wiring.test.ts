/**
 * A tripwire, not a feature test.
 *
 * G14 permits exactly one production importer: the app factory for the web
 * route. Q1: input view/handoff and outgoing web arguments only. Q2: stored
 * history unchanged. Q3: invocation-local table, never stored or reversed.
 * Any second importer crosses a deferred seam and must fail this tripwire.
 * Mutation: add an import to any other production module — the pin goes red.
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
const IMPORTS_PRIVACY = /(?:from|import|require)\s*\(?\s*['"][^'"]*\/privacy(?:\/[^'"]+)?['"]/

describe('lib/privacy is reachable only through the G14 factory and tests', () => {
  const files = sourceFiles(SRC)

  it('finds the source tree at all — the scan is worthless if it globs nothing', () => {
    // Without this, a broken path would make the assertion below vacuously true,
    // which is the failure mode that turns a source-scan pin into decoration.
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain(join('src', 'lib', 'privacy', 'pseudonymise.ts'))
  })

  it('has exactly one permitted production import site', () => {
    const importers = files
      .filter((f) => !f.startsWith(join('src', 'lib', 'privacy') + sep))
      .filter((f) => IMPORTS_PRIVACY.test(readFileSync(join(SRC, '..', f), 'utf8')))
      .filter((f) => !f.startsWith(TESTS + sep))

    expect(importers).toEqual([join('src', 'lib', 'harness-client', 'web-pseudonymiser.server.ts')])
  })

  it('is imported by its own tests, so the scan can actually detect an importer', () => {
    // The positive control for the assertion above.
    const testImporters = files
      .filter((f) => f.startsWith(TESTS + sep))
      .filter((f) => IMPORTS_PRIVACY.test(readFileSync(join(SRC, '..', f), 'utf8')))
    expect(testImporters.length).toBeGreaterThanOrEqual(4)
  })

  it('permits only session.server.ts to import the production factory (X12)', () => {
    const importsFactory =
      /(?:from|import|require)\s*\(?\s*['"][^'"]*web-pseudonymiser\.server(?:\.ts)?['"]/
    const importers = files
      .filter((f) => !f.startsWith(TESTS + sep))
      .filter((f) => importsFactory.test(readFileSync(join(SRC, '..', f), 'utf8')))
    expect(importers).toEqual([join('src', 'lib', 'harness-client', 'session.server.ts')])
  })
})
