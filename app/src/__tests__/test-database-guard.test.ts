// @vitest-environment node
/**
 * The guard that keeps test runs off the live Postgres.
 *
 * On a developer machine `localhost:5432` is the live compose stack. Agent runs
 * started without `TEST_DATABASE_URL` kept falling back to it, and Orca now
 * copies the repo-root `.env` (the password) into every new worktree. These pin
 * the four outcomes of `resolveTestDatabase()`: refuse, the explicit URL, the
 * opted-in compose Postgres, and CI's "no database" (skip).
 *
 * Every case passes its own `env` and its own temporary checkout, so nothing
 * here depends on, or reaches, the machine's real Postgres or the owner's
 * `app/.env`.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { ALLOW_LOCAL_DB, noDatabaseUrl, resolveTestDatabase } from './test-database'

/** A throwaway checkout: a root holding `app/`, with an optional `app/.env`. */
function checkout(appEnv?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'test-db-guard-'))
  mkdirSync(path.join(root, 'app'))
  if (appEnv !== undefined) writeFileSync(path.join(root, 'app', '.env'), appEnv)
  return root
}

const PRIVATE_URL = 'postgresql://postgres:test@127.0.0.1:55439/hames_test'

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
    expect(resolve).toThrow(`${ALLOW_LOCAL_DB}='${root}'`)
    expect(resolve).toThrow(/CI=1 pnpm test:run/)
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
    const root = checkout()
    // macOS's tmpdir is a symlink into /private, so the two spellings differ there.
    expectLocal(
      resolveTestDatabase('hames_test', {
        env: { [ALLOW_LOCAL_DB]: `${realpathSync(root)}/` },
        checkout: root,
      }),
      'hames_test',
    )
  })

  it("refuses an opt-in copied from another checkout (an Orca worktree's app/.env)", () => {
    const owner = checkout()
    const lane = checkout(`${ALLOW_LOCAL_DB}=${owner}\n`)
    expect(() => resolveTestDatabase('hames_test', { env: {}, checkout: lane })).toThrow(
      `${ALLOW_LOCAL_DB} is '${owner}', which is not this checkout`,
    )
  })

  it('refuses a boolean opt-in, because a flag travels into every lane that copies it', () => {
    const root = checkout()
    for (const flag of ['1', 'true']) {
      expect(() =>
        resolveTestDatabase('hames_test', { env: { [ALLOW_LOCAL_DB]: flag }, checkout: root }),
      ).toThrow(/which is not this checkout/)
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
