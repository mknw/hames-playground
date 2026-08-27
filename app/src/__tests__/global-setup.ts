/**
 * Vitest global setup — provision the throwaway test database.
 *
 * Runs once per `vitest` invocation (not per file), unlike `setup.ts`.
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

/** The database the UNIT suite talks to. Override with `TEST_DATABASE_URL`.
 *
 *  One of three, since #280: `app/e2e/` and `app/e2e-browser/` each provision
 *  their OWN database through {@link provisionDatabase}, so two suites running
 *  at once cannot delete each other's rows. See `docs/testing/pyramid.md`. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/kgagent_test'

/** `duplicate_database` — someone (or a previous run) got there first. */
const DUPLICATE_DATABASE = '42P04'

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
