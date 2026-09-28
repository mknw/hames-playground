/**
 * Vitest global setup — provision the throwaway test database.
 *
 * Runs per vitest PROJECT, not per file (unlike `setup.ts`): the `app`
 * project inherits it through `extends: true` while the root options declare
 * it too, so one `vitest` invocation provisions twice (#407). That is harmless
 * by construction — the second `CREATE DATABASE` hits the swallowed duplicate
 * error below — and it is why "could not provision" prints twice without a
 * Postgres.
 *
 * ## Why this exists
 *
 * The DB-backed suites used to run against whatever `DATABASE_URL` pointed at,
 * which on a developer machine is the dev database. That was survivable while
 * every test cleaned up its own rows. It stopped being survivable when at-rest
 * encryption landed: `initSchema()` now backfills existing plaintext rows with
 * the configured key, and the suite configures a fixed unit-test key. Run the
 * tests against the dev database once and its real conversations come back
 * encrypted under `unit-test-data-encryption-key` — after which `pnpm dev`,
 * holding the real key, refuses to boot. A test run must not be able to do
 * that, so `setup.ts` repoints `DATABASE_URL` unconditionally and this file
 * makes sure the target exists.
 *
 * Postgres has no `CREATE DATABASE IF NOT EXISTS`, so the duplicate error is
 * swallowed. An unreachable Postgres is also swallowed: the DB suites already
 * skip themselves when they cannot connect, and this file must not turn "no
 * docker on this machine" into a failed run.
 */
import pg from 'pg'
import { localDatabaseUrl } from '../lib/config/compose-credentials.server'

/** The database the UNIT suite talks to. Override with `TEST_DATABASE_URL`.
 *
 *  One of three, since #280: `app/e2e/` and `app/e2e-browser/` each provision
 *  their OWN database through {@link provisionDatabase}, so two suites running
 *  at once cannot delete each other's rows. See `docs/testing/pyramid.md`. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? localDatabaseUrl('kgagent_test')

/** `duplicate_database` — someone (or a previous run) got there first. */
const DUPLICATE_DATABASE = '42P04'

/**
 * A Postgres that ANSWERED and refused our credentials. Distinct from "no
 * Postgres here": that one is swallowed so a machine without docker still gets
 * a green run with the DB suites skipped, but this one means a database is
 * running and every DB-backed suite would skip against it — a green run that
 * tested nothing. That is exactly how a password mismatch between the repo-root
 * `.env` and these URLs once passed unnoticed, so it fails the run instead.
 *
 * SQLSTATE class 28 is `invalid_authorization_specification` (28P01 is a wrong
 * password, 28000 a missing role or pg_hba rejection). The message check covers
 * node-postgres's own client-side error when the server asks for SCRAM and the
 * URL carries no password at all — it has no SQLSTATE.
 */
export function isAuthFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.startsWith('28')) return true
  const message = err instanceof Error ? err.message : String(err)
  return /client password must be a string/i.test(message)
}

/**
 * Vitest's globalSetup entry point for the unit suite.
 *
 * Takes no argument on purpose even though vitest passes a project object: the
 * URL is this suite's, and a suite that wants a different one calls
 * {@link provisionDatabase} directly rather than hoping an argument lands in the
 * right position.
 */
export default async function setup(): Promise<void> {
  await provisionDatabase(TEST_DATABASE_URL)
}

/**
 * Create `url`'s database if it is not there yet.
 *
 * Exported so each suite can own its own throwaway target (#280): the app-path
 * and browser suites pass their own URL instead of inheriting this file's, which
 * is what makes concurrent runs safe. The alternative — one shared database and a
 * per-suite user id — leaves a `DROP`/`TRUNCATE` or a schema migration in one
 * suite visible to the other, and the user id is defence in depth on top rather
 * than a substitute.
 */
export async function provisionDatabase(connectionString: string): Promise<void> {
  const url = new URL(connectionString)
  const database = url.pathname.replace(/^\//, '')
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'

  const client = new pg.Client({ connectionString: maintenance.toString() })
  try {
    await client.connect()
    // Identifier, not a value — cannot be parameterised. `database` comes from
    // our own env var, and is quoted, so this is not a user-input path.
    await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    console.log(`[test-db] created ${database}`)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (isAuthFailure(err)) {
      throw new Error(
        `[test-db] Postgres at ${url.host} rejected the credentials for ${database} ` +
          `(${code ?? 'no code'}): ${err instanceof Error ? err.message : String(err)}. ` +
          'The test URLs take POSTGRES_PASSWORD from the environment or the repo-root .env ' +
          '(see .env.example), and that value does not match the running database. ' +
          'Failing the run: every DB-backed suite would otherwise skip and report green.',
        { cause: err },
      )
    }
    if (code !== DUPLICATE_DATABASE) {
      console.warn(
        `[test-db] could not provision ${database} (${code ?? 'no code'}): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'DB-backed suites will skip themselves.',
      )
    }
  } finally {
    await client.end().catch(() => {})
  }
}
