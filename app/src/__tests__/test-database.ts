/**
 * Which Postgres a test suite may use — decided before anything connects — and
 * what a DB-backed test does when it cannot reach one.
 *
 * A separate DATABASE per suite (#280) was not enough, because the default
 * SERVER is `localhost:5432`, which on a developer machine is the live compose
 * stack. Agent runs started without `TEST_DATABASE_URL` kept falling back to it.
 * They were refused only because their worktree had no password, and Orca now
 * copies the repo-root `.env` into every new worktree. The next such run could
 * log in, and two lanes would share one `hames_test`. The rule and the opt-in
 * are in `docs/testing/pyramid.md`, "Which Postgres a test run may touch".
 *
 * Its own module, with no `pg` import, because `setup.ts` loads it into every
 * test file's module graph. Loading `global-setup.ts` there instead cached the
 * real `pg` before a test file's `vi.mock('pg')` could apply, and that test's
 * mocked connection then went to a real server.
 */
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { localDatabaseUrl } from '../lib/config/compose-credentials.server'

/**
 * The opt-in that lets a run use the compose Postgres on `localhost:5432`.
 *
 * Its value is the ABSOLUTE PATH of the one checkout allowed to use it, not
 * `1`. A flag would travel: Orca copies `app/.env` into every worktree, and a
 * shell export reaches every agent the shell starts. A copied path still names
 * the checkout it came from, so it opts nothing else in.
 */
export const ALLOW_LOCAL_DB = 'HAMES_TEST_ALLOW_LOCAL_DB'

/** This checkout: the directory that holds `app/`. */
const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** Where the private Postgres in the refusal message listens. */
const PRIVATE_PORT = 55439

/**
 * The URL a run gets when CI configured no database. It names a Unix socket in a
 * directory that does not exist, so `pg` fails with `ENOENT` at once, with no
 * TCP connection and no DNS lookup. The DB-backed suites then skip, as they
 * always have in CI.
 *
 * It is a URL rather than `undefined` on purpose: `lib/db/client.server.ts`
 * reads an unset `DATABASE_URL` as "use the DEV database".
 */
export function noDatabaseUrl(database: string): string {
  return `postgresql:///${database}?host=/nonexistent/no-test-database-configured`
}

export interface TestDatabase {
  /** `explicit`: `TEST_DATABASE_URL`. `local`: the opted-in compose Postgres.
   *  `none`: CI with nothing configured, so the URL leads nowhere. */
  readonly source: 'explicit' | 'local' | 'none'
  readonly url: string
}

export interface ResolveOptions {
  /** Only the unit suite sets this. In CI with nothing configured it runs with
   *  no database, and its DB-backed suites skip. The e2e suites cannot run
   *  without one, so for them CI changes nothing. */
  readonly skipInCi?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The checkout the opt-in must name. Tests pass a temporary one. */
  readonly checkout?: string
}

/**
 * Decide which Postgres a test suite may use. Called for every suite's default,
 * before anything connects. In order:
 *
 *  1. `TEST_DATABASE_URL` is set: use it. Naming a database is an explicit act.
 *  2. {@link ALLOW_LOCAL_DB} names THIS checkout, in the environment or in
 *     `app/.env`: use the compose Postgres on `localhost:5432`.
 *  3. CI, and the suite can run without a database: use {@link noDatabaseUrl}.
 *  4. Otherwise throw. Falling back to `localhost:5432` here is what the guard
 *     exists to stop, so this is an error and never a skip.
 */
export function resolveTestDatabase(database: string, options: ResolveOptions = {}): TestDatabase {
  const { skipInCi = false, env = process.env, checkout = CHECKOUT } = options
  if (env.TEST_DATABASE_URL) return { source: 'explicit', url: env.TEST_DATABASE_URL }

  const optIn = env[ALLOW_LOCAL_DB] || envFileValue(path.join(checkout, 'app', '.env'))
  // Absolute only. `realpathSync` resolves a relative value against the cwd,
  // which is always the running checkout's `app/`, so `..` would name every
  // checkout a copied `app/.env` lands in: a flag again, in path form.
  if (optIn && path.isAbsolute(optIn) && samePath(optIn, checkout)) {
    return { source: 'local', url: localDatabaseUrl(database) }
  }
  if (skipInCi && isCi(env.CI)) return { source: 'none', url: noDatabaseUrl(database) }

  throw new Error(refusal(database, optIn))
}

function envFileValue(file: string): string | undefined {
  try {
    return parseEnv(readFileSync(file, 'utf8'))[ALLOW_LOCAL_DB] || undefined
  } catch {
    return undefined
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function isCi(value: string | undefined): boolean {
  return !!value && value !== 'false' && value !== '0'
}

/**
 * The refusal names the opt-in but never a value the guard would accept here.
 * The reader it exists for is an agent in a lane, and the cheapest way to clear
 * an error is to paste whatever line it prints. A line carrying this checkout's
 * path would be accepted: a lane naming itself looks the same as the owner. So
 * the opt-in line is a placeholder, marked owner-only, and this checkout's path
 * appears nowhere in the message. The owner pays for that by typing a path once.
 */
function refusal(database: string, optIn: string | undefined): string {
  const why = optIn
    ? `${ALLOW_LOCAL_DB} is '${optIn}', which does not name this checkout. ` +
      'It must be the absolute path of the checkout it opts in, so a copy of it ' +
      "(an Orca worktree's app/.env, an inherited shell export) opts nothing else in."
    : 'Nothing says which Postgres to use.'
  return [
    `[test-db] Refusing to fall back to the Postgres on localhost:5432 for ${database}. ` +
      'On a developer machine that is the live compose stack, and with the repo-root ' +
      `.env present this run could log in and write to it. ${why}`,
    'Choose one:',
    '  - a private, throwaway Postgres (worktrees, lanes, agents):',
    `      docker run --rm -d --name hames-test-pg -p ${PRIVATE_PORT}:5432 -e POSTGRES_PASSWORD=test postgres:16`,
    `      export TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:${PRIVATE_PORT}/${database}`,
    "  - the compose Postgres on purpose: the owner's own primary checkout ONLY.",
    '    Agents and lanes: use the private Postgres above, and never add this line.',
    `      ${ALLOW_LOCAL_DB}='<absolute path of your own primary checkout>'   # in app/.env`,
    '  - no database, as CI runs it (the unit suite only; its DB-backed suites skip):',
    '      CI=1 pnpm test:run',
    'See docs/testing/pyramid.md, "Which Postgres a test run may touch".',
  ].join('\n')
}

/**
 * Set only in CI's `test · postgres` job, where a database is guaranteed. There,
 * a DB-backed test that would skip fails instead (see {@link skipWithoutDatabase}).
 */
export const REQUIRE_DB = 'TEST_DATABASE_REQUIRED'

/**
 * What a DB-backed test does when its file's probe could not reach Postgres.
 * Every describe block whose tests touch the database opens with
 * `beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))`.
 *
 * It skips rather than returning early. An early `return` reports the test as
 * passed while it asserted nothing, and a green total then rests on no-ops
 * (`kg-test-pyramid` rule 3). With {@link REQUIRE_DB} set it throws instead, so
 * the job that exists to run these tests cannot go green by skipping them,
 * whether the probe failed or the condition passed in here is wrong.
 */
export function skipWithoutDatabase(
  ctx: { skip: () => void },
  available: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (available) return
  if (env[REQUIRE_DB]) {
    throw new Error(
      `[test-db] ${REQUIRE_DB} is set, so a DB-backed test may not skip. ` +
        "This test's file could not reach Postgres; its warning is above.",
    )
  }
  ctx.skip()
}
