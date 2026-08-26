/**
 * Vitest Setup File
 *
 * Configures the test environment before tests run.
 */

// At-rest encryption key for the Postgres columns holding user content and
// personal data (`lib/db/crypto.server.ts`). Set here rather than per test file
// because every DB-backed suite now needs it, and because the alternative — a
// key-less default — would have the whole suite exercise only the throwing
// path. Suites that test the *absence* of a key delete this variable for the
// duration of the assertion; the key is resolved per call, not at import, so
// that works.
process.env.DATA_ENCRYPTION_KEY ||= 'unit-test-data-encryption-key'

// Never let a test run touch the dev database. Unconditional (not `||=`): the
// point is that a developer's own DATABASE_URL cannot leak in, because
// `initSchema()`'s encryption backfill would rewrite their real rows with the
// unit-test key above. `global-setup.ts` provisions this database.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/kgagent_test'
