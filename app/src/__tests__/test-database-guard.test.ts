// @vitest-environment node
/**
 * The guard that keeps test runs off the live Postgres.
 *
 * On a developer machine `localhost:5432` is the live compose stack. Agent runs
 * started without `TEST_DATABASE_URL` kept falling back to it, and Orca now
 * copies the repo-root `.env` (the password) into every new worktree. These pin
 * the four outcomes of `resolveTestDatabase()`: refuse, the explicit URL, the
 * opted-in compose Postgres, and CI's "no database" (skip). The last block pins
 * what a DB-backed test does without a database: skip, or fail where one is
 * required.
 *
 * Every case passes its own `env` and its own temporary checkout, so nothing
 * here depends on, or reaches, the machine's real Postgres or the owner's
 * `app/.env`.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { parse } from 'yaml'
import {
  ALLOW_LOCAL_DB,
  REQUIRE_DB,
  noDatabaseUrl,
  resolveTestDatabase,
  skipWithoutDatabase,
} from './test-database'

/** A throwaway checkout: a root holding `app/`, with an optional `app/.env`. */
function checkout(appEnv?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'test-db-guard-'))
  mkdirSync(path.join(root, 'app'))
  if (appEnv !== undefined) writeFileSync(path.join(root, 'app', '.env'), appEnv)
  return root
}

const PRIVATE_URL = 'postgresql://postgres:test@127.0.0.1:55439/hames_test'

