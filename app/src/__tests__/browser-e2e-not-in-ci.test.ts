/**
 * The BROWSER e2e suite must never run in CI. This is the pin that says so.
 *
 * `app/e2e-browser/` drives a real Chromium against a real `vinxi dev` server
 * against a real Postgres. Its inference endpoint and MCP gateway are the same
 * fakes `app/e2e/` uses — no credential and no bill — but it is still the wrong
 * thing for a merge gate: it needs a ~95 MB browser download, a database, and a
 * dev-server boot per run, and its wall clock is a developer's machine rather
 * than a hermetic image. A CI job that picked it up would take minutes longer
 * and go red on someone else's docker, turning a diagnostic into a gate.
 *
 * This is a SIBLING of `e2e-not-in-ci.test.ts` and `evals-not-in-ci.test.ts`
 * rather than an extension of either, for the reason the first of them states:
 * the three protect different directories, and a shared helper would make a red
 * one ambiguous about which suite leaked. What is genuinely different here is
 * the last two blocks — a second runner (Playwright, with its own config and
 * its own browser download) and the dev-only seam in `src/` that the suite
 * reaches through, which is the one thing in this PR that could affect
 * production if its gates ever came off.
 *
 * Like its siblings, this is an ORDINARY test under `src/__tests__/`, so the
 * guard runs in the very job it protects.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = path.resolve(APP, '..')
const SUITE = 'e2e-browser'

/** Every file under a directory, recursively, as app-relative POSIX paths.
 *  `.runtime/` is gitignored run output (handles, traces, screenshots) and is
 *  not part of the suite. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '.runtime' || entry === 'node_modules') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(path.relative(APP, full).split(path.sep).join('/'))
  }
  return out
}

const FILES = walk(path.join(APP, SUITE))
const TS = FILES.filter((f) => f.endsWith('.ts'))

// ============================================================================
// The server-entry static-import closure
// ============================================================================

/** The module SolidStart loads once when the server handler graph loads. */
const ENTRY = 'src/middleware.ts'

/**
 * Source with comments removed.
 *
 * Load-bearing, not hygiene: the two modules this file is about both DISCUSS
 * `import('…/baml_client')` in their doc comments, and a scanner that read
 * prose as code would report the very idiom it exists to require.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

interface StaticImport {
  /** The specifier as written. */
  spec: string
  /** `import type` / `export type` — erased before a bundler sees it, so it
   *  neither creates a graph edge nor pulls a runtime into the entry chunk. */
  typeOnly: boolean
  /** The statement, whitespace-collapsed, for a legible failure message. */
  text: string
}

/**
 * Every STATIC import/re-export in a module. Dynamic `import()` is deliberately
 * not matched — it is the house idiom this whole check exists to require, and it
 * lands in a lazy chunk rather than in the entry.
 */
function staticImports(source: string): StaticImport[] {
  const clean = stripComments(source)
  const out: StaticImport[] = []
  // Multi-line named-import lists are covered: the gap between the keyword and
  // `from` is matched with a negated class, which crosses newlines.
  const withFrom = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?[^'"]*?from[ \t]*['"]([^'"]+)['"]/gm
  for (const m of clean.matchAll(withFrom)) {
    out.push({ spec: m[2], typeOnly: m[1] !== undefined, text: m[0].replace(/\s+/g, ' ').trim() })
  }
  // `import './x'` for side effects only.
  for (const m of clean.matchAll(/^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm)) {
    out.push({ spec: m[1], typeOnly: false, text: m[0].trim() })
  }
  return out
}

/** A relative or `~/`-aliased specifier resolved to an app-relative file, or
 *  `null` for a package import (not walked — a package's own graph is nitro's
 *  problem, and `@boundaryml/baml` is the thing being asserted ABOUT). */
function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('~/')) base = path.join(APP, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(path.join(APP, fromFile)), spec)
  else return null
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    try {
      if (statSync(candidate).isFile()) {
        return path.relative(APP, candidate).split(path.sep).join('/')
      }
    } catch {
      // Not this candidate.
    }
  }
  return null
}

/** Everything reachable from `ENTRY` by STATIC imports, transitively. */
function entryClosure(): string[] {
  const seen = new Set<string>([ENTRY])
  const queue = [ENTRY]
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const imported of staticImports(readFileSync(path.join(APP, file), 'utf8'))) {
      if (imported.typeOnly) continue
      const resolved = resolveLocal(file, imported.spec)
      if (resolved === null || seen.has(resolved)) continue
      seen.add(resolved)
      queue.push(resolved)
    }
  }
  return [...seen]
}

