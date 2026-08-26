/**
 * The evals must never run in CI. This is the pin that says so.
 *
 * `app/evals/` makes real, billed LLM calls against live endpoints — a
 * self-hosted GPU box that scales to zero, and a metered provider API. A CI
 * job that picked them up would bill every push, go red on someone else's
 * network, and quietly turn a compatibility measurement into a merge gate.
 *
 * The separation is structural (vitest's globs are rooted at `src/`, and no CI
 * step invokes the script), but "structural" is a claim about configuration
 * that a one-line edit can void without anyone noticing — a widened glob, a
 * convenience `pretest`, an import from `src/` that drags an eval module into
 * the test graph. Each assertion below fails on exactly one of those edits.
 *
 * This file is deliberately an ORDINARY test: it lives under `src/__tests__/`,
 * so it runs in the very job it is protecting.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = path.resolve(APP, '..')

/** Every file under a directory, recursively, as app-relative POSIX paths. */
function walk(dir: string, base: string = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(path.relative(APP, full).split(path.sep).join('/'))
  }
  return out
}

const EVAL_FILES = walk(path.join(APP, 'evals'))
const EVAL_TS = EVAL_FILES.filter((f) => f.endsWith('.ts'))

describe('the eval suite is not reachable from CI', () => {
  // Guards against the guard becoming vacuous: if `evals/` were emptied or
  // moved, every assertion below would pass while proving nothing.
  it('there are eval modules to protect', () => {
    expect(EVAL_TS.length).toBeGreaterThan(5)
    expect(EVAL_TS).toContain('evals/run.ts')
  })

  it('vitest collects nothing outside src/', () => {
    const config = readFileSync(path.join(APP, 'vitest.config.ts'), 'utf8')
    const include = /include:\s*\[([^\]]*)\]/.exec(config)?.[1]
    expect(include, 'vitest.config.ts has no test.include array').toBeTruthy()
    const patterns = [...(include as string).matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(patterns.length).toBeGreaterThan(0)
    // Rooted at src/ — an `evals/**` or a bare `**/*.test.ts` here would start
    // collecting eval modules, and both are one careless edit away.
    for (const pattern of patterns) {
      expect(pattern, `test.include pattern ${pattern} escapes src/`).toMatch(/^src\//)
    }
  })

  it('no eval file is named like a test, so a widened glob still would not match', () => {
    const testLike = EVAL_FILES.filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f))
    expect(testLike).toEqual([])
  })

  it('coverage measures nothing under evals/', () => {
    const config = readFileSync(path.join(APP, 'vitest.config.ts'), 'utf8')
    const coverage = config.slice(config.indexOf('coverage:'))
    const include = /include:\s*\[([^\]]*)\]/.exec(coverage)?.[1]
    const patterns = [...(include ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(patterns.length).toBeGreaterThan(0)
    for (const pattern of patterns) {
      expect(pattern, `coverage.include pattern ${pattern} escapes src/`).toMatch(/^src\//)
    }
  })

  it('nothing under src/ imports from evals/', () => {
    const offenders = walk(path.join(APP, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => f !== 'src/__tests__/evals-not-in-ci.test.ts')
      // Every import shape, not just `from '…'`: `await import('../../evals/run')`
      // and a bare `import '../../evals/run'` both reach the module — and
      // `evals/run.ts` calls `main()` at module scope, so either would bill
      // eleven scenarios inside the job this guard exists to keep unbilled.
      // `await import()` is also the shape every scenario in this suite uses.
      .filter((f) =>
        /(?:from|import|require)\s*\(?\s*['"][^'"]*evals\//.test(
          readFileSync(path.join(APP, f), 'utf8'),
        ),
      )
    expect(offenders).toEqual([])
  })

  it('the CI workflow never invokes the eval script', () => {
    const ci = readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).not.toMatch(/eval:harness/)
    expect(ci).not.toMatch(/\bevals\//)
  })

  it('no other package script pulls the evals in', () => {
    const pkg = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['eval:harness'], 'the eval script should exist').toBeTruthy()
    // A `pretest`/`prebuild` hook, or a `test` that chains the evals, is the
    // realistic way this leaks into CI. Any script OTHER than the eval entries
    // that mentions them fails here.
    const leaks = Object.entries(pkg.scripts)
      .filter(([name]) => !name.startsWith('eval:'))
      .filter(([, body]) => /eval:harness|evals\//.test(body))
      .map(([name]) => name)
    expect(leaks).toEqual([])
  })
})