/** The refusal's message for `checkout`, failing the test if it does not throw. */
function refusalIn(root: string, env: Record<string, string> = {}): string {
  try {
    resolveTestDatabase('hames_test', { env, checkout: root })
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected resolveTestDatabase to refuse')
}

describe('resolveTestDatabase: no URL and no opt-in refuses', () => {
  it('throws instead of falling back to localhost:5432, and says how to choose', () => {
    const root = checkout()
    const resolve = () => resolveTestDatabase('hames_test', { env: {}, checkout: root })
    expect(resolve).toThrow(
      /Refusing to fall back to the Postgres on localhost:5432 for hames_test/,
    )
    // The three ways out are in the message itself, so a lane that hits it does
    // not need to go and find the docs.
    expect(resolve).toThrow(/docker run --rm -d .* -p 55439:5432 .* postgres:16/)
    expect(resolve).toThrow(/TEST_DATABASE_URL=postgresql:\/\/postgres:test@127\.0\.0\.1:55439/)
    expect(resolve).toThrow(`${ALLOW_LOCAL_DB}='<absolute path of your own primary checkout>'`)
    expect(resolve).toThrow(/Agents and lanes: use the private Postgres above, and never add this/)
    expect(resolve).toThrow(/CI=1 pnpm test:run/)
  })

  it('hands a lane no opt-in it could paste to let itself in', () => {
    // The reader is an agent in a lane, and the cheapest way out of an error is
    // to paste the line it prints. So: this checkout's path appears nowhere in
    // the message, and every opt-in value the message shows is refused when the
    // lane writes it into its own app/.env.
    const owner = checkout()
    const envs: Record<string, string>[] = [{}, { [ALLOW_LOCAL_DB]: owner }]
    for (const env of envs) {
      const lane = checkout()
      const message = refusalIn(lane, env)
      expect(message).not.toContain(lane)
      expect(message).not.toContain(realpathSync(lane))

      // A quoted value whole (the placeholder has spaces), else up to whitespace.
      const shown = [
        ...message.matchAll(new RegExp(`${ALLOW_LOCAL_DB}=(?:'([^']*)'|(\\S+))`, 'g')),
      ].map((m) => m[1] ?? m[2])
      expect(shown.length, 'the message no longer shows an opt-in line at all').toBeGreaterThan(0)
      for (const value of shown) {
        writeFileSync(path.join(lane, 'app', '.env'), `${ALLOW_LOCAL_DB}='${value}'\n`)
        expect(() => resolveTestDatabase('hames_test', { env: {}, checkout: lane }), value).toThrow(
          /Refusing to fall back/,
        )
      }
    }
  })

  it('also refuses for the unit suite when CI is absent or explicitly off', () => {
    const root = checkout()
    for (const CI of [undefined, '', 'false', '0']) {
      expect(
        () => resolveTestDatabase('hames_test', { skipInCi: true, env: { CI }, checkout: root }),
        `CI=${String(CI)}`,
      ).toThrow(/Refusing to fall back/)
    }
  })
})

describe('resolveTestDatabase: an explicit TEST_DATABASE_URL proceeds', () => {
  it('uses the URL as given', () => {
    expect(
      resolveTestDatabase('hames_test', {
        env: { TEST_DATABASE_URL: PRIVATE_URL },
        checkout: checkout(),
      }),
    ).toEqual({ source: 'explicit', url: PRIVATE_URL })
  })

  it('wins over CI and over an opt-in, so naming a database is always enough', () => {
    const root = checkout()
    expect(
      resolveTestDatabase('hames_test', {
        skipInCi: true,
        env: { TEST_DATABASE_URL: PRIVATE_URL, CI: 'true', [ALLOW_LOCAL_DB]: root },
        checkout: root,
      }),
    ).toEqual({ source: 'explicit', url: PRIVATE_URL })
  })
})

describe('resolveTestDatabase: the opt-in proceeds, in its own checkout only', () => {
  function expectLocal(db: { source: string; url: string }, database: string): void {
    expect(db.source).toBe('local')
    const url = new URL(db.url)
    expect(url.host).toBe('localhost:5432')
    expect(url.pathname).toBe(`/${database}`)
  }

  it('from the environment', () => {
    const root = checkout()
    expectLocal(
      resolveTestDatabase('hames_test_apppath', {
        env: { [ALLOW_LOCAL_DB]: root },
        checkout: root,
      }),
      'hames_test_apppath',
    )
  })

  it('from app/.env, which vitest does not load on its own', () => {
    const root = checkout()
    writeFileSync(path.join(root, 'app', '.env'), `${ALLOW_LOCAL_DB}='${root}'\n`)
    expectLocal(resolveTestDatabase('hames_test', { env: {}, checkout: root }), 'hames_test')
  })

  it('compares real paths, so another spelling of the same checkout still matches', () => {
    // An explicit symlink, rather than relying on macOS's tmpdir being one: on
    // Linux CI that would make the two spellings identical and the test vacuous.
    const root = checkout()
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'test-db-link-')), 'checkout')
    symlinkSync(root, link)
    // The opt-in names the link; the checkout is the target.
    expectLocal(
      resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: `${link}/` }, checkout: root }),
      'hames_test',
    )
    // The checkout is reached through the link; the opt-in names the target.
    expectLocal(
      resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: root }, checkout: link }),
      'hames_test',
    )
  })

  it('refuses a relative opt-in, which names whatever checkout the run is in', () => {
    // A relative value resolves against the cwd, which is the running checkout's
    // app/. So `..` in a copied app/.env would name every lane it lands in.
    // Both are string results only: nothing here connects.
    const cwdCheckout = path.resolve('..')
    expect(() =>
      resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: '..' }, checkout: cwdCheckout }),
    ).toThrow(`${ALLOW_LOCAL_DB} is '..', which does not name this checkout`)

    const root = checkout()
    const relative = path.relative(process.cwd(), root)
    expect(path.isAbsolute(relative)).toBe(false)
    writeFileSync(path.join(root, 'app', '.env'), `${ALLOW_LOCAL_DB}='${relative}'\n`)
    expect(() => resolveTestDatabase('hames_test', { env: {}, checkout: root })).toThrow(
      /which does not name this checkout/,
    )
  })

  it("refuses an opt-in copied from another checkout (an Orca worktree's app/.env)", () => {
    const owner = checkout()
    const lane = checkout(`${ALLOW_LOCAL_DB}=${owner}\n`)
    expect(() => resolveTestDatabase('hames_test', { env: {}, checkout: lane })).toThrow(
      `${ALLOW_LOCAL_DB} is '${owner}', which does not name this checkout`,
    )
  })

  it('refuses a boolean opt-in, because a flag travels into every lane that copies it', () => {
    const root = checkout()
    for (const flag of ['1', 'true']) {
      expect(() =>
        resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: flag }, checkout: root }),
      ).toThrow(/which does not name this checkout/)
    }
  })
})

