/**
 * The three test suites cannot collide with each other.
 *
 * ## What went wrong
 *
 * `src/__tests__/` (unit), `app/e2e/` (app-path) and `app/e2e-browser/` (browser)
 * all talk to one Postgres, and two of them drive real turns through the app as
 * the dev-bypass user and then DELETE "their" rows by that user id. Until #280 the
 * database name and the user id were each one literal shared by all three. That is
 * survivable while nothing runs concurrently and stops being survivable the moment
 * something does: during #277's fix round a browser run and an app-path run
 * overlapped, each wiped the other's conversations mid-flight, and the failures
 * named scenarios rather than the collision — which is the expensive kind of red,
 * because the first thing anyone does with it is re-run and hope.
 *
 * ## What this file pins, and why it is a source scan
 *
 * That the three declared identities are DISTINCT. It reads the declarations out
 * of the files rather than importing them, for the reason the encryption-coverage
 * pin gives: importing `e2e/vitest.config.ts` from the unit suite would pull a
 * second vitest config into this process, and importing `e2e-browser/lib/env.ts`
 * would make the unit suite depend on the browser suite — the wrong direction, and
 * one `browser-e2e-not-in-ci.test.ts` exists to forbid.
 *
 * It is also the only place the three can be compared at all: no module sees more
 * than one of them at runtime, because that is precisely the isolation being
 * asserted.
 *
 * ## Two mechanisms, deliberately both
 *
 * A separate DATABASE is the real fix — separate rows, separate schema, separate
 * `initSchema()` backfill. A separate dev-bypass USER ID is defence in depth: it
 * keeps the suites apart even when someone deliberately points two of them at one
 * database with `TEST_DATABASE_URL`, which is a legitimate thing to want when
 * reproducing a cross-suite bug. Losing either is a regression, so both are pinned.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `path.dirname(fileURLToPath(import.meta.url))` rather than
// `new URL('../..', import.meta.url)`: under jsdom `import.meta.url` is not a
// file: URL, and the URL form throws at import time. Same shape as
// `browser-e2e-not-in-ci.test.ts`.
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string): string => readFileSync(path.join(APP_DIR, relative), 'utf8')

/** The database name out of a default in a source file:
 *  `resolveTestDatabase('name'…)`, the guard every suite's default goes through
 *  (`src/__tests__/test-database.ts`). */
function declaredDatabases(source: string): string[] {
  return [...source.matchAll(/resolveTestDatabase\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1])
}

/** The shapes a suite default had before the guard, each of which reaches the
 *  Postgres on `localhost:5432` without asking: the compose-URL helper called
 *  with a literal name, a `TEST_DATABASE_URL ??` fallback, and a literal
 *  `?? 'postgresql://…'`. */
const UNGUARDED_DEFAULT =
  /localDatabaseUrl\(\s*['"`]|TEST_DATABASE_URL\s*\?\?|\?\?\s*['"`]postgresql:/

/** Every test tree a test run loads: the unit suite, both e2e suites, and the
 *  harness-patterns suite that `pnpm test:run` runs as its second project. */
const TEST_TREES = ['src/__tests__', 'e2e', 'e2e-browser', '../packages/harness-patterns/__tests__']

/** The only files that may build the live default. The guard builds it after
 *  the opt-in matched; the URL helper's own test asserts the string it returns
 *  and connects nowhere. */
const MAY_BUILD_LIVE_URL = new Set([
  'src/__tests__/test-database.ts',
  'src/__tests__/lib/config/compose-credentials.test.ts',
])

/** A call to the compose-URL helper, or a connection string naming Postgres's
 *  default port on this machine. */
const LIVE_DEFAULT =
  /\blocalDatabaseUrl\s*\(|postgres(?:ql)?:\/\/[^\s'"`]*(?:localhost|127\.0\.0\.1|\[::1\]):5432\b/

/** The `.ts`/`.tsx` sources under `tree`, as paths relative to `app/`. */
function testSources(tree: string): string[] {
  return readdirSync(path.join(APP_DIR, tree), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/(^|[\\/])(node_modules|\.runtime)[\\/]/.test(file))
    .map((file) => path.join(tree, file))
}

interface Suite {
  readonly name: string
  /** Files that declare this suite's database default. Every one of them has to
   *  agree — a config and its global setup naming different databases is a suite
   *  that provisions one and writes to another. */
  readonly databaseDeclaredIn: readonly string[]
  /** File declaring the dev-bypass user id, and the id itself. */
  readonly userIdDeclaredIn: string
}

const SUITES: readonly Suite[] = [
  {
    name: 'unit',
    databaseDeclaredIn: ['src/__tests__/global-setup.ts', 'src/__tests__/setup.ts'],
    // The unit suite sets no `VITE_DEV_BYPASS_USER_ID`, so it runs as the shipped
    // default — which is the fallback in `dev-bypass.ts` itself.
    userIdDeclaredIn: 'src/lib/auth/dev-bypass.ts',
  },
  {
    name: 'app-path',
    databaseDeclaredIn: ['e2e/vitest.config.ts', 'e2e/global-setup.ts'],
    userIdDeclaredIn: 'e2e/vitest.config.ts',
  },
  {
    name: 'browser',
    databaseDeclaredIn: ['e2e-browser/lib/env.ts'],
    userIdDeclaredIn: 'e2e-browser/lib/env.ts',
  },
]

/**
 * The dev-bypass user id each suite declares. Extracted rather than imported —
 * see the header.
 *
 * Three shapes, tried in order, because the three suites legitimately declare it
 * three ways: a named constant handed to the runner's env (app-path, browser), an
 * inline literal on the env key (if anyone writes it that way), and the shipped
 * fallback in `dev-bypass.ts` itself (unit, which sets no override).
 */
function declaredUserId(suite: Suite): string {
  const source = read(suite.userIdDeclaredIn)
  const patterns = [
    /(?:export )?const BYPASS_USER_ID = '([^']+)'/,
    /VITE_DEV_BYPASS_USER_ID:\s*'([^']+)'/,
    /VITE_DEV_BYPASS_USER_ID \|\| '([^']+)'/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (match) return match[1]
  }
  throw new Error(
    `no dev-bypass user id found in ${suite.userIdDeclaredIn} — this scan is how the three ` +
      'suites are kept from sharing one, so a declaration it cannot read is a hole, not a pass',
  )
}

