// @vitest-environment node
// (node, not jsdom: importing a vitest config loads esbuild, whose TextEncoder
// invariant fails under jsdom.)
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
import appConfig from '../../vitest.config'

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

describe('the browser e2e suite is not reachable from CI', () => {
  // Guards against the guard becoming vacuous: if the directory were emptied
  // or moved, every assertion below would pass while proving nothing.
  it('there are browser-e2e modules to protect', () => {
    expect(TS.length).toBeGreaterThan(5)
    expect(TS).toContain(`${SUITE}/playwright.config.ts`)
    expect(TS.filter((f) => f.startsWith(`${SUITE}/scenarios/`)).length).toBeGreaterThan(3)
  })

  // The runner-level escape (#407): the config's `projects` list may add
  // @hames-ai/harness-patterns' own suite so coverage counts its tests, and
  // nothing else. A project entry naming e2e-browser/ would run that suite in CI
  // without touching any include glob. Read from the IMPORTED config, not
  // its source text, so no spelling of the entry (backticks, a variable, an
  // inline object with its own include) can slip past a pattern.
  it('no vitest project reaches e2e-browser/', () => {
    const projects = appConfig.test?.projects
    expect(Array.isArray(projects), 'vitest.config.ts has no projects array').toBe(true)
    for (const project of projects as unknown[]) {
      if (typeof project === 'string') {
        expect(project, `the project ${project} could collect the browser suite`).toBe(
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
    // `pnpm release:check` runs this suite as its third layer, and it does so
    // from `scripts/release-check.ts` rather than from its own script BODY — so
    // the package-script scan below cannot see it, and adding `release:check` to
    // a CI job would run the browser suite past every other assertion in this
    // file. Named here, where the question is "what does CI invoke".
    expect(ci).not.toMatch(/release:check/)
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

  it('loads BAML at module scope, so a broken native binding fails boot instead of 500ing behind a healthy container (#480 b)', () => {
    // This replaces the prohibition this suite used to enforce (a walk of the
    // server-entry closure asserting NOTHING in it imported `@boundaryml/baml`
    // or `baml_client` at module scope). That rule's reason was the #469 boot
    // crash: nitro BUNDLING the package wrong, so a static import pulled a
    // build-host-only path into `.output/server/index.mjs`. #478 fixed the
    // bundling (the rollup `external` in `app.config.ts`) and pinned it in CI
    // (`ci.yml`'s "Assert a BAML-loading route loads"), so the reason no
    // longer holds — and the owner's #480 call was to invert it: BAML should
    // load at boot ON PURPOSE, so a genuinely broken native binding fails
    // startup (and the container healthcheck) rather than leaving the app
    // `(healthy)` while every BAML route answers 500, which is what hid #469
    // in the first place.
    //
    // A source scan, like this suite's other middleware assertions, for the
    // reason they all give: importing `src/middleware.ts` for real would arm
    // the routine scheduler and the usage recorder in a unit run.
    //
    // Mutation: delete this import from `middleware.ts` and this test reddens
    // — that is the pin for the owner's "a test must go red" requirement. The
    // real-boot half (the native binding itself missing) is proved against a
    // throwaway image rather than here, because a unit test cannot delete a
    // dependency from its own process; see the PR description for that run.
    expect(middleware).toMatch(
      /^import \{ b \} from ['"]@hames-ai\/harness-baml\/baml_client['"]$/m,
    )
  })

  it('is only ever reached from the boot hook behind that same gate', () => {
    // A call NOT guarded by `devFakeInferenceUrl()` would import the BAML
    // client into server boot on every deployment, for a hook that cannot fire
    // — and, worse, would install the redirect wherever the guard used to be.
    //
    // Shape-independent on purpose: the guard has already been a top-level
    // `if` and is now a ternary, because nitro's es2019 target rejects the
    // top-level `await` the `if` form needed. What must hold either way is
    // that the guard is READ before the install is CALLED, and that the ONE
    // call sits inside the guarded branch.
    expect(middleware).toContain('devFakeInferenceUrl()')
    expect(middleware.indexOf('devFakeInferenceUrl()')).toBeLessThan(
      middleware.indexOf('installDevFakeInference('),
    )

    // One call site, bounded by the guarded arm.
    //
    // Scanned on RAW source, deliberately unlike `one-baml-corpus.test.ts`,
    // which strips comments first. A doc comment spelling `installDevFakeInference(`
    // would redden this — a false positive, but a LOUD one that names the line,
    // where stripping risks the opposite trade on the assertion that matters
    // most in this file.
    //
    // This used to be "no LINE begins with the call", a proxy for "no bare
    // statement" — and the proxy broke on formatting alone: when the dynamic
    // import moved to the package specifier the guarded expression no longer
    // fitted prettier's 100 columns, so the call landed on a continuation line
    // while staying exactly as guarded as before. Counting the call sites and
    // bounding their offset states the property directly, and a line break
    // cannot satisfy it — nor can a second, unguarded call further down, which
    // the line scan would also have missed whenever it was written with
    // anything (an `await`, a `void`, an assignment) in front of it.
    const callSites = [...middleware.matchAll(/(?<![\w.])installDevFakeInference\(/g)].map(
      (m) => m.index,
    )
    expect(callSites, 'installDevFakeInference must be called exactly once').toHaveLength(1)
    // The guarded arm is the conditional spread inside `onRequest: [...]` —
    // `...(devFakeInferenceUrl() ? [hook] : [])` — since the security headers
    // (#415 D13) became the array's first, UNconditional hook. It was
    // `onRequest: devFakeInferenceUrl() ? hook : undefined` before that.
    const armStart = middleware.indexOf('...(devFakeInferenceUrl()')
    const armEnd = middleware.indexOf(': [])', armStart)
    expect(armStart, 'the onRequest guard is not in its expected form').toBeGreaterThan(-1)
    expect(armEnd, 'the guarded spread has no `: []` arm').toBeGreaterThan(armStart)
    expect(
      callSites[0],
      'installDevFakeInference is called outside the guarded arm',
    ).toBeGreaterThan(armStart)
    expect(callSites[0], 'installDevFakeInference is called outside the guarded arm').toBeLessThan(
      armEnd,
    )
    const callers = walk(path.join(APP, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => !f.startsWith('src/__tests__/'))
      .filter((f) => f !== 'src/lib/inference/dev-fake-inference.server.ts')
      .filter((f) => /installDevFakeInference/.test(readFileSync(path.join(APP, f), 'utf8')))
    expect(callers).toEqual(['src/middleware.ts'])
  })
})
