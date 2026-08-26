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

/** The database every DB-backed test talks to. Override with `TEST_DATABASE_URL`. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/kgagent_test'

/** `duplicate_database` — someone (or a previous run) got there first. */
const DUPLICATE_DATABASE = '42P04'

export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL)
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
