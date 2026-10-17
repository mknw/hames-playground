// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  fileURLToPath(new URL('../../../lib/db/client.server.ts', import.meta.url)),
  'utf8',
)
const schema = source.match(/const SCHEMA_SQL = `([\s\S]*?)^`/m)?.[1]

/** Fail closed on new SQL forms. Migrations that rewrite/drop existing state
 * belong outside the boot schema; an older image can replay this batch. */
function nonAdditive(sql: string): string[] {
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  return statements.filter((statement) => {
    // Existing, intentional sequence-default migration. No other ALTER COLUMN
    // is permitted; keep this exception exact, not a keyword-wide exemption.
    if (
      /^ALTER TABLE conversations\s+ALTER COLUMN context_version SET DEFAULT nextval\('conversations_context_version_seq'\)$/.test(
        statement,
      )
    )
      return false
    const s = statement.replace(/'(?:''|[^'])*'/g, "''")
    if (/\b(DROP|UPDATE|DELETE|INSERT|TRUNCATE|RENAME|REPLACE|EXECUTE|DO|GRANT|REVOKE)\b/i.test(s))
      return true
    // A second ALTER action after an additive prefix must not sneak through.
    if (
      /^ALTER TABLE/.test(s) &&
      /\b(ALTER|SET|DISABLE|ENABLE|VALIDATE|INHERIT)\b/.test(s.slice('ALTER TABLE'.length))
    )
      return true
    return !(
      /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|SEQUENCE) IF NOT EXISTS \w+\b/.test(s) ||
      /^ALTER TABLE \w+\s+ADD COLUMN IF NOT EXISTS \w+\b/.test(s)
    )
  })
}

describe('SCHEMA_SQL remains additive-only (#432 row 8)', () => {
  it('only creates missing objects/adds missing columns, with one exact legacy default', () => {
    expect(schema).toBeDefined()
    expect(schema!.length).toBeGreaterThan(1000)
    expect(nonAdditive(schema!)).toEqual([])
  })

  it.each([
    'DROP TABLE conversations;',
    "UPDATE conversations SET title = 'changed';",
    'DELETE FROM conversations;',
    'TRUNCATE conversations;',
    'ALTER TABLE conversations DROP COLUMN title;',
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS x TEXT, DROP COLUMN title;',
    'ALTER TABLE conversations ALTER COLUMN title TYPE INTEGER;',
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS x TEXT, ALTER COLUMN title SET NOT NULL;',
    'CREATE TABLE conversations (id TEXT);',
    "ALTER TABLE conversations ALTER COLUMN context_version SET DEFAULT nextval('other_sequence');",
    'CREATE OR REPLACE VIEW hidden AS SELECT 1;',
    'DO $$ BEGIN DELETE FROM conversations; END $$;',
  ])('rejects destructive/non-idempotent mutation %s', (sql) => {
    expect(nonAdditive(sql).length).toBeGreaterThan(0)
  })
})