const ENTRY_CLOSURE = entryClosure()

describe('the browser e2e suite is not reachable from CI', () => {
  // Guards against the guard becoming vacuous: if the directory were emptied
  // or moved, every assertion below would pass while proving nothing.
  it('there are browser-e2e modules to protect', () => {
    expect(TS.length).toBeGreaterThan(5)
    expect(TS).toContain(`${SUITE}/playwright.config.ts`)
    expect(TS.filter((f) => f.startsWith(`${SUITE}/scenarios/`)).length).toBeGreaterThan(3)
  })

  it('no file here is named like a test, so a widened vitest glob still would not match', () => {
    expect(FILES.filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f))).toEqual([])
  })

  it('every scenario carries the .browser.ts suffix the runner matches on', () => {
    const scenarios = FILES.filter((f) => f.startsWith(`${SUITE}/scenarios/`))
    expect(scenarios.length).toBeGreaterThan(0)
    for (const file of scenarios) {
      expect(file, `${file} would not be collected by testMatch`).toMatch(/\.browser\.ts$/)
    }
  })

  it('the runner is a separate config rooted at the suite directory', () => {
    const config = readFileSync(path.join(APP, SUITE, 'playwright.config.ts'), 'utf8')
    // Both halves: a testDir pointing anywhere else, or a testMatch loose
    // enough to collect `src/**`, would re-run the unit suite under a browser.
    expect(config).toMatch(/testDir:.*['"`]\.\/scenarios/)
    expect(config).toMatch(/testMatch:.*\\\.browser\\\.ts/)
  })

  it('nothing under src/ imports from the browser suite', () => {
    const offenders = walk(path.join(APP, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => f !== `src/__tests__/browser-e2e-not-in-ci.test.ts`)
      // The allowed direction is e2e-browser → src (the suite drives the app).
      // src → e2e-browser would drag the fakes, their listening sockets and a
      // child-process spawn into the CI process.
      .filter((f) =>
        new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"][^'"]*/${SUITE}/`).test(
          readFileSync(path.join(APP, f), 'utf8'),
        ),
      )
    expect(offenders).toEqual([])
  })

  it('the CI workflow never invokes it, and never installs a browser', () => {
    const ci = readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).not.toMatch(/test:e2e:browser/)
    expect(ci).not.toMatch(new RegExp(`\\b${SUITE}\\b`))
    // The realistic way this leaks is not the script but the browser: a
    // `playwright install` step added for something else would make the suite
    // one `pnpm` invocation away from running.
    expect(ci).not.toMatch(/playwright/i)
  })

  it('no other package script pulls it in', () => {
    const pkg = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.scripts['test:e2e:browser'], 'the browser e2e script should exist').toBeTruthy()
    const leaks = Object.entries(pkg.scripts)
      .filter(([name]) => name !== 'test:e2e:browser')
      .filter(([, body]) => new RegExp(`test:e2e:browser|\\b${SUITE}/`).test(body))
      .map(([name]) => name)
    expect(leaks).toEqual([])

    // Playwright is a devDependency and stays one: a runtime dependency would
    // put it in the production image, which builds from the lockfile.
    expect(pkg.devDependencies?.['@playwright/test']).toBeTruthy()
    expect(pkg.dependencies?.['@playwright/test']).toBeUndefined()
  })
})

/**
 * The seam is the only thing in this suite that lives in `src/`, so it is the
 * only thing that could reach production. Both of its gates are pinned by
 * reading the source, because one of them (`import.meta.env.DEV`) is a
 * compile-time constant that no runtime test can exercise —
 * `lib/inference/dev-fake-inference.test.ts` pins the behaviour of the other.
 */
describe('the dev-only inference redirect cannot be enabled in production', () => {
  const seam = readFileSync(
    path.join(APP, 'src/lib/inference/dev-fake-inference.server.ts'),
    'utf8',
  )
  const middleware = readFileSync(path.join(APP, 'src/middleware.ts'), 'utf8')

  it('gates the endpoint on import.meta.env.DEV', () => {
    // Vite statically replaces this with `false` in a production build, so the
    // whole redirect is dead code there. Losing this line would turn a
    // dev-only test hook into a production configuration that re-points
    // production prompts at an arbitrary host — the switch ADR-0001 deleted.
    //
    // Anchored to the RETURN, not to the expression: the module also mentions
    // `import.meta.env.DEV` in the production-leak warning at the bottom, and
    // the first draft of this assertion matched that instead — deleting the
    // real gate left it green.
    expect(seam).toMatch(/if \(import\.meta\.env\.DEV !== true\) return null/)
  })

  it('additionally requires an explicit opt-in env var', () => {
    expect(seam).toMatch(/process\.env\.E2E_FAKE_INFERENCE_URL/)
  })

  it('the server-entry closure is WALKED, so the pin cannot go vacuous', () => {
    // The assertion below is only as good as this list. A resolver that stopped
    // returning anything would make it green over nothing, so the three
    // landmarks the invariant is about are named: the entry, the seam it
    // reaches, and the deepest module the reviewer's walk turned up — the one
    // whose acquiring a `Collector` import is the realistic regression.
    expect(ENTRY_CLOSURE).toContain(ENTRY)
    expect(ENTRY_CLOSURE).toContain('src/lib/inference/dev-fake-inference.server.ts')
    expect(ENTRY_CLOSURE).toContain('src/lib/metrics/usage-recorder.server.ts')
    expect(ENTRY_CLOSURE).toContain('src/lib/harness-patterns/clients.server.ts')
    expect(ENTRY_CLOSURE.length).toBeGreaterThan(10)
  })

  it('nothing in the server-entry closure imports BAML at module scope', () => {
    // The regression CI caught on the first push of this suite: a static
    // `import { ClientRegistry } from '@boundaryml/baml'` in the seam reaches
    // the server ENTRY chunk through `src/middleware.ts` (which imports the
    // seam statically), nitro links the native runtime into
    // `.output/server/index.mjs`, and the production container dies at boot
    // with `Cannot find module '…/@boundaryml/baml/native'` before serving a
    // request. `pnpm typecheck`, `pnpm test:run` and `pnpm build` ALL pass with
    // that in place — only the docker boot job fails — which is exactly why it
    // is pinned here, in the suite that runs on every push.
    //
    // THE CLOSURE, not two files. The first version of this checked
    // `dev-fake-inference.server.ts` and `middleware.ts` by name and said
    // "nothing else in `src/` imports BAML at module scope either". That was
    // false when it was written: `harness-patterns/routing.server.ts`,
    // `baml-adapters.server.ts`, eight `patterns/*.server.ts` and
    // `agents/title-generator.server.ts` all do. They are SAFE — none of them
    // is in the entry graph — and that is the actual rule, so it is the rule
    // that is asserted. An independent review walked this closure and found
    // ~19 modules, including `metrics/usage-recorder.server.ts` →
    // `harness-patterns/clients.server.ts`: any one of those acquiring a
    // module-scope `Collector` restores the boot regression with the old
    // two-file pin, `typecheck`, `test:run` and `build` all green.
    //
    // `import type` is not an offender: it is erased before a bundler sees it,
    // which is why several modules in the closure legitimately import BAML
    // TYPES. The house idiom for values stays
    // `const { b } = await import('…/baml_client')` inside an async function.
    const offenders = ENTRY_CLOSURE.flatMap((file) =>
      staticImports(readFileSync(path.join(APP, file), 'utf8'))
        .filter((imported) => !imported.typeOnly)
        .filter((imported) => /@boundaryml\/baml|baml_client/.test(imported.spec))
        .map((imported) => `${file}: ${imported.text}`),
    )
    expect(offenders, 'a module in the server-entry graph imports BAML at module scope').toEqual([])
  })

  it('is only ever reached from the boot hook behind that same gate', () => {
    // A call NOT guarded by `devFakeInferenceUrl()` would import the BAML
    // client into server boot on every deployment, for a hook that cannot fire
    // — and, worse, would install the redirect wherever the guard used to be.
    //
    // Shape-independent on purpose: the guard has already been a top-level
    // `if` and is now a ternary, because nitro's es2019 target rejects the
    // top-level `await` the `if` form needed. What must hold either way is
    // that the guard is READ before the install is CALLED, and that no line
    // calls the install on its own.
    expect(middleware).toContain('devFakeInferenceUrl()')
    expect(middleware.indexOf('devFakeInferenceUrl()')).toBeLessThan(
      middleware.indexOf('installDevFakeInference('),
    )
    const unguarded = middleware
      .split('\n')
      .filter((line) => /^\s*installDevFakeInference\(/.test(line))
    expect(unguarded, 'installDevFakeInference is called as a bare statement').toEqual([])
    const callers = walk(path.join(APP, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => !f.startsWith('src/__tests__/'))
      .filter((f) => f !== 'src/lib/inference/dev-fake-inference.server.ts')
      .filter((f) => /installDevFakeInference/.test(readFileSync(path.join(APP, f), 'utf8')))
    expect(callers).toEqual(['src/middleware.ts'])
  })
})