describe('resolveTestDatabase: CI with no database skips', () => {
  it('gives the unit suite a URL that reaches no server', async () => {
    const db = resolveTestDatabase('hames_test', {
      skipInCi: true,
      env: { CI: 'true' },
      checkout: checkout(),
    })
    expect(db).toEqual({ source: 'none', url: noDatabaseUrl('hames_test') })

    // The skip is only as safe as this URL. A real client against it fails on
    // a missing Unix socket: no TCP connection, no DNS lookup, nothing to log
    // in to. The DB-backed suites read that failure as "skip".
    const client = new pg.Client({ connectionString: db.url })
    await expect(client.connect()).rejects.toMatchObject({ code: 'ENOENT' })
    await client.end().catch(() => {})
  })

  it('does not skip for the e2e suites, which cannot run without a database', () => {
    expect(() =>
      resolveTestDatabase('hames_test_apppath', { env: { CI: '1' }, checkout: checkout() }),
    ).toThrow(/Refusing to fall back/)
  })

  it('ignores a copied opt-in under CI rather than using it', () => {
    const owner = checkout()
    const lane = checkout(`${ALLOW_LOCAL_DB}=${owner}\n`)
    expect(
      resolveTestDatabase('hames_test', { skipInCi: true, env: { CI: '1' }, checkout: lane })
        .source,
    ).toBe('none')
  })
})

describe('skipWithoutDatabase: what a DB-backed test does with no database', () => {
  const ctx = () => ({ skip: vi.fn() })

  it('neither skips nor fails when the probe reached Postgres', () => {
    for (const env of [{}, { [REQUIRE_DB]: '1' }]) {
      const c = ctx()
      expect(() => skipWithoutDatabase(c, true, env)).not.toThrow()
      expect(c.skip).not.toHaveBeenCalled()
    }
  })

  it('skips, rather than passing while asserting nothing, when it did not', () => {
    const c = ctx()
    skipWithoutDatabase(c, false, {})
    expect(c.skip).toHaveBeenCalledOnce()
  })

  it('fails instead of skipping where a database is required', () => {
    const c = ctx()
    expect(() => skipWithoutDatabase(c, false, { [REQUIRE_DB]: '1' })).toThrow(
      `${REQUIRE_DB} is set, so a DB-backed test may not skip`,
    )
    expect(c.skip).not.toHaveBeenCalled()
  })

  it("is required in CI's postgres job, so a skip there fails the job", () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const ci = parse(readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { env?: Record<string, string> }>
    }
    expect(ci.jobs.postgres.env?.[REQUIRE_DB]).toBe('1')
  })

  it('reads the variable from the process environment by default', () => {
    vi.stubEnv(REQUIRE_DB, '1')
    try {
      expect(() => skipWithoutDatabase(ctx(), false)).toThrow(REQUIRE_DB)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is the only way a test file on the real database client skips', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const dbFiles = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /(^|\/)__tests__\/.*\.(test|spec)\.tsx?$/.test(f))
      .map((f) => ({ f, s: readFileSync(path.join(src, f), 'utf8') }))
      .filter(
        ({ s }) =>
          /db\/client\.server'/.test(s) && !/vi\.mock\(\s*'[^']*db\/client\.server'/.test(s),
      )
    // The ten today, so a clean pass below is not "scanned nothing".
    expect(dbFiles.length).toBeGreaterThanOrEqual(10)
    for (const { f, s } of dbFiles) {
      expect(s, f).toContain('skipWithoutDatabase(ctx, dbAvailable)')
      expect(s, f).not.toMatch(
        /\b(?:it|test|describe)\.(?:skip|skipIf|runIf|todo)\b|ctx\.skip\(|\bit\(.*\n\s*if \(!dbAvailable\) return/,
      )
    }
  })
})
