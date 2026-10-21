// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const lib = fileURLToPath(new URL('../../../lib', import.meta.url))
const BOOT_DDL_SOURCES = [
  'auth/session-store.server.ts',
  'auth/user-tokens.server.ts',
  'auth/users.server.ts',
  'db/client.server.ts',
  'db/memories.server.ts',
  'db/routines.server.ts',
  'db/skills.server.ts',
  'db/user-prefs.server.ts',
  'metrics/preview-counters.server.ts',
]

// Mask quoted SQL and comments without moving delimiters. Dollar bodies remain
// ONE statement; commas inside types/expressions/strings are not ALTER actions.
const QUOTED_OR_COMMENT =
  /'(?:''|[^'])*'|"(?:""|[^"])*"|\$\$[\s\S]*?\$\$|--[^\n]*|\/\*[\s\S]*?\*\//g
function withoutComments(sql: string): string {
  return sql.replace(QUOTED_OR_COMMENT, (s) => (/^(--|\/\*)/.test(s) ? ' '.repeat(s.length) : s))
}
function splitTopLevel(sql: string, delimiter: string): string[] {
  const masked = sql.replace(QUOTED_OR_COMMENT, (s) => ' '.repeat(s.length))
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '(') depth++
    if (masked[i] === ')') depth--
    if (masked[i] === delimiter && depth === 0) {
      parts.push(sql.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(sql.slice(start).trim())
  return parts.filter(Boolean)
}
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim()

// Exact compatibility migrations, each bound to its source. No blanket
// ALTER COLUMN or DO permission: changing even one token must make the pin red.
const LEGACY_SEQUENCE_DEFAULT =
  "ALTER TABLE conversations ALTER COLUMN context_version SET DEFAULT nextval('conversations_context_version_seq')"
const LEGACY_MEMORY_OWNER_FK = normalized(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_sources_conversation_owner_fk') THEN
      ALTER TABLE memory_sources DROP CONSTRAINT IF EXISTS memory_sources_conversation_fk;
      ALTER TABLE memory_sources
        ADD CONSTRAINT memory_sources_conversation_owner_fk
        FOREIGN KEY (conversation_id, user_id) REFERENCES conversations (id, user_id) NOT VALID;
    END IF;
  END $$`)

// #722: this exact widening admits the new spelling and preserves old rows.
const SELF_DEPLOYED_MEMORY_TIER_CHECK = normalized(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'memories'::regclass AND conname = 'memories_tier_check'
        AND pg_get_constraintdef(oid) NOT LIKE '%self_deployed%'
    ) THEN
      ALTER TABLE memories DROP CONSTRAINT memories_tier_check;
      ALTER TABLE memories ADD CONSTRAINT memories_tier_check
        CHECK (tier IN ('verda','self_deployed','anthropic'));
    END IF;
  END $$`)

/** Fail closed on each statement AND each top-level ALTER action. */
function nonAdditive(sql: string, source = ''): string[] {
  return splitTopLevel(withoutComments(sql), ';').filter((statement) => {
    const exact = normalized(statement)
    if (source === 'db/client.server.ts' && exact === LEGACY_SEQUENCE_DEFAULT) return false
    if (
      source === 'db/memories.server.ts' &&
      (exact === LEGACY_MEMORY_OWNER_FK || exact === SELF_DEPLOYED_MEMORY_TIER_CHECK)
    )
      return false
    const masked = statement.replace(QUOTED_OR_COMMENT, "''")
    // ON DELETE CASCADE is an existing FK declaration, not a data DELETE.
    const operations = masked.replace(/\bON DELETE (?:CASCADE|SET NULL|NO ACTION|RESTRICT)\b/g, '')
    if (
      /\b(DROP|UPDATE|DELETE|INSERT|TRUNCATE|RENAME|REPLACE|EXECUTE|DO|GRANT|REVOKE)\b/i.test(
        operations,
      )
    )
      return true
    const alter = statement.match(/^ALTER TABLE \w+\s+([\s\S]+)$/)
    if (alter) {
      return splitTopLevel(alter[1], ',').some(
        (action) =>
          !/^ADD COLUMN IF NOT EXISTS \w+\s+\S/.test(action) ||
          /\b(ALTER|SET|DISABLE|ENABLE|VALIDATE|INHERIT)\b/.test(
            action.replace(QUOTED_OR_COMMENT, "''"),
          ),
      )
    }
    return !/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|SEQUENCE|EXTENSION) IF NOT EXISTS \w+\b/.test(
      masked,
    )
  })
}