describe('suite isolation: no two test suites share a namespace', () => {
  it('each suite declares its own throwaway database', () => {
    const byName = SUITES.map((suite) => {
      const databases = new Set(
        suite.databaseDeclaredIn.flatMap((file) => declaredDatabases(read(file))),
      )
      // Every file that names this suite's database has to name the SAME one.
      expect(
        [...databases],
        `${suite.name} declares more than one database across ${suite.databaseDeclaredIn.join(
          ', ',
        )} — it would provision one and write to another`,
      ).toHaveLength(1)
      return { suite: suite.name, database: [...databases][0] }
    })

    expect(
      new Set(byName.map((b) => b.database)).size,
      'two suites share a database, so a concurrent run of both deletes rows out from under ' +
        `the other: ${byName.map((b) => `${b.suite}=${b.database}`).join(', ')}`,
    ).toBe(SUITES.length)
  })

  it("each suite's default goes through the live-Postgres guard", () => {
    // The guard only protects a suite whose default reaches it. One file going
    // back to the old idiom is a run that falls back to the live stack without
    // asking, while the guard still reads like protection.
    for (const file of SUITES.flatMap((suite) => suite.databaseDeclaredIn)) {
      expect(
        read(file),
        `${file} builds a database default without resolveTestDatabase(), so it can reach ` +
          'the Postgres on localhost:5432 without the opt-in',
      ).not.toMatch(UNGUARDED_DEFAULT)
    }
  })

  it('nothing else in a test tree builds the live default either', () => {
    // The pin above covers the five files that declare a suite's default. A
    // helper or a test anywhere else could still build a localhost:5432 URL and
    // connect: that is how a mocked test once reached the live server, when its
    // mock stopped applying.
    for (const tree of TEST_TREES) {
      const files = testSources(tree)
      expect(files.length, `${tree} has no sources: the scan is reading nothing`).toBeGreaterThan(0)
      for (const file of files.filter((f) => !MAY_BUILD_LIVE_URL.has(f))) {
        expect(
          read(file),
          `${file} builds a URL for the Postgres on localhost:5432 outside the guard. Use ` +
            'resolveTestDatabase(), or a dead port for a URL that must never connect',
        ).not.toMatch(LIVE_DEFAULT)
      }
    }
    // The allow-list names real files, so a rename cannot silently widen it.
    const scanned = new Set(TEST_TREES.flatMap(testSources))
    for (const file of MAY_BUILD_LIVE_URL) expect(scanned.has(file), file).toBe(true)
  })

  it('each suite declares its own dev-bypass user id', () => {
    const ids = SUITES.map((suite) => ({ suite: suite.name, id: declaredUserId(suite) }))
    expect(
      new Set(ids.map((i) => i.id)).size,
      'two suites share a dev-bypass user id, so `wipeUserRows()` in one deletes the ' +
        `other's conversations: ${ids.map((i) => `${i.suite}=${i.id}`).join(', ')}`,
    ).toBe(SUITES.length)
  })

  it('the bypass user id is overridable, and defaults to the shipped literal', () => {
    // The mechanism the two e2e suites use. Pinned here rather than only in
    // `dev-bypass.test.ts` because what matters is that it is an env var at all:
    // the browser suite drives a SEPARATE PROCESS and has no other way to reach
    // the identity the server runs turns as.
    const source = read('src/lib/auth/dev-bypass.ts')
    expect(source, 'the id is no longer overridable, so the e2e suites cannot separate').toContain(
      'import.meta.env.VITE_DEV_BYPASS_USER_ID',
    )
    expect(source).toContain("|| 'dev-bypass-user'")
  })
})
