// @vitest-environment node
// (node, not jsdom: importing a vitest config loads esbuild, whose TextEncoder
// invariant fails under jsdom.)
/**
 * The app-path e2e suite must never run in CI. This is the pin that says so.
 *
 * `app/e2e/` drives whole conversations through the real server actions, the
 * real run loop, the real SSE route and a real Postgres. Its default mode is
 * hermetic — a fake inference endpoint and a fake MCP gateway, no credential
 * and no bill — but it is still the wrong thing for a merge gate: one scenario
 * deliberately sits through a 90-second cold start, the suite needs a database,
 * and its opt-in `E2E_LIVE=verda` mode makes real calls against a
 * scale-to-zero GPU box. A CI job that picked it up would take minutes longer,
 * go red on someone else's docker, and turn a diagnostic into a gate.
 *
 * The separation is structural — a separate vitest config, a directory outside
 * every `src/`-rooted glob, no file named like a test — but "structural" is a
 * claim about configuration that a one-line edit can void without anyone
 * noticing. Each assertion below fails on exactly one such edit.
 *
 * This file is deliberately an ORDINARY test, under `src/__tests__/`, so the
 * guard runs in the very job it protects. Its sibling is
 * `evals-not-in-ci.test.ts`, which does the same for `app/evals/`; the two are
 * kept separate rather than merged because they protect different directories
 * for different reasons and a shared helper would make a red one ambiguous.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import appConfig from '../../vitest.config'
import pkgConfig from '../../../packages/harness-patterns/vitest.config'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = path.resolve(APP, '..')

/** Every file under a directory, recursively, as app-relative POSIX paths. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(path.relative(APP, full).split(path.sep).join('/'))
  }
  return out
}

const E2E_FILES = walk(path.join(APP, 'e2e'))
const E2E_TS = E2E_FILES.filter((f) => f.endsWith('.ts'))

describe('the e2e suite is not reachable from CI', () => {
  // Guards against the guard becoming vacuous: if `e2e/` were emptied or
  // moved, every assertion below would pass while proving nothing.
  it('there are e2e modules to protect', () => {
    expect(E2E_TS.length).toBeGreaterThan(5)
    expect(E2E_TS).toContain('e2e/vitest.config.ts')
    expect(E2E_TS.filter((f) => f.startsWith('e2e/scenarios/')).length).toBeGreaterThan(3)
  })

  it('the CI vitest config collects nothing outside src/', () => {
    const config = readFileSync(path.join(APP, 'vitest.config.ts'), 'utf8')
    const include = /include:\s*\[([^\]]*)\]/.exec(config)?.[1]
    expect(include, 'vitest.config.ts has no test.include array').toBeTruthy()
    const patterns = [...(include as string).matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(patterns.length).toBeGreaterThan(0)
    for (const pattern of patterns) {
      expect(pattern, `test.include pattern ${pattern} escapes src/`).toMatch(/^src\//)
    }
  })

  // The runner-level escape (#407): the config's `projects` list may add
  // @hames-ai/harness-patterns' own suite so coverage counts its tests, and
  // nothing else. A project entry naming e2e/ would run that suite in CI
  // without touching any include glob. Read from the IMPORTED config, not
  // its source text, so no spelling of the entry (backticks, a variable, an
  // inline object with its own include) can slip past a pattern.
  it('no vitest project reaches e2e/', () => {
    const projects = appConfig.test?.projects
    expect(Array.isArray(projects), 'vitest.config.ts has no projects array').toBe(true)
    for (const project of projects as unknown[]) {
      if (typeof project === 'string') {
        expect(project, `the project ${project} could collect the e2e suite`).toBe(
          '../packages/harness-patterns',
        )
        continue
      }
      // An inline project may only extend the root options and name itself —
      // an include, root or dir of its own is a way out of src/.
      const inline = project as { extends?: unknown; test?: Record<string, unknown> }
      expect(Object.keys(inline).sort(), 'an inline project overrides more than its name').toEqual([
        'extends',
        'test',
      ])
      expect(inline.extends).toBe(true)
      expect(Object.keys(inline.test ?? {})).toEqual(['name'])
    }
  })

  // The package project itself is only safe while its own include stays
  // inside its `__tests__/`.
  it("the harness-patterns project's include stays rooted at its __tests__/", () => {
    const include = pkgConfig.test?.include ?? []
    expect(include.length).toBeGreaterThan(0)
    for (const pattern of include) {
      expect(pattern, `the package include pattern ${pattern} escapes __tests__/`).toMatch(
        /^__tests__\//,
      )
    }
  })

  it('no e2e file is named like a test, so a widened glob still would not match', () => {
    const testLike = E2E_FILES.filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f))
    expect(testLike).toEqual([])
  })

  it('the e2e runner is a separate config rooted at e2e/', () => {
    // Not decoration: if `test:e2e` collected `src/**` too it would re-run the
    // whole unit suite in a node environment with the dev auth bypass on, and
    // the two suites' setup files would fight over `process.env`.
    const config = readFileSync(path.join(APP, 'e2e/vitest.config.ts'), 'utf8')
    const include = /include:\s*\[([^\]]*)\]/.exec(config)?.[1]
    const patterns = [...(include ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(patterns.length).toBeGreaterThan(0)
    for (const pattern of patterns) {
      expect(pattern, `the e2e include pattern ${pattern} escapes e2e/`).toMatch(/^e2e\//)
    }
  })

  it('coverage measures nothing under e2e/', () => {
    const config = readFileSync(path.join(APP, 'vitest.config.ts'), 'utf8')
    const coverage = config.slice(config.indexOf('coverage:'))
    const include = /include:\s*\[([^\]]*)\]/.exec(coverage)?.[1]
    const patterns = [...(include ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(patterns.length).toBeGreaterThan(0)
    // src/** plus the two sanctioned escapes: the library and the agents
    // moved to packages/ (#225) and stay measured — anything else outside
    // src/ (e2e/, evals/) is still a red. They start `**/` because coverage
    // globs match absolute paths; the `../packages/…` spelling this list
    // used to allow matched nothing (#407).
    const ALLOWED_ESCAPES = ['**/packages/harness-patterns/**', '**/packages/agents/**']
    for (const pattern of patterns) {
      if (ALLOWED_ESCAPES.some((e) => pattern.startsWith(e))) continue
      expect(pattern, `coverage.include pattern ${pattern} escapes src/`).toMatch(/^src\//)
    }
  })

  it('nothing under src/ imports from e2e/', () => {
    const offenders = walk(path.join(APP, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => f !== 'src/__tests__/e2e-not-in-ci.test.ts')
      // Every import shape, not just `from '…'`. The direction that is allowed
      // is e2e → src (the suite drives the app); src → e2e would drag the
      // fakes, and their listening sockets, into the CI process.
      .filter((f) =>
        /(?:from|import|require)\s*\(?\s*['"][^'"]*\/e2e\//.test(
          readFileSync(path.join(APP, f), 'utf8'),
        ),
      )
    expect(offenders).toEqual([])
  })

  it('the CI workflow never invokes the e2e script', () => {
    const ci = readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).not.toMatch(/test:e2e/)
    expect(ci).not.toMatch(/\be2e\//)
  })

  it('no other package script pulls the e2e suite in', () => {
    const pkg = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:e2e'], 'the e2e script should exist').toBeTruthy()
    // A `pretest` hook, or a `test` that chains the e2e run, is the realistic
    // way this leaks into CI.
    const leaks = Object.entries(pkg.scripts)
      .filter(([name]) => name !== 'test:e2e')
      .filter(([, body]) => /test:e2e|\be2e\//.test(body))
      .map(([name]) => name)
    expect(leaks).toEqual([])
  })
})