/** Read SQL literals, not comments or imports. This covers the nine batches and
 * inline boot DDL (schema_meta / vector), and discovers new modules or names.
 * No production module is imported and no query is executed. */
function ddlSources(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of readdirSync(lib, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file) || /(^|\/)scripts\//.test(file)) continue
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(lib, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const sql = withoutComments(
          ts.isStringLiteralLike(node) ? node.text : node.getText(source).slice(1, -1),
        )
        if (
          /^\s*(?:CREATE|ALTER|DROP|DO)\b/.test(sql) &&
          /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SEQUENCE|EXTENSION)\b/.test(sql)
        ) {
          found.set(file, [...(found.get(file) ?? []), sql])
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

const sources = ddlSources()
describe('boot DDL remains additive-only (#432 row 8)', () => {
  it('inventories every boot-DDL source, including newly introduced modules', () => {
    expect([...sources.keys()].sort()).toEqual(BOOT_DDL_SOURCES)
  })

  it.each(BOOT_DDL_SOURCES)(
    'checks all DDL in %s, with only its exact legacy exceptions',
    (file) => {
      const batches = sources.get(file)
      expect(batches?.length).toBeGreaterThan(0)
      for (const sql of batches!) expect(nonAdditive(sql, file)).toEqual([])
    },
  )

  it.each([
    'DROP TABLE conversations;',
    'DROP TABLE users;',
    "UPDATE conversations SET title = 'changed';",
    'DELETE FROM conversations;',
    'TRUNCATE conversations;',
    'ALTER TABLE conversations DROP COLUMN title;',
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS x TEXT, DROP COLUMN title;',
    'ALTER TABLE conversations ALTER COLUMN title TYPE INTEGER;',
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS x TEXT, ALTER COLUMN title SET NOT NULL;',
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reviewer_x TEXT, ADD COLUMN reviewer_y TEXT;',
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reviewer_x TEXT, ADD CONSTRAINT reviewer_false CHECK (false);',
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS zz TEXT, ADD CONSTRAINT zz_chk CHECK (false);',
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS zz TEXT, ADD COLUMN title TEXT;',
    'CREATE TABLE conversations (id TEXT);',
    "ALTER TABLE conversations ALTER COLUMN context_version SET DEFAULT nextval('other_sequence');",
    'CREATE OR REPLACE VIEW hidden AS SELECT 1;',
    'DO $$ BEGIN DELETE FROM conversations; END $$;',
    LEGACY_MEMORY_OWNER_FK.replace('NOT VALID', ''),
    SELF_DEPLOYED_MEMORY_TIER_CHECK.replace(
      "'verda','self_deployed','anthropic'",
      "'self_deployed','anthropic'",
    ),
    SELF_DEPLOYED_MEMORY_TIER_CHECK.replace('NOT LIKE', 'LIKE'),
  ])('rejects destructive/non-idempotent mutation %s', (sql) => {
    expect(nonAdditive(sql, 'db/memories.server.ts').length).toBeGreaterThan(0)
  })

  it('keeps commas inside column types, expressions and strings working', () => {
    expect(
      nonAdditive(
        "ALTER TABLE example ADD COLUMN IF NOT EXISTS x NUMERIC(10, 2) DEFAULT round(1.2, 1), ADD COLUMN IF NOT EXISTS y TEXT DEFAULT 'a,b;--';",
      ),
    ).toEqual([])
  })
})
